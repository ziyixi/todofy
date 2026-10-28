/**
 * The daily backup and the restore (src/backup.ts, src/restore.ts) on real SQLite Durable Objects and real R2 in
 * workerd, driven step by step at fixed clocks through a probe object that runs the production modules over its own
 * store, with R2 calls that fail on demand: a populated store backed up and restored into an empty one, row for row and
 * byte for byte; the step budgets; a failed step repeated without duplicates; a failed job; retention; the refusals; a
 * restore that fails and starts again; the Ops view. The real WatchState runs both in ./restore.test.ts. All synthetic.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  BACKUP_STALE_MS,
  ERROR_RETRY_MS,
  EVIDENCE_COPIES,
  FAILED_RETRY_MS,
  KEEP,
  LATEST,
  PART_BYTES,
  STEP_BYTES,
  type Manifest,
} from '../../src/backup.ts';
import { RESTORE_EVIDENCE_LOOKS, RESTORE_SEQUENCE_GAP } from '../../src/restore.ts';

const DAY = 86_400_000;
/** 2026-10-28T11:23:00Z: the daily slot. */
const T = Date.parse('2026-10-28T11:23:00Z');
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9]);

let mf: Miniflare;
let persistence: string;
let backups: R2Bucket;
let evidence: R2Bucket;

