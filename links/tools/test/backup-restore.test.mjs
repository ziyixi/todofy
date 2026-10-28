// tools/backup-restore.ts on node:sqlite: synthetic links exported the way the daily backup stores them (SQLite's own
// JSON arrays in gzip NDJSON parts, a manifest), downloaded through a stand-in for `wrangler r2 object get`, turned
// into SQL, loaded into a database with only the migrations applied and verified through a stand-in for `wrangler d1
// execute`. The real backup, download and wrangler commands run in worker/test/runtime/backup.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { RESTORE_ORDER, RestoreError, VERIFY_ROWS, readBackup, restoreConfig, restoreSql } from '../backup-restore.ts';

const TOOL = fileURLToPath(new URL('../backup-restore.ts', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const BACKUP = 'backups/2026-10-28T052500Z/';
const PRODUCTION = readFileSync(fileURLToPath(new URL('../../wrangler.toml', import.meta.url)), 'utf8');
const PRODUCTION_ID = /database_id = "([^"]+)"/.exec(PRODUCTION)[1];
const KEYS = { links: ['key'], link_revisions: ['key', 'revision'], request_log: ['request_id'] };

function migrated(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)');
  for (const name of FILES) {
    db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
    db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
  }
  return db;
}

/** Synthetic links: quotes, CJK, emoji, a newline and a NUL; deleted and expiring ones; more revisions than a page. */
function seed(db, revisions = 3) {
  const insert = db.prepare(`INSERT INTO links (key, target, path_mode, visibility, description, tags, expire_time,
    create_time, update_time, delete_time, purge_time, revision, revision_time, etag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const revision = db.prepare(`INSERT INTO link_revisions (key, revision, create_time, target, path_mode, visibility,
    description, tags, expire_time) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let n = 0; n < 400; n++) {
    const key = `k${String(n).padStart(4, '0')}`;
    const target = `https://example.com/p/${String(n)}?q="x"&r=\\`;
    const description = n === 1 ? 'nul\0inside' : `Synthetic it's “quoted” 汉字 🙂\nline ${String(n)}`;
    const deleted = n % 13 === 0 ? 3000 : null;
    insert.run(key, target, 'append', n % 2 ? 'public' : 'private', description, '["a","b"]', n % 11 ? null : 1800000000000,
      1000 + n, 2000 + n, deleted, deleted && 4000000000000, revisions, 2000 + n, `e${String(n)}`);
    for (let r = 1; r <= revisions; r++)
      revision.run(key, r, 1000 + r, `${target}/r${String(r)}`, 'append', 'private', description, '[]', null);
  }
  db.prepare("INSERT INTO request_log VALUES ('11111111-1111-4111-8111-111111111111','CreateLink','links/k0001',?,5)").run(
    '{"name":"links/k0001","note":"a \\"quoted\\" reply"}',
  );
}

function columns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

/** What the backup stores: SQLite's JSON array of each row in key order, two parts per table, and the manifest. */
function backupOf(db, root, { mark = { start: 1, end: 1 } } = {}) {
  const tables = RESTORE_ORDER.map((name) => {
    const names = columns(db, name);
    const rows = db
      .prepare(`SELECT json_array(${names.join(',')}) AS r FROM ${name} ORDER BY ${KEYS[name].join(',')}`)
      .all()
      .map((row) => row.r);
    const half = Math.ceil(rows.length / 2);
    const parts = [rows.slice(0, half), rows.slice(half)]
      .filter((part) => part.length)
      .map((lines, index) => {
        const data = gzipSync(lines.join('\n') + '\n');
        const key = `${BACKUP}${name}/${String(index + 1).padStart(5, '0')}.ndjson.gz`;
        mkdirSync(dirname(join(root, 'parts', key)), { recursive: true });
        writeFileSync(join(root, 'parts', key), data);
        return { key, rows: lines.length, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
      });
    return { name, columns: names, key: KEYS[name], rows: rows.length, bytes: 0, parts };
  });
  const at = (update_time) => ({ update_time, rows: { links: 400, link_revisions: 1200, request_log: 1 } });
  const links = { schema_version: FILES.at(-1), change_mark: { start: at(mark.start), end: at(mark.end) }, tables };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ format: 'links-backup-v1', links }));
}

