// tools/backup-restore.ts on synthetic backups in the Worker's format (gzip NDJSON parts and a manifest), through a
// stand-in for `wrangler r2 object get/put` over a directory: download and its checks, verify, the SQLite load with
// exact values, and upload. The real backup, its wrangler download and the restore inside MailsortState run in
// mailsort/worker/test/runtime/backup.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { FORMAT, RestoreError, readBackup } from '../backup-restore.ts';

// CLI children keep their minimal environment and use the pinned interpreter directly.
const NODE_EXECUTABLE = process.env.JS_BINARY__NODE_BINARY ?? process.execPath

const TOOL = fileURLToPath(new URL('../backup-restore.ts', import.meta.url));
const BACKUP = 'backups/2026-10-28T114100Z/';
const BLOB = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

/** A stand-in for wrangler's `r2 object get|put <bucket>/<key> --file <path>` over `<root>/<bucket>/<key>`. */
const FAKE_WRANGLER = `
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [root, , , verb, target, , file] = process.argv.slice(2);
const path = join(root, target);
appendFileSync(join(root, 'log'), verb + ' ' + target + '\\n');
if (verb === 'get') {
  if (!existsSync(path)) process.exit(1);
  copyFileSync(path, file);
} else {
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(file, path);
}
`;

function part(table, index, rows) {
  const data = gzipSync(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return { data, entry: { key: `${BACKUP}${table}/${String(index).padStart(5, '0')}.ndjson.gz`, rows: rows.length, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') } };
}

/** A synthetic backup: meta, a rowid table with a blob and odd reals over two parts, and a WITHOUT ROWID table. */
function backup() {
  const meta = [part('meta', 1, [[1, 'schema_version', '12'], [2, 'settings', '{"mode":"live"}']])];
  const examples = [
    part('examples', 1, [[1, 'ex1', 'p2', '合成摘要 "quoted" it\'s\nline', { blob: BLOB.toString('base64') }, 0.30000000000000004]]),
    part('examples', 2, [[7, 'ex2', 'p4', '', null, { real: '-Infinity' }]]),
  ];
  const flow = [part('flow', 1, [['2026-10-01', 'claude', 'applied', 'p2', 9007199254740991], ['2026-10-02', 'claude', 'applied', '', -1]])];
  const parts = [...meta, ...examples, ...flow];
  const manifest = {
    format: FORMAT,
    object: 'mailsort-v1',
    started_at: '2026-10-28T11:41:00Z',
    created_at: '2026-10-28T11:41:03Z',
    schema_version: 12,
    tables: [
      { name: 'meta', sql: 'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)', indexes: [], columns: ['rowid', 'key', 'value'], key: ['rowid'], rows: 2, bytes: 0, parts: meta.map((p) => p.entry) },
      {
        name: 'examples',
        sql: 'CREATE TABLE examples (id TEXT PRIMARY KEY, label_id TEXT NOT NULL, summary TEXT NOT NULL, embedding BLOB, score REAL)',
        indexes: ['CREATE INDEX examples_label ON examples (label_id, id)'],
        columns: ['rowid', 'id', 'label_id', 'summary', 'embedding', 'score'],
        key: ['rowid'],
        rows: 2,
        bytes: 0,
        parts: examples.map((p) => p.entry),
      },
      {
        name: 'flow',
        sql: 'CREATE TABLE flow (\n    day TEXT NOT NULL, stage TEXT NOT NULL, outcome TEXT NOT NULL, label TEXT NOT NULL DEFAULT \'\', n INTEGER NOT NULL DEFAULT 0,\n    PRIMARY KEY (day, stage, outcome, label)\n  ) WITHOUT ROWID',
        indexes: [],
        columns: ['day', 'stage', 'outcome', 'label', 'n'],
        key: ['day', 'stage', 'outcome', 'label'],
        rows: 2,
        bytes: 0,
        parts: flow.map((p) => p.entry),
      },
    ],
  };
  return { manifest, parts };
}

/** A bucket directory holding the backup and latest.json, the fake wrangler and a work directory. */
function setup(change = (manifest, parts) => ({ manifest, parts })) {
  const root = mkdtempSync(join(tmpdir(), 'mailsort-tool-'));
  const bucket = join(root, 'r2');
  const { manifest, parts } = change(...Object.values(backup()));
  for (const { entry, data } of parts) {
    mkdirSync(dirname(join(bucket, 'mailsort-backups', entry.key)), { recursive: true });
    writeFileSync(join(bucket, 'mailsort-backups', entry.key), data);
  }
  writeFileSync(join(bucket, 'mailsort-backups', `${BACKUP}manifest.json`), JSON.stringify(manifest));
  writeFileSync(join(bucket, 'mailsort-backups', 'latest.json'), JSON.stringify({ key: BACKUP }));
  const fake = join(root, 'fake-wrangler.mjs');
  writeFileSync(fake, FAKE_WRANGLER);
  const tool = (...args) => spawnSync(NODE_EXECUTABLE, ['--preserve-symlinks-main', TOOL, ...args, '--wrangler', `node ${fake} ${bucket}`], { encoding: 'utf8' });
  return { root, bucket, tool, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('download fetches the newest backup owner-only and checks every part; verify and sqlite agree', () => {
  const { root, tool, cleanup } = setup();
  try {
    const out = join(root, 'restore');
    const downloaded = tool('download', '--out', out, '--local');
    assert.equal(downloaded.status, 0, downloaded.stderr);
    assert.equal(downloaded.stdout, `backup ${BACKUP}\nPASS meta rows=2 parts=1\nPASS examples rows=2 parts=2\nPASS flow rows=2 parts=1\ndownload PASS\n`);
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(statSync(join(out, 'manifest.json')).mode & 0o777, 0o600);
    assert.equal(tool('verify', '--in', out).status, 0);
    const named = tool('download', '--out', join(root, 'named'), '--backup', BACKUP.slice(0, -1), '--local');
    assert.equal(named.status, 0, named.stderr);

    const file = join(root, 'mailsort.sqlite');
    const loaded = tool('sqlite', '--in', out, '--out', file);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.match(loaded.stdout, /PASS meta rows=2\/2\nPASS examples rows=2\/2\nPASS flow rows=2\/2\nsqlite PASS\n$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const db = new DatabaseSync(file);
    // Every value as stored: the rowid, the blob's bytes, a real's last digit, an infinity and a 2^53 - 1 integer.
    assert.deepEqual(db.prepare('SELECT rowid, id, summary, typeof(embedding) AS t, hex(embedding) AS hex, score FROM examples ORDER BY rowid').all().map((row) => ({ ...row })), [
      { rowid: 1, id: 'ex1', summary: '合成摘要 "quoted" it\'s\nline', t: 'blob', hex: BLOB.toString('hex').toUpperCase(), score: 0.30000000000000004 },
      { rowid: 7, id: 'ex2', summary: '', t: 'null', hex: '', score: -Infinity },
    ]);
    assert.deepEqual(db.prepare('SELECT n FROM flow ORDER BY day').all().map((row) => row.n), [9007199254740991, -1]);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all().map((row) => row.name), ['examples_label']);
    db.close();
    assert.equal(tool('sqlite', '--in', out, '--out', file).status, 1);
  } finally {
    cleanup();
  }
});

test('a part whose SHA-256, rows or key differ from the manifest, or a manifest of another format, fails the download', () => {
  const cases = [
    ['SHA-256 differs from the manifest', (manifest, parts) => ({ manifest, parts: parts.map((p, i) => (i === 1 ? { ...p, data: Buffer.concat([p.data, Buffer.from([0])]) } : p)) })],
    ['rows, manifest says', (manifest, parts) => {
      manifest.tables[2].parts[0].rows = 3;
      manifest.tables[2].rows = 3;
      return { manifest, parts };
    }],
    ['a part key leaves the backup', (manifest, parts) => {
      manifest.tables[0].parts[0].key = `${BACKUP}../meta/00001.ndjson.gz`;
      return { manifest, parts };
    }],
    ['format is not', (manifest, parts) => ({ manifest: { ...manifest, format: 'tasks-d1-backup-v1' }, parts })],
    ['an unexpected schema statement', (manifest, parts) => {
      manifest.tables[1].indexes = ['CREATE INDEX x ON examples (id); DROP TABLE meta'];
      return { manifest, parts };
    }],
  ];
  for (const [message, change] of cases) {
    const { root, tool, cleanup } = setup(change);
    try {
      const result = tool('download', '--out', join(root, 'restore'), '--local');
      assert.equal(result.status, 1, message);
      assert.match(result.stderr, new RegExp(message.replace(/[()]/g, '\\$&')), message);
    } finally {
      cleanup();
    }
  }
});

test('readBackup refuses a part that is missing from a download', () => {
  const { root, tool, cleanup } = setup();
  try {
    const out = join(root, 'restore');
    assert.equal(tool('download', '--out', out, '--local').status, 0);
    rmSync(join(out, 'parts', `${BACKUP}flow/00001.ndjson.gz`));
    assert.throws(() => readBackup(out), (error) => error instanceof RestoreError && /flow\/00001\.ndjson\.gz: missing/.test(error.message));
  } finally {
    cleanup();
  }
});

test('upload puts the parts, then the manifest, and refuses a prefix that holds a manifest', () => {
  const { root, bucket, tool, cleanup } = setup();
  try {
    const out = join(root, 'restore');
    assert.equal(tool('download', '--out', out, '--local').status, 0);
    rmSync(join(bucket, 'log'));
    const uploaded = tool('upload', '--in', out, '--bucket', 'mailsort-restore', '--local');
    assert.equal(uploaded.status, 0, uploaded.stderr);
    const log = readFileSync(join(bucket, 'log'), 'utf8').trim().split('\n');
    assert.equal(log[0], `get mailsort-restore/${BACKUP}manifest.json`);
    assert.equal(log.at(-1), `put mailsort-restore/${BACKUP}manifest.json`);
    assert.equal(log.filter((line) => line.startsWith('put ')).length, 5);
    for (const name of ['meta/00001', 'examples/00001', 'examples/00002', 'flow/00001']) assert.ok(existsSync(join(bucket, 'mailsort-restore', `${BACKUP}${name}.ndjson.gz`)));
    const again = tool('upload', '--in', out, '--bucket', 'mailsort-restore', '--local');
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already holds/);
  } finally {
    cleanup();
  }
});

test('a download directory inside the repository is refused', () => {
  const { tool, cleanup } = setup();
  try {
    const inside = fileURLToPath(new URL('../../.restore-test', import.meta.url));
    const result = tool('download', '--out', inside, '--local');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /inside the repository/);
    assert.equal(existsSync(inside), false);
  } finally {
    cleanup();
  }
});
