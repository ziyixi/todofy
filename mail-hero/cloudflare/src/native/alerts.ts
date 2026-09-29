import type { Env } from './types.ts'
import { validateTarget } from './security.ts'
import { capacitySnapshot } from './capacity.ts'

type Row = Record<string, any>
type AlertEnv = Env & { ALERT_WEBHOOK_URL?: string; ALERT_WEBHOOK_TOKEN?: string; ALERT_WEBHOOK_ALLOWED_HOSTS?: string }
const DAY = 86_400_000
const MAX_ATTEMPTS = 8
export const ALERT_INTERVAL_MS = 10 * 60_000
interface Signal { code: string; active: boolean; severity: 'info' | 'warning' | 'critical'; metrics: Record<string, number> }

function destination(env: AlertEnv): { url: string; token: string } | null {
  if (!env.ALERT_WEBHOOK_URL && !env.ALERT_WEBHOOK_TOKEN) return null
  if (!env.ALERT_WEBHOOK_URL || !env.ALERT_WEBHOOK_TOKEN || env.ALERT_WEBHOOK_TOKEN.length < 32 || env.ALERT_WEBHOOK_TOKEN.length > 4096 || /[\r\n]/.test(env.ALERT_WEBHOOK_TOKEN)) throw new Error('alert_auth_invalid')
  const url = validateTarget({ ...env, WEBHOOK_ALLOWED_HOSTS: env.ALERT_WEBHOOK_ALLOWED_HOSTS ?? env.WEBHOOK_ALLOWED_HOSTS }, env.ALERT_WEBHOOK_URL)
  return { url: url.toString(), token: env.ALERT_WEBHOOK_TOKEN }
}
export function alertConfiguration(env: AlertEnv): { configured: boolean; configuration_error: boolean } {
  try { return { configured: destination(env) !== null, configuration_error: false } }
  catch { return { configured: false, configuration_error: true } }
}
export function alertSignals(value: Row, time = Date.now()): Signal[] {
  const capacityAvailable = Number.isSafeInteger(value.capacity_used_bytes) && value.capacity_used_bytes >= 0
  const used = Math.max(value.logical_bytes, capacityAvailable ? value.capacity_used_bytes : 0)
  const limit = capacityAvailable && value.capacity_limit_bytes > 0 ? value.capacity_limit_bytes : value.logical_limit_bytes
  const percent = limit > 0 ? Math.round(used / limit * 1000) / 10 : 0
  const level = percent >= 95 ? 95 : percent >= 85 ? 85 : percent >= 70 ? 70 : 0
  const backupAge = Math.max(0, time - Date.parse(value.last_backup_at || value.created_at))
  const pendingAge = value.oldest_pending_at ? Math.max(0, time - Date.parse(value.oldest_pending_at)) : 0
  const count = (name: string) => Number(value[name]) || 0
  const currentBlocked = count('current_blocked') > 0, blockedWaiting = count('blocked_waiting')
  // Auto recheck only when every block in view has a cooldown; any permanent
  // block needs the owner (rotate credentials or unblock).
  const autoRecheck = currentBlocked ? count('current_auto_recheck') > 0 : blockedWaiting > 0 && count('blocked_permanent_waiting') === 0
  return [
    ...[70, 85, 95].map(threshold => ({ code: `capacity_${threshold}`, active: level === threshold,
      severity: threshold >= 85 ? 'critical' as const : 'warning' as const,
      metrics: { used_bytes: used, logical_bytes: value.logical_bytes, limit_bytes: limit, percent, capacity_accounting_available: +capacityAvailable } })),
    { code: 'backup_stale', active: backupAge >= 36 * 3_600_000, severity: 'critical', metrics: { age_seconds: Math.floor(backupAge / 1000), has_backup: value.last_backup_at ? 1 : 0 } },
    { code: 'pending_stale', active: pendingAge >= 3_600_000, severity: 'warning', metrics: { oldest_age_seconds: Math.floor(pendingAge / 1000) } },
    { code: 'parse_failed', active: value.parse_failed > 0, severity: 'warning', metrics: { count: Number(value.parse_failed) || 0 } },
    { code: 'endpoint_blocked', active: currentBlocked || blockedWaiting > 0, severity: 'critical',
      metrics: { waiting_deliveries: blockedWaiting, current_blocked: +currentBlocked, auto_recheck: +autoRecheck } },
    { code: 'endpoint_paused', active: count('current_paused') > 0, severity: 'warning', metrics: { waiting_deliveries: count('paused_waiting') } },
    { code: 'delivery_failed', active: count('delivery_failed') > 0, severity: 'warning', metrics: { count: count('delivery_failed') } },
    { code: 'policy_error', active: count('policy_error') > 0, severity: 'warning', metrics: { count: count('policy_error') } },
  ]
}

