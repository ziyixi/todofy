// Mail Hero's owner API, mailhero.ui.v2 (proto/mailhero/ui/v2): one handler per rpc of MailHeroUiService, served by the
// shared transcoder (proto/ts/http-transcoder.ts) from http.ts after authentication. A handler reads its request (the
// names, etags, update masks, filters and page tokens the IDL describes), calls the module that does the work
// (api-messages.ts, api-deliveries.ts, api-endpoints.ts, api-settings.ts, api-delivery-stats.ts: plain inputs, D1 rows
// out) and maps its rows to the API's messages. Every mutation runs under the coordinator's write lease
// (backup.ts withBackupWrite), as before.
//
// Errors are RpcErrors with a reason of mailhero.ui.v2.ErrorReason or common.errors.v1.CommonReason; REASONS gives each
// its google.rpc.Code, its developer message and its Chinese copy. The modules throw HttpError with their own codes
// (shared with the admin bootstrap, deploy/configure-webhook.mjs); unexpected() maps each to its reason. A failed call
// to D1, R2 or the coordinator (dependencies.ts) is UNAVAILABLE, as are Mail Hero's own coded failures of those
// dependencies (`scheduler_unavailable`, `logical_capacity`, ...); anything else is a bug, INTERNAL.
import { create } from '@ziyixi/proto/protobuf'
import { timestampDate, timestampFromDate, type Timestamp } from '@ziyixi/proto/protobuf/wkt'
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb'
import { AttemptBucketSchema, DeliveryAttempt_Outcome, DeliveryAttemptSchema, DeliveryPayloadSchema, DeliverySchema, Delivery_RetryMode, Delivery_State, type Delivery, type DeliveryAttempt } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { Endpoint_AuthType, EndpointSchema, type Endpoint } from '@ziyixi/proto/mailhero/ui/v2/endpoint_pb'
import type { ErrorReason } from '@ziyixi/proto/mailhero/ui/v2/errors_pb'
import {
  CheckEndpointResponse_CheckResult,
  CheckEndpointResponseSchema,
  ListDeliveriesResponseSchema,
  ListDeliveryAttemptsResponseSchema,
  ListEndpointsResponseSchema,
  ListMessagesResponseSchema,
  PreviewRetentionPolicyResponseSchema,
  RotateEndpointCredentialResponseSchema,
  SendMessageResponseSchema,
  SummarizeDeliveryAttemptsRequest_Granularity,
  SummarizeDeliveryAttemptsResponseSchema,
  TestEndpointResponseSchema,
  UnblockEndpointResponseSchema,
  type MailHeroUiService,
} from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { Attachment_OmittedReason, Attachment_StorageState, Message_DeliveryState, Message_ParseState, MessageContentSchema, MessageSchema, ReceiveMode, type Message } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { ActiveAlert_Severity, OverviewSchema, SettingsSchema, SetupCheck_Result, SetupStatusSchema, type SchedulerStatus, type Settings } from '@ziyixi/proto/mailhero/ui/v2/settings_pb'
import { FieldMaskError, updatePaths } from '@ziyixi/proto/field-mask'
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder'
import { decodePageToken, encodePageToken, PageTokenError, type PageParameters } from '@ziyixi/proto/page-token'
import { Code, RpcError } from '@ziyixi/proto/rpc-status'
import type { JsonValue } from '@ziyixi/proto/protobuf'
import type { Env } from './types.ts'
import { withBackupWrite } from './backup.ts'
import { DependencyError } from './dependencies.ts'
import { FilterError, parseFilter, type Restriction } from './api-filter.ts'
import { HttpError } from './security.ts'
import { type Cursor, type Row } from './api-common.ts'
import { clearMessageContent, DELIVERY_STATES, getMessage, listMessages, markRead, PARSE_STATES, readMessageContent, reparseMessage, sendMessage, type MessageQuery, type ParsedRecord } from './api-messages.ts'
import { changeDelivery, getAttempt, getDelivery, listAttempts, listDeliveries, OUTCOME_SQL, readPayload, resendDelivery } from './api-deliveries.ts'
import { checkEndpoint, createEndpoint, getEndpoint, listEndpoints, rotateCredential, testEndpoint, unblockEndpoint, updateEndpoint } from './api-endpoints.ts'
import { currentSettings, overview, patchSettings, previewRetention, setupStatus } from './api-settings.ts'
import { deliveryRange, deliveryStats, parseInstant } from './api-delivery-stats.ts'

/** What every handler gets: the bindings (wrapped: dependencies.ts) and the owner http.ts authenticated. */
export interface ApiContext {
  readonly env: Env
  readonly owner: string
}

/** The API's own paths (google.api.http bindings and the downloads next to them). */
export const API_PREFIX = '/api/v2/'

// ---- errors --------------------------------------------------------------------------------------------------------

/** An ErrorInfo reason Mail Hero answers: its own (mailhero.ui.v2.ErrorReason) or one every API shares. */
export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>

/**
 * Each reason's code (errors.proto lists the same), its developer message and the owner's copy (the LocalizedMessage).
 * Exhaustive: a new ErrorReason fails the typecheck until it is mapped here.
 */
