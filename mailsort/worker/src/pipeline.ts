/**
 * Bounded Alarm maintenance: retain content, sync Gmail history and owner corrections, complete priority setup,
 * enumerate an explicit unread batch and resume persisted Gmail writes. Classification belongs to the hourly runner.
 */
import { modeCeiling, type Env, type ModeName } from './env.ts';
import { applyFeedback } from './feedback.ts';
import { GoogleError, isMessageId, type AccessToken, type GmailClient, type HistoryPage } from './gmail.ts';
import { labelMergeStep, mergeWritesToday, migrationActive } from './label-merge.ts';
import { ALARM_BACKLOG_MS, ALARM_IDLE_MS, ALARM_SUBREQUESTS, HISTORY_PAGE_SIZE, HISTORY_PAGES_MAX, MAIL_SUBREQUESTS, RESYNC_MAX } from './limits.ts';
import { PRIORITY_IDS, priorityStartedAt } from './priority.ts';
import { Budget, noteGoogleError, noteTokenOk, openSession, writeScope } from './session.ts';
import { effectiveMode, readSettings } from './settings.ts';
import { utcDay, type Store } from './store.ts';
import { scanUnread } from './unread.ts';
import { executeWrites, type WriteGate } from './writes.ts';

/** Labels Gmail puts on mail that is not the owner's incoming mail: never decided. */
const SKIP_LABELS = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT']);

export interface PassDeps {
  readonly store: Store;
  readonly env: Env;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
  /** The access token cached by the object between passes, and where to put a new one. */
  readonly token: AccessToken | null;
  readonly saveToken: (token: AccessToken | null) => void;
}

export interface PassResult {
  readonly next: number;
  readonly mode: ModeName;
  readonly synced: number;
  readonly decided: number;
  readonly applied: number;
  readonly deferred: number;
  readonly code: string;
}

// ---- sync -------------------------------------------------------------------------------------------------------------

/** Reads history pages into `pending` and `feedback`; answers how many mails it queued. */
async function sync(store: Store, gmail: GmailClient, budget: Budget, now: () => number, transact: <T>(fn: () => T) => T): Promise<{ queued: number; more: boolean }> {
  const cursor = store.getMeta('history_cursor');
  if (cursor === null) {
    // The install-time cursor: mail from now on, none of the history before.
    const id = await gmail.currentHistoryId();
    transact(() => {
      store.setMeta('history_cursor', id);
      store.setMeta('last_sync_at', String(now()));
      // The installation time remains available for history and Ops projections.
      store.setMeta('installed_at', String(now()));
    });
    return { queued: 0, more: false };
  }
  const start = cursor;
  let token: string | null = null;
  let queued = 0;
  for (let page = 0; page < HISTORY_PAGES_MAX; page++) {
    if (!budget.has(MAIL_SUBREQUESTS)) return { queued, more: true };
    let answer: HistoryPage;
    try {
      answer = await gmail.history(start, token, HISTORY_PAGE_SIZE);
    } catch (error) {
      if (error instanceof GoogleError && error.kind === 'not_found') return { queued: queued + (await resync(store, gmail, now, transact)), more: false };
      throw error;
    }
    const owned = store.ownedGmailIds();
    const records = answer.history ?? [];
    const last = records[records.length - 1]?.id;
    transact(() => {
      for (const record of records) {
        const seq = Number(record.id);
        for (const added of record.messagesAdded ?? []) {
          const labels = added.message.labelIds ?? [];
          // An ID the guard would refuse can never be read: never queued (it would wait at the head forever).
          if (isMessageId(added.message.id) && labels.includes('INBOX') && !labels.some((label) => SKIP_LABELS.has(label))) {
            store.enqueue(added.message.id, now());
            queued++;
          }
        }
        for (const [change, list] of [['added', record.labelsAdded ?? []], ['removed', record.labelsRemoved ?? []]] as const) {
          for (const item of list) {
            for (const label of item.labelIds) {
              if (!owned.has(label) || store.decision(item.message.id) === undefined) continue;
              store.run(
                `INSERT OR IGNORE INTO feedback (key, message_id, change, gmail_label_id, seq) VALUES (?, ?, ?, ?, ?)`,
                `${record.id}:${item.message.id}:${change}:${label}`,
                item.message.id,
                change,
                label,
                Number.isFinite(seq) ? seq : 0,
              );
            }
          }
        }
      }
      const done = answer.nextPageToken === undefined;
      // A finished read moves to the mailbox's historyId; an unfinished one to its last record (repeats are harmless).
      const next = done ? (answer.historyId ?? last ?? start) : (last ?? start);
      store.setMeta('history_cursor', next);
      if (done) store.setMeta('last_sync_at', String(now()));
    });
    if (answer.nextPageToken === undefined) return { queued, more: false };
    token = answer.nextPageToken;
  }
  return { queued, more: true };
}

