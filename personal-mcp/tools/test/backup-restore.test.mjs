// tools/backup-restore.ts on a synthetic backup laid out as worker/src/backup.ts writes it, through a stand-in for
// `wrangler r2 object get|put` (a bucket is a directory of objects by key). The real backup, download, upload and restore
// run in worker/test/runtime/restore.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { FORMAT, readBackup } from '../backup-restore.ts';

const TOOL = fileURLToPath(new URL('../backup-restore.ts', import.meta.url));
const BACKUP = 'backups/2026-10-28T052300Z/';
const BUCKET = 'personal-mcp-backups';

/** A backup in `root` (manifest.json and parts/<key>): two tables, one in two parts, and the KV keys. */
function made(root) {
  const part = (key, rows) => {
    const data = gzipSync(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    mkdirSync(dirname(join(root, 'parts', key)), { recursive: true });
    writeFileSync(join(root, 'parts', key), data);
    return { key, rows: rows.length, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  };
  const work = [part(`${BACKUP}tables/work/00001.ndjson.gz`, [[1, 'w1', 'Synthetic “work” it\'s 汉字\n']]),
    part(`${BACKUP}tables/work/00002.ndjson.gz`, [[2, 'w2', null]])];
  const links = [part(`${BACKUP}tables/work_links/00001.ndjson.gz`, [[1, 'w1', { blob: 'AAH/' }]])];
  const kv = [part(`${BACKUP}kv/00001.ndjson.gz`, [['last_tool_at', 1793000000000], ['last_subscription_request', { phase: 'accepted' }]])];
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    format: FORMAT, started_at: '2026-10-28T05:23:00Z', created_at: '2026-10-28T05:23:02Z', schema_version: 1,
    tables: [
      { name: 'work', sql: 'CREATE TABLE work (id TEXT, title TEXT)', columns: ['rowid', 'id', 'title'], max_rowid: 2, rows: 2, bytes: 0, parts: work },
      { name: 'work_links', sql: 'CREATE TABLE work_links (work_id TEXT, payload TEXT)', columns: ['rowid', 'work_id', 'payload'], max_rowid: 1, rows: 1, bytes: 0, parts: links },
    ],
    kv: { rows: 2, bytes: 0, parts: kv },
    excluded: { tables: ['delivery_totals'], kv: ['backup', 'restore'] },
  }));
  return { work, links, kv };
}

