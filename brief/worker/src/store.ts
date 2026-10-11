/**
 * BriefState's SQLite storage (../../docs/design.md §14): the sources' and hosts' state, the items and their
 * embeddings, the world clusters, the issue runs and their fetched texts, the issues and their items, every model
 * call, the send ledger, the keys that ran, the votes and weights, the daily usage and the AIP-155 request log, in the
 * Durable Object's own database. Synchronous (the Durable Object's SQL API), so the writes of one `transactionSync`
 * are atomic.
 *
 * Every statement's rows read and written are metered (`takeMeter`): SQLite rows are an account-wide budget (100,000
 * written and 5 million read a day, shared with Mail Hero, the watch app, mailsort and recall), and the workerd tests
 * hold each path to its share. Indexes are few and partial where a column changes (each index entry is a row
 * written). Nothing here logs: rows hold fetched titles and model text.
 */
import { ERRORS_KEPT, REQUEST_ID_TTL_MS } from './limits.ts';

export const SCHEMA_VERSION = 1;

export const SCHEMA_V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Per source: its health, validators, the round it was last polled in, the accepted-item times of 60 days (its
  // usual gap), a sitemap's seen URL hashes and the rounds each failing URL was tried in, and the arXiv page a round
  // has reached.
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'new',
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    last_attempt_ms INTEGER,
    last_success_ms INTEGER,
    last_round TEXT NOT NULL DEFAULT '',
    etag TEXT,
    last_modified TEXT,
    seen TEXT NOT NULL DEFAULT '',
    accepts TEXT NOT NULL DEFAULT '[]',
    last_item_title TEXT NOT NULL DEFAULT '',
    last_item_ms INTEGER,
    page INTEGER NOT NULL DEFAULT 0,
    first_ms INTEGER,
    tries TEXT NOT NULL DEFAULT '{}'
  )`,
  // Per host: the spacing (the next request's earliest time), the backoff, and the robots.txt verdict for the brief's
  // own product token with its Crawl-delay.
  `CREATE TABLE IF NOT EXISTS hosts (
    host TEXT PRIMARY KEY,
    next_ms INTEGER NOT NULL DEFAULT 0,
    backoff_ms INTEGER NOT NULL DEFAULT 0,
    backoff_until_ms INTEGER NOT NULL DEFAULT 0,
    crawl_delay_ms INTEGER NOT NULL DEFAULT 0,
    robots TEXT NOT NULL DEFAULT '',
    robots_until_ms INTEGER NOT NULL DEFAULT 0
  )`,
  // An item: one canonical key (arXiv ID, DOI or normalized URL) and every source that carried it; `body` is the full
  // text a feed_full source carries (cut to 16,000 characters), the summary at most 2,000 characters. `gate` is
  // pending (to screen), scored (Haiku), fallback (Haiku refused it: the embedding's score, or its cluster's),
  // unscored (refused without a fallback), or signal (only signal-only sources carry it: never screened). `ran` is the
  // issue it ran in (a world story's whole cluster), `listed` the issue whose 还有 showed it.
  `CREATE TABLE IF NOT EXISTS items (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    section TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT,
    link TEXT NOT NULL,
    doi TEXT,
    arxiv TEXT,
    published_ms INTEGER,
    fetched_ms INTEGER NOT NULL,
    sources TEXT NOT NULL,
    candidate INTEGER NOT NULL,
    text_tier TEXT NOT NULL,
    upvotes INTEGER NOT NULL DEFAULT 0,
    upvote_pct REAL NOT NULL DEFAULT 0,
    mentions TEXT NOT NULL DEFAULT '[]',
    cluster INTEGER,
    gate TEXT NOT NULL DEFAULT 'pending',
    gate_day TEXT,
    topic TEXT,
    score REAL,
    embedded INTEGER NOT NULL DEFAULT 0,
    ran TEXT,
    listed TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS items_fetched ON items (fetched_ms)`,
  `CREATE INDEX IF NOT EXISTS items_to_gate ON items (fetched_ms) WHERE gate = 'pending'`,
  `CREATE INDEX IF NOT EXISTS items_to_embed ON items (fetched_ms) WHERE embedded = 0`,
  `CREATE INDEX IF NOT EXISTS items_cluster ON items (cluster) WHERE cluster IS NOT NULL`,
  // The items that ran (the hold-back's vectors at the cutoff, design §4): few, so a partial index.
  `CREATE INDEX IF NOT EXISTS items_ran ON items (ran) WHERE ran IS NOT NULL`,
  // An arXiv ID or DOI a post mentioned before its item existed: resolved when the item comes, kept 7 days.
  `CREATE TABLE IF NOT EXISTS pending_mentions (key TEXT NOT NULL, source TEXT NOT NULL, item INTEGER NOT NULL, ms INTEGER NOT NULL, PRIMARY KEY (key, source)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS embeddings (item INTEGER PRIMARY KEY, vec BLOB NOT NULL, ms INTEGER NOT NULL, voted INTEGER NOT NULL DEFAULT 0)`,
  // World clusters: the normalized mean of their members' embeddings.
  `CREATE TABLE IF NOT EXISTS clusters (id INTEGER PRIMARY KEY AUTOINCREMENT, centroid BLOB NOT NULL, n INTEGER NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS clusters_updated ON clusters (updated_ms)`,
  // The profile's topic descriptions, embedded once per profile version (the refused-candidate fallback).
  `CREATE TABLE IF NOT EXISTS topic_vectors (topic TEXT PRIMARY KEY, vec BLOB NOT NULL, version TEXT NOT NULL)`,
  // One issue's pipeline: its step, the step's open marker (a crash or a deploy left it), the attempts, the backoff
  // and the step's data (cards, the pick, packets, the writer's answer), as JSON.
  `CREATE TABLE IF NOT EXISTS runs (
    issue TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    step TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}',
    attempts TEXT NOT NULL DEFAULT '{}',
    open_build TEXT,
    open_ms INTEGER,
    crashes INTEGER NOT NULL DEFAULT 0,
    not_before_ms INTEGER NOT NULL DEFAULT 0,
    backoff_ms INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NOT NULL DEFAULT '',
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  )`,
  // The fetched full text of a shortlisted document (at most 16,000 characters), deleted 7 days after its issue and
  // never shown beyond the quotes (design §3.3).
  `CREATE TABLE IF NOT EXISTS texts (
    issue TEXT NOT NULL,
    doc TEXT NOT NULL,
    uri TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    fetched_ms INTEGER,
    PRIMARY KEY (issue, doc)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS issues (
    issue TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    shadow INTEGER NOT NULL DEFAULT 0,
    html TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    render_hash TEXT NOT NULL DEFAULT '',
    item_count INTEGER NOT NULL DEFAULT 0,
    dropped_count INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    writer_models TEXT NOT NULL DEFAULT '[]',
    error_code TEXT NOT NULL DEFAULT '',
    quiet_reason TEXT NOT NULL DEFAULT '',
    more TEXT NOT NULL DEFAULT '[]',
    pick_fallback INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL,
    send_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS issue_items (
    issue TEXT NOT NULL,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    section TEXT NOT NULL,
    topic TEXT NOT NULL,
    format TEXT NOT NULL,
    title TEXT NOT NULL,
    paragraphs TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    refs TEXT NOT NULL,
    citations TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    score REAL NOT NULL DEFAULT 0,
    keys TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (issue, id)
  ) WITHOUT ROWID`,
  // Every model call: its reservation until it answers, then its cost from usage; the build that started it (a deploy
  // that killed it is told apart from a crash by an older build); the answer's text, kept until its step reads it (a
  // crash between the answer and the step's commit never pays for the call twice), emptied after 7 days.
  `CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue TEXT NOT NULL,
    step TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    build TEXT NOT NULL,
    model TEXT NOT NULL,
    served TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    reserved REAL NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    request_id TEXT NOT NULL DEFAULT '',
    stop TEXT NOT NULL DEFAULT '',
    refusal TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    writers TEXT NOT NULL DEFAULT '[]',
    answer TEXT NOT NULL DEFAULT '',
    day TEXT NOT NULL,
    month TEXT NOT NULL,
    started_ms INTEGER NOT NULL,
    finished_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS calls_month ON calls (month)`,
  `CREATE INDEX IF NOT EXISTS calls_issue ON calls (issue)`,
  `CREATE INDEX IF NOT EXISTS calls_open ON calls (started_ms) WHERE state = 'open'`,
  // The delivery ledger (design §12): one row per day, reserved before the request, never replayed after unknown.
  `CREATE TABLE IF NOT EXISTS sends (
    issue TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    render_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    message_id TEXT NOT NULL DEFAULT '',
    status INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL,
    finished_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sent_keys (key TEXT PRIMARY KEY, issue TEXT NOT NULL, title TEXT NOT NULL, ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS votes (issue TEXT NOT NULL, item TEXT NOT NULL, origin TEXT NOT NULL, vote TEXT NOT NULL, ms INTEGER NOT NULL, PRIMARY KEY (issue, item, origin)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS votes_ms ON votes (ms)`,
  `CREATE TABLE IF NOT EXISTS weights (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1,
    shown INTEGER NOT NULL DEFAULT 0,
    up INTEGER NOT NULL DEFAULT 0,
    down INTEGER NOT NULL DEFAULT 0,
    more INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, id)
  ) WITHOUT ROWID`,
  // One row per local day: requests, neurons, items, candidates screened and refused, the day's model cost.
  `CREATE TABLE IF NOT EXISTS usage (
    day TEXT PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0,
    neurons REAL NOT NULL DEFAULT 0,
    items INTEGER NOT NULL DEFAULT 0,
    world_items INTEGER NOT NULL DEFAULT 0,
    geo_items INTEGER NOT NULL DEFAULT 0,
    screened INTEGER NOT NULL DEFAULT 0,
    refused INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, method TEXT NOT NULL, resource TEXT NOT NULL, answer TEXT NOT NULL, time_ms INTEGER NOT NULL)`,
];

export type Value = string | number | null | ArrayBuffer;

export interface RowMeter {
  read: number;
  written: number;
}

export interface SourceRow extends Record<string, SqlStorageValue> {
  id: string;
  state: string;
  failures: number;
  last_error: string;
  last_attempt_ms: number | null;
  last_success_ms: number | null;
  last_round: string;
  etag: string | null;
  last_modified: string | null;
  seen: string;
  accepts: string;
  last_item_title: string;
  last_item_ms: number | null;
  page: number;
  first_ms: number | null;
  /** A sitemap's failing URLs (their hashes) and the rounds each was tried in, as JSON. */
  tries: string;
}

export interface HostRow extends Record<string, SqlStorageValue> {
  host: string;
  next_ms: number;
  backoff_ms: number;
  backoff_until_ms: number;
  crawl_delay_ms: number;
  robots: string;
  robots_until_ms: number;
}

export interface ItemRow extends Record<string, SqlStorageValue> {
  rowid: number;
  key: string;
  section: string;
  title: string;
  summary: string;
  body: string | null;
  link: string;
  doi: string | null;
  arxiv: string | null;
  published_ms: number | null;
  fetched_ms: number;
  sources: string;
  candidate: number;
  text_tier: string;
  upvotes: number;
  upvote_pct: number;
  mentions: string;
  cluster: number | null;
  gate: string;
  gate_day: string | null;
  topic: string | null;
  score: number | null;
  embedded: number;
  ran: string | null;
  listed: string | null;
}

export interface RunRow extends Record<string, SqlStorageValue> {
  issue: string;
  kind: string;
  step: string;
  done: number;
  data: string;
  attempts: string;
  open_build: string | null;
  open_ms: number | null;
  crashes: number;
  not_before_ms: number;
  backoff_ms: number;
  error_code: string;
  created_ms: number;
  updated_ms: number;
}

export interface IssueRow extends Record<string, SqlStorageValue> {
  issue: string;
  kind: string;
  state: string;
  title: string;
  shadow: number;
  html: string;
  text: string;
  render_hash: string;
  item_count: number;
  dropped_count: number;
  candidate_count: number;
  writer_models: string;
  error_code: string;
  quiet_reason: string;
  more: string;
  pick_fallback: number;
  created_ms: number;
  send_ms: number | null;
}

export interface IssueItemRow extends Record<string, SqlStorageValue> {
  issue: string;
  id: string;
  position: number;
  section: string;
  topic: string;
  format: string;
  title: string;
  paragraphs: string;
  why: string;
  refs: string;
  citations: string;
  reason: string;
  score: number;
  keys: string;
  sources: string;
}

export interface CallRow extends Record<string, SqlStorageValue> {
  id: number;
  issue: string;
  step: string;
  attempt: number;
  build: string;
  model: string;
  served: string;
  state: string;
  reserved: number;
  cost: number;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  request_id: string;
  stop: string;
  refusal: string;
  error: string;
  writers: string;
  answer: string;
  day: string;
  month: string;
  started_ms: number;
  finished_ms: number | null;
}

export interface SendRow extends Record<string, SqlStorageValue> {
  issue: string;
  idempotency_key: string;
  render_hash: string;
  state: string;
  message_id: string;
  status: number;
  created_ms: number;
  finished_ms: number | null;
}

export interface TextRow extends Record<string, SqlStorageValue> {
  issue: string;
  doc: string;
  uri: string;
  text: string;
  scope: string;
  state: string;
  attempts: number;
  fetched_ms: number | null;
}

export type UsageCounter = 'requests' | 'neurons' | 'items' | 'world_items' | 'geo_items' | 'screened' | 'refused';

export class Store {
  private meter: RowMeter = { read: 0, written: 0 };
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  /** Creates or upgrades the schema. */
  migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const version = Number(this.getMeta('schema_version') ?? 0);
    if (version < 1) for (const statement of SCHEMA_V1) this.sql.exec(statement);
    if (version !== SCHEMA_VERSION) this.setMeta('schema_version', String(SCHEMA_VERSION));
    this.meter = { read: 0, written: 0 };
  }

  get databaseSize(): number {
    return this.sql.databaseSize;
  }

  takeMeter(): RowMeter {
    const taken = this.meter;
    this.meter = { read: 0, written: 0 };
    return taken;
  }

  /** Runs `fn` outside the meter (the workerd suite's seeding and reads). */
  unmetered<T>(fn: () => T): T {
    const saved = { ...this.meter };
    try {
      return fn();
    } finally {
      this.meter = saved;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  private exec<T extends Record<string, SqlStorageValue>>(query: string, params: readonly Value[]): { rows: T[]; written: number } {
    const cursor = this.sql.exec<T>(query, ...params);
    const rows = cursor.toArray();
    this.meter.read += cursor.rowsRead;
    this.meter.written += cursor.rowsWritten;
    return { rows, written: cursor.rowsWritten };
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

  /** Inserts a row whose keys are the table's column names. */
  insert(table: string, row: Readonly<Record<string, Value>>): void {
    const columns = Object.keys(row);
    this.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map((column) => row[column] ?? null));
  }

  /** Sets only the given columns of the row(s) whose `key` column is `value` (each indexed column costs a write). */
  update(table: string, key: string, value: Value, changes: Readonly<Record<string, Value>>): void {
    const columns = Object.keys(changes);
    if (columns.length === 0) return;
    this.run(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE ${key} = ?`, ...columns.map((column) => changes[column] ?? null), value);
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

  /** A JSON value kept in meta, or `fallback` when it is missing or unreadable. */
  getJson<T>(key: string, fallback: T): T {
    const text = this.getMeta(key);
    if (text === null) return fallback;
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  }

  setJson(key: string, value: unknown): void {
    this.setMeta(key, JSON.stringify(value));
  }

  /** Records an error code for the status (newest first, ERRORS_KEPT at most; a repeat of the newest is not added). */
  pushError(code: string): void {
    const errors = this.getJson<string[]>('recent_errors', []);
    if (errors[0] === code) return;
    this.setJson('recent_errors', [code, ...errors].slice(0, ERRORS_KEPT));
  }

  recentErrors(): string[] {
    return this.getJson<string[]>('recent_errors', []);
  }

  // ---- AIP-155 -------------------------------------------------------------------------------------------------------

  request(requestId: string, now: number): { method: string; resource: string; answer: string } | undefined {
    return this.one<{ method: string; resource: string; answer: string }>(`SELECT method, resource, answer FROM requests WHERE request_id = ? AND time_ms > ?`, requestId, now - REQUEST_ID_TTL_MS);
  }

  putRequest(requestId: string, method: string, resource: string, answer: string, now: number): void {
    this.run(`INSERT OR REPLACE INTO requests (request_id, method, resource, answer, time_ms) VALUES (?, ?, ?, ?, ?)`, requestId, method, resource, answer, now);
  }

  // ---- usage ---------------------------------------------------------------------------------------------------------

  addUsage(day: string, counter: UsageCounter, amount: number): void {
    if (amount === 0) return;
    this.run(`INSERT INTO usage (day, ${counter}) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET ${counter} = ${counter} + excluded.${counter}`, day, amount);
  }

  usage(day: string): Record<UsageCounter, number> {
    const row = this.one<Record<UsageCounter, number>>(`SELECT requests, neurons, items, world_items, geo_items, screened, refused FROM usage WHERE day = ?`, day);
    return row ?? { requests: 0, neurons: 0, items: 0, world_items: 0, geo_items: 0, screened: 0, refused: 0 };
  }
}

/** A stored embedding (the bytes of a Float32Array). */
export function toBlob(vector: Float32Array): ArrayBuffer {
  return vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength) as ArrayBuffer;
}

export function fromBlob(blob: SqlStorageValue): Float32Array | null {
  return blob instanceof ArrayBuffer && blob.byteLength % 4 === 0 && blob.byteLength > 0 ? new Float32Array(blob.slice(0)) : null;
}

/** JSON of a stored column, or `fallback`. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
