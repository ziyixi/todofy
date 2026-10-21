/**
 * Tasks' weekly backup (src/backup-runner.ts) on real D1 and R2 at fixed clocks, with the object's storage as a Map,
 * then the jobs object running it from its Alarm and Ops reporting it. Synthetic rows only.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { BACKUP_TABLES, PLAN_STATEMENTS } from '../../src/backup.ts';
import {
  BACKUP_FORMAT,
  BACKUP_STALE_MS,
  backupOps,
  backupStatus,
  CONTINUE_MS,
  ERROR_RETRY_MS,
  FAILED_RETRY_MS,
  LATEST,
  MANIFEST,
  nextRun,
  QUERY_BUDGET,
  runBackup,
  type BackupPart,
  type BackupState,
  type BackupStore,
} from '../../src/backup-runner.ts';
import type { Env } from '../../src/env.ts';
import { measuredReads, startHarness, type Harness } from './harness.ts';

const DAY = 86_400_000;
/** A Sunday at 10:00 UTC, the weekly slot. */
const SUNDAY = Date.parse('2026-10-25T10:00:00Z');
/** More tasks than one step's pages hold: 1,600 rows are 16 pages of 100. */
const TASK_ROWS = 1600;

let harness: Harness;
let bucket: R2Bucket;
beforeAll(async () => {
  harness = await startHarness({ backups: true });
  bucket = (await harness.mf.getR2Bucket('BACKUPS', 'tasks')) as unknown as R2Bucket;
  await harness.db.batch([
    harness.db.prepare("INSERT INTO projects(id,title,created_at,updated_at) VALUES('work','Synthetic work',1,1)"),
    harness.db.prepare("INSERT INTO labels(id,title,created_at,updated_at) VALUES('l1','synthetic',1,1)"),
    harness.db
      .prepare(
        `INSERT INTO tasks(id,title,description,project_id,label_ids,sort_order,created_at,updated_at)
        SELECT printf('t%04d',value),'Synthetic task '||value,'it''s “quoted” 汉字'||char(10)||value,'work','["l1"]',
        value+0.5,value,value FROM json_each(?)`,
      )
      .bind(JSON.stringify(Array.from({ length: TASK_ROWS }, (_, index) => index))),
    harness.db.prepare(
      "INSERT INTO completions(id,task_id,title,completed_at,project_id) VALUES('c1','t0001','Synthetic task 1',5,'work')",
    ),
    harness.db.prepare(
      "INSERT INTO gtd_days(day,scope,open,age_0_7,age_8_14,age_15_30,age_31_plus,oldest_days,overdue,undated,computed_at) VALUES('2026-10-24','all',2,2,0,0,0,1,0,2,4)",
    ),
  ]);
});
afterAll(async () => {
  await harness.dispose();
});

/** The object's storage: values are copied in and out, as Durable Object storage does. */
class Store implements BackupStore {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(key)) as T | undefined);
  }
  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
  get state(): BackupState {
    return this.values.get('backup') as BackupState;
  }
}
function env(overrides: Partial<Env> = {}): Env {
  return { DB: harness.db, BACKUPS: bucket, ...overrides } as unknown as Env;
}
/** Steps the job at `now` until it ends: the number of steps. */
async function finish(store: Store, now: number, environment = env()): Promise<number> {
  for (let steps = 1; steps < 100; steps++) {
    await runBackup(environment, store, now);
    if (!store.state.job) return steps;
  }
  throw new Error('The job did not end');
}
async function json<T>(key: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`Missing ${key}`);
  return (await object.json()) as T;
}
interface Manifest {
  format: string;
  started_at: string;
  created_at: string;
  tasks: {
    schema_version: string;
    change_sequence: { start: number; end: number };
    tables: { name: string; columns: string[]; key: string[]; max_rowid: number; rows: number; parts: BackupPart[] }[];
  };
}
/** A table's rows as its parts hold them, each part checked against its SHA-256. */
async function partRows(parts: BackupPart[]): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  for (const part of parts) {
    const object = await bucket.get(part.key);
    if (!object) throw new Error(`Missing ${part.key}`);
    const data = new Uint8Array(await object.arrayBuffer());
    expect(createHash('sha256').update(data).digest('hex'), part.key).toBe(part.sha256);
    expect(object.customMetadata?.sha256).toBe(part.sha256);
    const lines = new TextDecoder().decode(gunzipSync(data)).split('\n').filter(Boolean);
    expect(lines, part.key).toHaveLength(part.rows);
    rows.push(...lines.map((line) => JSON.parse(line) as unknown[]));
  }
  return rows;
}

