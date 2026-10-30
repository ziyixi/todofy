/**
 * The daily backup (src/backup.ts, src/backup-runner.ts) on real D1 and R2 at fixed clocks, then the LinksBackup
 * object's Alarm (src/backup-alarm.ts) running the first one at the real clock as soon as Home's status finds no state,
 * Ops reporting it, and tools/backup-restore.ts restoring it with wrangler into a new, empty local D1 that holds, row
 * for row, what the store held (docs/backup.md "Rehearse locally"). Synthetic rows only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_TABLES, PAGE_ROWS, PLAN_STATEMENTS, MARK_STATEMENTS } from '../../src/backup.ts';
import {
  BACKUP_FORMAT,
  BACKUP_STALE_MS,
  backupFacts,
  backupOps,
  FAILED_RETRY_MS,
  KEEP,
  LATEST,
  MANIFEST,
  MAX_ERRORS,
  nextRun,
  QUERY_BUDGET,
  runBackup,
  STATE,
  STEP_BYTES,
  STEP_MS,
  type BackupPart,
  type BackupState,
} from '../../src/backup-runner.ts';
import type { Env } from '../../src/env.ts';
import { RESTORE_ORDER } from '../../../tools/backup-restore.ts';
import { measuredReads, startHarness, type Harness } from './harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '../../../tools/backup-restore.ts');
const WRANGLER = process.env.BAZEL_WRANGLER
  ? resolve(process.env.TEST_SRCDIR ?? '', process.env.TEST_WORKSPACE ?? '', process.env.BAZEL_WRANGLER)
  : join(HERE, '../../node_modules/.bin/wrangler');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The daily slot, 05:25 UTC. */
const SLOT = Date.parse('2026-10-28T05:25:00Z');
/** More rows than one step holds: the revisions alone are several steps of STEP_BYTES. */
const LINKS = 600;
const REVISIONS_PER_LINK = 4;
const REQUESTS = 30;

let h: Harness;
let bucket: R2Bucket;
beforeAll(async () => {
  h = await startHarness({ backups: true });
  bucket = (await h.mf.getR2Bucket('BACKUPS', 'links')) as unknown as R2Bucket;
  const keys = Array.from({ length: LINKS }, (_, n) => n);
  // Quotes, backslashes, newlines, CJK and emoji in every text column a person writes; some links deleted or expiring.
  await h.sql(
    `INSERT INTO links (key, target, path_mode, visibility, description, tags, expire_time, create_time, update_time,
       delete_time, purge_time, revision, revision_time, etag)
     SELECT printf('k%04d', value), 'https://example.com/p/' || value || '?q="x"&r=\\',
       CASE value % 3 WHEN 0 THEN 'exact' WHEN 1 THEN 'append' ELSE 'template' END,
       CASE value % 2 WHEN 0 THEN 'private' ELSE 'public' END,
       'Synthetic link ' || value || ' it''s “quoted” 汉字 🙂' || char(10) || 'second line',
       '["tag-' || (value % 7) || '","t"]', CASE WHEN value % 11 = 0 THEN 1800000000000 END, 1000 + value,
       2000 + value, CASE WHEN value % 13 = 0 THEN 3000 END, CASE WHEN value % 13 = 0 THEN 4000000000000 END,
       ${String(REVISIONS_PER_LINK)}, 2000 + value, printf('%016x', value)
     FROM json_each(?)`,
    JSON.stringify(keys),
  );
  await h.sql(
    `INSERT INTO link_revisions (key, revision, create_time, target, path_mode, visibility, description, tags, expire_time)
     SELECT l.key, r.value, 1000 + r.value, l.target || '/r' || r.value, l.path_mode, l.visibility,
       substr(l.description || ' ' || hex(randomblob(60)), 1, 200), l.tags, l.expire_time
     FROM links l, json_each('[1,2,3,4]') r`,
  );
  await h.sql(
    `INSERT INTO request_log (request_id, method, name, response, create_time)
     SELECT printf('%08x-0000-4000-8000-%012x', value, value), 'CreateLink', printf('links/k%04d', value),
       '{"name":"links/k' || value || '","note":"a \\"quoted\\" reply"}', 5000 + value FROM json_each(?)`,
    JSON.stringify(Array.from({ length: REQUESTS }, (_, n) => n)),
  );
  // A NUL inside a text value travels too.
  await h.sql("UPDATE link_revisions SET description = 'nul' || char(0) || 'inside' WHERE key = 'k0001' AND revision = 2");
});
afterAll(async () => {
  await h.dispose();
});
beforeEach(async () => {
  await clearBucket();
});

