/** contracts/ops-v1 guard: input rules, effective state and the Durable Object store behind it.
 * No Worker bindings here: MailCoordinator owns the storage, ops-core.ts and tests use the pure parts. */
import type { GuardState, OpsErrorCode } from '../../../../contracts/ops-v1/ops-v1.ts';
import { OPS_LIMITS } from '../../../../contracts/ops-v1/ops-v1.ts';

/** Background jobs that a shed guard defers (contracts/ops-v1/IMPLEMENTATION.md 2.5). Everything else
 * (intake, parsing, delivery and retries, repair, alerts, backup, the canary itself) always runs. */
export const DEFERRABLE_JOBS = ['raw_reconcile', 'lifecycle_retention', 'canary_cleanup', 'alert_history_purge'] as const;
export type DeferrableJob = (typeof DEFERRABLE_JOBS)[number];
/** A deferred job still runs once its last run is this old, so a guard renewed forever cannot starve it. */
export const DEFER_BOUND_MS = 48 * 3600_000;

/** Passed by the coordinator's alarm to runMaintenance. Without one, every job runs. */
export interface OpsDeferral {
  defers(job: DeferrableJob): boolean;
  ran(job: DeferrableJob): void;
}

export const CODE = /^[a-z][a-z0-9_]{0,47}$/;
export const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/;
/** Lowercase UUID, as Mail Hero writes event IDs (ops-v1 EventId). */
export const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The only errors a method rejects with; the message crosses RPC intact. */
export function opsError(code: OpsErrorCode): never { throw new Error(code); }

/** A well-formed RFC 3339 UTC instant that names a real calendar time, as epoch ms; otherwise null. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return null;
  const time = Date.parse(value);
  // Date.parse rolls 2026-02-30 over into March; the round trip refuses it.
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : null;
}
export function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && time >= 0 && time < 253402300800000 ? new Date(time).toISOString() : null;
}

export type GuardInput = { level: 'shed'; reason: string; until: number } | { level: 'normal'; reason: string; until: null };
/** SetGuardInput plus the rules the schema cannot express: `until` in (now, now + 36 h]. */
export function parseGuardInput(input: unknown, now: number): GuardInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) opsError('invalid_input');
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'level' || keys[1] !== 'reason' || keys[2] !== 'until') opsError('invalid_input');
  if (typeof value.reason !== 'string' || !CODE.test(value.reason)) opsError('invalid_input');
  if (value.level === 'normal') {
    if (value.until !== null) opsError('invalid_input');
    return { level: 'normal', reason: value.reason as string, until: null };
  }
  if (value.level !== 'shed') opsError('invalid_input');
  const until = parseTimestamp(value.until);
  if (until === null || until <= now || until > now + OPS_LIMITS.guardMaxAheadSeconds * 1000) opsError('invalid_input');
  return { level: 'shed', reason: value.reason as string, until: until as number };
}

export interface GuardRow { level: string; reason: string | null; until: number | null; set_at: number | null }
const NORMAL: GuardState = { level: 'normal', reason: null, until: null, set_at: null, deferred: [] };
/** Effective guard: shed only while now < until; anything else (absent, expired, damaged) reads as normal. */
export function guardState(row: GuardRow | null | undefined, now: number): GuardState {
  if (!row || row.level !== 'shed' || typeof row.until !== 'number' || row.until <= now ||
      typeof row.reason !== 'string' || !CODE.test(row.reason)) return NORMAL;
  const until = timestamp(row.until), setAt = timestamp(row.set_at ?? now);
  if (!until) return NORMAL;
  return { level: 'shed', reason: row.reason, until, set_at: setAt, deferred: [...DEFERRABLE_JOBS] };
}

type Sql = DurableObjectStorage['sql'];
/** Guard and last-run times in the coordinator's own SQLite: no D1, never in a backup, never held by a
 * backup lease, readable by the alarm without a network call. Losing it reads as normal. */
export class OpsGuardStore {
  private readonly sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS ops_guard(id INTEGER PRIMARY KEY CHECK(id=1),level TEXT NOT NULL,reason TEXT,until INTEGER,set_at INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS ops_job_runs(job TEXT PRIMARY KEY,at INTEGER NOT NULL)');
  }
  private row(): GuardRow | undefined {
    return this.sql.exec<GuardRow & Record<string, SqlStorageValue>>('SELECT level,reason,until,set_at FROM ops_guard WHERE id=1').toArray()[0];
  }
  read(now: number): GuardState { return guardState(this.row(), now); }
  /** Idempotent: the same shed level, reason and until keeps the stored set_at. Throws invalid_input. */
  set(input: unknown, now: number): GuardState {
    const value = parseGuardInput(input, now);
    if (value.level === 'normal') {
      this.sql.exec('DELETE FROM ops_guard WHERE id=1');
      return NORMAL;
    }
    const old = this.row();
    if (old && old.level === 'shed' && old.reason === value.reason && old.until === value.until) return guardState(old, now);
    this.sql.exec(`INSERT INTO ops_guard(id,level,reason,until,set_at) VALUES(1,'shed',?,?,?)
      ON CONFLICT(id) DO UPDATE SET level=excluded.level,reason=excluded.reason,until=excluded.until,set_at=excluded.set_at`, value.reason, value.until, now);
    return this.read(now);
  }
  lastRun(job: DeferrableJob): number | null {
    return this.sql.exec<{ at: number }>('SELECT at FROM ops_job_runs WHERE job=?', job).toArray()[0]?.at ?? null;
  }
  /** Defers a job only while shed and only if it ran within DEFER_BOUND_MS; never moves any clock. */
  deferral(now: number): OpsDeferral {
    const shed = this.read(now).level === 'shed';
    return {
      defers: job => { const last = shed ? this.lastRun(job) : null; return last !== null && now - last < DEFER_BOUND_MS; },
      ran: job => { this.sql.exec('INSERT INTO ops_job_runs(job,at) VALUES(?,?) ON CONFLICT(job) DO UPDATE SET at=excluded.at', job, Date.now()); },
    };
  }
}