beforeAll(async () => {
  persistence = await mkdtemp(join(tmpdir(), 'watch-backup-'));
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { DurableObject } from 'cloudflare:workers';
    import { Store } from './src/store.ts';
    import { applyRetention, backupFacts, backupOps, backupState, runBackup } from './src/backup.ts';
    import { restoreState, runRestore, startRestore } from './src/restore.ts';
    export class BackupProbe extends DurableObject {
      constructor(ctx, env) {
        super(ctx, env);
        this.store = new Store(ctx.storage.sql);
        this.failing = { put: 0, get: 0, putKey: '' };
        this.calls = { put: 0, get: 0 };
        this.evidenceCalls = { get: 0, head: 0, put: 0 };
        ctx.blockConcurrencyWhile(async () => this.store.migrate());
      }
      // BACKUPS with puts and gets that fail on demand, counted.
      bucket() {
        const real = this.env.BACKUPS;
        const call = (kind, run) => {
          this.calls[kind] += 1;
          if (this.failing[kind] > 0) { this.failing[kind] -= 1; return Promise.reject(new Error('synthetic_outage')); }
          return run();
        };
        const put = (key, ...rest) => key === this.failing.putKey ? Promise.reject(new Error('synthetic_outage')) : call('put', () => real.put(key, ...rest));
        return { put, get: (...a) => call('get', () => real.get(...a)),
          head: (...a) => real.head(...a), list: (...a) => real.list(...a), delete: (...a) => real.delete(...a) };
      }
      // EVIDENCE_STORE with its calls counted (an invocation may make 1,000 calls to Cloudflare services).
      evidence() {
        const real = this.env.EVIDENCE_STORE;
        const count = (kind, run) => { this.evidenceCalls[kind] += 1; return run(); };
        return { get: (...a) => count('get', () => real.get(...a)), head: (...a) => count('head', () => real.head(...a)),
          put: (...a) => count('put', () => real.put(...a)) };
      }
      restoreDeps() {
        return { store: this.store, backups: this.bucket(), evidence: this.evidence(), transact: fn => this.ctx.storage.transactionSync(fn) };
      }
      async fetch(request) {
        const { op, args } = await request.json();
        try {
          if (op === 'sql') return Response.json({ ok: this.store.all(args[0], ...(args[1] ?? [])) });
          if (op === 'dump') {
            const out = {};
            for (const { name } of this.store.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' ORDER BY name")) {
              const columns = this.store.all('PRAGMA table_info("' + name + '")').map(row => row.name);
              out[name] = this.store.all('SELECT ' + columns.map(c => 'quote("' + c + '") AS "' + c + '"').join(', ') + ' FROM "' + name + '"')
                .map(row => JSON.stringify(row)).sort();
            }
            return Response.json({ ok: out });
          }
          if (op === 'fail') { this.failing = { put: 0, get: 0, putKey: '', ...args[0] }; return Response.json({ ok: null }); }
          if (op === 'calls') { const calls = this.calls; this.calls = { put: 0, get: 0 }; return Response.json({ ok: calls }); }
          if (op === 'evidence_calls') { const calls = this.evidenceCalls; this.evidenceCalls = { get: 0, head: 0, put: 0 }; return Response.json({ ok: calls }); }
          if (op === 'backup') return Response.json({ ok: await runBackup({ store: this.store, bucket: this.bucket(), evidence: this.evidence() }, args[0]) });
          if (op === 'retention') return Response.json({ ok: await applyRetention(this.store, this.env.BACKUPS, args[0]) });
          if (op === 'restore_start') {
            try { await startRestore(this.restoreDeps(), args[0], args[1]); return Response.json({ ok: 'started' }); }
            catch (error) { return Response.json({ ok: error.reason ?? error.message }); }
          }
          if (op === 'restore') return Response.json({ ok: await runRestore(this.restoreDeps(), args[0]) });
          if (op === 'state') return Response.json({ ok: { backup: backupState(this.store), restore: restoreState(this.store) } });
          if (op === 'ops') return Response.json({ ok: backupOps(backupFacts(this.store), args[0]) });
          if (op === 'meter') return Response.json({ ok: this.store.takeMeter() });
          return Response.json({ error: 'unknown op' });
        } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'error' }); }
      }
    }
    export default { fetch() { return new Response(null, { status: 404 }); } };`,
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    mainFields: ['browser', 'module', 'main'],
    conditions: ['workerd', 'worker', 'import'],
    external: ['cloudflare:workers', 'node:buffer'],
    write: false,
    logLevel: 'silent',
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: join(persistence, 'v3'),
      handleStructuredLogs: () => undefined,
      workers: [
        {
          name: 'probe',
          modules: true,
          script: bundle.outputFiles[0]?.text ?? '',
          compatibilityDate: '2026-09-08',
          compatibilityFlags: ['nodejs_compat'],
          r2Buckets: ['BACKUPS', 'EVIDENCE_STORE'],
          durableObjects: { PROBE: { className: 'BackupProbe', useSQLite: true } },
        },
      ],
    }),
  );
  backups = (await mf.getR2Bucket('BACKUPS', 'probe')) as unknown as R2Bucket;
  evidence = (await mf.getR2Bucket('EVIDENCE_STORE', 'probe')) as unknown as R2Bucket;
});

afterAll(async () => {
  await mf.dispose();
  await rm(persistence, { recursive: true, force: true });
});

async function call<T>(object: string, op: string, ...args: unknown[]): Promise<T> {
  const namespace = await mf.getDurableObjectNamespace('PROBE', 'probe');
  const stub = namespace.get(namespace.idFromName(object));
  const response = await stub.fetch('http://probe/', { method: 'POST', body: JSON.stringify({ op, args }) });
  const result = (await response.json()) as { ok?: T; error?: string };
  if (result.error !== undefined) throw new Error(`${op}: ${result.error}`);
  return result.ok as T;
}
const sql = (object: string, query: string, ...params: unknown[]) => call<Record<string, unknown>[]>(object, 'sql', query, params);
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const hex = (data: Uint8Array) => Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');

interface State {
  backup: { status: string; last_key: string; next_run: number; failed_jobs: number; job: { phase: string; errors: number; prefix: string } | null } | null;
  restore: { state: string; phase: string; error_code: string; tables: { table: string; restored: number; expected: number }[]; evidence: Record<string, number> } | null;
}
const state = (object: string) => call<State>(object, 'state');

async function json<T>(key: string): Promise<T> {
  const object = await backups.get(key);
  if (object === null) throw new Error(`no ${key}`);
  return object.json();
}

/** Steps of the object's backup from `now` until its job ends; returns the steps' results. */
async function backupAll(object: string, now: number): Promise<{ ran: boolean; next: number }[]> {
  const steps: { ran: boolean; next: number }[] = [];
  let at = now;
  for (let i = 0; i < 200; i++) {
    const step = await call<{ ran: boolean; next: number }>(object, 'backup', at);
    steps.push(step);
    if (!step.ran || (await state(object)).backup?.job == null) return steps;
    at = step.next;
  }
  throw new Error('backup did not end');
}

async function restoreAll(object: string, now: number): Promise<number> {
  let at = now;
  for (let steps = 1; steps < 200; steps++) {
    const next = await call<number | null>(object, 'restore', at);
    if (next === null || (await state(object)).restore?.state !== 'running') return steps;
    at = next;
  }
  throw new Error('restore did not end');
}

/** Evidence objects in watch-evidence and their rows: captures (JSON) and screenshots (JPEG, shared by hash). */
async function seedEvidence(object: string, watch: string, count: number): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${String(i).padStart(9, '0')}abcdefg`.slice(0, 16);
    const objectKey = `captures/${watch}/${id}.json`;
    const imageKey = i % 3 === 0 ? `images/${sha256(Uint8Array.from([...JPEG, i % 2]))}.jpg` : '';
    await evidence.put(objectKey, JSON.stringify({ title: `合成页面 ${String(i)}`, markdown: `# 合成\n第 ${String(i)} 行 "quoted"` }), { httpMetadata: { contentType: 'application/json' } });
    if (imageKey) await evidence.put(imageKey, Uint8Array.from([...JPEG, i % 2]), { httpMetadata: { contentType: 'image/jpeg' } });
    await sql(object, `INSERT INTO evidence_snapshots VALUES (?, ?, ?, ?, ?, ?, 1)`, id, watch, T - DAY + i, `sha-${String(i)}`, objectKey, imageKey);
    keys.push(objectKey);
    if (imageKey) keys.push(imageKey);
  }
  // An interrupted upload (ready = 0) is indexed but never copied.
  await sql(object, `INSERT INTO evidence_snapshots VALUES ('zzzzzzzzzzzzzzzz', ?, 1, 'sha', 'captures/unready.json', '', 0)`, watch);
  return [...new Set(keys)].sort();
}

