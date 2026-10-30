/**
 * The daily backup (src/backup.ts) and the restore (src/restore.ts) on the real SubscriptionStore schema, Durable Object
 * SQLite and KV, and R2 in workerd, stepped at fixed clocks through test-store.ts: every table and KV key backed up,
 * restored into an empty object and compared row for row; the step budgets, a failed step repeated without duplicates,
 * a failed job, a failed restore resumed, retention, refusals, the Ops view and a retired object. Synthetic rows only.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, expect, it } from 'vitest';
import {
  BACKUP_FORMAT, CONTINUE_MS, ERROR_RETRY_MS, FAILED_RETRY_MS, KEEP, LATEST, MANIFEST, nextRun, SCHEMA_VERSION, STEP_BYTES,
  type BackupPart, type BackupState,
} from '../../src/backup.ts';
import { RESTORE_RETRY_MS, RESTORE_STEP_BYTES, WORK_SEQ_GAP, type RestoreState } from '../../src/restore.ts';

const DAY = 86_400_000;
/** The last 05:23 UTC slot before the run, so Ops sees a backup less than a day old. */
const SLOT = nextRun(Date.now() - DAY);
const runtimes: Miniflare[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); });

async function start() {
  const bundle = await build({
    ...(process.env.TEST_SRCDIR ? { nodePaths: [`${process.cwd()}/node_modules`] } : {}), entryPoints: ['test/runtime/test-store.ts'], bundle: true, format: 'esm', platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'], target: 'es2024', external: ['cloudflare:workers', 'node:*'], write: false,
    logLevel: 'silent' });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error('Missing the test store bundle');
  const unavailable = () => new Response(null, { status: 503 });
  const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'personal-mcp', script: output.text, modules: true, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { SUBSCRIPTIONS: { className: 'TestStore', useSQLite: true } },
    r2Buckets: { BACKUPS: 'personal-mcp-backups' },
    serviceBindings: { TASKS: unavailable, TODOFY_MAIL: unavailable, RECALL: unavailable, WATCH: unavailable, HOME: unavailable },
    bindings: { PUBLIC_HOST: 'mcp.example.org', ACCESS_ISSUER: 'https://test.cloudflareaccess.com', ACCESS_AUDIENCE: 'test',
      ACCESS_OWNER: 'owner@example.org', CALLBACK_HOSTS: 'receiver.example.org' },
  }] }));
  runtimes.push(runtime);
  await runtime.ready;
  const bucket = await runtime.getR2Bucket('BACKUPS') as unknown as R2Bucket;
  async function call<T>(object: string, method: string, ...args: unknown[]): Promise<T> {
    const response = await runtime.dispatchFetch(`https://store.internal/${object}`, { method: 'POST', body: JSON.stringify({ method, args }) });
    const reply = await response.json() as { result: T; error?: string };
    expect(reply.error, `${object}.${method}`).toBeUndefined();
    return reply.result;
  }
  return { runtime, bucket, call };
}
type Runtime = Awaited<ReturnType<typeof start>>;

interface Manifest {
  format: string;
  started_at: string;
  created_at: string;
  schema_version: number;
  tables: { name: string; sql: string; columns: string[]; max_rowid: number; sequence: number | null; rows: number; bytes: number;
    parts: BackupPart[] }[];
  kv: { rows: number; bytes: number; parts: BackupPart[] };
  excluded: { tables: string[]; kv: string[] };
}
type Dump = Record<string, unknown[]>;
type Step = { state: BackupState | null; due: number; at: number };

async function json<T>(bucket: R2Bucket, key: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`Missing ${key}`);
  return await object.json<T>();
}

/** A part's lines, checked against its SHA-256 and row count. */
async function partLines(bucket: R2Bucket, part: Pick<BackupPart, 'key' | 'rows' | 'sha256'>): Promise<string[]> {
  const object = await bucket.get(part.key);
  if (!object) throw new Error(`Missing ${part.key}`);
  const data = new Uint8Array(await object.arrayBuffer());
  expect(createHash('sha256').update(data).digest('hex'), part.key).toBe(part.sha256);
  expect(object.customMetadata?.sha256).toBe(part.sha256);
  const lines = new TextDecoder().decode(gunzipSync(data)).split('\n').filter(Boolean);
  expect(lines, part.key).toHaveLength(part.rows);
  return lines;
}

