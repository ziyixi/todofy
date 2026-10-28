/**
 * Owner UI and API on TODOFY_PUBLIC_HOST, always behind Cloudflare Access.
 *
 * The gate, in order: Access JWT on every request (static assets included), then
 *
 * - /api/v1/*: the owner API, TodofyUiService (proto/todofy/ui/v1, ui.ts), served by the shared transcoder; for
 *   every method but GET its `authorize` hook checks the same-origin Origin and the custom CSRF header and JSON media type,
 *   then MAINTENANCE_MODE, before the body is read;
 * - GET /task/<id>: a 302 to that task in Tasks (TASKS_PUBLIC_URL), the link the UI shows for a task;
 * - the routes of the owner API before todofy.ui.v1 (api/owner-api-v1.openapi.yaml until 2026-10-02:
 *   /api/v1/overview, /api/v1/events/..., ...): 410 `reload_required` in their old error envelope, so a tab still
 *   running the old UI tells the owner to reload (until 2026-11-02, then NOT_FOUND like any other path);
 * - everything else: the UI's static assets.
 *
 * Errors of the API are google.rpc.Status bodies (proto/todofy/ui/v1/errors.proto, common/errors/v1), logged as
 * one line with the request ID, status and reason only. Every response leaves with the private headers.
 */
import type { RouteInfo } from '@ziyixi/proto/http-transcoder';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { authenticate } from './access.ts';
import { verifyCsrf } from './csrf.ts';
import { variable } from './env.ts';
import { errorEnvelope, HttpError, MESSAGES, withPrivateHeaders, type Context } from './http.ts';
import { maintenance, REASONS, transcoder, uiError, type Reason, type UiContext } from './ui.ts';
import { warmCodec } from './warm.ts';

const API_PREFIX = '/api/v1/';
const TASK_PREFIX = '/task/';
/** A Tasks task ID (its imported Todoist IDs included). */
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The message of the 410 an old UI tab gets (its error panel shows it). */
export const RELOAD_MESSAGE = 'Todofy 已更新，请刷新页面';

/** The paths of the owner API before todofy.ui.v1, which answer 410 until 2026-11-02 (docs/history.md). */
const LEGACY_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/csrf',
  '/api/v1/setup',
  '/api/v1/overview',
  '/api/v1/events',
  '/api/v1/reminders',
  '/api/v1/reports/latest',
  '/api/v1/reports/recompute',
  '/api/v1/metrics/daily',
  '/api/v1/gtd/daily',
]);
const LEGACY_PATTERNS: readonly RegExp[] = [/^\/api\/v1\/events\/[^/]+(\/reconcile)?$/, /^\/api\/v1\/legacy_text\/[^/]+$/];

export function legacyPath(path: string): boolean {
  return LEGACY_PATHS.has(path) || LEGACY_PATTERNS.some((pattern) => pattern.test(path));
}

/** The transcoder's authorize hook: a mutation needs Origin and the CSRF header, and no maintenance. */
async function authorize(request: Request, route: RouteInfo, ctx: UiContext): Promise<void> {
  if (route.safe) return;
  await verifyCsrf(request, ctx.env);
  const refused = maintenance(ctx.env);
  if (refused !== null) throw refused;
}

// Both at global scope, once per isolate and outside every request's CPU limit: the transcoder reads the
// descriptors' bindings, and the codec its rules (warm.ts).
const api = transcoder(authorize);
warmCodec();

/** Access's failures (access.ts answers the hooks' codes) as the API's reasons. */
const ACCESS_REASONS: Readonly<Record<string, Reason>> = {
  unauthorized: 'UNAUTHORIZED',
  unavailable: 'UNAVAILABLE',
  access_not_configured: 'ACCESS_NOT_CONFIGURED',
};

/** A Status response, logged once: the request ID, status and reason only (never a path, query or body). */
function statusResponse(ctx: Context, error: RpcError): Response {
  console.log(JSON.stringify({ request_id: ctx.requestId, status: error.httpStatus, reason: error.reason }));
  return api.errorResponse(error, ctx.requestId, ctx.request.method === 'HEAD');
}

function methodNotAllowed(allow: string): RpcError {
  const { code, message } = REASONS.METHOD_NOT_ALLOWED;
  return new RpcError(code, 'METHOD_NOT_ALLOWED', message, { httpStatus: 405, headers: { allow } });
}

async function route(ctx: Context): Promise<Response> {
  const path = ctx.url.pathname;
  let owner: string;
  try {
    owner = await authenticate(ctx.request, ctx.env);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    // An old tab keeps reading its envelope; everything else gets the API's Status.
    if (legacyPath(path)) return errorEnvelope(ctx.requestId, error.status, error.code, MESSAGES[error.code]);
    return statusResponse(ctx, uiError(ACCESS_REASONS[error.code] ?? 'UNAUTHORIZED'));
  }
  if (legacyPath(path)) return errorEnvelope(ctx.requestId, 410, 'reload_required', RELOAD_MESSAGE);
  if (path.startsWith(TASK_PREFIX)) {
    if (ctx.request.method !== 'GET' && ctx.request.method !== 'HEAD') return statusResponse(ctx, methodNotAllowed('GET, HEAD'));
    const id = path.slice(TASK_PREFIX.length);
    if (!TASK_ID.test(id)) return statusResponse(ctx, uiError('NOT_FOUND'));
    const tasks = variable(ctx.env, 'TASKS_PUBLIC_URL').replace(/\/+$/, '');
    if (tasks === '') return statusResponse(ctx, uiError('NOT_CONFIGURED'));
    return new Response(null, { status: 302, headers: { location: `${tasks}/?task=${id}` } });
  }
  if (path === '/api/v1' || path.startsWith(API_PREFIX)) {
    const result = await api.handle(ctx.request, { env: ctx.env, url: ctx.url, owner }, ctx.requestId);
    if (result === null) return statusResponse(ctx, uiError('NOT_FOUND'));
    if (result.error !== undefined) {
      console.log(JSON.stringify({ request_id: ctx.requestId, status: result.response.status, reason: result.error.reason }));
    }
    return result.response;
  }
  if (path === '/api' || path.startsWith('/api/')) return statusResponse(ctx, uiError('NOT_FOUND'));
  // Unknown paths fall back to index.html (not_found_handling = single-page-application).
  return ctx.env.ASSETS.fetch(ctx.request);
}

export async function handleOwner(ctx: Context): Promise<Response> {
  const response = await route(ctx);
  return withPrivateHeaders(response, ctx.url.pathname.startsWith('/assets/'));
}
