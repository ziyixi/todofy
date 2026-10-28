/**
 * Mailsort's daily backup (../../docs/backup.md): every table of MailsortState's SQLite into the private bucket
 * `mailsort-backups` (binding BACKUPS), one bounded step per Alarm (state.ts tick):
 *
 *   backups/<job start>/<table>/<seq:05d>.ndjson.gz   one gzip part per table and step, one JSON array per row
 *   backups/<job start>/manifest.json                 written after every part: a prefix without it is incomplete
 *   latest.json                                       {"key": "backups/<job start>/"}, after the manifest
 *
 * The plan reads the schema itself (sqlite_master): every table but SQLite's and Cloudflare's own, with its CREATE
 * statement, indexes and columns, so a table a later release adds is backed up as it is, and a restore (restore.ts)
 * rebuilds the exact schema. A rowid table's rows carry their rowid; a WITHOUT ROWID table's are read in primary key
 * order. A value is JSON: null, a number, a string, {"blob": base64} or {"real": "Infinity"}.
 *
 * A job starts daily at BACKUP_RUN_AT_MINUTES (11:41 UTC), and at once when the object has no backup state (the first
 * job after the release that bound the bucket, or after a restore). While it runs the pipeline waits (state.ts), so
 * only an owner edit made during the job (a minute or so) may be partly in it. A step stores at most BACKUP_STEP_BYTES
 * of rows; a cursor moves only after its part is stored, so a failed step repeats its pages and overwrites the same
 * keys. BACKUP_MAX_ERRORS failed steps in a row, or a job older than BACKUP_MAX_JOB_MS, fail the job, which starts
 * again BACKUP_FAILED_RETRY_MS later (BACKUP_MAX_FAILED_JOBS times in a row, then at the next daily start). A job never
 * touches another backup's objects; after its manifest, all but the newest BACKUP_KEEP complete backups are deleted
 * with every incomplete prefix older than the new one. A store without any of the owner's records (a new object
 * before its setup or restore) is not backed up: its empty copy would only push out a good one.
 *
 * The state lives in the object's key-value storage (`backup`), outside the tables it backs up. Keys, counts and codes
 * are logged, never row content.
 */
import { Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import {
  BACKUP_CONTINUE_MS,
  BACKUP_EMPTY_RECHECK_MS,
  BACKUP_FAILED_RETRY_MS,
  BACKUP_KEEP,
  BACKUP_MAX_ERRORS,
  BACKUP_MAX_FAILED_JOBS,
  BACKUP_MAX_JOB_MS,
  BACKUP_PART_BYTES,
  BACKUP_PART_ROWS,
  BACKUP_RUN_AT_MINUTES,
  BACKUP_STALE_MS,
  BACKUP_STEP_BYTES,
  BACKUP_STEP_PARTS,
  BACKUP_STEP_RETRY_MS,
  DAY,
  MINUTE,
} from './limits.ts';
import type { Store, Value } from './store.ts';

export const BACKUP_FORMAT = 'mailsort-backup-v1';
export const BACKUP_ROOT = 'backups/';
export const MANIFEST = 'manifest.json';
export const LATEST = 'latest.json';
/** `backups/<job start>/`, the job start's UTC second (`2026-10-28T114100Z`). */
export const BACKUP_PREFIX = /^backups\/\d{4}-\d{2}-\d{2}T\d{6}Z\/$/;
/** Tables a new object fills by itself before its setup or restore (history registration, counters, request IDs). */
export const SELF_FILLED: ReadonlySet<string> = new Set(['meta', 'pending', 'usage', 'requests']);
const STATE_KEY = 'backup';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_LIST_PAGES = 10;
const utf8 = new TextEncoder();

/** The object's synchronous key-value storage (ctx.storage.kv), as much of it as the backup and restore use. */
export type Kv = Pick<SyncKvStorage, 'get' | 'put' | 'delete'>;

export interface BackupPart {
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}

/** One table as the plan read it: `columns` start with `rowid` for a rowid table, whose `key` is then `rowid`. */
export interface TableSchema {
  name: string;
  sql: string;
  indexes: string[];
  columns: string[];
  key: string[];
}

export interface ManifestTable extends TableSchema {
  rows: number;
  bytes: number;
  parts: BackupPart[];
}

export interface BackupManifest {
  format: string;
  /** The Durable Object name the backup was made from. */
  object: string;
  started_at: string;
  created_at: string;
  schema_version: number;
  tables: ManifestTable[];
}

interface Cursor extends TableSchema {
  /** The key of the last row stored, or null before the first. */
  after: Value[] | null;
  done: boolean;
  parts: BackupPart[];
}

interface Job {
  prefix: string;
  started_at: number;
  /** When its next step may run (ms). */
  next_step: number;
  planned: boolean;
  schema_version: number;
  errors: number;
  cursors: Cursor[];
}

export interface BackupState {
  /** When the first job started (ms): a first backup's stale time runs from it. */
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

/** What Ops reports (ops-status.ts). */
export interface BackupFacts {
  status: 'never' | 'ok' | 'failed' | 'running';
  last_backup_at: number | null;
  since: number | null;
}

/** Keys, counts and codes only: never row content. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ backup: fields }));
}

/** `2026-10-28T11:41:00Z`: the manifest's times. */
export function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The daily start after `now`; with `skipToday`, the next UTC day's (a job just finished). */
export function nextRun(now: number, skipToday = false): number {
  const today = Math.floor(now / DAY) * DAY + BACKUP_RUN_AT_MINUTES * MINUTE;
  return skipToday || today <= now ? today + DAY : today;
}

/** A table or column name as SQL: plain identifiers only, quoted (`rowid` stays the rowid). */
export function sqlName(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error('unsupported_schema');
  return name === 'rowid' ? name : `"${name}"`;
}

/** Every table of the store but SQLite's and Cloudflare's own, with its CREATE statement, in creation order. */
export function storeTables(store: Store): { name: string; sql: string }[] {
  return store
    .all<{ type: string; name: string; sql: string | null }>(`SELECT type, name, sql FROM sqlite_master ORDER BY rowid`)
    .filter((row) => row.type === 'table' && !row.name.startsWith('sqlite_') && !row.name.startsWith('_cf_'))
    .map((row) => ({ name: row.name, sql: row.sql ?? '' }));
}

/** Whether the store holds none of the owner's records: no row in any table a new object does not fill by itself. */
export function storeEmpty(store: Store): boolean {
  return storeTables(store).every((table) => SELF_FILLED.has(table.name) || store.one(`SELECT 1 AS x FROM ${sqlName(table.name)} LIMIT 1`) === undefined);
}

/** The schema of every table: its statement, indexes, columns and key. Views and triggers are not expected. */
export function planTables(store: Store): TableSchema[] {
  const objects = store.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid`)
    .filter((row) => !row.name.startsWith('sqlite_') && !row.name.startsWith('_cf_') && !row.tbl_name.startsWith('_cf_'));
  if (objects.some((row) => row.type !== 'table' && row.type !== 'index')) throw new Error('unsupported_schema');
  return objects.filter((row) => row.type === 'table').map((table) => {
    const info = store.all<{ name: string; type: string; pk: number }>(`PRAGMA table_info(${sqlName(table.name)})`);
    const columns = info.map((column) => column.name);
    for (const column of columns) sqlName(column);
    const primary = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
    // A WITHOUT ROWID table is read in primary key order; an INTEGER PRIMARY KEY is the rowid itself.
    const withoutRowid = /\)\s*WITHOUT\s+ROWID\s*$/i.test(table.sql ?? '');
    const alias = !withoutRowid && primary.length === 1 && primary[0]?.type.toUpperCase() === 'INTEGER' ? primary[0].name : null;
    const ordered = withoutRowid || alias !== null;
    const key = withoutRowid ? primary.map((column) => column.name) : [alias ?? 'rowid'];
    return {
      name: table.name,
      sql: table.sql ?? '',
      // Automatic indexes (a UNIQUE or PRIMARY KEY constraint) have no statement: the table's own makes them again.
      indexes: objects.filter((row) => row.type === 'index' && row.tbl_name === table.name && row.sql !== null).map((row) => row.sql ?? ''),
      columns: ordered ? columns : ['rowid', ...columns],
      key,
    };
  });
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** One stored value as JSON. */
export function encodeValue(value: SqlStorageValue): unknown {
  if (value instanceof ArrayBuffer) return { blob: base64(new Uint8Array(value)) };
  if (typeof value === 'number' && !Number.isFinite(value)) return { real: String(value) };
  return value;
}

async function sha256(data: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The gzip of `lines` stored under `key`, with its SHA-256 in the manifest and in the object's metadata. */
async function storePart(bucket: R2Bucket, key: string, lines: string[]): Promise<BackupPart> {
  const gzip = new Blob([`${lines.join('\n')}\n`]).stream().pipeThrough(new CompressionStream('gzip'));
  const data = new Uint8Array(await new Response(gzip).arrayBuffer());
  const digest = await sha256(data);
  await bucket.put(key, data, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { sha256: digest } });
  return { key, rows: lines.length, bytes: data.byteLength, sha256: digest };
}

function readState(kv: Kv): BackupState | undefined {
  return kv.get<BackupState>(STATE_KEY);
}

/** Whether a job runs, and when the next step or job is due: Infinity without the bucket. */
export function backupSchedule(bucket: R2Bucket | undefined, kv: Kv): { running: boolean; due: number } {
  if (bucket === undefined) return { running: false, due: Infinity };
  const state = readState(kv);
  if (state === undefined) return { running: false, due: 0 };
  return state.job === null ? { running: false, due: state.next_run } : { running: true, due: state.job.next_step };
}

/** Ops' facts; null without the bucket. */
export function backupFacts(bucket: R2Bucket | undefined, kv: Kv): BackupFacts | null {
  if (bucket === undefined) return null;
  const state = readState(kv);
  if (state === undefined) return { status: 'never', last_backup_at: null, since: null };
  return { status: state.job === null ? state.status : 'running', last_backup_at: state.last_backup_at, since: state.since };
}

/** A restore that succeeded starts a new backup of what it loaded at once. */
export function resetBackup(kv: Kv): void {
  kv.delete(STATE_KEY);
}

/**
 * Ops' view (ops-status.ts): the counter backup_age_seconds and the last backup's time once there is one, and the
 * signals backup_stale (critical) and backup_failed (warning, the last job failed). Nothing without the bucket.
 */
export function backupOps(facts: BackupFacts | null, now: number): {
  counters: Record<string, number>;
  signals: { code: string; severity: Severity; metrics: Record<string, number> }[];
  lastBackupAt: number | null;
} {
  const counters: Record<string, number> = {};
  const signals: { code: string; severity: Severity; metrics: Record<string, number> }[] = [];
  const last = facts?.last_backup_at ?? null;
  const age = last === null ? null : Math.max(Math.floor((now - last) / 1000), 0);
  if (age !== null) counters.backup_age_seconds = age;
  const since = last ?? facts?.since ?? null;
  if (since !== null && now - since > BACKUP_STALE_MS) {
    signals.push({ code: 'backup_stale', severity: Severity.CRITICAL, metrics: age === null ? { has_backup: 0 } : { age_seconds: age, has_backup: 1 } });
  }
  if (facts?.status === 'failed') signals.push({ code: 'backup_failed', severity: Severity.WARNING, metrics: {} });
  return { counters, signals, lastBackupAt: last };
}

export interface BackupDeps {
  readonly store: Store;
  readonly kv: Kv;
  readonly bucket: R2Bucket;
  /** The object's name, recorded in the manifest. */
  readonly object: string;
}

/** Runs the backup step due at `now`; answers whether a job still runs and when the next step or job is due. */
export async function runBackup(deps: BackupDeps, now: number): Promise<{ running: boolean; due: number }> {
  const { store, kv, bucket } = deps;
  const state: BackupState = readState(kv) ?? { since: null, next_run: 0, failed_jobs: 0, status: 'never', last_backup_at: null, last_key: '', error_code: '', job: null };
  if (state.job === null) {
    if (state.next_run > now) return { running: false, due: state.next_run };
    if (storeEmpty(store)) {
      state.next_run = now + BACKUP_EMPTY_RECHECK_MS;
      kv.put(STATE_KEY, state);
      return { running: false, due: state.next_run };
    }
    state.since ??= now;
    state.job = { prefix: `${BACKUP_ROOT}${timestamp(now).replaceAll(':', '')}/`, started_at: now, next_step: now, planned: false, schema_version: 0, errors: 0, cursors: [] };
  }
  const job = state.job;
  if (job.next_step > now) return { running: true, due: job.next_step };
  const step = !job.planned ? 'plan' : job.cursors.some((cursor) => !cursor.done) ? 'export' : 'finish';
  let failure = '';
  try {
    if (now - job.started_at > BACKUP_MAX_JOB_MS) {
      failure = 'job_timeout';
    } else {
      if (step === 'plan') plan(store, job);
      else if (step === 'export') await exportStep(store, bucket, job);
      else await finish(deps, state, job, now);
      job.errors = 0;
      job.next_step = now + BACKUP_CONTINUE_MS;
    }
  } catch (error) {
    // SQLite or R2 failed (or a bug): the step runs again from the parts stored so far.
    job.errors += 1;
    job.next_step = now + BACKUP_STEP_RETRY_MS;
    log({ error: error instanceof Error ? error.name : 'unknown', step, errors: job.errors });
    if (job.errors >= BACKUP_MAX_ERRORS) failure = error instanceof Error && error.message === 'unsupported_schema' ? 'unsupported_schema' : 'storage_error';
  }
  if (failure !== '') {
    log({ failed: failure, prefix: job.prefix });
    state.job = null;
    state.failed_jobs += 1;
    state.status = 'failed';
    state.error_code = failure;
    state.next_run = state.failed_jobs < BACKUP_MAX_FAILED_JOBS ? now + BACKUP_FAILED_RETRY_MS : nextRun(now);
  }
  kv.put(STATE_KEY, state);
  return state.job === null ? { running: false, due: state.next_run } : { running: true, due: state.job.next_step };
}

/** Fixes the tables to copy, each with its schema, and the store's schema version. */
function plan(store: Store, job: Job): void {
  job.schema_version = Number(store.getMeta('schema_version') ?? 0);
  job.cursors = planTables(store).map((table) => ({ ...table, after: null, done: false, parts: [] }));
  job.planned = true;
}

/** Pages of the tables still open, each stored as one part, until the step's byte or part budget is spent. */
async function exportStep(store: Store, bucket: R2Bucket, job: Job): Promise<void> {
  let budget = BACKUP_STEP_BYTES;
  let parts = 0;
  for (const cursor of job.cursors) {
    const keyList = cursor.key.map(sqlName).join(', ');
    // Positional names (c0, c1, ...): a result column is never named after another.
    const select = cursor.columns.map((column, index) => `${sqlName(column)} AS c${String(index)}`).join(', ');
    const keyAt = cursor.key.map((column) => cursor.columns.indexOf(column));
    while (!cursor.done && budget > 0 && parts < BACKUP_STEP_PARTS) {
      const after = cursor.after === null ? '' : `WHERE (${keyList}) > (${cursor.key.map(() => '?').join(', ')})`;
      const rows = store.all(`SELECT ${select} FROM ${sqlName(cursor.name)} ${after} ORDER BY ${keyList} LIMIT ?`, ...(cursor.after ?? []), BACKUP_PART_ROWS)
        .map((row) => cursor.columns.map((_, index) => row[`c${String(index)}`] ?? null));
      const lines: string[] = [];
      let bytes = 0;
      let last = cursor.after;
      for (const row of rows) {
        const line = JSON.stringify(row.map(encodeValue));
        const size = utf8.encode(line).byteLength + 1;
        // The first row is kept whatever its size (SQLite's own row limit bounds it).
        if (lines.length > 0 && bytes + size > Math.min(BACKUP_PART_BYTES, budget)) break;
        lines.push(line);
        bytes += size;
        last = keyAt.map((index) => row[index] as Value);
      }
      // The cursor moves only once its part is stored.
      if (lines.length > 0) cursor.parts.push(await storePart(bucket, `${job.prefix}${cursor.name}/${String(cursor.parts.length + 1).padStart(5, '0')}.ndjson.gz`, lines));
      budget -= bytes;
      parts += 1;
      cursor.after = last;
      cursor.done = lines.length === rows.length && rows.length < BACKUP_PART_ROWS;
    }
  }
}

/** Writes the manifest (it marks the backup complete) and latest.json, then applies retention. */
async function finish(deps: BackupDeps, state: BackupState, job: Job, now: number): Promise<void> {
  const { bucket } = deps;
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    object: deps.object,
    started_at: timestamp(job.started_at),
    created_at: timestamp(now),
    schema_version: job.schema_version,
    tables: job.cursors.map((cursor) => ({
      name: cursor.name,
      sql: cursor.sql,
      indexes: cursor.indexes,
      columns: cursor.columns,
      key: cursor.key,
      rows: cursor.parts.reduce((sum, part) => sum + part.rows, 0),
      bytes: cursor.parts.reduce((sum, part) => sum + part.bytes, 0),
      parts: cursor.parts,
    })),
  };
  const json = { httpMetadata: { contentType: 'application/json' } };
  // A repeat after a failed latest.json leaves the complete backup as it is.
  if ((await bucket.head(job.prefix + MANIFEST)) === null) await bucket.put(job.prefix + MANIFEST, JSON.stringify(manifest, null, 1), json);
  await bucket.put(LATEST, JSON.stringify({ key: job.prefix }), json);
  state.job = null;
  state.failed_jobs = 0;
  state.status = 'ok';
  state.error_code = '';
  state.last_backup_at = now;
  state.last_key = job.prefix;
  state.next_run = nextRun(now, true);
  log({ done: job.prefix, tables: manifest.tables.length, rows: manifest.tables.reduce((sum, table) => sum + table.rows, 0) });
  try {
    await applyRetention(bucket, job.prefix);
  } catch (error) {
    // The backup is complete; the next one retries the cleanup.
    log({ retention_error: error instanceof Error ? error.name : 'unknown' });
  }
}

/** Every complete backup but the newest BACKUP_KEEP (`current` counts) and every incomplete one older than `current`. */
async function applyRetention(bucket: R2Bucket, current: string): Promise<void> {
  const prefixes: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await bucket.list({ prefix: BACKUP_ROOT, delimiter: '/', ...(cursor === undefined ? {} : { cursor }) });
    prefixes.push(...listed.delimitedPrefixes);
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  const older = prefixes.filter((prefix) => prefix < current).sort().reverse();
  const kept: string[] = [];
  for (const prefix of older) if (kept.length < BACKUP_KEEP - 1 && (await bucket.head(prefix + MANIFEST)) !== null) kept.push(prefix);
  for (const prefix of older) {
    if (kept.includes(prefix)) continue;
    await deletePrefix(bucket, prefix);
    log({ deleted: prefix });
  }
}

/** Every object under `prefix` (a backup has a few dozen; bounded anyway). */
async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await bucket.list({ prefix, limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    if (!listed.truncated) return;
  }
  throw new Error('Too many objects under a backup prefix');
}
