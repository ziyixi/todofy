import type { Env } from './types'
import { HttpError, actionHash } from './security.ts'

export type Row = Record<string, any>
export const now = () => new Date().toISOString()
export const conflict = (message = '状态已改变，请刷新后重试'): never => { throw new HttpError(409, 'conflict', message) }
export const bad = (message: string): never => { throw new HttpError(400, 'invalid_request', message) }
export const missing = (): never => { throw new HttpError(404, 'not_found', '记录不存在') }
export const gone = (): never => { throw new HttpError(410, 'content_deleted', '内容已删除') }
export const paused = (env: Env) => env.FORCE_SEND_PAUSED === 'true' || env.FORCE_SEND_PAUSED === '1'
export function uuid(value: unknown, field = 'ID'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) bad(`${field} 无效`)
  return value as string
}
export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) bad('version 必填且必须为正整数')
  return value as number
}
export async function body(request: Request): Promise<Row> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) bad('请求必须为 JSON')
  const reader = request.body?.getReader()
  if (!reader) bad('请求内容缺失')
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader!.read()
      if (done) break
      length += value.byteLength
      if (length > 65536) { await reader!.cancel(); throw new HttpError(413, 'request_too_large', '请求内容过长') }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!result || typeof result !== 'object' || Array.isArray(result)) bad('请求格式无效')
    return result
  } catch (error) {
    if (error instanceof HttpError) throw error
    return bad('请求格式无效')
  }
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
export function page(params: URLSearchParams): { limit: number; time: string | null; id: string | null } {
  const limit = Number(params.get('limit') || 50)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('limit 超出范围')
  const encoded = params.get('cursor')
  if (!encoded) return { limit, time: null, id: null }
  try {
    const value = JSON.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')))
    if (typeof value.time !== 'string' || !Number.isFinite(Date.parse(value.time))) bad('cursor 无效')
    return { limit, time: new Date(value.time).toISOString(), id: uuid(value.id, 'cursor') }
  } catch { return bad('cursor 无效') }
}
export function paged(items: Row[], limit: number, timeField: string, idField: string) {
  let next: string | null = null
  if (items.length > limit) {
    items = items.slice(0, limit)
    const last = items.at(-1)!
    next = btoa(JSON.stringify({ time: last[timeField], id: last[idField] })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  }
  return { items, next_cursor: next }
}
export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') bad(`${field} 必须为布尔值`)
  return value as boolean
}

// An action reservation is an intent, not an acknowledgement of its side effect.
// Retrying the same request resumes an unfinished idempotent operation.
export async function action(env: Env, owner: string, actionID: unknown, operation: string, resource: string, input: unknown): Promise<Row> {
  const id = uuid(actionID, 'action_request_id')
  const hash = await actionHash(env, [operation, resource, input])
  await env.DB.prepare(`INSERT OR IGNORE INTO ui_actions(id,owner,action_request_id,operation,resource_id,request_hash,created_at) VALUES(?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), owner, id, operation, resource || null, hash, now()).run()
  const entry = await required(env, 'SELECT * FROM ui_actions WHERE owner=? AND action_request_id=?', owner, id)
  if (entry.operation !== operation || entry.request_hash !== hash || (entry.resource_id || '') !== resource) conflict('操作 ID 已用于不同请求')
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
e.current_revision_id,e.archived_at,r.revision,r.credential_ciphertext FROM webhook_endpoints e
JOIN endpoint_revisions r ON r.id=e.current_revision_id`
export function endpointJSON(row: Row): Row {
  const { credential_ciphertext, revision, ...value } = row
  value.credential_configured = !!value.credential_configured
  value.paused = !!value.paused
  // Rechecks belong to the current block episode; an unblocked revision has used none.
  value.blocked_rechecks = value.blocked_reason ? Number(value.blocked_rechecks) || 0 : 0
  return value
}
