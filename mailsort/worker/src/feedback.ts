/**
 * The owner's verdicts on decisions (../../docs/design.md §6): the report's corrections and the flow counters.
 *
 * Verdicts come from two places. The review queue's choices; and Gmail itself, read from the history's
 * labelAdded/labelRemoved records on mails mailsort decided: the owned labels a mail carries now are compared with what
 * mailsort did. Moving an applied mail from one owned label to another is a correction to the new one, removing the
 * label only is a correction to "none", putting it back withdraws the correction; adding an owned label to a mail
 * mailsort left (a label only recorded in shadow mode, an uncertain mail, a confident none) is a confirmation (the
 * decided label) or a correction (another). Mailsort's own writes change `current_labels` when they are made, so
 * their history records change nothing.
 *
 * Verdicts no longer make learning examples: nothing reads them. A new or withdrawn verdict deletes the mail's
 * historical example, so its summary does not outlive the verdict it was made from.
 */
import { canonicalDecision, effectiveLedgerRow, isMergeFeedback } from './label-identity.ts';
import { deleteExampleOf } from './examples.ts';
import { countFlow, stageOf } from './flow.ts';
import type { DecisionRow, Store } from './store.ts';
import { PRIORITY_IDS, priorityStartedAt } from './priority.ts';

export type VerdictSource = 'review' | 'gmail' | 'auto';