async function clearBucket(): Promise<void> {
  for (;;) {
    const listed = await bucket.list({ limit: 1000 });
    if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
    if (!listed.truncated) return;
  }
}

function env(overrides: Partial<Env> = {}): Env {
  return { DB: h.db, BACKUPS: bucket, ...overrides } as unknown as Env;
}
async function json<T>(key: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`Missing ${key}`);
  return object.json<T>();
}
const state = () => json<BackupState>(STATE);
/** The LinksBackup object's runs so far (its one log line each). */
function runsSoFar(): number {
  return h.logs.filter((line) => line.startsWith('{"backup":{"step"')).length;
}
/** The step a run at `now` took. */
async function step(environment: Env, now: number): Promise<string> {
  return (await runBackup(environment, now)).step;
}
/** Steps the job at `now` until it ends: the number of steps. */
async function finish(now: number, environment = env()): Promise<number> {
  for (let steps = 1; steps < 200; steps++) {
    await step(environment, now);
    if (!(await state()).job) return steps;
  }
  throw new Error('The job did not end');
}

interface Manifest {
  format: string;
  started_at: string;
  created_at: string;
  links: {
    schema_version: string;
    change_mark: { start: unknown; end: unknown };
    tables: { name: string; columns: string[]; key: string[]; rows: number; bytes: number; parts: BackupPart[] }[];
  };
}
/** A table's rows as its parts hold them, each part checked against its SHA-256 and its stored metadata. */
async function partRows(parts: BackupPart[]): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  for (const part of parts) {
    const object = await bucket.get(part.key);
    if (!object) throw new Error(`Missing ${part.key}`);
    const data = new Uint8Array(await object.arrayBuffer());
    expect(createHash('sha256').update(data).digest('hex'), part.key).toBe(part.sha256);
    expect(object.customMetadata?.sha256).toBe(part.sha256);
    expect(data.byteLength).toBe(part.bytes);
    const lines = new TextDecoder().decode(gunzipSync(data)).split('\n').filter(Boolean);
    expect(lines, part.key).toHaveLength(part.rows);
    rows.push(...lines.map((line) => JSON.parse(line) as unknown[]));
  }
  return rows;
}
/** Every row of a table in key order, as arrays in the columns' order: what a part must hold. */
async function tableRows(name: string, columns: readonly string[], key: readonly string[]): Promise<unknown[][]> {
  return h.db.prepare(`SELECT ${columns.join(',')} FROM ${name} ORDER BY ${key.join(',')}`).raw();
}

describe('what the backup reads', () => {
  it('names every table and column of the migrated schema, with its primary key', async () => {
    const tables = await h.sql<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name",
    );
    expect(tables.map((table) => table.name)).toEqual(BACKUP_TABLES.map((table) => table.name).sort());
    for (const table of BACKUP_TABLES) {
      const info = await h.sql<{ name: string; pk: number }>(`PRAGMA table_info(${table.name})`);
      expect(info.map((column) => column.name), table.name).toEqual(table.columns);
      const key = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
      expect(key.map((column) => column.name), table.name).toEqual(table.key);
    }
    // The restore tool loads the same tables in the same order.
    expect(RESTORE_ORDER).toEqual(BACKUP_TABLES.map((table) => table.name));
  });
});

