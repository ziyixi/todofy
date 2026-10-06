/**
 * The Worker's HTTP surface (../../docs/design.md §9). The whole host is behind Cloudflare Access, and the Worker verifies
 * the owner's Access JWT itself on every path but /health:
 *
 * - /api/v1/*: MailsortUiService (proto/mailsort/ui/v1). Every method but GET, HEAD and OPTIONS needs the same-origin
 *   Origin and the signed double-submit CSRF token, checked here before the body is read; the request then goes to
 *   MailsortState (state.ts), whose transcoder answers it. This handler stays thin (Workers Free: 10 ms of CPU): the
 *   JWT, the CSRF token and one call to the object;
 * - GET /api/csrf: the CSRF token and its cookie (transport, not part of the service);
 * - GET /health: the build, without data;
 * - everything else (GET and HEAD): the UI's static files, through the single-page fallback.
 *
 * Every response carries the private headers (no-store, nosniff, no referrer, never framed, the strict CSP). A refusal
 * is a google.rpc.Status body and one log line with the request ID, status and reason only, never a path or a URL.
 */
import { issueCsrf, STRICT_CSP, withPrivateHeaders } from '@ziyixi/edge-auth';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { authenticate, checkCsrf, CSRF_COOKIE, csrfKey } from './auth.ts';
import { buildSha, MAILSORT_OBJECT, REQUEST_ID_HEADER, type Env } from './env.ts';
import { MAX_BODY_BYTES } from './limits.ts';
import { errorResponse, REASONS, sortError } from './reasons.ts';

export const API_PREFIX = '/api/v1/';
const IMMUTABLE = 'private, max-age=31536000, immutable';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function methodNotAllowed(allow: string): RpcError {
  const { code, message } = REASONS.METHOD_NOT_ALLOWED;
  return new RpcError(code, 'METHOD_NOT_ALLOWED', message, { httpStatus: 405, headers: { allow } });
}

interface Routed {
  readonly response: Response;
  /** A hashed static file (cacheable). */
  readonly asset: boolean;
  readonly reason?: string | undefined;
}

/** The API request forwarded to MailsortState, with the request ID. */
async function forward(request: Request, env: Env, requestId: string): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  const stub = env.MAILSORT.get(env.MAILSORT.idFromName(MAILSORT_OBJECT));
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return stub.fetch(new Request(request.url, { method: request.method, headers, ...(hasBody ? { body: await request.arrayBuffer() } : {}) }));
}

/**
 * Local development and the smoke test only (`wrangler dev` with DEV_AUTH_BYPASS and DEV_MANUAL_ALARMS, a loopback
 * request): moves MailsortState's clock and runs one alarm pass, so the pipeline can be tried against the fake Gmail and
 * fake Workers AI without waiting. POST /__dev/clock?now=<ms> and POST /__dev/step?now=<ms>. Production never sets
 * either variable, so these paths are the UI's (the single-page fallback) there.
 */
async function devControl(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return new Response('POST only\n', { status: 405 });
  const now = Number(url.searchParams.get('now') ?? '');
  if (!Number.isSafeInteger(now) || now <= 0) return new Response('now=<epoch ms>\n', { status: 400 });
  const stub = env.MAILSORT.get(env.MAILSORT.idFromName(MAILSORT_OBJECT));
  if (url.pathname === '/__dev/clock') {
    await stub.setClock(now);
    return Response.json({ clock: now });
  }
  if (url.pathname === '/__dev/step') return Response.json(await stub.step(now));
  return new Response('not found\n', { status: 404 });
}

async function route(request: Request, env: Env, url: URL, requestId: string): Promise<Routed> {
  const head = request.method === 'HEAD';
  const fail = (error: RpcError): Routed => ({ response: errorResponse(error, requestId, head), asset: false, reason: error.reason });
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && !head) return fail(methodNotAllowed('GET, HEAD'));
    return { response: Response.json({ service: 'mailsort', status: 'ok', build: buildSha(env) }), asset: false };
  }
  const auth = await authenticate(request, env);
  if (!auth.ok) {
    if (auth.failure === 'missing_token' || auth.failure === 'invalid_token') return fail(sortError('UNAUTHORIZED'));
    return fail(sortError(auth.failure === 'keys_unavailable' ? 'UNAVAILABLE' : 'ACCESS_NOT_CONFIGURED'));
  }
  if (url.pathname === '/api/csrf') {
    if (request.method !== 'GET') return fail(methodNotAllowed('GET'));
    const key = await csrfKey(env);
    if (key === null) return fail(sortError('NOT_CONFIGURED'));
    const issued = await issueCsrf(request, auth.owner, { cookieName: CSRF_COOKIE, key });
    const response = Response.json({ token: issued.token });
    response.headers.set('set-cookie', issued.setCookie);
    return { response, asset: false };
  }
  if (url.pathname === '/api/v1' || url.pathname.startsWith(API_PREFIX)) {
    if (!SAFE.has(request.method)) {
      const csrf = await checkCsrf(request, env, auth.owner, auth.bypassed);
      if (csrf === 'no_key') return fail(sortError('NOT_CONFIGURED'));
      if (csrf === 'failed') return fail(sortError('CSRF_FAILED'));
      const length = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) return fail(new RpcError(REASONS.BAD_REQUEST.code, 'BAD_REQUEST', 'the request body is too large'));
    }
    try {
      // MailsortState logs its own refusals; its answer is passed on as it is.
      return { response: await forward(request, env, requestId), asset: false };
    } catch {
      return fail(sortError('UNAVAILABLE'));
    }
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return fail(sortError('NOT_FOUND'));
  if (url.pathname.startsWith('/__dev/') && auth.bypassed && env.DEV_MANUAL_ALARMS === 'true') return { response: await devControl(request, env, url), asset: false };
  if (request.method !== 'GET' && !head) return fail(methodNotAllowed('GET, HEAD'));
  return { response: await env.ASSETS.fetch(request), asset: url.pathname.startsWith('/assets/') };
}

function finalize(response: Response, asset: boolean): Response {
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const cacheable = asset && response.status === 200 && mediaType !== 'text/html';
  return withPrivateHeaders(response, cacheable ? { csp: STRICT_CSP, cacheControl: IMMUTABLE } : { csp: STRICT_CSP });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = newRequestId();
  let routed: Routed;
  try {
    routed = await route(request, env, url, requestId);
  } catch {
    // The assets binding or the CSRF key failed: unavailable, never a page.
    const error = sortError('UNAVAILABLE');
    routed = { response: errorResponse(error, requestId, request.method === 'HEAD'), asset: false, reason: error.reason };
  }
  if (routed.reason !== undefined) {
    // One line per refused request: the request ID, status and reason only (never a path, query or body).
    console.log(JSON.stringify({ request_id: requestId, status: routed.response.status, reason: routed.reason }));
  }
  if (request.body !== null && !request.body.locked) await request.body.cancel();
  return finalize(routed.response, routed.asset);
}
