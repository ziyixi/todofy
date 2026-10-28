// tools/backup-restore.ts on synthetic backups: a manifest, gzip NDJSON parts and evidence copies laid out the way
// worker/src/backup.ts writes them, downloaded and uploaded through a stand-in for `wrangler r2 object get/put` over a
// directory. The real backup, wrangler and the restore inside WatchState run in
// worker/test/runtime/restore.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { RestoreError, verifyDownload } from '../backup-restore.ts';

const TOOL = fileURLToPath(new URL('../backup-restore.ts', import.meta.url));
const BACKUP = 'backups/2026-10-28T112300Z/';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// A stand-in for wrangler: `r2 object get|put <bucket>/<key> --file <path> ...` over $FAKE_R2/<bucket>/<key>.
const FAKE = join(mkdtempSync(join(tmpdir(), 'watch-fake-wrangler-')), 'wrangler.mjs');
writeFileSync(
  FAKE,
  `import { copyFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [, , r2, object, verb, path, flag, file, ...rest] = process.argv;
if (r2 !== 'r2' || object !== 'object' || flag !== '--file') process.exit(2);
appendFileSync(join(process.env.FAKE_R2, 'calls.log'), [verb, path, ...rest].join(' ') + '\\n');
const stored = join(process.env.FAKE_R2, path);
if (verb === 'get') copyFileSync(stored, file);
else { mkdirSync(dirname(stored), { recursive: true }); copyFileSync(file, stored); }
`,
);

