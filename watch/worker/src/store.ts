/**
 * WatchState's SQLite storage (../../docs/design.md §6): every watch, snapshot, change, host and robots.txt verdict,
 * the daily ledger, the AIP-155 request log, the notification outbox and PreviewWatch's recent fetches, in the Durable Object's own database. No D1,
 * no R2. Synchronous (the Durable Object's SQL API), so a group of writes in one `transactionSync` is atomic.
 *
 * Every table is bounded: WATCHES_MAX watches; per watch SNAPSHOTS_KEPT snapshots (plus the notified, the pending and
 * the previous check's), SUPPRESSED_KEPT suppressed and CHANGES_KEPT changes in all (the oldest acknowledged, then
 * suppressed, then confirmed ones go first; never a pending one or the CONFIRMED_KEPT newest confirmed ones); one row
 * per host and per day; request IDs for a day; URL fetch times for URL_MIN_SPACING_MS; notifications for
 * NOTIFICATIONS_KEPT_MS and at most NOTIFICATIONS_MAX.
 *
 * Rows read are a budget too (Workers Free: 5,000,000 rows read and 100,000 written a day for the whole account's
 * SQLite Durable Objects, Mail Hero's included; docs/design.md §8). So the bounds are kept where they grow: after an
 * alarm, `pruneWatches` for the watches it checked, every query on an index that bounds what it visits (changes by
 * (watch_id, state, id)); the global tables at most once an hour and every watch once a UTC day (`pruneGlobal`). The
 * store counts what it reads and writes (`meter`): the workerd tests hold each path to a row budget.
 *
 * Nothing here logs. Rows hold the owner's personal data (URLs, page text); they leave the object only through the
 * owner API behind Access.
 */
import {
  CHANGES_KEPT,
  CONFIRMED_KEPT,
  DAY,
  HOUR,
  NOTIFICATIONS_KEPT_MS,
  NOTIFICATIONS_MAX,
  PREVIEW_CACHE_MS,
  REQUEST_ID_TTL_MS,
  SNAPSHOTS_KEPT,
  SUPPRESSED_KEPT,
  URL_MIN_SPACING_MS,
} from './limits.ts';

/** Bump with every schema change; `migrate` runs the steps above the stored version. */
export const SCHEMA_VERSION = 2;

const SCHEMA_V1 = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // The owner's settings (`settings`, wire JSON of the Watch fields the owner sets) and the scheduler's state.
  `CREATE TABLE IF NOT EXISTS watches (
    id TEXT PRIMARY KEY,
    settings TEXT NOT NULL,
    host TEXT NOT NULL,
    read_hash TEXT NOT NULL,
    check_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'broken')),
    pause_reason TEXT CHECK (pause_reason IN ('owner', 'broken_too_long')),
    etag TEXT NOT NULL,
    create_time INTEGER NOT NULL,
    update_time INTEGER NOT NULL,
    shadow_end INTEGER,
    next_check_at INTEGER,
    check_requested INTEGER NOT NULL DEFAULT 0,
    last_fetch_at INTEGER,
    last_check_at INTEGER,
    last_success_at INTEGER,
    last_outcome TEXT,
    last_failure TEXT,
    last_http_status INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    failure_start INTEGER,
    masked_count INTEGER NOT NULL DEFAULT 0,
    http_etag TEXT,
    http_last_modified TEXT,
    raw_sha TEXT,
    raw_check_hash TEXT,
    seen_sha TEXT,
    seen_check_hash TEXT,
    seen_snapshot_id INTEGER,
    baseline_id INTEGER,
    baseline_read_hash TEXT,
    pending_change TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS watches_due ON watches (next_check_at)`,
  // A snapshot: one Content (content.ts), gzipped JSON of at most SNAPSHOT_MAX_GZIP bytes.
  `CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sha TEXT NOT NULL,
    line_count INTEGER NOT NULL,
    body BLOB NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS snapshots_watch ON snapshots (watch_id, id)`,
  `CREATE TABLE IF NOT EXISTS changes (
    id TEXT PRIMARY KEY,
    watch_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'suppressed', 'acknowledged')),
    suppression TEXT CHECK (suppression IN ('BELOW_THRESHOLD', 'TRIGGER_NOT_MET', 'FLICKER')),
    shadow INTEGER NOT NULL DEFAULT 0,
    classifier TEXT NOT NULL DEFAULT 'RULE',
    trigger_kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    added INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    diff TEXT NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    reverted INTEGER NOT NULL DEFAULT 0,
    previous_value TEXT NOT NULL DEFAULT '',
    current_value TEXT NOT NULL DEFAULT '',
    detect_time INTEGER NOT NULL,
    resolve_time INTEGER,
    ack_time INTEGER,
    snapshot_id INTEGER,
    before_snapshot_id INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS changes_watch ON changes (watch_id, id)`,
  `CREATE INDEX IF NOT EXISTS changes_state ON changes (state, id)`,
  // Etiquette per host: the next page request's earliest start and the site's backoff.
  `CREATE TABLE IF NOT EXISTS hosts (host TEXT PRIMARY KEY, next_at INTEGER NOT NULL, backoff_until INTEGER, backoff_level INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS robots (host TEXT PRIMARY KEY, verdict TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  // One row per UTC day: external requests, and the browser ledger.
  `CREATE TABLE IF NOT EXISTS ledger (day TEXT PRIMARY KEY, fetches INTEGER NOT NULL DEFAULT 0, browser_ms INTEGER NOT NULL DEFAULT 0, browser_exhausted INTEGER NOT NULL DEFAULT 0)`,
  // PreviewWatch's recent fetches (preview.ts PreviewCache): a few rows of minutes; the body gzipped.
  `CREATE TABLE IF NOT EXISTS previews (key TEXT PRIMARY KEY, at INTEGER NOT NULL, meta TEXT NOT NULL, body BLOB)`,
  `CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, rpc TEXT NOT NULL, resource TEXT NOT NULL, response TEXT NOT NULL, at INTEGER NOT NULL)`,
  // The outbox later steps deliver from (notify.ts): IDs, kinds and policies only.
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('change_confirmed', 'watch_broken', 'watch_paused')),
    watch_id TEXT NOT NULL,
    change_id TEXT,
    policy TEXT NOT NULL CHECK (policy IN ('digest', 'urgent')),
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  )`,
];

