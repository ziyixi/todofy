// The owner API's HTTP surface, every path under /api/ but the backup machine API (index.ts routes that one first):
// Cloudflare Access (security.ts, packages/edge-auth) on every path, then
//
// - /api/v2/*: the owner API, mailhero.ui.v2 MailHeroUiService (proto/mailhero/ui/v2), served by the shared transcoder
//   with the handlers of api-v2.ts; every method but GET also needs MAINTENANCE_MODE off, the same-origin Origin and
//   the signed double-submit CSRF token (the transcoder's `authorize` hook runs before the body is read), and runs under
//   the coordinator's write lease;
//   Two reads whose answers cost more CPU than a Worker request has on Workers Free (DELEGATED: a message's parsed
//   content, up to about 4 MiB of JSON, and the delivery dashboard's numbers, whose first time zone in an isolate loads
//   ICU's zone data) are answered by the coordinator, a Durable Object with 30 s per invocation: the Worker
//   authenticates, forwards the method and path, and streams the coordinator's answer back. The coordinator runs the
//   same transcoder and handlers (handleDelegated), for those routes only;
// - GET /api/v2/messages/{message}/raw and /api/v2/messages/{message}/attachments/{part_id}: the two downloads, outside
//   the service (they stream bytes; mail_hero_ui_service.proto says why), behind the same authentication;
// - GET /api/csrf: the CSRF token and its cookie (transport, not part of the service);
// - /api/v1/*, the hand-written owner API before mailhero.ui.v2: 410 `reload_required` in its old error envelope, so a
//   tab still running the old UI tells the owner to reload (until 2026-11-01, then NOT_FOUND like any other path).
//
// Errors are google.rpc.Status bodies (errors.proto), logged as one line with the request ID, status and reason only
// (never a path, query, body or anything of mail). Every response has the private headers (security.ts
// privateResponse: no-store, nosniff, no referrer, no framing, Mail Hero's CSP). Workers Free gives this handler 10 ms of
// CPU: bodies are at most MAX_BODY_BYTES, every answer is bounded (api-v2.ts).
import { HttpTranscoder, type RouteInfo } from '@ziyixi/proto/http-transcoder'
import { MailHeroUiService } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { RpcError } from '@ziyixi/proto/rpc-status'
import type { Env } from './types.ts'
import { API_PREFIX, fromHttpError, handlers, isReason, mhError, REASONS, unexpected, type ApiContext } from './api-v2.ts'
import { downloadMessage } from './api-messages.ts'
import { withDependencies } from './dependencies.ts'
import { authenticate, csrfResponse, HttpError, json, privateResponse, requireCSRF } from './security.ts'
import { parseStatus } from '@ziyixi/proto/rpc-status'

/** ErrorInfo.domain: the API's name (MailHeroUiService's default_host), whatever host serves it. */
export const API_DOMAIN = 'mail-hero.ziyixi.science'
/** The largest request body the transcoder reads (the old API's limit). */
export const MAX_BODY_BYTES = 64 * 1024
/** The old API's paths, answered 410 reload_required for one release (remove after 2026-11-01: HANDOFF.md). */
const LEGACY_PREFIX = '/api/v1'
const CSRF_PATH = '/api/csrf'
const DOWNLOAD = /^\/api\/v2\/messages\/([^/]+)\/(?:raw|attachments\/([^/]+))$/
/** The reads the coordinator answers (GetMessageContent, SummarizeDeliveryAttempts): their GET bindings' paths. */
const DELEGATED = [/^\/api\/v2\/messages\/[^/]+\/content$/, /^\/api\/v2\/deliveries\/[^/]+\/attempts:summarize$/]
/** Where the coordinator takes a delegated read (its own path prefix, before the API's path). */
export const DELEGATED_PREFIX = '/owner-api'
const REQUEST_ID_HEADER = 'x-mail-hero-request-id'

function delegated(request: Request, url: URL): boolean {
  return (request.method === 'GET' || request.method === 'HEAD') && DELEGATED.some(pattern => pattern.test(url.pathname))
}

interface Context extends ApiContext {
  readonly request: Request
  readonly requestId: string
}

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** The transcoder's authorize hook: a mutation needs maintenance off, then Origin and the owner's CSRF token. */
async function authorize(request: Request, route: RouteInfo, ctx: Context): Promise<void> {
  if (route.safe) return
  if (ctx.env.MAINTENANCE_MODE === 'true') throw mhError('MAINTENANCE')
  await requireCSRF(request, ctx.env, ctx.owner)
}

const api = new HttpTranscoder(MailHeroUiService, handlers, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  authorize,
  localize: reason => (isReason(reason) ? { locale: 'zh-CN', message: REASONS[reason].zh } : undefined),
  onUnexpected: unexpected,
})

/** The old API's error envelope, {error: {code, message, request_id}}, for the paths an old tab still calls. */
function legacyError(status: number, code: string, message: string, requestId: string): Response {
  return json({ error: { code, message, request_id: requestId } }, status)
}

function isLegacy(pathname: string): boolean {
  return pathname === LEGACY_PREFIX || pathname.startsWith(`${LEGACY_PREFIX}/`)
}

interface Routed {
  readonly response: Response
  readonly reason?: string | undefined
}

