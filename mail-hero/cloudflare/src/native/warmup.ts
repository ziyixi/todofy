// The owner API's codec path, run at startup: in the Worker's global scope (api.ts calls warmUp right after it builds
// the transcoder), outside any request's CPU time on Workers Free, as FlowDay's worker/src/warmup.ts does. Without it
// an isolate's first request of a method runs that method's share of protobuf-es and the wire JSON codec before V8
// compiled it (and builds the codec's per-message rule tables): SendMessage's first run read 6.01 reference ms on a
// GitHub runner against its bound of 6 (test/cpu/delivery-request-cpu.test.mjs), where the hand-written API it
// replaced read about 4.1-4.9.
//
// For each call of WARM_CALLS it does what HttpTranscoder.handle does with a request, on synthetic data:
//
// - matches the path against every binding (http-path.ts splitPath and matchTemplate over the transcoder's routes);
// - reads the request message from its wire JSON with the strict profile (wire-json.ts fromWire, which reflects over
//   the message and checks its value rules): the body's fields, the path variables and the query parameters;
// - maps synthetic D1 rows to the answer with api-v2.ts's own mappers (toDelivery, toMessage, ...) and writes it with
//   the wire profile (toWire, JSON.stringify).
//
// The calls are the overview (the UI's first request), the three methods that make a delivery (SendMessage,
// ResendDelivery, TestEndpoint), the lists and reads the UI opens, one update with a field mask, and the two RPCs the
// coordinator answers (GetMessageContent, SummarizeDeliveryAttempts): the coordinator's Durable Object runs this same
// module, so its isolate is warmed too. Each round also builds one Ops status (ops-core.ts buildStatus: the coordinator's
// GuardState read strictly, the OpsStatus written by the wire codec), the codec path of Home's status() call, which
// otherwise compiles inside the call every 30 minutes, when Home's tick reaches a fresh isolate. Nothing here touches a
// binding, the network, D1 or R2; no secret and no real data (the global scope allows no I/O, and every value is a
// constant).
//
// Measured on the reference machine on 2026-10-02 (`npm run test:cpu`, four serial runs each, medians of three fresh
// isolates, reference ms, first run / warm median): SendMessage 4.15-4.60 / 2.50-3.15 -> 3.38-3.98 / 1.90-2.30 (main's
// hand-written send: 2.84-3.06 / 1.66-2.35), the isolate's first API request (the overview) 7.11-8.20 -> 5.71-6.50,
// 50 messages with a search 4.66-5.06 -> 2.77-3.26; the coordinator's slowest delegated read 17.8-19.4 -> 15.1-15.4.
// The Ops status round (2026-10-05, test/cpu/native-ops-cpu.test.mjs, two runs each, load average about 17): the
// isolate's first status() 3.84-4.15 -> 2.49-2.95.
import { create, type JsonObject, type JsonValue, type Message } from '@ziyixi/proto/protobuf'
import { timestampFromDate } from '@ziyixi/proto/protobuf/wkt'
import { matchTemplate, splitPath } from '@ziyixi/proto/http-path'
import type { HttpBinding } from '@ziyixi/proto/http-rule'
import { fromWire, toWire } from '@ziyixi/proto/wire-json'
import {
  ListDeliveriesResponseSchema,
  ListDeliveryAttemptsResponseSchema,
  ListMessagesResponseSchema,
  ResendDeliveryResponseSchema,
  SendMessageResponseSchema,
  SummarizeDeliveryAttemptsRequest_Granularity,
  SummarizeDeliveryAttemptsResponseSchema,
  TestEndpointResponseSchema,
} from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { AttemptBucketSchema } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire'
import type { Row } from './api-common.ts'
import { toAttempt, toContent, toDelivery, toMessage, toOverview, toSettings, toSetupStatus } from './api-v2.ts'
import type { ParsedRecord } from './api-messages.ts'
import { buildStatus, type StatusInput } from './ops-core.ts'
import { guardState } from './ops-guard.ts'

/**
 * Rounds of every call. The first round compiles the code (V8 compiles a function when it first runs); 1, 5, 20 and 100
 * rounds measured the same first requests, so a few rounds suffice. Five rounds of the calls add about 10 ms to an
 * isolate's startup (wall time from Miniflare's start to the first answer: 117 ms without the warm-up, 127 ms with it,
 * 190 ms with 200 rounds; a fresh Node process runs the five rounds cold in about 10 ms, test/warmup.test.mjs), far
 * below Workers' 1 s limit on a Worker's startup.
 */
