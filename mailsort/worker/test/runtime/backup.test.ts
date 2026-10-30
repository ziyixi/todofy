/**
 * The daily backup (src/backup.ts) and its restore (src/restore.ts) in workerd with real SQLite Durable Objects and R2:
 * a populated MailsortState backs itself up from its alarm; a second, empty Miniflare restores that backup through the
 * owner API, and every table matches the first, row for row and value for value (its SQLite type included), with the
 * schema; the pipeline then resumes from the mailbox's current state without a Gmail write. Also: the refusals, a part
 * whose SHA-256 is wrong, the daily share of SQLite writes, the Ops view, and tools/backup-restore.ts downloading and
 * verifying the same backup with wrangler. All data is synthetic.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { BackupRestore_State as State } from '@ziyixi/proto/mailsort/ui/v2/backup_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { BACKUP_FORMAT, LATEST, MANIFEST, type BackupManifest } from '../../src/backup.ts';
import { BACKUP_PART_BYTES, BACKUP_STEP_BYTES, BACKUP_STEP_PARTS, DAY as DAY_MS, RESTORE_ROWS_PER_DAY } from '../../src/limits.ts';
import { MAILSORT_OBJECT } from '../../src/env.ts';
import { SCHEMA_VERSION } from '../../src/store.ts';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness, type StepResult } from './harness.ts';
import { checkGoogleCalls, deliver, modifies, setMode } from './helpers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECOND = 1000;
const TOOL = join(HERE, '../../../tools/backup-restore.ts');
const WRANGLER = process.env.BAZEL_WRANGLER
  ? resolve(process.env.TEST_SRCDIR ?? '', process.env.TEST_WORKSPACE ?? '', process.env.BAZEL_WRANGLER)
  : undefined;
/** The first backup's clock: the object has no backup state, so its job starts at once. */
const AT = T0 + 2 * DAY_MS;
const mail = (i: number): SyntheticMail => ({ ...MAILS.bankEn, id: `abc${i.toString(16).padStart(13, '0')}` });
/** The largest synthetic row (a part's first row is kept whatever its size). */
const SLACK = 1_300_000;

/** Every table but SQLite's and Cloudflare's own, sorted by name. */
async function tables(h: Harness): Promise<string[]> {
  const rows = await h.sql<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`);
  return rows.map((row) => row.name);
}

/** The schema as SQLite keeps it: every table and index statement. */
async function schema(h: Harness): Promise<unknown[]> {
  return h.sql(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type, name`);
}

