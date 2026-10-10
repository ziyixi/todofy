/**
 * Gmail writes through the ledger (../../docs/design.md §7). Every write is a ledger row first (`intended`, or
 * `undo_intended` for an undo), committed before the request; then the request through gmail.ts, whose guard accepts a
 * modify only for such a row; then the row's outcome. A run interrupted between the two retries the same row: adding a
 * label that is already there, or removing one that is gone, changes nothing in Gmail.
 *
 * An `intended` row is written only if the caller's gate allows it at that moment: the row may be from an earlier
 * pass, and since then the owner may have chosen shadow, the breaker may have tripped or the label may have been
 * disabled. A refused row fails (`mode_changed`, ...) and its decision stays only recorded (`suggested`); the mail is
 * left in the inbox as it is. Undo rows are never gated: they only give the mail back to the inbox.
 *
 * An automatic row left by an earlier pass (a 503, a pass cut short) is also checked against the mail as it is now,
 * one metadata read before the write: if the owner has meanwhile archived it or filed it under a label of their own,
 * mailsort's label would be a second label on mail no longer in the inbox, so the row fails (`mail_changed`).
 *
 * Labels are created in Gmail (named by their path) just before the first write that needs them, after the gate, with
 * the parents Gmail nests them under (`开发` for `开发/CI通知`) when those do not exist yet. The parents only group:
 * they are never linked, so the guard never lets a write add one to a mail (one label per mail, always a leaf). A
 * write never takes over a Gmail label this app did not make: when Gmail already has a label of a label's exact path,
 * the label stays pending (`gmail_name_taken`) and the row fails (`label_name_taken`) until the owner renames the
 * label or adopts that Gmail label (从 Gmail 同步, api.ts syncLabels, the only place a label is adopted).
 *
 * Nor does a write add a label the mail already carries (`already_labelled`), so an undo never takes off a label that
 * was there before: the labels its intent recorded, and for an adopted label (the owner's own, which they may put on
 * mail themselves) the ones the mail has right before the write. A retry whose earlier try reached Gmail with its
 * answer lost fails that way too for an adopted label: the label stays, as one the owner may have put there.
 *
 * An applied label keeps its mail in the inbox when the ledger row says so (`archived` = 0: the label's keep-in-inbox,
 * or a mail that asks the owner to act soon); the guard checks the modify against that flag, and the undo then gives
 * nothing back to the inbox. A row recorded to archive keeps instead when its label keeps its mail by the time it goes
 * out (keepIfLabelKeeps).
 */
import { setCurrentLabels } from './feedback.ts';
import { countFlow, stageOf } from './flow.ts';
import { GmailRefused, GoogleError, isUserLabelId, type GmailClient, type GmailLabel } from './gmail.ts';
import { WRITE_ATTEMPTS_MAX } from './limits.ts';
import { parentGmailNames } from './paths.ts';
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

/**
 * Records the intent to add `label` to `messageId` (and archive it). `labelIds` are the labels the mail carries as the
 * decision read it; its user labels are kept for the later-pass check (mailChanged). Run inside the caller's transaction.
 */
export function intend(store: Store, messageId: string, label: LabelRow, archive: boolean, origin: 'auto' | 'owner', now: number, labelIds: readonly string[] = []): string {
  const id = timeId(now);
  store.run(
    `INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time, base_labels) VALUES (?, ?, ?, ?, ?, ?, 'intended', ?, ?)`,
    id,
    messageId,
    label.id,
    label.gmail_state === 'linked' ? label.gmail_id : null,
    archive ? 1 : 0,
    origin,
    now,
    JSON.stringify(labelIds.filter(isUserLabelId)),
  );
  return id;
}

/**
 * Whether the mail changed since `row`'s intent in a way that makes the write wrong: it left the inbox, or it carries a
 * user label it did not have then (the owner's own, or another of this app's), other than the row's own label (a write
 * that reached Gmail before its answer was lost).
 */