/** Live parse backlog and failures. The partial index excludes tombstones. */
export async function parseStatus(env: Env): Promise<{ oldest_at: string | null; failed: number }> {
  const row = await env.DB.prepare(`SELECT min(CASE WHEN parse_state IN('pending','parsing') THEN received_at END) oldest_at,
    COALESCE(sum(parse_state='failed'),0) failed FROM messages INDEXED BY messages_live_lifecycle_idx
    WHERE origin='cloudflare' AND content_deleted_at IS NULL AND parse_state IN('pending','parsing','failed')`).first<Row>()
  return { oldest_at: row?.oldest_at ?? null, failed: Number(row?.failed) || 0 }
}
/** Bounded snapshot: each query reads unsettled, in-flight or current-target rows only.
 * A block counts only while it is effective: an expired cooldown is sendable,
 * exactly as the scheduler sees it, and is rechecked on its next attempt. */
export async function alertSnapshot(env: Env, time = Date.now()): Promise<Row> {
  const timestamp = new Date(time).toISOString()
  const settings = await env.DB.prepare(`SELECT s.logical_bytes,s.logical_limit_bytes,s.last_backup_at,s.created_at,s.mode,s.current_endpoint_id,s.send_paused,
    e.paused endpoint_paused,e.archived_at endpoint_archived_at,r.blocked_reason,r.blocked_until
    FROM app_settings s LEFT JOIN webhook_endpoints e ON e.id=s.current_endpoint_id LEFT JOIN endpoint_revisions r ON r.id=e.current_revision_id WHERE s.id=1`).first<Row>()
  if (!settings) throw new Error('alert_settings_unavailable')
  const parse = await parseStatus(env)
  // Unsettled live mail: forward-ready mail with no event, stopped deliveries
  // and archive-only policy errors. Settled mail has left this partial index.
  const unsettled = await env.DB.prepare(`SELECT
    min(CASE WHEN m.parse_state='ready' AND m.receive_mode='forward' AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id) THEN m.received_at END) oldest_unsent_at,
    COALESCE(sum(EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.state='failed')
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.state IN('delivered','pending','retry_wait','sending'))),0) delivery_failed,
    COALESCE(sum(m.policy_error IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.state='delivered')),0) policy_error
    FROM messages m INDEXED BY messages_unsettled_idx WHERE m.origin='cloudflare' AND m.content_deleted_at IS NULL AND m.retention_started_at IS NULL`).first<Row>()
  const inflight = await env.DB.prepare(`SELECT min(d.created_at) oldest_at FROM deliveries d INDEXED BY deliveries_due_idx JOIN messages m ON m.id=d.message_id
    WHERE d.state IN('pending','retry_wait','sending') AND m.content_deleted_at IS NULL`).first<Row>()
  const effective = '(r.blocked_reason IS NOT NULL AND (r.blocked_until IS NULL OR r.blocked_until>?))'
  const waiting = await env.DB.prepare(`SELECT COALESCE(sum(${effective}),0) blocked_waiting,
    COALESCE(sum(r.blocked_reason IS NOT NULL AND r.blocked_until IS NULL),0) blocked_permanent_waiting,
    COALESCE(sum(e.paused=1 OR e.archived_at IS NOT NULL),0) paused_waiting
    FROM deliveries d INDEXED BY deliveries_due_idx JOIN endpoint_revisions r ON r.id=d.endpoint_revision_id JOIN webhook_endpoints e ON e.id=r.endpoint_id
    WHERE d.state IN('pending','retry_wait') AND (${effective} OR e.paused=1 OR e.archived_at IS NOT NULL)`).bind(timestamp, timestamp).first<Row>()
  const oldest = [parse.oldest_at, unsettled?.oldest_unsent_at, inflight?.oldest_at].filter((value): value is string => !!value).sort()[0] ?? null
  const forward = settings.mode === 'forward' && settings.current_endpoint_id
  const currentBlocked = forward && settings.blocked_reason && (!settings.blocked_until || Date.parse(settings.blocked_until) > time)
  return { logical_bytes: settings.logical_bytes, logical_limit_bytes: settings.logical_limit_bytes, last_backup_at: settings.last_backup_at,
    created_at: settings.created_at, oldest_pending_at: oldest, parse_failed: parse.failed,
    delivery_failed: Number(unsettled?.delivery_failed) || 0, policy_error: Number(unsettled?.policy_error) || 0,
    current_blocked: currentBlocked ? 1 : 0, current_auto_recheck: currentBlocked && settings.blocked_until ? 1 : 0,
    current_paused: forward && settings.endpoint_paused ? 1 : 0,
    blocked_waiting: Number(waiting?.blocked_waiting) || 0, blocked_permanent_waiting: Number(waiting?.blocked_permanent_waiting) || 0,
    paused_waiting: Number(waiting?.paused_waiting) || 0,
    // Read by ops-v1 status() only (modes); alertSignals ignores them.
    send_paused: settings.send_paused ? 1 : 0, forwarding: forward ? 1 : 0 }
}

