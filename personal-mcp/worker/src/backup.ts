/**
 * The daily backup of the SubscriptionStore (docs/backup.md): every table of its SQLite and every key of its KV, into
 * the private bucket `personal-mcp-backups` (binding BACKUPS), one bounded step per Alarm of the object (store.ts):
 *
 *   backups/<job start>/tables/<table>/<n:05d>.ndjson.gz  one gzip part per table and step; a line is one row as a
 *                                                         JSON array: its rowid, then its columns
 *   backups/<job start>/kv/<n:05d>.ndjson.gz              the KV keys, one [key, value] per line
 *   backups/<job start>/manifest.json                     written after every part: a prefix without it is incomplete
 *   latest.json                                           {"key": "backups/<job start>/"}, after the manifest
 *
 * `<job start>` is the UTC second the job started (`2026-10-28T052300Z`). The manifest (personal-mcp-backup-v1) holds
 * the schema version, each table's CREATE statement and columns (and an AUTOINCREMENT table's sequence), and each
 * part's rows, bytes and SHA-256.
 *
 * Every table is included but SQLite's own, Cloudflare's (`_cf_*`) and DERIVED_TABLES, which a restore rebuilds; every
 * KV key but STATE_KEYS, which describe the backup and the restore themselves. A table added later is backed up
 * without a change here.
 *
 * A job starts daily at 05:23 UTC, and at once when the object has no backup state yet (the first job after the release
 * that bound the bucket, or after a restore). A store without rows (a new object waiting for its restore) writes no
 * backup, so latest.json keeps naming real data. The first step fixes each table's max rowid and, like every step,
 * reads synchronously, the tables with the fewest rows first, until STEP_BYTES: a store that fits is one consistent
 * snapshot, and a larger one adds rows of its biggest tables up to the planned rowid in later steps. A cursor moves
 * only after its part is stored, so a failed step repeats from there and overwrites the same keys. MAX_ERRORS failed
 * steps in a row fail the job, which starts again FAILED_RETRY_MS later, or at the next 05:23 after MAX_FAILED_JOBS
 * failed jobs in a row. A job never touches another backup; after its manifest, all but the newest KEEP complete
 * backups are deleted with every incomplete prefix older than it.
 */
import { Severity } from '@ziyixi/proto/ops/v1/ops_pb';

export const BACKUP_FORMAT = 'personal-mcp-backup-v1';
/** The store's schema. Bump it with any table or column change (test/runtime/backup.test.ts pins the tables). */
export const SCHEMA_VERSION = 1;
export const BACKUP_ROOT = 'backups/';
export const MANIFEST = 'manifest.json';
export const LATEST = 'latest.json';
/** Complete backups kept, the new one included. */
export const KEEP = 30;
/** Row JSON a step reads before it stores its parts (at least one row per table it reaches). */
export const STEP_BYTES = 4 << 20;
const HOUR_MS = 3_600_000;
/** While a job runs, the next step comes this soon; after a failed step, ERROR_RETRY_MS. */
export const CONTINUE_MS = 1000;
export const ERROR_RETRY_MS = 60_000;
export const MAX_ERRORS = 3;
export const FAILED_RETRY_MS = HOUR_MS;
export const MAX_FAILED_JOBS = 3;
/** backup_stale: no complete backup for this long, or since the first step while there is none. */
export const BACKUP_STALE_MS = 72 * HOUR_MS;
/** 05:23 UTC: clear of Mail Hero's 04:17, Model Router's 04:47, Tasks' 10:00 and Home's half-hour ticks. */
const RUN_MINUTE = 5 * 60 + 23;
const MAX_LIST_PAGES = 10;
export const BACKUP_KEY = 'backup';
export const RESTORE_KEY = 'restore';
/** KV keys about the backup and the restore themselves, not the app's data. */
export const STATE_KEYS: readonly string[] = [BACKUP_KEY, RESTORE_KEY];
/** delivery_totals counts deliveries by state; the deliveries triggers rebuild it as a restore inserts them. */
export const DERIVED_TABLES: readonly string[] = ['delivery_totals'];