export const REASONS: Readonly<Record<Reason, { readonly code: Code; readonly message: string; readonly zh: string }>> = {
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid', zh: '请求格式无效' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such resource', zh: '记录不存在' },
  METHOD_NOT_ALLOWED: { code: Code.UNIMPLEMENTED, message: 'this method is not allowed on this path', zh: '不支持此请求方法' },
  INTERNAL: { code: Code.INTERNAL, message: 'internal error', zh: '服务出错了，请刷新页面后重试' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'a dependency is unavailable; repeat the request', zh: '服务暂不可用，请稍后重试' },
  UNAUTHORIZED: { code: Code.UNAUTHENTICATED, message: 'no valid Cloudflare Access login for the owner', zh: '需要通过 Cloudflare Access 登录，或登录已过期' },
  CSRF_FAILED: { code: Code.PERMISSION_DENIED, message: 'the CSRF token or Origin is not valid', zh: '请刷新页面后再试' },
  ACCESS_NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'the Access settings are incomplete', zh: '请先配置 Cloudflare Access' },
  NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'a required secret is missing', zh: '服务缺少必需的密钥配置' },
  ETAG_MISMATCH: { code: Code.ABORTED, message: 'the resource changed since the etag', zh: '状态已改变，请刷新后重试' },
  REQUEST_ID_REUSED: { code: Code.INVALID_ARGUMENT, message: 'the request_id was used for another request', zh: '操作 ID 已用于不同请求' },
  MAINTENANCE: { code: Code.UNAVAILABLE, message: 'maintenance mode accepts no changes', zh: '维护模式暂不接受修改，请稍后重试' },
  BACKUP_IN_PROGRESS: { code: Code.UNAVAILABLE, message: 'a backup snapshot holds the write lease', zh: '备份快照期间暂不接受修改；新邮件仍会归档' },
  CONTENT_DELETED: { code: Code.FAILED_PRECONDITION, message: 'the content was deleted', zh: '内容已删除' },
  RAW_EXPIRED: { code: Code.FAILED_PRECONDITION, message: 'the raw message expired', zh: '原件已按保留策略清理；已提取的正文仍可查看' },
  ATTACHMENT_OMITTED: { code: Code.FAILED_PRECONDITION, message: 'the attachment has no stored copy', zh: '该附件未保存独立副本' },
  CONTENT_UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'a stored object of the message did not load', zh: '邮件内容对象暂不可用，原件仍保留' },
  PAYLOAD_UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'the frozen request did not load', zh: '冻结请求对象暂不可用' },
  NOT_REPARSABLE: { code: Code.FAILED_PRECONDITION, message: 'the message cannot be parsed again', zh: '该邮件暂不能重新解析' },
  NOT_RETRYABLE: { code: Code.FAILED_PRECONDITION, message: 'the delivery cannot be retried in its state', zh: '该事件暂不能重试' },
  RETRY_WINDOW_CLOSED: { code: Code.FAILED_PRECONDITION, message: 'the request is gone or the retry window closed', zh: '内容不可用或事件重试期限已过' },
  NOT_CANCELLABLE: { code: Code.FAILED_PRECONDITION, message: 'the delivery is being sent or has ended', zh: '发送中或已完成的事件无法取消' },
  MESSAGE_NOT_READY: { code: Code.FAILED_PRECONDITION, message: 'the message is not parsed', zh: '邮件尚未解析成功，暂不能投递' },
  DELIVERY_EXISTS: { code: Code.ALREADY_EXISTS, message: 'the message has a delivery already', zh: '这封邮件已有投递；请在投递详情中重新发送' },
  ENDPOINT_UNAVAILABLE: { code: Code.FAILED_PRECONDITION, message: 'the target was archived', zh: '目标已不可用' },
  MESSAGE_CHANGED: { code: Code.ABORTED, message: 'the message changed while its event was made', zh: '邮件状态已改变，请重试' },
  INVALID_RESEND: { code: Code.FAILED_PRECONDITION, message: 'the event does not belong to the message', zh: '该事件不能重新发送' },
  INVALID_PAYLOAD: { code: Code.FAILED_PRECONDITION, message: 'the message cannot make a valid event', zh: '这封邮件无法生成有效的投递内容（主题和正文为空，或内容超出限制）' },
  INVALID_TARGET: { code: Code.INVALID_ARGUMENT, message: 'the display name or URI is not valid', zh: '名称或 Webhook URL 无效' },
  TARGET_NOT_ALLOWED: { code: Code.INVALID_ARGUMENT, message: 'the target is not an allowed public HTTPS host', zh: '目标必须是部署时允许的公网 HTTPS 域名' },
  AUTH_REQUIRED: { code: Code.INVALID_ARGUMENT, message: 'a target needs Bearer or Basic authentication', zh: '公网 webhook 必须配置 Bearer 或 Basic 认证' },
  INVALID_CREDENTIAL: { code: Code.INVALID_ARGUMENT, message: 'the credential is not valid', zh: '认证值无效：最多 4096 字节且不含换行；Bearer token 为不含空格的可打印 ASCII，Basic 为 username:password' },
  CREDENTIAL_REQUIRED: { code: Code.INVALID_ARGUMENT, message: 'a new origin or authentication type needs the credential', zh: '新 origin 或认证方式需要重新输入认证值' },
  NO_CREDENTIAL: { code: Code.FAILED_PRECONDITION, message: 'the target has no credential', zh: '此目标没有可轮换的认证值' },
  TOO_MANY_REVISIONS: { code: Code.FAILED_PRECONDITION, message: 'too many revisions on the origin', zh: '历史认证版本过多，需要分批维护后再轮换' },
  INVALID_RETENTION_POLICY: { code: Code.INVALID_ARGUMENT, message: 'a retention period breaks a rule', zh: '保留策略无效：天数为 1–3650，去重记录至少 90 天，原件不能长于正文，已处理异常邮件不能短于正文' },
  RETENTION_CONFIRMATION_REQUIRED: { code: Code.FAILED_PRECONDITION, message: 'the retention change needs a confirmed preview', zh: '启用、缩短或应用历史保留策略前需要预览并确认' },
  ENDPOINT_REQUIRED: { code: Code.FAILED_PRECONDITION, message: 'forward mode needs a current target', zh: '自动投递需要先选择 webhook 目标' },
  INVALID_TIME_RANGE: { code: Code.INVALID_ARGUMENT, message: 'the time range is not valid', zh: '时间范围无效或过长' },
  INVALID_TIME_ZONE: { code: Code.INVALID_ARGUMENT, message: 'the time zone is not usable', zh: '时区无效' },
}