export function mailChanged(row: LedgerRow, labelIds: readonly string[]): boolean {
  if (!labelIds.includes('INBOX')) return true;
  const base = new Set(JSON.parse(row.base_labels) as string[]);
  return labelIds.some((id) => isUserLabelId(id) && id !== row.gmail_label_id && !base.has(id));
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

/** The Gmail requests ensureGmailLabel may make for `label`: the list, the parents and the label itself. */
export function labelCreationCost(label: Pick<LabelRow, 'display_name' | 'gmail_state' | 'gmail_id'>): number {
  return label.gmail_state === 'linked' && label.gmail_id !== null ? 0 : 1 + parentGmailNames(label.display_name).length + 1;
}

/**
 * Gmail's user labels by name: the only ones a label of this app may be linked to. A system label (INBOX, SPAM,
 * CATEGORY_*, ...) is never adopted, whatever its name.
 */
export function userLabelsByName(labels: readonly GmailLabel[]): Map<string, string> {
  return new Map(labels.filter((item) => item.type !== 'system' && isUserLabelId(item.id)).map((item) => [item.name, item.id]));
}

/** Whether Gmail has user labels nested under `path` (`社团/活动` under `社团`): `path` is a parent there, never linked. */
export function hasSublabels(existing: ReadonlyMap<string, string>, path: string): boolean {
  return [...existing.keys()].some((name) => name.startsWith(`${path}/`));
}

/**
 * Creates `name` in Gmail and answers its ID; null on a 409: Gmail has a label of that name, made since its labels were
 * read, so by someone else (the owner): never one this app made.
 */
async function createUnlessTaken(gmail: GmailClient, name: string): Promise<string | null> {
  try {
    return await gmail.createLabel(name);
  } catch (error) {
    if (error instanceof GoogleError && error.code === 'labels_create_409') return null;
    throw error;
  }
}

/**
 * Makes sure Gmail has the parents of a label's path (`开发` for `开发/CI通知`), outermost first, so it shows the label
 * nested. A parent this app creates is recorded (`gmail_parents`): a label later linked to it (the owner adds `开发` by
 * hand once its children are gone) is the app's own, not adopted. A parent Gmail already had, or one made meanwhile
 * (a 409), is the owner's: used to nest under as it is, never recorded.
 */
export async function ensureGmailParents(gmail: GmailClient, path: string, existing: Map<string, string>, store: Store, now: number): Promise<void> {
  for (const parent of parentGmailNames(path)) {
    if (existing.has(parent)) continue;
    const id = await createUnlessTaken(gmail, parent);
    if (id === null) continue;
    existing.set(parent, id);
    store.run(`INSERT OR IGNORE INTO gmail_parents (gmail_id, create_time) VALUES (?, ?)`, id, now);
  }
}

/** Whether this app created the Gmail label `gmailId` as a parent (ensureGmailParents). */
export function isOwnParent(store: Store, gmailId: string): boolean {
  return store.one(`SELECT 1 AS x FROM gmail_parents WHERE gmail_id = ?`, gmailId) !== undefined;
}

/**
 * Links the label `labelId` to the Gmail label `gmailId`: owned from here on (the guard's set). Adopted when this app
 * did not create that Gmail label: a user label of exactly the label's path that Gmail already had (the owner's, linked
 * by their 从 Gmail 同步); a parent this app made earlier is its own, and its record goes. Run inside a transaction.
 */
export function linkGmailLabel(store: Store, labelId: string, gmailId: string, created: boolean, now: number): void {
  const ownParent = isOwnParent(store, gmailId);
  store.run(`DELETE FROM gmail_parents WHERE gmail_id = ?`, gmailId);
  store.run(`UPDATE labels SET gmail_id = ?, gmail_state = 'linked', gmail_adopted = ?, gmail_name_taken = 0 WHERE id = ?`, gmailId, created || ownParent ? 0 : 1, labelId);
  store.touchLabel(labelId, now);
  store.run(`UPDATE ledger SET gmail_label_id = ? WHERE label_id = ? AND gmail_label_id IS NULL AND state = 'intended'`, gmailId, labelId);
}

/** Records whether a pending label's path is the name of a Gmail label that is not its own. Run inside a transaction. */
export function setNameTaken(store: Store, labelId: string, taken: boolean, now: number): void {
  const flag = taken ? 1 : 0;
  if (store.run(`UPDATE labels SET gmail_name_taken = ? WHERE id = ? AND gmail_state = 'pending' AND gmail_name_taken != ?`, flag, labelId, flag) > 0) store.touchLabel(labelId, now);
}

/**
 * The label's Gmail ID, creating the label (and its parents) in Gmail when it is still pending. Null when it went
 * missing, or when its path is taken (`gmail_name_taken`): Gmail has a label of that name that is not its own (the
 * owner's, a system label, another label's here renamed to it in Gmail). Such a label is never adopted here, only by
 * the owner's 从 Gmail 同步. The one exception is a parent this app made, with no sublabels left: its own, so linked.
 */
export async function ensureGmailLabel(ctx: WriteContext, label: LabelRow): Promise<string | null> {
  if (label.gmail_state === 'linked' && label.gmail_id !== null) return label.gmail_id;
  if (label.gmail_state === 'missing') return null;
  // One read of Gmail's labels, then only what is missing.
  const labels = await ctx.gmail.labels();
  const existing = userLabelsByName(labels);
  const path = label.display_name;
  const there = labels.find((item) => item.name === path);
  let id: string | null;
  if (there === undefined) {
    await ensureGmailParents(ctx.gmail, path, existing, ctx.store, ctx.now());
    id = await createUnlessTaken(ctx.gmail, path);
  } else {
    // Taken, unless it is a parent this app made that nests nothing any more.
    id = isOwnParent(ctx.store, there.id) && !hasSublabels(existing, path) ? there.id : null;
  }
  const now = ctx.now();
  ctx.transact(() => {
    if (id === null) setNameTaken(ctx.store, label.id, true, now);
    else linkGmailLabel(ctx.store, label.id, id, there === undefined, now);
  });
  return id;
}

/**
 * Whether the mail already carries `gmailId`: as its intent recorded it (base_labels), or as it is now (`labelsNow`,
 * read for an adopted label). Writing it would change nothing, and its undo would take off a label that was there.
 */
export function alreadyLabelled(row: LedgerRow, gmailId: string, labelsNow: readonly string[] | null): boolean {
  return (JSON.parse(row.base_labels) as string[]).includes(gmailId) || (labelsNow?.includes(gmailId) ?? false);
}

export interface WriteOutcome {
  readonly applied: number;
  readonly undone: number;
  readonly failed: number;
  /** Google stopped answering (auth, rate, unavailable): the rest waits for the next alarm. */
  readonly stopped: boolean;
}

/** Fails an `intended` row for good. Run inside a transaction. */
function fail(store: Store, row: LedgerRow, code: string): void {
  store.run(`UPDATE ledger SET state = 'failed', last_code = ? WHERE id = ?`, code, row.id);
  // An auto write that failed for good (in this pass or a later retry) leaves its decision only recorded, as in
  // shadow mode: the mail stays in the inbox as it is. The review queue holds uncertain mail only.
  if (row.origin === 'auto' && store.run(`UPDATE decisions SET outcome = 'suggested' WHERE message_id = ? AND outcome = 'applied'`, row.message_id) > 0) {
    // The flow counted the decision as written: it is only recorded now, on its own day.
    const decision = store.decision(row.message_id);
    if (decision !== undefined) {
      const stage = stageOf(decision.decider);
      countFlow(store, decision.decided_at, stage, row.archived === 1 ? 'archived' : 'kept_in_inbox', decision.label_id, -1);
      countFlow(store, decision.decided_at, stage, 'suggested', decision.label_id, 1);
    }
  }
}

/**
 * Lowers an `intended` row from archive to keep when its label keeps its mail in the inbox now (归档 turned off since
 * the intent, for a write a 429 or 5xx left for a retry): keeping is the direction the owner just chose, and the safe
 * one, so the retry only adds the label. Never the other way: a row that keeps (a mail that asks the owner to act, or
 * a label that kept then) never starts archiving. The flow's count of an automatic write moves with it. Answers the row as it is now.
 * Run inside the gate's transaction, so the guard checks the modify against the flag the row now has.
 */
function keepIfLabelKeeps(store: Store, row: LedgerRow): LedgerRow {
  if (row.archived !== 1 || store.label(row.label_id)?.keep_in_inbox !== 1) return row;
  store.run(`UPDATE ledger SET archived = 0 WHERE id = ? AND state = 'intended'`, row.id);
  const decision = row.origin === 'auto' ? store.decision(row.message_id) : undefined;
  if (decision !== undefined && decision.outcome === 'applied') {
    const stage = stageOf(decision.decider);
    countFlow(store, decision.decided_at, stage, 'archived', decision.label_id, -1);
    countFlow(store, decision.decided_at, stage, 'kept_in_inbox', decision.label_id, 1);
  }
  return { ...row, archived: 0 };
}

/**
 * Executes ledger rows in `intended` or `undo_intended` (the given IDs, or the oldest `limit`), one Gmail modify each,
 * while the budget lasts. `ids === null` is the alarm's retry of rows earlier passes left: an automatic one among them,
 * like any automatic row that already failed once, is first checked against the mail as it is now (mailChanged).
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
    let row = original;
    const recheck = row.state === 'intended' && row.origin === 'auto' && (ids === null || row.attempts > 0);
    const label = store.label(row.label_id);
    // The owner's own label, adopted: the mail's labels are read right before the write (alreadyLabelled).
    const adopted = row.state === 'intended' && label?.gmail_state === 'linked' && label.gmail_adopted === 1;
    // A modify, one read of the mail (a recheck, an adopted label), and the label's creation in Gmail (with its
    // parents) when it is still pending.
    const creation = row.state === 'intended' && row.gmail_label_id === null && label !== undefined ? labelCreationCost(label) : 0;
    if (!ctx.budget.has(1 + (recheck || adopted ? 1 : 0) + creation)) break;
    try {
      if (row.state === 'intended') {
        if (label === undefined) {
          ctx.transact(() => { fail(store, row, 'label_deleted'); });
          failed++;
          continue;
        }
        const labelsNow = recheck || adopted ? await ctx.gmail.labelIdsOf(row.message_id) : null;
        // Before the gate, so a mail that is not written does not use up a write of the run's cap.
        if (recheck && labelsNow !== null && mailChanged(row, labelsNow)) {
          ctx.transact(() => { fail(store, row, 'mail_changed'); });
          failed++;
          continue;
        }
        // The gate runs before anything reaches Gmail, label creation included.
        const refused = ctx.transact(() => {
          const code = ctx.gate(row, label);
          if (code !== null) fail(store, row, code);
          else row = keepIfLabelKeeps(store, row);
          return code;
        });
        if (refused !== null) {
          failed++;
          continue;
        }
        const gmailId = row.gmail_label_id ?? (await ensureGmailLabel(ctx, label));
        if (gmailId === null) {
          ctx.transact(() => { fail(store, row, label.gmail_state === 'missing' ? 'label_missing' : 'label_name_taken'); });
          failed++;
          continue;
        }
        if (alreadyLabelled(row, gmailId, adopted ? labelsNow : null)) {
          ctx.transact(() => { fail(store, row, 'already_labelled'); });
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
          if (row.state === 'intended') fail(store, row, error instanceof GoogleError && error.kind === 'forbidden' ? 'read_only_grant' : permanent);
          else store.run(`UPDATE ledger SET state = 'applied', last_code = ? WHERE id = ?`, permanent, row.id);
          return false;
        }
        const attempts = row.attempts + 1;
        store.run(`UPDATE ledger SET attempts = ?, last_code = ? WHERE id = ?`, attempts, error instanceof GoogleError ? error.code : 'gmail_unexpected', row.id);
        if (attempts >= WRITE_ATTEMPTS_MAX) {
          if (row.state === 'intended') fail(store, row, 'attempts');
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