const SCHEMA_V2 = [
  // Every per-watch query on changes filters by state: without this index SQLite picks changes_state and visits the
  // rows of every watch (a prune of all watches read ~318,000 rows).
  `CREATE INDEX IF NOT EXISTS changes_watch_state ON changes (watch_id, state, id)`,
  // When each URL was last requested (a check or a preview): the same URL is never fetched again within
  // URL_MIN_SPACING_MS, whoever asks.
  `CREATE TABLE IF NOT EXISTS url_fetches (url TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
];

/** The global tables are pruned at most this often (meta `pruned_at`). */
export const PRUNE_GLOBAL_EVERY_MS = HOUR;

export type WatchStateName = 'active' | 'paused' | 'broken';
export type ChangeStateName = 'pending' | 'confirmed' | 'suppressed' | 'acknowledged';

export interface WatchRow {
  id: string;
  settings: string;
  host: string;
  read_hash: string;
  check_hash: string;
  state: WatchStateName;
  pause_reason: 'owner' | 'broken_too_long' | null;
  etag: string;
  create_time: number;
  update_time: number;
  shadow_end: number | null;
  next_check_at: number | null;
  check_requested: number;
  last_fetch_at: number | null;
  last_check_at: number | null;
  last_success_at: number | null;
  last_outcome: string | null;
  last_failure: string | null;
  last_http_status: number;
  failures: number;
  failure_start: number | null;
  masked_count: number;
  http_etag: string | null;
  http_last_modified: string | null;
  raw_sha: string | null;
  raw_check_hash: string | null;
  seen_sha: string | null;
  seen_check_hash: string | null;
  /** The previous check's text (the start of a typed trigger's edge). */
  seen_snapshot_id: number | null;
  baseline_id: number | null;
  baseline_read_hash: string | null;
  pending_change: string | null;
}

export interface ChangeRow {
  id: string;
  watch_id: string;
  state: ChangeStateName;
  suppression: 'BELOW_THRESHOLD' | 'TRIGGER_NOT_MET' | 'FLICKER' | null;
  shadow: number;
  classifier: string;
  trigger_kind: string;
  summary: string;
  added: number;
  removed: number;
  diff: string;
  truncated: number;
  reverted: number;
  previous_value: string;
  current_value: string;
  detect_time: number;
  resolve_time: number | null;
  ack_time: number | null;
  snapshot_id: number | null;
  /** A pending change: the text before it (its edge's start, for a third version). */
  before_snapshot_id: number | null;
  attempts: number;
}

export interface SnapshotRow {
  id: number;
  watch_id: string;
  created_at: number;
  sha: string;
  line_count: number;
  body: ArrayBuffer;
}

export interface HostRow {
  host: string;
  next_at: number;
  backoff_until: number | null;
  backoff_level: number;
}

export interface LedgerRow {
  day: string;
  fetches: number;
  browser_ms: number;
  browser_exhausted: number;
}

type Value = string | number | null | ArrayBuffer;

/** Rows read and written since the meter was last taken (cursor.rowsRead and rowsWritten, summed). */
export interface RowMeter {
  read: number;
  written: number;
}

export class Store {
  private readonly sql: SqlStorage;
  private meter: RowMeter = { read: 0, written: 0 };

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  /** Creates or upgrades the schema (in the constructor's blockConcurrencyWhile). */
  migrate(): void {
    const version = this.version();
    if (version < 1) for (const statement of SCHEMA_V1) this.sql.exec(statement);
    if (version < 2) for (const statement of SCHEMA_V2) this.sql.exec(statement);
    if (version !== SCHEMA_VERSION) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`, String(SCHEMA_VERSION));
  }

  /** The rows read and written since the last call (the workerd tests' row budgets), and a fresh count. */
  takeMeter(): RowMeter {
    const taken = this.meter;
    this.meter = { read: 0, written: 0 };
    return taken;
  }

  /** Adds to the meter (a test hook puts back what its own query read). */
  addMeter(meter: RowMeter): void {
    this.meter.read += meter.read;
    this.meter.written += meter.written;
  }

  /** Runs a statement to its end and counts its rows. */
  // The row type is the caller's statement of the query's columns, as in `all`.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  private exec<T extends Record<string, SqlStorageValue>>(query: string, params: Value[]): { rows: T[]; written: number } {
    const cursor = this.sql.exec<T>(query, ...params);
    const rows = cursor.toArray();
    this.meter.read += cursor.rowsRead;
    this.meter.written += cursor.rowsWritten;
    return { rows, written: cursor.rowsWritten };
  }

  private version(): number {
    const exists = this.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).toArray().length > 0;
    if (!exists) return 0;
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).toArray()[0];
    return row === undefined ? 0 : Number(row.value);
  }

  all<T extends Record<string, SqlStorageValue>>(query: string, ...params: Value[]): T[] {
    return this.exec<T>(query, params).rows;
  }

  // The row type is the caller's statement of the query's columns, as in `all`.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  one<T extends Record<string, SqlStorageValue>>(query: string, ...params: Value[]): T | undefined {
    return this.all<T>(query, ...params)[0];
  }

  run(query: string, ...params: Value[]): number {
    return this.exec(query, params).written;
  }

  // ---- meta ----------------------------------------------------------------------------------------------------------

  getMeta(key: string): string | null {
    return this.one<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
  }

  // ---- watches -------------------------------------------------------------------------------------------------------

  watch(id: string): WatchRow | undefined {
    return this.one<WatchRow & Record<string, SqlStorageValue>>(`SELECT * FROM watches WHERE id = ?`, id);
  }

  watches(): WatchRow[] {
    return this.all<WatchRow & Record<string, SqlStorageValue>>(`SELECT * FROM watches ORDER BY create_time DESC, id DESC`);
  }

  watchCount(): number {
    return this.one<{ n: number }>(`SELECT count(*) AS n FROM watches`)?.n ?? 0;
  }

  /** Watches due at `now`: active or broken ones, and paused ones the owner asked to check, earliest first. */
  dueWatches(now: number, limit: number): WatchRow[] {
    return this.all<WatchRow & Record<string, SqlStorageValue>>(
      `SELECT * FROM watches WHERE next_check_at IS NOT NULL AND next_check_at <= ? AND (state != 'paused' OR check_requested = 1) ORDER BY next_check_at, id LIMIT ?`,
      now,
      limit,
    );
  }

  /** The earliest scheduled check of any watch that will be checked, or null. */
  nextDue(): number | null {
    return this.one<{ at: number | null }>(`SELECT min(next_check_at) AS at FROM watches WHERE next_check_at IS NOT NULL AND (state != 'paused' OR check_requested = 1)`)?.at ?? null;
  }

  insertWatch(row: WatchRow): void {
    const names = Object.keys(row);
    this.run(`INSERT INTO watches (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, ...names.map((name) => (row as unknown as Record<string, Value>)[name] ?? null));
  }

  /** Writes the given columns of a watch. */
  updateWatch(id: string, fields: Partial<Omit<WatchRow, 'id'>>): void {
    const names = Object.keys(fields);
    if (names.length === 0) return;
    this.run(`UPDATE watches SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE id = ?`, ...names.map((name) => (fields as Record<string, Value>)[name] ?? null), id);
  }

  deleteWatch(id: string): void {
    this.run(`DELETE FROM watches WHERE id = ?`, id);
    this.run(`DELETE FROM snapshots WHERE watch_id = ?`, id);
    this.run(`DELETE FROM changes WHERE watch_id = ?`, id);
    this.run(`DELETE FROM notifications WHERE watch_id = ?`, id);
  }

  // ---- snapshots ---------------------------------------------------------------------------------------------------

  insertSnapshot(watchId: string, now: number, sha: string, lineCount: number, body: Uint8Array): number {
    this.run(`INSERT INTO snapshots (watch_id, created_at, sha, line_count, body) VALUES (?, ?, ?, ?, ?)`, watchId, now, sha, lineCount, body.slice().buffer);
    return this.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
  }

  snapshot(id: number): SnapshotRow | undefined {
    return this.one<SnapshotRow & Record<string, SqlStorageValue>>(`SELECT * FROM snapshots WHERE id = ?`, id);
  }

  // ---- changes -----------------------------------------------------------------------------------------------------

  change(watchId: string, id: string): ChangeRow | undefined {
    return this.one<ChangeRow & Record<string, SqlStorageValue>>(`SELECT * FROM changes WHERE watch_id = ? AND id = ?`, watchId, id);
  }

  insertChange(row: ChangeRow): void {
    const names = Object.keys(row);
    this.run(`INSERT INTO changes (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, ...names.map((name) => (row as unknown as Record<string, Value>)[name] ?? null));
  }

  updateChange(id: string, fields: Partial<Omit<ChangeRow, 'id' | 'watch_id'>>): void {
    const names = Object.keys(fields);
    if (names.length === 0) return;
    this.run(`UPDATE changes SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE id = ?`, ...names.map((name) => (fields as Record<string, Value>)[name] ?? null), id);
  }

  /** A page of changes, newest first: of one watch (or all with null), in one state (or all), before `before`. */
  changes(watchId: string | null, state: ChangeStateName | null, before: string | null, limit: number): ChangeRow[] {
    const where: string[] = [];
    const params: Value[] = [];
    if (watchId !== null) {
      where.push('watch_id = ?');
      params.push(watchId);
    }
    if (state !== null) {
      where.push('state = ?');
      params.push(state);
    }
    if (before !== null) {
      where.push('id < ?');
      params.push(before);
    }
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    return this.all<ChangeRow & Record<string, SqlStorageValue>>(`SELECT * FROM changes ${clause} ORDER BY id DESC LIMIT ?`, ...params, limit);
  }

  /**
   * Counts of the open changes by state (pending, confirmed, suppressed) over every watch. Acknowledged ones, the
   * largest group, are not counted: nothing shows that count, and an index count still reads each row it counts.
   */
  openCounts(): Record<Exclude<ChangeStateName, 'acknowledged'>, number> {
    const out = { pending: 0, confirmed: 0, suppressed: 0 };
    for (const state of ['pending', 'confirmed', 'suppressed'] as const) out[state] = this.one<{ n: number }>(`SELECT count(*) AS n FROM changes WHERE state = ?`, state)?.n ?? 0;
    return out;
  }

  /** Confirmed changes per watch (Watch.new_change_count). */
  newCounts(): Map<string, number> {
    return new Map(this.all<{ watch_id: string; n: number }>(`SELECT watch_id, count(*) AS n FROM changes WHERE state = 'confirmed' GROUP BY watch_id`).map((row) => [row.watch_id, row.n]));
  }

  // ---- hosts and robots --------------------------------------------------------------------------------------------

  host(host: string): HostRow | undefined {
    return this.one<HostRow & Record<string, SqlStorageValue>>(`SELECT * FROM hosts WHERE host = ?`, host);
  }

  putHost(row: HostRow): void {
    this.run(
      `INSERT INTO hosts (host, next_at, backoff_until, backoff_level) VALUES (?, ?, ?, ?)
       ON CONFLICT (host) DO UPDATE SET next_at = excluded.next_at, backoff_until = excluded.backoff_until, backoff_level = excluded.backoff_level`,
      row.host,
      row.next_at,
      row.backoff_until,
      row.backoff_level,
    );
  }

  robots(host: string, now: number): string | null {
    return this.one<{ verdict: string }>(`SELECT verdict FROM robots WHERE host = ? AND expires_at > ?`, host, now)?.verdict ?? null;
  }

  putRobots(host: string, verdict: string, expiresAt: number): void {
    this.run(`INSERT INTO robots (host, verdict, expires_at) VALUES (?, ?, ?) ON CONFLICT (host) DO UPDATE SET verdict = excluded.verdict, expires_at = excluded.expires_at`, host, verdict, expiresAt);
  }

  // ---- URL fetch times ---------------------------------------------------------------------------------------------

  /** When `url` was last requested (a check or a preview), if within URL_MIN_SPACING_MS of `now`. */
  urlFetchedAt(url: string, now: number): number | null {
    return this.one<{ at: number }>(`SELECT at FROM url_fetches WHERE url = ? AND at > ?`, url, now - URL_MIN_SPACING_MS)?.at ?? null;
  }

  putUrlFetch(url: string, at: number): void {
    this.run(`INSERT INTO url_fetches (url, at) VALUES (?, ?) ON CONFLICT (url) DO UPDATE SET at = max(at, excluded.at)`, url, at);
  }

  // ---- the ledger ----------------------------------------------------------------------------------------------------

  ledger(day: string): LedgerRow {
    return this.one<LedgerRow & Record<string, SqlStorageValue>>(`SELECT * FROM ledger WHERE day = ?`, day) ?? { day, fetches: 0, browser_ms: 0, browser_exhausted: 0 };
  }

  addLedger(day: string, fetches: number, browserMs = 0, exhausted = false): void {
    if (fetches === 0 && browserMs === 0 && !exhausted) return;
    this.run(
      `INSERT INTO ledger (day, fetches, browser_ms, browser_exhausted) VALUES (?, ?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET fetches = fetches + excluded.fetches, browser_ms = browser_ms + excluded.browser_ms,
         browser_exhausted = max(browser_exhausted, excluded.browser_exhausted)`,
      day,
      fetches,
      browserMs,
      exhausted ? 1 : 0,
    );
  }

  // ---- request IDs (AIP-155) -----------------------------------------------------------------------------------------

  request(requestId: string, now: number): { rpc: string; resource: string; response: string } | undefined {
    return this.one<{ rpc: string; resource: string; response: string }>(`SELECT rpc, resource, response FROM requests WHERE request_id = ? AND at > ?`, requestId, now - REQUEST_ID_TTL_MS);
  }

  putRequest(requestId: string, rpc: string, resource: string, response: string, now: number): void {
    this.run(`INSERT OR REPLACE INTO requests (request_id, rpc, resource, response, at) VALUES (?, ?, ?, ?, ?)`, requestId, rpc, resource, response, now);
  }

  // ---- notifications -------------------------------------------------------------------------------------------------

  enqueue(kind: 'change_confirmed' | 'watch_broken' | 'watch_paused', watchId: string, changeId: string | null, policy: 'digest' | 'urgent', now: number): void {
    this.run(`INSERT INTO notifications (kind, watch_id, change_id, policy, created_at) VALUES (?, ?, ?, ?, ?)`, kind, watchId, changeId, policy, now);
  }

  // ---- bounds --------------------------------------------------------------------------------------------------------

  /**
   * The global tables within their bounds, at most once per PRUNE_GLOBAL_EVERY_MS, and every watch's bounds once per
   * UTC day (a watch's rows grow only when it is checked, and `pruneWatches` follows every check). Returns rows deleted.
   */
  pruneGlobal(now: number): number {
    const last = Number(this.getMeta('pruned_at') ?? '0');
    if (now - last < PRUNE_GLOBAL_EVERY_MS && now >= last) return 0;
    let deleted = 0;
    deleted += this.run(`DELETE FROM requests WHERE at <= ?`, now - REQUEST_ID_TTL_MS);
    deleted += this.run(`DELETE FROM robots WHERE expires_at <= ?`, now);
    deleted += this.run(`DELETE FROM previews WHERE at <= ?`, now - PREVIEW_CACHE_MS);
    deleted += this.run(`DELETE FROM url_fetches WHERE at <= ?`, now - URL_MIN_SPACING_MS);
    deleted += this.run(`DELETE FROM ledger WHERE day < ?`, new Date(now - 8 * DAY).toISOString().slice(0, 10));
    deleted += this.run(`DELETE FROM notifications WHERE created_at <= ?`, now - NOTIFICATIONS_KEPT_MS);
    const cut = this.one<{ id: number }>(`SELECT id FROM notifications ORDER BY id DESC LIMIT 1 OFFSET ?`, NOTIFICATIONS_MAX);
    if (cut !== undefined) deleted += this.run(`DELETE FROM notifications WHERE id <= ?`, cut.id);
    deleted += this.run(`DELETE FROM hosts WHERE host NOT IN (SELECT host FROM watches) AND next_at <= ? AND coalesce(backoff_until, 0) <= ?`, now, now);
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.getMeta('swept_day') !== day) {
      deleted += this.pruneWatches(this.all<{ id: string }>(`SELECT id FROM watches`).map((row) => row.id));
      this.setMeta('swept_day', day);
    }
    this.setMeta('pruned_at', String(now));
    return deleted;
  }

  /** The bounds of the given watches (those an alarm checked). Returns rows deleted. */
  pruneWatches(ids: Iterable<string>): number {
    let deleted = 0;
    for (const id of new Set(ids)) deleted += this.pruneWatch(id);
    return deleted;
  }

  /**
   * A watch's snapshots and changes within their bounds; the notified, pending and previous snapshots are always kept.
   * Every query reads one watch's rows through an index (changes_watch_state, snapshots_watch).
   */
  pruneWatch(id: string): number {
    let deleted = 0;
    // The suppressed ones beyond the SUPPRESSED_KEPT newest.
    const suppressedCut = this.one<{ id: string }>(`SELECT id FROM changes WHERE watch_id = ? AND state = 'suppressed' ORDER BY id DESC LIMIT 1 OFFSET ?`, id, SUPPRESSED_KEPT);
    if (suppressedCut !== undefined) deleted += this.run(`DELETE FROM changes WHERE watch_id = ? AND state = 'suppressed' AND id <= ?`, id, suppressedCut.id);
    // Over CHANGES_KEPT in all: the oldest acknowledged ones go first, then suppressed, then confirmed ones beyond the
    // CONFIRMED_KEPT newest (a change the owner never read is dropped only when it is that old); never a pending one.
    let excess = (this.one<{ n: number }>(`SELECT count(*) AS n FROM changes WHERE watch_id = ?`, id)?.n ?? 0) - CHANGES_KEPT;
    for (const state of ['acknowledged', 'suppressed'] as const) {
      if (excess <= 0) break;
      const removed = this.run(`DELETE FROM changes WHERE id IN (SELECT id FROM changes WHERE watch_id = ? AND state = ? ORDER BY id LIMIT ?)`, id, state, excess);
      deleted += removed;
      excess -= removed;
    }
    if (excess > 0) {
      const keptFrom = this.one<{ id: string }>(`SELECT id FROM changes WHERE watch_id = ? AND state = 'confirmed' ORDER BY id DESC LIMIT 1 OFFSET ?`, id, CONFIRMED_KEPT - 1);
      if (keptFrom !== undefined) {
        deleted += this.run(`DELETE FROM changes WHERE id IN (SELECT id FROM changes WHERE watch_id = ? AND state = 'confirmed' AND id < ? ORDER BY id LIMIT ?)`, id, keptFrom.id, excess);
      }
    }
    const snapshotCut = this.one<{ id: number }>(`SELECT id FROM snapshots WHERE watch_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?`, id, SNAPSHOTS_KEPT - 1);
    if (snapshotCut !== undefined) {
      deleted += this.run(
        `DELETE FROM snapshots WHERE watch_id = ?1 AND id < ?2
           AND id NOT IN (SELECT coalesce(baseline_id, 0) FROM watches WHERE id = ?1)
           AND id NOT IN (SELECT coalesce(seen_snapshot_id, 0) FROM watches WHERE id = ?1)
           AND id NOT IN (SELECT coalesce(snapshot_id, 0) FROM changes WHERE watch_id = ?1 AND state = 'pending')
           AND id NOT IN (SELECT coalesce(before_snapshot_id, 0) FROM changes WHERE watch_id = ?1 AND state = 'pending')`,
        id,
        snapshotCut.id,
      );
    }
    return deleted;
  }
}