/** At most one active reminder and one resolution per code per UTC day.
 * No addresses, subjects, response bodies or event content enter notifications. */
export async function evaluateAlerts(env: AlertEnv, time = Date.now()): Promise<number> {
  const snapshot = await alertSnapshot(env, time)
  try {
    const capacity = await capacitySnapshot(env)
    snapshot.capacity_used_bytes = capacity.used_bytes
    snapshot.capacity_limit_bytes = capacity.limit_bytes
  } catch { /* D1-only fallback is explicit in each capacity alert's metrics. */ }
  const existing = await env.DB.prepare('SELECT * FROM alerts').all<Row>()
  const previous = new Map(existing.results.map(row => [row.code, row]))
  const timestamp = new Date(time).toISOString(), day = timestamp.slice(0, 10)
  const config = alertConfiguration(env)
  const statements: D1PreparedStatement[] = []
  let events = 0
  for (const signal of alertSignals(snapshot, time)) {
    const old = previous.get(signal.code)
    if (!signal.active && !old?.active) continue
    const transition = signal.active ? 'active' : 'resolved'
    const notify = !old || !!old.active !== signal.active || old.last_event_day !== day
    // active_since (0010): start of the current activation, kept while it stays active (ops-v1 `since`).
    statements.push(env.DB.prepare(`INSERT INTO alerts(code,active,severity,metrics_json,first_seen_at,last_seen_at,resolved_at,last_event_day,active_since)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET active=excluded.active,severity=excluded.severity,
      metrics_json=excluded.metrics_json,last_seen_at=excluded.last_seen_at,resolved_at=excluded.resolved_at,last_event_day=excluded.last_event_day,
      active_since=CASE WHEN excluded.active=1 THEN COALESCE(CASE WHEN alerts.active=1 THEN alerts.active_since END,excluded.active_since) END`)
      .bind(signal.code, +signal.active, signal.severity, JSON.stringify(signal.metrics), timestamp, timestamp, signal.active ? null : timestamp, notify ? day : old.last_event_day, signal.active ? timestamp : null))
    if (notify) {
      const id = crypto.randomUUID()
      const payload = JSON.stringify({ type: 'mailhero.alert.v1', id, code: signal.code, state: transition,
        severity: signal.active ? signal.severity : 'info', observed_at: timestamp, metrics: signal.metrics, management_path: '/settings' })
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO alert_notifications(id,code,transition,day,payload_json,state,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .bind(id, signal.code, transition, day, payload, config.configured ? 'pending' : 'disabled', timestamp, timestamp))
      events++
    }
  }
  if (statements.length) await env.DB.batch(statements)
  return events
}

