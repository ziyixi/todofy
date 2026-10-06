/**
 * The alarm's work (../../docs/design.md §4-§7), one pass:
 *
 * 1. the mode in force (off: nothing), the Gmail session (no secrets, or a failed grant: no Google call);
 * 2. sync: Gmail's history after the stored cursor, a few pages; new INBOX mails go to `pending` and owned-label changes
 *    on decided mails to `feedback`, in the same transaction that advances the cursor. The first pass only stores the
 *    mailbox's current historyId: no backfill. A lost cursor (404) is a bounded resync of the inbox's last two days;
 * 3. feedback: the queued label changes become verdicts, examples and rule proposals (feedback.ts);
 * 4. leftover writes (retries), each through the same gate as a new write;
 * 5. drain: at most DRAIN_MAX pending mails, while the subrequest budget lasts: read, skip what is not the owner's
 *    incoming mail, mask, decide (rules, neighbours, Clef), record, and in live mode write through the ledger;
 * 6. embeddings of new examples, and once per UTC day: weak accepts, the audit sample, live gating and the retention
 *    cleanup.
 *
 * Whether a write may go out is read again right before each one (alarmGate): the mode in force, the breaker, the
 * label's switches and the caps, so a breaker tripped by this pass's own writes, or the owner's shadow chosen while it
 * runs, stops the rest of the pass.
 *
 * Workers AI's daily quota used up defers the waiting mails to the next UTC day (never a failure); past
 * FLASH_SWITCH_SHARE of the owner's neuron budget the day's remaining mails use Clef-flash, and past the budget they wait.
 * The pass answers when it wants to run again: soon while a backlog waits, else ALARM_IDLE_MS.
 */
import { labelStats } from './accuracy.ts';
import { AiError, AiQuotaError, cutTokens, decide as askClef, embed, toBlob, type ClefOption, type ClefState } from './ai.ts';
import { candidatesOf, clefDecision, neighbourDecision, ruleDecision, type Decision, type LabelFacts } from './decide.ts';
import { dmarcAligned } from './dmarc.ts';
import { modeCeiling, type AiRunner, type Env, type ModeName } from './env.ts';
import { embeddedCount, nearest, storeEmbedding, unembedded } from './examples.ts';
import { applyFeedback } from './feedback.ts';
import { GmailRefused, GoogleError, isMessageId, type AccessToken, type GmailClient, type HistoryPage } from './gmail.ts';
import { timeId } from './ids.ts';
import {
  ALARM_BACKLOG_MS,
  ALARM_IDLE_MS,
  ALARM_SUBREQUESTS,
  AUDITS_PER_DAY,
  BAD_ANSWER_ATTEMPTS_MAX,
  CLEF,
  CLEF_FLASH,
  DAY,
  DRAIN_MAX,
  EMBED_BATCH,
  EXAMPLE_SUMMARY_CHARS,
  FLASH_SWITCH_SHARE,
  HISTORY_PAGE_SIZE,
  HISTORY_PAGES_MAX,
  INSTALL_GRACE_MS,
  MAIL_ATTEMPTS_MAX,
  MAIL_SUBREQUESTS,
  NEIGHBOUR_TOKENS_MAX,
  NEIGHBOURS,
  RESYNC_MAX,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  SHARE_JUMP,
  SHARE_MAX,
  SHARE_MIN_WRITES,
  WEAK_ACCEPT_MS,
  WEAK_EXAMPLES_BELOW,
} from './limits.ts';
import { features, summaryOf, type Features } from './mask.ts';
import { readMessage } from './mime.ts';
import { Budget, noteGoogleError, noteTokenOk, openSession, writeScope } from './session.ts';
import { effectiveMode, readSettings, tripBreaker, type SettingsValue } from './settings.ts';
import { utcDay, type LabelRow, type Store } from './store.ts';
import { executeWrites, intend, type WriteContext, type WriteGate } from './writes.ts';
import { putExample } from './examples.ts';

/** Labels Gmail puts on mail that is not the owner's incoming mail: never decided. */
const SKIP_LABELS = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT']);

