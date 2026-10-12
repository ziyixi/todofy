/**
 * RecallState's SQLite storage (../../docs/design.md §5.1): devices, sites, pages, visits, documents (the metadata;
 * the texts are in R2 until the retention window moves them to the Dropbox archive alone), the full-text index,
 * tombstones, deleted pages waiting for the alarm, feed consumers, the daily usage, the AIP-155 request log and what
 * the archive wrote to Dropbox, in the Durable Object's own database. Synchronous (the Durable Object's SQL API), so
 * the writes of one `transactionSync` are atomic.
 *
 * The change feed is the records' own rows: every write of a visit, document or tombstone row takes the next `seq`
 * of meta in its transaction (a revision moves its row to the new seq), so the feed holds no copy of a record and
 * never reuses a seq. A deleted page's visits and documents keep their rows until the alarm removes them, without a
 * page row: every read joins them to their live page, which hides them at once.
 *
 * Every statement's rows read and written are metered and charged to the day's usage (chargeRows, at the end of every
 * call into the object): the written ones count against the daily write budget (limits.ts DAILY_ROW_BUDGET), the read
 * ones against the daily read budget (DAILY_READ_BUDGET), and the workerd tests read both. Nothing here logs: rows
 * hold the owner's browsing.
 */
import { ACTIVE_MS, DAY, ERRORS_KEPT, REQUEST_ID_TTL_MS, USAGE_KEPT_DAYS } from './limits.ts';

export const SCHEMA_VERSION = 5;

export const SCHEMA_V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    extension_version TEXT NOT NULL,
    first_seen_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL,
    queued_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT NOT NULL DEFAULT '',
    clock_skew_s INTEGER NOT NULL DEFAULT 0
  )`,
  // A site: every page of one host (without a leading `www.`). host_key is the host's labels reversed
  // (`com.github.gist.`), so "this host and its subdomains" is an index range rather than a LIKE (whose pattern
  // production caps at 50 bytes). No index on focus_seconds: it would cost a row on every visit revision, while ListSites
  // sorts the few thousand sites in memory.
  `CREATE TABLE IF NOT EXISTS sites (
    host TEXT PRIMARY KEY,
    host_key TEXT NOT NULL UNIQUE,
    first_visit_ms INTEGER,
    last_visit_ms INTEGER,
    visit_count INTEGER NOT NULL DEFAULT 0,
    focus_seconds INTEGER NOT NULL DEFAULT 0
  )`,
  // A page: one normalized URL. Its rowid is never reused (AUTOINCREMENT) and is the index row's rowid: a page deleted
  // and visited again is a new row, and the old one's visits never join it. text_indexed holds the bytes of its latest
  // text in the index (0: its title and URL only).
  `CREATE TABLE IF NOT EXISTS pages (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    url_truncated INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    host_key TEXT NOT NULL,
    first_visit_ms INTEGER,
    last_visit_ms INTEGER,
    visit_count INTEGER NOT NULL DEFAULT 0,
    focus_seconds INTEGER NOT NULL DEFAULT 0,
    document_count INTEGER NOT NULL DEFAULT 0,
    latest_document TEXT,
    latest_capture_ms INTEGER,
    latest_text_sha256 TEXT,
    text_indexed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS pages_last_visit ON pages (last_visit_ms)`,
  `CREATE INDEX IF NOT EXISTS pages_host ON pages (host_key, last_visit_ms)`,
  // The pages whose text is in the index, oldest capture first: what the index budget moves out first.
  `CREATE INDEX IF NOT EXISTS pages_indexed ON pages (latest_capture_ms) WHERE text_indexed > 0`,
  `CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    seq_ms INTEGER NOT NULL,
    page_rowid INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    device_label TEXT NOT NULL,
    url TEXT NOT NULL,
    url_truncated INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    focus_seconds INTEGER NOT NULL,
    spans TEXT NOT NULL,
    revision INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS visits_start ON visits (start_ms, id)`,
  `CREATE INDEX IF NOT EXISTS visits_page ON visits (page_rowid, start_ms, id)`,
  // A captured text: its metadata here, its bytes in R2 at blobs/<blob_path>. sha256 and stored_bytes are those of the
  // stored (gzip) bytes; text_bytes and text_sha256 those of the text's UTF-8.
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    seq_ms INTEGER NOT NULL,
    page_rowid INTEGER NOT NULL,
    visit TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_label TEXT NOT NULL,
    capture_ms INTEGER NOT NULL,
    url TEXT NOT NULL,
    url_truncated INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    blob_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    stored_bytes INTEGER NOT NULL,
    text_bytes INTEGER NOT NULL,
    text_sha256 TEXT NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS documents_page ON documents (page_rowid, capture_ms)`,
  // One row per page (rowid = pages.rowid): its title, its URL's words and the first 32 KiB of its latest text, each
  // segmented (shared/segment.ts). Contentless: the texts live in R2; a row is replaced by a delete and an insert.
  `CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, url, body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')`,
  // The feed's deletions, and the ledger that keeps a deleted page deleted: kept forever.
  `CREATE TABLE IF NOT EXISTS tombstones (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    seq_ms INTEGER NOT NULL,
    page_id TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS tombstones_page ON tombstones (page_id, seq_ms)`,
  // Deleted pages whose visits, documents and R2 objects the alarm is still removing.
  `CREATE TABLE IF NOT EXISTS purges (page_rowid INTEGER PRIMARY KEY, page_id TEXT NOT NULL, started_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS consumers (name TEXT PRIMARY KEY, synced_seq INTEGER NOT NULL, last_pull_ms INTEGER NOT NULL)`,
  // One row per UTC day: rows written and read (the budgets), uploads and items, new visits, visits of pages that keep
  // their text that reached ten seconds, captures that arrived for them (kept, or skipped as the page's latest text or
  // its second of the day), texts kept, refused items by reason ({"<reason>": {"count": n, "last_ms": t}}), and whether
  // the write budget ran out.
  `CREATE TABLE IF NOT EXISTS usage (
    day TEXT PRIMARY KEY,
    rows_written INTEGER NOT NULL DEFAULT 0,
    rows_read INTEGER NOT NULL DEFAULT 0,
    batches INTEGER NOT NULL DEFAULT 0,
    items INTEGER NOT NULL DEFAULT 0,
    visits INTEGER NOT NULL DEFAULT 0,
    long_visits INTEGER NOT NULL DEFAULT 0,
    captures INTEGER NOT NULL DEFAULT 0,
    texts INTEGER NOT NULL DEFAULT 0,
    refused TEXT NOT NULL DEFAULT '{}',
    over_budget INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, method TEXT NOT NULL, resource TEXT NOT NULL, answer TEXT NOT NULL, time_ms INTEGER NOT NULL)`,
];