export function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value)
}

/** The RpcError of `reason`; `httpStatus` overrides its code's status (410 on a download of content that is gone). */
export function mhError(reason: Reason, init: { metadata?: Record<string, string>; httpStatus?: number; headers?: Record<string, string> } = {}): RpcError {
  const { code, message } = REASONS[reason]
  return new RpcError(code, reason, message, init)
}

function bad(): never {
  throw mhError('BAD_REQUEST')
}

/** The codes the modules (and the pipeline they call) throw that are not a reason's name in lower case. */
const ALIASES: Readonly<Record<string, Reason>> = {
  not_found: 'NOT_FOUND', message_not_found: 'NOT_FOUND',
  invalid_request: 'BAD_REQUEST', invalid_path: 'BAD_REQUEST', request_too_large: 'BAD_REQUEST',
  version_conflict: 'ETAG_MISMATCH', action_conflict: 'REQUEST_ID_REUSED',
  parsed_content_unavailable: 'CONTENT_UNAVAILABLE', invalid_replay: 'INVALID_RESEND',
  backup_unavailable: 'UNAVAILABLE', unauthorized: 'UNAUTHORIZED', csrf_failed: 'CSRF_FAILED',
  access_not_configured: 'ACCESS_NOT_CONFIGURED', invalid_auth_configuration: 'ACCESS_NOT_CONFIGURED',
}
/** The `rule` of each retention policy code (errors.proto INVALID_RETENTION_POLICY). */
const RETENTION_RULES = new Set(['days_range', 'ledger_minimum', 'raw_after_content', 'resolved_before_content'])
/** Reasons a download answers with 410 Gone, as before. */
const GONE: ReadonlySet<Reason> = new Set(['CONTENT_DELETED', 'RAW_EXPIRED', 'ATTACHMENT_OMITTED'])

/** The RpcError of a module's HttpError: by its code, else by its HTTP status. */
export function fromHttpError(error: HttpError, download = false): RpcError {
  const code = error.code
  if (code.startsWith('retention_') && RETENTION_RULES.has(code.slice('retention_'.length))) {
    return mhError('INVALID_RETENTION_POLICY', { metadata: { rule: code.slice('retention_'.length) } })
  }
  const upper = code.toUpperCase()
  const reason: Reason = isReason(upper) && upper !== 'INTERNAL' ? upper : ALIASES[code] ??
    (error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'ETAG_MISMATCH' : error.status >= 400 && error.status < 500 ? 'BAD_REQUEST'
      : error.status === 503 ? 'UNAVAILABLE' : 'INTERNAL')
  return mhError(reason, download && GONE.has(reason) ? { httpStatus: 410 } : {})
}

/** Mail Hero's own coded failure of a dependency (the coordinator, capacity, a lease): `scheduler_unavailable`... */
const CODED_FAILURE = /^[a-z][a-z0-9_]{0,63}$/

/** The transcoder's onUnexpected: what a handler threw that is not an RpcError. */
export function unexpected(error: unknown): RpcError {
  if (error instanceof RpcError) return error
  if (error instanceof HttpError) return fromHttpError(error)
  if (error instanceof DependencyError) return mhError('UNAVAILABLE')
  if (error instanceof Error && error.message === 'credential_key_not_configured') return mhError('NOT_CONFIGURED')
  if (error instanceof Error && CODED_FAILURE.test(error.message)) return mhError('UNAVAILABLE')
  return mhError('INTERNAL')
}

// ---- names, etags, pages -------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The UUID of `<collection>/<uuid>` (lower case); BAD_REQUEST for anything else. */
export function idOf(name: string, collection: 'messages' | 'deliveries' | 'endpoints', child = ''): string {
  const prefix = `${collection}/`
  if (!name.startsWith(prefix) || !name.endsWith(child)) bad()
  const id = name.slice(prefix.length, name.length - child.length).toLowerCase()
  return UUID.test(id) ? id : bad()
}

/** AIP-154: the etag of a version. Opaque to clients; Mail Hero writes the version's decimal digits. */
export function etagOf(version: number): string {
  return String(version)
}
/** The version an etag names: BAD_REQUEST for an empty one or a string Mail Hero never wrote. */
function versionOf(etag: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(etag) || !Number.isSafeInteger(Number(etag))) bad()
  return Number(etag)
}

/** AIP-158: 0 is the default (50), a negative size is BAD_REQUEST, a larger one than MAX_PAGE is read as MAX_PAGE. */
export const DEFAULT_PAGE = 50
export const MAX_PAGE = 100
function pageSize(size: number): number {
  if (size < 0) bad()
  return size === 0 ? DEFAULT_PAGE : Math.min(size, MAX_PAGE)
}
function decodeToken(token: string, parameters: PageParameters): JsonValue | null {
  if (token === '') return null
  try {
    return decodePageToken(token, parameters)
  } catch (error) {
    if (error instanceof PageTokenError) bad()
    throw error
  }
}
/** The keyset cursor of a page token, checked: a valid time and a UUID. */
function cursorOf(token: string, parameters: PageParameters): Cursor | null {
  const value = decodeToken(token, parameters)
  if (value === null) return null
  const { t, i } = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as { t?: unknown; i?: unknown }
  if (typeof t !== 'string' || !Number.isFinite(Date.parse(t)) || typeof i !== 'string' || !UUID.test(i)) bad()
  return { time: t as string, id: i as string }
}
function tokenOf(cursor: Cursor | null, parameters: PageParameters): string {
  return cursor === null ? '' : encodePageToken({ t: cursor.time, i: cursor.id }, parameters)
}

