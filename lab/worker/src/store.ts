/**
 * LabState's own SQLite storage (docs/design.md §6): scheduling metadata, per-day job cursors, the
 * embedding queue, vectors, the label mirror ranking reads, seeds, the neuron ledger, activity counts for
 * ops-v1 and the guard. Nothing here is read by the Worker directly; D1 holds the records the UI reads.
 */
import { utcDay } from './config.ts';

export const DO_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // One row per announce day: phase embedding → ranking → briefing → ready | ready_capped | empty.
  `CREATE TABLE IF NOT EXISTS jobs (
    day TEXT PRIMARY KEY,
    phase TEXT NOT NULL CHECK (phase IN ('embedding', 'ranking', 'briefing', 'ready', 'ready_capped', 'empty')),
    brief_cursor INTEGER NOT NULL DEFAULT 1,
    errors INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER,
    capped_day TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // The day's candidates (new + cross, first seen that day) in feed order.
  `CREATE TABLE IF NOT EXISTS day_items (
    day TEXT NOT NULL,
    pos INTEGER NOT NULL,
    paper_id TEXT NOT NULL,
    primary_category TEXT NOT NULL,
    announce_type TEXT NOT NULL,
    PRIMARY KEY (day, pos)
  )`,
  // Texts waiting for an embedding: a day's candidates (day = the announce day) or seeds (day = 'seed').
  `CREATE TABLE IF NOT EXISTS pending_embed (paper_id TEXT PRIMARY KEY, day TEXT NOT NULL, text TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS pending_embed_by_day ON pending_embed (day)`,
  `CREATE TABLE IF NOT EXISTS vectors (paper_id TEXT PRIMARY KEY, day TEXT NOT NULL, vec BLOB NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS vectors_by_at ON vectors (at)`,
  // Mirror of D1 feedback (rewritten after every committed decision): what ranking and counters read.
  `CREATE TABLE IF NOT EXISTS labels (
    paper_id TEXT PRIMARY KEY,
    label TEXT NOT NULL CHECK (label IN ('like', 'dislike')),
    source TEXT NOT NULL CHECK (source IN ('deck', 'library')),
    deck_id TEXT,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS labels_by_label_at ON labels (label, at)`,
  `CREATE TABLE IF NOT EXISTS seed_ids (
    paper_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'not_found')),
    added_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS neurons (day TEXT PRIMARY KEY, used REAL NOT NULL DEFAULT 0, cap_hit_at INTEGER, account_exhausted INTEGER NOT NULL DEFAULT 0)`,
  // Counts for ops-v1 (ingested, ranked, brief_rejected, ...), one row per event batch; kept 8 days.
  `CREATE TABLE IF NOT EXISTS activity (at INTEGER NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS activity_by_name_at ON activity (name, at)`,
  // Sends that are failed or unknown (ops-v1 send_unsettled), keyed by intent.
  `CREATE TABLE IF NOT EXISTS send_watch (intent_id TEXT PRIMARY KEY, since INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS guard (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    level TEXT NOT NULL CHECK (level IN ('normal', 'shed')),
    reason TEXT NOT NULL,
    until INTEGER,
    set_at INTEGER NOT NULL
  )`,
] as const;

type Row = Record<string, SqlStorageValue>;

export class Store {
  readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  migrate(): void {
    for (const statement of DO_SCHEMA) this.sql.exec(statement);
  }

  rows<T extends Row>(query: string, ...params: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(query, ...params).toArray();
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the row shape of its query
  one<T extends Row>(query: string, ...params: SqlStorageValue[]): T | undefined {
    return this.rows<T>(query, ...params)[0];
  }

  // ---- meta ------------------------------------------------------------------------------------------

  get(key: string): string | null {
    return this.one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }

  getNumber(key: string): number | null {
    const value = this.get(key);
    if (value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  set(key: string, value: string | number | null): void {
    if (value === null) this.sql.exec('DELETE FROM meta WHERE key = ?', key);
    else this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  // ---- neuron ledger ---------------------------------------------------------------------------------

  ledger(now: number): { day: string; used: number; capHitAt: number | null; exhausted: boolean } {
    const day = utcDay(now);
    const row = this.one<{ used: number; cap_hit_at: number | null; account_exhausted: number }>(
      'SELECT used, cap_hit_at, account_exhausted FROM neurons WHERE day = ?',
      day,
    );
    return { day, used: row?.used ?? 0, capHitAt: row?.cap_hit_at ?? null, exhausted: (row?.account_exhausted ?? 0) === 1 };
  }

  /** Adds `delta` neurons to today's ledger (negative to correct a pre-charged estimate, never below 0). */
  charge(now: number, delta: number): void {
    this.sql.exec(
      'INSERT INTO neurons (day, used) VALUES (?, max(0, ?)) ON CONFLICT (day) DO UPDATE SET used = max(0, used + ?)',
      utcDay(now),
      delta,
      delta,
    );
  }

  capHit(now: number, exhausted: boolean): void {
    this.sql.exec(
      `INSERT INTO neurons (day, used, cap_hit_at, account_exhausted) VALUES (?, 0, ?, ?)
       ON CONFLICT (day) DO UPDATE SET cap_hit_at = coalesce(cap_hit_at, excluded.cap_hit_at), account_exhausted = max(account_exhausted, excluded.account_exhausted)`,
      utcDay(now),
      now,
      exhausted ? 1 : 0,
    );
  }

  // ---- activity ----------------------------------------------------------------------------------------

  count(now: number, name: string, n: number): void {
    if (n > 0) this.sql.exec('INSERT INTO activity (at, name, n) VALUES (?, ?, ?)', now, name, n);
  }

  since(name: string, from: number): number {
    return this.one<{ total: number | null }>('SELECT sum(n) AS total FROM activity WHERE name = ? AND at >= ?', name, from)?.total ?? 0;
  }
}
