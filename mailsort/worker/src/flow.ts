/**
 * The flow counters (../../docs/design.md §10): how many mails each pipeline stage handled and what became of them,
 * per UTC day and label, for 概览's diagram (GetMailFlow). Counters only, never content.
 *
 * Each counter changes in the same transaction as the row it counts: a decision (pipeline.ts decideMail), a skip, a
 * deferral, a write that failed and left its mail a suggestion (writes.ts fail), a correction and its withdrawal
 * (feedback.ts). A decision's counters stay on the UTC day it was decided, so a later correction adds to that day.
 * Kept FLOW_KEPT_DAYS (store.ts prune); a day has a few hundred rows at most (stages x outcomes x labels).
 */
import { DAY, FLOW_COUNTS_MAX } from './limits.ts';
import { utcDay, type Store } from './store.ts';

export type FlowStage = 'skipped' | 'rule' | 'neighbours' | 'clef' | 'clef-flash' | 'deferred' | 'no_model';

export type FlowOutcome =
  | 'archived'
  | 'kept_in_inbox'
  | 'suggested'
  | 'unsure'
  | 'corrected'
  | 'not_inbox'
  | 'thread_sorted'
  | 'before_install'
  | 'unreadable'
  | 'deferred';

const SKIP_OUTCOMES: ReadonlySet<string> = new Set(['not_inbox', 'thread_sorted', 'before_install', 'unreadable']);

/** A decision's decider as its stage: the rule, the neighbours or a model; anything else had no model answer. */
export function stageOf(decider: string): FlowStage {
  return decider === 'rule' || decider === 'neighbours' || decider === 'clef' || decider === 'clef-flash' ? decider : 'no_model';
}

/** A skip reason as its outcome (pipeline.ts recordSkip's reasons). */
export function skipOutcome(reason: string): FlowOutcome {
  return SKIP_OUTCOMES.has(reason) ? (reason as FlowOutcome) : 'unreadable';
}

/**
 * Adds `delta` (negative to take back) to one counter of the UTC day of `at`. Never below zero. Run inside the
 * transaction that writes what it counts.
 */
export function countFlow(store: Store, at: number, stage: FlowStage, outcome: FlowOutcome, label: string | null, delta = 1): void {
  if (delta === 0) return;
  store.run(
    `INSERT INTO flow (day, stage, outcome, label, n) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (day, stage, outcome, label) DO UPDATE SET n = max(0, flow.n + ?)`,
    utcDay(at),
    stage,
    outcome,
    label ?? '',
    Math.max(0, delta),
    delta,
  );
}

/** The ranges GetMailFlow answers (MailFlow.name), in UTC days, today included. */
export const FLOW_RANGES: Readonly<Record<string, number>> = { today: 1, 'last-7-days': 7, 'last-30-days': 30 };

export interface FlowCount {
  readonly stage: FlowStage;
  readonly outcome: FlowOutcome;
  readonly label: string;
  readonly n: number;
}

/** The counters of the `days` UTC days up to the one of `now`, summed per stage, outcome and label. */
export function readFlow(store: Store, days: number, now: number): { start: number; end: number; counts: FlowCount[] } {
  const end = Math.floor(now / DAY) * DAY + DAY;
  const start = end - days * DAY;
  const counts = store.all<{ stage: FlowStage; outcome: FlowOutcome; label: string; n: number }>(
    `SELECT stage, outcome, label, sum(n) AS n FROM flow WHERE day >= ? AND day < ?
     GROUP BY stage, outcome, label HAVING sum(n) > 0 ORDER BY stage, outcome, label LIMIT ?`,
    utcDay(start),
    utcDay(end),
    FLOW_COUNTS_MAX,
  );
  return { start, end, counts };
}