/**
 * Version 2: the archive recall writes to Dropbox (archive.ts, backup.ts). `archive_days`: each UTC day that holds
 * changes, by their commit time (seq_ms), with the range of their seqs (the day's rows are read by seq, which is
 * indexed, then filtered by seq_ms), whether its file must be written again, and the Dropbox content hash of what was
 * written. `archive_blobs`: the blobs written to Dropbox, by path, with the connection (`target`) they were written to,
 * so nothing is written twice and a new Dropbox writes everything again without a delete.
 */
export const SCHEMA_V2: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS archive_days (
    day TEXT PRIMARY KEY,
    min_seq INTEGER NOT NULL,
    max_seq INTEGER NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1,
    content_hash TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS archive_days_dirty ON archive_days (day) WHERE dirty = 1`,
  `CREATE TABLE IF NOT EXISTS archive_blobs (path TEXT PRIMARY KEY, target TEXT NOT NULL, content_hash TEXT NOT NULL)`,
];

/**
 * Version 3: the retention window (retention.ts). `documents.archived_ms`: when the text left Cloudflare (its R2
 * object and its index entry) after the Dropbox archive confirmed holding it; null while R2 holds it. The row keeps
 * its seq and blob path, so the feed and the archive render the same change. `documents_retention`: the texts still in
 * Cloudflare, oldest capture first, the order retention takes them in. The column is added only when it is missing
 * (migrate): a rollback to version 2's code writes version 2 back, and the next deploy migrates again.
 */
export const SCHEMA_V3_COLUMN = `ALTER TABLE documents ADD COLUMN archived_ms INTEGER`;
export const SCHEMA_V3: readonly string[] = [`CREATE INDEX IF NOT EXISTS documents_retention ON documents (capture_ms) WHERE archived_ms IS NULL`];

/** Version 4: activity snapshots and seven-day hot storage; the existing text index remains independent. */
export const SCHEMA_V4: readonly string[] = [
  `ALTER TABLE documents ADD COLUMN screenshot_path TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE documents ADD COLUMN screenshot_sha256 TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE documents ADD COLUMN screenshot_bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE documents ADD COLUMN screenshot_width INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE documents ADD COLUMN screenshot_height INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pages ADD COLUMN latest_text_document TEXT`,
  `UPDATE pages SET latest_text_document = latest_document`,
  `CREATE INDEX IF NOT EXISTS documents_visit ON documents (visit, capture_ms, id)`,
  `DROP INDEX documents_page`,
  `CREATE INDEX documents_page ON documents (page_rowid, capture_ms, id)`,
];

/** Version 5: mobile heartbeat policy and indexed per-device timeline reads. */
export const SCHEMA_V5: readonly string[] = [
  `ALTER TABLE devices ADD COLUMN mobile INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS visits_device ON visits (device_id, start_ms, id)`,
];

export type Value = string | number | null | ArrayBuffer;

export interface RowMeter {
  read: number;
  written: number;
}

export interface PageRow extends Record<string, SqlStorageValue> {
  rowid: number;
  id: string;
  url: string;
  url_truncated: number;
  title: string;
  host_key: string;
  first_visit_ms: number | null;
  last_visit_ms: number | null;
  visit_count: number;
  focus_seconds: number;
  document_count: number;
  latest_document: string | null;
  latest_text_document: string | null;
  latest_capture_ms: number | null;
  latest_text_sha256: string | null;
  text_indexed: number;
}

export interface VisitRow extends Record<string, SqlStorageValue> {
  id: string;
  seq: number;
  seq_ms: number;
  page_rowid: number;
  device_id: string;
  device_label: string;
  url: string;
  url_truncated: number;
  title: string;
  start_ms: number;
  end_ms: number;
  focus_seconds: number;
  /** JSON: [[start_ms, end_ms], ...]. */
  spans: string;
  revision: number;
}

export interface DocumentRow extends Record<string, SqlStorageValue> {
  id: string;
  seq: number;
  seq_ms: number;
  page_rowid: number;
  visit: string;
  device_id: string;
  device_label: string;
  capture_ms: number;
  url: string;
  url_truncated: number;
  title: string;
  description: string;
  blob_path: string;
  sha256: string;
  stored_bytes: number;
  text_bytes: number;
  text_sha256: string;
  truncated: number;
  /** When retention moved the text to the Dropbox archive alone (R2 no longer holds it); null while R2 does. */
  archived_ms: number | null;
  screenshot_path: string;
  screenshot_sha256: string;
  screenshot_bytes: number;
  screenshot_width: number;
  screenshot_height: number;
}

export interface TombstoneRow extends Record<string, SqlStorageValue> {
  id: string;
  seq: number;
  seq_ms: number;
  page_id: string;
}

export interface DeviceRow extends Record<string, SqlStorageValue> {
  id: string;
  label: string;
  extension_version: string;
  first_seen_ms: number;
  last_seen_ms: number;
  queued_count: number;
  last_error_code: string;
  clock_skew_s: number;
  mobile: number;
}

export interface SiteRow extends Record<string, SqlStorageValue> {
  host: string;
  host_key: string;
  first_visit_ms: number | null;
  last_visit_ms: number | null;
  visit_count: number;
  focus_seconds: number;
}

export interface ConsumerRow extends Record<string, SqlStorageValue> {
  name: string;
  synced_seq: number;
  last_pull_ms: number;
}

export interface Refusal {
  readonly count: number;
  readonly last_ms: number;
}

export interface UsageRow {
  readonly day: string;
  readonly rows_written: number;
  readonly rows_read: number;
  readonly batches: number;
  readonly items: number;
  readonly visits: number;
  readonly long_visits: number;
  readonly captures: number;
  readonly texts: number;
  readonly refused: Readonly<Record<string, Refusal>>;
  readonly over_budget: number;
}

export type UsageCounter = 'batches' | 'items' | 'visits' | 'long_visits' | 'captures' | 'texts';

/**
 * The running totals kept in meta, so the status never counts a large table. `archived_count`: live documents whose
 * text is only in the Dropbox archive (retention.ts); `blob_bytes` counts the texts R2 still holds.
 */
export type Counter = 'page_count' | 'visit_count' | 'document_count' | 'blob_bytes' | 'indexed_text_bytes' | 'archived_count';

/** Changes to the running totals, gathered over a transaction and written once (addCounters). */
export type CounterDeltas = Partial<Record<Counter, number>>;

/** Adds `delta` to a total of `deltas`. */
export function addDelta(deltas: CounterDeltas, name: Counter, delta: number): void {
  deltas[name] = (deltas[name] ?? 0) + delta;
}

/** The UTC day of `ms`, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The start of the next UTC day after `ms`. */
export function nextUtcMidnight(ms: number): number {
  return (Math.floor(ms / DAY) + 1) * DAY;
}

/**
 * The host_key of a host: its labels reversed, each followed by `.` (`gist.github.com` → `com.github.gist.`), so the
 * keys of a host and its subdomains form the range [key, key with its last `.` as `/`). An IPv6 literal keeps its
 * text plus `.` (no subdomains).
 */
export function hostKey(host: string): string {
  if (host.startsWith('[')) return `${host}.`;
  return `${host.split('.').reverse().join('.')}.`;
}

/** The host_key range of a host and its subdomains: [low, high). `/` is the character after `.`. */
export function hostKeyRange(host: string): readonly [string, string] {
  const low = hostKey(host);
  return [low, `${low.slice(0, -1)}/`];
}

/** The host of a host_key (hostKey's inverse). */
export function hostOfKey(key: string): string {
  const trimmed = key.slice(0, -1);
  return trimmed.startsWith('[') ? trimmed : trimmed.split('.').reverse().join('.');
}

export class Store {
  private meter: RowMeter = { read: 0, written: 0 };
  /** Rows written and read since they were last added to today's usage. */
  private unbilled = 0;
  private unbilledReads = 0;
  /** Rows written since the object started (for a log line's difference). */
  private writtenTotal = 0;
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  /** Creates or upgrades the schema; the first migration makes the feed's identity. */
  migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const version = Number(this.getMeta('schema_version') ?? 0);
    if (version < 1) {
      for (const statement of SCHEMA_V1) this.sql.exec(statement);
      if (this.getMeta('feed_id') === null) this.setMeta('feed_id', crypto.randomUUID());
      if (this.getMeta('seq') === null) this.setMeta('seq', '0');
    }
    if (version < 2) for (const statement of SCHEMA_V2) this.sql.exec(statement);
    if (version < 3) {
      try {
        this.sql.exec(SCHEMA_V3_COLUMN);
      } catch {
        // The column exists: this store was at version 3 before a rollback wrote version 2 back.
      }
      for (const statement of SCHEMA_V3) this.sql.exec(statement);
    }
    if (version < 4) {
      const columns = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(documents)`).toArray().map((row) => row.name));
      for (const statement of SCHEMA_V4) {
        const column = /ALTER TABLE documents ADD COLUMN (\w+)/.exec(statement)?.[1];
        if (column !== undefined && columns.has(column)) continue;
        if (statement.startsWith('ALTER TABLE pages') && this.sql.exec<{ name: string }>(`PRAGMA table_info(pages)`).toArray().some((row) => row.name === 'latest_text_document')) continue;
        this.sql.exec(statement);
      }
      this.setMeta('text_retention_days', '7');
      this.setMeta('denylist_etag', crypto.randomUUID());
    }
    if (version < 5) {
      const hasMobile = this.sql.exec<{ name: string }>(`PRAGMA table_info(devices)`).toArray().some((row) => row.name === 'mobile');
      for (const statement of SCHEMA_V5) if (!statement.startsWith('ALTER TABLE') || !hasMobile) this.sql.exec(statement);
    }
    if (version !== SCHEMA_VERSION) this.setMeta('schema_version', String(SCHEMA_VERSION));
    // The migration's rows are no request's: neither the meter nor the budgets count them.
    this.meter = { read: 0, written: 0 };
    this.unbilled = 0;
    this.unbilledReads = 0;
  }

  get databaseSize(): number {
    return this.sql.databaseSize;
  }

  /** Runs `fn` outside every meter and the budgets (the workerd suite's seeding and reads). */
  unmetered<T>(fn: () => T): T {
    const saved = { meter: { ...this.meter }, unbilled: this.unbilled, unbilledReads: this.unbilledReads, writtenTotal: this.writtenTotal };
    try {
      return fn();
    } finally {
      this.meter = saved.meter;
      this.unbilled = saved.unbilled;
      this.unbilledReads = saved.unbilledReads;
      this.writtenTotal = saved.writtenTotal;
    }
  }

  takeMeter(): RowMeter {
    const taken = this.meter;
    this.meter = { read: 0, written: 0 };
    return taken;
  }

  addMeter(meter: RowMeter): void {
    this.meter.read += meter.read;
    this.meter.written += meter.written;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  private exec<T extends Record<string, SqlStorageValue>>(query: string, params: readonly Value[]): { rows: T[]; written: number } {
    const cursor = this.sql.exec<T>(query, ...params);
    const rows = cursor.toArray();
    this.meter.read += cursor.rowsRead;
    this.meter.written += cursor.rowsWritten;
    this.unbilled += cursor.rowsWritten;
    this.unbilledReads += cursor.rowsRead;
    this.writtenTotal += cursor.rowsWritten;
    return { rows, written: cursor.rowsWritten };
  }

  /** Rows written since the object started: the difference of two reads is what the code between them wrote. */
  get rowsWritten(): number {
    return this.writtenTotal;
  }

  /** Inserts a row whose keys are the table's column names. */
  insert(table: string, row: Readonly<Record<string, Value>>): void {
    const columns = Object.keys(row);
    this.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map((column) => row[column] ?? null));
  }

  /**
   * Sets only the given columns of the row whose `key` column is `value`. Naming an indexed column rewrites its index
   * entries even when its value does not change, and each entry is a row written against the daily budget, so callers
   * pass only what changes.
   */
  update(table: string, key: string, value: Value, changes: Readonly<Record<string, Value>>): void {
    const columns = Object.keys(changes);
    if (columns.length === 0) return;
    this.run(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE ${key} = ?`, ...columns.map((column) => changes[column] ?? null), value);
  }

  all<T extends Record<string, SqlStorageValue>>(query: string, ...params: Value[]): T[] {
    return this.exec<T>(query, params).rows;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  one<T extends Record<string, SqlStorageValue>>(query: string, ...params: Value[]): T | undefined {
    return this.all<T>(query, ...params)[0];
  }

  run(query: string, ...params: Value[]): number {
    return this.exec(query, params).written;
  }

  count(query: string, ...params: Value[]): number {
    return this.one<{ n: number }>(query, ...params)?.n ?? 0;
  }

  // ---- meta ----------------------------------------------------------------------------------------------------------

  getMeta(key: string): string | null {
    return this.one<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
  }

  deleteMeta(...keys: string[]): void {
    for (const key of keys) this.run(`DELETE FROM meta WHERE key = ?`, key);
  }

  feedId(): string {
    return this.getMeta('feed_id') ?? '';
  }

  /** The feed's counter: the newest seq handed out (0 before the first). */
  headSeq(): number {
    return Number(this.getMeta('seq') ?? '0');
  }

  /**
   * A seq allocator for one transaction: `next()` hands out the following seqs, `commit()` stores the counter once
   * (call it inside the same transaction).
   */
  seqs(): { next: () => number; commit: () => void } {
    let current = this.headSeq();
    const start = current;
    return {
      next: () => {
        current += 1;
        return current;
      },
      commit: () => {
        if (current !== start) this.setMeta('seq', String(current));
      },
    };
  }

  counter(name: Counter): number {
    return Number(this.getMeta(name) ?? '0');
  }

  addCounter(name: Counter, delta: number): void {
    if (delta === 0) return;
    this.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`, name, String(delta), delta);
  }

  /** Writes a transaction's gathered changes to the running totals, one row per total that changed. */
  addCounters(deltas: CounterDeltas): void {
    for (const [name, delta] of Object.entries(deltas) as [Counter, number][]) this.addCounter(name, delta);
  }

  /** The newest few error codes (newest first). */
  errors(): string[] {
    try {
      const value: unknown = JSON.parse(this.getMeta('recent_errors') ?? '[]');
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  pushError(code: string): void {
    const codes = [code, ...this.errors().filter((item) => item !== code)].slice(0, ERRORS_KEPT);
    this.setMeta('recent_errors', JSON.stringify(codes));
  }

  // ---- usage and the write budget ----------------------------------------------------------------------------------

  usage(day: string): UsageRow {
    const row = this.one<Record<string, SqlStorageValue>>(`SELECT * FROM usage WHERE day = ?`, day);
    let refused: Record<string, Refusal> = {};
    try {
      const parsed: unknown = JSON.parse(typeof row?.['refused'] === 'string' ? row['refused'] : '{}');
      if (typeof parsed === 'object' && parsed !== null) refused = parsed as Record<string, Refusal>;
    } catch {
      // A row this code did not write: no refusals.
    }
    const number = (name: string) => (typeof row?.[name] === 'number' ? row[name] : 0);
    return {
      day,
      rows_written: number('rows_written'),
      rows_read: number('rows_read'),
      batches: number('batches'),
      items: number('items'),
      visits: number('visits'),
      long_visits: number('long_visits'),
      captures: number('captures'),
      texts: number('texts'),
      refused,
      over_budget: number('over_budget'),
    };
  }

  /** Counts refused items by reason for the day (with the latest time). */
  addRefusals(day: string, reasons: readonly string[], now: number): void {
    if (reasons.length === 0) return;
    const refused: Record<string, Refusal> = { ...this.usage(day).refused };
    for (const reason of reasons) refused[reason] = { count: (refused[reason]?.count ?? 0) + 1, last_ms: now };
    this.run(`INSERT INTO usage (day, refused) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET refused = excluded.refused`, day, JSON.stringify(refused));
  }

  markOverBudget(day: string): void {
    this.run(`INSERT INTO usage (day, over_budget) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET over_budget = 1`, day);
  }

  /**
   * Adds the rows written since the last call (and this statement's own row) and the rows read since the last call to
   * the day's budget counters, with any of the day's other counters, in one statement.
   */
  chargeRows(day: string, counts: Partial<Record<UsageCounter, number>> = {}): void {
    const fields = (Object.entries(counts) as [UsageCounter, number][]).filter(([, amount]) => amount !== 0);
    if (this.unbilled === 0 && this.unbilledReads === 0 && fields.length === 0) return;
    const written = this.unbilled + 1;
    const read = this.unbilledReads;
    const names = ['rows_written', 'rows_read', ...fields.map(([field]) => field)];
    this.run(
      `INSERT INTO usage (day, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})
       ON CONFLICT (day) DO UPDATE SET ${names.map((name) => `${name} = ${name} + excluded.${name}`).join(', ')}`,
      day,
      written,
      read,
      ...fields.map(([, amount]) => amount),
    );
    this.unbilled -= written;
    this.unbilledReads -= read;
  }

  // ---- the request log (AIP-155) -----------------------------------------------------------------------------------

  request(requestId: string, now: number): { method: string; resource: string; answer: string } | undefined {
    return this.one<{ method: string; resource: string; answer: string }>(
      `SELECT method, resource, answer FROM requests WHERE request_id = ? AND time_ms > ?`,
      requestId,
      now - REQUEST_ID_TTL_MS,
    );
  }

  putRequest(requestId: string, method: string, resource: string, answer: string, now: number): void {
    this.run(`INSERT OR REPLACE INTO requests (request_id, method, resource, answer, time_ms) VALUES (?, ?, ?, ?, ?)`, requestId, method, resource, answer, now);
  }

  // ---- retention -----------------------------------------------------------------------------------------------------

  /**
   * The daily cleanup of the small tables: request IDs older than a day, usage older than USAGE_KEPT_DAYS, and archive
   * consumers that have not pulled for ACTIVE_MS (an archive that moved to another name, or was given up).
   */
  prune(now: number): void {
    this.run(`DELETE FROM requests WHERE time_ms < ?`, now - REQUEST_ID_TTL_MS);
    this.run(`DELETE FROM usage WHERE day < ?`, utcDay(now - USAGE_KEPT_DAYS * DAY));
    this.run(`DELETE FROM consumers WHERE last_pull_ms < ?`, now - ACTIVE_MS);
  }
}
