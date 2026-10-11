/**
 * The change feed (contracts/recall-archive-v1, ../../docs/design.md §7): GET /api/machine/v1/changes, answered by
 * RecallState. The feed is the `seq` of the visits, documents and tombstones rows (store.ts), so it is compacted by
 * construction: a revision moved its record to a newer seq, a deleted page's records no longer join a live page, and
 * every record's latest change lies above any cursor that has not seen it. Each change is rendered from its row by the
 * generated recall.archive.v1 code and the wire codec, so a seq always renders the same change.
 *
 * A page: three reads by seq above `after`, each of at most `limit` rows (visits and documents joined to their live
 * page), merged, the first `limit` kept. `last_seq` is the last change's seq when the page is full, else `head_seq`.
 * Each request's `after` is that consumer's sync position (consumers, at most CONSUMERS_MAX). Once today's rows read
 * pass FEED_READ_LIMIT the feed answers 429 with Retry-After until the next UTC day: an archive catching up from far
 * behind takes several days rather than the owner's searches.
 */
import { BlobSchema, Change_Kind, ChangePageSchema, ChangeSchema, DocumentSchema, FocusSpanSchema, TombstoneSchema, VisitSchema, type Change } from '@ziyixi/proto/recall/archive/v1/archive_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { toWire } from '@ziyixi/proto/wire-json';
import { machineError, machineJson, type MachineAnswer } from './answers.ts';
import { TEXT_MEDIA_TYPE } from './blobs.ts';
import { BEHIND_COUNT_MAX, CONSUMERS_MAX, FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT, FEED_READ_LIMIT, OVER_BUDGET_JITTER_MS } from './limits.ts';
import { hostOfKey, nextUtcMidnight, utcDay, type DocumentRow, type Store, type TombstoneRow, type VisitRow } from './store.ts';

export const ARCHIVE_VERSION = 'recall-archive-v1';
/** recall v1 keeps every tombstone. */
export const OLDEST_SEQ = 1;
const CONSUMER = /^[a-z][a-z0-9-]{0,31}$/;
const INT32_MAX = 2 ** 31 - 1;

/** A visit or document row with what its feed line needs from its live page. */
export type Joined<Row> = Row & { readonly page_id: string; readonly host_key: string };

/** A row's focus spans: [[start_ms, end_ms], ...]. */
export function spansOf(row: Pick<VisitRow, 'spans'>): [number, number][] {
  return JSON.parse(row.spans) as [number, number][];
}

export function visitChange(row: Joined<VisitRow>): Change {
  return create(ChangeSchema, {
    seq: row.seq,
    id: `visits/${row.id}`,
    kind: Change_Kind.VISIT,
    eventTime: timestampFromMs(row.start_ms),
    pageId: row.page_id,
    blobs: [],
    visit: create(VisitSchema, {
      url: row.url,
      urlTruncated: row.url_truncated === 1,
      title: row.title,
      site: hostOfKey(row.host_key),
      deviceId: row.device_id,
      deviceLabel: row.device_label,
      startTime: timestampFromMs(row.start_ms),
      endTime: timestampFromMs(row.end_ms),
      focusSeconds: row.focus_seconds,
      focusSpans: spansOf(row).map(([start, end]) => create(FocusSpanSchema, { startTime: timestampFromMs(start), endTime: timestampFromMs(end) })),
    }),
  });
}

export function documentChange(row: Joined<DocumentRow>): Change {
  return create(ChangeSchema, {
    seq: row.seq,
    id: `documents/${row.id}`,
    kind: Change_Kind.DOCUMENT,
    eventTime: timestampFromMs(row.capture_ms),
    pageId: row.page_id,
    blobs: [
      create(BlobSchema, {
        role: 'text',
        path: row.blob_path,
        mediaType: TEXT_MEDIA_TYPE,
        contentEncoding: 'gzip',
        sha256: row.sha256,
        sizeBytes: row.stored_bytes,
      }),
    ],
    document: create(DocumentSchema, {
      visit: `visits/${row.visit}`,
      url: row.url,
      urlTruncated: row.url_truncated === 1,
      title: row.title,
      description: row.description,
      site: hostOfKey(row.host_key),
      deviceId: row.device_id,
      deviceLabel: row.device_label,
      captureTime: timestampFromMs(row.capture_ms),
      textBytes: row.text_bytes,
      textTruncated: row.truncated === 1,
    }),
  });
}

export function tombstoneChange(row: TombstoneRow): Change {
  return create(ChangeSchema, {
    seq: row.seq,
    id: `tombstones/${row.id}`,
    kind: Change_Kind.TOMBSTONE,
    eventTime: timestampFromMs(row.seq_ms),
    blobs: [],
    tombstone: create(TombstoneSchema, { target: `pages/${row.page_id}` }),
  });
}

