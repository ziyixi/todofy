// What the owner API's modules share (api-messages.ts, api-deliveries.ts, api-endpoints.ts, api-settings.ts): D1
// helpers, the AIP-155 action ledger (ui_actions), and the delivery and endpoint rows. These modules take plain inputs
// and answer D1 rows; api-v2.ts maps mailhero.ui.v2 requests to them and their rows to its messages. They throw
// HttpError with a code of their own (security.ts), which api-v2.ts maps to an ErrorInfo reason (errors.proto); the
// admin bootstrap (deploy/configure-webhook.mjs) prints the same codes.
import type { Env } from './types'
import { HttpError, actionHash } from './security.ts'

export type Row = Record<string, any>
export const now = () => new Date().toISOString()
/** The resource changed since the version the request carried (ETAG_MISMATCH). */
export const conflict = (message = '状态已改变，请刷新后重试'): never => { throw new HttpError(409, 'etag_mismatch', message) }
export const bad = (message: string, code = 'invalid_request'): never => { throw new HttpError(400, code, message) }
export const missing = (): never => { throw new HttpError(404, 'not_found', '记录不存在') }
export const gone = (): never => { throw new HttpError(410, 'content_deleted', '内容已删除') }
export const paused = (env: Env) => env.FORCE_SEND_PAUSED === 'true' || env.FORCE_SEND_PAUSED === '1'
export function uuid(value: unknown, field = 'ID'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) bad(`${field} 无效`)
  return value as string
}
export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') bad(`${field} 必须为布尔值`)
  return value as boolean
}
export async function first(env: Env, sql: string, ...values: any[]): Promise<Row | null> {
  return env.DB.prepare(sql).bind(...values).first<Row>()
}
export async function rows(env: Env, sql: string, ...values: any[]): Promise<Row[]> {
  const result = await env.DB.prepare(sql).bind(...values).all<Row>()
  return result.results || []
}
export async function required(env: Env, sql: string, ...values: any[]): Promise<Row> {
  return await first(env, sql, ...values) || missing()
}

/** A keyset position in a list ordered by (time DESC, id DESC): the last row of the previous page. */
export interface Cursor { time: string; id: string }
/** A page of rows, and the cursor of the next one (null on the last page). */
export interface Page { items: Row[]; next: Cursor | null }
/** The page of `items` (queried with LIMIT limit + 1): the extra row only says there is a next page. */
export function paged(items: Row[], limit: number, timeField: string, idField: string): Page {
  if (items.length <= limit) return { items, next: null }
  const page = items.slice(0, limit), last = page.at(-1)!
  return { items: page, next: { time: last[timeField], id: last[idField] } }
}

// An action reservation is an intent, not an acknowledgement of its side effect.
// Retrying the same request resumes an unfinished idempotent operation.
export async function action(env: Env, owner: string, actionID: unknown, operation: string, resource: string, input: unknown): Promise<Row> {
  const id = uuid(actionID, 'action_request_id')
  const hash = await actionHash(env, [operation, resource, input])
  // Reserve and read in one D1 call; a failed read rolls back the reservation before any side effect.
  const [, selected] = await env.DB.batch<Row>([
    env.DB.prepare(`INSERT OR IGNORE INTO ui_actions(id,owner,action_request_id,operation,resource_id,request_hash,created_at) VALUES(?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), owner, id, operation, resource || null, hash, now()),
    env.DB.prepare('SELECT * FROM ui_actions WHERE owner=? AND action_request_id=?').bind(owner, id),
  ])
  const entry = selected.results[0] || missing()
  if (entry.operation !== operation || entry.request_hash !== hash || (entry.resource_id || '') !== resource) {
    throw new HttpError(400, 'request_id_reused', '操作 ID 已用于不同请求')
  }
  return entry
}
export async function finishAction(env: Env, entry: Row, result: string, status: number): Promise<void> {
  await env.DB.prepare('UPDATE ui_actions SET result_ref=?,http_status=? WHERE id=?').bind(result, status, entry.id).run()
}

export const deliverySelect = `SELECT d.event_id,d.message_id,e.id endpoint_id,COALESCE(m.subject,'') subject,
COALESCE(m.from_text,'') "from",e.label endpoint_label,r.url endpoint_url,d.state,d.attempt_count,d.created_at,
d.next_attempt_at,d.delivered_at,d.last_error,d.generation,d.replay_of_event_id,d.retry_mode,
(m.content_deleted_at IS NOT NULL) content_deleted,(m.canary_run_id IS NOT NULL) canary,e.paused endpoint_paused,s.send_paused global_paused,r.blocked_reason,r.blocked_until
FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN endpoint_revisions r ON r.id=d.endpoint_revision_id
JOIN webhook_endpoints e ON e.id=r.endpoint_id JOIN app_settings s ON s.id=1`
export function deliveryJSON(env: Env, row: Row): Row {
  const { endpoint_paused, global_paused, blocked_reason, blocked_until, ...value } = row
  value.content_deleted = !!value.content_deleted
  // A contracts/ops-v1 canary (synthetic); the UI labels it.
  value.canary = !!value.canary
  // An expired cooldown is not a pause: the scheduler sends on the next attempt.
  const blocked = blocked_reason && (!blocked_until || Date.parse(blocked_until) > Date.now())
  value.effective_state = ['pending', 'retry_wait'].includes(value.state) && (endpoint_paused || global_paused || blocked || paused(env)) ? 'paused' : value.state
  return value
}
export async function delivery(env: Env, id: string): Promise<Row> {
  return deliveryJSON(env, await required(env, deliverySelect + ' WHERE d.event_id=?', id))
}

export const endpointSelect = `SELECT e.id,e.label,r.url,r.auth_type,(r.credential_ciphertext IS NOT NULL) credential_configured,
e.rate_per_minute,r.timeout_ms/1000 timeout_seconds,e.paused,e.paused_reason,r.blocked_reason,r.blocked_until,r.blocked_rechecks,e.version,
e.current_revision_id,e.archived_at,e.created_at,r.revision,r.credential_ciphertext FROM webhook_endpoints e
JOIN endpoint_revisions r ON r.id=e.current_revision_id`
export function endpointJSON(row: Row): Row {
  const { credential_ciphertext, revision, ...value } = row
  value.credential_configured = !!value.credential_configured
  value.paused = !!value.paused
  // Rechecks belong to the current block episode; an unblocked revision has used none.
  value.blocked_rechecks = value.blocked_reason ? Number(value.blocked_rechecks) || 0 : 0
  return value
}
