/**
 * The owner API client (proto/mailhero/ui/v2): MailHeroUiService through the shared typed client
 * (proto/ts/http-client.ts), built from the same descriptors the Worker's transcoder routes with. Same-origin only:
 * every request goes to /api/v2/* with the Access cookie; nothing else leaves the page. This file adds only the
 * transport (mutations carry the signed double-submit CSRF token: header X-CSRF-Token, cookie mail_hero_csrf, from GET
 * /api/csrf; a refused token is renewed once), the ApiError every failure becomes, and the small helpers the pages
 * share (resource names, timestamps, the reads that combine several calls).
 */
import { createHttpClient, HttpEncodeError, HttpResponseError, RpcStatusError, type HttpCall } from '@ziyixi/proto/http-client'
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb'
import type { ErrorReason } from '@ziyixi/proto/mailhero/ui/v2/errors_pb'
import { MailHeroUiService } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import type { Delivery, DeliveryAttempt, DeliveryPayload } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import type { Message, MessageContent } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { quoteLiteral } from '@ziyixi/proto/filter'
import { parseStatus } from '@ziyixi/proto/rpc-status'
import { timestampDate, timestampFromDate, type Timestamp } from '@ziyixi/proto/protobuf/wkt'

export const CSRF_HEADER = 'X-CSRF-Token'

/** An ErrorInfo reason Mail Hero answers: its own (errors.proto) or one every API shares (CommonReason). */
export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>
/** Codes the browser produces itself when no Status is available. */
export type ClientCode = 'NETWORK_ERROR' | 'BAD_RESPONSE'

export class ApiError extends Error {
  readonly status: number
  /** The ErrorInfo reason (a Reason), or a ClientCode; a reason this build does not know stays as sent. */
  readonly reason: string
  readonly requestId: string | undefined
  /** ErrorInfo.metadata: codes only (INVALID_RETENTION_POLICY's `rule`). */
  readonly metadata: Readonly<Record<string, string>>

  constructor(status: number, reason: string, message: string, requestId?: string, metadata: Readonly<Record<string, string>> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.reason = reason
    this.requestId = requestId
    this.metadata = metadata
  }
}

/** Shown when fetch itself fails: no network, or Access redirected an expired session (redirect: 'error'). */
export const NETWORK_MESSAGE = '无法连接 Mail Hero，请检查网络后重试'

/** The UI's own copy where the reason alone says less than the owner needs; the rest show the server's copy. */
const RETENTION_RULES: Readonly<Record<string, string>> = {
  days_range: '保留天数应为 1–3650 的整数。',
  ledger_minimum: '去重记录至少保留 90 天。',
  raw_after_content: '原件保留期不能长于正文保留期。',
  resolved_before_content: '已处理异常邮件的保留期不能短于正文保留期；正文不自动清理时也须留空。',
}

/** Any failure of a call as an ApiError. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof RpcStatusError) {
    const { status } = error
    const reason = status.reason ?? 'BAD_RESPONSE'
    const rule = reason === 'INVALID_RETENTION_POLICY' ? RETENTION_RULES[status.metadata['rule'] ?? ''] : undefined
    const message = rule ?? status.localizedMessage?.message ?? `请求失败（HTTP ${status.httpStatus}）`
    return new ApiError(status.httpStatus, reason, message, status.requestId, status.metadata)
  }
  // Nothing was sent: the same input fails the same way.
  if (error instanceof HttpEncodeError) return new ApiError(400, 'BAD_REQUEST', '输入有误')
  if (error instanceof HttpResponseError) return new ApiError(error.httpStatus, 'BAD_RESPONSE', `请求失败（HTTP ${error.httpStatus}）`)
  return new ApiError(0, 'BAD_RESPONSE', '服务返回了无法识别的响应')
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
  let body: unknown
  try { body = await response.json() } catch { /* Not JSON: a proxy's or Access's page. */ }
  if (!response.ok) {
    const status = parseStatus(response.status, body)
    throw status === null ? new ApiError(response.status, 'BAD_RESPONSE', '无法取得表单安全令牌') : toApiError(new RpcStatusError(status))
  }
  const token = (body as { token?: unknown } | undefined)?.token
  if (typeof token !== 'string' || token === '') throw new ApiError(response.status, 'BAD_RESPONSE', '无法取得表单安全令牌')
  csrfToken = token
  return csrfToken
}

