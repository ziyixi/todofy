/**
 * The Worker's HTTP surface (docs/design.md §8): Access (edge-auth) on every path except /health, then
 *
 * - /api/v1/*: the owner API, LabUiService (proto/lab/ui/v1), served by the shared transcoder with the
 *   handlers of api.ts; every method but GET also needs the same-origin Origin and the signed double-submit
 *   CSRF token (the transcoder's `authorize` hook runs before the body is read);
 * - GET /api/csrf: the CSRF token and its cookie (transport, not part of the service);
 * - the routes of Lab's UI before lab.ui.v1 (/api/today, /api/decks/...): 410 `reload_required` in their old
 *   error envelope, so a tab still running the old UI tells the owner to reload (until 2026-11-01, then
 *   NOT_FOUND like any other path);
 * - everything else: the UI's static assets (GET and HEAD).
 *
 * Errors are google.rpc.Status bodies (proto/lab/ui/v1/errors.proto), logged as one line with the request
 * ID, status and reason only. Private headers on every response. Workers Free gives this handler 10 ms of CPU:
 * bodies are at most MAX_BODY_BYTES, answers are bounded.
 */
import {
  STRICT_CSP,
  asciiLowerCase,
  createAccessVerifier,
  importHmacKeyHex,
  issueCsrf,
  verifyCsrf,
  withPrivateHeaders,
  type AccessPolicy,
} from '@ziyixi/edge-auth';
import { HttpTranscoder, type RouteInfo } from '@ziyixi/proto/http-transcoder';
import { LabUiService } from '@ziyixi/proto/lab/ui/v1/lab_ui_service_pb';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { handlers, isReason, labError, REASONS, type ApiContext } from './api.ts';
import { buildSha, publicHost } from './config.ts';
import type { Env } from './env.ts';
import { MAX_BODY_BYTES } from './limits.ts';

export const CSRF_COOKIE = 'lab_csrf';
export const JWKS_TTL_MS = 600_000;
export const JWKS_REFRESH_COOLDOWN_MS = 60_000;
export const NBF_LEEWAY_SECONDS = 60;
/** ErrorInfo.domain: the API's name (LabUiService's default_host), whatever host serves it. */
export const API_DOMAIN = 'lab.ziyixi.science';
export const API_PREFIX = '/api/v1/';
const IMMUTABLE = 'private, max-age=31536000, immutable';

interface Context extends ApiContext {
  readonly request: Request;
  readonly url: URL;
  readonly requestId: string;
  /** Set once Access let the owner in. */
  readonly owner?: string;
  readonly bypassed?: boolean;
}

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---- Access and CSRF (packages/edge-auth SPEC §5.4, the dashboard's policy) ------------------------------

const verifier = createAccessVerifier();

export function accessPolicy(env: Env): AccessPolicy {
  return {
    issuer: env.ACCESS_ISSUER,
    audience: env.ACCESS_AUDIENCE,
    owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: NBF_LEEWAY_SECONDS,
    tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
    jwks: { ttlMs: JWKS_TTL_MS, refreshCooldownMs: JWKS_REFRESH_COOLDOWN_MS },
    devBypass: {
      enabled: env.DEV_AUTH_BYPASS === 'true',
      hosts: 'loopback-http',
      principal: asciiLowerCase((env.ACCESS_OWNER ?? '').trim()),
      whenNotLocal: 'refuse',
    },
  };
}

async function authenticate(ctx: Context): Promise<{ owner: string; bypassed: boolean }> {
  const result = await verifier.verify(ctx.request, accessPolicy(ctx.env));
  if (result.ok) return { owner: result.owner, bypassed: result.bypassed };
  switch (result.failure) {
    case 'not_configured':
    case 'dev_bypass_refused':
      throw labError('ACCESS_NOT_CONFIGURED');
    case 'keys_unavailable':
      throw labError('UNAVAILABLE');
    case 'missing_token':
    case 'invalid_token':
      throw labError('UNAUTHORIZED');
  }
}

async function csrfKey(env: Env): Promise<CryptoKey> {
  const key = await importHmacKeyHex((env.CSRF_SIGNING_KEY ?? '').trim());
  if (key === null) throw labError('NOT_CONFIGURED');
  return key;
}

function allowedOrigins(ctx: Context): string[] {
  const host = publicHost(ctx.env);
  const origins = host === null ? [] : [`https://${host}`];
  if (ctx.bypassed === true) origins.push(ctx.url.origin.toLowerCase());
  return origins;
}

/** The transcoder's authorize hook: a mutation needs Origin and the CSRF token of this owner. */
async function authorize(request: Request, route: RouteInfo, ctx: Context): Promise<void> {
  if (route.safe) return;
  const key = await csrfKey(ctx.env);
  const result = await verifyCsrf(request, ctx.owner ?? '', { cookieName: CSRF_COOKIE, key, allowedOrigins: allowedOrigins(ctx) });
  if (!result.ok) throw labError('CSRF_FAILED');
}

// ---- routes ----------------------------------------------------------------------------------------------------

const api = new HttpTranscoder(LabUiService, handlers, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  authorize,
  localize: (reason) => (isReason(reason) ? { locale: 'zh-CN', message: REASONS[reason].zh } : undefined),
  // A failed LabState or D1 call: the request may be repeated with its request_id.
  onUnexpected: () => labError('UNAVAILABLE'),
});