/**
 * After a lost cursor: a fresh cursor, then the inbox's mails of the last two days (deduplicated). The cursor is read
 * first, so a mail that arrives between the two reads is in the list, after the cursor, or both (the pending key and
 * enqueue's check of decisions drop the repeat); read the other way round it would be in neither.
 */
async function resync(store: Store, gmail: GmailClient, now: () => number, transact: <T>(fn: () => T) => T): Promise<number> {
  const id = await gmail.currentHistoryId();
  const ids = await gmail.recentInbox(RESYNC_MAX);
  transact(() => {
    for (const message of ids) store.enqueue(message, now());
    store.setMeta('history_cursor', id);
    store.setMeta('last_sync_at', String(now()));
    store.pushError('history_resync');
  });
  return ids.length;
}

/** Auto writes may go out now: live in force (the owner's mode under the ceiling and the breaker) and a write grant. */
export function writesLive(store: Store, ceiling: ModeName): boolean {
  return effectiveMode(readSettings(store), ceiling) === 'live' && writeScope(store);
}

/**
 * The alarm's gate (writes.ts WriteGate), asked right before each `intended` row goes to Gmail, whether the row is
 * this pass's or a retry of an earlier one. Every row needs live in force and a write grant. An auto row also needs
 * its label enabled and stays within the caps:
 * reaching the daily or per-run cap leaves its intent queued. An owner's row (a review choice whose first try failed)
 * is not capped.
 */
export function alarmGate(store: Store, ceiling: ModeName, counter: { runWrites: number }, now: () => number): WriteGate {
  return (row, label) => {
    const unread = store.one(`SELECT 1 AS x FROM unread_batch WHERE ledger_id = ?`, row.id) !== undefined ||
      store.one(`SELECT 1 AS x FROM classification_items WHERE ledger_id = ?`, row.id) !== undefined;
    if (unread) {
      const settings = readSettings(store);
      const full = store.usage(utcDay(now())).applied + mergeWritesToday(store, utcDay(now())) >= settings.dailyWriteLimit;
      if (!writesLive(store, ceiling) || full || counter.runWrites >= settings.runWriteLimit) return 'wait';
    }
    if (!writesLive(store, ceiling)) return 'mode_changed';
    if (row.origin === 'owner') return null;
    if (label.enabled !== 1) return 'label_disabled';
    const settings = readSettings(store);
    const at = now();
    if (store.usage(utcDay(at)).applied + mergeWritesToday(store, utcDay(at)) >= settings.dailyWriteLimit) {
      return 'wait';
    }
    if (counter.runWrites >= settings.runWriteLimit) {
      return 'wait';
    }
    counter.runWrites++;
    return null;
  };
}

// ---- daily work -------------------------------------------------------------------------------------------------------------

/**
 * The retention cleanup (store.ts prune), once per UTC day and in every mode: the 14 days of content hold even while
 * the mode is off, when nothing else runs. No Google call. Run inside a transaction.
 */
export function retain(store: Store, now: number): void {
  const day = utcDay(now);
  if (store.getMeta('pruned_day') === day) return;
  store.prune(now);
  store.setMeta('pruned_day', day);
}

// ---- the pass --------------------------------------------------------------------------------------------------------------

