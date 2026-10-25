/**
 * Bounded alarm pass: retain content, wait for priority setup, sync Gmail history, learn current priority feedback,
 * retry ledger writes, and classify each new message independently. P1 stays in Inbox, P2-P4 are archived.
 * The selected engine classifies a bounded batch in one request. Historical learning and replay remain readable.
 * Existing write gates and Gmail request limits apply to every step.
 */
import { CLAUDE_CACHE_TTL_MS, ClaudeBudgetError, ClaudeConfigurationError, ClaudeError, classifyEmails, type ClaudeBatchResult, type ClaudeEmail, type ClaudeItem } from './claude.ts';
import { classifyWithCodex, CodexError, CodexConfigurationError, type CodexBatchResult } from './codex.ts';
import { readClassificationPrompt } from './classification-prompt.ts';
import { modeCeiling, type Env, type ModeName } from './env.ts';
import { applyFeedback, setCurrentLabels } from './feedback.ts';
import { countFlow, skipOutcome, stageOf } from './flow.ts';
import { GmailRefused, GoogleError, isMessageId, type AccessToken, type GmailClient, type HistoryPage } from './gmail.ts';
import { labelMergeStep, mergeWritesToday, migrationActive } from './label-merge.ts';
import { features, mask, senderHash, summaryOf, type Features } from './mask.ts';
import {
  ALARM_BACKLOG_MS,
  ALARM_IDLE_MS,
  ALARM_SUBREQUESTS,
  BAD_ANSWER_ATTEMPTS_MAX,
  DAY,
  DRAIN_MAX,
  HOUR,
  HISTORY_PAGE_SIZE,
  HISTORY_PAGES_MAX,
  INSTALL_GRACE_MS,
  MAIL_ATTEMPTS_MAX,
  MAIL_SUBREQUESTS,
  RESYNC_MAX,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  EXAMPLE_SUMMARY_CHARS,
} from './limits.ts';
import { readMessage, type ReadMessage } from './mime.ts';
import { P1_ID, PRIORITY_IDS, priorityGmailIds, priorityStartedAt } from './priority.ts';
import { Budget, noteGoogleError, noteTokenOk, openSession, writeScope } from './session.ts';
import { effectiveMode, readSettings } from './settings.ts';
import { CLAUDE_MONTHLY_LIMIT_MICROS, utcDay, type Store } from './store.ts';
import { decisionForRecheck, fallbackP1, finishUnread, isUnreadPending, scanUnread, unreadRechecksFallback, unreadRechecksInitial100 } from './unread.ts';
import { executeWrites, intend, type WriteContext, type WriteGate } from './writes.ts';

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

/** The start of the next UTC day. */
export function nextUtcMidnight(now: number): number {
  return Math.floor(now / DAY) * DAY + DAY;
}

