/**
 * The daily end-to-end canary (docs/design.md §5.4): pure transitions of one run, `now` passed in.
 * HomeState makes the calls (at most one per phase per tick) and persists the record.
 */
import type { CanaryDelivery, CanaryResult, OpsStatus, StartCanaryResult } from '../../../contracts/ops-v1/ops-v1.ts';
import type { AppErrorCode, CanaryKind, CanaryOutcome, CanaryPhase, CanaryRun, CanaryStage } from './api-types.ts';
import type { OpsCall } from './ops-client.ts';
import { HOUR_MS, iso, isoOrNull, parseTimestamp, utcDay } from './time.ts';

/** Start phase: created + 2 h; after queuing: queued + 2 h. */
export const CANARY_DEADLINE_MS = 2 * HOUR_MS;
/** Statuses older than this do not count for the start preconditions. */
export const CANARY_STATUS_MAX_AGE_MS = HOUR_MS;
/** Canary runs are kept this long. */
export const CANARY_RETENTION_MS = 60 * 24 * HOUR_MS;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type StartWait = 'paused' | 'unavailable' | 'error' | 'no_status';

/** One run as HomeState stores it (epoch milliseconds). */
export interface CanaryRecord {
  readonly run_id: string;
  readonly kind: CanaryKind;
  readonly day: string;
  readonly phase: CanaryPhase;
  readonly outcome: CanaryOutcome | null;
  readonly stage: CanaryStage | null;
  readonly code: string | null;
  readonly event_id: string | null;
  readonly created_at: number;
  readonly queued_at: number | null;
  readonly delivered_at: number | null;
  readonly completed_at: number | null;
  readonly finished_at: number | null;
  readonly deadline_at: number;
  readonly delivery: {
    readonly state: CanaryDelivery['state'] | null;
    readonly attempts: number;
    readonly last_http_status: number | null;
    readonly error_code: string | null;
  };
  readonly consumer: {
    readonly state: CanaryResult['state'] | null;
    readonly waiting_code: string | null;
    readonly error_code: string | null;
  };
  readonly polls: number;
  /** Why the start is still waiting (last answer), for the deadline verdict. */
  readonly start_wait: StartWait | null;
  readonly start_code: string | null;
  /** Error code of the last failed delivery/result call, null after an answer. */
  readonly last_call_error: AppErrorCode | null;
}