function labelsOf(row: DecisionRow): string[] {
  try {
    const value: unknown = JSON.parse(row.current_labels);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function setCurrentLabels(store: Store, messageId: string, labels: readonly string[]): void {
  store.run(`UPDATE decisions SET current_labels = ? WHERE message_id = ?`, JSON.stringify([...new Set(labels)].sort()), messageId);
}

/**
 * Records the owner's choice for a decided mail: `chosen` is a label ID or null ("none of them"). Resolves a pending
 * review item of the mail and deletes its historical example.
 */
export function setVerdict(store: Store, row: DecisionRow, chosen: string | null, source: VerdictSource, now: number): void {
  if (priorityStartedAt(store) === 0 || row.decided_at < priorityStartedAt(store) || (row.label_id !== null && !PRIORITY_IDS.has(row.label_id)) || (chosen !== null && !PRIORITY_IDS.has(chosen))) return;
  const predicted = row.label_id === null ? null : store.canonicalLabelId(row.label_id);
  const verdict = predicted === chosen ? 'confirmed' : 'corrected';
  // The flow's corrections count decisions whose label the owner changed, once each, on the day it was decided.
  countCorrection(store, row, (verdict === 'corrected' ? 1 : 0) - (row.verdict === 'corrected' ? 1 : 0));
  store.run(`UPDATE decisions SET verdict = ?, verdict_label = ?, verdict_source = ?, verdict_at = ? WHERE message_id = ?`, verdict, chosen, source, now, row.message_id);
  deleteExampleOf(store, row.message_id);
  const review = store.pendingReviewOf(row.message_id);
  if (review !== undefined) {
    // `confirmed` when the owner chose the model's most likely label, else `corrected`: both are resolved.
    const state = (review.suggested_label === null ? null : store.canonicalLabelId(review.suggested_label)) === chosen ? 'confirmed' : 'corrected';
    store.run(`UPDATE review SET state = ?, resolved_label = ?, resolve_time = ? WHERE id = ?`, state, chosen, now, review.id);
  }
}

/** Adds `delta` to the flow's corrections of a decision that had a label (an unsure one has nothing to correct). */
function countCorrection(store: Store, row: DecisionRow, delta: number): void {
  const original = store.decision(row.message_id) ?? row;
  if (original.label_id !== null && original.outcome !== 'skipped') countFlow(store, original.decided_at, stageOf(original.decider), 'corrected', original.label_id, delta);
}

/** Withdraws a verdict (the owner undid their own change in Gmail): no verdict, no historical example. */
export function withdrawVerdict(store: Store, row: DecisionRow): void {
  if (row.verdict === 'corrected') countCorrection(store, row, -1);
  store.run(`UPDATE decisions SET verdict = NULL, verdict_label = NULL, verdict_source = NULL, verdict_at = NULL WHERE message_id = ?`, row.message_id);
  deleteExampleOf(store, row.message_id);
}

/**
 * Reads the queued Gmail label changes (the `feedback` table, oldest first) into verdicts. `owned` maps a Gmail label ID
 * to the app's label ID. Answers how many changes it read.
 */
export function applyFeedback(store: Store, owned: ReadonlyMap<string, string>, now: number, limit = 200): number {
  const events = store.all<{ key: string; message_id: string; change: 'added' | 'removed'; gmail_label_id: string; seq: number }>(
    `SELECT key, message_id, change, gmail_label_id, seq FROM feedback ORDER BY seq, key LIMIT ?`,
    limit,
  );
  const touched = new Set<string>();
  for (const event of events) {
    store.run(`DELETE FROM feedback WHERE key = ?`, event.key);
    if (isMergeFeedback(store, event)) continue;
    const original = owned.get(event.gmail_label_id);
    if (original === undefined || !PRIORITY_IDS.has(original)) continue;
    const label = store.canonicalLabelId(original);
    const row = store.decision(event.message_id);
    if (!PRIORITY_IDS.has(label) || row === undefined || row.outcome === 'skipped' || (row.label_id !== null && !PRIORITY_IDS.has(row.label_id)) || row.decided_at < priorityStartedAt(store)) continue;
    const labels = new Set(labelsOf(canonicalDecision(store, row)));
    if (event.change === 'added') labels.add(label);
    else labels.delete(label);
    setCurrentLabels(store, row.message_id, [...labels]);
    touched.add(row.message_id);
  }
  for (const messageId of touched) {
    const row = store.decision(messageId);
    if (row !== undefined) judge(store, row, now);
  }
  return events.length;
}

/** The verdict Gmail's current labels say for one decided mail. */
function judge(store: Store, row: DecisionRow, now: number): void {
  const original = row;
  row = canonicalDecision(store, row);
  const labels = labelsOf(row);
  const applied = row.outcome === 'applied' ? row.label_id : null;
  // What mailsort itself left on the mail: its label while its write stands.
  const rawLedger = applied === null ? undefined : store.one<import('./store.ts').LedgerRow>(`SELECT * FROM ledger WHERE message_id = ? AND label_id = ? ORDER BY create_time DESC LIMIT 1`, row.message_id, original.label_id);
  const ledger = rawLedger === undefined ? undefined : effectiveLedgerRow(store, rawLedger);
  const standing = applied !== null && ledger !== undefined && (ledger.state === 'applied' || ledger.state === 'intended');
  const base = standing ? [applied] : [];
  const same = labels.length === base.length && labels.every((label) => base.includes(label));
  if (same) {
    if (row.verdict_source === 'gmail') withdrawVerdict(store, row);
    if (ledger !== undefined) store.run(`UPDATE ledger SET superseded = 0 WHERE id = ?`, ledger.id);
    return;
  }
  const others = labels.filter((label) => label !== applied);
  if (!standing && others.length === 0) {
    // The owner removed a label they had added themselves: nothing left to judge by.
    if (row.verdict_source === 'gmail') withdrawVerdict(store, row);
    return;
  }
  const chosen = others[0] ?? null;
  // The owner's review choice, written to Gmail in live mode, comes back from the history as a label change: the same
  // verdict, which keeps its source and time (the sender history counts it from then).
  const sameReview = row.verdict_source === 'review' && row.verdict_label === chosen;
  if (!sameReview && (row.verdict_source !== 'gmail' || row.verdict_label !== chosen)) setVerdict(store, row, chosen, 'gmail', now);
  if (standing && chosen !== applied) store.run(`UPDATE ledger SET superseded = 1 WHERE id = ?`, ledger.id);
}
