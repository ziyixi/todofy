/** Same-origin owner API transport: Access cookies, JSON mutations and X-CSRF-Token: 1.
 * Each action keeps its request_id; authorization failures are returned without automatic replay.
 */
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb'
import { createHttpClient, HttpEncodeError, HttpResponseError, RpcStatusError, type HttpCall } from '@ziyixi/proto/http-client'
import type { ErrorReason } from '@ziyixi/proto/links/ui/v1/errors_pb'
import { LinkSchema, type Link } from '@ziyixi/proto/links/ui/v1/link_pb'
import { LinksUiService } from '@ziyixi/proto/links/ui/v1/links_ui_service_pb'
import { readDetail } from '@ziyixi/proto/rpc-status'

export const CSRF_HEADER = 'X-CSRF-Token'

/** An ErrorInfo reason the API answers: links.ui.v1's own (errors.proto) or one every API shares (CommonReason). */
export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>

export class ApiError extends Error {
  readonly status: number
  /** The ErrorInfo reason, or NETWORK_ERROR / BAD_RESPONSE when no Status came back. */
  readonly reason: string
  /** The link an ETAG_MISMATCH or LINK_EXISTS carries. */
  readonly link: Link | null

  constructor(status: number, reason: string, message: string, link: Link | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.reason = reason
    this.link = link
  }

  /** Worth repeating with the same request_id: the network, a failed dependency, or a proxy's page. */
  get transient(): boolean {
    if (this.reason === 'INTERNAL' || this.reason === 'BAD_REQUEST') return false
    return this.status === 0 || this.status >= 500 || this.reason === 'BAD_RESPONSE'
  }
}

/** Shown when fetch itself fails: no network, or Access redirected an expired session (redirect: 'error'). */
export const NETWORK_MESSAGE = '网络异常，或登录已过期，请稍后重试或刷新页面'

/** The launcher's own copy for the reasons it explains differently; the rest show the server's LocalizedMessage. */
const MESSAGES: Readonly<Partial<Record<Reason, string>>> = {
  LINK_EXISTS: '这个短链接已存在',
  ETAG_MISMATCH: '这个短链接已在别处修改，已载入最新内容',
  CSRF_FAILED: '请求来源或格式无效，请刷新页面后重试',
  NOT_FOUND: '找不到这个短链接',
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '出了点问题，请稍后重试'
}

/** Any failure of a call as an ApiError. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof RpcStatusError) {
    const { status } = error
    const reason = status.reason ?? 'BAD_RESPONSE'
    const message = MESSAGES[reason as Reason] ?? status.localizedMessage?.message ?? `请求失败（${reason}）`
    return new ApiError(status.httpStatus, reason, message, readDetail(status, LinkSchema) ?? null)
  }
  // Nothing was sent: the same input fails the same way, so it is a 400, never a network failure to retry.
  if (error instanceof HttpEncodeError) return new ApiError(400, 'BAD_REQUEST', '输入有误')
  if (error instanceof HttpResponseError) return new ApiError(error.httpStatus, 'BAD_RESPONSE', `服务返回了无法识别的响应（HTTP ${error.httpStatus}）`)
  return new ApiError(0, 'BAD_RESPONSE', '服务返回了无法识别的响应')
}

async function fetchSameOrigin(url: string, init: RequestInit): Promise<Response> {
  try {
    // redirect: 'error' so an expired Access session surfaces as an error, not as the login page's HTML.
    return await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', NETWORK_MESSAGE)
  }
}

/** Send JSON mutation headers directly; the Worker checks Origin before parsing the body. */
async function send(call: HttpCall): Promise<Response> {
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(call.httpMethod)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (mutation || call.body !== undefined) headers['Content-Type'] = 'application/json'
  if (mutation) headers['X-CSRF-Token'] = '1'
  return fetchSameOrigin(call.url, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) })
}

/** Every rpc of `client`, its failures turned into ApiErrors. */
function withApiErrors<C extends object>(client: C): C {
  const wrapped: Record<string, (request: unknown) => Promise<unknown>> = {}
  for (const [name, method] of Object.entries(client) as [string, (request: unknown) => Promise<unknown>][]) {
    wrapped[name] = (request) =>
      method(request).catch((error: unknown) => {
        throw toApiError(error)
      })
  }
  return wrapped as C
}

/** LinksUiService: `api.getLink({ name: 'links/gh' })` resolves to a Link. */
export const api = withApiErrors(createHttpClient(LinksUiService, send))

/** A fresh AIP-155 request ID (UUID4) for one user action. */
export function newRequestId(): string {
  return crypto.randomUUID()
}

/** Every link, page by page (at most LINKS_MAX in all). */
export async function listAll(showDeleted: boolean): Promise<Link[]> {
  const links: Link[] = []
  let pageToken = ''
  do {
    const page = await api.listLinks({ pageSize: 100, pageToken, showDeleted })
    links.push(...page.links)
    pageToken = page.nextPageToken
  } while (pageToken !== '')
  return links
}

/** Runs a mutation, repeating it once after a short pause when the failure was transient (same request_id). */
export async function withRetry<T>(run: () => Promise<T>, pauseMs = 800): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof ApiError) || !error.transient) throw error
    await new Promise((resolve) => setTimeout(resolve, pauseMs))
    return run()
  }
}

/** Test hook: forget the cached CSRF token. */