export type BackupStorage = Pick<DurableObjectStorage, 'sql' | 'kv' | 'transactionSync'>;
export interface BackupPart {
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}
export interface StoreTable {
  name: string;
  /** CREATE TABLE as SQLite keeps it. */
  sql: string;
  /** `rowid`, then the columns in their order. */
  columns: string[];
}
interface Cursor extends StoreTable {
  max_rowid: number;
  /** An AUTOINCREMENT table's sqlite_sequence when the job planned (null otherwise): numbers it has handed out. */
  sequence: number | null;
  last: number;
  done: boolean;
  parts: BackupPart[];
}
interface KvCursor {
  last: string | null;
  done: boolean;
  parts: BackupPart[];
}
interface Job {
  prefix: string;
  started_at: number;
  next_at: number;
  errors: number;
  /** Null until the first step plans the tables. */
  tables: Cursor[] | null;
  kv: KvCursor;
}
export interface BackupState {
  /** When the object ran its first job (ms): a first backup's stale time runs from it. */
  since: number | null;
  /** When the next job may start (ms); 0 at once. */
  next_run: number;
  /** Failed jobs since the last complete one. */
  failed_jobs: number;
  status: 'never' | 'ok' | 'failed';
  last_backup_at: number | null;
  last_key: string;
  error_code: string;
  job: Job | null;
}
/** What status and Ops report: none of it without the binding. */
export interface BackupFacts {
  status: 'never' | 'ok' | 'failed' | 'running';
  last_backup_at: number | null;
  last_key: string;
  since: number | null;
}

/** Keys, counts and codes only: never row content. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ backup: fields }));
}

/** `2026-10-28T05:23:00Z`: the manifest's times. */
export function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The first 05:23 UTC after `now`; with `skipToday`, not on `now`'s UTC day (a backup finished early). */
export function nextRun(now: number, skipToday = false): number {
  const day = Math.floor(now / (24 * HOUR_MS)) * 24 * HOUR_MS;
  let at = day + RUN_MINUTE * 60_000;
  if (at <= now || skipToday) at += 24 * HOUR_MS;
  return at;
}

