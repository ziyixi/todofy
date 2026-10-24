/**
 * Read-only replay of current priority decisions the owner confirmed or corrected in Gmail or the optional review.
 * Each case uses its original decision clock and only earlier evidence, preserving the shared AI/request budgets.
 * Historical topic decisions and examples never enter the priority replay.
 */
import { AiError, AiQuotaError } from './ai.ts';
import type { Decision, View } from './decide.ts';
import type { AiRunner } from './env.ts';
import { GoogleError, type GmailClient } from './gmail.ts';
import { timeId } from './ids.ts';
import { gather, judge, modelUnavailable, retryDelay, type Judgement } from './judge.ts';
import { BAD_ANSWER_ATTEMPTS_MAX, CLEF, MAIL_ATTEMPTS_MAX, NONE, REPLAY_BATCH, REPLAY_CASES_MAX, REPLAY_ITEMS_MAX, REPLAY_SUBREQUESTS, REPLAY_WINDOW_MS } from './limits.ts';
import { readMessage } from './mime.ts';
import { PRIORITY_IDS, priorityStartedAt } from './priority.ts';
import type { Budget } from './session.ts';
import type { SettingsValue } from './settings.ts';
import { utcDay, type Store } from './store.ts';

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

/**
 * The numbers of a judgement: view 1's top option (a label ID or `none`), its probability and the next most likely
 * option's, view 2's probability of that label as it answered, the combined probability the threshold reads (view 1's
 * p(none) for a none top). Legacy suspicious/trust fields stay unset or false; authentication is read-only metadata.
 */
export function numbersOf(decision: Decision, view1: View | null, view2: View | null, authenticated: boolean): ReplayNumbers {
  if (view1 === null) return { topOption: null, topP: null, runnerUpP: null, view2P: null, combined: null, suspicious: null, authenticated, trust: false };
  const top = view1.top;
  const runnerUp = Object.entries(view1.probabilities).reduce((best, [option, p]) => (option === top ? best : Math.max(best, p)), 0);
  return {
    topOption: top,
    topP: view1.probabilities[top] ?? 0,
    runnerUpP: runnerUp,
    view2P: view2 === null || top === NONE ? null : (view2.probabilities[top] ?? 0),
    combined: decision.confidence,
    suspicious: null,
    authenticated,
    trust: false,
  };
}

/**
 * Starts a replay evaluation at `now`, replacing the previous completed evaluation (the API refuses a running one): answers
 * the new job's ID. Run inside a transaction (the API's, with its request log entry).
 */
export function startReplay(store: Store, now: number): string {
  store.run(`DELETE FROM replay`);
  const jobId = timeId(now);
  const items = store.all<{ message_id: string; resolved_label: string | null; as_of: number }>(
    `SELECT message_id, verdict_label AS resolved_label, decided_at AS as_of FROM decisions
     WHERE verdict IN ('confirmed', 'corrected') AND verdict_source IN ('review', 'gmail') AND verdict_at >= ?
       AND decided_at >= ? AND verdict_label IN ('p1', 'p2', 'p3', 'p4') ORDER BY verdict_at DESC, message_id DESC LIMIT ?`,
    Math.max(now - REPLAY_WINDOW_MS, priorityStartedAt(store)),
    priorityStartedAt(store),
    REPLAY_ITEMS_MAX,
  );
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.message_id) || seen.size >= REPLAY_ITEMS_MAX) continue;
    seen.add(item.message_id);
    store.run(
      `INSERT INTO replay (job_id, message_id, state, owner_label, as_of, create_time) VALUES (?, ?, 'pending', ?, ?, ?)`,
      jobId,
      item.message_id,
      item.resolved_label === null ? '' : store.canonicalLabelId(item.resolved_label),
      item.as_of,
      now,
    );
  }
  const empty = seen.size === 0;
  store.run(`INSERT INTO replay (job_id, message_id, state, create_time, done_time) VALUES (?, '', ?, ?, ?)`, jobId, empty ? 'succeeded' : 'running', now, empty ? now : null);
  return jobId;
}

export interface ReplayDeps {
  readonly store: Store;
  readonly gmail: GmailClient;
  readonly ai: AiRunner;
  readonly budget: Budget;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
  readonly settings: Pick<SettingsValue, 'dailyNeuronBudget'>;
}

/** The replay's verdict on one decision: its outcome, its label (or most likely one) and the reason. */
function outcomeOf(decision: Decision): { outcome: string; label: string | null; reason: string } {
  if (decision.kind === 'label') return { outcome: 'label', label: decision.label, reason: '' };
  if (decision.kind === 'none') return { outcome: 'none', label: null, reason: '' };
  return { outcome: 'unsure', label: decision.top, reason: decision.reason };
}

