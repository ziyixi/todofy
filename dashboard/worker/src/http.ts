/**
 * The owner surface (docs/design.md §6, docs/design-v2.md §5): Access (edge-auth) on every path except /health, then
 *
 * - /api/v1/*: the owner API, DashboardUiService (proto/dashboard/ui/v1), served by the shared transcoder with the
 *   handlers of api.ts; every method but GET also needs the same-origin Origin and the signed double-submit CSRF
 *   token (the transcoder's `authorize` hook runs before the body is read);
 * - GET /api/csrf: the CSRF token and its cookie (transport, not part of the service);
 * - the routes of the UI before dashboard.ui.v1 (/api/v2/home, ...): 410 `reload_required` in their old error
 *   envelope, so a tab still running the old UI tells the owner to reload (until 2026-11-02, then NOT_FOUND like any
 *   other path);
 * - everything else: the UI's static assets (GET and HEAD).
 *
 * Errors are google.rpc.Status bodies (proto/dashboard/ui/v1/errors.proto, common/errors/v1/errors.proto), logged as
 * one line with the request ID, status and reason only. A failed dependency (HomeState, Access's keys) is
 * UNAVAILABLE, which the UI may repeat; anything else unexpected is a bug, INTERNAL. Private headers on every
 * response. Workers Free gives this handler 10 ms of CPU, so it never reads more than a 1 KiB body (a chunked upload
 * is cut off after 1 KiB) and never decodes a view: HomeState serializes each one once (api.ts).
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
import { DashboardUiService } from '@ziyixi/proto/dashboard/ui/v1/dashboard_ui_service_pb';
import { HttpTranscoder, type RouteInfo } from '@ziyixi/proto/http-transcoder';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { dashboardError, handlers, isReason, REASONS, type ApiContext } from './api.ts';
import type { CsrfResponse, HealthResponse, LegacyApiError } from './api-types.ts';
import { buildSha, devNow, publicHost } from './config.ts';
import type { Env } from './env.ts';

export const CSRF_COOKIE = 'home_csrf';
export const MAX_BODY_BYTES = 1024;
/** Access signing keys are cached for 10 minutes (the SPEC's stricter default; Todofy uses 1 h). */
export const JWKS_TTL_MS = 600_000;
export const JWKS_REFRESH_COOLDOWN_MS = 60_000;
export const NBF_LEEWAY_SECONDS = 60;
/** ErrorInfo.domain: the API's name (DashboardUiService's default_host), whatever host serves it. */
export const API_DOMAIN = 'home.ziyixi.science';
export const API_PREFIX = '/api/v1/';
/** The old UI's reload answer on its retired paths (one release, until 2026-11-02). */
export const RELOAD_MESSAGE = '个人控制台已更新，请刷新页面';
const IMMUTABLE = 'private, max-age=31536000, immutable';
const NO_STORE = { 'cache-control': 'no-store' } as const;

interface Context {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  readonly requestId: string;
}

/** The context of an authenticated request: the transcoder's and every handler's. */
interface OwnerContext extends Context, ApiContext {
  readonly owner: string;
  readonly bypassed: boolean;
}

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---- Access ---------------------------------------------------------------------------------------

/** One verifier per isolate: it owns the per-issuer key cache. */
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
    // Local development only: http://localhost|127.0.0.1|[::1] without cf-ray. Anywhere else an enabled
    // bypass refuses every request (503) instead of silently verifying.
    devBypass: {
      enabled: env.DEV_AUTH_BYPASS === 'true',
      hosts: 'loopback-http',
      principal: asciiLowerCase((env.ACCESS_OWNER ?? '').trim()),
      whenNotLocal: 'refuse',
    },
  };
}

async function authenticate(ctx: Context): Promise<OwnerContext> {
  const result = await verifier.verify(ctx.request, accessPolicy(ctx.env));
  if (result.ok) {
    // A request Access verified never reads DEV_NOW, and an enabled bypass refuses every non-loopback request, so a
    // stray DEV_NOW cannot move a production request's clock.
    return { ...ctx, owner: result.owner, bypassed: result.bypassed, at: result.bypassed ? devNow(ctx.env) : null };
  }
  switch (result.failure) {
    case 'not_configured':
    case 'dev_bypass_refused':
      throw dashboardError('ACCESS_NOT_CONFIGURED');
    case 'keys_unavailable':
      throw dashboardError('UNAVAILABLE');
    case 'missing_token':
    case 'invalid_token':
      throw dashboardError('UNAUTHORIZED');
  }
}

// ---- CSRF -----------------------------------------------------------------------------------------

async function csrfKey(env: Env): Promise<CryptoKey> {
  const key = await importHmacKeyHex((env.CSRF_SIGNING_KEY ?? '').trim());
  if (key === null) throw dashboardError('NOT_CONFIGURED');
  return key;
}