/** A dump's rows as a backup holds them: a blob as {"blob": base64}. */
function asBackupRows(rows: unknown[]): unknown[] {
  return rows.map(row => (row as unknown[]).map(value => typeof value === 'object' && value !== null && 'bytes' in value
    ? { blob: btoa(String.fromCharCode(...(value.bytes as number[]))) } : value));
}

/** Runs a job from `now` to its end, each step when the previous one said; answers each step with its time. */
async function backupJob(rt: Runtime, object: string, now: number): Promise<Step[]> {
  const steps: Step[] = [];
  for (let index = 0, at = now; index < 20; index++) {
    const step = { ...await rt.call<Step>(object, 'backupStep', at), at };
    steps.push(step);
    if (!step.state?.job) return steps;
    at = step.due;
  }
  throw new Error('The job did not end');
}

it('pins the store tables a backup holds; bump SCHEMA_VERSION with any change here', async () => {
  const rt = await start();
  expect(SCHEMA_VERSION).toBe(1);
  expect(await rt.call('fresh', 'tables')).toEqual([
    ['deliveries', ['rowid', 'subscription_id', 'event_id', 'body', 'state', 'attempts', 'next_at', 'accepted_at', 'error_code']],
    ['event_sources', ['rowid', 'name', 'state', 'checked_at', 'error_code']],
    ['own_changes', ['rowid', 'task_id', 'etag']],
    ['step_batches', ['rowid', 'request_id', 'input_hash', 'identities']],
    ['subscriptions', ['rowid', 'id', 'owner', 'url', 'secret', 'expires_at', 'verified_at', 'name', 'arguments']],
    ['test_events', ['rowid', 'id']],
    ['work', ['rowid', 'id', 'title', 'goal', 'scope', 'completion_criteria', 'state', 'checkpoint', 'next_action', 'waiting_for',
      'review_at', 'result', 'etag', 'created_at', 'updated_at', 'last_report_seq', 'handled_through_report_seq']],
    ['work_entries', ['rowid', 'seq', 'work_id', 'kind', 'summary', 'created_at', 'observed_at', 'evidence_ref', 'source_type',
      'source_ref', 'report_id', 'request_id', 'review_json', 'input_fingerprint', 'mutation', 'applied_etag']],
    ['work_links', ['rowid', 'work_id', 'type', 'ref', 'payload']],
  ]);
  // An empty store (a new object waiting for its restore) writes no backup and keeps no stale clock.
  const step = await rt.call<Step>('fresh', 'backupStep', SLOT);
  expect(step.state).toMatchObject({ status: 'never', since: null, job: null, next_run: nextRun(SLOT) });
  expect((await rt.bucket.list()).objects).toEqual([]);
});