// ---- rows to messages ----------------------------------------------------------------------------------------------

/** A stored ISO time as a Timestamp; unset for none, or one the profile cannot write (outside the years 1-9999). */
function ts(value: unknown): Timestamp | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const date = new Date(value)
  const year = date.getUTCFullYear()
  return Number.isFinite(date.getTime()) && year >= 1 && year <= 9999 ? timestampFromDate(date) : undefined
}
function iso(value: Timestamp | undefined): string | null {
  return value === undefined ? null : timestampDate(value).toISOString()
}
/** The enum value a stored lower-case name stands for (UNSPECIFIED for none or an unknown one). */
function enumOf<E extends Readonly<Record<string, number>>>(values: E, name: unknown): E[keyof E] {
  const key = typeof name === 'string' ? name.toUpperCase() : ''
  return (key !== 'UNSPECIFIED' && Object.hasOwn(values, key) ? values[key as keyof E] : values['UNSPECIFIED' as keyof E])
}
/** The lower-case name of an enum value (null for UNSPECIFIED or one this build does not know). */
function nameOf<E extends Readonly<Record<string, number>>>(values: E, value: number): string | null {
  const entry = Object.entries(values).find(([, number]) => number === value)
  return entry === undefined || entry[0] === 'UNSPECIFIED' ? null : entry[0].toLowerCase()
}
const int = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) ? value : Number(value) || 0)
const text = (value: unknown): string => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value))

export function toMessage(row: Row): Message {
  const id = text(row.id)
  return create(MessageSchema, {
    name: `messages/${id}`, subject: text(row.subject), sender: text(row.from), receiveTime: ts(row.received_at),
    lastReceiveTime: ts(row.last_received_at), arrivalCount: int(row.arrival_count), sizeBytes: int(row.size_bytes),
    parseState: enumOf(Message_ParseState, row.parse_state), parseError: text(row.parse_error),
    deliveryState: enumOf(Message_DeliveryState, row.delivery_state), deliveryCount: int(row.delivery_count),
    hasAttachments: !!row.has_attachment, snippet: text(row.preview), searchIndexTruncated: !!row.search_index_truncated,
    read: !!row.read_at, readTime: ts(row.read_at), rawExpireTime: ts(row.raw_expired_at), contentDeleteTime: ts(row.content_deleted_at),
    envelopeSender: text(row.envelope_from), envelopeRecipient: text(row.envelope_recipient), rawSha256: text(row.raw_sha256),
    receiveMode: enumOf(ReceiveMode, row.receive_mode),
    rawDownloadUri: !row.content_deleted_at && !row.raw_expired_at ? `${API_PREFIX}messages/${id}/raw` : '',
    etag: etagOf(int(row.version)),
  })
}

/** The parsed record of message `id` as its MessageContent. The record is the parser's: shapes are checked loosely. */
function toContent(id: string, parsed: ParsedRecord): ReturnType<typeof create<typeof MessageContentSchema>> {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const object = (value: unknown): Row => (value !== null && typeof value === 'object' ? (value as Row) : {})
  return create(MessageContentSchema, {
    name: `messages/${id}/content`,
    recipients: list(parsed.to).map(item => typeof item === 'string' ? { address: item } : { address: text(object(item).address), displayName: text(object(item).name) }),
    sendTime: ts(parsed.sent_at), rfcMessageId: text(parsed.rfc_message_id), text: text(parsed.text), html: text(parsed.html),
    headers: list(parsed.headers).map(item => ({ key: text(object(item).key), value: text(object(item).value) })),
    attachments: list(parsed.attachments).map(item => {
      const attachment = object(item), partID = text(attachment.part_id)
      const stored = attachment.storage_status !== 'omitted' && !!attachment.r2_key
      return {
        partId: partID, filename: text(attachment.filename), mimeType: text(attachment.content_type), sizeBytes: int(attachment.size_bytes ?? attachment.size),
        storageState: enumOf(Attachment_StorageState, attachment.storage_status), omittedReason: enumOf(Attachment_OmittedReason, attachment.omitted_reason),
        downloadUri: stored ? `${API_PREFIX}messages/${id}/attachments/${encodeURIComponent(partID)}` : '',
      }
    }),
    needsReview: parsed.needs_review === true, warnings: list(parsed.warnings).map(text), textTruncated: parsed.text_truncated === true,
    originalTextBytes: int(parsed.original_text_bytes), htmlOmitted: parsed.html_omitted === true,
    omittedAttachmentCount: int(parsed.attachments_omitted_count), contentPolicyVersion: text(parsed.content_policy_version),
  })
}

export function toDelivery(row: Row): Delivery {
  return create(DeliverySchema, {
    name: `deliveries/${text(row.event_id)}`, message: `messages/${text(row.message_id)}`, endpoint: `endpoints/${text(row.endpoint_id)}`,
    endpointDisplayName: text(row.endpoint_label), endpointUri: text(row.endpoint_url), subject: text(row.subject), sender: text(row.from),
    state: enumOf(Delivery_State, row.state), effectiveState: enumOf(Delivery_State, row.effective_state), attemptCount: int(row.attempt_count),
    createTime: ts(row.created_at), nextAttemptTime: ts(row.next_attempt_at), deliverTime: ts(row.delivered_at), lastError: text(row.last_error),
    generation: int(row.generation), sourceDelivery: row.replay_of_event_id ? `deliveries/${text(row.replay_of_event_id)}` : '',
    retryMode: enumOf(Delivery_RetryMode, row.retry_mode), contentDeleted: !!row.content_deleted, canary: !!row.canary,
  })
}

