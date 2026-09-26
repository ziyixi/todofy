import type { Env } from './types.ts'
import { HttpError } from './security.ts'
import { settleObjectCapacity } from './capacity.ts'
import { recordDeletion } from './backup-artifacts.ts'

const DAY = 86_400_000
type Row = Record<string, any>
export interface LifecyclePolicy {
  lifecycle_policy_version: number
  raw_retention_days: number | null
  content_retention_days: number | null
  ledger_retention_days: number
}
export async function captureLifecyclePolicy(env: Env): Promise<LifecyclePolicy> {
  const value = await env.DB.prepare('SELECT lifecycle_policy_version,raw_retention_days,content_retention_days,ledger_retention_days FROM app_settings WHERE id=1').first<LifecyclePolicy>()
  if (!value) throw new Error('lifecycle_policy_unavailable')
  return value
}

/** SQL predicate shared by preview, terminal-clock assignment and deletion CAS.
 * A forward message with no frozen-revision delivery must never qualify. */
export function safeTerminalSQL(alias = 'm'): string {
  if (!/^[a-z_]+$/i.test(alias)) throw new Error('invalid_sql_alias')
  const m = alias
  return `${m}.origin='cloudflare' AND ${m}.content_deleted_at IS NULL AND ${m}.parse_state='ready'
    AND ${m}.policy_error IS NULL AND COALESCE(${m}.needs_review,0)=0
    AND ${m}.claim_token IS NULL AND ${m}.lease_until IS NULL
    AND (${m}.receive_mode='archive' OR (${m}.receive_mode='forward' AND ${m}.endpoint_revision_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=${m}.id AND d.endpoint_revision_id=${m}.endpoint_revision_id AND d.state='delivered')))
    AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=${m}.id AND (d.state<>'delivered' OR d.claim_token IS NOT NULL OR d.lease_until IS NOT NULL))`
}
export function terminalAnchorSQL(alias = 'm'): string {
  return `max(${alias}.retention_started_at,COALESCE((SELECT max(d.delivered_at) FROM deliveries d WHERE d.message_id=${alias}.id),${alias}.retention_started_at))`
}
export interface LifecycleHooks {
  deleteContent: (messageID: string, version: number) => Promise<void>
  /** Must exclude backup acquisition until the entire callback has finished. */
  withMutation: <T>(operation: () => Promise<T>) => Promise<T>
}

/** Logical expiry is recorded first; unfinished physical deletion is retried.
 * The raw key stays attached until deletion completes, so a crash is resumable. */
export async function expireRawContent(env: Env, messageID: string, expectedVersion: number, withMutation: LifecycleHooks['withMutation']): Promise<boolean> {
  return withMutation(async () => {
    const message = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(messageID).first<Row>()
    if (!message || message.content_deleted_at || (message.raw_purged_at && !message.raw_capacity_pending_key)) return false
    if (!message.raw_expired_at) {
      const timestamp = new Date().toISOString()
      const expired = await env.DB.prepare(`UPDATE messages AS m SET raw_expired_at=?,pending_delete_bytes=pending_delete_bytes+size_bytes,version=version+1
        WHERE id=? AND version=? AND raw_expired_at IS NULL AND raw_key IS NOT NULL AND ${safeTerminalSQL('m')}`)
        .bind(timestamp, messageID, expectedVersion).run()
      if (!expired.meta.changes) return false
    }
    // A manual full purge owns its accounting after it writes the tombstone.
    const pending = await env.DB.prepare('SELECT raw_key,size_bytes FROM messages WHERE id=? AND raw_expired_at IS NOT NULL AND raw_purged_at IS NULL AND content_deleted_at IS NULL').bind(messageID).first<Row>()
    if (!pending && !message.raw_capacity_pending_key) return false
    if (pending) await recordDeletion(env, messageID, 'raw', message.raw_expired_at || new Date().toISOString())
    if (pending?.raw_key) await env.MAIL_STORE.delete(pending.raw_key)
    // D1 changes() ties the capacity update to this exact once-only completion.
    if (pending) await env.DB.batch([
      env.DB.prepare(`UPDATE messages SET raw_capacity_pending_key=raw_key,raw_capacity_remaining_bytes=max(0,content_bytes-size_bytes),raw_key=NULL,raw_purged_at=?,version=version+1,content_bytes=max(0,content_bytes-size_bytes),pending_delete_bytes=max(0,pending_delete_bytes-size_bytes)
        WHERE id=? AND raw_expired_at IS NOT NULL AND raw_purged_at IS NULL AND content_deleted_at IS NULL`).bind(new Date().toISOString(), messageID),
      env.DB.prepare('UPDATE app_settings SET logical_bytes=max(0,logical_bytes-?) WHERE id=1 AND changes()>0').bind(pending.size_bytes),
    ])
    // Keep a durable settlement marker across a failed DO call. A full-content
    // tombstone owns the allocation thereafter and must not be resurrected.
    const settlement = await env.DB.prepare(`SELECT raw_capacity_pending_key,raw_capacity_remaining_bytes,size_bytes FROM messages
      WHERE id=? AND raw_capacity_pending_key IS NOT NULL AND content_deleted_at IS NULL`).bind(messageID).first<Row>()
    if (settlement) {
      await settleObjectCapacity(env, settlement.raw_capacity_pending_key, settlement.raw_capacity_remaining_bytes, settlement.raw_capacity_remaining_bytes + settlement.size_bytes)
      await env.DB.prepare(`UPDATE messages SET raw_capacity_pending_key=NULL,raw_capacity_remaining_bytes=NULL WHERE id=? AND content_deleted_at IS NULL`).bind(messageID).run()
    }
    return true
  })
}