export const WARMUP_ROUNDS = 5
/** Rows of each list's answer per round. */
const PAGE = 5

const MESSAGE_ID = '0b4d9c1e-6a51-4c8e-9f3a-2d7e5b8c1a40'
const EVENT_ID = '7f2e4a90-3c1b-4d6e-8a5f-9b0c2d4e6f81'
const ENDPOINT_ID = 'c3a1e5b7-9d2f-4a6c-8e0b-1f3d5a7c9e2b'
const REQUEST_ID = '5e8a2c4f-1b3d-4f6a-9c8e-0d2b4f6a8c1e'
const TIME = '2026-01-01T09:30:00.000Z'

const MESSAGE_ROW: Row = {
  id: MESSAGE_ID, subject: 'Warm-up subject', from: 'Warm-up sender <sender@example.org>', received_at: TIME, last_received_at: TIME,
  arrival_count: 1, size_bytes: 2048, parse_state: 'ready', parse_error: null, delivery_state: 'delivered', delivery_count: 1,
  has_attachment: 1, preview: 'Warm-up preview', search_index_truncated: 0, read_at: TIME, raw_expired_at: null, content_deleted_at: null,
  envelope_from: 'sender@example.org', envelope_recipient: 'inbox@example.org', raw_sha256: 'a'.repeat(64), receive_mode: 'forward', version: 3,
}

const DELIVERY_ROW: Row = {
  event_id: EVENT_ID, message_id: MESSAGE_ID, endpoint_id: ENDPOINT_ID, endpoint_label: 'Warm-up consumer',
  endpoint_url: 'https://consumer.example.org/hooks/mail', subject: 'Warm-up subject', from: 'Warm-up sender', state: 'pending',
  effective_state: 'pending', attempt_count: 0, created_at: TIME, next_attempt_at: TIME, delivered_at: null, last_error: null, generation: 1,
  replay_of_event_id: EVENT_ID, retry_mode: 'auto', content_deleted: 0, canary: 0,
}

const ATTEMPT_ROW: Row = {
  attempt_no: 1, started_at: TIME, finished_at: TIME, http_status: 204, duration_ms: 120, outcome: 'delivered', error_code: null, response_preview: '',
}

const SETTINGS_ROW: Row = {
  receive_address: 'inbox@example.org', mode: 'forward', current_endpoint_id: ENDPOINT_ID, send_paused: 0, effective_send_paused: 0,
  maintenance_mode: 0, raw_retention_days: 7, content_retention_days: 30, ledger_retention_days: 180, resolved_retention_days: 60,
  lifecycle_policy_version: 1, logical_bytes: 1024, logical_limit_bytes: 5 * 1024 ** 3, database_bytes: 4096, last_backup_at: TIME, version: 2,
}

const SCHEDULER: Row = {
  available: true, pending: 2, failed: 0, oldest_at: TIME, next_alarm_at: TIME, capacity: { initialized: true, used_bytes: 1024, reserved_bytes: 512 },
}

/** What api-settings.ts overview() answers. */
const OVERVIEW: Row = {
  receive_address: 'inbox@example.org', counts: { messages: 60, pending: 2, failed: 1, delivered: 57, parse_failed: 0 },
  storage: { logical_bytes: 1024, limit_bytes: 5 * 1024 ** 3, database_bytes: 4096, pending_physical_delete_bytes: 0 }, backup: { last_at: TIME },
  send_paused: false, scheduler: SCHEDULER,
  alerts: {
    active: [{ code: 'delivery_failures', severity: 'warning', metrics: { failed: 1 }, first_seen_at: TIME, last_seen_at: TIME }],
    configured: true, configuration_error: false, pending_notifications: 0, failed_notifications: 0,
  },
  warnings: ['warm-up'],
}

/** What api-settings.ts setupStatus() answers. */
const SETUP_STATUS: Row = {
  receive_address: 'inbox@example.org', address_valid: true, scheduler: SCHEDULER, last_received_at: TIME,
  checks: [{ id: 'warm-up', label: 'Warm-up', status: 'ok', detail: 'Warm-up detail' }],
}

/** A parsed record (message.json) as the parser writes it, small. */
const PARSED: ParsedRecord = {
  to: [{ address: 'inbox@example.org', name: 'Inbox' }], sent_at: TIME, rfc_message_id: '<warm-up@example.org>', text: 'Warm-up text',
  html: '<p>Warm-up</p>', headers: [{ key: 'subject', value: 'Warm-up subject' }],
  attachments: [{ part_id: '1', filename: 'warm-up.txt', content_type: 'text/plain', size: 8, storage_status: 'stored', r2_key: 'warm-up' }],
  needs_review: false, warnings: ['text_truncated'], text_truncated: true, original_text_bytes: 4096, html_omitted: false,
  attachments_omitted_count: 0, content_policy_version: 'storage-v1',
}