export interface PassDeps {
  readonly store: Store;
  readonly env: Env;
  readonly fetch: typeof fetch;
  readonly ai: AiRunner | null;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
  /** The access token cached by the object between passes, and where to put a new one. */
  readonly token: AccessToken | null;
  readonly saveToken: (token: AccessToken | null) => void;
  /** Home's guard is shed: Clef-flash only, no embedding rebuild, no audit. */
  readonly shed: boolean;
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

/** The decision model for the next call, or null when the owner's neuron budget is used up today. */
export function chooseModel(store: Store, settings: SettingsValue, shed: boolean, now: number): string | null {
  const used = store.usage(utcDay(now)).neurons;
  if (used >= settings.dailyNeuronBudget) return null;
  return shed || used >= FLASH_SWITCH_SHARE * settings.dailyNeuronBudget ? CLEF_FLASH : CLEF;
}

function labelFacts(labels: readonly LabelRow[]): Map<string, LabelFacts> {
  return new Map(labels.map((label) => [label.id, { id: label.id, enabled: label.enabled === 1, trust: label.trust === 1, threshold: label.threshold }]));
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

// ---- one mail -----------------------------------------------------------------------------------------------------------

interface MailContext {
  readonly store: Store;
  readonly gmail: GmailClient;
  readonly ai: AiRunner | null;
  readonly budget: Budget;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
  readonly settings: SettingsValue;
  /** The deployment's MODE ceiling (the mode in force is read again before each write). */
  readonly ceiling: ModeName;
  readonly shed: boolean;
  readonly gate: WriteGate;
  /** Writes this pass let through its gate (the run cap), and the ones Gmail applied. */
  readonly counter: { runWrites: number; applied: number };
}

/** `retry`: Workers AI failed, stop calling it this pass; `later`: this mail waits, go on with the next. */
type MailOutcome = 'decided' | 'skipped' | 'gone' | 'deferred' | 'retry' | 'later' | 'stop';

/** The wait after a mail's `attempts`-th failure: RETRY_BASE_MS doubling, at most RETRY_MAX_MS. */
export function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

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
 * its label enabled and live, and stays within the caps: passing the daily or the run cap trips the breaker, which
 * makes every later write of the pass (and of the next ones) fail this gate. An owner's row (a review choice whose
 * first try failed) is not capped.
 */
export function alarmGate(store: Store, ceiling: ModeName, counter: { runWrites: number }, now: () => number): WriteGate {
  return (row, label) => {
    if (!writesLive(store, ceiling)) return 'mode_changed';
    if (row.origin === 'owner') return null;
    if (label.enabled !== 1 || label.live !== 1) return 'label_not_live';
    const settings = readSettings(store);
    const at = now();
    if (store.usage(utcDay(at)).applied >= settings.dailyWriteLimit) {
      tripBreaker(store, 'daily_limit', at);
      return 'daily_limit';
    }
    if (counter.runWrites >= settings.runWriteLimit) {
      tripBreaker(store, 'run_limit', at);
      return 'run_limit';
    }
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
    ctx.transact(() => store.run(`DELETE FROM pending WHERE message_id = ?`, messageId));
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

function recordSkip(store: Store, id: string, threadId: string, receivedAt: number, now: number, reason: string): void {
  store.run(
    `INSERT OR IGNORE INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, unsure_reason, content_cleared) VALUES (?, ?, ?, ?, 'skipped', 'skip', ?, 1)`,
    id,
    threadId,
    receivedAt,
    now,
    reason,
  );
  store.run(`DELETE FROM pending WHERE message_id = ?`, id);
}

/** Whitespace runs as one space, for comparing Gmail's snippet with the body it was cut from. */
function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The model's state of a mail: masked text, a code for the address, and the neighbours' short texts. Gmail's snippet
 * is the start of the body, so it is sent only when it says something the body does not (a metadata-only read has no
 * body): up to 300 characters of input saved on every call.
 */
export function clefState(f: Features, neighbours: readonly { label: string; summary: string }[]): ClefState {
  const head = fold(f.snippet).slice(0, 80);
  const snippetInBody = f.body !== '' && head !== '' && fold(f.body).startsWith(head);
  return {
    from: f.sender,
    to: f.toCode,
    list: f.listId === '' ? '' : 'mailing list',
    subject: f.subject,
    snippet: snippetInBody ? '' : f.snippet,
    body: f.body,
    gmail_category: f.category,
    similar_examples: neighbours.map((n) => ({ label: n.label, text: cutTokens(n.summary, NEIGHBOUR_TOKENS_MAX) })),
  };
}

async function decideMail(ctx: MailContext, messageId: string, attempts: number): Promise<MailOutcome> {
  const { store, gmail } = ctx;
  let read;
  try {
    const { message } = await gmail.message(messageId);
    read = readMessage(message);
  } catch (error) {
    return readFailed(ctx, messageId, attempts, error);
  }
  const now = ctx.now();
  if (read === null) {
    ctx.transact(() => { recordSkip(store, messageId, messageId, 0, now, 'unreadable'); });
    return 'skipped';
  }
  const owned = store.ownedGmailIds();
  if (!read.labelIds.includes('INBOX') || read.labelIds.some((label) => SKIP_LABELS.has(label))) {
    ctx.transact(() => { recordSkip(store, read.id, read.threadId, read.receivedAt, now, 'not_inbox'); });
    return 'skipped';
  }
  // No backfill: a lost cursor's resync lists the inbox of the last two days, which may reach back before the install.
  const installedAt = Number(store.getMeta('installed_at') ?? '0');
  if (installedAt > 0 && read.receivedAt > 0 && read.receivedAt < installedAt - INSTALL_GRACE_MS) {
    ctx.transact(() => { recordSkip(store, read.id, read.threadId, read.receivedAt, now, 'before_install'); });
    return 'skipped';
  }
  // One label per conversation: a thread that carries an owned label now keeps it. current_labels follows mailsort's
  // writes and undos and the owner's own changes in Gmail, so a conversation whose label was undone or removed is
  // decided again, and a shadow verdict (which writes nothing) does not hide the rest of its conversation.
  const threadSorted =
    read.labelIds.some((label) => owned.has(label)) || store.count(`SELECT count(*) AS n FROM decisions WHERE thread_id = ? AND current_labels != '[]'`, read.threadId) > 0;
  if (threadSorted) {
    ctx.transact(() => { recordSkip(store, read.id, read.threadId, read.receivedAt, now, 'thread_sorted'); });
    return 'skipped';
  }

  const f = await features(read);
  const dmarc = dmarcAligned(read.headers.authenticationResults, f.senderDomain);
  const labels = store.labels();
  const facts = labelFacts(labels);
  const enabled = labels.filter((label) => label.enabled === 1);
  const summary = summaryOf(f, EXAMPLE_SUMMARY_CHARS);
  const day = utcDay(now);

  let decision: Decision;
  let model = '';
  let probabilities: Record<string, number> = {};
  let suspicious: number | null = null;
  let bulk: number | null = null;
  const rule = enabled.length === 0 ? null : ruleDecision(store.matchingRules(f), facts, dmarc);
  if (enabled.length === 0) {
    decision = { confident: false, top: null, decider: 'none', reason: 'no_labels', candidates: [] };
  } else if (rule !== null) {
    decision = { confident: true, label: rule.label, decider: 'rule', ruleId: rule.ruleId, candidates: [{ label: rule.label, probability: 1 }] };
  } else {
    if (ctx.ai === null) {
      decision = { confident: false, top: null, decider: 'none', reason: 'model_unavailable', candidates: [] };
    } else {
      const chosen = chooseModel(store, ctx.settings, ctx.shed, now);
      if (chosen === null) return 'deferred';
      let neighbours: { label: string; summary: string; similarity: number }[] = [];
      try {
        if (embeddedCount(store) > 0) {
          const { vectors, neurons } = await embed(ctx.ai, [summary]);
          ctx.budget.left -= 1;
          ctx.transact(() => {
            store.addUsage(day, 'ai_calls', 1);
            store.addUsage(day, 'neurons', neurons);
          });
          const vector = vectors[0];
          if (vector !== undefined) neighbours = nearest(store, vector, NEIGHBOURS, new Set(enabled.map((label) => label.id)));
        }
        const shortcut = neighbourDecision(neighbours, facts, dmarc);
        if (shortcut !== null) {
          decision = { confident: true, label: shortcut, decider: 'neighbours', candidates: [{ label: shortcut, probability: neighbours[0]?.similarity ?? 1 }] };
        } else {
          const options: ClefOption[] = enabled.map((label) => ({ id: label.id, name: label.display_name, description: label.description }));
          const answer = await askClef(ctx.ai, chosen, clefState(f, neighbours), options);
          ctx.budget.left -= 1;
          ctx.transact(() => {
            store.addUsage(day, 'ai_calls', 1);
            store.addUsage(day, 'neurons', answer.neurons);
          });
          model = answer.model;
          probabilities = { ...answer.probabilities };
          suspicious = answer.suspicious;
          bulk = answer.bulk;
          decision = clefDecision(answer, chosen === CLEF_FLASH ? 'clef-flash' : 'clef', facts, ctx.settings.defaultThreshold);
        }
      } catch (error) {
        if (error instanceof AiQuotaError) {
          ctx.transact(() => {
            store.setQuotaExhausted(day);
            store.pushError('ai_quota_exhausted');
          });
          return 'deferred';
        }
        const code = error instanceof AiError ? error.code : 'ai_unexpected';
        // An answer this code refused is about this mail: a few tries, and the pass goes on. Anything else is an
        // outage: the mail waits (backoff, about five hours in all) and the pass stops calling the model.
        const badAnswer = code.startsWith('clef_bad');
        ctx.transact(() => { store.pushError(code); });
        if (attempts + 1 < (badAnswer ? BAD_ANSWER_ATTEMPTS_MAX : MAIL_ATTEMPTS_MAX)) {
          ctx.transact(() => { postpone(store, messageId, attempts, now); });
          return badAnswer ? 'later' : 'retry';
        }
        decision = { confident: false, top: null, decider: 'none', reason: 'model_unavailable', candidates: candidatesOf(probabilities) };
      }
    }
  }

  // The outcome: a Gmail write (live in force now, a live label, a write grant), a suggestion, or unsure. The caps are
  // the gate's, right before the write: a write it refuses becomes a suggestion like any failed write.
  const label = decision.confident ? labels.find((item) => item.id === decision.label) : undefined;
  const apply = decision.confident && label !== undefined && label.live === 1 && label.gmail_state !== 'missing' && writesLive(store, ctx.ceiling);
  const versions = Object.fromEntries(enabled.map((item) => [item.id, item.desc_version]));
  const intent: { id: string | null } = { id: null };
  ctx.transact(() => {
    const outcome = apply ? 'applied' : decision.confident ? 'suggested' : 'unsure';
    store.run(
      `INSERT OR REPLACE INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, top_label, decider, unsure_reason, probabilities,
         suspicious, bulk, model, versions, dmarc, sender_address, sender_domain, list_id, delivered_to, subject, sender, summary, current_labels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
      read.id,
      read.threadId,
      read.receivedAt,
      now,
      outcome,
      decision.confident ? decision.label : null,
      decision.confident ? decision.label : decision.top,
      decision.decider,
      decision.confident ? '' : decision.reason,
      JSON.stringify(probabilities),
      suspicious,
      bulk,
      model,
      JSON.stringify(versions),
      dmarc ? 1 : 0,
      f.senderAddress,
      f.senderDomain,
      f.listId,
      f.deliveredTo,
      f.subject,
      f.sender,
      summary,
    );
    if (decision.confident && decision.decider === 'rule' && decision.ruleId !== undefined) store.run(`UPDATE rules SET match_count = match_count + 1 WHERE id = ?`, decision.ruleId);
    store.addUsage(day, 'decided', 1);
    if (!decision.confident) store.addUsage(day, 'unsure', 1);
    if (apply) {
      intent.id = intend(store, read.id, label, true, 'auto', now);
    } else if (decision.confident || decision.reason !== 'no_labels') {
      store.run(
        `INSERT INTO review (id, message_id, kind, state, suggested_label, candidates, decider, unsure_reason, subject, sender, receive_time, create_time)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        timeId(now),
        read.id,
        decision.confident ? 'suggestion' : 'unsure',
        decision.confident ? decision.label : decision.top,
        JSON.stringify(decision.candidates),
        decision.decider,
        decision.confident ? '' : decision.reason,
        f.subject,
        f.sender,
        read.receivedAt,
        now,
      );
    }
    store.run(`DELETE FROM pending WHERE message_id = ?`, read.id);
  });
  const ledgerId = intent.id;
  if (ledgerId !== null) {
    // A write the gate refuses, or Gmail refuses for good, fails its row and becomes a suggestion (writes.ts fail).
    const outcome = await executeWrites(writeContext(ctx), [ledgerId], 1);
    ctx.counter.applied += outcome.applied;
    if (outcome.stopped) return 'stop';
    // May trip the breaker: the gate reads it before the pass's next write.
    if (outcome.applied > 0) ctx.transact(() => { checkLabelShare(store, ctx.now()); });
  }
  return 'decided';
}

function writeContext(ctx: Pick<MailContext, 'store' | 'gmail' | 'budget' | 'now' | 'transact' | 'gate'>): WriteContext {
  return { store: ctx.store, gmail: ctx.gmail, budget: ctx.budget, now: ctx.now, transact: ctx.transact, gate: ctx.gate };
}

/** The breaker's share rule: one label's share of today's writes jumped far above its last week's share. */
export function checkLabelShare(store: Store, now: number): void {
  const dayStart = Math.floor(now / DAY) * DAY;
  const today = store.all<{ label_id: string; n: number }>(`SELECT label_id, count(*) AS n FROM decisions WHERE outcome = 'applied' AND decided_at >= ? GROUP BY label_id`, dayStart);
  const total = today.reduce((sum, row) => sum + row.n, 0);
  if (total < SHARE_MIN_WRITES) return;
  const week = store.all<{ label_id: string; n: number }>(
    `SELECT label_id, count(*) AS n FROM decisions WHERE outcome = 'applied' AND decided_at >= ? AND decided_at < ? GROUP BY label_id`,
    dayStart - 7 * DAY,
    dayStart,
  );
  const weekTotal = week.reduce((sum, row) => sum + row.n, 0);
  // Without a week of writes there is no share to jump from.
  if (weekTotal < 2 * SHARE_MIN_WRITES) return;
  for (const row of today) {
    const share = row.n / total;
    const before = (week.find((item) => item.label_id === row.label_id)?.n ?? 0) / weekTotal;
    if (share > SHARE_MAX && share > SHARE_JUMP * before) {
      tripBreaker(store, 'label_share', now);
      return;
    }
  }
}

// ---- daily work -------------------------------------------------------------------------------------------------------------

/** Weak accepts, the audit sample, live gating and the retention cleanup, once per UTC day. */
export function daily(store: Store, settings: SettingsValue, shed: boolean, now: number): void {
  const day = utcDay(now);
  if (store.getMeta('daily_done') === day) return;
  // Applied labels left alone for WEAK_ACCEPT_MS: a weak confirmation, and an example while the label has few.
  const weak = store.all<{ message_id: string; label_id: string; summary: string | null }>(
    `SELECT d.message_id, d.label_id, d.summary FROM decisions d
     WHERE d.outcome = 'applied' AND d.verdict IS NULL AND d.decided_at <= ? AND d.label_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM ledger l WHERE l.message_id = d.message_id AND l.label_id = d.label_id AND l.state = 'applied' AND l.superseded = 0)
     LIMIT 500`,
    now - WEAK_ACCEPT_MS,
  );
  const counts = store.exampleCounts();
  for (const row of weak) {
    store.run(`UPDATE decisions SET verdict = 'weak', verdict_label = label_id, verdict_source = 'auto', verdict_at = ? WHERE message_id = ?`, now, row.message_id);
    const count = counts.get(row.label_id) ?? 0;
    if (row.summary !== null && row.summary !== '' && count < WEAK_EXAMPLES_BELOW && store.one(`SELECT 1 AS x FROM examples WHERE message_id = ?`, row.message_id) === undefined) {
      putExample(store, row.message_id, row.label_id, row.summary, 'weak_accept', now);
      counts.set(row.label_id, count + 1);
    }
  }
  // The audit: a few applied mails of the last three days, at random, into the review queue.
  if (!shed) {
    const sample = store.all<{ message_id: string; label_id: string; subject: string; sender: string; received_at: number }>(
      `SELECT message_id, label_id, subject, sender, received_at FROM decisions
       WHERE outcome = 'applied' AND verdict IS NULL AND content_cleared = 0 AND decided_at >= ?
         AND NOT EXISTS (SELECT 1 FROM review r WHERE r.message_id = decisions.message_id)
       ORDER BY random() LIMIT ?`,
      now - 3 * DAY,
      AUDITS_PER_DAY,
    );
    for (const row of sample) {
      store.run(
        `INSERT INTO review (id, message_id, kind, state, suggested_label, candidates, decider, unsure_reason, subject, sender, receive_time, create_time)
         VALUES (?, ?, 'audit', 'pending', ?, ?, 'audit', '', ?, ?, ?, ?)`,
        timeId(now),
        row.message_id,
        row.label_id,
        JSON.stringify([{ label: row.label_id, probability: 1 }]),
        row.subject,
        row.sender,
        row.received_at,
        now,
      );
    }
  }
  // Live gating: a live label whose precision bound fell below the target after a correction goes back to shadow.
  const live = store.all<LabelRow>(`SELECT * FROM labels WHERE live = 1`);
  const stats = labelStats(store, live.map((label) => label.id), now);
  for (const label of live) {
    const bound = stats.get(label.id)?.lowerBound ?? 0;
    const corrected = store.count(`SELECT count(*) AS n FROM decisions WHERE label_id = ? AND verdict = 'corrected' AND verdict_at >= ?`, label.id, label.live_since ?? 0);
    if (bound < settings.precisionTarget && corrected > 0) {
      store.run(`UPDATE labels SET live = 0, live_since = NULL WHERE id = ?`, label.id);
      store.touchLabel(label.id, now);
      store.pushError('label_live_revoked');
      // ops-v1 shows `label_live_revoked` for a day after the newest revocation.
      store.setMeta('revoked_at', String(now));
    }
  }
  store.prune(now);
  store.setMeta('daily_done', day);
}

// ---- the pass --------------------------------------------------------------------------------------------------------------

export async function runPass(deps: PassDeps): Promise<PassResult> {
  const { store, transact } = deps;
  const now = deps.now();
  const settings = readSettings(store);
  const mode = effectiveMode(settings, modeCeiling(deps.env));
  const idle = now + ALARM_IDLE_MS;
  transact(() => { store.setMeta('last_alarm_at', String(now)); });
  if (mode === 'off') return { next: idle, mode, synced: 0, decided: 0, applied: 0, deferred: 0, code: 'off' };

  const budget = new Budget(ALARM_SUBREQUESTS);
  const session = await openSession({ store, env: deps.env, fetch: deps.fetch, now: deps.now, budget, token: deps.token });
  if ('reason' in session) {
    transact(() => { daily(store, settings, deps.shed, now); });
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
    const owned = new Map(store.labels().flatMap((label) => (label.gmail_state === 'linked' && label.gmail_id !== null ? [[label.gmail_id, label.id] as const] : [])));
    transact(() => applyFeedback(store, owned, deps.now()));

    // Retries of writes an earlier pass left `intended` come before new decisions, through the same gate and counted
    // against the same run cap.
    const ceiling = modeCeiling(deps.env);
    const counter = { runWrites: 0, applied: 0 };
    const gate = alarmGate(store, ceiling, counter, deps.now);
    const retried = await executeWrites({ store, gmail, budget, now: deps.now, transact, gate }, null, 5);
    applied += retried.applied;
    if (retried.stopped) throw new Error('stopped');

    const ctx: MailContext = { store, gmail, ai: deps.ai, budget, now: deps.now, transact, settings, ceiling, shed: deps.shed, gate, counter };
    const due = store.due(now, DRAIN_MAX);
    for (const item of due) {
      if (!budget.has(MAIL_SUBREQUESTS)) {
        backlog = true;
        break;
      }
      const outcome = await decideMail(ctx, item.message_id, item.attempts);
      if (outcome === 'decided') decided++;
      if (outcome === 'deferred') {
        // The quota or the owner's budget is used up today: every waiting mail waits for the next UTC day.
        const until = nextUtcMidnight(deps.now());
        deferred = transact(() => store.run(`UPDATE pending SET not_before = ? WHERE not_before < ?`, until, until));
        code = 'deferred';
        break;
      }
      if (outcome === 'retry' || outcome === 'stop') break;
    }
    applied += counter.applied;
    if (store.due(deps.now(), 1).length > 0) backlog = true;

    // New examples' embeddings, a batch per pass (not while shed: they can wait).
    if (deps.ai !== null && !deps.shed && budget.has(1) && chooseModel(store, settings, false, deps.now()) !== null) {
      const batch = unembedded(store, EMBED_BATCH);
      if (batch.length > 0) {
        try {
          const { vectors, neurons } = await embed(deps.ai, batch.map((item) => item.summary));
          transact(() => {
            batch.forEach((item, index) => {
              const vector = vectors[index];
              if (vector !== undefined) storeEmbedding(store, item.id, toBlob(vector));
            });
            store.addUsage(utcDay(deps.now()), 'ai_calls', 1);
            store.addUsage(utcDay(deps.now()), 'neurons', neurons);
          });
          if (unembedded(store, 1).length > 0) backlog = true;
        } catch (error) {
          transact(() => { store.pushError(error instanceof AiQuotaError ? 'ai_quota_exhausted' : error instanceof AiError ? error.code : 'embedding_unexpected'); });
          if (error instanceof AiQuotaError) transact(() => { store.setQuotaExhausted(utcDay(deps.now())); });
        }
      }
    }
    if (store.count(`SELECT count(*) AS n FROM ledger WHERE state IN ('intended', 'undo_intended')`) > 0) backlog = true;
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
  transact(() => { daily(store, settings, deps.shed, deps.now()); });
  return { next: backlog ? deps.now() + ALARM_BACKLOG_MS : idle, mode, synced, decided, applied, deferred, code };
}