/** Records a mail's replay: evaluated with its judgement (and the sender's authentication), or skipped (null). */
function finish(store: Store, row: ReplayRow, now: number, evaluated: { readonly judgement: Judgement; readonly authenticated: boolean } | null): void {
  const decision = evaluated?.judgement.decision ?? null;
  const verdict = decision === null ? { outcome: null, label: null, reason: '' } : outcomeOf(decision);
  const n = evaluated === null ? null : numbersOf(evaluated.judgement.decision, evaluated.judgement.view1, evaluated.judgement.view2, evaluated.authenticated);
  store.run(
    `UPDATE replay SET state = ?, outcome = ?, label = ?, reason = ?, shown = ?, done_time = ?, top_option = ?, top_p = ?, runner_up_p = ?, view2_p = ?, combined = ?,
       suspicious = ?, authenticated = ?, trust = ? WHERE job_id = ? AND message_id = ?`,
    evaluated === null ? 'skipped' : 'evaluated',
    verdict.outcome,
    verdict.label,
    verdict.reason,
    0,
    now,
    n?.topOption ?? null,
    n?.topP ?? null,
    n?.runnerUpP ?? null,
    n?.view2P ?? null,
    n?.combined ?? null,
    n?.suspicious ?? null,
    n === null ? null : n.authenticated ? 1 : 0,
    n === null ? null : n.trust ? 1 : 0,
    row.job_id,
    row.message_id,
  );
}

/**
 * Decides up to REPLAY_BATCH waiting mails of the running replay, oldest first, while the pass's budget and the day's
 * neurons allow. Answers whether more could run now (the alarm comes back soon). Gmail refusing the grant or its rate,
 * or being unavailable, is thrown to the pass like any Google failure; a mail Gmail no longer gives is skipped.
 */
export async function replayStep(deps: ReplayDeps): Promise<boolean> {
  const { store } = deps;
  const job = store.one<{ job_id: string; state: string }>(`SELECT job_id, state FROM replay WHERE message_id = ''`);
  if (job?.state !== 'running') return false;
  for (let done = 0; done < REPLAY_BATCH; done++) {
    const row = store.one<ReplayRow>(`SELECT * FROM replay WHERE job_id = ? AND state = 'pending' AND not_before <= ? ORDER BY as_of, message_id LIMIT 1`, job.job_id, deps.now());
    if (row === undefined) {
      // Done, unless a mail backed off after an outage still waits.
      if (store.one(`SELECT 1 AS x FROM replay WHERE job_id = ? AND state = 'pending'`, job.job_id) !== undefined) return false;
      deps.transact(() => store.run(`UPDATE replay SET state = 'succeeded', done_time = ? WHERE job_id = ? AND message_id = ''`, deps.now(), job.job_id));
      return false;
    }
    if (row.as_of < priorityStartedAt(store) || row.owner_label === null || !PRIORITY_IDS.has(row.owner_label)) {
      deps.transact(() => { finish(store, row, deps.now(), null); });
      continue;
    }
    if (!deps.budget.has(REPLAY_SUBREQUESTS)) return true;
    // Past the day's budget (shared with the live pipeline, which goes first in every pass) it waits for the next UTC day.
    const usage = store.usage(utcDay(deps.now()));
    if (usage.quota_exhausted === 1 || usage.neurons >= deps.settings.dailyNeuronBudget) return false;
    let read;
    try {
      read = readMessage((await deps.gmail.message(row.message_id)).message);
    } catch (error) {
      if (error instanceof GoogleError && (error.kind === 'rate' || error.kind === 'auth' || error.kind === 'unavailable')) throw error;
      read = null;
    }
    if (read === null) {
      deps.transact(() => { finish(store, row, deps.now(), null); });
      continue;
    }
    const g = await gather(read);
    let judgement: Judgement;
    try {
      judgement = await judge({ store, ai: deps.ai, budget: deps.budget, now: deps.now, transact: deps.transact }, CLEF, g, row.as_of, row.message_id);
    } catch (error) {
      if (error instanceof AiQuotaError) {
        deps.transact(() => {
          store.setQuotaExhausted(utcDay(deps.now()));
          store.pushError('ai_quota_exhausted');
        });
        return false;
      }
      const code = error instanceof AiError ? error.code : 'ai_unexpected';
      // As the drain treats a mail: an answer this code refused is about this mail, a few tries and the replay goes on;
      // anything else is an outage, the mail backs off (about five hours in all) and the replay stops calling the model
      // this pass. Then the decision the drain would make: uncertain, model_unavailable.
      const badAnswer = code.startsWith('clef_bad');
      const attempts = row.attempts + 1;
      const now = deps.now();
      deps.transact(() => {
        store.pushError(code);
        store.run(
          `UPDATE replay SET attempts = ?, not_before = ? WHERE job_id = ? AND message_id = ?`,
          attempts,
          badAnswer ? row.not_before : now + retryDelay(attempts),
          row.job_id,
          row.message_id,
        );
      });
      if (attempts < (badAnswer ? BAD_ANSWER_ATTEMPTS_MAX : MAIL_ATTEMPTS_MAX)) {
        if (badAnswer) continue;
        return false;
      }
      judgement = modelUnavailable();
    }
    deps.transact(() => { finish(store, row, deps.now(), { judgement, authenticated: g.authenticated }); });
  }
  return store.one(`SELECT 1 AS x FROM replay WHERE job_id = ? AND state = 'pending' AND not_before <= ?`, job.job_id, deps.now()) !== undefined;
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
