/**
 * Tasks' weekly backup (docs/backup.md): every table of backup.ts into the private bucket `tasks-backups` (binding
 * BACKUPS), one bounded step per Alarm of the jobs object (jobs.ts). The layout:
 *
 *   backups/<job start>/<table>/<seq:05d>.ndjson.gz   one gzip part per table and step, one JSON array per row
 *   backups/<job start>/manifest.json                 written after every part: a prefix without it is incomplete
 *   latest.json                                       {"key": "backups/<job start>/"}, after the manifest
 *
 * `<job start>` is the UTC second the job started (`2026-10-25T100000Z`). The manifest (format tasks-d1-backup-v1)
 * holds the same `tasks` section the backups Todofy made of Tasks held: the applied migration, the change sequence when
 * the job planned and when it ended, and each table with its columns, key, rows and every part's SHA-256
 * (tools/backup-restore.ts reads both).
 *
 * A job starts every Sunday at 10:00 UTC, and at once when the object has no backup state yet (the first job after the
 * release that bound the bucket). A step reads at most QUERY_BUDGET D1 statements (the plan's one batch, or pages of
 * two) and stores each table it read as one part; a cursor moves only after its part is stored, so a failed step
 * repeats its pages and overwrites the same keys. Owner edits continue while a job runs (a minute or so): the restore
 * tool warns when the two change sequences differ. A job never touches another backup; after its manifest, all but the
 * newest KEEP complete backups are deleted with every incomplete prefix older than it. MAX_ERRORS failed steps in a
 * row fail the job, which is tried again FAILED_RETRY_MS later, up to MAX_FAILED_JOBS times, then on the next Sunday.
 *
 * The object's storage holds the state (`backup`), which it can lose: the next job is then due at once.
 */
import { Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import type { Env } from './env.ts';
import { backupPage, PAGE_STATEMENTS, planBackup } from './backup.ts';

export const BACKUP_FORMAT = 'tasks-d1-backup-v1';
export const BACKUP_ROOT = 'backups/';
export const MANIFEST = 'manifest.json';
export const LATEST = 'latest.json';
/** Complete backups kept, the new one included. */
export const KEEP = 6;
/** D1 statements a step may read: the plan's batch, or 15 pages. With runJobs' at most 9 an Alarm stays under 50. */
export const QUERY_BUDGET = 30;
const HOUR_MS = 3_600_000;
/** While a job runs, the next step comes this soon; after a failed step, ERROR_RETRY_MS. */
export const CONTINUE_MS = 1000;
export const ERROR_RETRY_MS = 60_000;
export const MAX_ERRORS = 3;
export const FAILED_RETRY_MS = 6 * HOUR_MS;
export const MAX_FAILED_JOBS = 3;
/** backup_stale: no complete backup for this long (a week and a day), or since the first step when there is none. */
export const BACKUP_STALE_MS = 8 * 24 * HOUR_MS;
/** Sunday (getUTCDay) at this UTC hour. */
const RUN_HOUR = 10;
const MAX_LIST_PAGES = 10;
const STATE_KEY = 'backup';

export interface BackupPart {
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}
/** One table of the running job, with the columns its plan named. */
interface Cursor {
  table: string;
  columns: string[];
  key: string[];
  max_rowid: number;
  last: number;
  done: boolean;
  parts: BackupPart[];
}
interface Job {
  prefix: string;
  started_at: number;
  planned: boolean;
  schema_version: string;
  change_start: number;
  change_end: number;
  errors: number;
  cursors: Cursor[];
}
export interface BackupState {
  /** When the object first ran a backup step (ms): a first backup's stale time runs from it. */
  since: number;
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
/** What Ops reports (ops.ts): none of it without the binding. */
export interface BackupFacts {
  status: 'never' | 'ok' | 'failed' | 'running';
  /** When the newest complete backup finished (ms). */
  last_backup_at: number | null;
  /** When the backup first ran (ms), or null before. */
  since: number | null;
}
/** The object's storage, as much of it as the backup uses. */
export interface BackupStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** Keys, counts and codes only: never row content. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ backup: fields }));
}