function compact(ms: number): string {
  return iso(ms).slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

/** `canary-YYYY-MM-DD` of the UTC day. */
export function scheduledRunId(now: number): string {
  return `canary-${utcDay(now)}`;
}

/** `canary-manual-YYYYMMDDTHHMMSSZ` (UTC). */
export function manualRunId(now: number): string {
  return `canary-manual-${compact(now)}`;
}

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

export function newRun(runId: string, kind: CanaryKind, now: number): CanaryRecord {
  return {
    run_id: runId,
    kind,
    day: utcDay(now),
    phase: 'starting',
    outcome: null,
    stage: null,
    code: null,
    event_id: null,
    created_at: now,
    queued_at: null,
    delivered_at: null,
    completed_at: null,
    finished_at: null,
    deadline_at: now + CANARY_DEADLINE_MS,
    delivery: { state: null, attempts: 0, last_http_status: null, error_code: null },
    consumer: { state: null, waiting_code: null, error_code: null },
    polls: 0,
    start_wait: null,
    start_code: null,
    last_call_error: null,
  };
}

export function finish(run: CanaryRecord, outcome: CanaryOutcome, stage: CanaryStage | null, code: string | null, now: number): CanaryRecord {
  return { ...run, phase: 'done', outcome, stage, code, finished_at: now };
}

export interface StatusAt {
  readonly status: OpsStatus | null;
  readonly status_at: number | null;
}

export type Precondition = { readonly kind: 'call' } | { readonly kind: 'wait' } | { readonly kind: 'skip'; readonly code: string };

/** Capabilities from the last successful statuses at most an hour old (§5.4). */
export function startPrecondition(mailHero: StatusAt, todofy: StatusAt, now: number): Precondition {
  const fresh = (s: StatusAt): OpsStatus | null =>
    s.status !== null && s.status_at !== null && now - s.status_at <= CANARY_STATUS_MAX_AGE_MS ? s.status : null;
  const mh = fresh(mailHero);
  const td = fresh(todofy);
  if (mh !== null && !mh.capabilities.includes('canary_producer')) return { kind: 'skip', code: 'canary_producer_missing' };
  // Never start a canary that a consumer might treat as real mail.
  if (td !== null && !td.capabilities.includes('canary_consumer')) return { kind: 'skip', code: 'canary_consumer_missing' };
  if (mh === null || td === null) return { kind: 'wait' };
  return { kind: 'call' };
}

export function waitForStatus(run: CanaryRecord): CanaryRecord {
  return { ...run, start_wait: 'no_status', start_code: 'status_unavailable' };
}

export function applyStart(run: CanaryRecord, call: OpsCall<StartCanaryResult>, now: number): CanaryRecord {
  const polled = { ...run, polls: run.polls + 1 };
  if (!call.ok) {
    if (call.code === 'invalid_input') return finish(polled, 'failed', 'start', 'invalid_input', now);
    return { ...polled, start_wait: 'error', start_code: call.code };
  }
  const result = call.value;
  if (result.state === 'queued') {
    return {
      ...polled,
      phase: 'delivering',
      event_id: result.event_id,
      queued_at: now,
      deadline_at: now + CANARY_DEADLINE_MS,
      start_wait: null,
      start_code: null,
    };
  }
  // paused / unavailable wrote nothing and may be retried with the same run_id.
  return { ...polled, start_wait: result.state, start_code: result.reason };
}

export function applyDelivery(run: CanaryRecord, call: OpsCall<CanaryDelivery>, now: number): CanaryRecord {
  const polled = { ...run, polls: run.polls + 1 };
  if (!call.ok) return { ...polled, last_call_error: call.code };
  const d = call.value;
  const loose = d as { readonly state: string; readonly last_http_status?: number; readonly error_code?: string };
  const delivery = {
    state: d.state,
    attempts: d.attempts,
    last_http_status: loose.last_http_status ?? run.delivery.last_http_status,
    error_code: loose.error_code ?? null,
  };
  const next: CanaryRecord = { ...polled, delivery, last_call_error: null };
  switch (d.state) {
    case 'delivered':
      return { ...next, phase: 'consuming', delivered_at: parseTimestamp(d.delivered_at) ?? now };
    case 'failed':
      return finish(next, 'failed', 'delivery', d.error_code, now);
    case 'unknown':
      return finish(next, 'failed', 'delivery', 'unknown_event', now);
    case 'pending':
    case 'paused':
      return next;
  }
}

export function applyResult(run: CanaryRecord, call: OpsCall<CanaryResult>, now: number): CanaryRecord {
  const polled = { ...run, polls: run.polls + 1 };
  if (!call.ok) return { ...polled, last_call_error: call.code };
  const r = call.value;
  const consumer = {
    state: r.state,
    waiting_code: r.state === 'processing' ? (r.waiting_code ?? null) : null,
    error_code: r.state === 'failed' ? r.error_code : null,
  };
  const next: CanaryRecord = { ...polled, consumer, last_call_error: null };
  switch (r.state) {
    case 'ok':
      return finish({ ...next, completed_at: parseTimestamp(r.completed_at) ?? now }, 'ok', null, null, now);
    case 'failed':
      return finish({ ...next, completed_at: parseTimestamp(r.completed_at) ?? now }, 'failed', 'consumer', r.error_code, now);
    case 'not_seen':
    case 'processing':
      return next;
  }
}

/** The verdict of a run still active at its deadline (§5.4); the run unchanged before it. */
export function applyDeadline(run: CanaryRecord, now: number): CanaryRecord {
  if (run.phase === 'done' || now < run.deadline_at) return run;
  switch (run.phase) {
    case 'starting':
      if (run.start_wait === 'paused' || run.start_wait === 'unavailable') return finish(run, 'skipped', 'start', run.start_code, now);
      if (run.start_wait === 'no_status') return finish(run, 'skipped', 'start', 'status_unavailable', now);
      return finish(run, 'failed', 'start', run.start_code ?? 'timeout', now);
    case 'delivering':
      if (run.delivery.state === 'paused') return finish(run, 'skipped', 'delivery', run.delivery.error_code ?? 'paused', now);
      if (run.delivery.state === null) return finish(run, 'failed', 'delivery', 'unreachable', now);
      return finish(run, 'failed', 'delivery', 'timeout', now);
    case 'consuming':
      if (run.consumer.state === 'processing' && run.consumer.waiting_code !== null) {
        return finish(run, 'skipped', 'consumer', run.consumer.waiting_code, now);
      }
      if (run.consumer.state === 'processing') return finish(run, 'failed', 'consumer', 'timeout', now);
      if (run.consumer.state === 'not_seen') return finish(run, 'failed', 'consumer', 'not_seen', now);
      return finish(run, 'failed', 'consumer', 'unreachable', now);
  }
}

/** Next scheduled start: today at hour_utc if not reached and no scheduled run today, else as §5.4. */
export function nextScheduledAt(now: number, hourUtc: number, scheduledToday: boolean): number {
  const dayStart = Math.floor(now / (24 * HOUR_MS)) * 24 * HOUR_MS;
  const todayAt = dayStart + hourUtc * HOUR_MS;
  if (scheduledToday) return todayAt + 24 * HOUR_MS;
  if (now < todayAt) return todayAt;
  // Due: the next cron tick (every 30 minutes) creates it.
  return Math.ceil(now / (HOUR_MS / 2)) * (HOUR_MS / 2);
}

export function runView(run: CanaryRecord): CanaryRun {
  return {
    run_id: run.run_id,
    kind: run.kind,
    day: run.day,
    phase: run.phase,
    outcome: run.outcome,
    stage: run.stage,
    code: run.code,
    event_id: run.event_id,
    created_at: iso(run.created_at),
    queued_at: isoOrNull(run.queued_at),
    delivered_at: isoOrNull(run.delivered_at),
    completed_at: isoOrNull(run.completed_at),
    finished_at: isoOrNull(run.finished_at),
    deadline_at: iso(run.deadline_at),
    delivery: { ...run.delivery },
    consumer: { ...run.consumer },
    polls: run.polls,
  };
}