/** A store with a row in every table, text with quotes, newlines and Chinese, BLOBs, and large rows when asked. */
async function seed(object: string, options: { largeRequests?: number; evidence?: number } = {}): Promise<string[]> {
  const statements = [
    `INSERT INTO watches (id, settings, host, read_hash, check_hash, state, pause_reason, etag, create_time, update_time, next_check_at, last_check_at, failures, baseline_id, seen_snapshot_id, pending_change)
       VALUES ('w1', '{"display_name":"合成 \\"一\\"","uri":"https://a.example.com/p"}', 'a.example.com', 'r1', 'c1', 'active', NULL, 'e1', 1, 2, ${String(T + 3_600_000)}, ${String(T - 3_600_000)}, 0, 1, 2, 'p1'),
              ('w2', '{"display_name":"two","uri":"https://b.example.com/"}', 'b.example.com', 'r2', 'c2', 'paused', 'owner', 'e2', 3, 4, NULL, NULL, 2, NULL, NULL, NULL)`,
    `INSERT INTO snapshots (watch_id, created_at, sha, line_count, body, evidence_ref) VALUES ('w1', 10, 's1', 3, randomblob(2000), 'watches/w1/snapshots/000000000abcdefg'),
       ('w1', 11, 's2', 0, X'', ''), ('w2', 12, 's3', 1, X'1f8b0800', '')`,
    `INSERT INTO changes (id, watch_id, state, suppression, trigger_kind, summary, added, removed, diff, detect_time, resolve_time, snapshot_id, before_snapshot_id, before_context, context_available, before_evidence)
       VALUES ('0000000001aaaaaa', 'w1', 'confirmed', NULL, 'any_change', '新增 1 行', 1, 0, '[{"k":1,"t":"it''s\\n新"}]', 100, 101, 2, 1, '["a"]', 1, 'watches/w1/snapshots/000000000abcdefg'),
              ('0000000002aaaaaa', 'w1', 'suppressed', 'FLICKER', 'any_change', 's', 0, 1, '[]', 102, NULL, NULL, NULL, '[]', 0, ''),
              ('p1', 'w1', 'pending', NULL, 'number', 'n', 1, 1, '[]', 103, NULL, 2, 1, '[]', 0, ''),
              ('0000000003aaaaaa', 'w2', 'acknowledged', NULL, 'new_item', 'a', 2, 0, '[]', 104, 105, NULL, NULL, '[]', 0, '')`,
    `INSERT INTO notifications (kind, watch_id, change_id, policy, created_at, delivered_at) VALUES ('change_confirmed', 'w1', '0000000001aaaaaa', 'digest', 100, 200),
       ('change_confirmed', 'w1', '0000000001aaaaaa', 'urgent', 101, NULL), ('watch_broken', 'w2', NULL, 'digest', 102, NULL)`,
    `INSERT INTO notifications (kind, watch_id, policy, created_at, delivered_at, evidence_only, before_evidence, after_evidence) VALUES ('change_confirmed', 'w1', 'digest', 103, 103, 1, 'a', 'b')`,
    `UPDATE sqlite_sequence SET seq = 120 WHERE name = 'notifications'`,
    `INSERT INTO intents (intent_id, kind, day, payload, events, state, event_ids, next_at, created_at, updated_at) VALUES ('urgent-x', 'urgent', '2026-10-27', '{"title":"合成"}', 1, 'open', '[2]', 1, 1, 1),
       ('digest-2026-10-26', 'digest', '2026-10-26', '', 2, 'recorded', '[]', 1, 1, 2)`,
    `INSERT INTO evidence_deletions VALUES ('captures/w9/old.json')`,
    `INSERT INTO hosts VALUES ('a.example.com', 5, 6, 1), ('b.example.com', 7, NULL, 0)`,
    `INSERT INTO robots VALUES ('a.example.com', 'allow', ${String(T + DAY)})`,
    `INSERT INTO ledger VALUES ('2026-10-27', 12, 30000, 0)`,
    `INSERT INTO requests VALUES ('11111111-1111-4111-8111-111111111111', 'CreateWatch', 'watches', '{"name":"watches/w1"}', ${String(T - 1000)})`,
    `INSERT INTO url_fetches VALUES ('https://a.example.com/p', ${String(T - 1000)})`,
    `INSERT INTO previews VALUES ('cache-key', 1, '{}', randomblob(100))`,
    `INSERT INTO meta (key, value) VALUES ('pruned_at', '5'), ('digest_day', '2026-10-27'), ('watch_events_floor', '1'), ('last_alarm_at', '${String(T - 60_000)}')`,
  ];
  for (const statement of statements) await sql(object, statement);
  if (options.largeRequests)
    await sql(object, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO requests SELECT 'large-' || i, 'UpdateWatch', 'watches/w1', hex(randomblob(50000)), i FROM n`, options.largeRequests);
  return seedEvidence(object, 'w1', options.evidence ?? 4);
}

/** Every table but the backup's own, row for row (SQL literals, so BLOBs and types compare exactly). */
async function tables(object: string): Promise<Record<string, string[]>> {
  const dump = await call<Record<string, string[]>>(object, 'dump');
  delete dump.backup_evidence;
  delete dump.previews;
  dump.meta = (dump.meta ?? []).filter((row) => !/"key":"'(backup|restore|schema_version)'"/.test(row));
  return dump;
}

describe('the daily backup', () => {
  it('skips an empty store: a new object never pushes good backups out', async () => {
    const step = await call<{ ran: boolean; next: number }>('empty', 'backup', T - 3_600_000);
    expect(step).toEqual({ ran: false, next: T });
    expect(await backups.get(LATEST)).toBeNull();
    expect((await state('empty')).backup?.status).toBe('never');
    // Home's view: no backup since the first step, critical after three days.
    expect((await call<{ signals: { code: string }[] }>('empty', 'ops', T)).signals).toEqual([]);
    const stale = await call<{ signals: { code: string; metrics: Record<string, number> }[] }>('empty', 'ops', T - 3_600_000 + BACKUP_STALE_MS + 1);
    expect(stale.signals.map(({ code, metrics }) => ({ code, metrics }))).toEqual([{ code: 'backup_stale', metrics: { has_backup: 0 } }]);
  });

  it('copies every table and every referenced evidence object once, in bounded steps', async () => {
    const referenced = await seed('a', { largeRequests: 220, evidence: EVIDENCE_COPIES + 5 });
    await call('a', 'calls');
    const steps = await backupAll('a', T);
    const { backup } = await state('a');
    expect(backup?.status).toBe('ok');
    expect(backup?.next_run).toBe(T + DAY);
    const latest = await json<{ key: string }>(LATEST);
    expect(latest.key).toBe('backups/2026-10-28T112300Z/');
    const manifest = await json<Manifest>(`${latest.key}manifest.json`);
    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.schema_version).toBe(6);
    expect(Object.keys(manifest.excluded).sort()).toEqual(['backup_evidence', 'previews']);
    expect(manifest.tables.map((table) => table.name)).toEqual([
      'changes', 'evidence_deletions', 'evidence_snapshots', 'hosts', 'intents', 'ledger', 'meta', 'notifications', 'requests', 'robots', 'snapshots', 'url_fetches', 'watches', 'sqlite_sequence',
    ]);
    // Every part: its SHA-256 (in the manifest and its metadata), its rows, within PART_BYTES (and one row).
    const dump = await tables('a');
    for (const table of manifest.tables) {
      let rows = 0;
      for (const part of table.parts) {
        const object = await backups.get(part.key);
        if (object === null) throw new Error(`no ${part.key}`);
        const data = new Uint8Array(await object.arrayBuffer());
        expect(sha256(data)).toBe(part.sha256);
        expect(object.customMetadata?.sha256).toBe(part.sha256);
        const text = new TextDecoder().decode(gunzipSync(data));
        expect(text.length).toBeLessThanOrEqual(PART_BYTES + 120_000);
        rows += text.split('\n').filter(Boolean).length;
      }
      expect(rows, table.name).toBe(table.rows);
      expect(table.rows, table.name).toBe(dump[table.name]?.length);
    }
    expect(manifest.tables.find((table) => table.name === 'requests')?.parts.length).toBeGreaterThanOrEqual(6);
    // The steps: the tables (20 MiB of requests: two steps of STEP_BYTES), the evidence (two of EVIDENCE_COPIES), the end.
    expect(steps.length).toBe(5);
    expect(STEP_BYTES / PART_BYTES).toBe(4);
    expect(manifest.evidence.objects.map((object) => object.key)).toEqual(referenced);
    expect(manifest.evidence.missing).toEqual([]);
    for (const object of manifest.evidence.objects) {
      const copy = await backups.get(`evidence/${object.key}`);
      const original = await evidence.get(object.key);
      if (copy === null || original === null) throw new Error(`no copy of ${object.key}`);
      const bytes = new Uint8Array(await copy.arrayBuffer());
      expect(hex(bytes)).toBe(hex(new Uint8Array(await original.arrayBuffer())));
      expect(sha256(bytes)).toBe(object.sha256);
      expect(copy.customMetadata?.sha256).toBe(object.sha256);
    }
    // One PUT per part and per evidence object, the manifest and latest.json: nothing written twice.
    const parts = manifest.tables.reduce((sum, table) => sum + table.parts.length, 0);
    expect((await call<{ put: number }>('a', 'calls')).put).toBe(parts + referenced.length + 2);

    // The next day's backup copies no evidence again: one PUT per part, the manifest and latest.json.
    await backupAll('a', T + DAY);
    const second = await json<Manifest>(`${(await json<{ key: string }>(LATEST)).key}manifest.json`);
    expect(second.evidence.objects).toEqual(manifest.evidence.objects);
    expect((await call<{ put: number }>('a', 'calls')).put).toBe(second.tables.reduce((sum, table) => sum + table.parts.length, 0) + 2);
    // Home's view: the age of the newest complete backup (it ended the job's last step, seconds after its start).
    const done = ((await state('a')).backup as unknown as { last_backup_at: number }).last_backup_at;
    expect(done - (T + DAY)).toBeLessThan(10_000);
    const ops = await call<{ counters: Record<string, number>; signals: unknown[]; lastBackupAt: string }>('a', 'ops', done + 60_000);
    expect(ops).toEqual({ counters: { backup_age_seconds: 60 }, signals: [], lastBackupAt: new Date(done).toISOString().replace('.000Z', 'Z') });
  });

  it('repeats a failed step from the parts stored, without duplicates', async () => {
    await seed('f');
    await call('f', 'fail', { put: 1 });
    const failed = await call<{ ran: boolean; next: number }>('f', 'backup', T + 2 * DAY);
    expect(failed).toEqual({ ran: true, next: T + 2 * DAY + ERROR_RETRY_MS });
    expect((await state('f')).backup?.job?.errors).toBe(1);
    const steps = await backupAll('f', failed.next);
    expect(steps.at(-1)?.ran).toBe(true);
    const manifest = await json<Manifest>(`${(await json<{ key: string }>(LATEST)).key}manifest.json`);
    const dump = await tables('f');
    for (const table of manifest.tables) {
      expect(table.rows, table.name).toBe(dump[table.name]?.length);
      expect(new Set(table.parts.map((part) => part.key)).size).toBe(table.parts.length);
    }
  });

  it('fails a job after three failed steps, lets writes go on, starts again 6 hours later', async () => {
    await call('f', 'fail', { put: 99 });
    let at = T + 3 * DAY;
    for (let i = 0; i < 3; i++) at = (await call<{ next: number }>('f', 'backup', at)).next;
    const { backup } = await state('f');
    expect(backup?.status).toBe('failed');
    expect(backup?.job).toBeNull();
    expect(backup?.next_run).toBe(T + 3 * DAY + 2 * ERROR_RETRY_MS + FAILED_RETRY_MS);
    const ops = await call<{ signals: { code: string }[] }>('f', 'ops', T + 3 * DAY + 3 * ERROR_RETRY_MS);
    expect(ops.signals.map((signal) => signal.code)).toEqual(['backup_failed']);
    await call('f', 'fail', {});
    await backupAll('f', backup?.next_run ?? 0);
    expect((await state('f')).backup?.status).toBe('ok');
  });

  it('keeps the newest 30 complete backups and every evidence copy they name, nothing older', async () => {
    // Small backups from here on: a month of them.
    await sql('a', `DELETE FROM requests WHERE request_id LIKE 'large-%'`);
    const before = (await backups.list({ prefix: 'backups/', delimiter: '/' })).delimitedPrefixes;
    // An incomplete prefix (a failed job's part) older than the next backup.
    await backups.put('backups/2026-10-31T000000Z/meta/00001.ndjson.gz', new Uint8Array([1]));
    // A screenshot no snapshot will name again after the next backup.
    const [{ image_key: dropped } = { image_key: '' }] = (await sql('a', `SELECT image_key FROM evidence_snapshots WHERE image_key != '' ORDER BY id LIMIT 1`)) as { image_key: string }[];
    await sql('a', `DELETE FROM evidence_snapshots WHERE image_key = ?`, dropped);
    for (let day = 4; day < 4 + KEEP; day++) await backupAll('a', T + day * DAY);
    const after = (await backups.list({ prefix: 'backups/', delimiter: '/' })).delimitedPrefixes;
    expect(after).toHaveLength(KEEP);
    expect(after[0]).toBe('backups/2026-11-01T112300Z/');
    for (const prefix of [...before, 'backups/2026-10-31T000000Z/']) expect(after).not.toContain(prefix);
    expect((await backups.list({ prefix: 'backups/2026-10-31T000000Z/' })).objects).toEqual([]);
    // The dropped screenshot was named only by the deleted backups: its copy is gone; the others stay.
    expect(await backups.head(`evidence/${dropped}`)).toBeNull();
    const latest = await json<Manifest>(`${after.at(-1) ?? ''}manifest.json`);
    for (const object of latest.evidence.objects) expect(await backups.head(`evidence/${object.key}`)).not.toBeNull();
  });
});

describe('the restore', () => {
  it('refuses a store with watches, an unknown backup and one this release cannot read', async () => {
    expect(await call('a', 'restore_start', '', T + 40 * DAY)).toBe('STORE_NOT_EMPTY');
    expect(await call('b', 'restore_start', 'backups/2026-01-01T000000Z/', T + 40 * DAY)).toBe('BACKUP_NOT_FOUND');
    expect(await call('b', 'restore_start', 'not-a-backup', T + 40 * DAY)).toBe('BACKUP_NOT_FOUND');
    const newer = { ...(await json<Manifest>(`${(await json<{ key: string }>(LATEST)).key}manifest.json`)), schema_version: 99 };
    await backups.put('backups/2099-01-01T000000Z/manifest.json', JSON.stringify(newer));
    expect(await call('b', 'restore_start', 'backups/2099-01-01T000000Z/', T + 40 * DAY)).toBe('BACKUP_UNSUPPORTED');
    await backups.delete('backups/2099-01-01T000000Z/manifest.json');
    expect((await state('b')).restore).toBeNull();
  });

  it('restores the newest backup into an empty store: the same rows, the evidence back first, verified', async () => {
    const source = await tables('a');
    const key = (await json<{ key: string }>(LATEST)).key;
    const manifest = await json<Manifest>(`${key}manifest.json`);
    // The evidence bucket lost two objects; the restore puts them back from their copies.
    const lost = manifest.evidence.objects.slice(0, 2);
    const originals = new Map<string, string>();
    for (const object of manifest.evidence.objects) originals.set(object.key, hex(new Uint8Array(await ((await evidence.get(object.key)) as R2ObjectBody).arrayBuffer())));
    for (const object of lost) await evidence.delete(object.key);
    // A minute of the store's own rows (an alarm pass) is not data: the restore replaces them.
    await sql('b', `INSERT INTO meta VALUES ('last_alarm_at', '1')`);
    expect(await call('b', 'restore_start', '', T + 40 * DAY)).toBe('started');
    // The first step's read fails: the step runs again.
    await call('b', 'fail', { get: 1 });
    const steps = await restoreAll('b', T + 40 * DAY);
    const { restore } = await state('b');
    expect(restore?.state).toBe('succeeded');
    expect(steps).toBeGreaterThan(3);
    expect(restore?.tables).toEqual(manifest.tables.map((table) => ({ table: table.name, restored: table.rows, expected: table.rows })));
    expect(restore?.evidence).toEqual({ restored: 2, present: manifest.evidence.objects.length - 2, missing: 0, mismatched: 0 });
    for (const [objectKey, bytes] of originals) expect(hex(new Uint8Array(await ((await evidence.get(objectKey)) as R2ObjectBody).arrayBuffer())), objectKey).toBe(bytes);

    // Row for row, but what keeps the old state from acting again: deliveries settled, the event feed moved on.
    const restored = await tables('b');
    expect(Object.keys(restored).sort()).toEqual(Object.keys(source).sort());
    for (const name of Object.keys(source)) {
      if (['notifications', 'intents', 'sqlite_sequence', 'meta'].includes(name)) continue;
      expect(restored[name], name).toEqual(source[name]);
    }
    const events = `SELECT id, kind, watch_id, change_id, policy, created_at, evidence_only, before_evidence, after_evidence FROM notifications ORDER BY id`;
    expect(await sql('b', events)).toEqual(await sql('a', events));
    const requests = `SELECT intent_id, kind, day, events, created_at, recorded_at FROM intents ORDER BY intent_id`;
    expect(await sql('b', requests)).toEqual(await sql('a', requests));
    expect(await sql('b', `SELECT count(*) AS n FROM notifications WHERE delivered_at IS NULL`)).toEqual([{ n: 0 }]);
    expect(await sql('b', `SELECT intent_id, state, last_code FROM intents WHERE state != 'recorded'`)).toEqual([{ intent_id: 'urgent-x', state: 'superseded', last_code: 'restored' }]);
    const [head] = (await sql('a', `SELECT seq FROM sqlite_sequence WHERE name = 'notifications'`)) as { seq: number }[];
    expect(await sql('b', `SELECT seq FROM sqlite_sequence WHERE name = 'notifications'`)).toEqual([{ seq: (head?.seq ?? 0) + RESTORE_SEQUENCE_GAP }]);
    expect(await sql('b', `SELECT value FROM meta WHERE key = 'watch_events_floor'`)).toEqual([{ value: String((head?.seq ?? 0) + RESTORE_SEQUENCE_GAP) }]);
    expect(await sql('b', `SELECT seq FROM sqlite_sequence WHERE name = 'snapshots'`)).toEqual(await sql('a', `SELECT seq FROM sqlite_sequence WHERE name = 'snapshots'`));
    const strip = (rows: string[] | undefined) => (rows ?? []).filter((row) => !/"key":"'(watch_events_floor)'"/.test(row));
    expect(strip(restored.meta)).toEqual(strip(source.meta));
    // The next backup knows every evidence copy: none is copied again.
    expect(await sql('b', `SELECT count(*) AS n FROM backup_evidence`)).toEqual([{ n: manifest.evidence.objects.length }]);
    // Once done, a repeat is refused (the store is not empty), and the restore stays as it was.
    expect(await call('b', 'restore_start', '', T + 41 * DAY)).toBe('STORE_NOT_EMPTY');
  });

  it('a part failing its SHA-256 fails the restore after three tries; a repeated restore starts again', async () => {
    const key = (await json<{ key: string }>(LATEST)).key;
    const manifest = await json<Manifest>(`${key}manifest.json`);
    // A copy of the backup with one part changed after it was written.
    const copy = 'backups/2026-12-31T000000Z/';
    for (const table of manifest.tables)
      for (const part of table.parts) {
        const data = new Uint8Array(await ((await backups.get(part.key)) as R2ObjectBody).arrayBuffer());
        if (table.name === 'watches') data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 1;
        await backups.put(part.key.replace(key, copy), data);
        part.key = part.key.replace(key, copy);
      }
    await backups.put(`${copy}manifest.json`, JSON.stringify(manifest));
    expect(await call('c', 'restore_start', copy, T + 50 * DAY)).toBe('started');
    await restoreAll('c', T + 50 * DAY);
    const failed = (await state('c')).restore;
    expect(failed?.state).toBe('failed');
    expect(failed?.error_code).toBe('part_mismatch');
    // Writes stay refused until a restore succeeds (state.ts reads restoreBlocking); repeating with the good backup works.
    expect(await sql('c', `SELECT count(*) AS n FROM watches`)).toEqual([{ n: 0 }]);
    expect(await call('c', 'restore_start', key, T + 51 * DAY)).toBe('started');
    await restoreAll('c', T + 51 * DAY);
    expect((await state('c')).restore?.state).toBe('succeeded');
    const restored = await tables('c');
    expect(restored.changes).toEqual((await tables('a')).changes);
  });
});

describe('the R2 calls of a step, a repeated last step and a newer backup', () => {
  /** 2027-01-06T11:23:00Z: after every backup above. */
  const LATER = T + 70 * DAY;
  type Calls = { get: number; head: number; put: number };

  it('reads at most EVIDENCE_COPIES evidence objects a step, a lost one too', async () => {
    const present = await seed('m', { evidence: 210 });
    // Objects the evidence bucket lost: each costs a GET as well.
    for (let i = 0; i < 45; i++) await sql('m', `INSERT INTO evidence_snapshots VALUES (?, 'w1', 1, 'sha', ?, '', 1)`, `lost${String(i).padStart(12, '0')}`, `captures/lost/${String(i)}.json`);
    await call('m', 'evidence_calls');
    let at = LATER;
    let evidenceSteps = 0;
    for (let steps = 0; steps < 50; steps++) {
      const phase = (await state('m')).backup?.job?.phase ?? 'tables';
      const step = await call<{ ran: boolean; next: number }>('m', 'backup', at);
      const calls = await call<Calls>('m', 'evidence_calls');
      expect(calls.get, `step ${String(steps)}`).toBeLessThanOrEqual(EVIDENCE_COPIES);
      if (phase === 'evidence') evidenceSteps += 1;
      if ((await state('m')).backup?.job == null) break;
      at = step.next;
    }
    expect((await state('m')).backup?.status).toBe('ok');
    expect(evidenceSteps).toBe(Math.ceil((present.length + 45) / EVIDENCE_COPIES));
    const manifest = await json<Manifest>(`${(await json<{ key: string }>(LATEST)).key}manifest.json`);
    expect(manifest.evidence.objects.map((object) => object.key)).toEqual(present);
    expect(manifest.evidence.missing).toHaveLength(45);
  });

  it('a restore looks at most RESTORE_EVIDENCE_LOOKS evidence objects a step, all of them present', async () => {
    const manifest = await json<Manifest>(`${(await json<{ key: string }>(LATEST)).key}manifest.json`);
    expect(manifest.evidence.objects.length).toBeGreaterThan(RESTORE_EVIDENCE_LOOKS);
    expect(await call('n', 'restore_start', '', LATER + DAY / 2)).toBe('started');
    await call('n', 'evidence_calls');
    let at = LATER + DAY / 2;
    let evidenceSteps = 0;
    for (let steps = 0; steps < 50 && (await state('n')).restore?.state === 'running'; steps++) {
      at = (await call<number | null>('n', 'restore', at)) ?? at;
      const calls = await call<Calls>('n', 'evidence_calls');
      expect(calls.head, `step ${String(steps)}`).toBeLessThanOrEqual(RESTORE_EVIDENCE_LOOKS);
      if (calls.head > 0) evidenceSteps += 1;
    }
    const { restore } = await state('n');
    expect(restore?.state).toBe('succeeded');
    expect(evidenceSteps).toBe(Math.ceil(manifest.evidence.objects.length / RESTORE_EVIDENCE_LOOKS));
    expect(restore?.evidence).toEqual({ restored: 0, present: manifest.evidence.objects.length, missing: 45, mismatched: 0 });
  });

  it('the restored store backs itself up at its next alarm', async () => {
    expect((await state('n')).backup?.next_run ?? 0).toBe(0);
    await call('n', 'calls');
    await backupAll('n', LATER + DAY / 2 + 60_000);
    expect((await state('n')).backup?.status).toBe('ok');
    // Every evidence copy came with the restore: the job PUT only its parts, the manifest and latest.json.
    const manifest = await json<Manifest>(`${(await json<{ key: string }>(LATEST)).key}manifest.json`);
    expect((await call<{ put: number }>('n', 'calls')).put).toBe(manifest.tables.reduce((sum, table) => sum + table.parts.length, 0) + 2);
  });

  it('a repeated last step writes latest.json, never the complete manifest again', async () => {
    let at = LATER + DAY;
    for (let steps = 0; steps < 50 && (await state('m')).backup?.job?.phase !== 'finish'; steps++) at = (await call<{ next: number }>('m', 'backup', at)).next;
    const prefix = (await state('m')).backup?.job?.prefix ?? '';
    await call('m', 'fail', { putKey: LATEST });
    at = (await call<{ next: number }>('m', 'backup', at)).next;
    const written = await backups.head(`${prefix}manifest.json`);
    expect(written).not.toBeNull();
    expect((await state('m')).backup?.job?.errors).toBe(1);
    await call('m', 'fail', {});
    await call('m', 'backup', at);
    expect((await state('m')).backup?.status).toBe('ok');
    expect((await json<{ key: string }>(LATEST)).key).toBe(prefix);
    expect((await backups.head(`${prefix}manifest.json`))?.version).toBe(written?.version);
  });

  it('retention keeps a newer backup and the evidence copies it names', async () => {
    const current = (await json<{ key: string }>(LATEST)).key;
    const newer = 'backups/2099-01-01T000000Z/';
    const key = 'images/0000000000000000000000000000000000000000000000000000000000000000.jpg';
    const manifest = { ...(await json<Manifest>(`${current}manifest.json`)) };
    manifest.evidence = { root: 'evidence/', objects: [{ key, sha256: sha256(JPEG), bytes: JPEG.byteLength }], missing: [] };
    await backups.put(`${newer}manifest.json`, JSON.stringify(manifest));
    await backups.put(`evidence/${key}`, JPEG);
    // This store copied it once too, and none of its own backups names it.
    await sql('m', `INSERT INTO backup_evidence VALUES (?, ?, ?)`, key, sha256(JPEG), JPEG.byteLength);
    await call('m', 'retention', current);
    expect(await backups.head(`evidence/${key}`)).not.toBeNull();
    expect(await backups.head(`${newer}manifest.json`)).not.toBeNull();
    await backups.delete([`${newer}manifest.json`, `evidence/${key}`]);
  });
});
