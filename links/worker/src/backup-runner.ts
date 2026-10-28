/**
 * The daily backup (../../docs/backup.md): every table of backup.ts into the private bucket `links-backups` (binding
 * BACKUPS), one bounded step per tick of the Worker's one cron trigger (index.ts). The layout:
 *
 *   backups/<job start>/<table>/<seq:05d>.ndjson.gz   one gzip part per table and step, one JSON array per row
 *   backups/<job start>/manifest.json                 written after every part: a prefix without it is incomplete
 *   latest.json                                       {"key": "backups/<job start>/"}, after the manifest
 *   state.json                                        the job's cursors and the last result, after every step
 *
 * `<job start>` is the UTC second the job started (`2026-10-28T052500Z`). The manifest (format links-backup-v1) holds
 * the applied migration, the change mark when the job planned and when it ended, and each table with its columns,
 * key, rows and every part's SHA-256 (tools/backup-restore.ts reads it).
 *
 * A job starts every day at 05:25 UTC, and at the first tick when the bucket holds no state yet (the first job after
 * the release that bound it). A tick with no job due reads state.json and stops. A step reads at most QUERY_BUDGET D1
 * statements and STEP_BYTES of rows, within Workers Free's 10 ms of CPU, and stores each table it read as one part; a
 * cursor moves only after its part is stored, so a failed step repeats its pages and overwrites the same keys. The
 * last step checks every part's stored SHA-256 and size against the job's record before it writes the manifest.
 * Owner edits continue while a job runs: the restore tool warns when the two change marks differ. A job never touches
 * another backup; after its manifest, all but the newest KEEP complete backups are deleted with every incomplete
 * prefix older than it. MAX_ERRORS failed steps in a row fail the job, which starts again FAILED_RETRY_MS later, or at
 * the next daily slot after MAX_FAILED_JOBS failed jobs in a row. Losing state.json only makes the next job due at once.
 */
import { Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import { BACKUP_TABLES, backupPage, changeMark, planBackup, type ChangeMark } from './backup.ts';
import type { Env } from './env.ts';

export const BACKUP_FORMAT = 'links-backup-v1';
export const BACKUP_ROOT = 'backups/';
export const MANIFEST = 'manifest.json';
export const LATEST = 'latest.json';
export const STATE = 'state.json';
/** Complete backups kept, the new one included. */
export const KEEP = 30;
/** D1 statements a step may read: under Free's 50 per invocation. */
export const QUERY_BUDGET = 30;
/** Bytes of row JSON a step may read and store: gzip and SHA-256 stay within Free's 10 ms (test/runtime/cpu.test.ts). */
export const STEP_BYTES = 128 << 10;
export const MAX_ERRORS = 3;
const HOUR_MS = 3_600_000;
export const FAILED_RETRY_MS = HOUR_MS;
export const MAX_FAILED_JOBS = 3;
/** backup_stale: no complete backup for this long, or since the first step when there is none. */
export const BACKUP_STALE_MS = 72 * HOUR_MS;
/** The daily slot: this many minutes after 00:00 UTC (05:25). */
const RUN_MINUTE = 5 * 60 + 25;
const MAX_LIST_PAGES = 5;
/** The last step found a part that differs from the job's record (another step overwrote it): the job fails. */
const PART_MISMATCH = 'part_mismatch';

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
  /** The key of the last row stored; null before the first. */
  after: unknown[] | null;
  done: boolean;
  parts: BackupPart[];
}
interface Job {
  prefix: string;
  started_at: number;
  planned: boolean;
  schema_version: string;
  mark: ChangeMark | null;
  errors: number;
  cursors: Cursor[];
}
export interface BackupState {
  /** When the first backup step ran (ms): a first backup's stale time runs from it. */
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
export type BackupStep = 'unbound' | 'idle' | 'plan' | 'export' | 'finish';

/** Keys, counts and codes only: never row content. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ backup: fields }));
}

/** `2026-10-28T05:25:00Z`: the manifest's times. */
function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The first daily slot after `now`; with `skipToday`, not on `now`'s UTC day (a backup finished early). */
export function nextRun(now: number, skipToday = false): number {
  const today = new Date(now);
  today.setUTCHours(0, RUN_MINUTE, 0, 0);
  const at = today.getTime();
  return at <= now || skipToday ? at + 24 * HOUR_MS : at;
}

async function readState(bucket: R2Bucket): Promise<BackupState | null> {
  const object = await bucket.get(STATE);
  if (!object) return null;
  try {
    return await object.json<BackupState>();
  } catch {
    // An unreadable state is a lost one: the next job is due at once.
    return null;
  }
}

/**
 * The facts Ops reports; null without the binding. A bucket that does not answer is a failed backup: no step can run
 * either, and a state that cannot be read could never turn stale.
 */
export async function backupFacts(env: Env): Promise<BackupFacts | null> {
  if (!env.BACKUPS) return null;
  let state: BackupState | null;
  try {
    state = await readState(env.BACKUPS);
  } catch {
    return { status: 'failed', last_backup_at: null, since: null };
  }
  if (!state) return { status: 'never', last_backup_at: null, since: null };
  return { status: state.job ? 'running' : state.status, last_backup_at: state.last_backup_at, since: state.since };
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

function newJob(now: number): Job {
  return {
    prefix: `${BACKUP_ROOT}${timestamp(now).replaceAll(':', '')}/`,
    started_at: now,
    planned: false,
    schema_version: '',
    mark: null,
    errors: 0,
    cursors: [],
  };
}

/** Runs the backup's step due at `now` (a cron tick) and answers which one it was. */
export async function runBackup(env: Env, now: number): Promise<BackupStep> {
  const bucket = env.BACKUPS;
  if (!bucket) return 'unbound';
  const state = (await readState(bucket)) ?? {
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
    if (state.next_run > now) return 'idle';
    state.job = newJob(now);
  }
  const job = state.job;
  const step = !job.planned ? 'plan' : job.cursors.some((cursor) => !cursor.done) ? 'export' : 'finish';
  try {
    if (step === 'plan') await plan(env.DB, job);
    else if (step === 'export') await exportStep(env.DB, bucket, job);
    else await finish(env.DB, bucket, state, job, now);
    job.errors = 0;
  } catch (error) {
    // D1 or R2 failed (or a bug): the next tick runs the step again from the parts stored so far.
    const code = error instanceof Error && error.message === PART_MISMATCH ? PART_MISMATCH : 'storage_error';
    job.errors += 1;
    log({ error: error instanceof Error ? error.name : 'unknown', code, step, errors: job.errors });
    if (job.errors >= MAX_ERRORS) {
      log({ failed: code, prefix: job.prefix });
      state.job = null;
      state.failed_jobs += 1;
      state.status = 'failed';
      state.error_code = code;
      state.next_run = state.failed_jobs < MAX_FAILED_JOBS ? now + FAILED_RETRY_MS : nextRun(now);
    }
  }
  await bucket.put(STATE, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
  return step;
}

/** Fixes the migration and the change mark in one batch, and opens every table. */
async function plan(db: D1Database, job: Job): Promise<void> {
  const planned = await planBackup(db);
  job.schema_version = planned.schema_version;
  job.mark = planned.mark;
  job.cursors = BACKUP_TABLES.map((table) => ({
    table: table.name,
    columns: [...table.columns],
    key: [...table.key],
    after: null,
    done: false,
    parts: [],
  }));
  job.planned = true;
}

/** Pages of the tables still open into one part each, until the step's statements or bytes are spent. */
async function exportStep(db: D1Database, bucket: R2Bucket, job: Job): Promise<void> {
  let statements = QUERY_BUDGET;
  let bytes = STEP_BYTES;
  for (const cursor of job.cursors) {
    if (cursor.done) continue;
    if (statements < 1 || bytes <= 0) break;
    const lines: string[] = [];
    let after = cursor.after;
    let done = false;
    while (!done && statements >= 1 && bytes > 0) {
      statements -= 1;
      const page = await backupPage(db, { name: cursor.table, columns: cursor.columns }, after, bytes);
      lines.push(...page.rows);
      bytes -= page.bytes;
      ({ last: after, done } = page);
    }
    if (lines.length) {
      const key = `${job.prefix}${cursor.table}/${String(cursor.parts.length + 1).padStart(5, '0')}.ndjson.gz`;
      cursor.parts.push(await storePart(bucket, key, lines));
    }
    cursor.after = after;
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

/** Every object under `prefix`, or null past MAX_LIST_PAGES pages (never decide on a partial listing). */
async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[] | null> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await bucket.list({
      prefix,
      limit: 1000,
      include: ['customMetadata'],
      ...(cursor === undefined ? {} : { cursor }),
    });
    objects.push(...listed.objects);
    if (!listed.truncated) return objects;
    cursor = listed.cursor;
  }
  return null;
}

/**
 * Checks every part against the bucket (its SHA-256 and size), then writes the manifest (it marks the backup complete)
 * and latest.json, and applies retention.
 */
async function finish(db: D1Database, bucket: R2Bucket, state: BackupState, job: Job, now: number): Promise<void> {
  const end = await changeMark(db);
  const stored = new Map((await listAll(bucket, job.prefix))?.map((object) => [object.key, object]));
  for (const part of job.cursors.flatMap((cursor) => cursor.parts)) {
    const object = stored.get(part.key);
    if (object?.size !== part.bytes || object.customMetadata?.sha256 !== part.sha256)
      throw new Error(PART_MISMATCH);
  }
  const tables = job.cursors.map((cursor) => ({
    name: cursor.table,
    columns: cursor.columns,
    key: cursor.key,
    rows: cursor.parts.reduce((sum, part) => sum + part.rows, 0),
    bytes: cursor.parts.reduce((sum, part) => sum + part.bytes, 0),
    parts: cursor.parts,
  }));
  const manifest = JSON.stringify(
    {
      format: BACKUP_FORMAT,
      started_at: timestamp(job.started_at),
      created_at: timestamp(now),
      links: {
        schema_version: job.schema_version,
        // Rows read page by page between the two marks; equal marks: nothing changed meanwhile.
        change_mark: { start: job.mark, end },
        tables,
      },
    },
    null,
    1,
  );
  const json = { httpMetadata: { contentType: 'application/json' } };
  // A finish that stored its manifest but failed after it runs again: the complete backup is never rewritten.
  if (!stored.has(job.prefix + MANIFEST)) await bucket.put(job.prefix + MANIFEST, manifest, json);
  await bucket.put(LATEST, JSON.stringify({ key: job.prefix }), json);
  state.job = null;
  state.failed_jobs = 0;
  state.status = 'ok';
  state.error_code = '';
  state.last_backup_at = now;
  state.last_key = job.prefix;
  state.next_run = nextRun(now, true);
  log({ done: job.prefix, rows: tables.reduce((sum, table) => sum + table.rows, 0) });
  try {
    await applyRetention(bucket, job.prefix);
  } catch (error) {
    // The backup is complete; the next one retries the cleanup.
    log({ retention_error: error instanceof Error ? error.name : 'unknown' });
  }
}

/**
 * Deletes every complete backup but the newest KEEP (`current` counts) and every incomplete prefix older than
 * `current`. Nothing newer than `current` is touched. One listing of the prefixes and a manifest check each, so the
 * cost does not grow with the parts the bucket holds.
 */
async function applyRetention(bucket: R2Bucket, current: string): Promise<void> {
  const listed = await bucket.list({ prefix: BACKUP_ROOT, delimiter: '/' });
  const older = listed.delimitedPrefixes.filter((prefix) => prefix < current).sort().reverse();
  const kept = new Set<string>();
  for (const prefix of older)
    if (kept.size < KEEP - 1 && (await bucket.head(prefix + MANIFEST)) !== null) kept.add(prefix);
  for (const prefix of older) {
    if (kept.has(prefix)) continue;
    await deletePrefix(bucket, prefix);
    log({ deleted: prefix });
  }
}

/** Every object under `prefix`, a page of at most 1000 keys at a time. */
async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await bucket.list({ prefix, limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    if (!listed.truncated) return;
  }
  throw new Error('Too many objects under a backup prefix');
}
