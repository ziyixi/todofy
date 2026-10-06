/**
 * Gmail writes through the ledger (../../docs/design.md §7). Every write is a ledger row first (`intended`, or
 * `undo_intended` for an undo), committed before the request; then the request through gmail.ts, whose guard accepts a
 * modify only for such a row; then the row's outcome. A run interrupted between the two retries the same row: adding a
 * label that is already there, or removing one that is gone, changes nothing in Gmail.
 *
 * An `intended` row is written only if the caller's gate allows it at that moment: the row may be from an earlier
 * pass, and since then the owner may have chosen shadow, the breaker may have tripped or the label may have left live.
 * A refused row fails (`mode_changed`, ...) and its mail becomes a suggestion in the review queue. Undo rows are never
 * gated: they only give the mail back to the inbox.
 *
 * Labels are created in Gmail ("分拣/" + display name) just before the first write that needs them, after the gate.
 */
import { setCurrentLabels } from './feedback.ts';
import { GmailRefused, GoogleError, type GmailClient } from './gmail.ts';
import { LABEL_PREFIX, WRITE_ATTEMPTS_MAX } from './limits.ts';
import { noteGoogleError } from './session.ts';
import { timeId } from './ids.ts';
import { utcDay, type LabelRow, type LedgerRow, type Store } from './store.ts';
import type { Budget } from './session.ts';

/**
 * Asked right before an `intended` row is written: null to write it, or the code it fails with. It reads the mode,
 * the label and the limits as they are now, and may count the write (the alarm's caps).
 */
export type WriteGate = (row: LedgerRow, label: LabelRow) => string | null;

export interface WriteContext {
  readonly store: Store;
  readonly gmail: GmailClient;
  readonly budget: Budget;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
  readonly gate: WriteGate;
}

/** Records the intent to add `label` to `messageId` (and archive it). Run inside the caller's transaction. */
export function intend(store: Store, messageId: string, label: LabelRow, archive: boolean, origin: 'auto' | 'owner', now: number): string {
  const id = timeId(now);
  store.run(
    `INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time) VALUES (?, ?, ?, ?, ?, ?, 'intended', ?)`,
    id,
    messageId,
    label.id,
    label.gmail_state === 'linked' ? label.gmail_id : null,
    archive ? 1 : 0,
    origin,
    now,
  );
  return id;
}

/**
 * Whether UndoLedgerEntry accepts `row`: mailsort's label still stands as it put it (applied, or an undo already
 * under way; not changed by the owner in Gmail since), and the label is still owned (`owned`: Store.ownedGmailIds).
 * A label deleted here, or missing in Gmail, is no longer owned, so the guard would refuse its undo.
 */
export function undoable(row: LedgerRow, owned: ReadonlySet<string>): boolean {
  return (row.state === 'applied' || row.state === 'undo_intended') && row.superseded === 0 && row.gmail_label_id !== null && owned.has(row.gmail_label_id);
}

/** Marks an applied row for undo (the next execute removes the label, and adds INBOX back if it archived). */
export function intendUndo(store: Store, row: LedgerRow): void {
  store.run(`UPDATE ledger SET state = 'undo_intended', attempts = 0 WHERE id = ? AND state = 'applied'`, row.id);
}

/** The label's Gmail ID, creating the label in Gmail when it is still pending; null when it went missing. */
export async function ensureGmailLabel(ctx: WriteContext, label: LabelRow): Promise<string | null> {
  if (label.gmail_state === 'linked' && label.gmail_id !== null) return label.gmail_id;
  if (label.gmail_state === 'missing') return null;
  const name = `${LABEL_PREFIX}${label.display_name}`;
  let id: string;
  try {
    id = await ctx.gmail.createLabel(name);
  } catch (error) {
    // 409: Gmail already has a label of that name (made by hand, or by an earlier try): link it.
    if (!(error instanceof GoogleError) || error.code !== 'labels_create_409') throw error;
    const found = (await ctx.gmail.labels()).find((item) => item.name === name);
    if (found === undefined) throw error;
    id = found.id;
  }
  const now = ctx.now();
  ctx.transact(() => {
    ctx.store.run(`UPDATE labels SET gmail_id = ?, gmail_state = 'linked' WHERE id = ?`, id, label.id);
    ctx.store.touchLabel(label.id, now);
    ctx.store.run(`UPDATE ledger SET gmail_label_id = ? WHERE label_id = ? AND gmail_label_id IS NULL AND state = 'intended'`, id, label.id);
  });
  return id;
}

export interface WriteOutcome {
  readonly applied: number;
  readonly undone: number;
  readonly failed: number;
  /** Google stopped answering (auth, rate, unavailable): the rest waits for the next alarm. */
  readonly stopped: boolean;
}

/** A failed auto write's mail becomes a suggestion in the review queue (once, while its content is kept). */
export function addSuggestion(store: Store, messageId: string, now: number): void {
  const row = store.decision(messageId);
  if (row === undefined || row.content_cleared === 1 || store.pendingReviewOf(messageId) !== undefined) return;
  store.run(
    `INSERT INTO review (id, message_id, kind, state, suggested_label, candidates, decider, unsure_reason, subject, sender, receive_time, create_time)
     VALUES (?, ?, 'suggestion', 'pending', ?, ?, ?, '', ?, ?, ?, ?)`,
    timeId(now),
    messageId,
    row.label_id,
    JSON.stringify(row.label_id === null ? [] : [{ label: row.label_id, probability: 1 }]),
    row.decider,
    row.subject ?? '',
    row.sender ?? '',
    row.received_at,
    now,
  );
}