async function download(ctx: Context, url: URL, match: RegExpExecArray): Promise<Routed> {
  const head = ctx.request.method === 'HEAD'
  const fail = (error: RpcError): Routed => ({ response: api.errorResponse(error, ctx.requestId, head), reason: error.reason })
  if (ctx.request.method !== 'GET') return fail(mhError('METHOD_NOT_ALLOWED', { httpStatus: 405, headers: { allow: 'GET' } }))
  let id: string, part: string | undefined
  try {
    id = decodeURIComponent(match[1]!).toLowerCase()
    part = match[2] === undefined ? undefined : decodeURIComponent(match[2])
  } catch {
    return fail(mhError('BAD_REQUEST'))
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || url.search !== '') return fail(mhError('BAD_REQUEST'))
  try {
    return { response: await downloadMessage(ctx.env, id, part) }
  } catch (error) {
    return fail(error instanceof HttpError ? fromHttpError(error, true) : unexpected(error))
  }
}

async function route(request: Request, env: Env, requestId: string): Promise<Routed> {
  const url = new URL(request.url)
  const head = request.method === 'HEAD'
  const legacy = isLegacy(url.pathname)
  let owner: string
  try {
    owner = await authenticate(request, env)
  } catch (error) {
    // The old envelope for an old tab, as the old API answered; a Status for everything else.
    const rpc = error instanceof HttpError ? fromHttpError(error) : mhError('INTERNAL')
    if (legacy) {
      const known = error instanceof HttpError
      return { response: legacyError(known ? error.status : 503, known ? error.code : 'service_unavailable', known ? error.message : '服务暂不可用，请稍后重试', requestId), reason: rpc.reason }
    }
    return { response: api.errorResponse(rpc, requestId, head), reason: rpc.reason }
  }
  if (legacy) return { response: legacyError(410, 'reload_required', 'Mail Hero 已更新，请刷新页面', requestId), reason: 'RELOAD_REQUIRED' }
  const ctx: Context = { env: withDependencies(env), owner, request, requestId }
  const fail = (error: RpcError): Routed => ({ response: api.errorResponse(error, requestId, head), reason: error.reason })
  if (url.pathname === CSRF_PATH) {
    if (request.method !== 'GET') return fail(mhError('METHOD_NOT_ALLOWED', { httpStatus: 405, headers: { allow: 'GET' } }))
    try {
      return { response: await csrfResponse(request, ctx.env, owner) }
    } catch (error) {
      return fail(unexpected(error))
    }
  }
  const downloadMatch = DOWNLOAD.exec(url.pathname)
  if (downloadMatch !== null) return download(ctx, url, downloadMatch)
  if (delegated(request, url)) return forward(ctx, url)
  if (url.pathname === '/api/v2' || url.pathname.startsWith(API_PREFIX)) {
    const result = await api.handle(request, ctx, requestId)
    if (result !== null) return { response: result.response, reason: result.error?.reason }
  }
  return fail(mhError('NOT_FOUND'))
}

/** A delegated read: the coordinator's answer, streamed back as it is (its error body read for the log line only). */
async function forward(ctx: Context, url: URL): Promise<Routed> {
  const head = ctx.request.method === 'HEAD'
  let response: Response
  try {
    response = await ctx.env.COORDINATOR.get(ctx.env.COORDINATOR.idFromName('inbox-v1')).fetch(`https://coordinator${DELEGATED_PREFIX}${url.pathname}${url.search}`, {
      method: ctx.request.method, headers: { [REQUEST_ID_HEADER]: ctx.requestId },
    })
  } catch {
    const error = mhError('UNAVAILABLE')
    return { response: api.errorResponse(error, ctx.requestId, head), reason: error.reason }
  }
  if (response.ok) return { response }
  const text = head ? '' : await response.text()
  let reason: string | undefined
  try { reason = parseStatus(response.status, JSON.parse(text))?.reason } catch { reason = undefined }
  return { response: new Response(head ? null : text, response), reason: reason ?? 'UNAVAILABLE' }
}

/**
 * The coordinator's side of a delegated read (its fetch handler routes DELEGATED_PREFIX here): the same transcoder and
 * handlers as the Worker, for the DELEGATED routes only, with the Worker's request ID. Only the Worker calls it, after
 * authentication: a Durable Object has no public route.
 */
export async function handleDelegated(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.slice(DELEGATED_PREFIX.length)
  const requestId = /^[0-9a-f]{16}$/.test(request.headers.get(REQUEST_ID_HEADER) ?? '') ? request.headers.get(REQUEST_ID_HEADER)! : newRequestId()
  const inner = new Request(`https://${API_DOMAIN}${path}${url.search}`, { method: request.method })
  const head = request.method === 'HEAD'
  if (!url.pathname.startsWith(`${DELEGATED_PREFIX}/`) || !delegated(inner, new URL(inner.url))) return api.errorResponse(mhError('NOT_FOUND'), requestId, head)
  const result = await api.handle(inner, { env: withDependencies(env), owner: '', request: inner, requestId }, requestId)
  return result?.response ?? api.errorResponse(mhError('NOT_FOUND'), requestId, head)
}

/** Every request under /api/ but the backup machine API. */
export async function handleAPI(request: Request, env: Env): Promise<Response> {
  const requestId = newRequestId()
  let result: Routed
  try {
    result = await route(request, env, requestId)
  } catch {
    // Anything that escaped the routes: a bug.
    const error = mhError('INTERNAL')
    result = { response: api.errorResponse(error, requestId, request.method === 'HEAD'), reason: error.reason }
  }
  if (result.reason !== undefined) {
    // One line per refused request: the request ID, status and reason only.
    console.log(JSON.stringify({ request_id: requestId, status: result.response.status, reason: result.reason }))
  }
  if (request.body !== null && !request.body.locked) await request.body.cancel()
  return privateResponse(result.response)
}

/** The Status of a request refused before routing (index.ts: MAINTENANCE_MODE refuses every mutation first). */
export function refusedResponse(reason: 'MAINTENANCE', head = false): Response {
  return privateResponse(api.errorResponse(mhError(reason), newRequestId(), head))
}