/**
 * The transport of every call. A mutation carries the CSRF token; a 403 CSRF_FAILED (an expired token, a lost cookie)
 * drops the token and sends once more with a fresh one (the same body, so the same request_id).
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
    try { reason = parseStatus(403, await response.clone().json())?.reason } catch { reason = undefined }
    if (reason !== 'CSRF_FAILED') return response
  }
}

/** Every rpc of `client`, its failures turned into ApiErrors. */
function withApiErrors<C extends object>(client: C): C {
  const wrapped: Record<string, (request: unknown) => Promise<unknown>> = {}
  for (const [name, method] of Object.entries(client) as [string, (request: unknown) => Promise<unknown>][]) {
    wrapped[name] = request => method(request).catch((error: unknown) => { throw toApiError(error) })
  }
  return wrapped as C
}

/** MailHeroUiService: `api.getMessage({ name: messageName(id) })` resolves to a Message. */
export const api = withApiErrors(createHttpClient(MailHeroUiService, send))

/** Test hook: forget the cached CSRF token. */
export function resetClientForTests(): void {
  csrfToken = null
}

// ---- names, times, filters ---------------------------------------------------------------------------------------

/** AIP-155: a request_id, made once per user action, so a repeated request is answered with the first result. */
export function newRequestId(): string { return crypto.randomUUID() }
/** The last segment of a resource name (`messages/<id>` -> `<id>`). */
export function idOf(name: string): string { return name.slice(name.lastIndexOf('/') + 1) }
export const messageName = (id: string): string => `messages/${id}`
export const deliveryName = (id: string): string => `deliveries/${id}`
export const endpointName = (id: string): string => `endpoints/${id}`

/** A Timestamp as an ISO string (null for none), for the formatting helpers. */
export function timeOf(value: Timestamp | undefined): string | null {
  return value === undefined ? null : timestampDate(value).toISOString()
}
/** An ISO instant as a Timestamp. */
export function timestamp(iso: string): Timestamp {
  return timestampFromDate(new Date(iso))
}
/** The lower-case wire name of an enum value ('' for UNSPECIFIED or a value this build does not know). */
export function enumName<E extends Readonly<Record<string, number | string>>>(values: E, value: number): string {
  const entry = Object.entries(values).find(([, number]) => number === value)
  return entry === undefined || entry[0] === 'UNSPECIFIED' ? '' : entry[0].toLowerCase()
}
/** An AIP-160 filter: the search box's text as one quoted literal, and the restrictions, joined by AND. */
export function filterOf(search: string, restrictions: readonly (string | false | null | undefined)[]): string {
  return [quoteLiteral(search), ...restrictions].filter((term): term is string => !!term).join(' AND ')
}

// ---- reads that combine calls -------------------------------------------------------------------------------------

/** A message, its parsed content and its deliveries (newest first, at most `deliveries`). */
export interface MessageView { readonly message: Message; readonly content: MessageContent; readonly deliveries: readonly Delivery[] }
export async function loadMessage(id: string, deliveries = 100): Promise<MessageView> {
  const name = messageName(id)
  const [message, content, list] = await Promise.all([
    api.getMessage({ name }), api.getMessageContent({ name: `${name}/content` }),
    api.listDeliveries({ filter: `message = ${quoteLiteral(name)}`, pageSize: deliveries }),
  ])
  return { message, content, deliveries: list.deliveries }
}

/** A delivery, its attempts (newest first, at most 100) and its frozen request. */
export interface DeliveryView { readonly delivery: Delivery; readonly attempts: readonly DeliveryAttempt[]; readonly payload: DeliveryPayload }
export async function loadDelivery(id: string): Promise<DeliveryView> {
  const name = deliveryName(id)
  const [delivery, attempts, payload] = await Promise.all([
    api.getDelivery({ name }), api.listDeliveryAttempts({ parent: name, pageSize: 100 }), api.getDeliveryPayload({ name: `${name}/payload` }),
  ])
  return { delivery, attempts: attempts.deliveryAttempts, payload }
}