/** Every row of every table, each value with its SQLite type (a blob as hex), in rowid or key order. */
async function dump(h: Harness): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of await tables(h)) {
    const columns = (await h.sql<{ name: string }>(`PRAGMA table_info("${table}")`)).map((column) => column.name);
    const sql = (await h.sql<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = ?`, table))[0]?.sql ?? '';
    const rowid = !/WITHOUT ROWID/i.test(sql);
    const values = columns.map((column) => `typeof("${column}"), CASE typeof("${column}") WHEN 'blob' THEN hex("${column}") ELSE "${column}" END`);
    out[table] = await h.sql(`SELECT ${rowid ? 'rowid, ' : ''}${values.join(', ')} FROM "${table}" ORDER BY ${rowid ? 'rowid' : columns.map((column) => `"${column}"`).join(', ')}`);
  }
  return out;
}

/** Alarm ticks a second apart from `now` until the work in progress (a backup job, a restore) ends; the ticks and the last one's result. */
async function settle(h: Harness, now: number, what: 'backup' | 'restore', limit = 400): Promise<{ ticks: number; last: StepResult }> {
  for (let ticks = 1; ticks <= limit; ticks++) {
    const at = now + (ticks - 1) * SECOND;
    const last = await h.tick(at);
    const state = (await h.kv(what)) as { job?: unknown; state?: string } | null;
    if (what === 'backup' ? state !== null && state.job === null : state?.state !== 'running') return { ticks, last: { ...last, next: last.next - at } };
  }
  throw new Error(`the ${what} did not end`);
}

async function manifestOf(h: Harness, key?: string): Promise<BackupManifest> {
  const bucket = await h.mf.getR2Bucket('BACKUPS');
  const prefix = key ?? ((await (await bucket.get(LATEST))?.json()) as { key: string }).key;
  return (await (await bucket.get(prefix + MANIFEST))?.json()) as BackupManifest;
}

/** Every object of `from`'s bucket into `to`'s, as an owner would copy a backup into a new account's bucket. */
async function copyBucket(from: Harness, to: Harness, change?: (key: string, data: Uint8Array) => Uint8Array): Promise<void> {
  const source = await from.mf.getR2Bucket('BACKUPS');
  const target = await to.mf.getR2Bucket('BACKUPS');
  let cursor: string | undefined;
  do {
    const listed = await source.list({ limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
    for (const object of listed.objects) {
      const data = new Uint8Array(await (await source.get(object.key))?.arrayBuffer() ?? new ArrayBuffer(0));
      await target.put(object.key, change?.(object.key, data) ?? data);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

/** A store with rows in every table: the pipeline's own, and synthetic rows of every historical table. */
async function populate(h: Harness): Promise<void> {
  await h.step(T0);
  await setMode(h, Mode.LIVE);
  await h.api.initializePriorities({ requestId: op() });
  await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
  h.up.claude.bucket = 'P2';
  for (let i = 1; i <= 12; i++) deliver(h, mail(i), T0 + MINUTE);
  for (let pass = 2; pass <= 4; pass++) await h.step(T0 + pass * MINUTE);
  expect(modifies(h).length).toBeGreaterThan(0);
  const blob = `X'${Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')).join('')}'`;
  const statements = [
    `INSERT INTO examples (id, label_id, summary, origin, message_id, embedding, create_time) VALUES ('ex1', 'p2', '合成摘要 "quoted" it''s' || char(10) || 'two lines', 'correction', 'm-ex1', ${blob}, ${String(T0)})`,
    `INSERT INTO examples (id, label_id, summary, origin, message_id, embedding, create_time) VALUES ('ex2', 'p4', '', 'confirmation', NULL, NULL, ${String(T0)})`,
    // Six rows of 1.2 MB: each goes alone into a part, and the step's budget spreads them over steps.
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6)
     INSERT INTO review (id, message_id, kind, state, decider, subject, sender, receive_time, create_time)
     SELECT 'r' || i, 'm-r' || i, 'unsure', 'pending', 'claude', 'Synthetic ' || replace(hex(zeroblob(300000)), '0', 'é'), 'Sender <example.org>', ${String(T0)}, ${String(T0)} FROM n`,
    `INSERT INTO pending (message_id, added_at, not_before, attempts, deferred) VALUES ('abc00000000000ff', ${String(T0)}, ${String(T0 + 30 * DAY_MS)}, 2, ${String(T0)})`,
    `INSERT INTO feedback (key, message_id, change, gmail_label_id, seq) VALUES ('1001:m-f1:added:Label_9', 'm-f1', 'added', 'Label_9', 1001)`,
    `INSERT INTO retired_labels (id, retire_time) VALUES ('old-label', ${String(T0)})`,
    `INSERT INTO gmail_parents (gmail_id, create_time) VALUES ('Label_77', ${String(T0)})`,
    `INSERT INTO trusted_domains (label_id, domain, origin, subdomains, create_time) VALUES ('p2', 'bank.example.com', 'owner', 1, ${String(T0)})`,
    `INSERT INTO replay (job_id, message_id, state, owner_label, outcome, top_p, runner_up_p, combined, create_time) VALUES ('job1', 'm-rp1', 'evaluated', 'p2', 'label', 0.30000000000000004, -1.5e-300, 1e300, ${String(T0)})`,
    `INSERT INTO label_aliases (source_id, target_id) VALUES ('old-p2', 'p2')`,
    `INSERT INTO label_merge_jobs (id, state, phase, plan, create_time, update_time, etag) VALUES ('merge1', 'succeeded', 'done', '{"groups":[]}', ${String(T0)}, ${String(T0)}, 'e1')`,
    `INSERT INTO label_merge_items (job_id, message_id, source_id, target_id, source_gmail_id, target_gmail_id, state) VALUES ('merge1', 'm-mi1', 'old-p2', 'p2', 'Label_1', 'Label_2', 'done')`,
    `INSERT INTO label_merge_hides (job_id, gmail_id, state) VALUES ('merge1', 'Label_1', 'done')`,
    `INSERT INTO unread_batch (message_id, state, ledger_id) VALUES ('m-u1', 'skipped', NULL)`,
    // A guard an older release stored: Ops' normal request clears it, but never while a restore loads it.
    `INSERT INTO meta (key, value) VALUES ('guard_reason', 'usage_80')`,
    `INSERT INTO codex_usage (day, requests, successes, failures, usage_reported, input_tokens, output_tokens) VALUES ('2026-09-30', 3, 2, 1, 1, 9007199254740991, -7)`,
    // More counters than one part holds: a WITHOUT ROWID table read over several parts in key order.
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40000)
     INSERT INTO flow (day, stage, outcome, label, n) SELECT printf('2025-%05d', i), 'claude', 'applied', 'p' || (i % 4 + 1), i FROM n`,
  ];
  for (const statement of statements) await h.sql(statement);
}

