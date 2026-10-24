/** A single owner-requested unread batch, using the normal pending queue and write ledger. */
import { UnreadClassification_State, UnreadClassificationSchema, type UnreadClassification } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import type { GmailClient } from './gmail.ts';
import { P1_ID, PRIORITY_IDS, priorityStartedAt } from './priority.ts';
import type { DecisionRow, Store } from './store.ts';

interface UnreadScan {
  readonly startedAt: number;
  readonly listed: boolean;
  readonly pageToken?: string;
  readonly recheckFallback: boolean;
  readonly recheckInitial100: boolean;
  readonly recheckAllUnread?: boolean;
}

function scanOf(store: Store): UnreadScan | null {
  const saved = store.getMeta('unread_scan');
  return saved === null ? null : JSON.parse(saved) as UnreadScan;
}

export function unreadProgress(store: Store, now: number): UnreadClassification | undefined {
  const scan = scanOf(store);
  if (scan === null) return undefined;
  const counts = store.one<{ total: number; pending: number; applied: number; skipped: number; failed: number; deferred: number }>(
    `SELECT count(*) AS total,
      coalesce(sum(b.state = 'pending' AND (b.ledger_id IS NULL OR l.state = 'intended')), 0) AS pending,
      coalesce(sum(l.apply_time IS NOT NULL), 0) AS applied,
      coalesce(sum(b.state = 'skipped'), 0) AS skipped,
      coalesce(sum(b.state = 'failed' OR (b.state = 'pending' AND l.state = 'failed')), 0) AS failed,
      coalesce(sum(b.state = 'pending' AND p.not_before > ?), 0) AS deferred
     FROM unread_batch b LEFT JOIN ledger l ON l.id = b.ledger_id LEFT JOIN pending p ON p.message_id = b.message_id`, now,
  );
  const pending = counts?.pending ?? 0;
  let state: UnreadClassification_State = UnreadClassification_State.SCANNING;
  if (scan.listed) state = pending > 0 ? UnreadClassification_State.RUNNING : UnreadClassification_State.COMPLETED;
  return create(UnreadClassificationSchema, {
    name: 'unreadClassification',
    state,
    startedTime: timestampFromMs(scan.startedAt),
    totalCount: counts?.total ?? 0,
    pendingCount: pending,
    appliedCount: counts?.applied ?? 0,
    skippedCount: counts?.skipped ?? 0,
    failedCount: counts?.failed ?? 0,
    deferredCount: counts?.deferred ?? 0,
  });
}

/** Freeze a cohort until every member has a judgement; independent Gmail intents may outlive it. Transactional. */
export function startUnread(store: Store, now: number, recheckFallback = false, recheckInitial100 = false, recheckAllUnread = false): void {
  const previous = unreadProgress(store, now);
  const awaitingJudgement = unreadScanning(store) || store.one(`SELECT 1 AS x FROM unread_batch WHERE state = 'pending' AND ledger_id IS NULL LIMIT 1`) !== undefined;
  if (previous !== undefined && previous.state !== UnreadClassification_State.COMPLETED && awaitingJudgement && !recheckAllUnread) return;
  // An explicit all-unread request supersedes an older unfinished selection, preserving existing write intents.
  if (recheckAllUnread) store.run(`DELETE FROM pending WHERE message_id IN (SELECT message_id FROM unread_batch WHERE ledger_id IS NULL)`);
  store.run(`DELETE FROM unread_batch`);
  store.setMeta('unread_scan', JSON.stringify({ startedAt: now, listed: recheckInitial100, recheckFallback, recheckInitial100, recheckAllUnread } satisfies UnreadScan));
  if (recheckInitial100) {
    // Original successful writes are immutable, including after a later recheck or undo.
    store.run(`INSERT INTO unread_batch (message_id)
      SELECT message_id FROM ledger WHERE origin = 'auto' AND label_id IN ('p1', 'p2', 'p3', 'p4') AND apply_time IS NOT NULL AND create_time >= ?
      GROUP BY message_id ORDER BY min(create_time), message_id LIMIT 100`, priorityStartedAt(store));
    store.run(`INSERT OR IGNORE INTO pending (message_id, added_at) SELECT message_id, ? FROM unread_batch`, now);
  }
}