/** One page of the feed: the changes above `after`, at most `limit`, and the cursor. */
export function readChanges(store: Store, after: number, limit: number): { changes: Change[]; lastSeq: number; headSeq: number } {
  const head = store.headSeq();
  const visits = store.all<Joined<VisitRow>>(
    `SELECT v.*, p.id AS page_id, p.host_key AS host_key FROM visits v JOIN pages p ON p.rowid = v.page_rowid WHERE v.seq > ? ORDER BY v.seq LIMIT ?`,
    after,
    limit,
  );
  const documents = store.all<Joined<DocumentRow>>(
    `SELECT d.*, p.id AS page_id, p.host_key AS host_key FROM documents d JOIN pages p ON p.rowid = d.page_rowid WHERE d.seq > ? ORDER BY d.seq LIMIT ?`,
    after,
    limit,
  );
  const tombstones = store.all<TombstoneRow>(`SELECT * FROM tombstones WHERE seq > ? ORDER BY seq LIMIT ?`, after, limit);
  const changes = [...visits.map(visitChange), ...documents.map(documentChange), ...tombstones.map(tombstoneChange)]
    .sort((a, b) => a.seq - b.seq)
    .slice(0, limit);
  const last = changes[changes.length - 1];
  return { changes, lastSeq: changes.length === limit && last !== undefined ? last.seq : head, headSeq: head };
}

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

/** Records a consumer's sync position (its `after`); a ninth name replaces the one unseen longest. */
export function recordConsumer(store: Store, name: string, after: number, now: number): void {
  const known = store.one(`SELECT 1 AS x FROM consumers WHERE name = ?`, name) !== undefined;
  if (!known && store.count(`SELECT count(*) AS n FROM consumers`) >= CONSUMERS_MAX) {
    store.run(`DELETE FROM consumers WHERE name = (SELECT name FROM consumers ORDER BY last_pull_ms, name LIMIT 1)`);
  }
  store.run(
    `INSERT INTO consumers (name, synced_seq, last_pull_ms) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET synced_seq = excluded.synced_seq, last_pull_ms = excluded.last_pull_ms`,
    name,
    after,
    now,
  );
}

interface FeedQuery {
  readonly after: number;
  readonly limit: number;
  readonly consumer: string | null;
}

/** The query of GET changes, or null when a parameter breaks its rule (an unknown or repeated one included). */
export function parseFeedQuery(search: string): FeedQuery | null {
  const params = new URLSearchParams(search);
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!['after', 'limit', 'consumer'].includes(key) || seen.has(key)) return null;
    seen.add(key);
  }
  const after = params.get('after') ?? '0';
  const limit = params.get('limit') ?? String(FEED_DEFAULT_LIMIT);
  const consumer = params.get('consumer');
  if (!/^(0|[1-9][0-9]{0,9})$/.test(after) || Number(after) > INT32_MAX) return null;
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > FEED_MAX_LIMIT) return null;
  if (consumer !== null && !CONSUMER.test(consumer)) return null;
  return { after: Number(after), limit: Number(limit), consumer };
}

/** The answer of GET /api/machine/v1/changes (the export token already checked by the Worker). */
export function feedAnswer(store: Store, search: string, now: number, requestId: string): MachineAnswer {
  const query = parseFeedQuery(search);
  if (query === null) return machineError('BAD_REQUEST', requestId);
  if (store.usage(utcDay(now)).rows_read >= FEED_READ_LIMIT) {
    const retryAfter = Math.ceil((nextUtcMidnight(now) - now + Math.random() * OVER_BUDGET_JITTER_MS) / 1000);
    return machineError('FEED_OVER_BUDGET', requestId, { 'retry-after': String(retryAfter) });
  }
  const head = store.headSeq();
  if (query.after > head) return machineError('CURSOR_AHEAD', requestId);
  if (query.after < OLDEST_SEQ - 1) return machineError('CURSOR_EXPIRED', requestId);
  if (query.consumer !== null) recordConsumer(store, query.consumer, query.after, now);
  const page = readChanges(store, query.after, query.limit);
  const message = create(ChangePageSchema, {
    version: ARCHIVE_VERSION,
    feedId: store.feedId(),
    changes: page.changes,
    lastSeq: page.lastSeq,
    headSeq: page.headSeq,
    oldestSeq: OLDEST_SEQ,
  });
  return machineJson(JSON.stringify(toWire(ChangePageSchema, message)));
}
