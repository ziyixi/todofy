/**
 * The archive's files (contracts/recall-archive-v1 §3, ../../docs/design.md §7.2), as recall writes them to Dropbox
 * (backup.ts): `VERSION`, `state.json`, one `changes/YYYY/MM/DD.jsonl` per UTC day of commit, and the blobs at
 * `blobs/<path>`. A day's file holds the feed's changes committed that day (by seq_ms), one compact line each, in seq
 * order: the same records the feed serves, rendered by the same code (feed.ts).
 *
 * Which days to write. A scan reads the seq and commit time of the changes above `archive_scan_seq`, at most
 * ARCHIVE_SCAN_ROWS of each table a pass, and marks their days dirty in `archive_days`, widening each day's seq range;
 * a day's rows are then read by that range (seq is indexed; seq_ms is not, and an index on it would cost a row on every
 * visit revision) and filtered by seq_ms. A dirty day's file is rendered whole from what the object holds then, and
 * written again only when its bytes changed. Files of earlier days are not rewritten when a later change supersedes or
 * deletes one of their records: the newer line, or the tombstone, is in a later file, and a reader takes each record's
 * line with the highest seq. Codes and counts only in logs.
 */
import { ArchiveStateSchema, ChangeSchema, type Change } from '@ziyixi/proto/recall/archive/v1/archive_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { toWire } from '@ziyixi/proto/wire-json';
import { ARCHIVE_VERSION, documentChange, tombstoneChange, visitChange, type Joined } from './feed.ts';
import { DAY } from './limits.ts';
import { utcDay, type DocumentRow, type Store, type TombstoneRow, type VisitRow } from './store.ts';

/** The archive's VERSION file. */
export const VERSION_TEXT = `${ARCHIVE_VERSION}\n`;
/** state.json's `consumer` for the archive recall writes to Dropbox. */
export const ARCHIVE_KEEPER = 'dropbox';

/** A day of `archive_days`. */
export interface DayRow extends Record<string, SqlStorageValue> {
  day: string;
  min_seq: number;
  max_seq: number;
  dirty: number;
  content_hash: string | null;
}

/** A blob a day's file refers to. */
export interface DayBlob {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/** The path of a day's file in the archive: `changes/2026/10/10.jsonl`. */
export function dayPath(day: string): string {
  return `changes/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}.jsonl`;
}

/** The newest seq the archive's days account for. */
export function scannedSeq(store: Store): number {
  return Number(store.getMeta('archive_scan_seq') ?? '0');
}

/**
 * One scan step (inside the caller's transaction): the seq and commit time of up to `limit` changes of each table
 * above `archive_scan_seq`, their days marked dirty with their seq ranges widened, and `archive_scan_seq` moved to the
 * highest seq below which every change was read. Answers whether the scan reached the feed's head.
 */
export function scanStep(store: Store, limit: number): boolean {
  const from = scannedSeq(store);
  const head = store.headSeq();
  if (from >= head) return true;
  let upTo = head;
  const rows: { seq: number; seq_ms: number }[] = [];
  for (const table of ['visits', 'documents', 'tombstones']) {
    const found = store.all<{ seq: number; seq_ms: number }>(`SELECT seq, seq_ms FROM ${table} WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?`, from, head, limit);
    rows.push(...found);
    // A full read may have left rows of this table above its last seq: the scan is complete only up to it.
    const last = found[found.length - 1];
    if (found.length === limit && last !== undefined) upTo = Math.min(upTo, last.seq);
  }
  const days = new Map<string, { min: number; max: number }>();
  for (const row of rows) {
    if (row.seq > upTo) continue;
    const day = utcDay(row.seq_ms);
    const range = days.get(day);
    days.set(day, range === undefined ? { min: row.seq, max: row.seq } : { min: Math.min(range.min, row.seq), max: Math.max(range.max, row.seq) });
  }
  for (const [day, range] of days) {
    store.run(
      `INSERT INTO archive_days (day, min_seq, max_seq, dirty) VALUES (?, ?, ?, 1)
       ON CONFLICT (day) DO UPDATE SET min_seq = min(min_seq, excluded.min_seq), max_seq = max(max_seq, excluded.max_seq), dirty = 1`,
      day,
      range.min,
      range.max,
    );
  }
  store.setMeta('archive_scan_seq', String(upTo));
  return upTo >= head;
}

/** Up to `limit` dirty days, newest first (a newer line is written before an older file could lose its record). */
export function dirtyDays(store: Store, limit: number): DayRow[] {
  return store.all<DayRow>(`SELECT * FROM archive_days WHERE dirty = 1 ORDER BY day DESC LIMIT ?`, limit);
}

/** Whether a day's file is still to be written. */
export function anyDirty(store: Store): boolean {
  return store.one(`SELECT 1 AS x FROM archive_days WHERE dirty = 1 LIMIT 1`) !== undefined;
}

/** A day's file: its text (empty when it holds no change), how many changes it holds, and the blobs they refer to. */
export function renderDay(store: Store, row: Pick<DayRow, 'day' | 'min_seq' | 'max_seq'>): { readonly text: string; readonly count: number; readonly blobs: DayBlob[] } {
  const start = Date.parse(`${row.day}T00:00:00Z`);
  const range = [row.min_seq, row.max_seq, start, start + DAY] as const;
  const visits = store.all<Joined<VisitRow>>(
    `SELECT v.*, p.id AS page_id, p.host_key AS host_key FROM visits v JOIN pages p ON p.rowid = v.page_rowid
     WHERE v.seq >= ? AND v.seq <= ? AND v.seq_ms >= ? AND v.seq_ms < ? ORDER BY v.seq`,
    ...range,
  );
  const documents = store.all<Joined<DocumentRow>>(
    `SELECT d.*, p.id AS page_id, p.host_key AS host_key FROM documents d JOIN pages p ON p.rowid = d.page_rowid
     WHERE d.seq >= ? AND d.seq <= ? AND d.seq_ms >= ? AND d.seq_ms < ? ORDER BY d.seq`,
    ...range,
  );
  const tombstones = store.all<TombstoneRow>(`SELECT * FROM tombstones WHERE seq >= ? AND seq <= ? AND seq_ms >= ? AND seq_ms < ? ORDER BY seq`, ...range);
  const changes: Change[] = [...visits.map(visitChange), ...documents.map(documentChange), ...tombstones.map(tombstoneChange)].sort((a, b) => a.seq - b.seq);
  const lines = changes.map((change) => JSON.stringify(toWire(ChangeSchema, change)));
  return {
    text: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    count: changes.length,
    blobs: documents.map((document) => ({ path: document.blob_path, sha256: document.sha256, size: document.stored_bytes })),
  };
}

/** state.json: the feed, where it came from, its keeper and the seq up to which every change is in the archive. */
export function stateText(feedId: string, source: string, syncedSeq: number, now: number): string {
  const state = create(ArchiveStateSchema, { version: ARCHIVE_VERSION, feedId, source, consumer: ARCHIVE_KEEPER, syncedSeq, updateTime: timestampFromMs(now) });
  return `${JSON.stringify(toWire(ArchiveStateSchema, state), null, 2)}\n`;
}
