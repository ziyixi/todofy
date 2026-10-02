/**
 * The request router of the Worker "flowday" (../../docs/design.md §2). Every path needs the owner's Cloudflare Access
 * JWT except /health and the exact PWA files; then
 *
 * - /api/v1/*: the owner API, FlowDayUiService (proto/flowday/ui/v1), served by the shared transcoder with the handlers
 *   of ./api.ts; every method but GET also needs the CSRF token and an allowed Origin (the transcoder's `authorize`
 *   hook runs before the body is read);
 * - GET /api/csrf: the CSRF token and its cookie (transport, not part of the service);
 * - the routes of FlowDay's UI before flowday.ui.v1 (/api/tasks, /api/flows, ...): 410 `reload_required` in their old
 *   error envelope, so a tab still running the old UI tells the owner to reload and loses nothing silently (until
 *   2026-11-02, then NOT_FOUND like any other path);
 * - /api/test/*: the E2E routes, only for a loopback dev-bypass request with E2E_TEST_ROUTES (./e2e.ts);
 * - everything else: the UI's static files (GET and HEAD).
 *
 * Errors are google.rpc.Status bodies (./errors.ts). Each API mutation, and each refused request, logs one line with
 * the request ID, the rpc, the status, the reason and its D1 row counts (and answers them in x-flowday-rows-written),
 * because the account's D1 write allowance is shared with every other app; never a path, query, body or ID.
 */
import { withPrivateHeaders } from '@ziyixi/edge-auth';
import { FlowDayUiService } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { HttpTranscoder, type RouteInfo } from '@ziyixi/proto/http-transcoder';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { handlers, type ApiContext } from './api.ts';
import { PWA_PUBLIC_PATHS, pwaAsset, uiAsset } from './assets.ts';
import { Meter, isStorageError, openDb } from './db.ts';
import { e2eEnabled, e2eRoute } from './e2e.ts';
import type { Env } from './env.ts';
import { API_DOMAIN, REASONS, flowdayError, isReason, localize } from './errors.ts';
import { authenticate, checkCsrf, csrfResponse, jsonResponse, methodNotAllowed, newRequestId, type Principal } from './http.ts';
import { MAX_BODY_BYTES } from './limits.ts';
import { warmUp } from './warmup.ts';

export const ROWS_WRITTEN_HEADER = 'x-flowday-rows-written';
export const API_PREFIX = '/api/v1/';

/**
 * The paths of FlowDay's UI before flowday.ui.v1. Only these answer 410 reload_required; other unknown /api paths are
 * NOT_FOUND.
 */
const LEGACY_PATHS: ReadonlySet<string> = new Set([
  '/api/tasks',
  '/api/tasks/deleted',
  '/api/flows',
  '/api/entries',
  '/api/notes',
  '/api/settings',
  '/api/sync',
  '/api/timer/session',
  '/api/analytics',
]);

export function isLegacyPath(pathname: string): boolean {
  return LEGACY_PATHS.has(pathname) || pathname.startsWith('/api/entries/');
}

/** What the transcoder's authorize hook and the handlers get. */
interface RouteContext extends ApiContext {
  readonly principal: Principal;
}

/** A mutation needs this owner's CSRF token and an allowed Origin (./http.ts). */
async function authorize(request: Request, route: RouteInfo, ctx: RouteContext): Promise<void> {
  if (!route.safe) await checkCsrf(request, ctx.env, ctx.principal);
}

const api = new HttpTranscoder(FlowDayUiService, handlers, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  authorize,
  localize,
  // A failed D1 call may be repeated; anything else unexpected is a bug in FlowDay, never answered as retryable.
  onUnexpected: (error) => flowdayError(isStorageError(error) ? 'UNAVAILABLE' : 'INTERNAL'),
});

// The answer path, compiled and optimized during startup rather than in an isolate's first list answer (./warmup.ts).
warmUp();

function buildSha(env: Env): string {
  const value = (env.BUILD_SHA ?? '').trim();
  return /^[0-9a-f]{7,40}$|^(dev|test)$/.test(value) ? value : 'unknown';
}

/** The old UI's error envelope, {error: {code, message, request_id}}, for the paths it still calls. */
function legacyError(requestId: string, status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message, request_id: requestId } }, status);
}

interface Routed {
  readonly response: Response;
  /** For the log line: the rpc's name, or what kind of path it was (no path, ID or query is logged). */
  readonly route: string;
  readonly reason: string | null;
}

interface RouteInput {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  readonly requestId: string;
  readonly meter: Meter;
  readonly fetcher: typeof fetch;
}

