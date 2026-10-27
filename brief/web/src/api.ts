/** Same-origin owner API transport: Access cookies, JSON mutations and X-CSRF-Token: 1.
 * Each action keeps its request_id; authorization failures are returned without automatic replay.
 */
import { BriefUiService } from '@ziyixi/proto/brief/ui/v1/brief_ui_service_pb'
import type { ErrorReason } from '@ziyixi/proto/brief/ui/v1/errors_pb'
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb'
import { createHttpClient, HttpEncodeError, HttpResponseError, RpcStatusError, type HttpCall } from '@ziyixi/proto/http-client'

const CSRF_HEADER = 'X-CSRF-Token'

/** An ErrorInfo reason the API answers: brief.ui.v1's own (errors.proto) or one every API shares (CommonReason). */
export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>

export class ApiError extends Error {
  readonly status: number
  /** The ErrorInfo reason, or NETWORK_ERROR / BAD_RESPONSE when no Status came back. */
  readonly reason: string

  constructor(status: number, reason: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.reason = reason
  }

  /** Worth repeating with the same request_id: the network, a failed dependency, or a proxy's page. */
  get transient(): boolean {
    if (this.reason === 'INTERNAL' || this.reason === 'BAD_REQUEST') return false
    return this.status === 0 || this.status >= 500 || this.reason === 'BAD_RESPONSE'
  }
}

/** Shown when fetch itself fails: no network, or Access redirected an expired session (redirect: 'error'). */
const NETWORK_MESSAGE = '网络异常，或登录已过期，请稍后重试或刷新页面'

/** The UI's own copy for the reasons it explains differently; the rest show the server's LocalizedMessage. */
const MESSAGES: Readonly<Partial<Record<Reason, string>>> = {
  ETAG_MISMATCH: '设置已在别处修改，已载入最新内容',
  CSRF_FAILED: '请求来源或格式无效，请刷新页面后重试',
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '出了点问题，请稍后重试'
}

/** Any failure of a call as an ApiError. */
function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof RpcStatusError) {
    const { status } = error
    const reason = status.reason ?? 'BAD_RESPONSE'
    const message = MESSAGES[reason as Reason] ?? status.localizedMessage?.message ?? `请求失败（${reason}）`
    return new ApiError(status.httpStatus, reason, message)
  }
  // Nothing was sent: the same input fails the same way, so it is a 400, never a network failure to retry.
  if (error instanceof HttpEncodeError) return new ApiError(400, 'BAD_REQUEST', '输入有误')
  if (error instanceof HttpResponseError) return new ApiError(error.httpStatus, 'BAD_RESPONSE', `服务返回了无法识别的响应（HTTP ${String(error.httpStatus)}）`)
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
  if (mutation) headers[CSRF_HEADER] = '1'
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

/** BriefUiService: `api.getIssue({ name: 'issues/2026-10-12' })` resolves to an Issue. */
export const api = withApiErrors(createHttpClient(BriefUiService, send))

/** A fresh AIP-155 request ID (UUID4) for one user action. */
export function newRequestId(): string {
  return crypto.randomUUID()
}

/** Every item of a list, page by page (`get` answers one page and its next token), at most `maxPages` pages. */
export async function listAll<T>(get: (pageToken: string) => Promise<{ items: T[]; next: string }>, maxPages: number): Promise<T[]> {
  const items: T[] = []
  let pageToken = ''
  for (let page = 0; page < maxPages; page++) {
    const answer = await get(pageToken)
    items.push(...answer.items)
    pageToken = answer.next
    if (pageToken === '') break
  }
  return items
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