function allowedOrigins(ctx: OwnerContext): string[] {
  const host = publicHost(ctx.env);
  const origins = host === null ? [] : [`https://${host}`];
  // The loopback dev server is plain HTTP on its own port.
  if (ctx.bypassed) origins.push(ctx.url.origin.toLowerCase());
  return origins;
}

/** The transcoder's authorize hook: a mutation needs Origin and the CSRF token of this owner (the key first). */
async function authorize(request: Request, route: RouteInfo, ctx: OwnerContext): Promise<void> {
  if (route.safe) return;
  const key = await csrfKey(ctx.env);
  const result = await verifyCsrf(request, ctx.owner, { cookieName: CSRF_COOKIE, key, allowedOrigins: allowedOrigins(ctx) });
  if (!result.ok) throw dashboardError('CSRF_FAILED');
}

async function csrfResponse(ctx: OwnerContext): Promise<Response> {
  const key = await csrfKey(ctx.env);
  const issued = await issueCsrf(ctx.request, ctx.owner, { cookieName: CSRF_COOKIE, key });
  const body: CsrfResponse = { token: issued.token };
  const response = Response.json(body, { headers: NO_STORE });
  response.headers.set('set-cookie', issued.setCookie);
  return response;
}

// ---- routes ---------------------------------------------------------------------------------------

/** Built at global scope: the route table is read from the descriptors during startup, outside any request. */
const api = new HttpTranscoder(DashboardUiService, handlers, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  authorize,
  localize: (reason) => (isReason(reason) ? { locale: 'zh-CN', message: REASONS[reason].zh } : undefined),
  // A bug (api.ts wraps its HomeState calls as UNAVAILABLE itself): never answered as retryable.
  onUnexpected: () => dashboardError('INTERNAL'),
});

function methodNotAllowed(allow: string): RpcError {
  return dashboardError('METHOD_NOT_ALLOWED', { allow });
}

/** A path of the UI's API before dashboard.ui.v1 (/api/v2/..., anything under /api but /api/v1 and /api/csrf). */
export function legacyApi(pathname: string): boolean {
  return pathname === '/api' || (pathname.startsWith('/api/') && !pathname.startsWith(API_PREFIX) && pathname !== '/api/v1' && pathname !== '/api/csrf');
}

/** The old UI's error envelope, {error: {code, message, request_id}}, for the paths it still calls. */
function legacyError(ctx: Context, status: number, code: string, message: string): Response {
  const body: LegacyApiError = { error: { code, message, request_id: ctx.requestId } };
  return Response.json(body, { status, headers: NO_STORE });
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
    const body: HealthResponse = { service: 'home', status: 'ok', build: buildSha(env) };
    return { response: Response.json(body, { headers: NO_STORE }), asset: false };
  }
  let ctx: OwnerContext;
  try {
    ctx = await authenticate(base);
  } catch (error) {
    // edge-auth reports a failed key fetch as `keys_unavailable` (UNAVAILABLE): anything it throws is a bug.
    const rpc = error instanceof RpcError ? error : dashboardError('INTERNAL');
    if (legacyApi(url.pathname)) {
      const message = isReason(rpc.reason) ? REASONS[rpc.reason].zh : REASONS.UNAVAILABLE.zh;
      return { response: legacyError(base, rpc.httpStatus, rpc.reason.toLowerCase(), message), asset: false, reason: rpc.reason };
    }
    return fail(rpc);
  }
  if (legacyApi(url.pathname)) {
    return { response: legacyError(ctx, 410, 'reload_required', RELOAD_MESSAGE), asset: false, reason: 'RELOAD_REQUIRED' };
  }
  if (url.pathname === '/api/csrf') {
    // GET only, as before: a token and its cookie are issued to a page that asks for one.
    if (request.method !== 'GET') return fail(methodNotAllowed('GET'));
    try {
      return { response: await csrfResponse(ctx), asset: false };
    } catch (error) {
      return fail(error instanceof RpcError ? error : dashboardError('INTERNAL'));
    }
  }
  if (url.pathname === '/api/v1' || url.pathname.startsWith(API_PREFIX)) {
    const result = await api.handle(request, ctx, ctx.requestId);
    if (result === null) return fail(dashboardError('NOT_FOUND'));
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
    const error = dashboardError('UNAVAILABLE');
    result = { response: api.errorResponse(error, ctx.requestId, request.method === 'HEAD'), asset: false, reason: error.reason };
  }
  if (result.reason !== undefined) {
    // One line per refused request: the request ID, status and reason only (never a path, query or body).
    console.log(JSON.stringify({ request_id: ctx.requestId, status: result.response.status, reason: result.reason }));
  }
  // An answer given on the headers alone leaves the upload unread: discard it.
  if (request.body !== null && !request.body.locked) await request.body.cancel();
  return finalize(result.response, result.asset);
}