function methodNotAllowed(allow: string): RpcError {
  const { code, message } = REASONS.METHOD_NOT_ALLOWED;
  return new RpcError(code, 'METHOD_NOT_ALLOWED', message, { httpStatus: 405, headers: { allow } });
}

/** A path of Lab's UI API before lab.ui.v1 (not /api/v1/*, not /api/csrf). */
function legacyApi(pathname: string): boolean {
  return pathname === '/api' || (pathname.startsWith('/api/') && !pathname.startsWith(API_PREFIX) && pathname !== '/api/v1' && pathname !== '/api/csrf');
}

/** The old UI's error envelope, {error: {code, message, request_id}}, for the paths it still calls. */
function legacyError(ctx: Context, status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, request_id: ctx.requestId } }, { status, headers: { 'cache-control': 'no-store' } });
}

async function csrfResponse(ctx: Context): Promise<Response> {
  const key = await csrfKey(ctx.env);
  const issued = await issueCsrf(ctx.request, ctx.owner ?? '', { cookieName: CSRF_COOKIE, key });
  const response = Response.json({ token: issued.token }, { headers: { 'cache-control': 'no-store' } });
  response.headers.set('set-cookie', issued.setCookie);
  return response;
}

interface Routed {
  readonly response: Response;
  readonly asset: boolean;
  readonly reason?: string | undefined;
}

async function route(base: Context): Promise<Routed> {
  const { request, url, env } = base;
  const head = request.method === 'HEAD';
  const fail = (error: RpcError): Routed => ({ response: api.errorResponse(error, base.requestId, head), asset: false, reason: error.reason });
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && !head) return fail(methodNotAllowed('GET, HEAD'));
    return { response: Response.json({ service: 'lab', status: 'ok', build: buildSha(env) }, { headers: { 'cache-control': 'no-store' } }), asset: false };
  }
  let ctx: Context;
  try {
    ctx = { ...base, ...(await authenticate(base)) };
  } catch (error) {
    const rpc = error instanceof RpcError ? error : labError('UNAVAILABLE');
    if (legacyApi(url.pathname)) {
      const message = isReason(rpc.reason) ? REASONS[rpc.reason].zh : REASONS.UNAVAILABLE.zh;
      return { response: legacyError(base, rpc.httpStatus, rpc.reason.toLowerCase(), message), asset: false, reason: rpc.reason };
    }
    return fail(rpc);
  }
  if (legacyApi(url.pathname)) {
    return { response: legacyError(ctx, 410, 'reload_required', 'Lab 已更新，请刷新页面'), asset: false, reason: 'RELOAD_REQUIRED' };
  }
  if (url.pathname === '/api/csrf') {
    if (request.method !== 'GET') return fail(methodNotAllowed('GET'));
    try {
      return { response: await csrfResponse(ctx), asset: false };
    } catch (error) {
      return fail(error instanceof RpcError ? error : labError('UNAVAILABLE'));
    }
  }
  if (url.pathname === '/api/v1' || url.pathname.startsWith(API_PREFIX)) {
    const result = await api.handle(request, ctx, ctx.requestId);
    if (result === null) return fail(labError('NOT_FOUND'));
    return { response: result.response, asset: false, reason: result.error?.reason };
  }
  if (request.method !== 'GET' && !head) return fail(methodNotAllowed('GET, HEAD'));
  return { response: await env.ASSETS.fetch(request), asset: url.pathname.startsWith('/assets/') };
}

function finalize(response: Response, asset: boolean): Response {
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const cacheable = asset && response.status === 200 && mediaType !== 'text/html';
  return withPrivateHeaders(response, cacheable ? { csp: STRICT_CSP, cacheControl: IMMUTABLE } : { csp: STRICT_CSP });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const ctx: Context = { request, env, url: new URL(request.url), requestId: newRequestId() };
  let result: Routed;
  try {
    result = await route(ctx);
  } catch {
    // Anything that escaped the routes (an asset fetch that threw): unavailable, as before.
    const error = labError('UNAVAILABLE');
    result = { response: api.errorResponse(error, ctx.requestId, request.method === 'HEAD'), asset: false, reason: error.reason };
  }
  if (result.reason !== undefined) {
    // One line per refused request: the request ID, status and reason only (never a path, query or body).
    console.log(JSON.stringify({ request_id: ctx.requestId, status: result.response.status, reason: result.reason }));
  }
  if (request.body !== null && !request.body.locked) await request.body.cancel();
  return finalize(result.response, result.asset);
}