it('backs up every table and KV key in bounded steps, then restores them row for row into an empty object', async () => {
  const rt = await start();
  await rt.call('owner', 'seed', 2400, 1200);
  // A store restored once and backed up before it numbered a new entry: its sequence is past its last entry.
  await rt.call('owner', 'exec', "UPDATE sqlite_sequence SET seq = 1207 WHERE name = 'work_entries'");
  const source = await rt.call<Dump>('owner', 'dump');
  expect(source.work_entries?.length).toBe(1200);

  // The first step plans and reads; rows written after the plan are not in this backup.
  const first = { ...await rt.call<Step>('owner', 'backupStep', SLOT), at: SLOT };
  expect(first.due).toBe(SLOT + CONTINUE_MS);
  const prefix = `backups/${new Date(SLOT).toISOString().slice(0, 19).replaceAll(':', '')}Z/`;
  expect(first.state?.job?.prefix).toBe(prefix);
  await rt.call('owner', 'exec', `INSERT INTO deliveries (subscription_id, event_id, body, next_at) VALUES ('sub_late', 'late', '{}', 1)`);
  const steps = [first, ...await backupJob(rt, 'owner', first.due)];
  expect(steps.length).toBeGreaterThan(2);
  // Each step stored at most STEP_BYTES of rows, plus the row that crossed it.
  const known = new Set<string>();
  for (const step of steps.slice(0, -1)) {
    const parts = [...step.state?.job?.kv.parts ?? [], ...(step.state?.job?.tables ?? []).flatMap(table => table.parts)]
      .filter(part => !known.has(part.key));
    let bytes = 0;
    let largest = 0;
    for (const part of parts) {
      known.add(part.key);
      for (const line of await partLines(rt.bucket, part)) { bytes += line.length + 1; largest = Math.max(largest, line.length + 1); }
    }
    expect(bytes).toBeLessThanOrEqual(STEP_BYTES + largest);
  }
  const done = steps.at(-1);
  expect(done?.at).toBe(SLOT + (steps.length - 1) * CONTINUE_MS);
  expect(done?.state).toMatchObject({ status: 'ok', last_backup_at: done?.at, last_key: prefix, failed_jobs: 0, job: null, since: SLOT });
  expect(done?.due).toBe(SLOT + DAY);
  expect(await json(rt.bucket, LATEST)).toEqual({ key: prefix });

  const manifest = await json<Manifest>(rt.bucket, `${prefix}${MANIFEST}`);
  expect(manifest).toMatchObject({ format: BACKUP_FORMAT, schema_version: SCHEMA_VERSION, started_at: new Date(SLOT).toISOString().replace('.000', ''),
    excluded: { tables: ['delivery_totals'], kv: ['backup', 'restore'] } });
  expect(manifest.tables.map(table => table.name)).toEqual(Object.keys(source).filter(name =>
    !['delivery_totals', 'sqlite_sequence', 'kv'].includes(name)));
  for (const table of manifest.tables) {
    expect(table.sql).toMatch(new RegExp(`^CREATE TABLE ${table.name} `));
    const rows: unknown[] = [];
    for (const part of table.parts) rows.push(...(await partLines(rt.bucket, part)).map(line => JSON.parse(line) as unknown));
    expect(rows, table.name).toEqual(asBackupRows(source[table.name] ?? []));
    expect(table.rows).toBe(rows.length);
    expect(table.sequence, table.name).toBe(table.name === 'work_entries' ? 1207 : null);
  }
  expect(manifest.tables.find(table => table.name === 'deliveries')?.parts.length).toBeGreaterThan(1);
  const kv: unknown[] = [];
  for (const part of manifest.kv.parts) kv.push(...(await partLines(rt.bucket, part)).map(line => JSON.parse(line) as unknown));
  expect(kv).toEqual(source.kv);
  expect(kv.map(entry => (entry as string[])[0])).toEqual(['last_subscription_at', 'last_subscription_request', 'last_tool_at']);
  // Not due again before the next slot.
  expect((await rt.call<Step>('owner', 'backupStep', SLOT + DAY - 1)).state?.job).toBeNull();

  // A restore needs an empty store and a complete backup of a schema this release has.
  const refused = async (object: string, backup: unknown) => rt.call<{ status: number; error: string }>(object, 'beginRestore', backup, SLOT);
  expect(await refused('owner', prefix)).toMatchObject({ status: 409, error: 'store_not_empty' });
  expect(await refused('target', '../escape/')).toMatchObject({ status: 400, error: 'invalid_backup' });
  expect(await refused('target', 'backups/2020-01-01T000000Z/')).toMatchObject({ status: 404, error: 'backup_not_found' });
  for (const [at, changed] of [['2020-01-02T000000Z', { schema_version: SCHEMA_VERSION + 1 }],
    ['2020-01-03T000000Z', { tables: [{ ...manifest.tables[0], name: 'unknown_table' }] }]] as const) {
    await rt.bucket.put(`backups/${at}/${MANIFEST}`, JSON.stringify({ ...manifest, ...changed }));
    expect(await refused('target', `backups/${at}/`)).toMatchObject({ status: 422, error: 'backup_schema_unsupported' });
  }
  // Another request that writes while the manifest is read wins: the store is no longer empty, and nothing starts.
  expect(await rt.call('racer', 'beginRestore', prefix, SLOT, true)).toMatchObject({ status: 409, error: 'store_not_empty' });
  expect(await rt.call('racer', 'restoreStep', SLOT)).toEqual({ next: null, state: null });

  // The restore: bounded steps, each part checked and read back, then its verification.
  const started = await rt.call<{ status: number; restore: { phase: string; parts: { total: number } } }>('target', 'beginRestore', prefix, SLOT);
  expect(started).toMatchObject({ status: 202, restore: { phase: 'running', parts: { loaded: 0 } } });
  const partsOf = (state: RestoreState) => state.families.flatMap(family => family.parts);
  let previous = 0;
  for (let index = 0; ; index++) {
    expect(index).toBeLessThan(20);
    const step = await rt.call<{ next: number | null; state: RestoreState }>('target', 'restoreStep', SLOT);
    const all = partsOf(step.state);
    const loaded = step.state.families.slice(0, step.state.next.family).reduce((sum, family) => sum + family.parts.length, 0) + step.state.next.part;
    let bytes = 0;
    for (const part of all.slice(previous, loaded - 1)) bytes += (await partLines(rt.bucket, part)).reduce((sum, line) => sum + line.length + 1, 0);
    expect(bytes).toBeLessThan(RESTORE_STEP_BYTES);
    previous = loaded;
    if (step.next === null) {
      expect(step.state.phase).toBe('done');
      expect(step.state.verification?.every(item => item.ok)).toBe(true);
      expect(step.state.verification?.map(item => [item.name, item.restored])).toEqual([
        ...manifest.tables.map(table => [table.name, table.rows]), ['kv', 3],
        ['delivery_totals', manifest.tables.find(table => table.name === 'deliveries')?.rows],
      ]);
      break;
    }
    expect(step.next).toBe(SLOT + CONTINUE_MS);
  }
  const restored = await rt.call<Dump>('target', 'dump');
  // Every event source is marked to be checked at once; everything else is the source, rowids and blob included.
  expect(restored.event_sources?.map(row => (row as unknown[]).slice(3))).toEqual([[0, 'restored'], [0, 'restored'], [0, 'restored']]);
  // New Work entries are numbered past the gap from the backup's sequence, not its last entry, so no Work notice reuses
  // an event ID the lost store may have sent; every etag moves by the gap, so no etag a Dot holds from it matches.
  const etag = manifest.tables.find(table => table.name === 'work')?.columns.indexOf('etag') ?? -1;
  expect(etag).toBeGreaterThan(0);
  const expected = { ...source, event_sources: source.event_sources?.map(row => [...(row as unknown[]).slice(0, 3), 0, 'restored']),
    work: source.work?.map(row => (row as unknown[]).map((value, index) => index === etag ? (value as number) + WORK_SEQ_GAP : value)),
    sqlite_sequence: source.sqlite_sequence?.map(row => (row as unknown[])[1] === 'work_entries'
      ? [(row as unknown[])[0], 'work_entries', 1207 + WORK_SEQ_GAP] : row) };
  expect(restored).toEqual(expected);
  // The restored store backs itself up at once; a second restore finds it filled.
  expect((await rt.call<Step>('target', 'backupStep', SLOT + 1000)).state?.job?.tables).not.toBeNull();
  expect(await refused('target', prefix)).toMatchObject({ status: 409, error: 'store_not_empty' });
}, 120_000);