const repeat = <T>(item: T): T[] => Array.from({ length: PAGE }, () => item)

const OPS_TIME = Date.parse(TIME)

/**
 * What ops-core.ts opsStatus() reads, synthetic: the coordinator's answer with a shed guard (as ops-guard.ts writes it)
 * and an alert snapshot with failures, so the status carries signals with metrics, counters and every mode.
 */
const OPS_STATUS_INPUT: StatusInput = {
  time: OPS_TIME,
  env: { MAINTENANCE_MODE: 'false', FORCE_SEND_PAUSED: 'false', INGEST_DAILY_MESSAGE_LIMIT: '300', INGEST_DAILY_BYTE_LIMIT: '268435456', PUBLIC_HOST: 'mail.example.org' },
  coordinator: {
    jobs_pending: 2, jobs_failed: 1, backup_active: false, capacity: { used_bytes: 1024, limit_bytes: 5 * 1024 ** 3 }, ingest_today: { messages: 4, bytes: 4096 },
    guard: guardState({ level: 'shed', reason: 'd1_reads_high', until: OPS_TIME + 3_600_000, set_at: OPS_TIME }, OPS_TIME),
  },
  snapshot: {
    logical_bytes: 1024, logical_limit_bytes: 5 * 1024 ** 3, last_backup_at: TIME, created_at: TIME, oldest_pending_at: TIME, parse_failed: 1,
    delivery_failed: 1, policy_error: 0, current_blocked: 0, current_auto_recheck: 0, current_paused: 0, blocked_waiting: 0, blocked_permanent_waiting: 0,
    paused_waiting: 0, send_paused: 0, forwarding: 1,
  },
  active: [{ code: 'parse_failed', active_since: TIME }],
}

/** One Ops status (Home's status() call without its reads); the test checks it against the contract. */
export function warmOpsStatus(): wire.OpsStatus {
  return buildStatus(OPS_STATUS_INPUT)
}

/** One request of a method, as the UI sends it, and its answer from synthetic rows (as the handler maps them). */
export interface WarmCall {
  readonly httpMethod: HttpBinding['httpMethod']
  readonly path: string
  /** The body's JSON (its binding's `body` field, or the whole request for `*`). */
  readonly body?: JsonObject
  /** The query parameters, as wire values. */
  readonly query?: JsonObject
  /** AIP-134: the binding's body field, read as a partial update (an update_mask names some fields). */
  readonly partial?: string
  readonly answer: () => Message
}