export async function runPass(deps: PassDeps): Promise<PassResult> {
  const { store, transact } = deps;
  const now = deps.now();
  const settings = readSettings(store);
  const mode = effectiveMode(settings, modeCeiling(deps.env));
  const idle = now + ALARM_IDLE_MS;
  transact(() => {
    store.setMeta('last_alarm_at', String(now));
    retain(store, now);
  });
  if (mode === 'off') return { next: idle, mode, synced: 0, decided: 0, applied: 0, deferred: 0, code: 'off' };

  const budget = new Budget(ALARM_SUBREQUESTS);
  const session = await openSession({ store, env: deps.env, fetch: deps.fetch, now: deps.now, budget, token: deps.token });
  if ('reason' in session) {
    return { next: idle, mode, synced: 0, decided: 0, applied: 0, deferred: 0, code: session.reason };
  }
  const gmail = session.client;
  let synced = 0;
  const decided = 0;
  let applied = 0;
  const deferred = 0;
  let backlog = false;
  let code = 'ok';
  try {
    const token = await gmail.ensureToken();
    deps.saveToken(token);
    transact(() => { noteTokenOk(store, token); });
    const read = await sync(store, gmail, budget, deps.now, transact);
    synced = read.queued;
    backlog ||= read.more;
    if (migrationActive(store)) {
      await labelMergeStep({ store, gmail, budget, now: deps.now, transact, canWrite: () => {
        const current = readSettings(store);
        return effectiveMode(current, modeCeiling(deps.env)) !== 'off' && current.breaker === '' && store.getMeta('write_scope') === '1';
      } });
      return { next: deps.now() + ALARM_BACKLOG_MS, mode, synced, decided: 0, applied: 0, deferred: 0, code: 'label_consolidation' };
    }

    // Keep history registration and any accepted legacy consolidation running while the owner sets up priorities.
    // Classification, learning and ordinary writes begin only after the four priority identities are ready.
    if (priorityStartedAt(store) === 0 || [...PRIORITY_IDS].some((id) => store.label(id) === undefined)) {
      return { next: read.more ? deps.now() + ALARM_BACKLOG_MS : idle, mode, synced, decided: 0, applied: 0, deferred: 0, code: 'priority_setup_required' };
    }

    if (budget.has(1) && await scanUnread(store, gmail, deps.now(), transact)) {
      return { next: deps.now() + ALARM_BACKLOG_MS, mode, synced, decided: 0, applied: 0, deferred: 0, code: 'unread_scanning' };
    }

    const owned = new Map(store.labels().filter((label) => PRIORITY_IDS.has(label.id)).flatMap((label) => (label.gmail_state === 'linked' && label.gmail_id !== null ? [[label.gmail_id, label.id] as const] : [])));
    transact(() => applyFeedback(store, owned, deps.now()));

    // Retries of writes an earlier pass left `intended` come before new decisions, through the same gate and counted
    // against the same run cap.
    const ceiling = modeCeiling(deps.env);
    const counter = { runWrites: 0 };
    const gate = alarmGate(store, ceiling, counter, deps.now);
    const retried = await executeWrites({ store, gmail, budget, now: deps.now, transact, gate }, null, 5);
    applied += retried.applied;
    if (retried.stopped) throw new Error('stopped');

    if (store.count(`SELECT count(*) AS n FROM ledger WHERE state IN ('intended', 'undo_intended')`) > 0) {
      const current = readSettings(store);
      const canWrite = writesLive(store, ceiling) && store.usage(utcDay(deps.now())).applied + mergeWritesToday(store, utcDay(deps.now())) < current.dailyWriteLimit;
      // Paused/capped batch intents remain persistent without making an idle Alarm busy every 30 seconds.
      if (canWrite || store.count(`SELECT count(*) AS n FROM ledger WHERE state = 'undo_intended'`) > 0) backlog = true;
    }
  } catch (error) {
    if (!(error instanceof Error && error.message === 'stopped')) {
      transact(() => noteGoogleError(store, error));
      code = error instanceof GoogleError ? error.code : 'pass_error';
      if (error instanceof GoogleError && error.kind === 'auth') deps.saveToken(null);
    } else {
      code = 'gmail_stopped';
    }
    backlog = false;
  }
  return { next: backlog ? deps.now() + ALARM_BACKLOG_MS : idle, mode, synced, decided, applied, deferred, code };
}
