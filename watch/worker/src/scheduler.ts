/**
 * One alarm of WatchState (../../docs/design.md §4, §6): the due watches checked within the alarm's budgets, then the
 * outbox, the bounds and the next alarm. WatchState arms the next one itself (setAlarm, no cron) and re-arms after an
 * error; every owner API call re-arms one when none is set.
 *
 * Budgets of one alarm (Workers Free: 50 external requests per invocation, 30 s of CPU; DO alarms may run 15 minutes):
 * - at most ALARM_FETCH_BUDGET external requests; a check starts only with REQUESTS_PER_CHECK left;
 * - at most ALARM_BYTES_BUDGET body bytes (the parse is the CPU); a check starts only with FETCH_MAX_BYTES left;
 * - at most ALARM_WALL_BUDGET_MS of wall time; a check starts only ALARM_START_MARGIN_MS before it;
 * - ALARM_CONCURRENCY hosts at a time, one request at a time per host (a lane per host; the browser is one lane; a
 *   redirect to another lane's host waits for that host's lock and spacing, obtain.ts).
 * Each check is stamped with the time it starts (`deps.now()`), not the alarm's: a pass may last minutes, and the
 * host's spacing, the URL's 15 minutes and the confirmation fetch count from the real request. What is left stays
 * due: the next alarm runs a second later with fresh budgets. A check that throws is recorded as INTERNAL_ERROR
 * (pipeline.ts recordInternalError). Afterwards the bounds of the watches whose checks may have added rows are kept
 * (store.ts pruneWatches, a few hundred rows read each), and the global ones at most hourly (every watch once a day).
 */
import { deliver, type NotificationSink } from './notify.ts';
import { utcDay } from './etiquette.ts';
import { ALARM_BYTES_BUDGET, ALARM_CONCURRENCY, FETCH_MAX_BYTES, ALARM_DUE_MAX, ALARM_FETCH_BUDGET, ALARM_IDLE_MS, ALARM_START_MARGIN_MS, ALARM_WALL_BUDGET_MS, WAKE_MS } from './limits.ts';
import { REQUESTS_PER_CHECK, type Budget } from './obtain.ts';
import { recordInternalError, runCheck, storedConfig, type CheckDeps, type CheckOutcome } from './pipeline.ts';
import type { WatchRow } from './store.ts';

export interface AlarmDeps extends CheckDeps {
  /** Monotonic milliseconds for the wall budget (performance.now in the Worker). */
  readonly elapsed: () => number;
  /** Where the outbox goes (null in v1: it only fills). */
  readonly sink: NotificationSink | null;
}

/** An error as a short code for a log line (never a message that could carry data). */
export function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : error instanceof Error ? error.name : 'error';
}

export interface AlarmResult {
  /** When the next alarm should run. */
  readonly next: number;
  readonly outcomes: Readonly<Partial<Record<CheckOutcome | 'error', number>>>;
  /** External requests made. */
  readonly requests: number;
  /** Due watches left for the next alarm (a budget ran out). */
  readonly left: number;
}

/** The lane of a watch: its host, or the browser for browser watches (one render at a time). */
function laneOf(row: WatchRow): string {
  try {
    return storedConfig(row).fetcher === 'browser' ? ':browser' : row.host;
  } catch {
    return row.host;
  }
}

/** The due watches at `now`, checked lane by lane. */
export async function runAlarm(deps: AlarmDeps, now: number): Promise<AlarmResult> {
  const start = deps.elapsed();
  const budget: Budget = { requests: ALARM_FETCH_BUDGET, used: 0, bytes: 0 };
  const due = deps.store.dueWatches(now, ALARM_DUE_MAX);
  const lanes = new Map<string, WatchRow[]>();
  for (const row of due) {
    const lane = laneOf(row);
    lanes.set(lane, [...(lanes.get(lane) ?? []), row]);
  }
  const outcomes: Partial<Record<CheckOutcome | 'error', number>> = {};
  let left = 0;
  const queue = [...lanes.values()];
  // Checks in flight hold REQUESTS_PER_CHECK each, so concurrent lanes never overrun the budget together. A lane that
  // finds the budget held by others waits for one of them; it gives up only when nothing is in flight.
  const inFlight = new Set<Promise<void>>();
  const timeLeft = () => deps.elapsed() - start + ALARM_START_MARGIN_MS < ALARM_WALL_BUDGET_MS;
  const budgetLeft = () =>
    budget.requests - inFlight.size * REQUESTS_PER_CHECK >= REQUESTS_PER_CHECK && budget.bytes + (inFlight.size + 1) * FETCH_MAX_BYTES <= ALARM_BYTES_BUDGET;
  const canStart = async (): Promise<boolean> => {
    while (timeLeft() && !budgetLeft() && inFlight.size > 0) await Promise.race(inFlight);
    return timeLeft() && budgetLeft();
  };

  // The watches whose checks may have added a snapshot or a change: only their bounds can have grown.
  const grown = new Set<string>();
  const check = async (row: WatchRow) => {
    const at = deps.now();
    try {
      const outcome = await runCheck(deps, row.id, at, budget);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if (outcome === 'changed' || outcome === 'unchanged') grown.add(row.id);
    } catch (error) {
      // A bug in one watch's check must not stop the others: it counts as a failure of its own and waits at least the
      // URL's 15 minutes (its request was recorded); only a code is logged.
      outcomes.error = (outcomes.error ?? 0) + 1;
      console.log(JSON.stringify({ event: 'check_failed', watch: row.id, code: errorCode(error) }));
      recordInternalError(deps, row.id, deps.now());
    }
  };
  const worker = async () => {
    for (let lane = queue.shift(); lane !== undefined; lane = queue.shift()) {
      for (const row of lane) {
        if (!(await canStart())) {
          left += 1;
          continue;
        }
        const running = check(row);
        inFlight.add(running);
        try {
          await running;
        } finally {
          inFlight.delete(running);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ALARM_CONCURRENCY, queue.length) }, worker));

  deps.store.addLedger(utcDay(now), budget.used);
  await deliver(deps.store, deps.sink, now);
  deps.store.pruneWatches(grown);
  deps.store.pruneGlobal(now);
  deps.store.setMeta('last_alarm_at', String(now));

  const nextDue = deps.store.nextDue();
  let next = nextDue ?? now + ALARM_IDLE_MS;
  next = Math.min(Math.max(next, now + WAKE_MS), now + ALARM_IDLE_MS);
  return { next, outcomes, requests: budget.used, left };
}

