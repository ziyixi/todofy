import type { Env } from './types.ts'
import { capacitySnapshot } from './capacity.ts'

type Row = Record<string, any>
export const ALERT_INTERVAL_MS = 10 * 60_000
interface Signal { code: string; active: boolean; severity: 'info' | 'warning' | 'critical'; metrics: Record<string, number> }

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

/** Keeps one row per code in `alerts`. ops-v1 status() reports the active rows as signals (with `since`), and Home's
 * daily digest task in Tasks carries them to the owner; the owner UI shows them too. Only codes, counts and times are
 * stored, never addresses, subjects, response bodies or event content. */
export async function evaluateAlerts(env: Env, time = Date.now()): Promise<void> {
  const snapshot = await alertSnapshot(env, time)
  try {
    const capacity = await capacitySnapshot(env)
    snapshot.capacity_used_bytes = capacity.used_bytes
    snapshot.capacity_limit_bytes = capacity.limit_bytes
  } catch { /* D1-only fallback is explicit in each capacity alert's metrics. */ }
  const existing = await env.DB.prepare('SELECT * FROM alerts').all<Row>()
  const previous = new Map(existing.results.map(row => [row.code, row]))
  const timestamp = new Date(time).toISOString()
  const statements: D1PreparedStatement[] = []
  for (const signal of alertSignals(snapshot, time)) {
    if (!signal.active && !previous.get(signal.code)?.active) continue
    // active_since (0010): start of the current activation, kept while it stays active (ops-v1 `since`).
    // last_event_day (0006, NOT NULL) was the removed alert webhook's daily key; it is the day of the last write.
    statements.push(env.DB.prepare(`INSERT INTO alerts(code,active,severity,metrics_json,first_seen_at,last_seen_at,resolved_at,last_event_day,active_since)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET active=excluded.active,severity=excluded.severity,
      metrics_json=excluded.metrics_json,last_seen_at=excluded.last_seen_at,resolved_at=excluded.resolved_at,last_event_day=excluded.last_event_day,
      active_since=CASE WHEN excluded.active=1 THEN COALESCE(CASE WHEN alerts.active=1 THEN alerts.active_since END,excluded.active_since) END`)
      .bind(signal.code, +signal.active, signal.severity, JSON.stringify(signal.metrics), timestamp, timestamp, signal.active ? null : timestamp, timestamp.slice(0, 10), signal.active ? timestamp : null))
  }
  if (statements.length) await env.DB.batch(statements)
}

/** The active alerts for the owner UI, most severe first. */
export async function alertOverview(env: Env): Promise<Row> {
  const active = await env.DB.prepare('SELECT code,severity,metrics_json,first_seen_at,last_seen_at FROM alerts WHERE active=1 ORDER BY severity,code LIMIT 8').all<Row>()
  return { active: active.results.map(({ metrics_json, ...row }) => ({ ...row, metrics: JSON.parse(metrics_json) })) }
}
