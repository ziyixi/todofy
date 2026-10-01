/**
 * The owner API client (proto/lab/ui/v1, docs/design.md §8): LabUiService through the shared typed client
 * (proto/ts/http-client.ts), built from the same descriptors the Worker's transcoder routes with. Same-origin
 * only: every request goes to /api/v1/* with the Access cookie; nothing else leaves the page. This file adds
 * only the transport: mutations carry the signed double-submit CSRF token (header X-CSRF-Token, cookie
 * lab_csrf, from GET /api/csrf), a refused token is renewed once, and every failure becomes an ApiError with
 * the copy the owner reads. Callers pass a request_id (newOpId) per user action, so a retried request is
 * answered with the first response.
 */
import { createHttpClient, HttpEncodeError, HttpResponseError, RpcStatusError, type HttpCall } from '@ziyixi/proto/http-client'
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb'
import { DeckStateSchema, type DeckState } from '@ziyixi/proto/lab/ui/v1/deck_pb'
import type { ErrorReason } from '@ziyixi/proto/lab/ui/v1/errors_pb'
import { LabUiService } from '@ziyixi/proto/lab/ui/v1/lab_ui_service_pb'
import { parseStatus, readDetail } from '@ziyixi/proto/rpc-status'

export const CSRF_HEADER = 'X-CSRF-Token'

/** An ErrorInfo reason Lab answers: lab.ui.v1's own (errors.proto) or one every API shares (CommonReason). */
export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>
/** Codes the browser produces itself when no Status is available. */
export type ClientCode = 'NETWORK_ERROR' | 'BAD_RESPONSE'

export class ApiError extends Error {
  readonly status: number
  /**
   * The ErrorInfo reason (a Reason), or a ClientCode; a reason this build does not know stays as sent, so the
   * type is string and callers compare with Reason and ClientCode values.
   */
  readonly reason: string
  readonly requestId: string | null
  /** DECK_CHANGED carries the deck's current state. */
  readonly state: DeckState | null

  constructor(status: number, reason: string, message: string, requestId: string | null = null, state: DeckState | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.reason = reason
    this.requestId = requestId
    this.state = state
  }

  /**
   * Worth repeating with the same request_id: the request may never have arrived (a network error), a
   * dependency failed (UNAVAILABLE), or something between answered that is not the API (BAD_RESPONSE, e.g. a
   * proxy's 502). Never INTERNAL (a bug answers the same way again) or BAD_REQUEST (an input the client could
   * not even encode, or one the server refused).
   */
  get transient(): boolean {
    if (this.reason === 'INTERNAL' || this.reason === 'BAD_REQUEST') return false
    return this.status === 0 || this.status >= 500 || this.reason === 'BAD_RESPONSE'
  }
}

/** Shown when fetch itself fails: no network, or Access redirected an expired session (redirect: 'error'). */
export const NETWORK_MESSAGE = '网络异常，或登录已过期，请稍后重试或刷新页面'

/** The UI's own copy for the reasons it explains differently; the rest show the server's LocalizedMessage. */
const MESSAGES: Readonly<Partial<Record<Reason, string>>> = {
  DECK_NOT_FOUND: '找不到这组卡片',
  DECK_CHANGED: '已同步其他设备上的选择',
  ALREADY_DECIDED: '这张卡片已经在别处选过了',
  NOTHING_TO_UNDO: '没有可以撤销的操作',
  DECK_LOG_FULL: '这组卡片的操作次数已达上限',
  NOT_IN_DECK: '这篇论文不在这组卡片里',
  NOTHING_TO_SEND: '没有需要发送的论文',
  SEND_IN_PROGRESS: '正在发送中，请稍候',
  CSRF_FAILED: '页面安全令牌已过期，请刷新页面',
  BAD_REQUEST: '输入有误',
  ALREADY_LIKED: '已经喜欢过这篇论文',
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return '出了点问题，请稍后重试'
}

function unreadable(status: number): ApiError {
  return new ApiError(status, 'BAD_RESPONSE', `服务返回了无法识别的响应（HTTP ${status}）`)
}

/** Any failure of a call as an ApiError. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof RpcStatusError) {
    const { status } = error
    const reason = status.reason ?? 'BAD_RESPONSE'
    const message = MESSAGES[reason as Reason] ?? status.localizedMessage?.message ?? `请求失败（${reason}）`
    const state = reason === 'DECK_CHANGED' ? (readDetail(status, DeckStateSchema) ?? null) : null
    return new ApiError(status.httpStatus, reason, message, status.requestId ?? null, state)
  }
  // Nothing was sent: the same input fails the same way, so it is a 400, never a network failure to retry.
  if (error instanceof HttpEncodeError) return new ApiError(400, 'BAD_REQUEST', '输入有误')
  if (error instanceof HttpResponseError) return unreadable(error.httpStatus)
  return unreadable(0)
}

let csrfToken: string | null = null

async function fetchSameOrigin(url: string, init: RequestInit): Promise<Response> {
  try {
    // redirect: 'error' so an expired Access session surfaces as an error, not as the login page's HTML.
    return await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', NETWORK_MESSAGE)
  }
}

async function csrf(): Promise<string> {
  if (csrfToken) return csrfToken
  const response = await fetchSameOrigin('/api/csrf', { headers: { Accept: 'application/json' } })
  let token: unknown
  try {
    token = ((await response.json()) as { token?: unknown }).token
  } catch {
    // Not JSON: an error page from a proxy or Access.
  }
  if (!response.ok || typeof token !== 'string' || token === '') throw new ApiError(response.status, 'BAD_RESPONSE', '无法取得页面安全令牌')
  csrfToken = token
  return csrfToken
}

/**
 * The transport of every call. A mutation carries the CSRF token; a 403 CSRF_FAILED (expired token, lost
 * cookie) drops the token and sends once more with a fresh one (same body, so the same request_id).
 */
async function send(call: HttpCall): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (call.body !== undefined) headers['Content-Type'] = 'application/json'
    if (call.httpMethod !== 'GET') headers[CSRF_HEADER] = await csrf()
    const response = await fetchSameOrigin(call.url, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) })
    if (response.status !== 403 || call.httpMethod === 'GET') return response
    csrfToken = null
    if (attempt > 0) return response
    let reason: string | undefined
    try {
      reason = parseStatus(403, await response.clone().json())?.reason
    } catch {
      // Not a Status: answer it as it is.
    }
    if (reason !== 'CSRF_FAILED') return response
  }
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

/** LabUiService: `lab.getDeck({ name: deckName(day) })` resolves to a Deck. */
export const lab = withApiErrors(createHttpClient(LabUiService, send))

/** A deck's resource name. */
export function deckName(day: string): string {
  return `decks/${day}`
}

/** The day of a deck's resource name (`decks/2026-09-30`), or '' for anything else. */
export function dayOf(name: string): string {
  return /^decks\/(\d{4}-\d{2}-\d{2})$/.exec(name)?.[1] ?? ''
}

/**
 * Runs a mutation, repeating it once after a short pause when the failure was transient. The caller passes
 * the same request (same request_id), so a request whose response was lost is answered from the server's log.
 */
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
export function resetClientForTests(): void {
  csrfToken = null
}
