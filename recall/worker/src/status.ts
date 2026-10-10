/**
 * The state of recording, archiving and storage (ServiceStatus of proto/recall/ui/v1/status.proto, ../../docs/design.md
 * §8.7, §9), built from bounded reads: the running counters in meta (never a count of a large table), the devices,
 * at most CONSUMERS_MAX consumers (the oldest change each has not archived, one indexed read per table; the changes
 * behind one that pulled within STALE_MS counted up to BEHIND_COUNT_MAX), and a week of usage rows. The UI reads it on
 * every navigation, so a consumer far behind or long gone costs a few reads, never a count of the feed. Codes, counts,
 * labels and times only. The same facts feed ops-v1 (ops-status.ts).
 */
import { create } from '@ziyixi/proto/protobuf';
import { ArchiveConsumerSchema, DeviceStatusSchema, RejectedItemsSchema, ServiceStatusSchema, type ArchiveConsumer, type DeviceStatus, type RejectedItems, type ServiceStatus } from '@ziyixi/proto/recall/ui/v1/status_pb';
import { BEHIND_COUNT_MAX, DAILY_READ_BUDGET, DAILY_ROW_BUDGET, DAY, MIB, REJECTED_WINDOW_DAYS, STALE_MS, STORAGE_BUDGET_MIB } from './limits.ts';
import { time } from './model.ts';
import { utcDay, type ConsumerRow, type DeviceRow, type Store } from './store.ts';

/** The changes above a seq: live visits and documents, and tombstones. */
const CHANGES_ABOVE = ['visits r JOIN pages p ON p.rowid = r.page_rowid WHERE r.seq > ?', 'documents r JOIN pages p ON p.rowid = r.page_rowid WHERE r.seq > ?', 'tombstones r WHERE r.seq > ?'];

/** The commit time of the oldest change above a seq (null when there is none): one indexed read per table. */
export function oldestUnsynced(store: Store, seq: number): number | null {
  const times = CHANGES_ABOVE.map((from) => store.one<{ seq_ms: number }>(`SELECT r.seq_ms AS seq_ms FROM ${from} ORDER BY r.seq LIMIT 1`, seq)?.seq_ms).filter(
    (ms): ms is number => ms !== undefined,
  );
  return times.length === 0 ? null : Math.min(...times);
}

/** The changes above a seq, counted up to BEHIND_COUNT_MAX. */
export function behindCount(store: Store, seq: number): number {
  let count = 0;
  for (const from of CHANGES_ABOVE) {
    if (count >= BEHIND_COUNT_MAX) break;
    count += store.count(`SELECT count(*) AS n FROM (SELECT 1 FROM ${from} LIMIT ?)`, seq, BEHIND_COUNT_MAX - count);
  }
  return count;
}

export function devices(store: Store): DeviceRow[] {
  return store.all<DeviceRow>(`SELECT * FROM devices ORDER BY last_seen_ms DESC, id`);
}

export function consumers(store: Store): ConsumerRow[] {
  return store.all<ConsumerRow>(`SELECT * FROM consumers ORDER BY last_pull_ms DESC, name`);
}

/** Refused items of the last REJECTED_WINDOW_DAYS UTC days (today included), by reason, with the latest time. */
export function rejectedItems(store: Store, now: number): { readonly reason: string; readonly count: number; readonly lastMs: number }[] {
  const totals = new Map<string, { count: number; lastMs: number }>();
  for (let day = 0; day < REJECTED_WINDOW_DAYS; day++) {
    for (const [reason, refusal] of Object.entries(store.usage(utcDay(now - day * DAY)).refused)) {
      const total = totals.get(reason) ?? { count: 0, lastMs: 0 };
      totals.set(reason, { count: total.count + refusal.count, lastMs: Math.max(total.lastMs, refusal.last_ms) });
    }
  }
  return [...totals].map(([reason, total]) => ({ reason, ...total })).sort((a, b) => (a.reason < b.reason ? -1 : 1));
}

/** The first visit of a live page, or null. */
export function firstVisitMs(store: Store): number | null {
  return store.one<{ start_ms: number }>(`SELECT v.start_ms AS start_ms FROM visits v JOIN pages p ON p.rowid = v.page_rowid ORDER BY v.start_ms LIMIT 1`)?.start_ms ?? null;
}

function deviceMessage(row: DeviceRow, now: number): DeviceStatus {
  return create(DeviceStatusSchema, {
    deviceId: row.id,
    label: row.label,
    extensionVersion: row.extension_version,
    firstSeenTime: time(row.first_seen_ms),
    lastHeartbeatTime: time(row.last_seen_ms),
    queuedCount: row.queued_count,
    lastErrorCode: row.last_error_code,
    stale: now - row.last_seen_ms > STALE_MS,
    clockSkewSeconds: row.clock_skew_s,
  });
}

function consumerMessage(store: Store, row: ConsumerRow, now: number): ArchiveConsumer {
  const stale = now - row.last_pull_ms > STALE_MS;
  const oldestMs = row.synced_seq >= store.headSeq() ? null : oldestUnsynced(store, row.synced_seq);
  return create(ArchiveConsumerSchema, {
    consumer: row.name,
    syncedSeq: row.synced_seq,
    lastPullTime: time(row.last_pull_ms),
    // A stale consumer is not counted: how far behind it is, its oldest change says.
    behindCount: stale || oldestMs === null ? 0 : behindCount(store, row.synced_seq),
    oldestUnsyncedTime: time(oldestMs),
    stale,
  });
}

export function serviceStatus(store: Store, now: number, build: string): ServiceStatus {
  const oldestIndexed = store.getMeta('oldest_indexed_text_ms');
  const today = store.usage(utcDay(now));
  const rejected: RejectedItems[] = rejectedItems(store, now).map((item) => create(RejectedItemsSchema, { reason: item.reason, count: item.count, lastTime: time(item.lastMs) }));
  return create(ServiceStatusSchema, {
    name: 'serviceStatus',
    devices: devices(store).map((row) => deviceMessage(row, now)),
    archiveConsumers: consumers(store).map((row) => consumerMessage(store, row, now)),
    headSeq: store.headSeq(),
    firstVisitTime: time(firstVisitMs(store)),
    pageCount: store.counter('page_count'),
    visitCount: store.counter('visit_count'),
    documentCount: store.counter('document_count'),
    storageUsedMib: Math.ceil(store.databaseSize / MIB),
    storageBudgetMib: STORAGE_BUDGET_MIB,
    blobStoredMib: Math.ceil(store.counter('blob_bytes') / MIB),
    rowsWrittenTodayCount: today.rows_written,
    dailyRowBudget: DAILY_ROW_BUDGET,
    rowsReadTodayCount: today.rows_read,
    dailyReadBudget: DAILY_READ_BUDGET,
    oldestIndexedTextTime: time(oldestIndexed === null ? null : Number(oldestIndexed)),
    recentErrorCodes: store.errors(),
    build,
    rejectedItems: rejected,
  });
}