describe('a daily job', () => {
  it('plans, writes parts within its budgets, checks them, then writes its manifest and latest.json', async () => {
    expect(await backupFacts(env())).toEqual({ status: 'never', last_backup_at: null, since: null });
    // The first step only plans, in one batch; nothing is stored yet but the state.
    const planning = measuredReads(h.db);
    // Its next step is due STEP_MS later.
    expect(await runBackup(env({ DB: planning.db }), SLOT)).toEqual({ step: 'plan', next: SLOT + STEP_MS });
    expect(planning.metrics.statements).toBe(PLAN_STATEMENTS);
    expect((await state()).job?.prefix).toBe('backups/2026-10-28T052500Z/');
    expect((await bucket.list({ prefix: 'backups/' })).objects).toEqual([]);
    expect(await backupFacts(env())).toEqual({ status: 'running', last_backup_at: null, since: SLOT });

    // Every export step stays within its statements, its bytes and the rows a page reads: about three times its LIMIT
    // (D1 counts the table's rows, the window's and the subquery's).
    let steps = 0;
    for (;;) {
      const before = await state();
      if (!before.job?.cursors.some((cursor) => !cursor.done)) break;
      const step = measuredReads(h.db);
      expect(await runBackup(env({ DB: step.db }), SLOT)).toEqual({ step: 'export', next: SLOT + STEP_MS });
      expect(step.metrics.statements).toBeLessThanOrEqual(QUERY_BUDGET);
      expect(step.metrics.rowsRead).toBeLessThanOrEqual(step.metrics.statements * (3 * PAGE_ROWS + 5));
      const after = await state();
      const stored = (after.job?.cursors ?? []).flatMap((cursor) => cursor.parts).slice(
        before.job.cursors.flatMap((cursor) => cursor.parts).length,
      );
      const read = await Promise.all(stored.map(async (part) => (await partRows([part])).reduce((sum, row) => sum + JSON.stringify(row).length, 0)));
      // The JSON's characters are at most its bytes: a step stays under its bytes, plus at most one row.
      expect(read.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(STEP_BYTES + 4096);
      steps += 1;
      expect(steps).toBeLessThan(40);
    }
    expect(steps).toBeGreaterThan(2);

    // The last step reads the change mark again, checks the parts, writes the manifest and latest.json.
    const closing = measuredReads(h.db);
    // Then nothing before tomorrow's slot.
    expect(await runBackup(env({ DB: closing.db }), SLOT + 60_000)).toEqual({ step: 'finish', next: SLOT + DAY });
    expect(closing.metrics.statements).toBe(MARK_STATEMENTS);
    expect(await state()).toMatchObject({ status: 'ok', last_backup_at: SLOT + 60_000, failed_jobs: 0, job: null });
    expect((await state()).next_run).toBe(SLOT + DAY);
    expect(nextRun(SLOT + 60_000, true)).toBe(SLOT + DAY);
    expect(nextRun(SLOT - 60_000)).toBe(SLOT);

    expect(await json(LATEST)).toEqual({ key: 'backups/2026-10-28T052500Z/' });
    const manifest = await json<Manifest>(`backups/2026-10-28T052500Z/${MANIFEST}`);
    expect(manifest).toMatchObject({ format: BACKUP_FORMAT, started_at: '2026-10-28T05:25:00Z', created_at: '2026-10-28T05:26:00Z' });
    expect(manifest.links.schema_version).toBe('0001_init.sql');
    expect(manifest.links.change_mark.start).toEqual(manifest.links.change_mark.end);
    expect(manifest.links.change_mark.start).toEqual({
      update_time: 2000 + LINKS - 1,
      rows: { links: LINKS, link_revisions: LINKS * REVISIONS_PER_LINK, request_log: REQUESTS },
    });
    expect(manifest.links.tables.map((table) => table.name)).toEqual(BACKUP_TABLES.map((table) => table.name));
    for (const table of manifest.links.tables) {
      // Row for row and value for value what D1 holds, in key order, each row once.
      expect(await partRows(table.parts), table.name).toEqual(await tableRows(table.name, table.columns, table.key));
      expect(table.rows).toBe((await tableRows(table.name, table.columns, table.key)).length);
    }
    expect(manifest.links.tables.find((table) => table.name === 'link_revisions')?.parts.length).toBeGreaterThan(1);

    // Not due again before tomorrow's slot: a run only reads the state and sleeps until then; without the bucket there
    // is nothing to schedule.
    expect(await runBackup(env(), SLOT + HOUR)).toEqual({ step: 'idle', next: SLOT + DAY });
    expect(await runBackup({ DB: h.db } as unknown as Env, SLOT + DAY)).toEqual({ step: 'unbound', next: null });
  });

  it('repeats a failed step without duplicates, and fails the job after three in a row, retried later', async () => {
    let failures = 0;
    // Part writes fail; the state still saves, as when R2 refuses a large write or D1 fails a page.
    const flaky = {
      put: (...args: Parameters<R2Bucket['put']>) => {
        if (failures > 0 && args[0] !== STATE) {
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
    await step(env({ BACKUPS: flaky }), SLOT); // the plan
    failures = 1;
    // The failed step runs again STEP_MS later.
    expect(await runBackup(env({ BACKUPS: flaky }), SLOT)).toEqual({ step: 'export', next: SLOT + STEP_MS });
    expect((await state()).job?.errors).toBe(1);
    expect((await state()).job?.cursors.every((cursor) => cursor.parts.length === 0 && cursor.after === null)).toBe(true);
    await finish(SLOT, env({ BACKUPS: flaky }));
    const done = await state();
    const manifest = await json<Manifest>(`${done.last_key}${MANIFEST}`);
    for (const table of manifest.links.tables)
      expect(await partRows(table.parts), table.name).toEqual(await tableRows(table.name, table.columns, table.key));

    // D1 failing every page: three failed steps in a row fail the job; it starts again an hour later.
    await clearBucket();
    const later = SLOT + 2 * DAY;
    await step(env(), later); // the plan
    const broken = { prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error('Synthetic D1 failure')) }) }) };
    let last = await runBackup(env({ DB: broken as unknown as D1Database }), later);
    for (let failed = 2; failed <= MAX_ERRORS; failed++) last = await runBackup(env({ DB: broken as unknown as D1Database }), later);
    expect(last).toEqual({ step: 'export', next: later + FAILED_RETRY_MS });
    expect(await state()).toMatchObject({ status: 'failed', error_code: 'storage_error', failed_jobs: 1, job: null });
    expect((await state()).next_run).toBe(later + FAILED_RETRY_MS);
    expect(await backupFacts(env())).toMatchObject({ status: 'failed', last_backup_at: null });
    expect(await step(env(), later + FAILED_RETRY_MS - 1)).toBe('idle');
    expect(await finish(later + FAILED_RETRY_MS)).toBeGreaterThan(2);
    expect(await state()).toMatchObject({ status: 'ok', failed_jobs: 0 });
  });

  it('never writes a manifest over a part that differs from its record', async () => {
    await step(env(), SLOT);
    while ((await state()).job?.cursors.some((cursor) => !cursor.done)) await step(env(), SLOT);
    const part = (await state()).job?.cursors[0]?.parts[0];
    if (!part) throw new Error('No part');
    // Another step (an overlapping tick) rewrote the part with other rows.
    await bucket.put(part.key, 'other', { customMetadata: { sha256: '0'.repeat(64) } });
    for (let failed = 1; failed <= MAX_ERRORS; failed++) expect(await step(env(), SLOT)).toBe('finish');
    expect(await state()).toMatchObject({ status: 'failed', error_code: 'part_mismatch', job: null });
    expect(await bucket.head(`backups/2026-10-28T052500Z/${MANIFEST}`)).toBeNull();
    expect(await bucket.head(LATEST)).toBeNull();
  });

  it('never rewrites a manifest it stored when the last step runs again', async () => {
    let failLatest = true;
    // latest.json fails once after the manifest is stored, as when R2 drops a write.
    const flaky = {
      put: (...args: Parameters<R2Bucket['put']>) => {
        if (failLatest && args[0] === LATEST) {
          failLatest = false;
          return Promise.reject(new Error('Synthetic R2 failure'));
        }
        return bucket.put(...args);
      },
      get: bucket.get.bind(bucket),
      head: bucket.head.bind(bucket),
      list: bucket.list.bind(bucket),
      delete: bucket.delete.bind(bucket),
    } as unknown as R2Bucket;
    await step(env({ BACKUPS: flaky }), SLOT);
    while ((await state()).job?.cursors.some((cursor) => !cursor.done)) await step(env({ BACKUPS: flaky }), SLOT);
    expect(await step(env({ BACKUPS: flaky }), SLOT + 60_000)).toBe('finish');
    const key = `backups/2026-10-28T052500Z/${MANIFEST}`;
    const first = await bucket.head(key);
    expect(first).not.toBeNull();
    expect((await state()).job?.errors).toBe(1);
    expect(await step(env({ BACKUPS: flaky }), SLOT + 120_000)).toBe('finish');
    expect((await bucket.head(key))?.etag).toBe(first?.etag);
    expect((await json<Manifest>(key)).created_at).toBe('2026-10-28T05:26:00Z');
    expect(await json(LATEST)).toEqual({ key: 'backups/2026-10-28T052500Z/' });
    expect(await state()).toMatchObject({ status: 'ok', job: null });
  });

  it(`keeps the newest ${String(KEEP)} complete backups; older ones and incomplete leftovers go, newer ones stay`, async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * DAY).toISOString().slice(0, 10);
    const older = Array.from({ length: KEEP + 1 }, (_, n) => `backups/${day(n)}T052500Z/`);
    for (const prefix of older) {
      await bucket.put(`${prefix}${MANIFEST}`, '{}');
      await bucket.put(`${prefix}links/00001.ndjson.gz`, 'x');
    }
    // The oldest holds more parts than one listing page: retention deletes it page by page.
    for (let part = 2; part <= 1001; part++)
      await bucket.put(`${older[0] ?? ''}link_revisions/${String(part).padStart(5, '0')}.ndjson.gz`, 'x');
    const incomplete = 'backups/2026-09-15T120000Z/';
    await bucket.put(`${incomplete}links/00001.ndjson.gz`, 'x');
    const newer = 'backups/2099-01-01T000000Z/';
    await bucket.put(`${newer}links/00001.ndjson.gz`, 'x');
    await finish(SLOT);
    const prefixes = (await bucket.list({ prefix: 'backups/', delimiter: '/' })).delimitedPrefixes;
    // This job's and the newest KEEP - 1 seeded ones; the incomplete older one is gone; the newer one is untouched.
    expect(prefixes).toEqual([...older.slice(-(KEEP - 1)), 'backups/2026-10-28T052500Z/', newer]);
    expect((await bucket.list({ prefix: older[0] ?? '' })).objects).toEqual([]);
    for (const prefix of older.slice(-(KEEP - 1)))
      expect((await bucket.list({ prefix })).objects.map((object) => object.key)).toEqual([
        `${prefix}links/00001.ndjson.gz`,
        `${prefix}${MANIFEST}`,
      ]);
  });
});

