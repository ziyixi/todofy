// The owner API's deliveries (mailhero.ui.v2 Delivery, DeliveryAttempt and DeliveryPayload): D1 rows, the frozen
// request in R2, and retry, cancel and resend. Inputs are plain values api-v2.ts read from the request; outputs are D1
// rows (api-common.ts).
import type { Env } from './types'
import { HttpError } from './security.ts'
import { enqueue, requestDelivery } from './pipeline.ts'
import { action, delivery, deliveryJSON, deliverySelect, finishAction, first, now, paged, required, rows, type Cursor, type Page, type Row } from './api-common.ts'
import type { DeliveryRange } from './api-delivery-stats.ts'

/** Attempt outcomes as the dashboard groups them (mailhero.ui.v2 AttemptCounts), and their rows. */
export const OUTCOME_SQL: Readonly<Record<string, string>> = {
  succeeded: "a.outcome='delivered'", retried: "a.outcome='retryable'",
  failed: "a.outcome IN('rejected','failed')", unknown: "a.outcome='interrupted'",
}

/** The restrictions of ListDeliveries (api-v2.ts parses its filter into these). */
export interface DeliveryQuery {
  /** A stored state. */
  state: string | null
  /** The deliveries of one message. */
  messageID: string | null
  /** With `range`: deliveries of real mail with an attempt of this outcome (OUTCOME_SQL) that ended in the range. */
  outcome: string | null
  range: DeliveryRange | null
  limit: number
  cursor: Cursor | null
}

export async function listDeliveries(env: Env, query: DeliveryQuery): Promise<Page> {
  // One event may have several matching attempts. Materializing distinct IDs
  // keeps the drill-down list distinct, while the chart counts attempts.
  const range = query.outcome && query.range ? query.range : null
  const matching = range ? ` JOIN (
    SELECT DISTINCT a.event_id FROM delivery_attempts a
    WHERE a.finished_at>=? AND a.finished_at<? AND ${OUTCOME_SQL[query.outcome!]}
  ) matched ON matched.event_id=d.event_id` : ''
  const binds: unknown[] = range ? [range.from, range.to] : []
  const conditions: string[] = []
  if (range) conditions.push("m.origin='cloudflare'")
  if (query.state) { conditions.push('d.state=?'); binds.push(query.state) }
  if (query.messageID) { conditions.push('d.message_id=?'); binds.push(query.messageID) }
  if (query.cursor) { conditions.push('(d.created_at,d.event_id)<(?,?)'); binds.push(query.cursor.time, query.cursor.id) }
  binds.push(query.limit + 1)
  const items = await rows(env, deliverySelect + matching + ` ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY d.created_at DESC,d.event_id DESC LIMIT ?`, ...binds)
  return paged(items.map(item => deliveryJSON(env, item)), query.limit, 'created_at', 'event_id')
}

export async function getDelivery(env: Env, id: string): Promise<Row> {
  return delivery(env, id)
}

/** A delivery's attempts, newest first: `limit` of them before attempt number `before` (null: from the newest). */
export async function listAttempts(env: Env, id: string, limit: number, before: number | null): Promise<{ items: Row[]; next: number | null }> {
  await required(env, 'SELECT event_id FROM deliveries WHERE event_id=?', id)
  const items = before === null
    ? await rows(env, 'SELECT * FROM delivery_attempts WHERE event_id=? ORDER BY attempt_no DESC LIMIT ?', id, limit + 1)
    : await rows(env, 'SELECT * FROM delivery_attempts WHERE event_id=? AND attempt_no<? ORDER BY attempt_no DESC LIMIT ?', id, before, limit + 1)
  if (items.length <= limit) return { items, next: null }
  const page = items.slice(0, limit)
  return { items: page, next: page.at(-1)!.attempt_no }
}

export async function getAttempt(env: Env, id: string, attemptNo: number): Promise<Row> {
  return required(env, 'SELECT * FROM delivery_attempts WHERE event_id=? AND attempt_no=?', id, attemptNo)
}