it('repeats a failed step from the parts stored, and fails a job after three failed steps in a row', async () => {
  const rt = await start();
  await rt.call('owner', 'seed', 300, 200);
  const source = await rt.call<Dump>('owner', 'dump');
  // The second part of the first step fails: the first part's cursor moved, the rest repeat.
  await rt.call('owner', 'fail', { put: 1, putAfter: 1 });
  const failed = await rt.call<Step>('owner', 'backupStep', SLOT);
  expect(failed.due).toBe(SLOT + ERROR_RETRY_MS);
  expect(failed.state?.job?.errors).toBe(1);
  expect(failed.state?.job?.kv.parts).toHaveLength(1);
  expect(failed.state?.job?.tables?.flatMap(table => table.parts)).toEqual([]);
  const steps = await backupJob(rt, 'owner', SLOT + ERROR_RETRY_MS);
  expect(steps.at(-1)?.state?.status).toBe('ok');
  const manifest = await json<Manifest>(rt.bucket, `${steps.at(-1)?.state?.last_key ?? ''}${MANIFEST}`);
  for (const table of manifest.tables) {
    const rows: unknown[] = [];
    for (const part of table.parts) rows.push(...(await partLines(rt.bucket, part)).map(line => JSON.parse(line) as unknown));
    expect(rows, table.name).toEqual(asBackupRows(source[table.name] ?? []));
  }

  await rt.call('other', 'seed', 10, 10);
  await rt.call('other', 'fail', { put: 100 });
  let step: Step | undefined;
  for (let index = 0; index < 3; index++) step = await rt.call<Step>('other', 'backupStep', SLOT + index * ERROR_RETRY_MS);
  expect(step?.state).toMatchObject({ status: 'failed', error_code: 'storage_error', failed_jobs: 1, job: null });
  expect(step?.due).toBe(SLOT + 2 * ERROR_RETRY_MS + FAILED_RETRY_MS);
  await rt.call('other', 'fail', {});
  // Ops: the failed job is a warning (beside the seeded failed delivery's); it is not stale yet.
  const ops = await rt.call<{ signals: { code: string }[] }>('other', 'getOpsStatus');
  expect(ops.signals.map(signal => signal.code)).toEqual(['backup_failed', 'delivery_failed']);
});

