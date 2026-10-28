/**
 * The daily backup's job (src/backup.ts) step by step against a real local R2 bucket (Miniflare's), with the store on
 * Node's SQLite (../fakes/sql.ts) and the object's key-value storage as a Map, so R2 can be made to fail: a failed step
 * repeats its parts without duplicates, three in a row fail the job, a job that runs too long fails, a store without
 * the owner's records is not backed up, and retention keeps the newest 30 complete backups. backup.test.ts runs the
 * same job from MailsortState's alarm. Synthetic rows only.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import { backupOps, LATEST, MANIFEST, nextRun, runBackup, type BackupManifest, type BackupState, type Kv } from '../../src/backup.ts';
import {
  BACKUP_CONTINUE_MS,
  BACKUP_EMPTY_RECHECK_MS,
  BACKUP_FAILED_RETRY_MS,
  BACKUP_KEEP,
  BACKUP_MAX_JOB_MS,
  BACKUP_PART_ROWS,
  BACKUP_STALE_MS,
  BACKUP_STEP_RETRY_MS,
  DAY,
  HOUR,
} from '../../src/limits.ts';
import { Store } from '../../src/store.ts';
import { memorySql } from '../fakes/sql.ts';
import { startHarness, T0, type Harness } from './harness.ts';

let h: Harness;
let bucket: R2Bucket;
beforeAll(async () => {
  h = await startHarness({ backups: true });
  bucket = (await h.mf.getR2Bucket('BACKUPS')) as unknown as R2Bucket;
});
afterAll(async () => {
  await h.dispose();
});

/** The object's key-value storage: values are copied in and out, as Durable Object storage does. */
class MemoryKv implements Kv {
  readonly values = new Map<string, unknown>();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- SyncKvStorage's own signature
  get<T>(key: string): T | undefined {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  put(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }
  delete(key: string): boolean {
    return this.values.delete(key);
  }
  get state(): BackupState {
    return this.values.get('backup') as BackupState;
  }
}

/** A migrated store with its four priority labels and more flow counters than one part holds. */
function store(rows = 2 * BACKUP_PART_ROWS + 10): Store {
  const value = new Store(memorySql());
  value.migrate();
  for (const [i, id] of ['p1', 'p2', 'p3', 'p4'].entries()) {
    value.run(`INSERT INTO labels (id, seq, display_name, gmail_state, create_time, update_time, etag) VALUES (?, ?, ?, 'pending', ?, ?, 'e')`, id, i + 1, id.toUpperCase(), T0, T0);
  }
  value.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO flow (day, stage, outcome, label, n) SELECT printf('2025-%05d', i), 'claude', 'applied', '', i FROM n`, rows);
  return value;
}

/** A bucket whose puts fail while `failures` is above zero, after `succeed` more puts went through. */
function flaky(): { bucket: R2Bucket; failures: number; succeed: number } {
  const control = { failures: 0, succeed: 0, bucket: undefined as unknown as R2Bucket };
  control.bucket = {
    put: (...args: Parameters<R2Bucket['put']>) => {
      if (control.succeed > 0) control.succeed -= 1;
      else if (control.failures > 0) {
        control.failures -= 1;
        return Promise.reject(new Error('Synthetic R2 failure'));
      }
      return bucket.put(...args);
    },
    get: bucket.get.bind(bucket),
    head: bucket.head.bind(bucket),
    list: bucket.list.bind(bucket),
    delete: bucket.delete.bind(bucket),
  } as unknown as R2Bucket;
  return control;
}

async function json<T>(key: string): Promise<T> {
  const object = await bucket.get(key);
  if (object === null) throw new Error(`missing ${key}`);
  return object.json<T>();
}

async function keys(prefix: string): Promise<string[]> {
  return (await bucket.list({ prefix, limit: 1000 })).objects.map((object) => object.key).sort();
}

it('a failed step repeats its parts without duplicates; three in a row fail the job, which is tried again later', async () => {
  const source = store();
  const kv = new MemoryKv();
  const control = flaky();
  const at = Date.parse('2026-10-10T11:41:00Z');
  const deps = { store: source, kv, bucket: control.bucket, object: 'mailsort-v1' };
  expect(await runBackup(deps, at)).toEqual({ running: true, due: at + BACKUP_CONTINUE_MS }); // the plan
  control.succeed = 1;
  control.failures = 2;
  // The first export step stores meta's part, then fails on the labels': meta's cursor moved, the labels' did not.
  expect(await runBackup(deps, at + 1000)).toEqual({ running: true, due: at + 1000 + BACKUP_STEP_RETRY_MS });
  expect(kv.state.job?.errors).toBe(1);
  const cursors = new Map(kv.state.job?.cursors.map((cursor) => [cursor.name, cursor]));
  expect(cursors.get('meta')).toMatchObject({ done: true, parts: [{ key: 'backups/2026-10-10T114100Z/meta/00001.ndjson.gz' }] });
  expect(cursors.get('labels')).toMatchObject({ done: false, after: null, parts: [] });
  expect(await runBackup(deps, at + 2000)).toMatchObject({ running: true }); // not due yet: nothing runs
  expect(await runBackup(deps, at + 1000 + BACKUP_STEP_RETRY_MS)).toMatchObject({ running: true });
  expect(kv.state.job?.errors).toBe(2);
  let now = at + 1000 + 2 * BACKUP_STEP_RETRY_MS;
  while (kv.state.job !== null) {
    await runBackup(deps, now);
    now += BACKUP_CONTINUE_MS;
  }
  expect(kv.state).toMatchObject({ status: 'ok', failed_jobs: 0, last_key: 'backups/2026-10-10T114100Z/' });
  const manifest = await json<BackupManifest>(`backups/2026-10-10T114100Z/${MANIFEST}`);
  const flow = manifest.tables.find((table) => table.name === 'flow');
  expect(flow?.rows).toBe(2 * BACKUP_PART_ROWS + 10);
  // Every object under the prefix is one of the manifest's parts (or the manifest): a repeat overwrote its keys.
  const parts = manifest.tables.flatMap((table) => table.parts.map((part) => part.key));
  expect(new Set(parts).size).toBe(parts.length);
  expect(await keys('backups/2026-10-10T114100Z/')).toEqual([...parts, `backups/2026-10-10T114100Z/${MANIFEST}`].sort());
  expect(await json(LATEST)).toEqual({ key: 'backups/2026-10-10T114100Z/' });

  // R2 refuses every write: three failed steps fail the job, retried 6 hours later, three times, then the next day.
  const failing = new MemoryKv();
  const later = at + DAY;
  control.failures = Infinity;
  const failingDeps = { ...deps, kv: failing };
  let next = later;
  for (let job = 1; job <= 3; job++) {
    const start = next;
    await runBackup(failingDeps, start); // the plan reads SQLite only
    for (let step = 0; step < 3; step++) await runBackup(failingDeps, start + 1000 + step * BACKUP_STEP_RETRY_MS);
    expect(failing.state).toMatchObject({ status: 'failed', error_code: 'storage_error', failed_jobs: job, job: null, last_backup_at: null });
    next = failing.state.next_run;
    expect(next).toBe(job < 3 ? start + 1000 + 2 * BACKUP_STEP_RETRY_MS + BACKUP_FAILED_RETRY_MS : nextRun(start + 1000 + 2 * BACKUP_STEP_RETRY_MS));
  }
  control.failures = 0;
});

it('a job that runs too long fails; a store without the owner records is not backed up', async () => {
  const kv = new MemoryKv();
  const at = Date.parse('2026-10-12T11:41:00Z');
  const deps = { store: store(10), kv, bucket, object: 'mailsort-v1' };
  await runBackup(deps, at);
  await runBackup(deps, at + BACKUP_MAX_JOB_MS + 1);
  expect(kv.state).toMatchObject({ status: 'failed', error_code: 'job_timeout', job: null, failed_jobs: 1 });

  const empty = new Store(memorySql());
  empty.migrate();
  empty.run(`INSERT INTO pending (message_id, added_at) VALUES ('abc0000000000001', ?)`, at);
  const quiet = new MemoryKv();
  expect(await runBackup({ ...deps, store: empty, kv: quiet }, at)).toEqual({ running: false, due: at + BACKUP_EMPTY_RECHECK_MS });
  expect(quiet.state).toMatchObject({ since: null, status: 'never', job: null });
  expect(await keys('backups/2026-10-12T114100Z/')).toEqual([]);
});

it('retention keeps the newest 30 complete backups and drops older incomplete ones; it never touches a kept one', async () => {
  // 31 complete backups before, and two incomplete prefixes: one between them, one after the newest complete.
  const days = Array.from({ length: BACKUP_KEEP + 1 }, (_, i) => new Date(Date.parse('2026-08-01T11:41:00Z') + i * DAY).toISOString().slice(0, 10));
  const complete = days.map((day) => `backups/${day}T114100Z/`);
  for (const prefix of complete) {
    await bucket.put(`${prefix}${MANIFEST}`, '{}');
    await bucket.put(`${prefix}meta/00001.ndjson.gz`, 'x');
  }
  const incomplete = ['backups/2026-08-05T120000Z/', 'backups/2026-09-01T120000Z/'];
  for (const prefix of incomplete) await bucket.put(`${prefix}meta/00001.ndjson.gz`, 'x');
  const kv = new MemoryKv();
  let now = Date.parse('2026-11-20T11:41:00Z');
  const deps = { store: store(10), kv, bucket, object: 'mailsort-v1' };
  do {
    await runBackup(deps, now);
    now += BACKUP_CONTINUE_MS;
  } while (kv.state.job !== null);
  const prefixes = (await bucket.list({ prefix: 'backups/', delimiter: '/' })).delimitedPrefixes;
  // This job's, and the 29 newest complete before it; the earlier tests' complete backups are among the newest.
  const kept = prefixes.filter((prefix) => prefix <= 'backups/2026-11-20T114100Z/');
  expect(kept).toHaveLength(BACKUP_KEEP);
  expect(kept.at(-1)).toBe('backups/2026-11-20T114100Z/');
  for (const prefix of kept) expect(await bucket.head(`${prefix}${MANIFEST}`), prefix).not.toBeNull();
  for (const prefix of incomplete) expect(await keys(prefix), prefix).toEqual([]);
  expect(kept).not.toContain(complete[0]);
  expect(kept).toContain(complete.at(-1));
  // A kept backup keeps every object.
  expect(await keys(complete.at(-1) ?? '')).toEqual([`${complete.at(-1) ?? ''}${MANIFEST}`, `${complete.at(-1) ?? ''}meta/00001.ndjson.gz`]);
});

it('the next daily start, and Ops: the age of the last backup, a stale one and a failed job', () => {
  expect(new Date(nextRun(Date.parse('2026-10-28T09:00:00Z'))).toISOString()).toBe('2026-10-28T11:41:00.000Z');
  expect(new Date(nextRun(Date.parse('2026-10-28T11:41:00Z'))).toISOString()).toBe('2026-10-29T11:41:00.000Z');
  expect(new Date(nextRun(Date.parse('2026-10-28T09:00:00Z'), true)).toISOString()).toBe('2026-10-29T11:41:00.000Z');
  const now = T0 + 10 * DAY;
  expect(backupOps(null, now)).toEqual({ counters: {}, signals: [], lastBackupAt: null });
  expect(backupOps({ status: 'never', last_backup_at: null, since: null }, now).signals).toEqual([]);
  expect(backupOps({ status: 'ok', last_backup_at: now - DAY, since: T0 }, now)).toEqual({ counters: { backup_age_seconds: 86_400 }, signals: [], lastBackupAt: now - DAY });
  expect(backupOps({ status: 'failed', last_backup_at: now - BACKUP_STALE_MS - 1000, since: T0 }, now).signals).toEqual([
    { code: 'backup_stale', severity: Severity.CRITICAL, metrics: { age_seconds: 3 * 86_400 + 1, has_backup: 1 } },
    { code: 'backup_failed', severity: Severity.WARNING, metrics: {} },
  ]);
  // Before a first complete backup, from the first job on.
  expect(backupOps({ status: 'running', last_backup_at: null, since: now - HOUR }, now).signals).toEqual([]);
  expect(backupOps({ status: 'failed', last_backup_at: null, since: now - 4 * DAY }, now).signals).toEqual([
    { code: 'backup_stale', severity: Severity.CRITICAL, metrics: { has_backup: 0 } },
    { code: 'backup_failed', severity: Severity.WARNING, metrics: {} },
  ]);
});