/** The first instant of the next UTC calendar month. */
export function nextUtcMonth(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function deferModel(store: Store, until: number, now: number, transact: PassDeps['transact']): number {
  return transact(() => {
    const first = store.count(`SELECT count(*) AS n FROM pending WHERE not_before < ? AND deferred = 0`, until);
    const total = store.count(`SELECT count(*) AS n FROM pending WHERE not_before < ?`, until);
    store.run(`UPDATE pending SET deferred = ? WHERE not_before < ? AND deferred = 0`, now, until);
    countFlow(store, now, 'deferred', 'deferred', null, first);
    store.setMeta('next_model_at', String(until));
    store.run(`UPDATE pending SET not_before = ? WHERE not_before < ?`, until, until);
    return total;
  });
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
      // What "before the install" means for a later resync (decideMail skips such mail).
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
          if (isMessageId(added.message.id) && labels.includes('INBOX') && labels.includes('UNREAD') && !labels.some((label) => SKIP_LABELS.has(label))) {
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

// ---- one mail -----------------------------------------------------------------------------------------------------------

interface MailContext {
  readonly store: Store;
  readonly gmail: GmailClient;
  readonly budget: Budget;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
  /** The deployment's MODE ceiling (the mode in force is read again before each write). */
  readonly ceiling: ModeName;
  readonly gate: WriteGate;
  /** Writes this pass let through its gate (the run cap), and the ones Gmail applied. */
  readonly counter: { runWrites: number; applied: number };
}

/** `later` leaves mail pending; `stop` persists later Claude results without more Gmail writes. */
type MailOutcome = 'decided' | 'skipped' | 'gone' | 'later' | 'stop';

/** Puts a pending mail back with one more attempt and its backoff. Run inside a transaction. */
function postpone(store: Store, messageId: string, attempts: number, now: number): void {
  store.run(`UPDATE pending SET attempts = ?, not_before = ? WHERE message_id = ?`, attempts + 1, now + retryDelay(attempts + 1), messageId);
}

/** Auto writes may go out now: live in force (the owner's mode under the ceiling and the breaker) and a write grant. */
export function writesLive(store: Store, ceiling: ModeName): boolean {
  return effectiveMode(readSettings(store), ceiling) === 'live' && writeScope(store);
}

/**
 * The alarm's gate (writes.ts WriteGate), asked right before each `intended` row goes to Gmail, whether the row is
 * this pass's or a retry of an earlier one. Every row needs live in force and a write grant. An auto row also needs
 * its label enabled and stays within the caps:
 * reaching the daily or run cap keeps its intent waiting for a later eligible pass. An owner's row (a review choice whose first try failed) is not capped.
 */
export function alarmGate(store: Store, ceiling: ModeName, counter: { runWrites: number }, now: () => number): WriteGate {
  return (row, label) => {
    const unread = store.one(`SELECT 1 AS x FROM unread_batch WHERE ledger_id = ?`, row.id) !== undefined;
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
    if (store.usage(utcDay(at)).applied + mergeWritesToday(store, utcDay(at)) >= settings.dailyWriteLimit || counter.runWrites >= settings.runWriteLimit) return 'wait';
    counter.runWrites++;
    return null;
  };
}

/**
 * A failed read of one pending mail. Rate and auth are Google's state, not the mail's: the pass stops and the mail
 * keeps its place. Anything else is the mail's own problem and must never hold up the mail behind it (the queue is
 * read oldest first): an answer that will not change (refused by the guard, malformed, too large even as metadata)
 * skips it at once; a 403 or an unavailable Gmail puts it back with a backoff, and skips it after MAIL_ATTEMPTS_MAX
 * tries. Unavailable still stops the pass, since Gmail may be down for every mail.
 */
function readFailed(ctx: MailContext, messageId: string, attempts: number, error: unknown): MailOutcome {
  const { store } = ctx;
  const now = ctx.now();
  if (error instanceof GoogleError && error.kind === 'not_found') {
    ctx.transact(() => { finishPending(store, messageId); });
    return 'gone';
  }
  if (error instanceof GoogleError && (error.kind === 'rate' || error.kind === 'auth')) throw error;
  const code = error instanceof GoogleError ? error.code : error instanceof GmailRefused ? 'gmail_guard_refused' : 'message_unexpected';
  const final = error instanceof GmailRefused || (error instanceof GoogleError && (error.kind === 'bad_answer' || error.kind === 'too_large'));
  ctx.transact(() => {
    store.pushError(code);
    if (final || attempts + 1 >= MAIL_ATTEMPTS_MAX) recordSkip(store, messageId, messageId, 0, now, 'unreadable');
    else postpone(store, messageId, attempts, now);
  });
  if (error instanceof GoogleError && error.kind === 'unavailable') throw error;
  return 'skipped';
}

/**
 * Takes a mail off the queue. A mail deferred for the budget was counted as waiting (延后) on the day of its first
 * deferral; it leaves that count now, in the transaction that counts where it went (a decision or a skip), so every
 * mail is in the flow exactly once. Run inside a transaction.
 */
function finishPending(store: Store, messageId: string, unreadState: 'skipped' | 'failed' = 'skipped'): void {
  const deferredAt = store.one<{ deferred: number }>(`SELECT deferred FROM pending WHERE message_id = ?`, messageId)?.deferred ?? 0;
  if (deferredAt > 0) countFlow(store, deferredAt, 'deferred', 'deferred', null, -1);
  store.run(`DELETE FROM pending WHERE message_id = ?`, messageId);
  finishUnread(store, messageId, unreadState);
}

/** Records a skipped mail (and counts it once in the flow). Run inside a transaction. */
function recordSkip(store: Store, id: string, threadId: string, receivedAt: number, now: number, reason: string): void {
  const recorded = store.run(
    `INSERT OR IGNORE INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, unsure_reason, content_cleared) VALUES (?, ?, ?, ?, 'skipped', 'skip', ?, 1)`,
    id,
    threadId,
    receivedAt,
    now,
    reason,
  );
  if (recorded > 0) countFlow(store, now, 'skipped', skipOutcome(reason), null);
  finishPending(store, id, reason === 'unreadable' ? 'failed' : 'skipped');
}

interface Gathered { readonly features: Features; readonly senderHash: string; readonly summary: string; }

async function gather(read: ReadMessage): Promise<Gathered> {
  const masked = await features(read);
  return { features: masked, senderHash: await senderHash(masked.senderAddress), summary: summaryOf(masked, EXAMPLE_SUMMARY_CHARS) };
}

function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

interface PreparedMail { readonly read: ReadMessage; readonly gathered: Awaited<ReturnType<typeof gather>>; readonly priorPriority: string | null; readonly recheck: boolean; readonly unread: boolean; readonly attempts: number; }

async function prepareMail(ctx: MailContext, messageId: string, attempts: number): Promise<PreparedMail | MailOutcome> {
  const { store, gmail } = ctx;
  const unread = isUnreadPending(store, messageId);
  const recheckFallback = unread && unreadRechecksFallback(store);
  const recheckInitial100 = unread && unreadRechecksInitial100(store);
  if (unread && !writesLive(store, ctx.ceiling)) {
    // A paused explicit batch must retain its members without reading their contents.
    ctx.transact(() => store.run(`UPDATE pending SET not_before = ? WHERE message_id = ?`, ctx.now() + ALARM_IDLE_MS, messageId));
    return 'later';
  }
  let read;
  try {
    const { message, metadataOnly } = await gmail.message(messageId);
    read = readMessage(message, metadataOnly);
  } catch (error) {
    return readFailed(ctx, messageId, attempts, error);
  }
  const now = ctx.now();
  if (read === null) {
    ctx.transact(() => { recordSkip(store, messageId, messageId, 0, now, 'unreadable'); });
    return 'skipped';
  }
  if ((!recheckInitial100 && (!read.labelIds.includes('UNREAD') || (!unread && !read.labelIds.includes('INBOX')))) || read.labelIds.some((label) => SKIP_LABELS.has(label))) {
    ctx.transact(() => { recordSkip(store, read.id, read.threadId, read.receivedAt, now, 'not_inbox'); });
    return 'skipped';
  }
  const priorityIds = priorityGmailIds(store);
  const currentPriorities = read.labelIds.filter(id => priorityIds.has(id));
  const priorPriority = recheckInitial100 ? decisionForRecheck(store, messageId)?.label_id : recheckFallback ? P1_ID : null;
  if (recheckInitial100 && (priorPriority == null || currentPriorities.length !== 1 || currentPriorities[0] !== store.label(priorPriority)?.gmail_id)) {
    ctx.transact(() => { finishPending(store, messageId); });
    return 'skipped';
  }
  if (recheckFallback && (!fallbackP1(store, messageId) || currentPriorities.length !== 1 || currentPriorities[0] !== store.label(P1_ID)?.gmail_id)) {
    ctx.transact(() => { finishPending(store, messageId); });
    return 'skipped';
  }
  if (!recheckFallback && !recheckInitial100 && currentPriorities.length > 0) {
    ctx.transact(() => { finishPending(store, messageId); });
    return 'skipped';
  }
  // No backfill: a lost cursor's resync lists the inbox of the last two days, which may reach back before the install.
  const installedAt = Number(store.getMeta('installed_at') ?? '0');
  if (!unread && read.receivedAt > 0 && read.receivedAt < priorityStartedAt(store)) {
    ctx.transact(() => { recordSkip(store, read.id, read.threadId, read.receivedAt, now, 'before_install'); });
    return 'skipped';
  }
  if (!unread && installedAt > 0 && read.receivedAt > 0 && read.receivedAt < installedAt - INSTALL_GRACE_MS) {
    ctx.transact(() => { recordSkip(store, read.id, read.threadId, read.receivedAt, now, 'before_install'); });
    return 'skipped';
  }
  // Ineligible mail can leave the batch even when the Gmail write allowance is exhausted.
  if (unread || writesLive(store, ctx.ceiling)) {
    const at = ctx.now();
    const settings = readSettings(store);
    const dayFull = store.usage(utcDay(at)).applied + mergeWritesToday(store, utcDay(at)) >= settings.dailyWriteLimit;
    if (dayFull || ctx.counter.runWrites >= settings.runWriteLimit) {
      ctx.transact(() => store.run(`UPDATE pending SET not_before = ? WHERE message_id = ?`, dayFull ? nextUtcMidnight(at) : at + ALARM_IDLE_MS, messageId));
      return 'later';
    }
  }

  return { read, gathered: await gather(read), priorPriority: priorPriority ?? null, recheck: recheckFallback || recheckInitial100, unread, attempts };
}

async function applyClassification(ctx: MailContext, prepared: PreparedMail, result: ClaudeItem, provider: 'claude' | 'codex', model: string, writeNow = true): Promise<MailOutcome> {
  const { store } = ctx;
  const { read, gathered: g, priorPriority, recheck, unread } = prepared;
  const now = ctx.now();
  const labelId = result.bucket.toLowerCase();
  // The outcome: a confident label is written to Gmail while live is in force with a write grant (the caps are the
  // gate's, right before the write: a write it refuses stays recorded, like any failed write), else only recorded.
  const labels = store.labels();
  const label = labels.find((item) => item.id === labelId);
  const unchangedPriority = recheck && label !== undefined && label.id === priorPriority;
  // A label missing from Gmail, or whose path names a Gmail label not its own, writes nothing until the owner acts.
  const apply = !unchangedPriority && label !== undefined && label.gmail_state !== 'missing' && label.gmail_name_taken !== 1 && writesLive(store, ctx.ceiling);
  // Fixed cadence: P1 remains visible in Inbox, P2-P4 are archived.
  const archive = label?.id !== P1_ID;
  const intent: { id: string | null } = { id: null };
  ctx.transact(() => {
    // Only a validated P1-P4 result reaches a recorded decision.
    const outcome = apply || unchangedPriority ? 'applied' : 'suggested';
    recordDecision(store, read, g, now, { outcome, label: labelId, decider: provider, model, reason: '', modelReason: mask(result.reason, 300) });
    store.addUsage(utcDay(now), 'decided', 1);
    if (unchangedPriority) setCurrentLabels(store, read.id, [label.id]);
    else countFlow(store, now, stageOf(provider), apply ? (archive ? 'archived' : 'kept_in_inbox') : 'suggested', labelId);
    if (apply) intent.id = intend(store, read.id, label, archive, 'auto', now, read.labelIds);
    if (unread && intent.id !== null) store.run(`UPDATE unread_batch SET ledger_id = ? WHERE message_id = ?`, intent.id, read.id);
    finishPending(store, read.id, unchangedPriority ? 'skipped' : 'failed');
  });
  const ledgerId = intent.id;
  if (ledgerId !== null && writeNow) {
    // A write the gate refuses, or Gmail refuses for good, fails its row and stays recorded (writes.ts fail).
    const outcome = await executeWrites(writeContext(ctx), [ledgerId], 1);
    ctx.counter.applied += outcome.applied;
    if (outcome.stopped) return 'stop';
  }
  return 'decided';
}

interface Recorded {
  readonly outcome: 'applied' | 'suggested' | 'unsure';
  readonly label: string | null;
  readonly decider: 'claude' | 'codex' | 'none';
  readonly model: string;
  readonly reason: string;
  readonly modelReason?: string;
}

/** Masked decision content follows the existing 14-day retention; probabilities remain absent for Claude. */
function recordDecision(store: Store, read: ReadMessage, gathered: Gathered, now: number, result: Recorded): void {
  store.run(`INSERT OR REPLACE INTO decisions
    (message_id, thread_id, received_at, decided_at, outcome, label_id, top_label, decider, unsure_reason,
      model, model_reason, sender_hash, sender_domain, subject, sender, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    read.id, read.threadId, read.receivedAt, now, result.outcome, result.label, result.label, result.decider,
    result.reason, result.model, result.modelReason ?? null, gathered.senderHash || null,
    gathered.features.senderDomain || null, gathered.features.subject, gathered.features.sender, gathered.summary);
}

function writeContext(ctx: Pick<MailContext, 'store' | 'gmail' | 'budget' | 'now' | 'transact' | 'gate'>): WriteContext {
  return { store: ctx.store, gmail: ctx.gmail, budget: ctx.budget, now: ctx.now, transact: ctx.transact, gate: ctx.gate };
}

// ---- daily work -------------------------------------------------------------------------------------------------------------

/**
 * The retention cleanup (store.ts prune), once per UTC day and in every mode: the 14 days of content hold even while
 * the mode is off, when nothing else runs. No Google call. Run inside a transaction.
 */
export function retain(store: Store, now: number): void {
  const day = utcDay(now);
  if (store.getMeta('pruned_day') === day) return;
  const limitedMonth = store.getMeta('claude_limited_month');
  if (store.getMeta('claude_error') === 'claude_spend_limit' && limitedMonth !== null && limitedMonth < day.slice(0, 7)) store.deleteMeta('claude_error');
  store.prune(now);
  store.setMeta('pruned_day', day);
}

// ---- the pass --------------------------------------------------------------------------------------------------------------

export async function runPass(deps: PassDeps): Promise<PassResult> {
  const { store, transact } = deps;
  const now = deps.now();
  const settings = readSettings(store);
  const mode = effectiveMode(settings, modeCeiling(deps.env));
  const provider = settings.classificationProvider;
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
  let decided = 0;
  let applied = 0;
  let deferred = 0;
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
    const counter = { runWrites: 0, applied: 0 };
    const gate = alarmGate(store, ceiling, counter, deps.now);
    const retried = await executeWrites({ store, gmail, budget, now: deps.now, transact, gate }, null, 5);
    applied += retried.applied;
    if (retried.stopped) throw new Error('stopped');

    const ctx: MailContext = { store, gmail, budget, now: deps.now, transact, ceiling, gate, counter };
    const nextModelAt = Number(store.getMeta('next_model_at') ?? '0');
    const month = utcDay(deps.now()).slice(0, 7);
    const providerLimited = store.getMeta('claude_limited_month') === month;
    if (provider === 'claude' && (providerLimited || store.claudeUsage(month).cost_micros >= CLAUDE_MONTHLY_LIMIT_MICROS)) {
      deferred = deferModel(store, nextUtcMonth(deps.now()), deps.now(), transact);
      code = 'claude_spend_limit';
    } else if (deps.now() >= nextModelAt) {
      const prepared: PreparedMail[] = [];
      for (const item of store.due(deps.now(), DRAIN_MAX)) {
        if (!budget.has(MAIL_SUBREQUESTS + 1)) break;
        const result = await prepareMail(ctx, item.message_id, item.attempts);
        if (typeof result !== 'string') prepared.push(result);
      }
      if (prepared.length > 0) {
        const at = deps.now();
        const prompt = readClassificationPrompt(store);
        const recentCache = Number(store.getMeta('claude_prompt_cache_at') ?? 0) > at - CLAUDE_CACHE_TTL_MS;
        const cachePrompt = store.count(`SELECT count(*) AS n FROM pending WHERE not_before <= ?`, at) > prepared.length || recentCache;
        let answer: ClaudeBatchResult | CodexBatchResult | null = null;
        try {
          budget.left--;
          const emails: ClaudeEmail[] = prepared.map(({ read, gathered: g }) => ({
            id: read.id, subject: g.features.subject, sender: g.features.sender,
            received_at: new Date(read.receivedAt || at).toISOString(), evaluated_at: new Date(at).toISOString(),
            time_zone: 'America/Los_Angeles', body: Array.from(g.features.body).slice(0, 12000).join(''),
            body_truncated: read.bodyTruncated === true || Array.from(read.body).length > 12000,
          }));
          if (provider === 'codex') {
            const recorded = await classifyWithCodex(deps.env, emails, deps.fetch, { basePrompt: prompt.baseText, personalRules: prompt.personalRules });
            transact(() => {
              store.addCodexUsage(utcDay(at), true, recorded.usageAvailable ? recorded : undefined);
              store.setMeta('codex_last_request_at', String(at));
              store.setMeta('codex_usage_last_request_at', String(at));
              store.setMeta('codex_last_success_at', String(at));
              store.deleteMeta('codex_error');
            });
            answer = recorded;
          } else {
            const recorded = await classifyEmails(deps.env.ANTHROPIC_API_KEY ?? '', emails, deps.fetch, { basePrompt: prompt.baseText, personalRules: prompt.personalRules, cachePrompt });
            answer = recorded;
            transact(() => {
              store.addClaudeUsage(utcDay(at), recorded);
              if (recorded.cacheWriteTokens + recorded.cacheReadTokens > 0) store.setMeta('claude_prompt_cache_at', String(at));
              store.setMeta('claude_last_request_at', String(at));
              store.setMeta('claude_last_success_at', String(at));
              store.deleteMeta('claude_error');
            });
          }
        } catch (error) {
          const errorCode = error instanceof ClaudeError || error instanceof CodexError ? error.code : `${provider}_unexpected`;
          transact(() => {
            if (error instanceof CodexError && error.attempted) {
              store.addCodexUsage(utcDay(at), false, error.usage);
              store.setMeta('codex_last_request_at', String(at));
              store.setMeta('codex_usage_last_request_at', String(at));
            }
            if (error instanceof ClaudeError && error.usage !== undefined) {
              store.addClaudeUsage(utcDay(at), error.usage);
              if (error.usage.cacheWriteTokens + error.usage.cacheReadTokens > 0) store.setMeta('claude_prompt_cache_at', String(at));
              store.setMeta('claude_last_request_at', String(at));
            }
            store.pushError(errorCode);
            store.setMeta(`${provider}_error`, errorCode);
            if (error instanceof ClaudeBudgetError) store.setMeta('claude_limited_month', month);
            if (!(error instanceof ClaudeBudgetError) && !(error instanceof ClaudeConfigurationError) && !(error instanceof CodexConfigurationError) && errorCode !== 'codex_quota') {
              for (const item of prepared) {
                if (item.attempts + 1 >= (/^(claude|codex)_bad_/.test(errorCode) || errorCode === 'claude_incomplete' || errorCode === 'codex_response_too_large' ? BAD_ANSWER_ATTEMPTS_MAX : MAIL_ATTEMPTS_MAX)) {
                  if (!item.recheck || store.decision(item.read.id) === undefined) {
                    recordDecision(store, item.read, item.gathered, at, { outcome: 'unsure', label: null, decider: 'none', model: '', reason: 'model_unavailable' });
                    store.addUsage(utcDay(at), 'decided', 1);
                    store.addUsage(utcDay(at), 'unsure', 1);
                    countFlow(store, at, 'no_model', 'unsure', null);
                  }
                  finishPending(store, item.read.id, 'failed');
                }
                else postpone(store, item.read.id, item.attempts, at);
              }
            }
          });
          if (error instanceof ClaudeBudgetError) deferred = deferModel(store, nextUtcMonth(at), at, transact);
          else if (errorCode === 'codex_quota') deferred = deferModel(store, at + HOUR, at, transact);
          code = errorCode;
        }
        let stopped = false;
        if (answer !== null) for (const item of answer.items) {
          const original = prepared.find(value => value.read.id === item.id);
          if (original === undefined) continue;
          const outcome = await applyClassification(ctx, original, item, provider, answer.model, !stopped);
          decided++;
          if (outcome === 'stop') { stopped = true; code = 'gmail_stopped'; }
        }
      }
      // One persisted cadence: keep draining the pending backlog, then wait about an hour before a new batch starts.
      const pending = store.count(`SELECT count(*) AS n FROM pending`);
      transact(() => { store.setMeta('next_model_at', String(pending > 0 ? Math.max(deps.now(), store.one<{ at: number }>(`SELECT min(not_before) AS at FROM pending`)?.at ?? deps.now()) : deps.now() + HOUR)); });
      if (pending > 0 && store.due(deps.now(), 1).length > 0 && code === 'ok') backlog = true;
    }
    applied += counter.applied;

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
