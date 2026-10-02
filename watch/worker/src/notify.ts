/**
 * The notification outbox (../../docs/design.md §7) and the seam its sink plugs into. Since W3 the sink is Todofy
 * (todofy.ts: task intents of source SOURCE_WATCH over the TODOFY service binding); without that binding (local
 * development, most workerd tests) there is no sink, the outbox only fills, and the change inbox is how the owner learns
 * of a change.
 *
 * What goes into the outbox, in the same transaction as the state it reports (store.ts `notifications`):
 * - `change_confirmed`: a change became CONFIRMED (its watch's notify policy: `digest` or `urgent`);
 * - `watch_broken`: the third failed check in a row (always `digest`: a broken page is never urgent);
 * - `watch_paused`: the Worker paused a watch after 14 days broken (`digest`).
 *
 * An event carries IDs, a kind and a policy: never a URL, page text or a diff. Delivery is two steps. `take` runs in
 * one transaction with marking the events delivered: the sink freezes what it will send in its own durable inbox (the
 * same SQLite), so an event is never lost and never sent twice whatever fails afterwards. `flush` then does the
 * network part, retrying from that inbox. `pendingCounts` is what ops-v1 reports.
 */
import type { Store } from './store.ts';

export type WatchEventKind = 'change_confirmed' | 'watch_broken' | 'watch_paused';
export type NotifyPolicy = 'digest' | 'urgent';

export interface WatchEvent {
  readonly id: number;
  readonly kind: WatchEventKind;
  readonly watchId: string;
  readonly changeId: string | null;
  readonly policy: NotifyPolicy;
  readonly createdAt: number;
}

/** Which pending events a sink takes now. */
export interface SinkWants {
  /** The urgent events (the sink may still take only some of them). */
  readonly urgent: boolean;
  /** Every pending event, both policies: the daily digest is due. */
  readonly digest: boolean;
}

/** Where the outbox goes (todofy.ts). */
export interface NotificationSink {
  /** What to offer now: urgent events while the sink may send them, and every event when its digest is due. */
  wants(now: number): SinkWants;
  /**
   * Takes `events` over into the sink's own durable inbox, synchronously, inside the transaction that marks them
   * delivered; answers the IDs it took (the others stay pending). Called with no events when the digest is due and
   * nothing waits, so the sink can record that day's digest as done.
   */
  take(events: readonly WatchEvent[], wants: SinkWants, now: number): readonly number[];
  /** Sends what its inbox holds that is due (the network part, after the transaction). */
  flush(now: number): Promise<void>;
  /** When the sink next has work (its digest time, a retry), or null. */
  nextAt(now: number): number | null;
}

/** The most events one delivery hands a sink: the whole outbox for a digest, fewer for urgent ones. */
export const DIGEST_BATCH = 500;
export const URGENT_BATCH = 50;

interface EventRow {
  id: number;
  kind: WatchEventKind;
  watch_id: string;
  change_id: string | null;
  policy: NotifyPolicy;
  created_at: number;
  [column: string]: SqlStorageValue;
}

/** Undelivered events of the given policies, oldest first (the partial index notifications_pending). */
export function pendingEvents(store: Store, policies: readonly NotifyPolicy[], limit: number): WatchEvent[] {
  if (policies.length === 0) return [];
  return store
    .all<EventRow>(
      `SELECT id, kind, watch_id, change_id, policy, created_at FROM notifications
       WHERE delivered_at IS NULL AND policy IN (${policies.map(() => '?').join(', ')}) ORDER BY id LIMIT ?`,
      ...policies,
      limit,
    )
    .map((row) => ({ id: row.id, kind: row.kind, watchId: row.watch_id, changeId: row.change_id, policy: row.policy, createdAt: row.created_at }));
}

/** The outbox rows of `ids` (delivered or not; a pruned one is missing), oldest first: a sink folding an intent. */
export function eventsByIds(store: Store, ids: readonly number[]): WatchEvent[] {
  const out: WatchEvent[] = [];
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const row = store.one<EventRow>(`SELECT id, kind, watch_id, change_id, policy, created_at FROM notifications WHERE id = ?`, id);
    if (row !== undefined) out.push({ id: row.id, kind: row.kind, watchId: row.watch_id, changeId: row.change_id, policy: row.policy, createdAt: row.created_at });
  }
  return out;
}

/** Whether an urgent event waits (at most one row read, through the partial index). */
export function urgentWaiting(store: Store): boolean {
  return store.one<{ id: number }>(`SELECT id FROM notifications WHERE delivered_at IS NULL AND policy = 'urgent' LIMIT 1`) !== undefined;
}

/** Counts of undelivered events by kind and policy (ops-v1). */
export function pendingCounts(store: Store): Record<`${WatchEventKind}_${NotifyPolicy}`, number> {
  const out = { change_confirmed_digest: 0, change_confirmed_urgent: 0, watch_broken_digest: 0, watch_broken_urgent: 0, watch_paused_digest: 0, watch_paused_urgent: 0 };
  for (const row of store.all<{ kind: WatchEventKind; policy: NotifyPolicy; n: number }>(
    `SELECT kind, policy, count(*) AS n FROM notifications WHERE delivered_at IS NULL GROUP BY kind, policy`,
  )) {
    out[`${row.kind}_${row.policy}`] = row.n;
  }
  return out;
}

/**
 * Hands the pending events the sink wants to it and marks what it took, in one transaction, then lets it send. No
 * sink: nothing happens. Returns the events marked delivered.
 */
export async function deliver(store: Store, sink: NotificationSink | null, now: number, transact: <T>(fn: () => T) => T): Promise<number> {
  if (sink === null) return 0;
  const wants = sink.wants(now);
  let marked = 0;
  if (wants.digest || wants.urgent) {
    marked = transact(() => {
      const events = wants.digest ? pendingEvents(store, ['digest', 'urgent'], DIGEST_BATCH) : pendingEvents(store, ['urgent'], URGENT_BATCH);
      if (events.length === 0 && !wants.digest) return 0;
      let count = 0;
      for (const id of new Set(sink.take(events, wants, now))) count += store.run(`UPDATE notifications SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`, now, id);
      return count;
    });
  }
  await sink.flush(now);
  return marked;
}