it('repeats a failed restore step without duplicates, fails after three, refuses other writes, and resumes', async () => {
  const rt = await start();
  await rt.call('owner', 'seed', 300, 200);
  const source = await rt.call<Dump>('owner', 'dump');
  const steps = await backupJob(rt, 'owner', SLOT);
  const prefix = steps.at(-1)?.state?.last_key ?? '';
  expect(await rt.call('target', 'beginRestore', prefix, SLOT)).toMatchObject({ status: 202 });
  // A row in the way of the first part's tenth: the part's first nine rows roll back with it.
  const deliveries = source.deliveries as unknown[][];
  const blocking = deliveries[9]?.[0] as number;
  await rt.call('target', 'exec', 'INSERT INTO deliveries (rowid, subscription_id, event_id, body, next_at) VALUES (?, ?, ?, ?, ?)',
    blocking, 'sub_blocking', 'blocking', '{"timestamp":"2026-10-20T00:00:00Z"}', 1);
  const blocked = await rt.call<{ next: number | null; state: RestoreState }>('target', 'restoreStep', SLOT);
  expect(blocked).toMatchObject({ next: SLOT + RESTORE_RETRY_MS, state: { phase: 'running', errors: 1, error_code: 'insert_failed', next: { family: 0, part: 0 } } });
  expect(await rt.call('target', 'exec', 'SELECT count(*) AS n FROM deliveries')).toEqual([{ n: 1 }]);
  // While it is unfinished, Ops reports maintenance.
  const ops = await rt.call<{ health: string; modes: { maintenance: boolean }; signals: { code: string }[] }>('target', 'getOpsStatus');
  expect(ops).toMatchObject({ health: 'down', modes: { maintenance: true } });
  expect(ops.signals.map(signal => signal.code)).toContain('maintenance_mode');
  await rt.call('target', 'exec', 'DELETE FROM deliveries WHERE rowid = ?', blocking);
  // Two more failed reads fail it; the owner's call with the same backup resumes it, another backup is refused.
  await rt.call('target', 'fail', { get: 2 });
  await rt.call('target', 'restoreStep', SLOT);
  const failed = await rt.call<{ next: number | null; state: RestoreState }>('target', 'restoreStep', SLOT);
  expect(failed).toMatchObject({ next: null, state: { phase: 'failed', errors: 3 } });
  expect(await rt.call('target', 'beginRestore', 'backups/2020-01-01T000000Z/', SLOT)).toMatchObject({ status: 409, error: 'restore_unfinished' });
  expect(await rt.call('target', 'beginRestore', prefix, SLOT)).toMatchObject({ status: 202, restore: { phase: 'running' } });
  for (let index = 0; ; index++) {
    expect(index).toBeLessThan(20);
    if ((await rt.call<{ next: number | null }>('target', 'restoreStep', SLOT)).next === null) break;
  }
  const restored = await rt.call<Dump>('target', 'dump');
  expect(restored.deliveries).toEqual(source.deliveries);
  expect(restored.work_entries).toEqual(source.work_entries);
  const after = await rt.call<{ health: string; modes: { maintenance: boolean } }>('target', 'getOpsStatus');
  expect(after.modes.maintenance).toBe(false);
});

