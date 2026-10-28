/** Same-origin owner API transport: Access cookies, JSON mutations and X-CSRF-Token: 1.
 * Each action keeps its request_id; authorization failures are returned without automatic replay.
 */
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb'
import { createHttpClient, HttpEncodeError, HttpResponseError, RpcStatusError, type HttpCall } from '@ziyixi/proto/http-client'
import { readDetail } from '@ziyixi/proto/rpc-status'
import type { ErrorReason } from '@ziyixi/proto/todofy/ui/v1/errors_pb'
import { MailEventSchema, type MailEvent } from '@ziyixi/proto/todofy/ui/v1/mail_event_pb'
import { TodofyUiService } from '@ziyixi/proto/todofy/ui/v1/todofy_ui_service_pb'

export const CSRF_HEADER = 'X-CSRF-Token'

/** An ErrorInfo reason Todofy answers: todofy.ui.v1's own (errors.proto) or one every API shares (CommonReason). */
export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>
/** Codes the browser produces itself when no Status is available. */
export type ClientCode = 'NETWORK_ERROR' | 'BAD_RESPONSE'

export class ApiError extends Error {
  readonly status: number
  /**
   * The ErrorInfo reason (a Reason), or a ClientCode; a reason this build does not know stays as sent, so the type
   * is string and callers compare with Reason and ClientCode values.
   */
  readonly reason: string
  readonly requestId: string | null
  /** ETAG_MISMATCH and ACTION_NOT_ALLOWED carry the event as it is now. */
  readonly event: MailEvent | null

  constructor(status: number, reason: string, message: string, requestId: string | null = null, event: MailEvent | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.reason = reason
    this.requestId = requestId
    this.event = event
  }
}

/** Shown when fetch itself fails: no network, or Access redirected an expired session (redirect: 'error'). */
export const NETWORK_MESSAGE = '无法连接 Todofy，或登录已过期；请刷新页面后重试'

function unreadable(status: number): ApiError {
  return new ApiError(status, 'BAD_RESPONSE', `服务返回了无法识别的响应（HTTP ${status}）`)
}

/** Any failure of a call as an ApiError: the server's LocalizedMessage, else a generic line with the reason. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof RpcStatusError) {
    const { status } = error
    const reason = status.reason ?? 'BAD_RESPONSE'
    const message = status.localizedMessage?.message ?? `请求失败（${reason}）`
    const event = reason === 'ETAG_MISMATCH' || reason === 'ACTION_NOT_ALLOWED' ? (readDetail(status, MailEventSchema) ?? null) : null
    return new ApiError(status.httpStatus, reason, message, status.requestId ?? null, event)
  }
  // Nothing was sent: the same input fails the same way, so it is a 400, never a network failure to retry.
  if (error instanceof HttpEncodeError) return new ApiError(400, 'BAD_REQUEST', '请求参数无效')
  if (error instanceof HttpResponseError) return unreadable(error.httpStatus)
  return unreadable(0)
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
export async function send(call: HttpCall): Promise<Response> {
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

/** TodofyUiService: `todofy.getMailEvent({ name: mailEventName(id) })` resolves to a MailEvent. */
export const todofy = withApiErrors(createHttpClient(TodofyUiService, send))

/** A fresh AIP-155 request_id for one owner action; reuse it only to resend the identical request. */
export function newRequestId(): string {
  return crypto.randomUUID()
}
