/**
 * The Worker's HTTP surface (../../docs/design.md §2-§4, §7). Two halves on one host:
 *
 * The short links, outside Access (anyone may ask; resolve.ts decides what they learn):
 * - GET/HEAD /<key>, /<key>/<rest>, /<key>+: the redirect (302), the preview page, or the continuation to /_/k/;
 * - `/` redirects to the launcher /_/, `/robots.txt` disallows everything, any other path is 404, and any method
 *   but GET and HEAD is 405.
 *
 * The owner's half, /_/ (the path-scoped Access application covers /_/* and the exact /_; the Worker verifies the
 * Access JWT itself on every request):
 * - /_/api/v1/*: LinksUiService (proto/links/ui/v1) through the shared transcoder, with Origin and the CSRF token
 *   checked for every method but GET before the body is read; GET /_/api/csrf issues the token (transport);
 * - /_/k/<key>[+][/<rest>]: the continuation a short link sends the owner to: the live link's answer, else the
 *   launcher (which offers to create the key);
 * - /_/: the launcher's page. Its files under /_/assets/ never reach the Worker (wrangler.toml run_worker_first);
 *   `/_` redirects to `/_/`.
 *
 * Every response is private (`private, no-store`, never cached by Cloudflare or a shared cache), `noindex`, never
 * framed, with the strict CSP and no referrer. Only 302 redirects, never 301/308: a browser keeps those forever,
 * which would outlive an edit or a delete. Errors under /_/ are google.rpc.Status bodies, logged as one line with
 * the request ID, status and reason only; the short-link half logs nothing at all (never a key, a path or a target).
 */
import { issueCsrf, STRICT_CSP, withPrivateHeaders } from '@ziyixi/edge-auth';
import { HttpTranscoder, type RouteInfo } from '@ziyixi/proto/http-transcoder';
import { LinksUiService } from '@ziyixi/proto/links/ui/v1/links_ui_service_pb';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { handlers, isReason, linksError, REASONS, type ApiContext } from './api.ts';
import { authenticate, checkCsrf, CSRF_COOKIE, csrfKey, isOwner } from './auth.ts';
import type { Env } from './env.ts';
import { parseShortPath, type ShortPath } from './keys.ts';
import { MAX_BODY_BYTES, REST_MAX } from './limits.ts';
import { NOT_FOUND_TEXT, previewPage, refusalText, ROBOTS_TXT } from './pages.ts';
import { readResolvable, resolve, resolveForOwner, type Resolution } from './resolve.ts';

/** ErrorInfo.domain: the API's name (LinksUiService's default_host), whatever host serves it. */
export const API_DOMAIN = 's.ziyixi.science';
export const API_PREFIX = '/_/api/v1/';
const CACHE_CONTROL = 'private, no-store';

interface Context extends ApiContext {
  readonly request: Request;
  readonly url: URL;
  readonly requestId: string;
  readonly owner: string;
  readonly bypassed: boolean;
}

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The transcoder's authorize hook: a mutation needs the same-origin Origin and this owner's CSRF token. */
async function authorize(request: Request, route: RouteInfo, ctx: Context): Promise<void> {
  if (route.safe) return;
  const result = await checkCsrf(request, ctx.env, ctx.owner, ctx.bypassed);
  if (result === 'no_key') throw linksError('NOT_CONFIGURED');
  if (result === 'failed') throw linksError('CSRF_FAILED');
}

const api = new HttpTranscoder(LinksUiService, handlers, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  authorize,
  localize: (reason) => (isReason(reason) ? { locale: 'zh-CN', message: REASONS[reason].zh } : undefined),
  // A bug (api.ts wraps its D1 calls as UNAVAILABLE itself): never answered as retryable.
  onUnexpected: () => linksError('INTERNAL'),
});

// ---- responses ------------------------------------------------------------------------------------------------------

