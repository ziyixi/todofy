/**
 * The Worker's HTTP surface (../../docs/design.md §1, §10). It stays thin (Workers Free: 10 ms of CPU per request): it
 * checks the caller and makes one call to BriefState.
 *
 * - /feedback (exactly; an Access Bypass application lets it through Access): the signed token is verified first and
 *   by its own key (feedback.ts), never by Access; a bad or expired token, another method or another path below it is
 *   404 without any object call. GET answers the confirmation page, POST (the page's button, the token in the form body)
 *   records the vote;
 * - GET /health: the build, without data;
 * - everything else needs the owner's Access JWT, verified here (the whole host is behind Access as well):
 *   - /api/v1/*: BriefUiService (proto/brief/ui/v1). Every method but GET, HEAD and OPTIONS needs the same-origin Origin
 *     and the custom CSRF header and JSON media type, checked here before the body is read; BriefState's transcoder answers;
 *   - GET /api/csrf: the CSRF token and its cookie (transport, not part of the service);
 *   - everything else (GET and HEAD): the archive UI's static files, through the single-page fallback.
 *
 * Every response carries the private headers (no-store, nosniff, no referrer, never framed, the strict CSP). A refusal
 * is one log line with the request ID, status and reason only, never a path, a query or a token.
 */
import { STRICT_CSP, withPrivateHeaders } from '@ziyixi/edge-auth';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { authenticate, checkCsrf } from './auth.ts';
import { BRIEF_OBJECT, buildSha, REQUEST_ID_HEADER, type Env } from './env.ts';
import { confirmPage, FEEDBACK_HEADERS, feedbackKey, recordedPage, verifyFeedback } from './feedback.ts';
import { readCapped } from './fetch/net.ts';
import { newRequestId } from './ids.ts';
import { MAX_BODY_BYTES } from './limits.ts';
import { briefError, errorResponse, REASONS } from './reasons.ts';
import type { BriefState } from './state.ts';

export const API_PREFIX = '/api/v1/';
const IMMUTABLE = 'private, max-age=31536000, immutable';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const FORM_MAX_BYTES = 2048;

function methodNotAllowed(allow: string): RpcError {
  const { code, message } = REASONS.METHOD_NOT_ALLOWED;
  return new RpcError(code, 'METHOD_NOT_ALLOWED', message, { httpStatus: 405, headers: { allow } });
}

interface Routed {
  readonly response: Response;
  readonly asset: boolean;
  readonly reason?: string | undefined;
}

function stub(env: Env): DurableObjectStub<BriefState> {
  return env.BRIEF.get(env.BRIEF.idFromName(BRIEF_OBJECT));
}

async function forward(request: Request, env: Env, requestId: string): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return stub(env).fetch(new Request(request.url, { method: request.method, headers, ...(hasBody ? { body: await request.arrayBuffer() } : {}) }));
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/**
 * The token of a feedback request: the query's `t` on GET, the form body's `t` on POST. The body is read as a stream
 * and given up past 2 KiB, whatever its Content-Length says (a chunked body has none): the route is public.
 */
async function feedbackToken(request: Request, url: URL): Promise<string | null> {
  if (request.method === 'GET') return url.searchParams.get('t');
  if (request.method !== 'POST') return null;
  if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return null;
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > FORM_MAX_BYTES) return null;
  const read = await readCapped(new Response(request.body), FORM_MAX_BYTES, false);
  if (read === null) return null;
  return new URLSearchParams(new TextDecoder().decode(read.body)).get('t');
}

/** /feedback (design §10): the token first, then one object call. */
async function feedback(request: Request, env: Env, url: URL): Promise<Routed> {
  const key = await feedbackKey(env.FEEDBACK_SIGNING_KEY);
  const token = key === null ? null : await feedbackToken(request, url);
  const claim = key === null || token === null ? null : await verifyFeedback(key, token, Date.now());
  if (claim === null || token === null) return { response: notFound(), asset: false, reason: 'feedback_refused' };
  if (request.method === 'GET') {
    const title = await stub(env).feedbackTitle(claim.issue, claim.item);
    if (title === null) return { response: notFound(), asset: false, reason: 'feedback_unknown_item' };
    return { response: new Response(confirmPage(title, claim.vote, token), { headers: FEEDBACK_HEADERS }), asset: false };
  }
  const title = await stub(env).recordFeedback(claim.issue, claim.item, claim.vote);
  if (title === null) return { response: notFound(), asset: false, reason: 'feedback_unknown_item' };
  return { response: new Response(recordedPage(title, claim.vote), { headers: FEEDBACK_HEADERS }), asset: false };
}

async function route(request: Request, env: Env, url: URL, requestId: string): Promise<Routed> {
  const head = request.method === 'HEAD';
  const fail = (error: RpcError): Routed => ({ response: errorResponse(error, requestId, head), asset: false, reason: error.reason });
  if (url.pathname === '/feedback' || url.pathname.startsWith('/feedback/')) {
    if (url.pathname !== '/feedback') return { response: notFound(), asset: false, reason: 'feedback_refused' };
    try {
      return await feedback(request, env, url);
    } catch {
      return { response: new Response('Unavailable', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' } }), asset: false, reason: 'UNAVAILABLE' };
    }
  }
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && !head) return fail(methodNotAllowed('GET, HEAD'));
    return { response: Response.json({ service: 'brief', status: 'ok', build: buildSha(env) }), asset: false };
  }
  const auth = await authenticate(request, env);
  if (!auth.ok) {
    if (auth.failure === 'missing_token' || auth.failure === 'invalid_token') return fail(briefError('UNAUTHORIZED'));
    return fail(briefError(auth.failure === 'keys_unavailable' ? 'UNAVAILABLE' : 'ACCESS_NOT_CONFIGURED'));
  }
  if (url.pathname === '/api/csrf') {
    if (request.method !== 'GET') return fail(methodNotAllowed('GET'));
    const response = Response.json({ token: '1' });
    return { response, asset: false };
  }
  if (url.pathname === '/api/v1' || url.pathname.startsWith(API_PREFIX)) {
    if (!SAFE.has(request.method)) {
      const csrf = await checkCsrf(request, env, auth.bypassed);
      if (csrf === 'failed') return fail(briefError('CSRF_FAILED'));
      const length = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) return fail(briefError('BAD_REQUEST', [], 'the request body is too large'));
    }
    try {
      return { response: await forward(request, env, requestId), asset: false };
    } catch {
      return fail(briefError('UNAVAILABLE'));
    }
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return fail(briefError('NOT_FOUND'));
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
    const error = briefError('UNAVAILABLE');
    routed = { response: errorResponse(error, requestId, request.method === 'HEAD'), asset: false, reason: error.reason };
  }
  if (routed.reason !== undefined) {
    // One line per refused request: the request ID, status and reason only (never a path, query, token or body).
    console.log(JSON.stringify({ request_id: requestId, status: routed.response.status, reason: routed.reason }));
  }
  if (request.body !== null && !request.body.locked) await request.body.cancel();
  return finalize(routed.response, routed.asset);
}