test('a job plans, writes one part per table and step, then its manifest and latest.json', async () => {
  const store = new Store();
  // The first step only plans, in one batch; nothing is stored yet.
  const planning = measuredReads(harness.db);
  expect(await runBackup(env({ DB: planning.db }), store, SUNDAY)).toBe(SUNDAY + CONTINUE_MS);
  expect(planning.metrics.statements).toBe(PLAN_STATEMENTS);
  expect(store.state.job?.prefix).toBe('backups/2026-10-25T100000Z/');
  expect((await bucket.list({ prefix: 'backups/' })).objects).toEqual([]);
  // Every later step stays within its statement budget.
  let next = SUNDAY + CONTINUE_MS;
  for (let steps = 0; next === SUNDAY + CONTINUE_MS; steps++) {
    expect(steps).toBeLessThan(20);
    const step = measuredReads(harness.db);
    next = await runBackup(env({ DB: step.db }), store, SUNDAY);
    expect(step.metrics.statements).toBeLessThanOrEqual(QUERY_BUDGET);
  }
  // Done: the next job is next Sunday's.
  expect(next).toBe(SUNDAY + 7 * DAY);
  expect(nextRun(SUNDAY, true)).toBe(next);
  expect(store.state).toMatchObject({ status: 'ok', last_backup_at: SUNDAY, failed_jobs: 0, job: null });

  expect(await json(LATEST)).toEqual({ key: 'backups/2026-10-25T100000Z/' });
  const manifest = await json<Manifest>(`backups/2026-10-25T100000Z/${MANIFEST}`);
  expect(manifest).toMatchObject({ format: BACKUP_FORMAT, started_at: '2026-10-25T10:00:00Z' });
  expect(manifest.tasks.schema_version).toMatch(/^\d{4}_.*\.sql$/);
  expect(manifest.tasks.change_sequence.start).toBe(manifest.tasks.change_sequence.end);
  expect(manifest.tasks.tables.map((table) => table.name)).toEqual(BACKUP_TABLES.map((table) => table.name));
  for (const table of manifest.tasks.tables) {
    const stored = await harness.db.prepare(`SELECT ${table.columns.join(',')} FROM ${table.name} ORDER BY rowid`).raw();
    expect(await partRows(table.parts), table.name).toEqual(stored);
    expect(table.rows, table.name).toBe(stored.length);
  }
  // 16 pages of tasks: the first step that reads them stops at its budget, the next one finishes them.
  const tasks = manifest.tasks.tables.find((table) => table.name === 'tasks');
  expect(tasks?.parts.length).toBeGreaterThan(1);
  expect(tasks?.rows).toBe(TASK_ROWS);
  // Not due again before next Sunday.
  expect(await runBackup(env(), store, SUNDAY + DAY)).toBe(SUNDAY + 7 * DAY);
});

test('a failed step repeats its pages; three in a row fail the job, which is tried again later', async () => {
  let failures = 0;
  const flaky = {
    put: (...args: Parameters<R2Bucket['put']>) => {
      if (failures > 0) {
        failures--;
        return Promise.reject(new Error('Synthetic R2 failure'));
      }
      return bucket.put(...args);
    },
    get: bucket.get.bind(bucket),
    head: bucket.head.bind(bucket),
    list: bucket.list.bind(bucket),
    delete: bucket.delete.bind(bucket),
  } as unknown as R2Bucket;
  const at = SUNDAY + 7 * DAY;
  const store = new Store();
  await runBackup(env({ BACKUPS: flaky }), store, at); // the plan
  failures = 1;
  expect(await runBackup(env({ BACKUPS: flaky }), store, at)).toBe(at + ERROR_RETRY_MS);
  expect(store.state.job?.errors).toBe(1);
  expect(store.state.job?.cursors.every((cursor) => cursor.parts.length === 0)).toBe(true);
  await finish(store, at, env({ BACKUPS: flaky }));
  const manifest = await json<Manifest>(`${store.state.last_key}${MANIFEST}`);
  const tasks = manifest.tasks.tables.find((table) => table.name === 'tasks');
  expect((await partRows(tasks?.parts ?? [])).length).toBe(TASK_ROWS);

  const failing = new Store();
  const later = at + 60_000;
  failures = Infinity;
  await runBackup(env({ BACKUPS: flaky }), failing, later); // the plan reads D1 only
  for (let step = 1; step <= 3; step++) await runBackup(env({ BACKUPS: flaky }), failing, later);
  expect(failing.state).toMatchObject({ status: 'failed', error_code: 'storage_error', failed_jobs: 1, job: null });
  expect(failing.state.next_run).toBe(later + FAILED_RETRY_MS);
  expect((await backupStatus(env(), failing)).facts).toMatchObject({ status: 'failed', last_backup_at: null });
  failures = 0;
});