function toAttempt(eventID: string, row: Row): DeliveryAttempt {
  return create(DeliveryAttemptSchema, {
    name: `deliveries/${eventID}/attempts/${int(row.attempt_no)}`, startTime: ts(row.started_at), finishTime: ts(row.finished_at),
    httpStatus: int(row.http_status), durationMs: int(row.duration_ms), outcome: enumOf(DeliveryAttempt_Outcome, row.outcome),
    errorCode: text(row.error_code), responsePreview: text(row.response_preview),
  })
}

export function toEndpoint(row: Row): Endpoint {
  return create(EndpointSchema, {
    name: `endpoints/${text(row.id)}`, displayName: text(row.label), uri: text(row.url), authType: enumOf(Endpoint_AuthType, row.auth_type),
    credentialConfigured: !!row.credential_configured, ratePerMinute: int(row.rate_per_minute), timeoutSeconds: int(row.timeout_seconds),
    paused: !!row.paused, pausedReason: text(row.paused_reason), blockedReason: text(row.blocked_reason), blockExpireTime: ts(row.blocked_until),
    blockedRecheckCount: int(row.blocked_rechecks), etag: etagOf(int(row.version)),
  })
}

const days = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : int(value))
const bytes = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0)

export function toSettings(row: Row): Settings {
  return create(SettingsSchema, {
    name: 'settings', receiveAddress: text(row.receive_address), mode: enumOf(ReceiveMode, row.mode),
    currentEndpoint: row.current_endpoint_id ? `endpoints/${text(row.current_endpoint_id)}` : '', sendPaused: !!row.send_paused,
    effectiveSendPaused: !!row.effective_send_paused, maintenanceMode: !!row.maintenance_mode,
    rawRetentionDays: days(row.raw_retention_days), contentRetentionDays: days(row.content_retention_days),
    ledgerRetentionDays: days(row.ledger_retention_days), resolvedRetentionDays: days(row.resolved_retention_days),
    lifecyclePolicyVersion: int(row.lifecycle_policy_version), logicalBytes: bytes(row.logical_bytes), logicalLimitBytes: bytes(row.logical_limit_bytes),
    databaseBytes: row.database_bytes === null || row.database_bytes === undefined ? undefined : bytes(row.database_bytes),
    lastBackupTime: ts(row.last_backup_at), etag: etagOf(int(row.version)),
  })
}

function toScheduler(row: Row): SchedulerStatus {
  if (!row.available) return { $typeName: 'mailhero.ui.v2.SchedulerStatus', available: false, pendingJobCount: 0, failedJobCount: 0, capacityInitialized: false }
  const capacity = row.capacity as Row | null
  const initialized = capacity?.initialized === true
  return {
    $typeName: 'mailhero.ui.v2.SchedulerStatus', available: true, pendingJobCount: int(row.pending), failedJobCount: int(row.failed),
    oldestJobTime: ts(row.oldest_at), nextAlarmTime: ts(row.next_alarm_at), capacityInitialized: initialized,
    ...(initialized ? { capacityUsedBytes: bytes(capacity!.used_bytes), capacityReservedBytes: bytes(capacity!.reserved_bytes) } : {}),
  }
}

// ---- filters -------------------------------------------------------------------------------------------------------

/** The longest filter a list takes, in characters. */
export const FILTER_MAX = 400

function filterOf(text: string): { literals: readonly string[]; restrictions: readonly Restriction[] } {
  try {
    return parseFilter(text, FILTER_MAX)
  } catch (error) {
    if (error instanceof FilterError) bad()
    throw error
  }
}
/** Each restriction's field at most once per comparator, and only the fields and comparators `allowed` names. */
function restrictionsBy(restrictions: readonly Restriction[], allowed: Readonly<Record<string, readonly string[]>>): Map<string, Restriction> {
  const found = new Map<string, Restriction>()
  for (const restriction of restrictions) {
    const key = `${restriction.field} ${restriction.comparator}`
    if (!allowed[restriction.field]?.includes(restriction.comparator) || found.has(key)) bad()
    found.set(key, restriction)
  }
  return found
}
/** A bare upper-case enum name in `names` (lower-cased), else BAD_REQUEST. */
function enumValue(restriction: Restriction | undefined, names: readonly string[]): string | null {
  if (restriction === undefined) return null
  const name = restriction.value.toLowerCase()
  if (restriction.quoted || restriction.value !== restriction.value.toUpperCase() || !names.includes(name)) bad()
  return name
}

/** ListMessages' filter (mail_hero_ui_service.proto) as the query of listMessages, without its page. */
function messageFilter(filter: string): Omit<MessageQuery, 'limit' | 'cursor'> {
  const { literals, restrictions } = filterOf(filter)
  if (literals.length > 1) bad()
  const by = restrictionsBy(restrictions, {
    delivery_state: ['='], parse_state: ['='], has_attachments: ['='], receive_time: ['>=', '<='],
  })
  const attachment = by.get('has_attachments =')
  if (attachment !== undefined && (attachment.quoted || (attachment.value !== 'true' && attachment.value !== 'false'))) bad()
  const time = (key: string) => {
    const restriction = by.get(key)
    if (restriction === undefined) return null
    if (!restriction.quoted) bad()
    return parseInstant(restriction.value)
  }
  const literal = literals[0]?.trim().toLocaleLowerCase() ?? ''
  return {
    search: literal === '' ? null : literal,
    deliveryState: enumValue(by.get('delivery_state ='), ['unarranged', ...DELIVERY_STATES]),
    parseState: enumValue(by.get('parse_state ='), PARSE_STATES),
    hasAttachment: attachment === undefined ? null : attachment.value === 'true',
    receivedAfter: time('receive_time >='), receivedBefore: time('receive_time <='),
  }
}