/** `2026-10-25T10:00:00Z`: the manifest's times. */
function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The first Sunday 10:00 UTC after `now`; with `skipToday`, not on `now`'s UTC day (a backup finished early). */
export function nextRun(now: number, skipToday = false): number {
  const today = new Date(now);
  today.setUTCHours(RUN_HOUR, 0, 0, 0);
  let at = today.getTime() + ((7 - today.getUTCDay()) % 7) * 24 * HOUR_MS;
  if (at <= now || (skipToday && at === today.getTime())) at += 7 * 24 * HOUR_MS;
  return at;
}

function newJob(now: number): Job {
  const second = timestamp(now).replaceAll(':', '');
  return {
    prefix: `${BACKUP_ROOT}${second}/`,
    started_at: now,
    planned: false,
    schema_version: '',
    change_start: 0,
    change_end: 0,
    errors: 0,
    cursors: [],
  };
}

/** The facts Ops reports, and when the next step is due (Infinity without the binding). */
export async function backupStatus(env: Env, store: BackupStore): Promise<{ facts: BackupFacts | null; due: number }> {
  if (!env.BACKUPS) return { facts: null, due: Infinity };
  const state = await store.get<BackupState>(STATE_KEY);
  if (!state) return { facts: { status: 'never', last_backup_at: null, since: null }, due: 0 };
  return {
    facts: { status: state.job ? 'running' : state.status, last_backup_at: state.last_backup_at, since: state.since },
    due: state.job ? 0 : state.next_run,
  };
}

/**
 * Ops' view of the backup (ops.ts): the counter backup_age_seconds and the last backup's time once there is one, and the
 * signals backup_stale (critical) and backup_failed (warning, the last job failed). Nothing without the binding.
 */
export function backupOps(facts: BackupFacts | null, now: number) {
  const counters: Record<string, number> = {};
  const signals: { code: string; severity: Severity; metrics: Record<string, number> }[] = [];
  const last = facts?.last_backup_at ?? null;
  const age = last === null ? null : Math.max(Math.floor((now - last) / 1000), 0);
  if (age !== null) counters.backup_age_seconds = age;
  const since = last ?? facts?.since ?? null;
  if (since !== null && now - since > BACKUP_STALE_MS)
    signals.push({
      code: 'backup_stale',
      severity: Severity.CRITICAL,
      metrics: age === null ? { has_backup: 0 } : { age_seconds: age, has_backup: 1 },
    });
  if (facts?.status === 'failed') signals.push({ code: 'backup_failed', severity: Severity.WARNING, metrics: {} });
  return { counters, signals, lastBackupAt: last === null ? null : new Date(last).toISOString() };
}

/** Runs the backup's step due at `now` and answers when the next one is due (Infinity without the binding). */
export async function runBackup(env: Env, store: BackupStore, now: number): Promise<number> {
  const bucket = env.BACKUPS;
  if (!bucket) return Infinity;
  const state = (await store.get<BackupState>(STATE_KEY)) ?? {
    since: now,
    next_run: 0,
    failed_jobs: 0,
    status: 'never',
    last_backup_at: null,
    last_key: '',
    error_code: '',
    job: null,
  };
  if (!state.job) {
    if (state.next_run > now) return state.next_run;
    state.job = newJob(now);
  }
  const job = state.job;
  const step = !job.planned ? 'plan' : job.cursors.some((cursor) => !cursor.done) ? 'export' : 'finish';
  let retry = CONTINUE_MS;
  try {
    if (step === 'plan') await plan(env.DB, job);
    else if (step === 'export') await exportStep(env.DB, bucket, job);
    else await finish(bucket, state, job, now);
    job.errors = 0;
  } catch (error) {
    // D1 or R2 failed (or a bug): the step runs again from the cursors of the parts stored so far.
    job.errors += 1;
    retry = ERROR_RETRY_MS;
    log({ error: error instanceof Error ? error.name : 'unknown', step, errors: job.errors });
    if (job.errors >= MAX_ERRORS) {
      log({ failed: 'storage_error', prefix: job.prefix });
      state.job = null;
      state.failed_jobs += 1;
      Object.assign(state, { status: 'failed', error_code: 'storage_error' });
      state.next_run = state.failed_jobs < MAX_FAILED_JOBS ? now + FAILED_RETRY_MS : nextRun(now);
    }
  }
  await store.put(STATE_KEY, state);
  return state.job ? now + retry : state.next_run;
}