/** Every table of the store but SQLite's, Cloudflare's and DERIVED_TABLES, by name. */
export function storeTables(sql: SqlStorage): StoreTable[] {
  return sql.exec<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master
      WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name`).toArray()
    .filter(table => !DERIVED_TABLES.includes(table.name))
    .map(table => {
      if (!/^[a-z_][a-z0-9_]*$/.test(table.name)) throw new Error('backup_table_name');
      const columns = sql.exec<{ name: string }>(`PRAGMA table_info("${table.name}")`).toArray().map(column => column.name);
      return { name: table.name, sql: table.sql, columns: ['rowid', ...columns] };
    });
}

/** No row in any table a backup holds: a new object, which a restore may fill. */
export function storeIsEmpty(sql: SqlStorage): boolean {
  return storeTables(sql).every(table => !sql.exec(`SELECT 1 FROM "${table.name}" LIMIT 1`).toArray().length);
}

/** A value as the parts hold it: text, numbers and NULL as they are, a blob as {"blob": "<base64>"}. */
export function encodeValue(value: unknown): unknown {
  if (!(value instanceof ArrayBuffer)) return value;
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return { blob: btoa(binary) };
}

export function rowLine(row: readonly unknown[]): string {
  return JSON.stringify(row.map(encodeValue));
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function newState(): BackupState {
  return { since: null, next_run: 0, failed_jobs: 0, status: 'never', last_backup_at: null, last_key: '', error_code: '', job: null };
}

function newJob(now: number): Job {
  return { prefix: `${BACKUP_ROOT}${timestamp(now).replaceAll(':', '')}/`, started_at: now, next_at: now, errors: 0,
    tables: null, kv: { last: null, done: false, parts: [] } };
}

/** The facts status and Ops report, and when the next step is due: Infinity without the binding. */
export function backupStatus(storage: BackupStorage, bucket: R2Bucket | undefined): { facts: BackupFacts | null; due: number } {
  if (!bucket) return { facts: null, due: Infinity };
  const state = storage.kv.get<BackupState>(BACKUP_KEY);
  if (!state) return { facts: { status: 'never', last_backup_at: null, last_key: '', since: null }, due: 0 };
  return {
    facts: { status: state.job ? 'running' : state.status, last_backup_at: state.last_backup_at, last_key: state.last_key, since: state.since },
    due: state.job ? state.job.next_at : state.next_run,
  };
}

/**
 * Ops' view (ops.ts): the counter backup_age_seconds and the last backup's time once there is one, the signals
 * backup_stale (critical) and backup_failed (warning, the last job failed). Nothing without the binding.
 */
export function backupOps(facts: BackupFacts | null, now: number) {
  const counters: Record<string, number> = {};
  const signals: { code: string; severity: Severity; metrics: Record<string, number> }[] = [];
  const last = facts?.last_backup_at ?? null;
  const age = last === null ? null : Math.max(Math.floor((now - last) / 1000), 0);
  if (age !== null) counters.backup_age_seconds = age;
  const since = last ?? facts?.since ?? null;
  if (since !== null && now - since > BACKUP_STALE_MS) signals.push({ code: 'backup_stale', severity: Severity.CRITICAL,
    metrics: age === null ? { has_backup: 0 } : { age_seconds: age, has_backup: 1 } });
  if (facts?.status === 'failed') signals.push({ code: 'backup_failed', severity: Severity.WARNING, metrics: {} });
  return { counters, signals, lastBackupAt: last === null ? null : new Date(last).toISOString() };
}

/** Runs the step due at `now`, if any. The caller arms the Alarm for backupStatus().due. */
export async function runBackup(storage: BackupStorage, bucket: R2Bucket | undefined, now: number): Promise<void> {
  if (!bucket) return;
  const state = storage.kv.get<BackupState>(BACKUP_KEY) ?? newState();
  if (!state.job) {
    if (state.next_run > now) return;
    if (storeIsEmpty(storage.sql)) {
      state.next_run = nextRun(now);
      storage.kv.put(BACKUP_KEY, state);
      return;
    }
    state.since ??= now;
    state.job = newJob(now);
  }
  const job = state.job;
  if (job.next_at > now) return;
  const step = job.tables?.every(table => table.done) && job.kv.done ? 'finish' : 'export';
  try {
    if (step === 'export') await exportStep(storage, bucket, job);
    else await finish(bucket, state, job, now);
    job.errors = 0;
    job.next_at = now + CONTINUE_MS;
  } catch (error) {
    // R2 failed (or a bug): the step runs again from the parts stored so far.
    job.errors += 1;
    job.next_at = now + ERROR_RETRY_MS;
    log({ error: error instanceof Error ? error.name : 'unknown', step, errors: job.errors });
    if (job.errors >= MAX_ERRORS) {
      log({ failed: 'storage_error', prefix: job.prefix });
      state.job = null;
      state.failed_jobs += 1;
      state.status = 'failed';
      state.error_code = 'storage_error';
      state.next_run = state.failed_jobs < MAX_FAILED_JOBS ? now + FAILED_RETRY_MS : nextRun(now);
    }
  }
  storage.kv.put(BACKUP_KEY, state);
}

/**
 * Fixes every table's max rowid, fewest rows first, so the small ones share the first step's read. Those include the
 * tables that move a row to a new rowid when they replace it (own_changes, work_links, event_sources): read in a later
 * step, such a row could move past the planned rowid and miss the backup.
 */
function plan(sql: SqlStorage): Cursor[] {
  const sequences = new Map<string, number>();
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").toArray().length)
    for (const row of sql.exec<{ name: string; seq: number }>('SELECT name, seq FROM sqlite_sequence')) sequences.set(row.name, row.seq);
  return storeTables(sql)
    .map(table => {
      const { n, max } = sql.exec<{ n: number; max: number }>(`SELECT count(*) AS n, coalesce(max(rowid), 0) AS max FROM "${table.name}"`).one();
      return { table: { ...table, max_rowid: max, sequence: sequences.get(table.name) ?? null, last: 0, done: max === 0, parts: [] }, rows: n };
    })
    .sort((a, b) => a.rows - b.rows || (a.table.name < b.table.name ? -1 : 1))
    .map(({ table }) => table);
}

/**
 * One step: plans on the first, then reads synchronously (nothing else runs in between) the KV keys and each open
 * table's next rows up to STEP_BYTES, and stores one part per table it read. A cursor moves only after its part.
 */
async function exportStep(storage: BackupStorage, bucket: R2Bucket, job: Job): Promise<void> {
  job.tables ??= plan(storage.sql);
  let budget = STEP_BYTES;
  const reads: { lines: string[]; store: (part: BackupPart | null) => void; key: string }[] = [];
  if (!job.kv.done) {
    const lines: string[] = [];
    let last = job.kv.last;
    let done = true;
    for (const [key, value] of storage.kv.list(last === null ? {} : { startAfter: last })) {
      if (STATE_KEYS.includes(key)) continue;
      if (budget <= 0) { done = false; break; }
      const line = JSON.stringify([key, value]);
      lines.push(line);
      budget -= line.length + 1;
      last = key;
    }
    const cursor = job.kv;
    reads.push({ lines, key: `${job.prefix}kv/${String(cursor.parts.length + 1).padStart(5, '0')}.ndjson.gz`,
      store: (part) => { if (part) cursor.parts.push(part); cursor.last = last; cursor.done = done; } });
  }
  for (const cursor of job.tables) {
    if (cursor.done || budget <= 0) continue;
    const lines: string[] = [];
    let last = cursor.last;
    let done = true;
    for (const row of storage.sql.exec(`SELECT ${cursor.columns.map(column => `"${column}"`).join(',')} FROM "${cursor.name}"
        WHERE rowid > ? AND rowid <= ? ORDER BY rowid`, cursor.last, cursor.max_rowid).raw()) {
      if (budget <= 0) { done = false; break; }
      const line = rowLine(row);
      lines.push(line);
      budget -= line.length + 1;
      last = row[0] as number;
    }
    reads.push({ lines, key: `${job.prefix}tables/${cursor.name}/${String(cursor.parts.length + 1).padStart(5, '0')}.ndjson.gz`,
      store: (part) => { if (part) cursor.parts.push(part); cursor.last = last; cursor.done = done; } });
  }
  for (const read of reads) read.store(read.lines.length ? await storePart(bucket, read.key, read.lines) : null);
}

async function storePart(bucket: R2Bucket, key: string, lines: string[]): Promise<BackupPart> {
  const gzip = new Blob([`${lines.join('\n')}\n`]).stream().pipeThrough(new CompressionStream('gzip'));
  const data = new Uint8Array(await new Response(gzip).arrayBuffer());
  const sha256 = await sha256Hex(data);
  await bucket.put(key, data, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { sha256 } });
  return { key, rows: lines.length, bytes: data.byteLength, sha256 };
}

const total = (parts: BackupPart[], field: 'rows' | 'bytes') => parts.reduce((sum, part) => sum + part[field], 0);

/** Writes the manifest (it marks the backup complete) and latest.json, then applies retention. */
async function finish(bucket: R2Bucket, state: BackupState, job: Job, now: number): Promise<void> {
  const tables = [...job.tables ?? []].sort((a, b) => (a.name < b.name ? -1 : 1)).map(table => ({
    name: table.name, sql: table.sql, columns: table.columns, max_rowid: table.max_rowid, sequence: table.sequence,
    rows: total(table.parts, 'rows'), bytes: total(table.parts, 'bytes'), parts: table.parts,
  }));
  const manifest = {
    format: BACKUP_FORMAT,
    started_at: timestamp(job.started_at),
    created_at: timestamp(now),
    schema_version: SCHEMA_VERSION,
    // Rows with rowid <= max_rowid when the job planned; nothing newer. `sequence` is an AUTOINCREMENT table's
    // sqlite_sequence then, which a restore does not go below.
    tables,
    kv: { rows: total(job.kv.parts, 'rows'), bytes: total(job.kv.parts, 'bytes'), parts: job.kv.parts },
    excluded: { tables: DERIVED_TABLES, kv: STATE_KEYS },
  };
  const json = { httpMetadata: { contentType: 'application/json' } };
  await bucket.put(job.prefix + MANIFEST, JSON.stringify(manifest, null, 1), json);
  await bucket.put(LATEST, JSON.stringify({ key: job.prefix }), json);
  state.job = null;
  state.failed_jobs = 0;
  state.status = 'ok';
  state.error_code = '';
  state.last_backup_at = now;
  state.last_key = job.prefix;
  state.next_run = nextRun(now, true);
  log({ done: job.prefix, rows: tables.reduce((sum, table) => sum + table.rows, 0) + manifest.kv.rows });
  try {
    await applyRetention(bucket, job.prefix);
  } catch (error) {
    // The backup is complete; the next one retries the cleanup.
    log({ retention_error: error instanceof Error ? error.name : 'unknown' });
  }
}

/**
 * Every complete backup but the newest KEEP (`current` counts) and every incomplete one older than `current`. One listing
 * of the backups finds both, so the cleanup costs a few R2 calls (subrequests) however many backups there are.
 */
async function applyRetention(bucket: R2Bucket, current: string): Promise<void> {
  const keys = new Map<string, string[]>();
  const complete = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page === MAX_LIST_PAGES) throw new Error('Too many objects under the backups');
    const listed = await bucket.list({ prefix: BACKUP_ROOT, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const { key } of listed.objects) {
      const prefix = key.slice(0, key.indexOf('/', BACKUP_ROOT.length) + 1);
      if (!prefix || prefix >= current) continue;
      keys.set(prefix, [...keys.get(prefix) ?? [], key]);
      if (key === prefix + MANIFEST) complete.add(prefix);
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  const kept = new Set([...complete].sort().reverse().slice(0, KEEP - 1));
  const doomed = [...keys].filter(([prefix]) => !kept.has(prefix));
  const deleted = doomed.flatMap(([, objects]) => objects);
  for (let index = 0; index < deleted.length; index += 1000) await bucket.delete(deleted.slice(index, index + 1000));
  for (const [prefix] of doomed) log({ deleted: prefix });
}
