/** contracts/ops-v1 for Mail Hero: what the `Ops` entrypoint (ops.ts) runs. Kept free of
 * `cloudflare:workers` so Node tests import it directly.
 *
 * Content rule: outputs carry only codes, numbers, booleans, timestamps, event IDs and the owner UI URL.
 * Nothing here reads a subject, address, body, header, target URL or remote response. */
import type { Env } from './types.ts';
import type { CanaryDelivery, GuardState, MailHeroModes, MailHeroStatus, OpsErrorCode, OpsSeverity, OpsSignal, StartCanaryResult,
  CanaryPausedReason, CanaryUnavailableReason } from '../../../../contracts/ops-v1/ops-v1.ts';
import { OPS_ERROR_CODES, OPS_LIMITS, OPS_VERSION } from '../../../../contracts/ops-v1/ops-v1.ts';
import { alertSignals, alertSnapshot } from './alerts.ts';
import { backupStatus, withBackupWrite } from './backup.ts';
import { coordinatorRequest } from './capacity.ts';
import { CANARY_RUN_ID, canaryActionID, createSyntheticCanaryDelivery } from './pipeline.ts';
import { HttpError } from './security.ts';
import { CODE, EVENT_ID, opsError, parseGuardInput, timestamp } from './ops-guard.ts';

type Row = Record<string, any>;
export const MAIL_HERO_CAPABILITIES = ['canary_producer', 'guard'] as const;
const NORMAL_GUARD: GuardState = { level: 'normal', reason: null, until: null, set_at: null, deferred: [] };
const RANK: Record<OpsSeverity, number> = { critical: 0, warning: 1, info: 2 };
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** The only D1 statement of status() beyond alertSnapshot's five (one row per alert code). */
export const ACTIVE_ALERTS_SQL = 'SELECT code,active_since FROM alerts WHERE active=1 LIMIT 16';
/** status() D1 statements: alertSnapshot (5) and ACTIVE_ALERTS_SQL (1). */
export const STATUS_MAX_D1_STATEMENTS = 6;

const forceSendPaused = (env: Pick<Env, 'FORCE_SEND_PAUSED'>) => env.FORCE_SEND_PAUSED === 'true' || env.FORCE_SEND_PAUSED === '1';
export function uiURL(host: unknown): string | null {
  return typeof host === 'string' && HOST.test(host) ? `https://${host}/` : null;
}
function limit(value: string | undefined, fallback: number): number | null {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}
/** Numbers only, named by codes, at most OPS_LIMITS.metricsMaxKeys. */
function numbers(value: Record<string, unknown>, max: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (Object.keys(out).length >= max) break;
    if (CODE.test(key) && typeof item === 'number' && Number.isFinite(item)) out[key] = item;
  }
  return out;
}
/** Rejects only with an OpsErrorCode; a bug or provider error (which may carry SQL or URLs) is `unavailable`. */
export async function opsCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const code = error instanceof Error && (OPS_ERROR_CODES as readonly string[]).includes(error.message) ? error.message as OpsErrorCode : 'unavailable';
    throw new Error(code);
  }
}

/** The coordinator's `GET /ops/status` (DO SQLite only). */
export interface CoordinatorOpsStatus {
  jobs_pending: number; jobs_failed: number; backup_active: boolean;
  capacity: { used_bytes: number; limit_bytes: number } | null;
  ingest_today: { messages: number; bytes: number }; guard: GuardState;
}
export interface StatusInput {
  time: number;
  env: Pick<Env, 'MAINTENANCE_MODE' | 'FORCE_SEND_PAUSED' | 'INGEST_DAILY_MESSAGE_LIMIT' | 'INGEST_DAILY_BYTE_LIMIT' | 'PUBLIC_HOST'>;
  /** null when a read failed: the status is then `down` with the single signal status_unavailable. */
  coordinator: CoordinatorOpsStatus | null;
  snapshot: Row | null;
  active: Array<{ code: string; active_since: string | null }> | null;
}

