/**
 * The retired replay evaluation's stored results, read-only. The Workers AI evaluation that wrote them was removed;
 * StartReplayEvaluation refuses (api.ts) and GetReplayEvaluation answers the last stored job.
 */
import { REPLAY_CASES_MAX } from './limits.ts';
import type { Store } from './store.ts';

export interface ReplayRow extends Record<string, SqlStorageValue> {
  job_id: string;
  message_id: string;
  state: 'running' | 'succeeded' | 'pending' | 'evaluated' | 'skipped';
  /** The owner's answer: a label ID, or '' for "none of them". */
  owner_label: string | null;
  /** The original decision's time: the sender history before it, and the day whose review quota it competes for. */
  as_of: number;
  /** What the replay decided: `label`, `none` or `unsure`. */
  outcome: string | null;
  /** The decided label, or an uncertain decision's most likely label. */
  label: string | null;
  reason: string;
  shown: number;
  attempts: number;
  /** A mail backed off after a model outage waits until then. */
  not_before: number;
  create_time: number;
  done_time: number | null;
  // The decision's numbers (numbersOf; schema version 6). NULL before it was evaluated, and for a skipped mail.
  /** View 1's top option: a label ID or `none`; NULL when view 1 did not answer. */
  top_option: string | null;
  top_p: number | null;
  runner_up_p: number | null;
  /** View 2's probability of the top label; NULL when view 2 did not run. */
  view2_p: number | null;
  combined: number | null;
  suspicious: number | null;
  /** p(needs_action): never written since 2026-10-11 (the question is no longer asked), so NULL. */
  needs_action: number | null;
  /** 1: DMARC passed aligned with the From domain. Set for every mail evaluated since schema version 6. */
  authenticated: number | null;
  /** 1: the top label is a trust label. */
  trust: number | null;
}

/** One evaluated mail's decision numbers (no content): what the thresholds are calibrated with. */
export interface ReplayNumbers {
  readonly topOption: string | null;
  readonly topP: number | null;
  readonly runnerUpP: number | null;
  readonly view2P: number | null;
  readonly combined: number | null;
  readonly suspicious: number | null;
  readonly authenticated: boolean;
  readonly trust: boolean;
}

export interface ReplaySummary {
  readonly state: 'running' | 'succeeded';
  readonly createTime: number;
  readonly completeTime: number | null;
  readonly total: number;
  readonly evaluated: number;
  readonly skipped: number;
  readonly auto: number;
  readonly autoMatch: number;
  readonly none: number;
  readonly noneMatch: number;
  readonly unsure: number;
  readonly shown: number;
  /** The confident decisions that differ from the owner's answer: decided and owner label ('' for none), counted. */
  readonly mismatches: readonly { readonly decided: string; readonly owner: string; readonly count: number }[];
  /** The evaluated mails with their numbers, in the order of their original decisions, at most REPLAY_CASES_MAX. */
  readonly cases: readonly ReplayCase[];
  /** The uncertain mails per reason. */
  readonly reasonCounts: Readonly<Record<string, number>>;
}

/** One case: the owner's answer ('' for none), the replay's outcome and reason, and the decision's numbers. */
export interface ReplayCase extends ReplayNumbers {
  readonly owner: string;
  readonly outcome: 'label' | 'none' | 'unsure';
  readonly reason: string;
}

/** The latest replay's summary (counts, label IDs and each case's numbers; no content), or null when there is none. */
export function replaySummary(store: Store): ReplaySummary | null {
  const job = store.one<ReplayRow>(`SELECT * FROM replay WHERE message_id = ''`);
  if (job === undefined) return null;
  const counts = store.one<Record<string, number | null>>(
    `SELECT count(*) AS total, sum(state = 'evaluated') AS evaluated, sum(state = 'skipped') AS skipped,
       sum(outcome = 'label') AS auto, sum(outcome = 'label' AND coalesce((SELECT target_id FROM label_aliases WHERE source_id = replay.label), label) = coalesce((SELECT target_id FROM label_aliases WHERE source_id = replay.owner_label), owner_label)) AS auto_match,
       sum(outcome = 'none') AS none, sum(outcome = 'none' AND owner_label = '') AS none_match,
       sum(outcome = 'unsure') AS unsure, sum(outcome = 'unsure' AND shown = 1) AS shown
     FROM replay WHERE job_id = ? AND message_id != ''`,
    job.job_id,
  ) ?? {};
  const mismatches = store.all<{ decided: string; owner: string; n: number }>(
    `SELECT CASE outcome WHEN 'label' THEN coalesce((SELECT target_id FROM label_aliases WHERE source_id = replay.label), label) ELSE '' END AS decided, coalesce((SELECT target_id FROM label_aliases WHERE source_id = replay.owner_label), owner_label) AS owner, count(*) AS n FROM replay
     WHERE job_id = ? AND message_id != '' AND state = 'evaluated' AND ((outcome = 'label' AND coalesce((SELECT target_id FROM label_aliases WHERE source_id = replay.label), label) != coalesce((SELECT target_id FROM label_aliases WHERE source_id = replay.owner_label), owner_label)) OR (outcome = 'none' AND owner_label != ''))
     GROUP BY decided, owner ORDER BY n DESC, decided, owner`,
    job.job_id,
  );
  // `authenticated` is set for every mail evaluated since the numbers were recorded (schema version 6).
  const cases = store.all<ReplayRow>(
    `SELECT * FROM replay WHERE job_id = ? AND message_id != '' AND state = 'evaluated' AND authenticated IS NOT NULL ORDER BY as_of, message_id LIMIT ?`,
    job.job_id,
    REPLAY_CASES_MAX,
  );
  const reasons = store.all<{ reason: string; n: number }>(
    `SELECT reason, count(*) AS n FROM replay WHERE job_id = ? AND message_id != '' AND outcome = 'unsure' GROUP BY reason ORDER BY reason`,
    job.job_id,
  );
  const n = (key: string) => counts[key] ?? 0;
  return {
    state: job.state === 'succeeded' ? 'succeeded' : 'running',
    createTime: job.create_time,
    completeTime: job.done_time,
    total: n('total'),
    evaluated: n('evaluated'),
    skipped: n('skipped'),
    auto: n('auto'),
    autoMatch: n('auto_match'),
    none: n('none'),
    noneMatch: n('none_match'),
    unsure: n('unsure'),
    shown: n('shown'),
    mismatches: mismatches.map((row) => ({ decided: row.decided, owner: row.owner, count: row.n })),
    cases: cases.map((row) => ({
      owner: row.owner_label === null ? '' : store.canonicalLabelId(row.owner_label),
      outcome: row.outcome === 'label' || row.outcome === 'none' ? row.outcome : 'unsure',
      reason: row.reason,
      topOption: row.top_option === null ? null : store.canonicalLabelId(row.top_option),
      topP: row.top_p,
      runnerUpP: row.runner_up_p,
      view2P: row.view2_p,
      combined: row.combined,
      suspicious: row.suspicious,
      authenticated: row.authenticated === 1,
      trust: row.trust === 1,
    })),
    reasonCounts: Object.fromEntries(reasons.map((row) => [row.reason, row.n])),
  };
}
