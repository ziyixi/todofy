/** A single owner-requested unread batch, using the normal pending queue and write ledger. */
import { UnreadClassification_State, UnreadClassificationSchema, type UnreadClassification } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import type { GmailClient } from './gmail.ts';
import type { Store } from './store.ts';

interface UnreadScan {
  readonly startedAt: number;
  readonly listed: boolean;
  readonly pageToken?: string;
  /** Set only by the retired one-time recheck batches, whose progress still reports unchanged rechecks. */
  readonly recheckFallback?: boolean;
  readonly recheckInitial100?: boolean;
}

function scanOf(store: Store): UnreadScan | null {
  const saved = store.getMeta('unread_scan');
  return saved === null ? null : JSON.parse(saved) as UnreadScan;
}

export function unreadProgress(store: Store, now: number): UnreadClassification | undefined {
  const scan = scanOf(store);
  if (scan === null) return undefined;
  const counts = store.one<{ total: number; pending: number; applied: number; skipped: number; failed: number; deferred: number; unchanged: number }>(
    `SELECT count(*) AS total,
      coalesce(sum(b.state = 'pending' AND (b.ledger_id IS NULL OR l.state = 'intended')), 0) AS pending,
      coalesce(sum(l.apply_time IS NOT NULL), 0) AS applied,
      coalesce(sum(b.state = 'skipped'), 0) AS skipped,
      coalesce(sum(b.state = 'failed' OR (b.state = 'pending' AND l.state = 'failed')), 0) AS failed,
      coalesce(sum(b.state = 'pending' AND p.not_before > ?), 0) AS deferred,
      coalesce(sum(b.state = 'skipped' AND b.ledger_id IS NULL AND d.decider IN ('claude','codex','openai','google')
        AND d.outcome = 'applied' AND d.decided_at >= ?), 0) AS unchanged
     FROM unread_batch b LEFT JOIN ledger l ON l.id = b.ledger_id LEFT JOIN pending p ON p.message_id = b.message_id
       LEFT JOIN decisions d ON d.message_id = b.message_id`, now, scan.startedAt,
  );
  const pending = counts?.pending ?? 0;
  const unchanged = scan.recheckFallback === true || scan.recheckInitial100 === true ? counts?.unchanged ?? 0 : 0;
  let state: UnreadClassification_State = UnreadClassification_State.SCANNING;
  if (scan.listed) state = pending > 0 ? UnreadClassification_State.RUNNING : UnreadClassification_State.COMPLETED;
  return create(UnreadClassificationSchema, {
    name: 'unreadClassification',
    state,
    startedTime: timestampFromMs(scan.startedAt),
    totalCount: counts?.total ?? 0,
    pendingCount: pending,
    appliedCount: counts?.applied ?? 0,
    // Stored skipped rows include successful unchanged rechecks; keep the API outcomes distinct.
    skippedCount: (counts?.skipped ?? 0) - unchanged,
    unchangedCount: unchanged,
    failedCount: counts?.failed ?? 0,
    deferredCount: counts?.deferred ?? 0,
  });
}

/** An active batch keeps its IDs and progress, including when another request_id is used. Transactional. */
export function startUnread(store: Store, now: number): void {
  const previous = unreadProgress(store, now);
  if (previous !== undefined && previous.state !== UnreadClassification_State.COMPLETED) return;
  store.run(`DELETE FROM unread_batch`);
  store.setMeta('unread_scan', JSON.stringify({ startedAt: now, listed: false } satisfies UnreadScan));
}

/** One read-only page per alarm. No batch writes start until the complete ID set has been collected. */
export async function scanUnread(store: Store, gmail: GmailClient, now: number, transact: <T>(fn: () => T) => T): Promise<boolean> {
  const scan = scanOf(store);
  if (scan === null || scan.listed) return false;
  const page = await gmail.unreadPage(scan.pageToken);
  transact(() => {
    for (const id of page.ids) store.run(`INSERT OR IGNORE INTO unread_batch (message_id) VALUES (?)`, id);
    store.setMeta('unread_scan', JSON.stringify({ ...scan, listed: page.nextPageToken === undefined, pageToken: page.nextPageToken }));
    if (page.nextPageToken === undefined) {
      // Explicit backfill includes older decisions; ordinary new-mail enqueue retains its original deduplication.
      store.run(`INSERT OR IGNORE INTO pending (message_id, added_at) SELECT message_id, ? FROM unread_batch WHERE state = 'pending'`, now);
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

/** A restored batch ends (restore.ts): the mail it still waits for is skipped and nothing more is listed. Transactional. */
export function endUnread(store: Store): void {
  const scan = scanOf(store);
  if (scan === null) return;
  store.run(`UPDATE unread_batch SET state = 'skipped' WHERE state = 'pending' AND ledger_id IS NULL`);
  if (!scan.listed) store.setMeta('unread_scan', JSON.stringify({ ...scan, listed: true, pageToken: undefined }));
}