describe('Ops', () => {
  it('reports the age of the last backup, a stale one and a failed job', () => {
    const now = SLOT + DAY;
    expect(backupOps(null, now)).toEqual({ counters: {}, signals: [], lastBackupAt: null });
    expect(backupOps({ status: 'never', last_backup_at: null, since: null }, now).signals).toEqual([]);
    expect(backupOps({ status: 'ok', last_backup_at: SLOT, since: SLOT - 30 * DAY }, now)).toEqual({
      counters: { backup_age_seconds: 86_400 },
      signals: [],
      lastBackupAt: '2026-10-28T05:25:00.000Z',
    });
    const stale = backupOps({ status: 'failed', last_backup_at: now - BACKUP_STALE_MS - 1000, since: 0 }, now);
    expect(stale.signals).toEqual([
      { code: 'backup_stale', severity: Severity.CRITICAL, metrics: { age_seconds: 3 * 86_400 + 1, has_backup: 1 } },
      { code: 'backup_failed', severity: Severity.WARNING, metrics: {} },
    ]);
    // Before a first complete backup, from the first step on.
    expect(backupOps({ status: 'running', last_backup_at: null, since: now - DAY }, now).signals).toEqual([]);
    expect(backupOps({ status: 'failed', last_backup_at: null, since: now - 4 * DAY }, now).signals).toEqual([
      { code: 'backup_stale', severity: Severity.CRITICAL, metrics: { has_backup: 0 } },
      { code: 'backup_failed', severity: Severity.WARNING, metrics: {} },
    ]);
  });

  it('reports a bucket that does not answer as a failed backup', async () => {
    const silent = { get: () => Promise.reject(new Error('Synthetic R2 failure')) } as unknown as R2Bucket;
    const facts = await backupFacts(env({ BACKUPS: silent }));
    expect(facts).toEqual({ status: 'failed', last_backup_at: null, since: null });
    expect(backupOps(facts, SLOT).signals).toEqual([{ code: 'backup_failed', severity: Severity.WARNING, metrics: {} }]);
    // A run does not mistake it for a lost state: it starts no job and writes nothing (the Alarm tries again STEP_MS later).
    await expect(runBackup(env({ BACKUPS: silent }), SLOT)).rejects.toThrow('Synthetic R2 failure');
  });
});

