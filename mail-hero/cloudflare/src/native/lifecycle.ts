import type { Env } from './types.ts'
import { HttpError } from './security.ts'
import { settleObjectCapacity } from './capacity.ts'
import { recordDeletion } from './backup-artifacts.ts'

const DAY = 86_400_000, HOUR = 3_600_000
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
/** Same text format as toISOString(), so due times compare as strings. */
export const NEVER_DUE = '9999-12-31T23:59:59.999Z'
const iso = (julian: string) => `strftime('%Y-%m-%dT%H:%M:%fZ',${julian})`
function stageDueSQL(alias: string, anchor: string, stage: 'raw' | 'content'): string {
  const m = alias
  if (!/^[a-z_]+$/i.test(m)) throw new Error('invalid_sql_alias')
  return stage === 'raw'
    ? `CASE WHEN ${m}.raw_expired_at IS NULL AND ${m}.raw_key IS NOT NULL AND ${m}.raw_retention_days IS NOT NULL THEN ${iso(`julianday(${anchor})+${m}.raw_retention_days`)} END`
    : `CASE WHEN ${m}.content_retention_days IS NOT NULL THEN ${iso(`julianday(${anchor})+${m}.content_retention_days`)} END`
}
export const rawDueSQL = (alias: string, anchor: string) => stageDueSQL(alias, anchor, 'raw')
export const contentDueSQL = (alias: string, anchor: string) => stageDueSQL(alias, anchor, 'content')
/** Earliest stage due time. The anchor is evaluated once; multi-argument min()
 * is NULL when either stage is absent, so COALESCE falls through to the other. */
