/**
 * Learning from the owner (../../docs/design.md §6), without fine-tuning: verdicts on decisions, examples and rule
 * proposals.
 *
 * Verdicts come from two places. The review queue's confirm and correct; and Gmail itself, read from the history's
 * labelAdded/labelRemoved records on mails mailsort decided: the owned labels a mail carries now are compared with what
 * mailsort did. Moving an applied mail from one owned label to another is a correction to the new one, removing the
 * label only is a correction to "none", putting it back withdraws the correction; adding an owned label to a mail
 * mailsort only suggested is a confirmation (the suggested label) or a correction (another). Mailsort's own writes
 * change `current_labels` when they are made, so their history records change nothing.
 *
 * A verdict with a label makes an example of the mail's summary (while its content is kept); a withdrawn verdict
 * deletes it. The same sender (or mailing list) corrected to the same label RULE_PROPOSAL_CORRECTIONS times proposes a
 * rule, which decides nothing until the owner approves it.
 */
import { deleteExampleOf, putExample } from './examples.ts';
import { shortId } from './ids.ts';
import { RULE_PROPOSAL_CORRECTIONS } from './limits.ts';
import type { DecisionRow, Store } from './store.ts';

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
 * Records the owner's choice for a decided mail: `chosen` is a label ID or null ("none of them"). Updates the example,
 * the rule proposals and a pending review item of the mail.
 */
export function setVerdict(store: Store, row: DecisionRow, chosen: string | null, source: VerdictSource, now: number): void {
  const predicted = row.label_id ?? null;
  const verdict = predicted === chosen ? 'confirmed' : 'corrected';
  store.run(`UPDATE decisions SET verdict = ?, verdict_label = ?, verdict_source = ?, verdict_at = ? WHERE message_id = ?`, verdict, chosen, source, now, row.message_id);
  if (chosen !== null && row.summary !== null && row.summary !== '') {
    putExample(store, row.message_id, chosen, row.summary, verdict === 'confirmed' ? 'confirmation' : 'correction', now);
  } else {
    deleteExampleOf(store, row.message_id);
  }
  if (verdict === 'corrected' && chosen !== null) proposeRule(store, row, chosen, now);
  const review = store.pendingReviewOf(row.message_id);
  if (review !== undefined) {
    const state = review.suggested_label === chosen ? 'confirmed' : 'corrected';
    store.run(`UPDATE review SET state = ?, resolved_label = ?, resolve_time = ? WHERE id = ?`, state, chosen, now, review.id);
  }
}

/** Withdraws a verdict (the owner undid their own change in Gmail): no verdict, no example, fewer proposals. */
export function withdrawVerdict(store: Store, row: DecisionRow): void {
  store.run(`UPDATE decisions SET verdict = NULL, verdict_label = NULL, verdict_source = NULL, verdict_at = NULL WHERE message_id = ?`, row.message_id);
  deleteExampleOf(store, row.message_id);
  if (row.verdict === 'corrected' && row.verdict_label !== null) retractProposal(store, row, row.verdict_label);
}

/** The rule key of a mail: its mailing list when it has one, else its sender's address. */
function ruleKey(row: Pick<DecisionRow, 'list_id' | 'sender_address'>): { kind: 'list_id' | 'sender_address'; value: string } | null {
  if (row.list_id !== null && row.list_id !== '') return { kind: 'list_id', value: row.list_id };
  if (row.sender_address !== null && row.sender_address !== '') return { kind: 'sender_address', value: row.sender_address };
  return null;
}

function corrections(store: Store, key: { kind: 'list_id' | 'sender_address'; value: string }, label: string): number {
  const column = key.kind === 'list_id' ? 'list_id' : 'sender_address';
  return store.count(`SELECT count(*) AS n FROM decisions WHERE ${column} = ? AND verdict_label = ? AND verdict = 'corrected'`, key.value, label);
}

export function proposeRule(store: Store, row: DecisionRow, label: string, now: number): void {
  const key = ruleKey(row);
  if (key === null) return;
  const count = corrections(store, key, label);
  if (count < RULE_PROPOSAL_CORRECTIONS) return;
  const existing = store.one<{ id: string; state: string }>(`SELECT id, state FROM rules WHERE kind = ? AND value = ? AND label_id = ?`, key.kind, key.value, label);
  if (existing !== undefined) {
    store.run(`UPDATE rules SET correction_count = ? WHERE id = ?`, count, existing.id);
    return;
  }
  store.run(
    `INSERT INTO rules (id, kind, value, label_id, state, correction_count, create_time, update_time) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?)`,
    shortId('r'),
    key.kind,
    key.value,
    label,
    count,
    now,
    now,
  );
}

function retractProposal(store: Store, row: DecisionRow, label: string): void {
  const key = ruleKey(row);
  if (key === null) return;
  const count = corrections(store, key, label);
  if (count < RULE_PROPOSAL_CORRECTIONS) store.run(`DELETE FROM rules WHERE kind = ? AND value = ? AND label_id = ? AND state = 'proposed'`, key.kind, key.value, label);
  else store.run(`UPDATE rules SET correction_count = ? WHERE kind = ? AND value = ? AND label_id = ?`, count, key.kind, key.value, label);
}

/**
 * Reads the queued Gmail label changes (the `feedback` table, oldest first) into verdicts. `owned` maps a Gmail label ID
 * to the app's label ID. Answers how many changes it read.
 */
export function applyFeedback(store: Store, owned: ReadonlyMap<string, string>, now: number, limit = 200): number {
  const events = store.all<{ key: string; message_id: string; change: 'added' | 'removed'; gmail_label_id: string }>(
    `SELECT key, message_id, change, gmail_label_id FROM feedback ORDER BY seq, key LIMIT ?`,
    limit,
  );
  const touched = new Set<string>();
  for (const event of events) {
    store.run(`DELETE FROM feedback WHERE key = ?`, event.key);
    const label = owned.get(event.gmail_label_id);
    const row = store.decision(event.message_id);
    if (label === undefined || row === undefined || row.outcome === 'skipped') continue;
    const labels = new Set(labelsOf(row));
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
  const labels = labelsOf(row);
  const applied = row.outcome === 'applied' ? row.label_id : null;
  // What mailsort itself left on the mail: its label while its write stands.
  const ledger = applied === null ? undefined : store.one<{ id: string; state: string }>(`SELECT id, state FROM ledger WHERE message_id = ? AND label_id = ? ORDER BY create_time DESC LIMIT 1`, row.message_id, applied);
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
  if (row.verdict_source !== 'gmail' || row.verdict_label !== chosen) setVerdict(store, row, chosen, 'gmail', now);
  if (standing && chosen !== applied) store.run(`UPDATE ledger SET superseded = 1 WHERE id = ?`, ledger.id);
}