function text(body: string, status: number, head: boolean, headers: Record<string, string> = {}): Response {
  return new Response(head ? null : body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

const notAllowed = (head: boolean) => text('Method not allowed.\n', 405, head, { allow: 'GET, HEAD' });

/** The answer of a short-link resolution. */
function answer(resolution: Resolution, head: boolean): Response {
  switch (resolution.kind) {
    case 'redirect':
      return redirect(resolution.location);
    case 'preview':
      return new Response(head ? null : previewPage(resolution.key, resolution.row, resolution.url), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    case 'refused':
      return text(refusalText(resolution.problem), 404, head);
  }
}

/** The short path of a request, or null for any path that names no usable key or has too long a rest. */
function shortPath(pathname: string): ShortPath | null {
  const path = parseShortPath(pathname);
  return path === null || path.rest.length > REST_MAX ? null : path;
}

// ---- the short links ------------------------------------------------------------------------------------------------

async function shortLink(request: Request, env: Env, url: URL): Promise<Response> {
  const head = request.method === 'HEAD';
  if (request.method !== 'GET' && !head) return notAllowed(head);
  if (url.pathname === '/') return redirect('/_/');
  if (url.pathname === '/robots.txt') return text(ROBOTS_TXT, 200, head);
  const path = shortPath(url.pathname);
  if (path === null) return text(NOT_FOUND_TEXT, 404, head);
  const row = await readResolvable(env.DB, path.key);
  return answer(await resolve(path, row, Date.now(), () => isOwner(request, env)), head);
}

// ---- the owner's half ---------------------------------------------------------------------------------------------------

async function csrfResponse(ctx: Context): Promise<Response> {
  const key = await csrfKey(ctx.env);
  if (key === null) throw linksError('NOT_CONFIGURED');
  const issued = await issueCsrf(ctx.request, ctx.owner, { cookieName: CSRF_COOKIE, key });
  const response = Response.json({ token: issued.token }, { headers: { 'cache-control': 'no-store' } });
  response.headers.set('set-cookie', issued.setCookie);
  return response;
}

/** The launcher's page (web/dist/_/index.html, which the assets binding serves at /_/). */
async function launcher(ctx: Context, head: boolean): Promise<Response> {
  const page = await ctx.env.ASSETS.fetch(new Request(new URL('/_/', ctx.url), { method: 'GET' }));
  return head ? new Response(null, page) : page;
}

interface Routed {
  readonly response: Response;
  /** The refusal's reason, for the one log line. */
  readonly reason?: string | undefined;
}

async function owned(base: { request: Request; env: Env; url: URL; requestId: string }): Promise<Routed> {
  const { request, url } = base;
  const head = request.method === 'HEAD';
  const fail = (error: RpcError): Routed => ({ response: api.errorResponse(error, base.requestId, head), reason: error.reason });
  const auth = await authenticate(request, base.env);
  if (!auth.ok) {
    if (auth.failure === 'missing_token' || auth.failure === 'invalid_token') return fail(linksError('UNAUTHORIZED'));
    return fail(linksError(auth.failure === 'keys_unavailable' ? 'UNAVAILABLE' : 'ACCESS_NOT_CONFIGURED'));
  }
  const ctx: Context = { ...base, now: Date.now(), owner: auth.owner, bypassed: auth.bypassed };
  try {
    if (url.pathname === '/_/api/v1' || url.pathname.startsWith(API_PREFIX)) {
      const result = await api.handle(request, ctx, ctx.requestId);
      if (result === null) return fail(linksError('NOT_FOUND'));
      return { response: result.response, reason: result.error?.reason };
    }
    if (url.pathname === '/_/api/csrf') {
      if (request.method !== 'GET') return fail(methodNotAllowed('GET'));
      return { response: await csrfResponse(ctx) };
    }
    if (request.method !== 'GET' && !head) return fail(methodNotAllowed('GET, HEAD'));
    if (url.pathname === '/_/') return { response: await launcher(ctx, head) };
    if (url.pathname.startsWith('/_/k/')) {
      // The owner's continuation: the same path the short link had, after /_/k.
      const path = shortPath(url.pathname.slice('/_/k'.length));
      const row = path === null ? null : await readResolvable(ctx.env.DB, path.key);
      const resolution = path === null ? null : resolveForOwner(path, row, ctx.now);
      return { response: resolution === null ? await launcher(ctx, head) : answer(resolution, head) };
    }
    return fail(linksError('NOT_FOUND'));
  } catch (error) {
    // D1 or the assets binding failed (the API's own calls are mapped inside the transcoder).
    return fail(error instanceof RpcError ? error : linksError('UNAVAILABLE'));
  }
}

function methodNotAllowed(allow: string): RpcError {
  const { code, message } = REASONS.METHOD_NOT_ALLOWED;
  return new RpcError(code, 'METHOD_NOT_ALLOWED', message, { httpStatus: 405, headers: { allow } });
}

// ---- the entry ---------------------------------------------------------------------------------------------------------

/** The private headers of every response, plus `noindex` (also on the redirects, which crawlers follow). */
function finalize(response: Response): Response {
  const done = withPrivateHeaders(response, { csp: STRICT_CSP, cacheControl: CACHE_CONTROL });
  done.headers.set('x-robots-tag', 'noindex');
  return done;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let response: Response;
  if (url.pathname === '/_') {
    response = redirect('/_/');
  } else if (url.pathname.startsWith('/_/')) {
    const requestId = newRequestId();
    let routed: Routed;
    try {
      routed = await owned({ request, env, url, requestId });
    } catch {
      const error = linksError('UNAVAILABLE');
      routed = { response: api.errorResponse(error, requestId, request.method === 'HEAD'), reason: error.reason };
    }
    if (routed.reason !== undefined) {
      // One line per refused owner request: the request ID, status and reason only (never a path, query or body).
      console.log(JSON.stringify({ request_id: requestId, status: routed.response.status, reason: routed.reason }));
    }
    response = routed.response;
  } else {
    try {
      response = await shortLink(request, env, url);
    } catch {
      // D1 failed: the same answer for every key, nothing logged.
      response = text('Temporarily unavailable.\n', 503, request.method === 'HEAD', { 'retry-after': '5' });
    }
  }
  if (request.body !== null && !request.body.locked) await request.body.cancel();
  return finalize(response);
}