async function route({ request, env, url, requestId, meter, fetcher }: RouteInput): Promise<Routed> {
  const { pathname } = url;
  const head = request.method === 'HEAD';
  const read = request.method === 'GET' || head;
  const fail = (error: RpcError, name: string): Routed => ({ response: api.errorResponse(error, requestId, head), route: name, reason: error.reason });
  if (pathname === '/health') {
    if (!read) return fail(methodNotAllowed('GET, HEAD'), 'health');
    return { response: jsonResponse({ service: 'flowday', status: 'ok', build: buildSha(env) }), route: 'health', reason: null };
  }
  if (PWA_PUBLIC_PATHS.has(pathname)) {
    if (!read) return fail(methodNotAllowed('GET, HEAD'), 'pwa');
    return { response: await pwaAsset(request, env.ASSETS, pathname), route: 'pwa', reason: null };
  }
  let principal: Principal;
  try {
    principal = await authenticate(request, env);
  } catch (error) {
    // edge-auth reports a failed key fetch as `keys_unavailable` (UNAVAILABLE): anything it throws is a bug.
    const rpc = error instanceof RpcError ? error : flowdayError('INTERNAL');
    if (isLegacyPath(pathname)) {
      const copy = isReason(rpc.reason) ? REASONS[rpc.reason].copy : REASONS.UNAVAILABLE.copy;
      return { response: legacyError(requestId, rpc.httpStatus, rpc.reason.toLowerCase(), copy), route: 'legacy', reason: rpc.reason };
    }
    return fail(rpc, pathname.startsWith('/api/') ? 'api' : 'ui');
  }
  if (isLegacyPath(pathname)) {
    return {
      response: legacyError(requestId, 410, 'reload_required', 'FlowDay has been updated. Reload the page to continue.'),
      route: 'legacy',
      reason: 'RELOAD_REQUIRED',
    };
  }
  if (pathname === '/api/csrf') {
    if (request.method !== 'GET') return fail(methodNotAllowed('GET'), 'csrf');
    return { response: await csrfResponse(request, env, principal), route: 'csrf', reason: null };
  }
  const db = openDb(env.DB, meter);
  if (pathname.startsWith('/api/test/') && e2eEnabled(env, principal)) {
    return { response: await e2eRoute(request, env, db, pathname), route: 'test', reason: null };
  }
  if (pathname === '/api/v1' || pathname.startsWith(API_PREFIX)) {
    const ctx: RouteContext = { env, db, fetcher, now: () => new Date(), principal };
    const result = await api.handle(request, ctx, requestId);
    if (result === null) return fail(flowdayError('NOT_FOUND'), 'api');
    return { response: result.response, route: result.route?.method.name ?? 'api', reason: result.error?.reason ?? null };
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) return fail(flowdayError('NOT_FOUND'), 'api');
  if (!read) return fail(methodNotAllowed('GET, HEAD'), 'ui');
  return { response: await uiAsset(request, env.ASSETS, pathname), route: 'ui', reason: null };
}

export async function handleRequest(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const requestId = newRequestId();
  const meter = new Meter();
  let routed: Routed;
  try {
    routed = await route({ request, env, url, requestId, meter, fetcher });
  } catch (error) {
    // Anything that escaped the routes: an RpcError of the transport routes (a missing CSRF secret), or a dependency
    // that failed (the asset store, D1 in the E2E routes): unavailable, as before.
    const rpc = error instanceof RpcError ? error : flowdayError('UNAVAILABLE');
    routed = { response: api.errorResponse(rpc, requestId, request.method === 'HEAD'), route: 'error', reason: rpc.reason };
  }
  if (request.body !== null && !request.body.locked) await request.body.cancel();
  // UI and PWA files carry their own private headers (page CSP, cache policy); everything else gets the defaults.
  const assetPath = !url.pathname.startsWith('/api/') && url.pathname !== '/health';
  if (assetPath && routed.reason === null) return routed.response;
  const final = withPrivateHeaders(routed.response);
  if (!url.pathname.startsWith('/api/')) return final;
  final.headers.set(ROWS_WRITTEN_HEADER, String(meter.rowsWritten));
  if (routed.reason !== null || request.method !== 'GET') {
    console.log(
      JSON.stringify({
        request_id: requestId,
        method: request.method,
        route: routed.route,
        status: final.status,
        code: routed.reason,
        rows_written: meter.rowsWritten,
        rows_read: meter.rowsRead,
      }),
    );
  }
  return final;
}