it('keeps the newest complete backups and deletes older ones and incomplete leftovers', async () => {
  const rt = await start();
  const older = Array.from({ length: KEEP + 1 }, (_, index) => `backups/2020-01-${String(index + 1).padStart(2, '0')}T052300Z/`);
  for (const prefix of older) {
    await rt.bucket.put(`${prefix}${MANIFEST}`, '{}');
    await rt.bucket.put(`${prefix}tables/work/00001.ndjson.gz`, 'x');
  }
  const incomplete = 'backups/2020-01-05T120000Z/';
  await rt.bucket.put(`${incomplete}tables/work/00001.ndjson.gz`, 'x');
  await rt.call('owner', 'seed', 5, 5);
  await rt.call('owner', 'r2Calls');
  const steps = await backupJob(rt, 'owner', SLOT);
  const current = steps.at(-1)?.state?.last_key ?? '';
  // The first step's ten parts, the manifest and latest.json, then one listing and one delete: well inside Free's 50
  // subrequests, however many backups the bucket keeps.
  expect(await rt.call('owner', 'r2Calls')).toBe(10 + 2 + 2);
  const listed = await rt.bucket.list({ prefix: 'backups/', delimiter: '/' });
  expect(listed.delimitedPrefixes).toEqual([...older.slice(-(KEEP - 1)), current]);
  expect((await rt.bucket.list({ prefix: incomplete })).objects).toEqual([]);
  expect((await rt.bucket.list({ prefix: older[0] ?? '' })).objects).toEqual([]);
  expect(await json(rt.bucket, LATEST)).toEqual({ key: current });
});

it('reports the backup in Ops, and an object the Worker no longer routes to stays quiet', async () => {
  const rt = await start();
  await rt.call('owner', 'seed', 5, 5);
  const before = await rt.call<{ counters: Record<string, number>; last_backup_at: string | null; signals: unknown[] }>('owner', 'getOpsStatus');
  expect(before.counters).not.toHaveProperty('backup_age_seconds');
  expect(before.last_backup_at ?? null).toBeNull();
  const finished = (await backupJob(rt, 'owner', SLOT)).at(-1)?.at ?? 0;
  const after = await rt.call<{ counters: Record<string, number>; last_backup_at: string; signals: { code: string }[] }>('owner', 'getOpsStatus');
  expect(after.last_backup_at).toBe(new Date(finished).toISOString());
  expect(Math.abs((after.counters.backup_age_seconds ?? 0) - Math.floor((Date.now() - finished) / 1000))).toBeLessThanOrEqual(2);
  // The seeded failed delivery's warning only: no backup signal.
  expect(after.signals.map(signal => signal.code)).toEqual(['delivery_failed']);
  await rt.call('retired', 'seed', 5, 5);
  expect(await rt.call('retired', 'realAlarm')).toEqual({ alarm: null, backup: null });
}, 60_000);
