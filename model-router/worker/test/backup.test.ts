import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, onTestFinished } from 'vitest';
import { URL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  backupStep, bodyKey, newBackup, pageKey, BODIES_PER_STEP,
  type BackupEnv, type BackupComplete, type RequestRow,
} from '../src/backup.ts';
import { readMetadata, restoreSql, verifyFiles } from '../../tools/backup-restore.ts';

const SCHEMA = readFileSync(new URL('../../migrations/0001_router.sql', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-28T04:47:00Z');
const DAY = 86_400_000;

class Database {
  readonly sql = new DatabaseSync(':memory:');
  readonly queries: string[] = [];
  constructor() { this.sql.exec(SCHEMA); }
  prepare(query: string) {
    const sql = this.sql;
    const queries = this.queries;
    let values: (string | number | null)[] = [];
    return {
      bind(...bindings: (string | number | null)[]) { values = bindings; return this; },
      first() {
        queries.push(query);
        return Promise.resolve(sql.prepare(query).get(...values) ?? null);
      },
      all() {
        queries.push(query);
        return Promise.resolve({ results: sql.prepare(query).all(...values) });
      },
    };
  }
  insert(row: RequestRow) {
    const columns = Object.keys(row);
    this.sql.prepare(`INSERT INTO requests (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map((column) => row[column]!));
  }
}

interface Stored {
  bytes: Uint8Array;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
}
class Bucket {
  readonly objects = new Map<string, Stored>();
  gets: string[] = [];
  puts: string[] = [];
  failPut = '';
  seed(key: string, value: string, httpMetadata = { contentType: 'application/json' }) {
    this.objects.set(key, { bytes: new TextEncoder().encode(value), httpMetadata, customMetadata: {} });
  }
  get(key: string) {
    this.gets.push(key);
    const object = this.objects.get(key);
    if (!object) return Promise.resolve(null);
    return Promise.resolve({
      body: new Response(object.bytes).body,
      size: object.bytes.length,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      json() { return Promise.resolve(JSON.parse(new TextDecoder().decode(object.bytes)) as unknown); },
    });
  }
  async put(key: string, value: BodyInit, options: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> } = {}) {
    this.puts.push(key);
    if (key === this.failPut) throw new Error('synthetic_storage_failure');
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, httpMetadata: options.httpMetadata ?? {}, customMetadata: options.customMetadata ?? {} });
    return { key, size: bytes.length };
  }
}

function environment() {
  const db = new Database();
  const source = new Bucket();
  const backups = new Bucket();
  return { db, source, backups, env: { DB: db, REQUEST_BODIES: source, BACKUPS: backups } as unknown as BackupEnv };
}

function row(index: number, changes: Partial<RequestRow> = {}): RequestRow {
  const id = `synthetic-${index}`;
  return {
    id, app: 'newsletter', model: 'models/sol-6-1', state: 'succeeded',
    started_ms: NOW - 1000, completed_ms: NOW - 500,
    body_key: `requests/newsletter/${id}.json`, content_expire_ms: NOW + DAY,
    input_hash: `synthetic-hash-${index}`,
    generation_json: JSON.stringify({ output: '', usage: { input_tokens: index, available: true }, historical_value: "汉字 'quoted'\nkept" }),
    ...changes,
  };
}

async function finish(env: BackupEnv, initial = newBackup(NOW)) {
  let cursor = initial;
  for (let step = 0; step < 200; step += 1) {
    const before = structuredClone(cursor);
    const result = await backupStep(env, cursor, NOW + step);
    assert.deepEqual(cursor, before, 'the owner persists only a successfully returned cursor');
    if (result.finished) return result;
    assert.ok(result.next);
    cursor = result.next;
  }
  throw new Error('synthetic_backup_did_not_finish');
}

function marker(bucket: Bucket, prefix = newBackup(NOW).prefix): BackupComplete {
  return JSON.parse(new TextDecoder().decode(bucket.objects.get(`${prefix}complete.json`)!.bytes)) as BackupComplete;
}

function localCopy(bucket: Bucket, prefix: string) {
  const temporaryRoot = new URL('../.tmp/', import.meta.url);
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot.pathname, 'backup-'));
  for (const [key, value] of bucket.objects) {
    if (!key.startsWith(prefix)) continue;
    const path = join(directory, key.slice(prefix.length));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value.bytes);
  }
  return directory;
}

test('pages all completed log columns, fixes the initial row range, and copies at most ten bodies per tick', async () => {
  const { db, source, backups, env } = environment();
  onTestFinished(() => db.sql.close());
  for (let index = 0; index < 205; index += 1) {
    const saved = row(index, { content_expire_ms: index < 25 ? NOW + DAY : NOW - DAY });
    db.insert(saved);
    if (index < 25) source.seed(saved.body_key, JSON.stringify({ input: `Synthetic input ${index}`, output: '合成输出' }));
  }
  db.insert(row(999, { state: 'running', completed_ms: null }));
  let cursor = (await backupStep(env, newBackup(NOW), NOW)).next!;
  db.insert(row(1000)); // Started after the snapshot's max rowid was fixed.
  let done = false;
  for (let step = 0; step < 30; step += 1) {
    const gets = source.gets.length;
    const puts = backups.puts.length;
    const result = await backupStep(env, cursor, NOW + step);
    assert.ok(source.gets.length - gets <= BODIES_PER_STEP);
    assert.ok(backups.puts.length - puts <= BODIES_PER_STEP);
    if (result.finished) { done = true; break; }
    cursor = result.next!;
  }
  assert.ok(done);
  assert.deepEqual(marker(backups), {
    requests: 205, bodies: 25,
    body_bytes: [...source.objects.values()].reduce((sum, object) => sum + object.bytes.length, 0),
    started_ms: NOW, completed_ms: marker(backups).completed_ms, page_count: 3,
  });
  const restored = [0, 1, 2].flatMap((page) => new TextDecoder().decode(gunzipSync(backups.objects.get(pageKey(cursor.prefix, page))!.bytes))
    .trim().split('\n').map((line) => JSON.parse(line) as RequestRow));
  assert.equal(restored.length, 205);
  assert.deepEqual(restored[0], row(0));
  assert.equal(restored.some((saved) => saved.id === 'synthetic-999' || saved.id === 'synthetic-1000'), false);
  assert.ok(db.queries.every((query) => !query.includes('OFFSET')));
});

test('skips expired/unavailable bodies and never exports conversations or environment secrets', async () => {
  const { db, source, backups, env } = environment();
  onTestFinished(() => db.sql.close());
  const kept = row(1);
  db.insert(kept);
  db.insert(row(2, { content_expire_ms: NOW }));
  db.insert(row(3, { generation_json: '{"content_unavailable":true}' }));
  db.insert(row(4, { state: 'running', completed_ms: null }));
  // Wire JSON omits a false OUTPUT_ONLY boolean in the current owner projection.
  db.insert(row(5, { generation_json: '{"generation":{"name":"requests/synthetic-5"}}' }));
  source.seed(kept.body_key, '{"input":"Synthetic prompt","output":"Synthetic answer"}');
  source.seed('conversations/synthetic/config.json', '{"private":"excluded"}');
  const extras = { ...env, ANTHROPIC_API_KEY: 'synthetic-secret-must-stay-out' };
  await finish(extras);
  assert.equal(marker(backups).requests, 4);
  assert.equal(marker(backups).bodies, 1);
  assert.deepEqual(source.gets, [kept.body_key]);
  assert.equal([...backups.objects.keys()].some((key) => key.includes('conversations')), false);
  const metadata = new TextDecoder().decode(gunzipSync(backups.objects.get(pageKey(newBackup(NOW).prefix, 0))!.bytes));
  assert.equal(metadata.includes('synthetic-secret'), false);
  assert.equal(metadata.includes('_backup_rowid'), false);
  assert.deepEqual(backups.objects.get(bodyKey(newBackup(NOW).prefix, kept.body_key))!.bytes, source.objects.get(kept.body_key)!.bytes);
});

test('a failed body batch leaves no completion marker and repeats safely from the unchanged cursor', async () => {
  const { db, source, backups, env } = environment();
  onTestFinished(() => db.sql.close());
  for (let index = 0; index < 12; index += 1) {
    const saved = row(index);
    db.insert(saved);
    source.seed(saved.body_key, JSON.stringify({ output: index }));
  }
  const planned = (await backupStep(env, newBackup(NOW))).next!;
  const cursor = (await backupStep(env, planned)).next!;
  const before = structuredClone(cursor);
  backups.failPut = bodyKey(cursor.prefix, row(5).body_key);
  await assert.rejects(backupStep(env, cursor), /synthetic_storage_failure/);
  assert.deepEqual(cursor, before);
  assert.equal(backups.objects.has(`${cursor.prefix}complete.json`), false);
  backups.failPut = '';
  await finish(env, cursor);
  assert.equal(marker(backups).bodies, 12);
  assert.equal([...backups.objects.keys()].filter((key) => key.includes('/bodies/')).length, 12);
});

test('a missing retained body fails the copy instead of publishing a complete backup', async () => {
  const { db, backups, env } = environment();
  onTestFinished(() => db.sql.close());
  db.insert(row(1));
  await assert.rejects(finish(env), /backup_retained_body_missing/);
  assert.equal(backups.objects.has(`${newBackup(NOW).prefix}complete.json`), false);
});

test('an empty backup completes and a completed UTC day is never overwritten', async () => {
  const { db, backups, env } = environment();
  onTestFinished(() => db.sql.close());
  const result = await finish(env);
  assert.deepEqual(result.counts, { requests: 0, bodies: 0, body_bytes: 0 });
  const saved = structuredClone([...backups.objects]);
  const queryCount = db.queries.length;
  db.insert(row(1));
  assert.equal((await backupStep(env, newBackup(NOW + 1000))).finished, true);
  assert.equal(db.queries.length, queryCount);
  assert.deepEqual([...backups.objects], saved);
});

test('restores gzip pages and exact body files into empty resources without changing expiry or log values', async () => {
  const { db, source, backups, env } = environment();
  const target = new Database();
  const targetBodies = new Bucket();
  onTestFinished(() => { db.sql.close(); target.sql.close(); });
  for (let index = 0; index < 103; index += 1) {
    const saved = row(index, { state: index === 0 ? 'failed' : 'succeeded', content_expire_ms: index < 3 ? NOW + DAY : NOW - DAY });
    db.insert(saved);
    if (index < 3) source.seed(saved.body_key, JSON.stringify({ input: "Synthetic 'quoted' 汉字\ninput", output: String(index) }));
  }
  await finish(env);
  const directory = localCopy(backups, newBackup(NOW).prefix);
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const backup = readMetadata(directory);
  verifyFiles(backup, directory);
  target.sql.exec(restoreSql(backup));
  for (const key of backup.bodyKeys) await targetBodies.put(key, readFileSync(join(directory, 'bodies', key)));
  assert.equal(target.sql.prepare('SELECT count(*) AS n FROM requests').get()!.n, 103);
  assert.equal(targetBodies.objects.size, 3);
  assert.deepEqual(target.sql.prepare('SELECT * FROM requests ORDER BY rowid').all(), db.sql.prepare('SELECT * FROM requests ORDER BY rowid').all());
  for (const [key, original] of source.objects) assert.deepEqual(targetBodies.objects.get(key)!.bytes, original.bytes);
  assert.equal(target.sql.prepare('SELECT content_expire_ms FROM requests WHERE id = ?').get('synthetic-0')!.content_expire_ms, NOW + DAY);
});

test('restore refuses missing pages and mismatched completion counts or body bytes', async () => {
  const { db, source, backups, env } = environment();
  onTestFinished(() => db.sql.close());
  const saved = row(1);
  db.insert(saved);
  source.seed(saved.body_key, '{"output":"Synthetic"}');
  await finish(env);
  const directory = localCopy(backups, newBackup(NOW).prefix);
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const complete = marker(backups);
  writeFileSync(join(directory, 'complete.json'), JSON.stringify({ ...complete, requests: 2 }));
  assert.throws(() => readMetadata(directory), /backup_request_count_mismatch/);
  writeFileSync(join(directory, 'complete.json'), JSON.stringify({ ...complete, bodies: 0 }));
  assert.throws(() => readMetadata(directory), /backup_body_count_mismatch/);
  writeFileSync(join(directory, 'complete.json'), JSON.stringify(complete));
  const backup = readMetadata(directory);
  writeFileSync(join(directory, 'bodies', saved.body_key), 'truncated');
  assert.throws(() => verifyFiles(backup, directory), /backup_body_bytes_mismatch/);
  rmSync(join(directory, pageKey('', 0)));
  assert.throws(() => readMetadata(directory));
});