// ---- handlers ------------------------------------------------------------------------------------------------------

/** Runs a mutation under the coordinator's write lease (a backup snapshot excludes it: BACKUP_IN_PROGRESS). */
function mutate<T>(ctx: ApiContext, run: () => Promise<T>): Promise<T> {
  return withBackupWrite(ctx.env, run)
}
/** An AIP-134 update's paths: an explicit list (no mask, an empty one or `*` is BAD_REQUEST here, see the IDL). */
function maskPaths(mask: { readonly paths: readonly string[] } | undefined, required: boolean): readonly string[] | '*' {
  let paths: '*' | readonly string[]
  try {
    paths = updatePaths(mask)
  } catch (error) {
    if (error instanceof FieldMaskError) bad()
    throw error
  }
  if (paths === '*' && required) bad()
  return paths
}

export const handlers: ServiceHandlers<ShapeOf<typeof MailHeroUiService>, ApiContext> = {
  async getOverview(request, { env }) {
    if (request.name !== 'overview') throw mhError('NOT_FOUND')
    const value = await overview(env)
    const counts = value.counts as Row, storage = value.storage as Row, alerts = value.alerts as Row
    return create(OverviewSchema, {
      name: 'overview', receiveAddress: text(value.receive_address), messageCount: int(counts.messages), pendingDeliveryCount: int(counts.pending),
      failedDeliveryCount: int(counts.failed), deliveredCount: int(counts.delivered), parseFailedCount: int(counts.parse_failed),
      logicalBytes: bytes(storage.logical_bytes), logicalLimitBytes: bytes(storage.limit_bytes),
      databaseBytes: storage.database_bytes === null || storage.database_bytes === undefined ? undefined : bytes(storage.database_bytes),
      pendingPhysicalDeleteBytes: bytes(storage.pending_physical_delete_bytes), lastBackupTime: ts((value.backup as Row).last_at),
      sendPaused: !!value.send_paused, scheduler: toScheduler(value.scheduler as Row),
      activeAlerts: (alerts.active as Row[]).map(alert => ({
        code: text(alert.code), severity: enumOf(ActiveAlert_Severity, alert.severity),
        metrics: Object.fromEntries(Object.entries((alert.metrics ?? {}) as Row).filter(([, number]) => typeof number === 'number' && Number.isFinite(number))),
        firstSeenTime: ts(alert.first_seen_at), lastSeenTime: ts(alert.last_seen_at),
      })),
      alertWebhookConfigured: !!alerts.configured, alertWebhookMisconfigured: !!alerts.configuration_error,
      pendingNotificationCount: int(alerts.pending_notifications), failedNotificationCount: int(alerts.failed_notifications),
      warnings: (value.warnings as string[]).map(text),
    })
  },

  async getSetupStatus(request, { env }) {
    if (request.name !== 'setupStatus') throw mhError('NOT_FOUND')
    const value = await setupStatus(env)
    return create(SetupStatusSchema, {
      name: 'setupStatus', receiveAddress: text(value.receive_address), addressValid: !!value.address_valid,
      scheduler: toScheduler(value.scheduler as Row), lastReceiveTime: ts(value.last_received_at),
      checks: (value.checks as Row[]).map(check => ({ id: text(check.id), label: text(check.label), result: enumOf(SetupCheck_Result, check.status), detail: text(check.detail) })),
    })
  },

  async getSettings(request, { env }) {
    if (request.name !== 'settings') throw mhError('NOT_FOUND')
    return toSettings(await currentSettings(env))
  },

  async updateSettings(request, ctx) {
    const settings = request.settings!
    if (settings.name !== 'settings') throw mhError('NOT_FOUND')
    const paths = maskPaths(request.updateMask, true) as readonly string[]
    const expected = versionOf(settings.etag)
    const input: Row = {}
    for (const path of paths) {
      switch (path) {
        case 'mode': input.mode = nameOf(ReceiveMode, settings.mode) ?? bad(); break
        case 'current_endpoint': input.current_endpoint_id = settings.currentEndpoint === '' ? null : idOf(settings.currentEndpoint, 'endpoints'); break
        case 'send_paused': input.send_paused = settings.sendPaused; break
        case 'raw_retention_days': input.raw_retention_days = settings.rawRetentionDays ?? null; break
        case 'content_retention_days': input.content_retention_days = settings.contentRetentionDays ?? null; break
        case 'ledger_retention_days': input.ledger_retention_days = settings.ledgerRetentionDays ?? null; break
        case 'resolved_retention_days': input.resolved_retention_days = settings.resolvedRetentionDays ?? null; break
        default: break // output-only fields (the transcoder refused unknown ones): ignored, AIP-203
      }
    }
    return mutate(ctx, async () => toSettings(await patchSettings(ctx.env, ctx.owner, input, expected, request.retentionConfirmation || null, request.applyExisting)))
  },

  async previewRetentionPolicy(request, { env, owner }) {
    if (request.name !== 'settings') throw mhError('NOT_FOUND')
    const value = await previewRetention(env, owner, {
      raw_retention_days: request.rawRetentionDays ?? null, content_retention_days: request.contentRetentionDays ?? null,
      ledger_retention_days: request.ledgerRetentionDays, resolved_retention_days: request.resolvedRetentionDays ?? null,
      apply_existing: request.applyExisting,
    })
    return create(PreviewRetentionPolicyResponseSchema, {
      etag: etagOf(int(value.version)), rawRetentionDays: days(value.raw_retention_days), contentRetentionDays: days(value.content_retention_days),
      ledgerRetentionDays: int(value.ledger_retention_days), resolvedRetentionDays: days(value.resolved_retention_days), applyExisting: !!value.apply_existing,
      historicalMessageCount: int(value.historical_messages), safeTerminalMessageCount: int(value.safe_terminal_messages),
      historicalContentBytes: bytes(value.historical_content_bytes), resolvedMessageCount: int(value.resolved_messages),
      candidateCount: int(value.candidates), expireTime: ts(value.expires_at), confirmationToken: text(value.preview_token),
    })
  },

  async listMessages(request, { env }) {
    const parameters = { filter: request.filter }
    const query = messageFilter(request.filter)
    const limit = pageSize(request.pageSize)
    const page = await listMessages(env, { ...query, limit, cursor: cursorOf(request.pageToken, parameters) })
    return create(ListMessagesResponseSchema, { messages: page.items.map(toMessage), nextPageToken: tokenOf(page.next, parameters) })
  },

  async getMessage(request, { env }) {
    return toMessage(await getMessage(env, idOf(request.name, 'messages')))
  },

  async updateMessage(request, ctx) {
    const message = request.message!
    const id = idOf(message.name, 'messages')
    const paths = maskPaths(request.updateMask, false)
    const expected = versionOf(message.etag)
    if (paths !== '*' && !paths.includes('read')) return toMessage(await getMessage(ctx.env, id)) // nothing the owner sets
    return mutate(ctx, async () => toMessage(await markRead(ctx.env, id, expected, message.read)))
  },

  async getMessageContent(request, { env }) {
    const id = idOf(request.name, 'messages', '/content')
    return toContent(id, await readMessageContent(env, id))
  },

  async sendMessage(request, ctx) {
    const id = idOf(request.name, 'messages'), endpointID = idOf(request.endpoint, 'endpoints')
    return mutate(ctx, async () => create(SendMessageResponseSchema, {
      delivery: toDelivery(await sendMessage(ctx.env, ctx.owner, id, endpointID, request.requestId)),
    }))
  },

  async reparseMessage(request, ctx) {
    const id = idOf(request.name, 'messages')
    return mutate(ctx, async () => toMessage(await reparseMessage(ctx.env, ctx.owner, id, request.requestId)))
  },

  async clearMessageContent(request, ctx) {
    const id = idOf(request.name, 'messages'), expected = versionOf(request.etag)
    return mutate(ctx, async () => toMessage(await clearMessageContent(ctx.env, ctx.owner, id, expected, request.requestId)))
  },

  async listDeliveries(request, { env }) {
    const parameters = { filter: request.filter }
    const { literals, restrictions } = filterOf(request.filter)
    if (literals.length > 0) bad()
    const by = restrictionsBy(restrictions, { state: ['='], message: ['='], attempt_outcome: ['='], attempt_finish_time: ['>=', '<'] })
    const message = by.get('message =')
    if (message !== undefined && !message.quoted) bad()
    const outcome = enumValue(by.get('attempt_outcome ='), Object.keys(OUTCOME_SQL))
    const from = by.get('attempt_finish_time >='), to = by.get('attempt_finish_time <')
    // The drill-down needs all three; a range without an outcome, or an outcome without its range, is refused.
    if ((outcome === null) !== (from === undefined) || (from === undefined) !== (to === undefined)) bad()
    if ((from !== undefined && !from.quoted) || (to !== undefined && !to.quoted)) bad()
    const page = await listDeliveries(env, {
      state: enumValue(by.get('state ='), DELIVERY_STATES), messageID: message === undefined ? null : idOf(message.value, 'messages'),
      outcome, range: from === undefined ? null : deliveryRange(from.value, to!.value),
      limit: pageSize(request.pageSize), cursor: cursorOf(request.pageToken, parameters),
    })
    return create(ListDeliveriesResponseSchema, { deliveries: page.items.map(toDelivery), nextPageToken: tokenOf(page.next, parameters) })
  },

  async getDelivery(request, { env }) {
    return toDelivery(await getDelivery(env, idOf(request.name, 'deliveries')))
  },

  async retryDelivery(request, ctx) {
    const id = idOf(request.name, 'deliveries')
    return mutate(ctx, async () => toDelivery(await changeDelivery(ctx.env, ctx.owner, id, 'retry', request.requestId)))
  },

  async cancelDelivery(request, ctx) {
    const id = idOf(request.name, 'deliveries')
    return mutate(ctx, async () => toDelivery(await changeDelivery(ctx.env, ctx.owner, id, 'cancel', request.requestId)))
  },

  async resendDelivery(request, ctx) {
    const id = idOf(request.name, 'deliveries'), endpointID = idOf(request.endpoint, 'endpoints'), expected = versionOf(request.messageEtag)
    return mutate(ctx, async () => toDelivery(await resendDelivery(ctx.env, ctx.owner, id, endpointID, expected, request.requestId)))
  },

  async listDeliveryAttempts(request, { env }) {
    const id = idOf(request.parent, 'deliveries')
    const parameters = { parent: request.parent }
    const before = decodeToken(request.pageToken, parameters)
    if (before !== null && (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 1)) bad()
    const page = await listAttempts(env, id, pageSize(request.pageSize), before as number | null)
    return create(ListDeliveryAttemptsResponseSchema, {
      deliveryAttempts: page.items.map(row => toAttempt(id, row)),
      nextPageToken: page.next === null ? '' : encodePageToken(page.next, parameters),
    })
  },

  async getDeliveryAttempt(request, { env }) {
    const match = /^(deliveries\/[^/]+)\/attempts\/([1-9][0-9]{0,8})$/.exec(request.name) ?? bad()
    const id = idOf(match[1]!, 'deliveries')
    return toAttempt(id, await getAttempt(env, id, Number(match[2])))
  },

  async getDeliveryPayload(request, { env }) {
    const id = idOf(request.name, 'deliveries', '/payload')
    const payload = await readPayload(env, id)
    return create(DeliveryPayloadSchema, { name: `deliveries/${id}/payload`, body: payload.body ?? '', bodySha256: payload.sha256 })
  },

  async summarizeDeliveryAttempts(request, { env }) {
    if (request.parent !== 'deliveries/-') throw mhError('NOT_FOUND')
    const bucket = request.granularity === SummarizeDeliveryAttemptsRequest_Granularity.HOUR ? 'hour' : 'day'
    const value = await deliveryStats(env, { from: iso(request.startTime) ?? bad(), to: iso(request.endTime) ?? bad(), bucket, tz: request.timeZone || 'UTC' })
    const counts = (row: Row) => ({ succeededCount: int(row.succeeded), retriedCount: int(row.retried), failedCount: int(row.failed), unknownCount: int(row.unknown) })
    return create(SummarizeDeliveryAttemptsResponseSchema, {
      startTime: ts(value.from), endTime: ts(value.to),
      granularity: bucket === 'hour' ? SummarizeDeliveryAttemptsRequest_Granularity.HOUR : SummarizeDeliveryAttemptsRequest_Granularity.DAY,
      timeZone: text(value.time_zone), totals: counts(value.totals as Row),
      buckets: (value.buckets as Row[]).map(item => create(AttemptBucketSchema, { startTime: ts(item.start), endTime: ts(item.end), counts: counts(item) })),
    })
  },

  async listEndpoints(request, { env }) {
    const parameters = {}
    const page = await listEndpoints(env, pageSize(request.pageSize), cursorOf(request.pageToken, parameters))
    return create(ListEndpointsResponseSchema, { endpoints: page.items.map(toEndpoint), nextPageToken: tokenOf(page.next, parameters) })
  },

  async getEndpoint(request, { env }) {
    return toEndpoint(await getEndpoint(env, idOf(request.name, 'endpoints')))
  },

  async createEndpoint(request, ctx) {
    const endpoint = request.endpoint!
    const input: Row = {
      label: endpoint.displayName, url: endpoint.uri, credential: endpoint.credential, paused: endpoint.paused,
      ...(endpoint.authType === Endpoint_AuthType.UNSPECIFIED ? {} : { auth_type: nameOf(Endpoint_AuthType, endpoint.authType) ?? bad() }),
      ...(endpoint.ratePerMinute === 0 ? {} : { rate_per_minute: endpoint.ratePerMinute }),
      ...(endpoint.timeoutSeconds === 0 ? {} : { timeout_seconds: endpoint.timeoutSeconds }),
    }
    return mutate(ctx, async () => toEndpoint(await createEndpoint(ctx.env, ctx.owner, input, request.requestId)))
  },

  async updateEndpoint(request, ctx) {
    const endpoint = request.endpoint!
    const id = idOf(endpoint.name, 'endpoints')
    const paths = maskPaths(request.updateMask, true) as readonly string[]
    const expected = versionOf(endpoint.etag)
    const input: Row = {}
    for (const path of paths) {
      switch (path) {
        case 'display_name': input.label = endpoint.displayName; break
        case 'uri': input.url = endpoint.uri; break
        case 'auth_type': input.auth_type = endpoint.authType === Endpoint_AuthType.UNSPECIFIED ? 'bearer' : nameOf(Endpoint_AuthType, endpoint.authType) ?? bad(); break
        case 'credential': input.credential = endpoint.credential; break
        case 'rate_per_minute': input.rate_per_minute = endpoint.ratePerMinute || 2; break
        case 'timeout_seconds': input.timeout_seconds = endpoint.timeoutSeconds || 20; break
        case 'paused': input.paused = endpoint.paused; break
        default: break // output-only fields: ignored (AIP-203)
      }
    }
    return mutate(ctx, async () => toEndpoint(await updateEndpoint(ctx.env, id, input, expected)))
  },

  async rotateEndpointCredential(request, ctx) {
    const id = idOf(request.name, 'endpoints'), expected = versionOf(request.etag)
    return mutate(ctx, async () => {
      const result = await rotateCredential(ctx.env, id, request.credential, expected)
      return create(RotateEndpointCredentialResponseSchema, { endpoint: toEndpoint(result.endpoint), affectedRevisionCount: result.affected })
    })
  },

  async unblockEndpoint(request, ctx) {
    const id = idOf(request.name, 'endpoints'), expected = versionOf(request.etag)
    return mutate(ctx, async () => {
      const result = await unblockEndpoint(ctx.env, ctx.owner, id, expected, request.requestId || null)
      return create(UnblockEndpointResponseSchema, { endpoint: toEndpoint(result.endpoint), affectedRevisionCount: result.affected })
    })
  },

  async checkEndpoint(request, { env }) {
    const allowed = await checkEndpoint(env, idOf(request.name, 'endpoints'))
    const { NOT_CHECKED, BLOCKED } = CheckEndpointResponse_CheckResult
    return create(CheckEndpointResponseSchema, { uriAllowed: allowed, dns: allowed ? NOT_CHECKED : BLOCKED, tls: NOT_CHECKED, consumer: NOT_CHECKED })
  },

  async testEndpoint(request, ctx) {
    const id = idOf(request.name, 'endpoints')
    return mutate(ctx, async () => create(TestEndpointResponseSchema, { delivery: `deliveries/${await testEndpoint(ctx.env, ctx.owner, id, request.requestId)}` }))
  },
}