export function lifecycleDueSQL(alias: string, anchor: string): string {
  return `(SELECT COALESCE(min(r,c),r,c,'${NEVER_DUE}') FROM (SELECT ${rawDueSQL(alias, 't.anchor')} r,${contentDueSQL(alias, 't.anchor')} c FROM (SELECT ${anchor} anchor) t))`
}
/** Recomputes a clocked row's due time, optionally only if it is unchanged. */
export async function refreshLifecycleDue(env: Env, messageID: string, expectedDue?: string): Promise<void> {
  await env.DB.prepare(`UPDATE messages AS m SET lifecycle_due_at=${lifecycleDueSQL('m', terminalAnchorSQL('m'))}
    WHERE m.id=? AND m.retention_started_at IS NOT NULL AND m.content_deleted_at IS NULL${expectedDue === undefined ? '' : ' AND m.lifecycle_due_at=?'}`)
    .bind(messageID, ...(expectedDue === undefined ? [] : [expectedDue])).run()
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
      // Once raw has logically expired only the content stage remains due.
      const expired = await env.DB.prepare(`UPDATE messages AS m SET raw_expired_at=?,pending_delete_bytes=pending_delete_bytes+size_bytes,version=version+1,
        lifecycle_due_at=CASE WHEN m.retention_started_at IS NULL THEN m.lifecycle_due_at ELSE COALESCE(${contentDueSQL('m', terminalAnchorSQL('m'))},'${NEVER_DUE}') END
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

const SWEEP_PAGE = 20
/** Every periodic read is bounded by due or unsettled rows, never by history.
 * Due rows come from their precomputed lifecycle_due_at, which is only ever at
 * or before the true due time. The worst case stays below Free D1's 50
 * queries even counting each batch statement: two full deletions end the
 * pass, and the clock sweep then waits for the next one. */
export async function runLifecycle(env: Env, hooks: LifecycleHooks): Promise<{ continueSoon: boolean; processed: number }> {
  if (env.MAINTENANCE_MODE === 'true') return { continueSoon: false, processed: 0 }
  let processed = 0, more = false
  // Heal rows clocked by an older Worker; the partial index is normally empty.
  await env.DB.prepare(`UPDATE messages AS m SET lifecycle_due_at=${lifecycleDueSQL('m', terminalAnchorSQL('m'))} WHERE m.id IN(
    SELECT id FROM messages INDEXED BY messages_due_missing_idx WHERE origin='cloudflare' AND content_deleted_at IS NULL
      AND retention_started_at IS NOT NULL AND lifecycle_due_at IS NULL LIMIT 50)`).run()
  const retry = await env.DB.prepare(`SELECT id,version FROM messages WHERE raw_expired_at IS NOT NULL AND (raw_purged_at IS NULL OR raw_capacity_pending_key IS NOT NULL) AND content_deleted_at IS NULL ORDER BY raw_expired_at LIMIT 1`).first<Row>()
  if (retry && await expireRawContent(env, retry.id, retry.version, hooks.withMutation)) processed++
  // Every outcome other than a purge moves the due time forward or clears it,
  // so a row cannot be selected twice in one pass.
  const postpone = (id: string, old: string, due: string | null) => env.DB.prepare('UPDATE messages SET lifecycle_due_at=? WHERE id=? AND lifecycle_due_at=?').bind(due, id, old).run()
  for (let examined = 0; processed < 2 && examined < 4; examined++) {
    const timestamp = new Date().toISOString(), time = Date.parse(timestamp)
    // The index supplies the order, so the precise per-row state below is
    // evaluated for the single selected row only.
    const candidate = await env.DB.prepare(`SELECT m.id,m.version,m.retention_started_at,m.lifecycle_due_at,(${safeTerminalSQL()}) safe,
      ${contentDueSQL('m', terminalAnchorSQL('m'))} content_due_at,${rawDueSQL('m', terminalAnchorSQL('m'))} raw_due_at
      FROM messages m INDEXED BY messages_lifecycle_due_idx WHERE m.origin='cloudflare' AND m.content_deleted_at IS NULL
      AND m.lifecycle_due_at IS NOT NULL AND m.lifecycle_due_at<=? ORDER BY m.lifecycle_due_at,m.id LIMIT 1`).bind(timestamp).first<Row>()
    if (!candidate) break
    const old = candidate.lifecycle_due_at
    if (!candidate.retention_started_at) { await postpone(candidate.id, old, null); continue }
    if (!candidate.safe) { await postpone(candidate.id, old, new Date(time + DAY).toISOString()); continue }
    if (candidate.content_due_at && candidate.content_due_at <= timestamp) {
      let deleted = false
      await hooks.withMutation(async () => {
        // A send/reparse may have begun since selection. Recheck inside the guard.
        const safe = await env.DB.prepare(`SELECT m.id FROM messages m WHERE m.id=? AND m.version=? AND ${safeTerminalSQL()}`).bind(candidate.id, candidate.version).first()
        if (safe) { await hooks.deleteContent(candidate.id, candidate.version); deleted = true }
      }).catch(error => { if (!(error instanceof HttpError) || error.status !== 409) throw error })
      if (deleted) processed++
      else await postpone(candidate.id, old, new Date(time + HOUR).toISOString())
    } else if (candidate.raw_due_at && candidate.raw_due_at <= timestamp) {
      let expired = false
      try { expired = await expireRawContent(env, candidate.id, candidate.version, hooks.withMutation) }
      catch (error) { if (!(error instanceof HttpError) || error.status !== 409) throw error }
      // The expiry itself already moved the due time to the content stage.
      if (expired) processed++
      else await postpone(candidate.id, old, new Date(time + HOUR).toISOString())
    } else await refreshLifecycleDue(env, candidate.id, old) // The anchor moved later.
  }
  if (processed < 2) {
    await hooks.withMutation(async () => {
      // Start clocks through a resumable cursor over unsettled mail only.
      const saved = (await env.DB.prepare("SELECT value FROM maintenance WHERE id='retention_sweep_cursor'").first<Row>())?.value ?? ''
      const split = saved.indexOf('|')
      const page = (await env.DB.prepare(`SELECT m.id,m.received_at,m.retention_policy_version,(${safeTerminalSQL()}) safe FROM messages m INDEXED BY messages_unsettled_idx
        WHERE m.origin='cloudflare' AND m.content_deleted_at IS NULL AND m.retention_started_at IS NULL${saved ? ' AND (m.received_at,m.id)>(?,?)' : ''}
        ORDER BY m.received_at,m.id LIMIT ${SWEEP_PAGE}`).bind(...(saved ? [saved.slice(0, split), saved.slice(split + 1)] : [])).all<Row>()).results
      const ready = page.filter(row => row.safe && row.retention_policy_version !== null).map(row => row.id)
      more = page.length === SWEEP_PAGE
      const cursor = more ? `${page.at(-1)!.received_at}|${page.at(-1)!.id}` : ''
      const statements: D1PreparedStatement[] = []
      // Numbered parameters: ?1 is the clock start and also the anchor floor.
      if (ready.length) statements.push(env.DB.prepare(`UPDATE messages AS m SET retention_started_at=?1,
        lifecycle_due_at=${lifecycleDueSQL('m', 'max(?1,COALESCE((SELECT max(d.delivered_at) FROM deliveries d WHERE d.message_id=m.id),?1))')}
        WHERE m.id IN(${ready.map((_, i) => `?${i + 2}`).join(',')}) AND m.retention_started_at IS NULL AND m.retention_policy_version IS NOT NULL AND ${safeTerminalSQL('m')}`)
        .bind(new Date().toISOString(), ...ready))
      if (cursor !== saved) statements.push(env.DB.prepare("INSERT INTO maintenance(id,value) VALUES('retention_sweep_cursor',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").bind(cursor))
      if (statements.length) await env.DB.batch(statements)
    })
  }
  return { continueSoon: more || processed >= 2, processed }
}

export async function lifecycleStorage(env: Env): Promise<Row> {
  const pending = await env.DB.prepare('SELECT COALESCE(sum(pending_delete_bytes),0) pending_physical_delete_bytes FROM messages INDEXED BY messages_pending_delete_idx WHERE pending_delete_bytes>0').first<Row>()
  return { pending_physical_delete_bytes: pending?.pending_physical_delete_bytes ?? 0,
    bucket_actual_bytes: null, account_r2_bytes: null, measured_at: null, actual_usage_status: 'not_measured' }
}

export function retentionCutoff(days: number, timestamp = Date.now()): string { return new Date(timestamp - days * DAY).toISOString() }
