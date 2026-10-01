/**
 * Quota guardrails (docs/design.md §5.3): pure decisions, `now` passed in. Shed at 80 % actual usage
 * of any trigger resource, hold while at least 70 % on the same UTC day, clear below 70 % or on a new
 * UTC day; never shed without fresh usage; owner overrides win while they last. Monthly R2 operations
 * do not reset at midnight, so a snapshot from the end of the previous day of the same month still
 * counts for them (daily resources never carry over).
 */
import type { GuardLevel, GuardState, SetGuardInput } from '@ziyixi/proto/ops/v1/ops_wire';
import { OPS_LIMITS } from '../../../contracts/ops-v1/ops-v1.ts';
import { GUARD_CLEAR_PERCENT, GUARD_SHED_PERCENT, type AppErrorCode, type GuardSource, type QuotaRow } from './api-types.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, iso, nextUtcMidnight, utcDay, utcMonthStart } from './time.ts';

/** Usage older than this (or of another UTC day) is not fresh. */
export const USAGE_FRESH_MS = 90 * MINUTE_MS;
/**
 * An automatic shed lasts until the next UTC midnight plus this margin (renewed while still over). A
 * shed that continues past midnight (monthly R2 operations) is renewed by the 00:00 tick's setGuard;
 * the margin covers that call failing or the tick running late, so the 00:30 tick's retry still lands
 * before the apps' stored `until` (ops-v1: shed only while now < until). Far inside the 36 h bound.
 */
export const SHED_MARGIN_MS = 60 * MINUTE_MS;
/** An owner's forced shed lasts this long unless cleared. */
export const OWNER_SHED_MS = DAY_MS;

export interface UsageSnapshot {
  readonly fetched_at: number | null;
  readonly day: string | null;
  /** UTC month start (YYYY-MM-01) of the fetch; monthly rows carry over midnight only within it. */
  readonly month?: string | null;
  readonly rows: readonly QuotaRow[];
}

/** The automatic decision, persisted between ticks. */
export interface AutoGuard {
  readonly level: GuardLevel;
  readonly reason: string;
  /** Epoch ms; null when normal. */
  readonly until: number | null;
  /** UTC day the current shed episode started (hysteresis only holds within that day). */
  readonly entered_day: string | null;
  readonly entered_at: number | null;
}

export interface GuardOverrideDoc {
  readonly level: GuardLevel;
  readonly until: number;
  readonly set_at: number;
}

export interface DesiredGuard {
  readonly level: GuardLevel;
  readonly reason: string;
  readonly until: number | null;
  readonly source: GuardSource;
}

function recent(usage: UsageSnapshot | null, now: number): usage is UsageSnapshot & { readonly fetched_at: number } {
  return usage !== null && usage.fetched_at !== null && now - usage.fetched_at <= USAGE_FRESH_MS && now >= usage.fetched_at - 5 * MINUTE_MS;
}

export function usageFresh(usage: UsageSnapshot | null, now: number): boolean {
  return recent(usage, now) && usage.day === utcDay(now);
}

/**
 * The trigger rows the automatic rule may use at `now`: all rows of fresh usage; right after midnight,
 * the monthly rows of a snapshot from the previous day of the same month that is still within the
 * freshness window (a GraphQL outage at the day change must not lift a monthly R2 shed); else null.
 */
export function usableTriggerRows(usage: UsageSnapshot | null, now: number): readonly QuotaRow[] | null {
  if (usage === null) return null;
  if (usageFresh(usage, now)) return usage.rows;
  if (recent(usage, now) && usage.month === utcMonthStart(now)) return usage.rows.filter((row) => row.period === 'monthly');
  return null;
}

/**
 * Whether `row` uses at least `percent` % of its allowance. Compared on the measured value, never on the
 * displayed `percent` (rounded to 0.1): 79.95 % shows as 80 but is below the 80 % threshold.
 */
export function reachesPercent(row: Pick<QuotaRow, 'used' | 'limit'>, percent: number): boolean {
  return row.used !== null && row.limit > 0 && row.used * 100 >= row.limit * percent;
}

/** The trigger row with the highest share of its allowance (ties: the first in QUOTA_RESOURCES order). */
export function highestTrigger(rows: readonly QuotaRow[]): QuotaRow | null {
  let best: QuotaRow | null = null;
  for (const row of rows) {
    if (!row.guard_trigger || row.used === null || !(row.limit > 0)) continue;
    if (best === null || row.used / row.limit > (best.used ?? 0) / best.limit) best = row;
  }
  return best;
}

export function shedUntil(now: number): number {
  return nextUtcMidnight(now) + SHED_MARGIN_MS;
}

export const AUTO_NORMAL: AutoGuard = { level: 'normal', reason: 'quota_normal', until: null, entered_day: null, entered_at: null };
/** Normal because there is no usable usage (no token, or GraphQL failing): nothing is known, nothing is shed. */
export const AUTO_UNKNOWN: AutoGuard = { ...AUTO_NORMAL, reason: 'usage_unknown' };