/** A delivery's frozen request as text (null once the message's content was deleted) and its SHA-256. */
export async function readPayload(env: Env, id: string): Promise<{ body: string | null; sha256: string }> {
  const record = await required(env, `SELECT d.payload_key,d.payload_sha256,(m.content_deleted_at IS NOT NULL) content_deleted
    FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.event_id=?`, id)
  if (!record.payload_key || record.content_deleted) return { body: null, sha256: record.payload_sha256 }
  const object = await env.MAIL_STORE.get(record.payload_key)
  if (!object) throw new HttpError(503, 'payload_unavailable', '冻结请求对象暂不可用')
  return { body: await object.text(), sha256: record.payload_sha256 }
}

/**
 * Retries a delivery once (`retry`) or cancels it (`cancel`), each at most once per action ID; answers the delivery.
 * Either is the owner handling the exception: the message's resolved-exception clock restarts.
 */
export async function changeDelivery(env: Env, owner: string, id: string, change: 'retry' | 'cancel', actionID: string): Promise<Row> {
  const entry = await action(env, owner, actionID, change, id, null)
  if (!entry.result_ref) {
    const expected = await required(env, 'SELECT * FROM deliveries WHERE event_id=?', id)
    if (change === 'retry' && (!expected.payload_key || Date.parse(expected.created_at) < Date.now() - 30 * 86400000)) {
      throw new HttpError(409, 'retry_window_closed', '内容不可用或事件重试期限已过')
    }
    const result = await env.DB.batch([
      env.DB.prepare(change === 'retry'
        ? `UPDATE deliveries SET state='pending',retry_mode='once',next_attempt_at=?,last_error=NULL WHERE event_id=? AND state IN('failed','retry_wait','cancelled') AND payload_key IS NOT NULL AND EXISTS(SELECT 1 FROM ui_actions WHERE id=? AND result_ref IS NULL) AND EXISTS(SELECT 1 FROM messages WHERE id=deliveries.message_id AND content_deleted_at IS NULL)`
        : `UPDATE deliveries SET state='cancelled',last_error='cancelled_by_owner' WHERE ? IS NOT NULL AND event_id=? AND state IN('pending','retry_wait','failed') AND EXISTS(SELECT 1 FROM ui_actions WHERE id=? AND result_ref IS NULL)`)
        .bind(now(), id, entry.id),
      env.DB.prepare('UPDATE ui_actions SET result_ref=?,http_status=? WHERE id=? AND changes()>0').bind(id, change === 'retry' ? 202 : 200, entry.id),
      // A retry or cancel is a handling that may end without an attempt time of
      // its own: the resolved-exception clock restarts when the lifecycle next
      // sees the message resolved.
      env.DB.prepare('UPDATE messages SET resolved_at=NULL WHERE id=(SELECT message_id FROM deliveries WHERE event_id=?) AND resolved_at IS NOT NULL AND changes()>0').bind(id),
    ])
    if (!result[0].meta.changes) {
      const completed = await required(env, 'SELECT result_ref FROM ui_actions WHERE id=?', entry.id)
      if (!completed.result_ref) {
        throw change === 'cancel'
          ? new HttpError(409, 'not_cancellable', '发送中或已完成的事件无法取消')
          : new HttpError(409, 'not_retryable', '该事件暂不能重试')
      }
    }
  }
  if (change === 'retry') await enqueue(env, { type: 'deliver', eventID: id })
  return delivery(env, id)
}

/** Sends a delivery's message again as a new event to an endpoint, if the message is still at `expectedVersion`. */
export async function resendDelivery(env: Env, owner: string, id: string, endpointID: string, expectedVersion: number, actionID: string): Promise<Row> {
  const entry = await action(env, owner, actionID, 'replay', id, [endpointID, expectedVersion])
  if (entry.result_ref) return delivery(env, entry.result_ref)
  const existing = await first(env, 'SELECT event_id FROM deliveries WHERE action_request_id=? AND replay_of_event_id=?', actionID, id)
  if (existing) {
    await finishAction(env, entry, existing.event_id, 201)
    return delivery(env, existing.event_id)
  }
  const previous = await required(env, 'SELECT message_id FROM deliveries WHERE event_id=?', id)
  const endpoint = await required(env, 'SELECT current_revision_id FROM webhook_endpoints WHERE id=? AND archived_at IS NULL', endpointID)
  const eventID = await requestDelivery(env, { kind: 'message', options: { messageID: previous.message_id, revisionID: endpoint.current_revision_id, actionID, replayOf: id, expectedMessageVersion: expectedVersion, retryMode: 'auto' } })
  await finishAction(env, entry, eventID, 201)
  return delivery(env, eventID)
}