/** One durable outbound attempt per invocation. Retrying reuses exact bytes/ID. */
export async function deliverAlert(env: AlertEnv, time = Date.now()): Promise<boolean> {
  let target: ReturnType<typeof destination>
  try { target = destination(env) } catch { return false }
  if (!target || env.MAINTENANCE_MODE === 'true') return false
  const timestamp = new Date(time).toISOString()
  const row = await env.DB.prepare(`SELECT * FROM alert_notifications WHERE
    (state='pending' AND next_attempt_at<=?) OR (state='sending' AND lease_until<=?) ORDER BY created_at,id LIMIT 1`).bind(timestamp, timestamp).first<Row>()
  if (!row) return false
  if (row.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(`UPDATE alert_notifications SET state='failed',last_error='attempt_limit',lease_until=NULL,finished_at=? WHERE id=? AND attempts>=?`).bind(timestamp, row.id, MAX_ATTEMPTS).run()
    return true
  }
  const claim = await env.DB.prepare(`UPDATE alert_notifications SET state='sending',attempts=attempts+1,lease_until=? WHERE id=? AND attempts=?
    AND ((state='pending' AND next_attempt_at<=?) OR (state='sending' AND lease_until<=?))`)
    .bind(new Date(time + 60_000).toISOString(), row.id, row.attempts, timestamp, timestamp).run()
  if (!claim.meta.changes) return false
  const attempt = row.attempts + 1
  let state = 'pending', error: string | null = 'network_error', delay = Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(attempt - 1, 9))
  try {
    const response = await fetch(target.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${target.token}`, 'Idempotency-Key': row.id, 'User-Agent': 'MailHero/1.0' }, body: row.payload_json })
    const status = response.status
    if (status >= 200 && status < 300) { state = 'sent'; error = null }
    else {
      error = `http_${status}`
      if (status !== 408 && status !== 429 && status < 500) state = 'failed'
      const value = response.headers.get('Retry-After')
      if (value) {
        const requested = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - time
        if (Number.isFinite(requested) && requested > 0) {
          if (requested > DAY) { state = 'failed'; error = 'retry_after_excessive' }
          else delay = Math.max(delay, requested)
        }
      }
    }
    await response.body?.cancel()
  } catch { /* Error details may contain credentials or remote content. */ }
  if (state === 'pending' && attempt >= MAX_ATTEMPTS) { state = 'failed'; error = 'attempt_limit' }
  await env.DB.prepare(`UPDATE alert_notifications SET state=?,last_error=?,next_attempt_at=?,lease_until=NULL,finished_at=? WHERE id=? AND state='sending' AND attempts=?`)
    .bind(state, error, new Date(time + delay).toISOString(), state === 'pending' ? null : new Date().toISOString(), row.id, attempt).run()
  return true
}

export async function alertOverview(env: AlertEnv): Promise<Row> {
  const active = await env.DB.prepare('SELECT code,severity,metrics_json,first_seen_at,last_seen_at FROM alerts WHERE active=1 ORDER BY severity,code LIMIT 8').all<Row>()
  const delivery = await env.DB.prepare(`SELECT (SELECT count(*) FROM alert_notifications WHERE state IN('pending','sending')) pending,
    (SELECT count(*) FROM alert_notifications WHERE state='failed') failed`).first<Row>()
  return { ...alertConfiguration(env), active: active.results.map(({ metrics_json, ...row }) => ({ ...row, metrics: JSON.parse(metrics_json) })),
    pending_notifications: delivery?.pending ?? 0, failed_notifications: delivery?.failed ?? 0 }
}

/** Run as its own bounded maintenance phase, under the coordinator backup guard.
 * `purgeHistory: false` (an ops-v1 shed guard) skips only the 180-day history delete. */
export async function runAlerts(env: AlertEnv, options: { purgeHistory?: boolean } = {}): Promise<{ continueSoon: boolean }> {
  if (env.MAINTENANCE_MODE === 'true') return { continueSoon: false }
  await evaluateAlerts(env)
  await deliverAlert(env)
  if (options.purgeHistory !== false) await env.DB.prepare(`DELETE FROM alert_notifications WHERE id IN (SELECT id FROM alert_notifications INDEXED BY alert_notifications_created_idx
    WHERE created_at<? AND state IN('sent','failed','disabled') ORDER BY created_at LIMIT 20)`)
    .bind(new Date(Date.now() - 180 * DAY).toISOString()).run()
  const pending = await env.DB.prepare(`SELECT 1 FROM alert_notifications WHERE state IN('pending','sending') LIMIT 1`).first()
  return { continueSoon: alertConfiguration(env).configured && !!pending }
}
