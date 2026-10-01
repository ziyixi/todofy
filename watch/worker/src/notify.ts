/**
 * The notification interface (../../docs/design.md §7), the seam step W3 plugs into. Not part of v1's behaviour: v1
 * only fills the outbox; no sink is configured, nothing leaves the object, and the change inbox is how the owner
 * learns of a change.
 *
 * What goes into the outbox, in the same transaction as the state it reports (store.ts `notifications`):
 * - `change_confirmed`: a change became CONFIRMED (its watch's notify policy: `digest` or `urgent`);
 * - `watch_broken`: the third failed check in a row (always `digest`: a broken page is never urgent);
 * - `watch_paused`: the Worker paused a watch after 14 days broken (`digest`).
 *
 * An event carries IDs, a kind and a policy: never a URL, page text or a diff. A sink reads what it needs through the
 * Durable Object (a digest line uses the watch's display name only). W3's sinks: a task intent of kind SOURCE_WATCH to
 * Todofy for `urgent` and the daily digest, and ops-v1 counts for the dashboard (`pendingCounts`).
 */
import type { Store } from './store.ts';

export type WatchEventKind = 'change_confirmed' | 'watch_broken' | 'watch_paused';

export interface WatchEvent {
  readonly id: number;
  readonly kind: WatchEventKind;
  readonly watchId: string;
  readonly changeId: string | null;
  readonly policy: 'digest' | 'urgent';
  readonly createdAt: number;
}

/** Where events go. `deliver` answers the IDs it took over (a sink keeps its own inbox and deduplicates by ID). */
export interface NotificationSink {
  deliver(events: readonly WatchEvent[]): Promise<readonly number[]>;
}

/** The most events one delivery hands a sink. */
export const DELIVERY_BATCH = 50;

/** Undelivered events, oldest first. */
export function pendingEvents(store: Store, limit = DELIVERY_BATCH): WatchEvent[] {
  return store
    .all<{ id: number; kind: WatchEventKind; watch_id: string; change_id: string | null; policy: 'digest' | 'urgent'; created_at: number }>(
      `SELECT id, kind, watch_id, change_id, policy, created_at FROM notifications WHERE delivered_at IS NULL ORDER BY id LIMIT ?`,
      limit,
    )
    .map((row) => ({ id: row.id, kind: row.kind, watchId: row.watch_id, changeId: row.change_id, policy: row.policy, createdAt: row.created_at }));
}

/** Counts of undelivered events by kind and policy (ops-v1, W3). */
export function pendingCounts(store: Store): Record<`${WatchEventKind}_${'digest' | 'urgent'}`, number> {
  const out = { change_confirmed_digest: 0, change_confirmed_urgent: 0, watch_broken_digest: 0, watch_broken_urgent: 0, watch_paused_digest: 0, watch_paused_urgent: 0 };
  for (const row of store.all<{ kind: WatchEventKind; policy: 'digest' | 'urgent'; n: number }>(`SELECT kind, policy, count(*) AS n FROM notifications WHERE delivered_at IS NULL GROUP BY kind, policy`)) {
    out[`${row.kind}_${row.policy}`] = row.n;
  }
  return out;
}

/** Hands the pending events to `sink` and marks what it took over. No sink (v1): nothing happens. */
export async function deliver(store: Store, sink: NotificationSink | null, now: number): Promise<number> {
  if (sink === null) return 0;
  const events = pendingEvents(store);
  if (events.length === 0) return 0;
  const taken = new Set(await sink.deliver(events));
  let marked = 0;
  for (const event of events) if (taken.has(event.id)) marked += store.run(`UPDATE notifications SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`, now, event.id);
  return marked;
}
