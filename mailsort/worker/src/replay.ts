/**
 * The replay evaluation (../../docs/design.md §5.1): before Gmail labelling goes live, the mails the owner answered in
 * the review queue are decided again by today's pipeline and compared with the owner's answers.
 *
 * StartReplayEvaluation (startReplay) takes every review item the owner resolved in the last REPLAY_WINDOW_MS with a
 * label or "none of them", at most REPLAY_ITEMS_MAX, newest first, and writes one row per mail with the owner's
 * answer, next to the job's own row (message_id ''), in the one table `replay`. Each alarm pass then decides a few of
 * them (replayStep), after the drain and the embeddings, with the subrequests the pass has left: it re-reads the mail
 * (metadata and body, as the drain does, with the read grant), gathers the same evidence and asks the same two views
 * (judge.ts), as of the mail's original decision (the sender history, the examples and the trusted domains of then:
 * never what the owner's answer to that mail, or a later one, taught), and records what the decision would have been,
 * and whether the review queue's quota of that day would have shown it. A model outage backs the mail off as the drain
 * does (and stops calling the model for the pass); a refused answer gets a few tries; then the mail counts as
 * uncertain (`model_unavailable`). It writes nothing to Gmail, makes
 * no verdict, example, decision, review item or flow count: only its own rows and the day's usage (Gmail calls,
 * neurons), which every model call counts against the owner's budget.
 *
 * It never starves the live pipeline: it runs last in a pass, only while the day's neurons are below
 * REPLAY_NEURON_SHARE of the owner's budget and Workers AI's quota lasts (else the next UTC day), never while Home's
 * guard sheds (pipeline.ts), always with the full Clef (what live decisions use). Its rows are pruned REPLAY_KEPT_MS
 * after the start (store.ts prune). GetReplayEvaluation answers counts and label pairs only (replaySummary).
 */
import { AiError, AiQuotaError } from './ai.ts';
import { joinsReview, type Decision } from './decide.ts';
import type { AiRunner } from './env.ts';
import { GoogleError, type GmailClient } from './gmail.ts';
import { timeId } from './ids.ts';
import { gather, judge, modelUnavailable, retryDelay, reviewQuotaOn, type Judgement } from './judge.ts';
import { BAD_ANSWER_ATTEMPTS_MAX, CLEF, DAY, MAIL_ATTEMPTS_MAX, REPLAY_BATCH, REPLAY_ITEMS_MAX, REPLAY_NEURON_SHARE, REPLAY_SUBREQUESTS, REPLAY_WINDOW_MS } from './limits.ts';
import { readMessage } from './mime.ts';
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
}

/**
 * Starts a replay evaluation at `now`, replacing the previous one (and its rows): answers the new job's ID. Run inside
 * a transaction (the API's, with its request log entry).
 */
export function startReplay(store: Store, now: number): string {
  store.run(`DELETE FROM replay`);
  const jobId = timeId(now);
  const items = store.all<{ message_id: string; resolved_label: string | null; as_of: number }>(
    `SELECT r.message_id, r.resolved_label, coalesce(d.decided_at, r.receive_time) AS as_of FROM review r LEFT JOIN decisions d ON d.message_id = r.message_id
     WHERE r.state IN ('confirmed', 'corrected') AND r.resolve_time >= ? ORDER BY r.resolve_time DESC, r.id DESC LIMIT ?`,
    now - REPLAY_WINDOW_MS,
    // A mail may have been asked twice (an older suggestion and its audit): its newest answer counts.
    2 * REPLAY_ITEMS_MAX,
  );
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.message_id) || seen.size >= REPLAY_ITEMS_MAX) continue;
    seen.add(item.message_id);
    store.run(
      `INSERT INTO replay (job_id, message_id, state, owner_label, as_of, create_time) VALUES (?, ?, 'pending', ?, ?, ?)`,
      jobId,
      item.message_id,
      item.resolved_label ?? '',
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

function finish(store: Store, row: ReplayRow, state: 'evaluated' | 'skipped', now: number, decision: Decision | null): void {
  let shown = 0;
  if (decision?.kind === 'unsure') {
    // The quota of the mail's own day, against the mails of this replay shown on that day so far (rows are decided in
    // the order of their days, so each day's mails compete as they arrived; one backed off goes after the rest).
    const dayStart = Math.floor(row.as_of / DAY) * DAY;
    const before = store.count(`SELECT count(*) AS n FROM replay WHERE job_id = ? AND shown = 1 AND as_of >= ? AND as_of < ?`, row.job_id, dayStart, dayStart + DAY);
    shown = joinsReview(decision, before, reviewQuotaOn(store, row.as_of)) ? 1 : 0;
  }
  const verdict = decision === null ? { outcome: null, label: null, reason: '' } : outcomeOf(decision);
  store.run(
    `UPDATE replay SET state = ?, outcome = ?, label = ?, reason = ?, shown = ?, done_time = ? WHERE job_id = ? AND message_id = ?`,
    state,
    verdict.outcome,
    verdict.label,
    verdict.reason,
    shown,
    now,
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
    if (!deps.budget.has(REPLAY_SUBREQUESTS)) return true;
    // The live pipeline keeps the rest of the day's budget: the replay waits for the next UTC day past its share.
    const usage = store.usage(utcDay(deps.now()));
    if (usage.quota_exhausted === 1 || usage.neurons >= REPLAY_NEURON_SHARE * deps.settings.dailyNeuronBudget) return false;
    let read;
    try {
      read = readMessage((await deps.gmail.message(row.message_id)).message);
    } catch (error) {
      if (error instanceof GoogleError && (error.kind === 'rate' || error.kind === 'auth' || error.kind === 'unavailable')) throw error;
      read = null;
    }
    if (read === null) {
      deps.transact(() => { finish(store, row, 'skipped', deps.now(), null); });
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
    const { decision } = judgement;
    deps.transact(() => { finish(store, row, 'evaluated', deps.now(), decision); });
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
}

/** The latest replay's summary (counts and label IDs only), or null when there is none. */
export function replaySummary(store: Store): ReplaySummary | null {
  const job = store.one<ReplayRow>(`SELECT * FROM replay WHERE message_id = ''`);
  if (job === undefined) return null;
  const counts = store.one<Record<string, number | null>>(
    `SELECT count(*) AS total, sum(state = 'evaluated') AS evaluated, sum(state = 'skipped') AS skipped,
       sum(outcome = 'label') AS auto, sum(outcome = 'label' AND label = owner_label) AS auto_match,
       sum(outcome = 'none') AS none, sum(outcome = 'none' AND owner_label = '') AS none_match,
       sum(outcome = 'unsure') AS unsure, sum(outcome = 'unsure' AND shown = 1) AS shown
     FROM replay WHERE job_id = ? AND message_id != ''`,
    job.job_id,
  ) ?? {};
  const mismatches = store.all<{ decided: string; owner: string; n: number }>(
    `SELECT CASE outcome WHEN 'label' THEN label ELSE '' END AS decided, owner_label AS owner, count(*) AS n FROM replay
     WHERE job_id = ? AND message_id != '' AND state = 'evaluated' AND ((outcome = 'label' AND label != owner_label) OR (outcome = 'none' AND owner_label != ''))
     GROUP BY decided, owner ORDER BY n DESC, decided, owner`,
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
  };
}