/** Pure: health, modes, signals and counters from the bounded reads (IMPLEMENTATION.md 2.4). */
export function buildStatus({ time, env, coordinator, snapshot, active }: StatusInput): MailHeroStatus {
  const maintenance = env.MAINTENANCE_MODE === 'true', forced = forceSendPaused(env);
  const base = { version: OPS_VERSION as typeof OPS_VERSION, app: 'mail-hero' as const, generated_at: new Date(time).toISOString() };
  const tail = { ui_url: uiURL(env.PUBLIC_HOST), capabilities: [...MAIL_HERO_CAPABILITIES] };
  if (!coordinator || !snapshot || !active) {
    // Modes from deployment variables only: the others were not read and are not guessed.
    return { ...base, health: 'down', modes: { maintenance, force_send_paused: forced } as MailHeroModes,
      guard: coordinator?.guard ?? NORMAL_GUARD, signals: [{ code: 'status_unavailable', severity: 'critical', metrics: {} }],
      counters: {}, last_backup_at: null, ...tail };
  }
  const guard = coordinator.guard;
  const view: Row = { ...snapshot };
  if (coordinator.capacity) { view.capacity_used_bytes = coordinator.capacity.used_bytes; view.capacity_limit_bytes = coordinator.capacity.limit_bytes; }
  const since = new Map(active.map(row => [row.code, timestamp(row.active_since)]));
  const signals: OpsSignal[] = [];
  const add = (code: string, severity: OpsSeverity, metrics: Record<string, unknown> = {}) => {
    const start = since.get(code);
    signals.push({ code, severity, metrics: numbers(metrics, OPS_LIMITS.metricsMaxKeys), ...(start ? { since: start } : {}) });
  };
  for (const signal of alertSignals(view, time)) if (signal.active) add(signal.code, signal.severity, signal.metrics);
  if (maintenance) add('maintenance_mode', 'critical');
  if (forced) add('force_send_paused', 'warning');
  if (snapshot.send_paused) add('send_paused', 'warning');
  const messageLimit = limit(env.INGEST_DAILY_MESSAGE_LIMIT, 300), byteLimit = limit(env.INGEST_DAILY_BYTE_LIMIT, 256 * 1024 * 1024);
  const today = coordinator.ingest_today;
  if (messageLimit && byteLimit) {
    const percent = Math.round(Math.max(today.messages / messageLimit, today.bytes / byteLimit) * 1000) / 10;
    if (percent >= 80) add('ingest_quota_80', 'warning', { messages: today.messages, bytes: today.bytes, message_limit: messageLimit, byte_limit: byteLimit, percent });
  }
  if (!snapshot.forwarding) add('forwarding_off', 'info');
  if (coordinator.backup_active) add('backup_active', 'info');
  if (guard.level === 'shed' && guard.until) add('guard_shed', 'info', { seconds_left: Math.max(0, Math.ceil((Date.parse(guard.until) - time) / 1000)) });
  signals.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const health = maintenance ? 'down' : signals.some(signal => signal.severity !== 'info') ? 'degraded' : 'ok';
  const oldest = snapshot.oldest_pending_at ? Date.parse(snapshot.oldest_pending_at) : NaN;
  const counters = numbers({
    jobs_pending: coordinator.jobs_pending, jobs_failed: coordinator.jobs_failed,
    parse_failed: Number(snapshot.parse_failed), delivery_failed: Number(snapshot.delivery_failed), policy_error: Number(snapshot.policy_error),
    blocked_waiting: Number(snapshot.blocked_waiting), paused_waiting: Number(snapshot.paused_waiting),
    oldest_pending_age_seconds: snapshot.oldest_pending_at ? Math.max(0, Math.floor((time - oldest) / 1000)) : 0,
    ...(coordinator.capacity ? { capacity_used_bytes: coordinator.capacity.used_bytes, capacity_limit_bytes: coordinator.capacity.limit_bytes } : {}),
    logical_bytes: Number(snapshot.logical_bytes),
    ingest_today_messages: today.messages, ingest_today_bytes: today.bytes,
    ...(messageLimit ? { ingest_limit_messages: messageLimit } : {}), ...(byteLimit ? { ingest_limit_bytes: byteLimit } : {}),
  }, OPS_LIMITS.countersMaxKeys);
  return { ...base, health,
    modes: { maintenance, force_send_paused: forced, send_paused: !!snapshot.send_paused, forwarding: !!snapshot.forwarding, backup_active: !!coordinator.backup_active },
    guard, signals: signals.slice(0, OPS_LIMITS.statusMaxSignals), counters, last_backup_at: timestamp(snapshot.last_backup_at), ...tail };
}

/** status(): one Durable Object request, then at most STATUS_MAX_D1_STATEMENTS bounded D1 reads, no writes. */
export async function opsStatus(env: Env, time = Date.now()): Promise<MailHeroStatus> {
  let coordinator: CoordinatorOpsStatus | null = null, snapshot: Row | null = null, active: StatusInput['active'] = null;
  try {
    const response = await coordinatorRequest(env, '/ops/status');
    if (response.ok) coordinator = await response.json();
  } catch { /* reported as status_unavailable */ }
  if (coordinator) {
    try {
      snapshot = await alertSnapshot(env, time);
      active = (await env.DB.prepare(ACTIVE_ALERTS_SQL).all<{ code: string; active_since: string | null }>()).results;
    } catch { snapshot = null; }
  }
  return buildStatus({ time, env, coordinator, snapshot, active });
}

/** setGuard(): validated here and again by the coordinator against its own clock. */
export async function opsSetGuard(env: Env, input: unknown): Promise<GuardState> {
  parseGuardInput(input, Date.now());
  let response: Response;
  try { response = await coordinatorRequest(env, '/ops/guard', input); } catch { return opsError('unavailable'); }
  if (response.status === 400) opsError('invalid_input');
  if (!response.ok) opsError('unavailable');
  return response.json();
}

