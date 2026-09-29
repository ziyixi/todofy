/**
 * Owner UI and API on TODOFY_PUBLIC_HOST, always behind Cloudflare Access.
 *
 * The gate, in order: Access JWT on every request (static assets included), then for API writes
 * the CSRF check and MAINTENANCE_MODE, then the route. Every response leaves with the private
 * headers. The API itself runs in the core; the gateway only adds the verified owner.
 */
import { authenticate } from './access.ts';
import { callCoordinator, forward } from './coordinator.ts';
import { csv, flag, variable } from './env.ts';
import { issueCsrf, verifyCsrf } from './csrf.ts';
import { isJsonObject } from './crypto.ts';
import { errorResponse, HttpError, jsonResponse, withPrivateHeaders, type Context } from './http.ts';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const MAINTENANCE_RETRY_AFTER_S = '300';

export async function handleOwner(ctx: Context): Promise<Response> {
  const path = ctx.url.pathname;
  try {
    const owner = await authenticate(ctx.request, ctx.env);
    if (path.startsWith('/api/')) return withPrivateHeaders(await api(ctx, owner));
    // Unknown paths fall back to index.html (not_found_handling = single-page-application).
    return withPrivateHeaders(await ctx.env.ASSETS.fetch(ctx.request), path.startsWith('/assets/'));
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return withPrivateHeaders(errorResponse(ctx.requestId, error.status, error.code));
  }
}

async function api(ctx: Context, owner: string): Promise<Response> {
  const { method } = ctx.request;
  const path = ctx.url.pathname;
  if (!READ_METHODS.has(method)) {
    await verifyCsrf(ctx, owner);
    if (flag(ctx.env, 'MAINTENANCE_MODE')) {
      return errorResponse(ctx.requestId, 503, 'maintenance', { 'retry-after': MAINTENANCE_RETRY_AFTER_S });
    }
  }
  if (method === 'GET' && path === '/api/v1/csrf') return issueCsrf(ctx, owner);
  if (method === 'GET' && path === '/api/v1/setup') return setup(ctx, owner);
  if (!path.startsWith('/api/v1/')) return errorResponse(ctx.requestId, 404, 'not_found');
  const headers: Record<string, string> = { 'x-todofy-owner': owner };
  for (const name of ['content-type', 'content-length']) {
    const value = ctx.request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  // The core checks the declared length before it reads the body (16 KiB), so it is forwarded unread.
  const body = READ_METHODS.has(method) ? null : ctx.request.body;
  return forward(ctx, `${path}${ctx.url.search}`, { method, headers, body });
}

/** The setup page's integration facts: whether each secret is set, never its value. */
async function setup(ctx: Context, owner: string): Promise<Response> {
  const { env } = ctx;
  let core: unknown;
  try {
    const response = await callCoordinator(env, ctx.requestId, '/setup', { method: 'GET' });
    if (response.status !== 200) throw new Error('setup');
    core = await response.json();
  } catch {
    return errorResponse(ctx.requestId, 503, 'unavailable');
  }
  if (!isJsonObject(core) || typeof core.mail_source_id !== 'string' || !isJsonObject(core.configured)) {
    return errorResponse(ctx.requestId, 503, 'unavailable');
  }
  return jsonResponse({
    build: variable(env, 'BUILD_SHA', 'unknown'),
    public_host: variable(env, 'TODOFY_PUBLIC_HOST').toLowerCase(),
    hooks_hosts: csv(env, 'TODOFY_HOOKS_HOSTS'),
    webhook_path: '/hooks/mail',
    mail_source_id: core.mail_source_id,
    access_owner: owner,
    configured: {
      mail_webhook_token: Boolean(variable(env, 'MAIL_WEBHOOK_TOKEN_SHA256')),
      report_basic_auth: Boolean(variable(env, 'REPORT_BASIC_AUTH_SHA256')),
      ...core.configured,
    },
  });
}