/** Fixes the snapshot: the migration, the change sequence and every table's max rowid, in one batch. */
async function plan(db: D1Database, job: Job): Promise<void> {
  const planned = await planBackup(db);
  job.schema_version = planned.schema_version;
  job.change_start = job.change_end = planned.change_sequence;
  job.cursors = planned.tables.map((table) => ({
    table: table.name,
    columns: [...table.columns],
    key: [...table.key],
    max_rowid: table.max_rowid,
    last: 0,
    done: table.max_rowid === 0,
    parts: [],
  }));
  job.planned = true;
}

/** Pages of the tables still open into one part each, until the step's statement budget is spent. */
async function exportStep(db: D1Database, bucket: R2Bucket, job: Job): Promise<void> {
  let budget = QUERY_BUDGET;
  for (const cursor of job.cursors) {
    if (cursor.done) continue;
    if (budget < PAGE_STATEMENTS) break;
    const lines: string[] = [];
    let last = cursor.last;
    let done = false;
    while (!done && budget >= PAGE_STATEMENTS) {
      budget -= PAGE_STATEMENTS;
      const page = await backupPage(db, { name: cursor.table, columns: cursor.columns }, last, cursor.max_rowid);
      lines.push(...page.rows);
      ({ last, done } = page);
      job.change_end = Math.max(job.change_end, page.change_sequence);
    }
    if (lines.length) {
      const key = `${job.prefix}${cursor.table}/${String(cursor.parts.length + 1).padStart(5, '0')}.ndjson.gz`;
      cursor.parts.push(await storePart(bucket, key, lines));
    }
    cursor.last = last;
    cursor.done = done;
  }
}

async function storePart(bucket: R2Bucket, key: string, lines: string[]): Promise<BackupPart> {
  const gzip = new Blob([`${lines.join('\n')}\n`]).stream().pipeThrough(new CompressionStream('gzip'));
  const data = new Uint8Array(await new Response(gzip).arrayBuffer());
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  await bucket.put(key, data, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { sha256 } });
  return { key, rows: lines.length, bytes: data.byteLength, sha256 };
}

/** Writes the manifest (it marks the backup complete) and latest.json, then applies retention. */
async function finish(bucket: R2Bucket, state: BackupState, job: Job, now: number): Promise<void> {
  const tables = job.cursors.map((cursor) => ({
    name: cursor.table,
    columns: cursor.columns,
    key: cursor.key,
    max_rowid: cursor.max_rowid,
    rows: cursor.parts.reduce((sum, part) => sum + part.rows, 0),
    bytes: cursor.parts.reduce((sum, part) => sum + part.bytes, 0),
    parts: cursor.parts,
  }));
  const manifest = JSON.stringify(
    {
      format: BACKUP_FORMAT,
      started_at: timestamp(job.started_at),
      created_at: timestamp(now),
      tasks: {
        schema_version: job.schema_version,
        change_sequence: { start: job.change_start, end: job.change_end },
        // Rows with rowid <= max_rowid when the job planned; nothing newer.
        tables,
      },
    },
    null,
    1,
  );
  const json = { httpMetadata: { contentType: 'application/json' } };
  await bucket.put(job.prefix + MANIFEST, manifest, json);
  await bucket.put(LATEST, JSON.stringify({ key: job.prefix }), json);
  Object.assign(state, {
    job: null,
    failed_jobs: 0,
    status: 'ok',
    error_code: '',
    last_backup_at: now,
    last_key: job.prefix,
    next_run: nextRun(now, true),
  });
  log({ done: job.prefix, rows: tables.reduce((sum, table) => sum + table.rows, 0) });
  try {
    await applyRetention(bucket, job.prefix);
  } catch (error) {
    // The backup is complete; the next one retries the cleanup.
    log({ retention_error: error instanceof Error ? error.name : 'unknown' });
  }
}

/** Every complete backup but the newest KEEP (`current` counts) and every incomplete one older than `current`. */
async function applyRetention(bucket: R2Bucket, current: string): Promise<void> {
  const listed = await bucket.list({ prefix: BACKUP_ROOT, delimiter: '/' });
  const older = listed.delimitedPrefixes.filter((prefix) => prefix < current).sort().reverse();
  const kept: string[] = [];
  for (const prefix of older)
    if (kept.length < KEEP - 1 && (await bucket.head(prefix + MANIFEST)) !== null) kept.push(prefix);
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
    if (keys.length) await bucket.delete(keys);
    if (!listed.truncated) return;
  }
  throw new Error('Too many objects under a backup prefix');
}