/** Bounded work: assign clocks for up to 8 messages and purge at most 2 stages.
 * Existing unversioned rows stay untouched until an owner confirms a preview. */
export async function runLifecycle(env: Env, hooks: LifecycleHooks): Promise<{ continueSoon: boolean; processed: number }> {
  if (env.MAINTENANCE_MODE === 'true') return { continueSoon: false, processed: 0 }
  let processed = 0, more = false
  await hooks.withMutation(async () => {
    const started = await env.DB.prepare(`UPDATE messages SET retention_started_at=? WHERE id IN (
      SELECT m.id FROM messages m WHERE m.retention_policy_version IS NOT NULL AND m.retention_started_at IS NULL AND ${safeTerminalSQL()} ORDER BY m.received_at LIMIT 8)`)
      .bind(new Date().toISOString()).run()
    more = started.meta.changes === 8
  })
  const retry = await env.DB.prepare(`SELECT id,version FROM messages WHERE raw_expired_at IS NOT NULL AND (raw_purged_at IS NULL OR raw_capacity_pending_key IS NOT NULL) AND content_deleted_at IS NULL ORDER BY raw_expired_at LIMIT 1`).first<Row>()
  if (retry && await expireRawContent(env, retry.id, retry.version, hooks.withMutation)) processed++
  for (let step = processed; step < 2; step++) {
    const timestamp = new Date().toISOString()
    const candidate = await env.DB.prepare(`SELECT m.id,m.version,
      (m.content_retention_days IS NOT NULL AND julianday(?)>=julianday(${terminalAnchorSQL()})+m.content_retention_days) content_due
      FROM messages m WHERE m.retention_policy_version IS NOT NULL AND m.retention_started_at IS NOT NULL AND ${safeTerminalSQL()}
      AND ((m.content_retention_days IS NOT NULL AND julianday(?)>=julianday(${terminalAnchorSQL()})+m.content_retention_days)
      OR (m.raw_expired_at IS NULL AND m.raw_key IS NOT NULL AND m.raw_retention_days IS NOT NULL AND julianday(?)>=julianday(${terminalAnchorSQL()})+m.raw_retention_days))
      ORDER BY m.retention_started_at,m.id LIMIT 1`).bind(timestamp, timestamp, timestamp).first<Row>()
    if (!candidate) break
    try {
      if (candidate.content_due) await hooks.withMutation(async () => {
        // A send/reparse may have begun since selection. Recheck inside the guard.
        const safe = await env.DB.prepare(`SELECT m.id FROM messages m WHERE m.id=? AND m.version=? AND ${safeTerminalSQL()}`).bind(candidate.id, candidate.version).first()
        if (safe) { await hooks.deleteContent(candidate.id, candidate.version); processed++ }
      })
      else if (await expireRawContent(env, candidate.id, candidate.version, hooks.withMutation)) processed++
    } catch (error) { if (!(error instanceof HttpError) || error.status !== 409) throw error }
  }
  return { continueSoon: more || processed >= 2, processed }
}

export async function lifecycleStorage(env: Env): Promise<Row> {
  const pending = await env.DB.prepare('SELECT COALESCE(sum(pending_delete_bytes),0) pending_physical_delete_bytes FROM messages').first<Row>()
  return { pending_physical_delete_bytes: pending?.pending_physical_delete_bytes ?? 0,
    bucket_actual_bytes: null, account_r2_bytes: null, measured_at: null, actual_usage_status: 'not_measured' }
}

export function retentionCutoff(days: number, timestamp = Date.now()): string { return new Date(timestamp - days * DAY).toISOString() }