/** Fails an `intended` row for good. Run inside a transaction. */
function fail(store: Store, row: LedgerRow, code: string, now: number): void {
  store.run(`UPDATE ledger SET state = 'failed', last_code = ? WHERE id = ?`, code, row.id);
  // An auto write that failed for good (in this pass or a later retry) leaves its mail as a suggestion in the
  // review queue: the owner can still label it from there. An owner's row was their own choice: nothing to review.
  if (row.origin === 'auto' && store.run(`UPDATE decisions SET outcome = 'suggested' WHERE message_id = ? AND outcome = 'applied'`, row.message_id) > 0) {
    addSuggestion(store, row.message_id, now);
  }
}

/**
 * Executes ledger rows in `intended` or `undo_intended` (the given IDs, or the oldest `limit`), one Gmail modify each,
 * while the budget lasts.
 */
export async function executeWrites(ctx: WriteContext, ids: readonly string[] | null, limit: number): Promise<WriteOutcome> {
  const { store } = ctx;
  const rows =
    ids === null
      ? store.all<LedgerRow>(`SELECT * FROM ledger WHERE state IN ('intended', 'undo_intended') ORDER BY id LIMIT ?`, limit)
      : ids.flatMap((id) => {
          const row = store.ledgerRow(id);
          return row !== undefined && (row.state === 'intended' || row.state === 'undo_intended') ? [row] : [];
        });
  let applied = 0;
  let undone = 0;
  let failed = 0;
  for (const original of rows) {
    if (!ctx.budget.has(2)) break;
    let row = original;
    const label = store.label(row.label_id);
    try {
      if (row.state === 'intended') {
        if (label === undefined) {
          ctx.transact(() => { fail(store, row, 'label_deleted', ctx.now()); });
          failed++;
          continue;
        }
        // The gate runs before anything reaches Gmail, label creation included.
        const refused = ctx.transact(() => {
          const code = ctx.gate(row, label);
          if (code !== null) fail(store, row, code, ctx.now());
          return code;
        });
        if (refused !== null) {
          failed++;
          continue;
        }
        const gmailId = row.gmail_label_id ?? (await ensureGmailLabel(ctx, label));
        if (gmailId === null) {
          ctx.transact(() => { fail(store, row, 'label_missing', ctx.now()); });
          failed++;
          continue;
        }
        if (row.gmail_label_id === null) {
          ctx.transact(() => store.run(`UPDATE ledger SET gmail_label_id = ? WHERE id = ?`, gmailId, row.id));
          row = { ...row, gmail_label_id: gmailId };
        }
        await ctx.gmail.classify(row.message_id, gmailId, row.archived === 1);
        const now = ctx.now();
        ctx.transact(() => {
          store.run(`UPDATE ledger SET state = 'applied', apply_time = ?, last_code = NULL WHERE id = ?`, now, row.id);
          const decision = store.decision(row.message_id);
          if (decision !== undefined) setCurrentLabels(store, row.message_id, [...(JSON.parse(decision.current_labels) as string[]), row.label_id]);
          if (row.origin === 'auto') store.addUsage(utcDay(now), 'applied', 1);
        });
        applied++;
      } else {
        if (row.gmail_label_id === null) {
          ctx.transact(() => store.run(`UPDATE ledger SET state = 'undone', undo_time = ? WHERE id = ?`, ctx.now(), row.id));
          continue;
        }
        await ctx.gmail.undo(row.message_id, row.gmail_label_id, row.archived === 1);
        const now = ctx.now();
        ctx.transact(() => {
          store.run(`UPDATE ledger SET state = 'undone', undo_time = ?, last_code = NULL WHERE id = ?`, now, row.id);
          const decision = store.decision(row.message_id);
          if (decision !== undefined) setCurrentLabels(store, row.message_id, (JSON.parse(decision.current_labels) as string[]).filter((item) => item !== row.label_id));
        });
        undone++;
      }
    } catch (error) {
      const stop = ctx.transact(() => {
        // Permanent for this one row: the mail is gone, the grant is read-only, Gmail refused the request itself, or
        // the guard refused it (its label is no longer owned: deleted here, or missing in Gmail). Retrying cannot
        // help, and the other rows are not affected, so the run goes on.
        const permanent =
          error instanceof GmailRefused ? 'guard_refused' : error instanceof GoogleError && (error.kind === 'not_found' || error.kind === 'forbidden' || error.kind === 'bad_answer') ? error.code : null;
        if (permanent !== null) {
          store.pushError(error instanceof GmailRefused ? 'gmail_guard_refused' : permanent);
          if (row.state === 'intended') fail(store, row, error instanceof GoogleError && error.kind === 'forbidden' ? 'read_only_grant' : permanent, ctx.now());
          else store.run(`UPDATE ledger SET state = 'applied', last_code = ? WHERE id = ?`, permanent, row.id);
          return false;
        }
        const attempts = row.attempts + 1;
        store.run(`UPDATE ledger SET attempts = ?, last_code = ? WHERE id = ?`, attempts, error instanceof GoogleError ? error.code : 'gmail_unexpected', row.id);
        if (attempts >= WRITE_ATTEMPTS_MAX) {
          if (row.state === 'intended') fail(store, row, 'attempts', ctx.now());
          else store.run(`UPDATE ledger SET state = 'applied' WHERE id = ?`, row.id);
        }
        return noteGoogleError(store, error);
      });
      if (stop) return { applied, undone, failed: failed + 1, stopped: true };
      failed++;
    }
  }
  return { applied, undone, failed, stopped: false };
}