const paused = (reason: CanaryPausedReason): StartCanaryResult => ({ event_id: null, state: 'paused', reason });
const unavailable = (reason: CanaryUnavailableReason): StartCanaryResult => ({ event_id: null, state: 'unavailable', reason });
/** The current default target: settings, current endpoint and its current revision (one row). */
const TARGET_SQL = `SELECT s.mode,s.send_paused,e.id endpoint_id,e.paused,e.archived_at,e.current_revision_id,r.id revision_id,r.blocked_reason,r.blocked_until
  FROM app_settings s LEFT JOIN webhook_endpoints e ON e.id=s.current_endpoint_id LEFT JOIN endpoint_revisions r ON r.id=e.current_revision_id WHERE s.id=1`;

/** startCanary(): idempotent per run_id; nothing is queued while sending would be held. At most two D1
 * reads before the synthetic delivery's own statements. */
export async function startCanary(env: Env, input: unknown, time = Date.now()): Promise<StartCanaryResult> {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
      typeof value.run_id !== 'string' || !CANARY_RUN_ID.test(value.run_id)) opsError('invalid_input');
  const runID = value!.run_id as string;
  if (env.MAINTENANCE_MODE === 'true') return unavailable('maintenance');
  let target: Row | null;
  try {
    const existing = await env.DB.prepare('SELECT event_id FROM deliveries WHERE action_request_id=?').bind(canaryActionID(runID)).first<Row>();
    if (existing) return { event_id: existing.event_id, state: 'queued' };
    target = await env.DB.prepare(TARGET_SQL).first<Row>();
  } catch { return opsError('unavailable'); }
  if (!target) opsError('unavailable');
  if (forceSendPaused(env)) return paused('send_paused');
  if (target!.send_paused) return paused('settings_paused');
  if (target!.mode !== 'forward' || !target!.endpoint_id || !target!.revision_id) return unavailable('no_endpoint');
  if (target!.paused || target!.archived_at) return paused('endpoint_paused');
  if (target!.blocked_reason && (!target!.blocked_until || Date.parse(target!.blocked_until) > time)) return paused('endpoint_blocked');
  let eventID: string;
  try { eventID = await withBackupWrite(env, () => createSyntheticCanaryDelivery(env, target!.revision_id, runID)); }
  catch (error) {
    const code = error instanceof HttpError ? error.code : error instanceof Error ? error.message : '';
    // The capacity reservation, or the capacity-guarded message or delivery insert, refused it.
    if (['logical_capacity', 'message_not_found', 'message_changed'].includes(code)) return unavailable('capacity');
    if (code === 'backup_in_progress') {
      try { if ((await backupStatus(env)).paused) return unavailable('backup_active'); } catch { /* unavailable */ }
    }
    return opsError('unavailable');
  }
  return { event_id: eventID, state: 'queued' };
}

/** One statement: the event, its message's canary marker, the holds that apply and the last HTTP status. */
export const CANARY_DELIVERY_SQL = `SELECT d.state,d.attempt_count,d.created_at,d.delivered_at,d.last_error,e.paused endpoint_paused,e.archived_at,s.send_paused,
  (SELECT a.http_status FROM delivery_attempts a WHERE a.event_id=d.event_id ORDER BY a.attempt_no DESC LIMIT 1) last_http_status
  FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN endpoint_revisions r ON r.id=d.endpoint_revision_id
  JOIN webhook_endpoints e ON e.id=r.endpoint_id JOIN app_settings s ON s.id=1
  WHERE d.event_id=? AND m.canary_run_id IS NOT NULL`;
/** Pure mapping of that row (null: no canary with this ID, also a real mail's event). */
export function canaryDeliveryState(row: Row | null, env: Pick<Env, 'FORCE_SEND_PAUSED' | 'MAINTENANCE_MODE'>): CanaryDelivery {
  if (!row) return { state: 'unknown', attempts: 0 };
  const attempts = Math.max(0, Number(row.attempt_count) || 0);
  const status = Number(row.last_http_status);
  const http = row.last_http_status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? { last_http_status: status } : {};
  const error = typeof row.last_error === 'string' && CODE.test(row.last_error) ? row.last_error : null;
  if (row.state === 'delivered') {
    return { state: 'delivered', attempts: Math.max(1, attempts), ...http, delivered_at: timestamp(row.delivered_at) ?? timestamp(row.created_at)! };
  }
  if (row.state === 'failed' || row.state === 'cancelled') {
    return { state: 'failed', attempts, ...http, error_code: error ?? (row.state === 'cancelled' ? 'canary_cancelled' : 'delivery_failed') };
  }
  const held = forceSendPaused(env) || env.MAINTENANCE_MODE === 'true' || !!row.send_paused || !!row.endpoint_paused || !!row.archived_at;
  return { state: held ? 'paused' : 'pending', attempts, ...http, ...(error ? { error_code: error } : {}) };
}
export async function canaryDelivery(env: Env, eventID: unknown): Promise<CanaryDelivery> {
  if (typeof eventID !== 'string' || !EVENT_ID.test(eventID)) opsError('invalid_input');
  let row: Row | null;
  try { row = await env.DB.prepare(CANARY_DELIVERY_SQL).bind(eventID).first<Row>(); } catch { return opsError('unavailable'); }
  return canaryDeliveryState(row, env);
}