/** A temporary place with a backup in `source/`, an empty bucket store and the wrangler stand-in. */
function place(latest = true) {
  const root = mkdtempSync(join(tmpdir(), 'personal-mcp-restore-tool-'));
  const source = join(root, 'source');
  mkdirSync(source);
  const parts = made(source);
  const store = join(root, 'store');
  const put = (key, data) => {
    mkdirSync(dirname(join(store, BUCKET, key)), { recursive: true });
    writeFileSync(join(store, BUCKET, key), data);
  };
  const stub = join(root, 'wrangler.mjs');
  writeFileSync(stub, `import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.MCP_CALLS, JSON.stringify(args) + '\\n');
const object = process.env.MCP_BUCKET + '/' + args[3];
const file = args[args.indexOf('--file') + 1];
try {
  if (args[2] === 'get') copyFileSync(object, file);
  else { mkdirSync(dirname(object), { recursive: true }); copyFileSync(file, object); }
} catch { process.exit(1); }`);
  const run = (...args) => spawnSync('node', [TOOL, ...args, '--local', '--persist-to', '/unused', '--wrangler', `node ${stub}`], {
    encoding: 'utf8', env: { ...process.env, MCP_BUCKET: store, MCP_CALLS: join(root, 'calls.jsonl') },
  });
  const calls = () => existsSync(join(root, 'calls.jsonl'))
    ? readFileSync(join(root, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const fill = () => {
    put(`${BACKUP}manifest.json`, readFileSync(join(source, 'manifest.json')));
    for (const part of [...parts.work, ...parts.links, ...parts.kv]) put(part.key, readFileSync(join(source, 'parts', part.key)));
    if (latest) put('latest.json', JSON.stringify({ key: BACKUP }));
  };
  return { root, source, store, parts, run, calls, fill, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('verify reads every part against the manifest and counts each table and the KV keys', () => {
  const p = place();
  try {
    const backup = readBackup(p.source);
    assert.equal(backup.prefix, BACKUP);
    assert.deepEqual(backup.families.map((family) => [family.name, family.rows, family.parts.length]),
      [['work', 2, 2], ['work_links', 1, 1], ['kv', 2, 1]]);
    const verified = spawnSync('node', [TOOL, 'verify', '--in', p.source], { encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(verified.stdout, `backup ${BACKUP} schema_version=1 created_at=2026-10-28T05:23:02Z\n` +
      'PASS work rows=2\nPASS work_links rows=1\nPASS kv rows=2\nverify PASS\n');
    assert.doesNotMatch(verified.stdout, /Synthetic|last_tool_at/);
  } finally {
    p.cleanup();
  }
});

test('verify refuses a changed part, a wrong row count or width, and another format', () => {
  const p = place();
  try {
    const manifest = JSON.parse(readFileSync(join(p.source, 'manifest.json'), 'utf8'));
    const write = (value) => writeFileSync(join(p.source, 'manifest.json'), JSON.stringify(value));
    write({ ...manifest, format: 'other-backup-v1' });
    assert.throws(() => readBackup(p.source), /format is not personal-mcp-backup-v1/);
    write({ ...manifest, tables: [{ ...manifest.tables[0], rows: 3 }, manifest.tables[1]] });
    assert.throws(() => readBackup(p.source), /work: parts hold 2 rows, manifest says 3/);
    write({ ...manifest, tables: [{ ...manifest.tables[0], columns: ['rowid', 'id'] }, manifest.tables[1]] });
    assert.throws(() => readBackup(p.source), /a row does not match the manifest's columns/);
    write(manifest);
    const file = join(p.source, 'parts', p.parts.links[0].key);
    const data = readFileSync(file);
    data[data.length >> 1] ^= 1;
    writeFileSync(file, data);
    const failed = spawnSync('node', [TOOL, 'verify', '--in', p.source], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /work_links\/00001\.ndjson\.gz: SHA-256 differs from the manifest/);
  } finally {
    p.cleanup();
  }
});

test('download fetches the newest backup, checks every part and writes owner-only files', () => {
  const p = place();
  try {
    p.fill();
    const out = join(p.root, 'restore');
    const downloaded = p.run('download', '--out', out);
    assert.equal(downloaded.status, 0, downloaded.stderr);
    assert.equal(downloaded.stdout, `backup ${BACKUP}\nPASS work rows=2 parts=2\nPASS work_links rows=1 parts=1\nPASS kv rows=2 parts=1\ndownload PASS\n`);
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(statSync(join(out, 'manifest.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(out, 'parts', p.parts.kv[0].key)).mode & 0o777, 0o600);
    const calls = p.calls();
    assert.deepEqual(calls.map((call) => call.slice(0, 4)), [
      ['r2', 'object', 'get', `${BUCKET}/latest.json`], ['r2', 'object', 'get', `${BUCKET}/${BACKUP}manifest.json`],
      ...[...p.parts.work, ...p.parts.links, ...p.parts.kv].map((part) => ['r2', 'object', 'get', `${BUCKET}/${part.key}`]),
    ]);
    assert.ok(calls.every((call) => call.slice(-3).join(' ') === '--local --persist-to /unused'));
    assert.deepEqual(readBackup(out).families, readBackup(p.source).families);
  } finally {
    p.cleanup();
  }
});

test('download takes a named backup, and refuses a damaged one, a missing latest.json and the repository', () => {
  const p = place(false);
  try {
    p.fill();
    const named = p.run('download', '--out', join(p.root, 'named'), '--backup', BACKUP.slice(0, -1));
    assert.equal(named.status, 0, named.stderr);
    assert.equal(p.calls()[0][3], `${BUCKET}/${BACKUP}manifest.json`);
    const missing = p.run('download', '--out', join(p.root, 'missing'));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /wrangler r2 object get failed: latest\.json/);
    const stored = join(p.store, BUCKET, p.parts.work[1].key);
    const data = readFileSync(stored);
    data[data.length >> 1] ^= 1;
    writeFileSync(stored, data);
    const damaged = p.run('download', '--out', join(p.root, 'damaged'), '--backup', BACKUP);
    assert.equal(damaged.status, 1);
    assert.match(damaged.stderr, /work\/00002\.ndjson\.gz: SHA-256 differs from the manifest/);
    const inside = p.run('download', '--out', fileURLToPath(new URL('../do-not-create', import.meta.url)), '--backup', BACKUP);
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /inside the repository/);
    assert.equal(existsSync(fileURLToPath(new URL('../do-not-create', import.meta.url))), false);
    const odd = p.run('download', '--out', join(p.root, 'odd'), '--backup', '../escape');
    assert.equal(odd.status, 1);
    assert.match(odd.stderr, /not a prefix like backups\//);
    const manifest = JSON.parse(readFileSync(join(p.source, 'manifest.json'), 'utf8'));
    manifest.tables[0].parts[0].key = 'backups/2020-01-05T052300Z/tables/work/00001.ndjson.gz';
    writeFileSync(join(p.store, BUCKET, BACKUP, 'manifest.json'), JSON.stringify(manifest));
    const outside = p.run('download', '--out', join(p.root, 'outside'), '--backup', BACKUP);
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /a part key leaves the backup/);
  } finally {
    p.cleanup();
  }
});

test('upload puts a checked backup into a bucket, parts first and the manifest last, and never rewrites one', () => {
  const p = place();
  try {
    const uploaded = p.run('upload', '--in', p.source);
    assert.equal(uploaded.status, 0, uploaded.stderr);
    assert.match(uploaded.stdout, /\nput 4 parts and the manifest into personal-mcp-backups\nupload PASS\n$/);
    const calls = p.calls();
    assert.deepEqual(calls[0].slice(0, 4), ['r2', 'object', 'get', `${BUCKET}/${BACKUP}manifest.json`]);
    const puts = calls.slice(1);
    assert.deepEqual(puts.map((call) => call[3]), [...[...p.parts.work, ...p.parts.links, ...p.parts.kv].map((part) => `${BUCKET}/${part.key}`),
      `${BUCKET}/${BACKUP}manifest.json`]);
    assert.ok(puts.every((call) => call[2] === 'put'));
    assert.deepEqual(puts.at(-1).slice(6, 8), ['--content-type', 'application/json']);
    for (const part of p.parts.work) assert.deepEqual(readFileSync(join(p.store, BUCKET, part.key)), readFileSync(join(p.source, 'parts', part.key)));
    assert.equal(existsSync(join(p.store, BUCKET, 'latest.json')), false);
    const again = p.run('upload', '--in', p.source);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already holds backups\/2026-10-28T052300Z\/ complete; it is not rewritten/);
    const other = p.run('upload', '--in', p.source, '--bucket', 'Not_A_Bucket');
    assert.equal(other.status, 1);
    assert.match(other.stderr, /--bucket is not a bucket name/);
  } finally {
    p.cleanup();
  }
});