/** The current assigned priority, excluding decisions explicitly confirmed or corrected by the owner. */
export function decisionForRecheck(store: Store, messageId: string): DecisionRow | undefined {
  const row = store.decision(messageId);
  if (row === undefined || row.label_id === null || !PRIORITY_IDS.has(row.label_id) || row.decided_at < priorityStartedAt(store) ||
    ((row.verdict === 'confirmed' || row.verdict === 'corrected') && (row.verdict_source === 'gmail' || row.verdict_source === 'review'))) return undefined;
  return row;
}

/** A current-era P1 chosen by the uncertainty policy, without an owner's confirmed or corrected verdict. */
export function fallbackP1(store: Store, messageId: string): boolean {
  const row = decisionForRecheck(store, messageId);
  return row?.label_id === P1_ID && ['low_confidence', 'views_disagree', 'no_match'].includes(row.unsure_reason);
}

/** The batch's explicit narrow retry option; older saved batches retain normal unread behavior. */
export function unreadRechecksFallback(store: Store): boolean {
  return scanOf(store)?.recheckFallback === true;
}

export function unreadRechecksInitial100(store: Store): boolean {
  return scanOf(store)?.recheckInitial100 === true;
}

/** One read-only page per alarm. No batch writes start until the complete ID set has been collected. */
export async function scanUnread(store: Store, gmail: GmailClient, now: number, transact: <T>(fn: () => T) => T): Promise<boolean> {
  const scan = scanOf(store);
  if (scan === null || scan.listed) return false;
  const page = await gmail.unreadPage(scan.pageToken);
  transact(() => {
    for (const id of page.ids) {
      if (!scan.recheckFallback || fallbackP1(store, id)) store.run(`INSERT OR IGNORE INTO unread_batch (message_id) VALUES (?)`, id);
    }
    store.setMeta('unread_scan', JSON.stringify({ ...scan, listed: page.nextPageToken === undefined, pageToken: page.nextPageToken }));
    if (page.nextPageToken === undefined) {
      // Explicit backfill includes older decisions; ordinary new-mail enqueue retains its original deduplication.
      store.run(`UPDATE unread_batch SET ledger_id = (SELECT l.id FROM ledger l WHERE l.message_id = unread_batch.message_id AND l.state = 'intended' ORDER BY l.id DESC LIMIT 1)
        WHERE state = 'pending' AND ledger_id IS NULL AND EXISTS (SELECT 1 FROM ledger l WHERE l.message_id = unread_batch.message_id AND l.state = 'intended')`);
      store.run(`INSERT OR IGNORE INTO pending (message_id, added_at) SELECT message_id, ? FROM unread_batch WHERE state = 'pending' AND ledger_id IS NULL`, now);
    }
  });
  return page.nextPageToken !== undefined;
}

/** Only IDs still waiting in this explicit batch may bypass the normal new-mail time/Inbox boundary. */
export function isUnreadPending(store: Store, messageId: string): boolean {
  return store.one(`SELECT 1 AS x FROM unread_batch WHERE message_id = ? AND state = 'pending' AND ledger_id IS NULL`, messageId) !== undefined;
}

/** A skip or failure without a Gmail intent must not look like an applied classification. Transactional. */
export function finishUnread(store: Store, messageId: string, state: 'skipped' | 'failed'): void {
  store.run(`UPDATE unread_batch SET state = ? WHERE message_id = ? AND ledger_id IS NULL`, state, messageId);
}

/** Explicit owner approval to replace existing unread priorities. */
export function unreadRechecksAll(store: Store): boolean {
  return scanOf(store)?.recheckAllUnread === true;
}

/** Whether the frozen batch is still listing Gmail IDs. */
export function unreadScanning(store: Store): boolean {
  const scan = scanOf(store);
  return scan !== null && !scan.listed;
}