/** One evaluation of the automatic rule (§5.3 steps 2–3). */
export function evaluateAuto(now: number, usage: UsageSnapshot | null, previous: AutoGuard | null): AutoGuard {
  const today = utcDay(now);
  const rows = usableTriggerRows(usage, now);
  if (rows === null) {
    // No usable data: keep an existing shed until it lapses; never enter shed without data.
    if (previous?.level === 'shed' && previous.until !== null && now < previous.until) return previous;
    return AUTO_UNKNOWN;
  }
  const top = highestTrigger(rows);
  const sameEpisode = previous?.level === 'shed' && previous.entered_day === today;
  if (sameEpisode && top !== null && reachesPercent(top, GUARD_CLEAR_PERCENT)) {
    return { ...previous, until: shedUntil(now) };
  }
  if (top !== null && reachesPercent(top, GUARD_SHED_PERCENT)) {
    return { level: 'shed', reason: `quota_${top.id}`, until: shedUntil(now), entered_day: today, entered_at: now };
  }
  return AUTO_NORMAL;
}

/** The owner override still in force at `now`, or null (an expired one is dropped). */
export function activeOverride(override: GuardOverrideDoc | null, now: number): GuardOverrideDoc | null {
  return override !== null && now < override.until ? override : null;
}

/** What both apps should have now (§5.3 step 1 over the automatic decision). */
export function desiredGuard(now: number, auto: AutoGuard | null, override: GuardOverrideDoc | null): DesiredGuard {
  const owner = activeOverride(override, now);
  if (owner?.level === 'shed') return { level: 'shed', reason: 'owner_shed', until: owner.until, source: 'owner' };
  if (owner?.level === 'normal') return { level: 'normal', reason: 'owner_clear', until: null, source: 'owner' };
  if (auto === null) return { level: 'normal', reason: 'quota_normal', until: null, source: 'none' };
  if (auto.level === 'shed' && auto.until !== null && now < auto.until) {
    return { level: 'shed', reason: auto.reason, until: auto.until, source: 'auto' };
  }
  return { level: 'normal', reason: auto.level === 'normal' ? auto.reason : 'quota_normal', until: null, source: 'auto' };
}

/** The owner's override for `level` set at `now`: shed for 24 h, or clear until the next UTC midnight. */
export function ownerOverride(level: GuardLevel, now: number): GuardOverrideDoc {
  return { level, until: level === 'shed' ? now + OWNER_SHED_MS : nextUtcMidnight(now), set_at: now };
}

export function guardInput(desired: DesiredGuard, now: number): SetGuardInput {
  if (desired.level === 'shed' && desired.until !== null) {
    // The contract refuses an until more than 36 h ahead; every rule here stays far inside it.
    const until = Math.min(desired.until, now + OPS_LIMITS.guardMaxAheadSeconds * 1000 - HOUR_MS);
    return { level: 'shed', reason: desired.reason, until: iso(until) };
  }
  return { level: 'normal', reason: desired.reason, until: null };
}

/** What the dashboard last asked one app for and got back (table guard_applied). */
export interface AppliedGuard {
  /** Input of the last successful call. */
  readonly input: SetGuardInput | null;
  readonly state: GuardState | null;
  readonly last_call_at: number | null;
  readonly last_error: AppErrorCode | null;
  readonly consecutive_failures: number;
}

export const NO_APPLIED: AppliedGuard = { input: null, state: null, last_call_at: null, last_error: null, consecutive_failures: 0 };

function sameUntil(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/**
 * Whether to call setGuard on an app now. `observed` is the guard in the app's status from this tick
 * (null when there is none). A steady state makes no call; normal is only sent to an app that is, or
 * was last left, shed.
 */
export function needsApply(input: SetGuardInput, applied: AppliedGuard, observed: GuardState | null): boolean {
  if (input.level === 'normal') {
    return observed?.level === 'shed' || applied.input?.level === 'shed';
  }
  const last = applied.input;
  const sameAsLast = last !== null && last.level === 'shed' && last.reason === input.reason && sameUntil(last.until, input.until);
  if (!sameAsLast || applied.consecutive_failures > 0) return true;
  // The app lost its state or it expired: re-apply.
  return observed !== null && !(observed.level === 'shed' && sameUntil(observed.until, input.until));
}

/**
 * The failure record after a tick in which no call was needed: a failure only counts while the call it
 * belongs to is still pending, so the level it was for no longer being wanted (or being in place)
 * clears it (`guard_apply_failed` then disappears).
 */
export function settled(applied: AppliedGuard): AppliedGuard {
  return applied.consecutive_failures === 0 && applied.last_error === null ? applied : { ...applied, last_error: null, consecutive_failures: 0 };
}

/** Hours left of a shed, one decimal (digest metric). */
export function hoursLeft(until: number | null, now: number): number {
  return until === null ? 0 : Math.max(0, Math.round(((until - now) / HOUR_MS) * 10) / 10);
}