function dump(db) {
  return Object.fromEntries(
    RESTORE_ORDER.map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY ${KEYS[name].join(',')}`).all()]),
  );
}

function withBackup(run, options) {
  const root = mkdtempSync(join(tmpdir(), 'links-restore-test-'));
  try {
    const source = migrated();
    seed(source);
    backupOf(source, root, options);
    return run(root, source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('every table of migrations/ is restored', () => {
  const tables = migrated()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'")
    .all()
    .map((row) => row.name);
  assert.deepEqual([...tables].sort(), [...RESTORE_ORDER].sort());
});

test('a backup round-trips row for row into an empty database, and a re-run changes nothing', () =>
  withBackup((root, source) => {
    const { sql, statements } = restoreSql(readBackup(root));
    assert.equal(statements, 400 + 1200 + 1);
    assert.ok(sql.includes("CAST(X'"), 'a NUL travels as a blob cast');
    const target = migrated();
    target.exec(sql);
    target.exec(sql);
    assert.deepEqual(dump(target), dump(source));
  }));

test('a part that differs from its manifest, or is missing, is refused', () =>
  withBackup((root) => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    const part = manifest.links.tables[0].parts[0];
    const path = join(root, 'parts', part.key);
    const data = readFileSync(path);
    data[data.length >> 1] ^= 1;
    writeFileSync(path, data);
    assert.throws(() => readBackup(root), /links\/00001\.ndjson\.gz: SHA-256 differs/);
    rmSync(path);
    assert.throws(() => readBackup(root), /links\/00001\.ndjson\.gz: missing/);
  }));

test('a manifest of another format, without its links section or with other tables, is refused', () =>
  withBackup((root) => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...manifest, format: 'tasks-d1-backup-v1' }));
    assert.throws(() => readBackup(root), /format is not links-backup-v1/);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ format: 'links-backup-v1' }));
    assert.throws(() => readBackup(root), /no links section/);
    const fewer = { ...manifest.links, tables: manifest.links.tables.slice(0, 2) };
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ format: 'links-backup-v1', links: fewer }));
    assert.throws(() => readBackup(root), (error) => error instanceof RestoreError && /unexpected tables/.test(error.message));
  }));

test('the config names only a new database, outside the repository, and never overwrites', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const config = restoreConfig('links-restore', id);
  assert.match(config, new RegExp(`database_id = "${id}"`));
  assert.match(config, /migrations_dir = "\/.*\/links\/migrations"/);
  assert.doesNotMatch(config, /^(name|main) =/m);
  assert.throws(() => restoreConfig('links', id), /production database/);
  assert.throws(() => restoreConfig('links-restore', PRODUCTION_ID), /production database/);
  assert.throws(() => restoreConfig('links-restore', 'not-a-uuid'), /not a D1 database id/);
  const directory = mkdtempSync(join(tmpdir(), 'links-restore-config-'));
  try {
    const out = join(directory, 'restore.toml');
    const run = (target) =>
      spawnSync('node', [TOOL, 'config', '--database-name', 'links-restore', '--database-id', id, '--out', target], {
        encoding: 'utf8',
      });
    assert.equal(run(out).status, 0);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.match(run(out).stderr, /exists or cannot be created; nothing was written/);
    const inside = run(fileURLToPath(new URL('../do-not-create.toml', import.meta.url)));
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /inside the repository/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The SQL loaded into a node:sqlite file, and `verify` against it through a stand-in for `wrangler d1 execute`. */
function loaded(root, sql) {
  const file = join(root, 'target.sqlite');
  const target = migrated(file);
  target.exec(readFileSync(sql, 'utf8'));
  target.close();
  const wrangler = join(root, 'wrangler.mjs');
  writeFileSync(
    wrangler,
    `import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const args = process.argv.slice(2);
appendFileSync(process.env.LINKS_CALLS, JSON.stringify(args) + '\\n');
const db = new DatabaseSync(process.env.LINKS_TARGET);
console.log(JSON.stringify([{ results: db.prepare(args[args.indexOf('--command') + 1]).all(), success: true }]));`,
  );
  const calls = join(root, 'calls.jsonl');
  const verify = () =>
    spawnSync('node', [TOOL, 'verify', '--in', root, '--config', 'unused.toml', '--local', '--wrangler', `node ${wrangler}`], {
      encoding: 'utf8',
      env: { ...process.env, LINKS_TARGET: file, LINKS_CALLS: calls },
    });
  return { file, verify, calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).length };
}

test('the CLI writes the SQL owner-only, warns about a moving snapshot, and verifies row for row', () =>
  withBackup(
    (root) => {
      const out = join(root, 'restore.sql');
      const written = execFileSync('node', [TOOL, 'sql', '--in', root, '--out', out], { encoding: 'utf8' });
      assert.equal(statSync(out).mode & 0o777, 0o600);
      assert.match(written, /^WARN the links changed while the backup ran/);
      assert.match(written, /PASS link_revisions rows=1200\nPASS request_log rows=1\nstatements=1601\nsql PASS\n$/);
      assert.doesNotMatch(written, /Synthetic|example\.com|汉字/);
      const { file, verify, calls } = loaded(root, out);
      const passed = verify();
      assert.equal(passed.status, 0, passed.stderr);
      assert.equal(
        passed.stdout,
        `PASS schema_version ${FILES.at(-1)}\nPASS links rows=400/400\nPASS link_revisions rows=1200/1200\nPASS request_log rows=1/1\nverify PASS\n`,
      );
      // The migrations, then each table in pages of VERIFY_ROWS until a short one.
      assert.equal(calls(), 1 + 1 + Math.floor(1200 / VERIFY_ROWS) + 1 + 1);
      const db = new DatabaseSync(file);
      db.exec("UPDATE link_revisions SET description = 'changed' WHERE key = 'k0300' AND revision = 2");
      db.exec("DELETE FROM request_log");
      const failed = verify();
      assert.equal(failed.status, 1);
      assert.match(failed.stdout, /PASS links rows=400\/400\nFAIL link_revisions rows=1200\/1200 differing=1\nFAIL request_log rows=0\/1\nverify FAIL\n$/);
      assert.doesNotMatch(failed.stdout, /changed|k0300/);
    },
    { mark: { start: 2399, end: 2400 } },
  ));

/**
 * `download` against a stand-in for `wrangler r2 object get`: the bucket is a directory of objects by key, and the
 * stand-in records each call.
 */
function bucketOf(made, latest = true) {
  const store = mkdtempSync(join(tmpdir(), 'links-restore-bucket-'));
  const put = (key, data) => {
    mkdirSync(dirname(join(store, 'links-backups', key)), { recursive: true });
    writeFileSync(join(store, 'links-backups', key), data);
  };
  const manifest = readFileSync(join(made, 'manifest.json'));
  put(`${BACKUP}manifest.json`, manifest);
  for (const table of JSON.parse(manifest.toString()).links.tables)
    for (const part of table.parts) put(part.key, readFileSync(join(made, 'parts', part.key)));
  if (latest) put('latest.json', JSON.stringify({ key: BACKUP }));
  const stub = join(store, 'wrangler.mjs');
  writeFileSync(
    stub,
    `import { appendFileSync, copyFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.LINKS_CALLS, JSON.stringify(args) + '\\n');
try { copyFileSync(process.env.LINKS_BUCKET + '/' + args[3], args[args.indexOf('--file') + 1]); }
catch { process.exit(1); }`,
  );
  return {
    store,
    download: (out, ...extra) =>
      spawnSync('node', [TOOL, 'download', '--out', out, '--local', '--persist-to', '/unused', '--wrangler', `node ${stub}`, ...extra], {
        encoding: 'utf8',
        env: { ...process.env, LINKS_BUCKET: store, LINKS_CALLS: join(store, 'calls.jsonl') },
      }),
    calls: () =>
      readFileSync(join(store, 'calls.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

test('download fetches the newest backup, or a named one, checks every part and keeps the files owner-only', () =>
  withBackup((made) => {
    const bucket = bucketOf(made);
    const out = join(bucket.store, 'restore');
    try {
      const newest = bucket.download(out);
      assert.equal(newest.status, 0, newest.stderr);
      assert.equal(
        newest.stdout,
        `backup ${BACKUP}\nPASS links rows=400 parts=2\nPASS link_revisions rows=1200 parts=2\nPASS request_log rows=1 parts=1\ndownload PASS\n`,
      );
      const keys = bucket.calls().map((args) => args[3]);
      assert.deepEqual(keys.slice(0, 2), ['links-backups/latest.json', `links-backups/${BACKUP}manifest.json`]);
      assert.equal(keys.length, 2 + 5);
      assert.ok(bucket.calls().every((args) => args.includes('--local') && args.includes('--persist-to')));
      assert.equal(statSync(join(out, 'manifest.json')).mode & 0o777, 0o600);
      assert.equal(statSync(out).mode & 0o777, 0o700);
      const named = bucket.download(join(bucket.store, 'named'), '--backup', BACKUP.slice(0, -1));
      assert.equal(named.status, 0, named.stderr);
      const wrong = bucket.download(join(bucket.store, 'wrong'), '--backup', 'backups/latest');
      assert.equal(wrong.status, 1);
      assert.match(wrong.stderr, /not a prefix like backups\//);
      const inside = bucket.download(fileURLToPath(new URL('../do-not-create', import.meta.url)));
      assert.equal(inside.status, 1);
      assert.match(inside.stderr, /inside the repository/);
    } finally {
      rmSync(bucket.store, { recursive: true, force: true });
    }
  }));

test('download refuses a part that differs from the manifest', () =>
  withBackup((made) => {
    const manifest = JSON.parse(readFileSync(join(made, 'manifest.json'), 'utf8'));
    manifest.links.tables[2].parts[0].sha256 = '0'.repeat(64);
    writeFileSync(join(made, 'manifest.json'), JSON.stringify(manifest));
    const bucket = bucketOf(made);
    try {
      const result = bucket.download(join(bucket.store, 'restore'));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /request_log\/00001\.ndjson\.gz: SHA-256 differs from the manifest/);
    } finally {
      rmSync(bucket.store, { recursive: true, force: true });
    }
  }));
