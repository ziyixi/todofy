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
  return [
    ...[70, 85, 95].map(threshold => ({ code: `capacity_${threshold}`, active: level === threshold,
      severity: threshold >= 85 ? 'critical' as const : 'warning' as const,
      metrics: { used_bytes: used, logical_bytes: value.logical_bytes, limit_bytes: limit, percent, capacity_accounting_available: +capacityAvailable } })),
    { code: 'backup_stale', active: backupAge >= 36 * 3_600_000, severity: 'critical', metrics: { age_seconds: Math.floor(backupAge / 1000), has_backup: value.last_backup_at ? 1 : 0 } },
    { code: 'pending_stale', active: pendingAge >= 3_600_000, severity: 'warning', metrics: { oldest_age_seconds: Math.floor(pendingAge / 1000) } },
    { code: 'parse_failed', active: value.parse_failed > 0, severity: 'warning', metrics: { count: Number(value.parse_failed) || 0 } },
  ]
}

/** At most one active reminder and one resolution per code per UTC day.
 * No addresses, subjects, response bodies or event content enter notifications. */
export async function evaluateAlerts(env: AlertEnv, time = Date.now()): Promise<number> {
  const snapshot = await env.DB.prepare(`SELECT s.logical_bytes,s.logical_limit_bytes,s.last_backup_at,s.created_at,
    (SELECT min(m.received_at) FROM messages m WHERE m.origin='cloudflare' AND m.content_deleted_at IS NULL AND
      (m.parse_state IN('pending','parsing') OR (m.receive_mode='forward' AND
        (NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id) OR EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.state<>'delivered'))))) oldest_pending_at,
    (SELECT count(*) FROM messages WHERE origin='cloudflare' AND parse_state='failed' AND content_deleted_at IS NULL) parse_failed
    FROM app_settings s WHERE s.id=1`).first<Row>()
  if (!snapshot) throw new Error('alert_settings_unavailable')
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
    statements.push(env.DB.prepare(`INSERT INTO alerts(code,active,severity,metrics_json,first_seen_at,last_seen_at,resolved_at,last_event_day)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET active=excluded.active,severity=excluded.severity,
      metrics_json=excluded.metrics_json,last_seen_at=excluded.last_seen_at,resolved_at=excluded.resolved_at,last_event_day=excluded.last_event_day`)
      .bind(signal.code, +signal.active, signal.severity, JSON.stringify(signal.metrics), timestamp, timestamp, signal.active ? null : timestamp, notify ? day : old.last_event_day))
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
  const delivery = await env.DB.prepare(`SELECT sum(CASE WHEN state IN('pending','sending') THEN 1 ELSE 0 END) pending,sum(CASE WHEN state='failed' THEN 1 ELSE 0 END) failed FROM alert_notifications`).first<Row>()
  return { ...alertConfiguration(env), active: active.results.map(({ metrics_json, ...row }) => ({ ...row, metrics: JSON.parse(metrics_json) })),
    pending_notifications: delivery?.pending ?? 0, failed_notifications: delivery?.failed ?? 0 }
}

/** Run as its own bounded maintenance phase, under the coordinator backup guard. */
export async function runAlerts(env: AlertEnv): Promise<{ continueSoon: boolean }> {
  if (env.MAINTENANCE_MODE === 'true') return { continueSoon: false }
  await evaluateAlerts(env)
  await deliverAlert(env)
  await env.DB.prepare(`DELETE FROM alert_notifications WHERE id IN (SELECT id FROM alert_notifications
    WHERE state IN('sent','failed','disabled') AND created_at<? ORDER BY created_at LIMIT 20)`)
    .bind(new Date(Date.now() - 180 * DAY).toISOString()).run()
  const pending = await env.DB.prepare(`SELECT 1 FROM alert_notifications WHERE state IN('pending','sending') LIMIT 1`).first()
  return { continueSoon: alertConfiguration(env).configured && !!pending }
}