/** A bucket directory holding one synthetic backup (and latest.json); returns its manifest. */
function bucket(root, { tamper = false } = {}) {
  const put = (key, data) => {
    mkdirSync(dirname(join(root, 'watch-backups', key)), { recursive: true });
    writeFileSync(join(root, 'watch-backups', key), data);
  };
  const table = (name, columns, rows) => {
    const data = gzipSync(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const key = `${BACKUP}${name}/00001.ndjson.gz`;
    put(key, tamper && name === 'watches' ? Buffer.concat([data, Buffer.from([0])]) : data);
    return { name, columns, rows: rows.length, bytes: data.length, parts: [{ key, rows: rows.length, bytes: data.length, sha256: sha256(data) }] };
  };
  const evidence = [
    ['captures/w1/000000000abcdefg.json', Buffer.from(JSON.stringify({ title: '合成页面', markdown: '# "quoted"\n新' }))],
    ['images/abc.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  ];
  for (const [key, data] of evidence) put(`evidence/${key}`, data);
  const manifest = {
    format: 'watch-backup-v1',
    started_at: '2026-10-28T11:23:00Z',
    created_at: '2026-10-28T11:23:04Z',
    schema_version: 6,
    tables: [
      table('watches', ['id', 'settings'], [['w1', '{"display_name":"合成"}'], ['w2', '{}']]),
      table('snapshots', ['id', 'body'], [[1, { base64: 'AAEC' }]]),
    ],
    evidence: { root: 'evidence/', objects: evidence.map(([key, data]) => ({ key, sha256: sha256(data), bytes: data.length })), missing: [] },
    excluded: { previews: 'a cache' },
  };
  put(`${BACKUP}manifest.json`, JSON.stringify(manifest));
  put('latest.json', JSON.stringify({ key: BACKUP }));
  return manifest;
}

function run(fakeRoot, ...args) {
  return spawnSync('node', [TOOL, ...args, '--wrangler', `node ${FAKE}`], { encoding: 'utf8', env: { ...process.env, FAKE_R2: fakeRoot } });
}

test('download fetches the newest backup and its evidence owner-only, and checks every SHA-256', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-tool-'));
  try {
    bucket(join(root, 'r2'));
    const out = join(root, 'restore');
    const result = run(join(root, 'r2'), 'download', '--out', out, '--local');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      `backup ${BACKUP}`,
      'PASS watches rows=2 parts=1',
      'PASS snapshots rows=1 parts=1',
      'PASS evidence objects=2 missing_in_backup=0',
      'download PASS',
    ]);
    assert.equal(statSync(join(out, 'manifest.json')).mode & 0o777, 0o600);
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(out, 'evidence/images/abc.jpg')).length, 4);
    const calls = readFileSync(join(root, 'r2', 'calls.log'), 'utf8');
    assert.match(calls, /^get watch-backups\/latest\.json --local$/m);
    assert.match(calls, /^get watch-backups\/evidence\/captures\/w1\/000000000abcdefg\.json --local$/m);
    // A named backup and another bucket.
    const named = run(join(root, 'r2'), 'download', '--out', join(root, 'named'), '--remote', '--backup', BACKUP.slice(0, -1));
    assert.equal(named.status, 0, named.stderr);
    assert.match(readFileSync(join(root, 'r2', 'calls.log'), 'utf8'), /^get watch-backups\/backups\/2026-10-28T112300Z\/manifest\.json --remote$/m);
    assert.notEqual(run(join(root, 'r2'), 'download', '--out', join(root, 'x'), '--backup', 'backups/../').status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify refuses a changed part, a changed evidence copy and a key that leaves the directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-tool-'));
  try {
    bucket(join(root, 'r2'), { tamper: true });
    const failed = run(join(root, 'r2'), 'download', '--out', join(root, 'restore'), '--local');
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /watches\/00001\.ndjson\.gz: SHA-256 differs from the manifest/);
    const clean = join(root, 'clean');
    bucket(clean);
    const download = run(clean, 'download', '--out', join(root, 'good'), '--local');
    assert.equal(download.status, 0, download.stderr);
    assert.equal(verifyDownload(join(root, 'good')).lines.length, 3);
    writeFileSync(join(root, 'good', 'evidence/images/abc.jpg'), Buffer.from([0]));
    assert.throws(() => verifyDownload(join(root, 'good')), (error) => error instanceof RestoreError && /evidence images\/abc\.jpg/.test(error.message));
    const manifest = JSON.parse(readFileSync(join(root, 'good', 'manifest.json'), 'utf8'));
    manifest.evidence.objects[0].key = '../outside.json';
    writeFileSync(join(root, 'good', 'manifest.json'), JSON.stringify(manifest));
    const outside = spawnSync('node', [TOOL, 'verify', '--in', join(root, 'good')], { encoding: 'utf8' });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /leaves the download directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('download refuses a directory inside the repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-tool-'));
  try {
    bucket(join(root, 'r2'));
    const inside = join(dirname(TOOL), 'restore-inside');
    const result = run(join(root, 'r2'), 'download', '--out', inside, '--local');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /inside the repository/);
    assert.equal(existsSync(inside), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upload puts the evidence and the parts, then the manifest, never latest.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-tool-'));
  try {
    bucket(join(root, 'r2'));
    assert.equal(run(join(root, 'r2'), 'download', '--out', join(root, 'restore'), '--local').status, 0);
    const target = join(root, 'target');
    mkdirSync(target);
    const result = run(target, 'upload', '--in', join(root, 'restore'), '--bucket', 'watch-backups-new', '--remote');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`uploaded ${BACKUP} to watch-backups-new`));
    const calls = readFileSync(join(target, 'calls.log'), 'utf8').trim().split('\n');
    assert.equal(calls.at(-1), `put watch-backups-new/${BACKUP}manifest.json --content-type application/json --remote`);
    assert.ok(calls[0]?.startsWith('put watch-backups-new/evidence/'));
    assert.ok(calls.some((line) => line === 'put watch-backups-new/evidence/images/abc.jpg --content-type image/jpeg --remote'));
    assert.equal(existsSync(join(target, 'watch-backups-new', 'latest.json')), false);
    assert.equal(run(target, 'upload', '--in', join(root, 'restore')).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