describe('a populated store backs itself up and restores into an empty one', () => {
  let source: Harness;
  let target: Harness;
  let before: Record<string, unknown[]>;
  let prefix: string;
  /** When the first backup finished: its last step's clock. */
  let finished = 0;
  beforeAll(async () => {
    source = await startHarness({ backups: true });
    await populate(source);
    target = await startHarness({ backups: true });
  });
  afterAll(async () => {
    checkGoogleCalls(source);
    checkGoogleCalls(target);
    await source.dispose();
    await target.dispose();
  });

  it('covers every table, in bounded steps, and writes the manifest last, then latest.json', async () => {
    const all = await tables(source);
    // Every table holds rows, so the comparison below proves each one.
    const empty = [];
    for (const table of all) if ((await source.sql<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`))[0]?.n === 0) empty.push(table);
    expect(empty).toEqual([]);
    before = await dump(source);
    const bucket = await source.mf.getR2Bucket('BACKUPS');
    const sizes = new Map<string, number>();
    let steps = 0;
    for (;;) {
      const result = await source.tick(AT + steps * SECOND);
      expect(result.code).toBe('backup');
      finished = AT + steps * SECOND;
      steps += 1;
      // Each step stores at most its parts and bytes (a part's first row may run over).
      const listed = await bucket.list({ prefix: 'backups/', limit: 1000 });
      const added = listed.objects.filter((object) => object.key.endsWith('.gz') && !sizes.has(object.key));
      let bytes = 0;
      for (const object of added) {
        const size = gunzipSync(new Uint8Array(await (await bucket.get(object.key))?.arrayBuffer() ?? new ArrayBuffer(0))).byteLength;
        sizes.set(object.key, size);
        bytes += size;
      }
      expect(added.length).toBeLessThanOrEqual(BACKUP_STEP_PARTS);
      expect(bytes).toBeLessThanOrEqual(BACKUP_STEP_BYTES + SLACK);
      // Before its last step, no manifest and no latest.json.
      const state = (await source.kv('backup')) as { job: unknown };
      if (state.job === null) break;
      expect(listed.objects.some((object) => object.key.endsWith(MANIFEST))).toBe(false);
      expect(await bucket.head(LATEST)).toBeNull();
      expect(steps).toBeLessThan(50);
    }
    expect(steps).toBeGreaterThan(3);
    prefix = ((await (await bucket.get(LATEST))?.json()) as { key: string }).key;
    expect(prefix).toBe('backups/2026-10-03T000000Z/');
    const manifest = await manifestOf(source);
    expect(manifest).toMatchObject({ format: BACKUP_FORMAT, object: MAILSORT_OBJECT, started_at: '2026-10-03T00:00:00Z', schema_version: SCHEMA_VERSION });
    expect(manifest.tables.map((table) => table.name).sort()).toEqual(all);
    for (const table of manifest.tables) {
      expect(table.rows, table.name).toBe(before[table.name]?.length);
      for (const part of table.parts) expect(sizes.get(part.key), part.key).toBeLessThanOrEqual(BACKUP_PART_BYTES + SLACK);
    }
    expect(manifest.tables.find((table) => table.name === 'flow')?.parts.length).toBeGreaterThan(5);
    // Each large review row went alone into a part of its own.
    expect(manifest.tables.find((table) => table.name === 'review')?.parts).toHaveLength(6);
    // The next job is tomorrow's, at 11:41 UTC; until then a tick runs the pipeline.
    expect(await source.kv('backup')).toMatchObject({ status: 'ok', since: AT, last_backup_at: finished, next_run: Date.parse('2026-10-04T11:41:00Z'), job: null });
    expect((await source.tick(AT + MINUTE)).code).not.toBe('backup');
  });

  it('Ops reports the backup', async () => {
    const status = await source.opsStatus();
    expect(status).toMatchObject({ last_backup_at: new Date(finished).toISOString().replace('.000Z', 'Z') });
    expect((status.counters as Record<string, number>).backup_age_seconds).toBeGreaterThanOrEqual(0);
    expect((status.signals as { code: string }[]).map((signal) => signal.code)).not.toContain('backup_failed');
  });

  it('refuses a store that holds records, a malformed or missing backup, and a target without the backup', async () => {
    expect(reasonOf(await rejection(source.api.startBackupRestore({ name: 'backupRestore', backup: prefix, requestId: op() })))).toBe('RESTORE_TARGET_NOT_EMPTY');
    expect(reasonOf(await rejection(target.api.startBackupRestore({ name: 'backupRestore', backup: 'latest', requestId: op() })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(target.api.startBackupRestore({ name: 'backupRestore', backup: prefix, requestId: op() })))).toBe('BACKUP_NOT_RESTORABLE');
    expect(reasonOf(await rejection(target.api.getBackupRestore({ name: 'backupRestore' })))).toBe('NOT_FOUND');
  });

  it('restores into a new object row for row; every other write waits until it succeeded', async () => {
    // A new object fills a few tables by itself before the owner starts the restore (history registration).
    await target.step(AT);
    await copyBucket(source, target);
    const started = await target.api.startBackupRestore({ name: 'backupRestore', backup: prefix.slice(0, -1), requestId: op() });
    expect(started).toMatchObject({ state: State.RUNNING, backup: prefix, schemaVersion: SCHEMA_VERSION });
    expect(reasonOf(await rejection(target.api.startBackupRestore({ name: 'backupRestore', backup: prefix, requestId: op() })))).toBe('RESTORE_ACTIVE');
    const settings = create(SettingsSchema, { name: 'settings', mode: Mode.OFF });
    expect(reasonOf(await rejection(target.api.updateSettings({ settings, updateMask: { paths: ['mode'] }, requestId: op() })))).toBe('RESTORE_ACTIVE');
    // Neither a pass nor a backup runs meanwhile, and Ops' normal guard request changes no restored row.
    expect(await target.step(AT)).toMatchObject({ code: 'restoring' });
    for (let tick = 0; tick < 3; tick++) await target.tick(AT + tick * SECOND);
    expect(await target.sql(`SELECT value FROM meta WHERE key = 'guard_reason'`)).toEqual([{ value: 'usage_80' }]);
    expect(await target.opsSetGuard({ level: 'normal', reason: 'quota_recovered', until: null })).toMatchObject({ level: 'normal' });
    const { ticks, last } = await settle(target, AT + 3 * SECOND, 'restore');
    expect(ticks).toBeGreaterThan(2);
    // Its last step asks for the next alarm at once: the new backup and the pipeline start without waiting for a call.
    expect(last).toEqual({ next: 0, code: 'restore' });
    const done = await target.api.getBackupRestore({ name: 'backupRestore' });
    expect(done).toMatchObject({ state: State.SUCCEEDED, errorCode: '', backup: prefix });
    expect(done.tables.map((table) => table.table).sort()).toEqual(await tables(source));
    for (const table of done.tables) expect(table.restoredRows, table.table).toBe(table.backupRows);

    expect(await schema(target)).toEqual(await schema(source));
    const after = await dump(target);
    // Intake resumes from the mailbox's current state: the history cursor is the one difference.
    const meta = (rows: unknown[]) => rows.filter((row) => !JSON.stringify(row).includes('"history_cursor"'));
    expect(meta(after.meta ?? [])).toEqual(meta(before.meta ?? []));
    expect((after.meta ?? []).length).toBe((before.meta ?? []).length - 1);
    for (const table of Object.keys(before)) if (table !== 'meta') expect(after[table], table).toEqual(before[table]);
  });

  it('then backs the restored store up at once and runs the pipeline from the current mailbox, writing nothing', async () => {
    await settle(target, AT + MINUTE, 'backup');
    const latest = await manifestOf(target);
    expect(latest.started_at).toBe('2026-10-03T00:01:00Z');
    // The same rows but the history cursor the restore dropped.
    const rows = (manifest: BackupManifest) => manifest.tables.filter((table) => table.name !== 'meta').map((table) => [table.name, table.rows]);
    const restored = await manifestOf(target, prefix);
    expect(rows(latest)).toEqual(rows(restored));
    expect(latest.tables.find((table) => table.name === 'meta')?.rows).toBe((restored.tables.find((table) => table.name === 'meta')?.rows ?? 0) - 1);
    target.up.gmail.calls.length = 0;
    await target.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), updateMask: { paths: ['mode'] }, requestId: op() });
    await target.tick(AT + 2 * MINUTE);
    const paths = target.up.gmail.calls.map((call) => new URL(call.url).pathname);
    expect(paths.some((path) => path.endsWith('/profile'))).toBe(true);
    expect(paths.some((path) => path.endsWith('/history'))).toBe(false);
    expect(modifies(target)).toEqual([]);
    expect(reasonOf(await rejection(target.api.startBackupRestore({ name: 'backupRestore', backup: prefix, requestId: op() })))).toBe('RESTORE_TARGET_NOT_EMPTY');
  });

  it('tools/backup-restore.ts downloads it with wrangler, checks every part and loads it into SQLite', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mailsort-restore-'));
    try {
      const tool = (...args: string[]) => spawnSync(process.execPath, [TOOL, ...args, ...(WRANGLER && process.env.BAZEL_WRANGLER && ['download', 'upload', 'verify'].includes(args[0] ?? '') ? ['--wrangler', WRANGLER] : [])], { encoding: 'utf8' });
      const downloaded = tool('download', '--out', join(work, 'restore'), '--local', '--persist-to', source.persistTo);
      expect(downloaded.status, downloaded.stderr).toBe(0);
      expect(downloaded.stdout).toContain(`backup ${prefix}\n`);
      expect(downloaded.stdout).toMatch(/\nPASS flow rows=40\d{3} parts=\d+\n/);
      const verified = tool('verify', '--in', join(work, 'restore'));
      expect(verified.status, verified.stderr).toBe(0);
      const loaded = tool('sqlite', '--in', join(work, 'restore'), '--out', join(work, 'mailsort.sqlite'));
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout.trim().split('\n').at(-1)).toBe('sqlite PASS');
      for (const table of await tables(source)) expect(loaded.stdout).toContain(`PASS ${table} rows=${String(before[table]?.length)}/${String(before[table]?.length)}\n`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe('a broken part, a restart and the daily share of writes', () => {
  let source: Harness;
  let target: Harness;
  let prefix: string;
  beforeAll(async () => {
    source = await startHarness({ backups: true });
    await source.step(T0);
    await source.api.initializePriorities({ requestId: op() });
    // More rows than one day's share: the restore spreads over two UTC days.
    await source.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(RESTORE_ROWS_PER_DAY + 10_000)})
      INSERT INTO flow (day, stage, outcome, label, n) SELECT printf('2024-%06d', i), 'claude', 'applied', '', i FROM n`);
    await settle(source, AT, 'backup');
    prefix = 'backups/2026-10-03T000000Z/';
    target = await startHarness({ backups: true });
  });
  afterAll(async () => {
    await source.dispose();
    await target.dispose();
  });

  it('fails on a part whose SHA-256 differs, keeps refusing writes, and a restart after the fix succeeds over two days', async () => {
    const broken = (await manifestOf(source)).tables.find((table) => table.name === 'flow')?.parts[1]?.key ?? '';
    await copyBucket(source, target, (key, data) => (key === broken ? data.map((byte, i) => (i === 20 ? byte ^ 1 : byte)) : data));
    await target.api.startBackupRestore({ name: 'backupRestore', backup: prefix, requestId: op() });
    // Three failed steps, a minute apart, fail it.
    for (let minute = 0; minute < 8; minute++) await target.tick(AT + minute * MINUTE);
    const failed = await target.api.getBackupRestore({ name: 'backupRestore' });
    expect(failed).toMatchObject({ state: State.FAILED, errorCode: 'part_checksum' });
    expect(reasonOf(await rejection(target.api.initializePriorities({ requestId: op() })))).toBe('RESTORE_ACTIVE');
    expect((await target.tick(AT + 10 * MINUTE)).next).toBeNull();

    await copyBucket(source, target);
    const restarted = await target.api.startBackupRestore({ name: 'backupRestore', backup: prefix, requestId: op() });
    expect(restarted.state).toBe(State.RUNNING);
    const day = AT + 20 * MINUTE;
    for (let ticks = 0; ticks < 100; ticks++) {
      const state = (await target.kv('restore')) as { next_step: number; state: string };
      if (state.next_step > day + MINUTE) break;
      await target.tick(day + ticks * SECOND);
    }
    const waiting = await target.api.getBackupRestore({ name: 'backupRestore' });
    expect(waiting.state).toBe(State.RUNNING);
    expect(waiting.resumeTime && timestampMs(waiting.resumeTime)).toBe(AT + DAY_MS);
    const flow = waiting.tables.find((table) => table.table === 'flow');
    expect(flow?.restoredRows).toBeLessThan(flow?.backupRows ?? 0);
    expect(((await target.kv('restore')) as { day_rows: number }).day_rows).toBeGreaterThanOrEqual(RESTORE_ROWS_PER_DAY);
    await settle(target, AT + DAY_MS, 'restore');
    const done = await target.api.getBackupRestore({ name: 'backupRestore' });
    expect(done.state).toBe(State.SUCCEEDED);
    for (const table of done.tables) expect(table.restoredRows, table.table).toBe(table.backupRows);
    expect((await target.sql<{ n: number }>(`SELECT count(*) AS n FROM flow`))[0]?.n).toBe(RESTORE_ROWS_PER_DAY + 10_000);
  });
});

it("after a switch to a new object (MAILSORT_OBJECT), the former object's alarm ends without a pass", async () => {
  const h = await startHarness();
  try {
    expect(await h.tickOf(`${MAILSORT_OBJECT}-former`, T0)).toEqual({ result: { next: null, code: 'retired_object' }, passed: false });
    expect((await h.tickOf(MAILSORT_OBJECT, T0)).passed).toBe(true);
  } finally {
    await h.dispose();
  }
});

describe('a restored state is history: nothing in flight reaches Gmail again', () => {
  let source: Harness;
  let target: Harness;
  beforeAll(async () => {
    source = await startHarness({ backups: true });
    await source.step(T0);
    await setMode(source, Mode.LIVE);
    await source.api.initializePriorities({ requestId: op() });
    deliver(source, mail(1), T0 + MINUTE);
    await source.step(T0 + 2 * MINUTE);
    await source.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
    await source.step(T0 + 3 * MINUTE);
    // A write, an undo and an unread batch the backup catches in flight.
    await source.sql(`INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time, base_labels) VALUES ('0000000aaintend', 'm-in1', 'p2', NULL, 1, 'auto', 'intended', ${String(T0)}, '[]')`);
    await source.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, decider) VALUES ('m-in1', 't-in1', ${String(T0)}, ${String(T0)}, 'applied', 'p2', 'claude')`);
    await source.sql(`UPDATE ledger SET state = 'undo_intended' WHERE state = 'applied' AND id = (SELECT min(id) FROM ledger WHERE state = 'applied')`);
    await source.sql(`INSERT INTO meta (key, value) VALUES ('unread_scan', '{"startedAt":${String(T0)},"listed":false,"pageToken":"next"}')`);
    await source.sql(`INSERT INTO unread_batch (message_id, state) VALUES ('m-u2', 'pending')`);
    await settle(source, AT, 'backup');
    target = await startHarness({ backups: true });
    await copyBucket(source, target);
  });
  afterAll(async () => {
    checkGoogleCalls(target);
    await source.dispose();
    await target.dispose();
  });

  it('turns intents into history, ends the unread batch and drops the history cursor', async () => {
    await target.api.startBackupRestore({ name: 'backupRestore', backup: 'backups/2026-10-03T000000Z/', requestId: op() });
    await settle(target, AT, 'restore');
    expect(await target.sql(`SELECT state, last_code FROM ledger WHERE id = '0000000aaintend'`)).toEqual([{ state: 'failed', last_code: 'restored' }]);
    expect(await target.sql(`SELECT outcome FROM decisions WHERE message_id = 'm-in1'`)).toEqual([{ outcome: 'suggested' }]);
    expect(await target.sql(`SELECT count(*) AS n FROM ledger WHERE state IN ('intended', 'undo_intended')`)).toEqual([{ n: 0 }]);
    expect(await target.sql(`SELECT count(*) AS n FROM ledger WHERE last_code = 'restored' AND state = 'applied'`)).toEqual([{ n: 1 }]);
    expect(await target.sql(`SELECT state FROM unread_batch WHERE message_id = 'm-u2'`)).toEqual([{ state: 'skipped' }]);
    expect(JSON.parse(((await target.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'unread_scan'`))[0]?.value) ?? '{}')).toEqual({ startedAt: T0, listed: true });
    expect(await target.sql(`SELECT value FROM meta WHERE key = 'history_cursor'`)).toEqual([]);
    const installed = await source.sql(`SELECT value FROM meta WHERE key = 'installed_at'`);
    target.up.gmail.calls.length = 0;
    await settle(target, AT + MINUTE, 'backup');
    for (let minute = 2; minute < 6; minute++) await target.tick(AT + minute * MINUTE);
    expect(modifies(target)).toEqual([]);
    expect(await target.sql(`SELECT value FROM meta WHERE key = 'installed_at'`)).toEqual(installed);
    expect(await target.sql(`SELECT count(*) AS n FROM meta WHERE key = 'history_cursor'`)).toEqual([{ n: 1 }]);
  });
});