/** Home's view through the entrypoint (the Worker "links-ops"); each call also arms the backup's Alarm. */
async function opsStatus() {
  const ops = await h.mf.getWorker('links-ops');
  return (await (await ops.fetch('https://links-ops.internal/')).json()) as {
    app: string;
    health: string;
    counters: Record<string, number>;
    signals: { code: string; severity: string }[];
    last_backup_at: string | null;
    ui_url?: string;
  };
}

// At the real clock, after the fixed-clock tests: nothing armed the object before.
describe('the Alarm, Home and a restore', () => {
  it('starts the first backup as soon as Home finds no state, a step every STEP_MS, and restores row for row', async () => {
    // No state yet: Home's status arms the Alarm at once, and its run starts the job.
    expect(await opsStatus()).toMatchObject({ app: 'links', health: 'ok', counters: { database_ready: 1 }, signals: [], last_backup_at: null, ui_url: 'https://s.example.com/_/' });
    let before = Date.now();
    let run = await h.alarmRun(1);
    expect(run.step).toBe('plan');
    // The next step STEP_MS later; arming again (Home's next status) keeps it.
    expect(run.next).toBeGreaterThanOrEqual(before - 60_000 + STEP_MS);
    expect(run.next).toBeLessThanOrEqual(Date.now() + STEP_MS);
    expect(await h.arm()).toBe(run.next);
    expect((await opsStatus()).last_backup_at).toBeNull();
    expect(await h.arm()).toBe(run.next);
    // Each later step, brought forward instead of waiting STEP_MS, until the last one.
    for (let runs = 2; run.step !== 'finish'; runs++) {
      expect(runs).toBeLessThan(60);
      before = Date.now();
      await h.arm(true);
      run = await h.alarmRun(runs);
      if (run.step === 'export') expect(run.next).toBeGreaterThanOrEqual(before + STEP_MS);
    }
    // Done: the Alarm sleeps until tomorrow's slot, 05:25 UTC.
    const done = await state();
    expect(done).toMatchObject({ status: 'ok', job: null });
    expect(run.next).toBe(done.next_run);
    expect(new Date(done.next_run).toISOString()).toMatch(/T05:25:00\.000Z$/);
    expect(done.next_run - Date.now()).toBeGreaterThan(0);
    expect(await h.arm()).toBe(done.next_run);
    // A run before then only reads the state and sleeps until it again.
    const runs = runsSoFar();
    await h.arm(true);
    expect(await h.alarmRun(runs + 1)).toEqual({ step: 'idle', next: done.next_run });
    const latest = await json<{ key: string }>(LATEST);
    expect(latest.key).toBe(done.last_key);
    expect(await opsStatus()).toMatchObject({ health: 'ok', signals: [], counters: { database_ready: 1 } });
    expect(h.logs.join('\n')).not.toMatch(/k0\d{3}|example\.com|Synthetic/);

    const work = await mkdtemp(join(tmpdir(), 'links-restore-'));
    try {
      const tool = (...args: string[]) => spawnSync(process.execPath, [TOOL, ...args, ...(WRANGLER && process.env.BAZEL_WRANGLER && ['download', 'upload', 'verify'].includes(args[0] ?? '') ? ['--wrangler', WRANGLER] : [])], { encoding: 'utf8' });
      const wrangler = (...args: string[]) =>
        execFileSync(WRANGLER, args, { encoding: 'utf8', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 256 << 20 });
      const restore = join(work, 'restore');
      const downloaded = tool('download', '--out', restore, '--local', '--persist-to', h.persistTo);
      expect(downloaded.status, downloaded.stderr).toBe(0);
      expect(downloaded.stdout).toContain(`backup ${latest.key}\n`);
      expect(downloaded.stdout).toMatch(new RegExp(`\\nPASS link_revisions rows=${String(LINKS * REVISIONS_PER_LINK)} parts=\\d+\\n`));
      const config = join(work, 'restore.toml');
      const configured = tool('config', '--database-name', 'links-restore', '--database-id', randomUUID(), '--out', config);
      expect(configured.status, configured.stderr).toBe(0);
      const target = ['--local', '--persist-to', join(work, 'd1'), '--config', config];
      wrangler('d1', 'migrations', 'apply', 'DB', ...target);
      const sql = join(work, 'restore.sql');
      const written = tool('sql', '--in', restore, '--out', sql);
      expect(written.status, written.stderr).toBe(0);
      expect(written.stdout).not.toMatch(/WARN|Synthetic|example\.com/);
      wrangler('d1', 'execute', 'DB', ...target, '--file', sql);
      const verified = tool('verify', '--in', restore, ...target);
      expect(verified.status, verified.stdout + verified.stderr).toBe(0);
      expect(verified.stdout).toContain(`PASS link_revisions rows=${String(LINKS * REVISIONS_PER_LINK)}/${String(LINKS * REVISIONS_PER_LINK)}\n`);
      expect(verified.stdout.trim().split('\n').at(-1)).toBe('verify PASS');

      // Independently of the tool: every table of the restored database equals the store, row for row.
      for (const table of BACKUP_TABLES) {
        const query = `SELECT * FROM ${table.name} ORDER BY ${table.key.join(',')}`;
        const restored = (JSON.parse(wrangler('d1', 'execute', 'DB', ...target, '--json', '--command', query)) as { results: unknown[] }[])[0]?.results;
        expect(restored, table.name).toEqual(await h.sql(query));
      }

      // A restored row that differs fails the check.
      wrangler('d1', 'execute', 'DB', ...target, '--command', "UPDATE links SET description = 'changed' WHERE key = 'k0007'");
      const failed = tool('verify', '--in', restore, ...target);
      expect(failed.status).toBe(1);
      expect(failed.stdout).toMatch(/FAIL links rows=600\/600 differing=1\n/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('answers Home with the backup facts and no guard, and leaves an armed Alarm as it is', async () => {
    // After the backup above: the Alarm waits for tomorrow's slot, which no status moves.
    const armed = await h.arm();
    const runs = runsSoFar();
    const now = Date.now();
    const written: BackupState = {
      since: now - 10 * DAY,
      next_run: now + HOUR,
      failed_jobs: 1,
      status: 'failed',
      last_backup_at: now - 4 * DAY,
      last_key: 'backups/2026-10-24T052500Z/',
      error_code: 'storage_error',
      job: null,
    };
    await bucket.put(STATE, JSON.stringify(written));
    const failed = await opsStatus();
    expect(failed.health).toBe('degraded');
    expect(failed.signals).toEqual([
      { code: 'backup_stale', severity: 'critical', metrics: { age_seconds: expect.any(Number) as number, has_backup: 1 } },
      { code: 'backup_failed', severity: 'warning', metrics: {} },
    ]);
    expect(failed.counters.backup_age_seconds).toBeGreaterThanOrEqual(4 * 86_400);
    expect(Date.parse(failed.last_backup_at ?? '')).toBe(written.last_backup_at);
    await bucket.put(STATE, JSON.stringify({ ...written, status: 'ok', failed_jobs: 0, last_backup_at: now - HOUR }));
    expect(await opsStatus()).toMatchObject({ health: 'ok', signals: [] });
    expect(await h.arm()).toBe(armed);
    expect(runsSoFar()).toBe(runs);
    const guard = await (await h.mf.getWorker('links-ops')).fetch('https://links-ops.internal/guard');
    expect(guard.status).toBe(400);
    expect(await guard.json()).toEqual({ error: 'invalid_input' });
  });
});