test('the newest six complete backups stay; older ones and incomplete leftovers go', async () => {
  const older = Array.from({ length: 6 }, (_, index) => `backups/2020-0${String(index + 1)}-05T100000Z/`);
  const incomplete = 'backups/2020-01-12T100000Z/';
  for (const prefix of older) {
    await bucket.put(`${prefix}${MANIFEST}`, '{}');
    await bucket.put(`${prefix}tasks/00001.ndjson.gz`, 'x');
  }
  await bucket.put(`${incomplete}tasks/00001.ndjson.gz`, 'x');
  const store = new Store();
  await finish(store, SUNDAY + 14 * DAY);
  // This job's, the two before it (25 October and 1 November) and the three newest seeded ones.
  expect(store.state.last_key).toBe('backups/2026-11-08T100000Z/');
  expect((await bucket.list({ prefix: 'backups/', delimiter: '/' })).delimitedPrefixes).toEqual([
    ...older.slice(3),
    'backups/2026-10-25T100000Z/',
    'backups/2026-11-01T100000Z/',
    'backups/2026-11-08T100000Z/',
  ]);
  expect((await bucket.list({ prefix: incomplete })).objects).toEqual([]);
});

test('Ops reports the age of the last backup, a stale one and a failed job', () => {
  const now = SUNDAY + DAY;
  expect(backupOps(null, now)).toEqual({ counters: {}, signals: [], lastBackupAt: null });
  expect(backupOps({ status: 'never', last_backup_at: null, since: null }, now).signals).toEqual([]);
  expect(backupOps({ status: 'ok', last_backup_at: SUNDAY, since: SUNDAY - 30 * DAY }, now)).toEqual({
    counters: { backup_age_seconds: 86_400 },
    signals: [],
    lastBackupAt: '2026-10-25T10:00:00.000Z',
  });
  const stale = backupOps({ status: 'failed', last_backup_at: now - BACKUP_STALE_MS - 1000, since: 0 }, now);
  expect(stale.signals).toEqual([
    { code: 'backup_stale', severity: Severity.CRITICAL, metrics: { age_seconds: 8 * 86_400 + 1, has_backup: 1 } },
    { code: 'backup_failed', severity: Severity.WARNING, metrics: {} },
  ]);
  // Before a first complete backup, from the first step on.
  expect(backupOps({ status: 'running', last_backup_at: null, since: now - DAY }, now).signals).toEqual([]);
  expect(backupOps({ status: 'failed', last_backup_at: null, since: now - 9 * DAY }, now).signals).toEqual([
    { code: 'backup_stale', severity: Severity.CRITICAL, metrics: { has_backup: 0 } },
    { code: 'backup_failed', severity: Severity.WARNING, metrics: {} },
  ]);
});

test("the jobs object runs the first backup from Home's status, and Ops reports it", async () => {
  const jobs = await harness.mf.getWorker('tasks-jobs');
  const before = (await (await jobs.fetch('https://jobs.internal/')).json()) as { backup: unknown };
  expect(before.backup).toEqual({ status: 'never', last_backup_at: null, since: null });
  const ops = await harness.mf.getWorker('tasks-ops');
  const started = Date.now();
  let status: { counters: Record<string, number>; signals: { code: string }[]; last_backup_at: string | null };
  for (;;) {
    status = (await (await ops.fetch('https://tasks-ops.internal/')).json()) as typeof status;
    if (status.last_backup_at) break;
    expect(Date.now() - started).toBeLessThan(30_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(status.counters.backup_age_seconds).toBeGreaterThanOrEqual(0);
  expect(status.signals.map((signal) => signal.code)).not.toContain('backup_failed');
  const latest = await json<{ key: string }>(LATEST);
  const manifest = await json<Manifest>(`${latest.key}${MANIFEST}`);
  expect(manifest.tasks.tables.find((table) => table.name === 'tasks')?.rows).toBe(TASK_ROWS);
  const after = (await (await jobs.fetch('https://jobs.internal/')).json()) as { backup: { status: string } };
  expect(after.backup.status).toBe('ok');
});