/** The calls warmed, by method (protobuf-es's localName, as the transcoder names handlers). */
export const WARM_CALLS: Readonly<Record<string, WarmCall>> = {
  getOverview: { httpMethod: 'GET', path: '/api/v2/overview', answer: () => toOverview(OVERVIEW) },
  getSetupStatus: { httpMethod: 'GET', path: '/api/v2/setupStatus', answer: () => toSetupStatus(SETUP_STATUS) },
  sendMessage: {
    httpMethod: 'POST', path: `/api/v2/messages/${MESSAGE_ID}:send`, body: { endpoint: `endpoints/${ENDPOINT_ID}`, request_id: REQUEST_ID },
    answer: () => create(SendMessageResponseSchema, { delivery: toDelivery(DELIVERY_ROW) }),
  },
  resendDelivery: {
    httpMethod: 'POST', path: `/api/v2/deliveries/${EVENT_ID}:resend`, body: { endpoint: `endpoints/${ENDPOINT_ID}`, request_id: REQUEST_ID, message_etag: '3' },
    answer: () => create(ResendDeliveryResponseSchema, { delivery: toDelivery(DELIVERY_ROW) }),
  },
  testEndpoint: {
    httpMethod: 'POST', path: `/api/v2/endpoints/${ENDPOINT_ID}:test`, body: { request_id: REQUEST_ID },
    answer: () => create(TestEndpointResponseSchema, { delivery: toDelivery(DELIVERY_ROW) }),
  },
  listMessages: {
    httpMethod: 'GET', path: '/api/v2/messages', query: { page_size: 50, filter: 'warm-up parse_state = READY' },
    answer: () => create(ListMessagesResponseSchema, { messages: repeat(MESSAGE_ROW).map(toMessage), nextPageToken: 'warm-up' }),
  },
  getMessage: { httpMethod: 'GET', path: `/api/v2/messages/${MESSAGE_ID}`, answer: () => toMessage(MESSAGE_ROW) },
  listDeliveries: {
    httpMethod: 'GET', path: '/api/v2/deliveries', query: { page_size: 50, filter: 'state = PENDING' },
    answer: () => create(ListDeliveriesResponseSchema, { deliveries: repeat(DELIVERY_ROW).map(toDelivery), nextPageToken: 'warm-up' }),
  },
  getDelivery: { httpMethod: 'GET', path: `/api/v2/deliveries/${EVENT_ID}`, answer: () => toDelivery(DELIVERY_ROW) },
  listDeliveryAttempts: {
    httpMethod: 'GET', path: `/api/v2/deliveries/${EVENT_ID}/attempts`, query: { page_size: 50 },
    answer: () => create(ListDeliveryAttemptsResponseSchema, { deliveryAttempts: repeat(ATTEMPT_ROW).map(row => toAttempt(EVENT_ID, row)), nextPageToken: 'warm-up' }),
  },
  updateSettings: {
    httpMethod: 'PATCH', path: '/api/v2/settings', body: { send_paused: true, etag: '2' }, query: { update_mask: 'send_paused' }, partial: 'settings',
    answer: () => toSettings(SETTINGS_ROW),
  },
  getMessageContent: { httpMethod: 'GET', path: `/api/v2/messages/${MESSAGE_ID}/content`, answer: () => toContent(MESSAGE_ID, PARSED) },
  summarizeDeliveryAttempts: {
    httpMethod: 'GET', path: '/api/v2/deliveries/-/attempts:summarize',
    query: { start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-08T00:00:00Z', granularity: 'hour', time_zone: 'America/Los_Angeles' },
    answer: () => {
      const counts = { succeededCount: 1, retriedCount: 1, failedCount: 0, unknownCount: 0 }
      const time = timestampFromDate(new Date(TIME))
      return create(SummarizeDeliveryAttemptsResponseSchema, {
        startTime: time, endTime: time, granularity: SummarizeDeliveryAttemptsRequest_Granularity.HOUR, timeZone: 'America/Los_Angeles', totals: counts,
        buckets: repeat(null).map(() => create(AttemptBucketSchema, { startTime: time, endTime: time, counts })),
      })
    },
  },
}

/** Sets `value` at a dotted field path of a wire object (the transcoder's setPath, without its conflict check). */
function setPath(wire: JsonObject, path: readonly string[], value: JsonValue): void {
  let node = wire
  for (const name of path.slice(0, -1)) node = (node[name] ??= {}) as JsonObject
  node[path[path.length - 1]!] = value
}

/** One call: routed, its request read, its answer mapped and written. Returns the request read and the answer's text. */
export function warmCall(routes: readonly HttpBinding[], name: string, call: WarmCall): { request: Message; answer: string } {
  const split = splitPath(call.path)
  let route: HttpBinding | undefined
  let bindings: ReadonlyMap<string, string> | null = null
  if (split !== null) {
    for (const candidate of routes) {
      const matched = matchTemplate(candidate.template, split)
      if (matched !== null && route === undefined && candidate.httpMethod === call.httpMethod) [route, bindings] = [candidate, matched]
    }
  }
  if (route === undefined || bindings === null || route.method.localName !== name) throw new TypeError(`warm-up: ${name} is not routed`)
  // The body as the transcoder reads it (parsed from its text) under its binding's field, the path variables, the query.
  const body = JSON.parse(JSON.stringify(call.body ?? {})) as JsonObject
  const wire: JsonObject = route.body === '' || route.body === '*' ? body : { [route.body]: body }
  for (const [path, value] of bindings) setPath(wire, path.split('.'), value)
  for (const [key, value] of Object.entries(call.query ?? {})) setPath(wire, key.split('.'), value)
  const request = fromWire(route.method.input, wire, { strict: true, ...(call.partial === undefined ? {} : { partial: call.partial }) }).message as Message
  return { request, answer: JSON.stringify(toWire(route.method.output, call.answer() as never)) }
}

/** Runs every call of WARM_CALLS against the transcoder's routes, and one Ops status, `rounds` times. */
export function warmUp(routes: readonly HttpBinding[], rounds: number = WARMUP_ROUNDS): void {
  for (let round = 0; round < rounds; round += 1) {
    for (const [name, call] of Object.entries(WARM_CALLS)) warmCall(routes, name, call)
    warmOpsStatus()
  }
}
