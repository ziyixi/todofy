#!/usr/bin/env node
/**
 * Watch's daily backups (worker/src/backup.ts; docs/backup.md) on the owner's machine.
 *
 *   download  fetch a backup's manifest, its parts and the evidence copies it names from R2 with `wrangler r2 object
 *             get` into a private directory outside the repository, and check each against the manifest's SHA-256.
 *             By default the newest backup of `watch-backups` (its latest.json); `--backup backups/<job start>/` names
 *             one.
 *   verify    check a download again: every part's SHA-256, gzip, row count and width, every evidence copy's SHA-256
 *             and size. Prints the rows per table and the evidence count.
 *   upload    put a checked download into a bucket with `wrangler r2 object put`: the evidence copies, the parts, then
 *             the manifest (a prefix without it is incomplete), never latest.json. For a lost `watch-backups` (a new
 *             bucket bound as BACKUPS) or a local rehearsal; the restore itself runs inside WatchState (RestoreBackup)
 *             and names the backup.
 *
 *   node tools/backup-restore.ts download --out <outside>/restore --remote [--backup backups/<job start>/]
 *   node tools/backup-restore.ts verify --in <outside>/restore
 *   node tools/backup-restore.ts upload --in <outside>/restore --bucket <bucket> --remote
 *
 * A download directory holds manifest.json, parts/<part key> and evidence/<evidence key>. `--local --persist-to <dir>`
 * in place of `--remote` works on a local copy; `--bucket` reads another bucket. Files are written owner-only and their
 * contents are never printed. Node only, no dependencies.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = resolve(APP, 'worker/node_modules/.bin/wrangler');
export const FORMAT = 'watch-backup-v1';
export const BUCKET = 'watch-backups';
export const EVIDENCE_ROOT = 'evidence/';
const PREFIX = /^backups\/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\/$/;

export class RestoreError extends Error {}

interface Part {
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}
interface Table {
  name: string;
  columns: string[];
  rows: number;
  parts: Part[];
}
interface Evidence {
  key: string;
  sha256: string;
  bytes: number;
}
export interface Manifest {
  format: string;
  started_at: string;
  created_at: string;
  schema_version: number;
  tables: Table[];
  evidence: { root: string; objects: Evidence[]; missing: string[] };
}

/** A key that stays inside its directory: no absolute path, no `..`. */
function safeKey(key: unknown): key is string {
  return typeof key === 'string' && key !== '' && !key.startsWith('/') && !key.split('/').includes('..') && !key.includes('\\');
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** The manifest of a download, its shape checked (every key inside the backup's prefix or the evidence root). */
export function readManifest(root: string): Manifest {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    throw new RestoreError('manifest.json: missing or not JSON');
  }
  if (manifest.format !== FORMAT) throw new RestoreError(`manifest.json: format is not ${FORMAT}`);
  if (!Array.isArray(manifest.tables) || !Array.isArray(manifest.evidence?.objects) || !Array.isArray(manifest.evidence.missing))
    throw new RestoreError('manifest.json: no tables or evidence');
  for (const table of manifest.tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table.name) || !table.columns.every((column) => /^[a-z_][a-z0-9_]*$/.test(column)))
      throw new RestoreError('manifest.json: an invalid table or column name');
    for (const part of table.parts) if (!safeKey(part.key) || !part.key.startsWith('backups/')) throw new RestoreError('a part key leaves the backup');
  }
  for (const object of manifest.evidence.objects) if (!safeKey(object.key)) throw new RestoreError('an evidence key leaves the download directory');
  return manifest;
}

/** Every part and evidence copy of a download checked against the manifest; the lines it prints. */
export function verifyDownload(root: string): { manifest: Manifest; lines: string[] } {
  const manifest = readManifest(root);
  const lines: string[] = [];
  for (const table of manifest.tables) {
    let rows = 0;
    for (const part of table.parts) {
      let data: Buffer;
      try {
        data = readFileSync(resolve(root, 'parts', part.key));
      } catch {
        throw new RestoreError(`${part.key}: missing`);
      }
      if (sha256(data) !== part.sha256) throw new RestoreError(`${part.key}: SHA-256 differs from the manifest`);
      let parsed: unknown[];
      try {
        parsed = gunzipSync(data).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
      } catch {
        throw new RestoreError(`${part.key}: not a readable gzip NDJSON part`);
      }
      if (parsed.length !== part.rows) throw new RestoreError(`${part.key}: ${String(parsed.length)} rows, manifest says ${String(part.rows)}`);
      if (!parsed.every((row) => Array.isArray(row) && row.length === table.columns.length))
        throw new RestoreError(`${part.key}: a row does not match the manifest's columns`);
      rows += parsed.length;
    }
    if (rows !== table.rows) throw new RestoreError(`${table.name}: parts hold ${String(rows)} rows, manifest says ${String(table.rows)}`);
    lines.push(`PASS ${table.name} rows=${String(rows)} parts=${String(table.parts.length)}`);
  }
  for (const object of manifest.evidence.objects) {
    let data: Buffer;
    try {
      data = readFileSync(resolve(root, 'evidence', object.key));
    } catch {
      throw new RestoreError(`evidence ${object.key}: missing`);
    }
    if (data.byteLength !== object.bytes || sha256(data) !== object.sha256) throw new RestoreError(`evidence ${object.key}: SHA-256 differs from the manifest`);
  }
  lines.push(`PASS evidence objects=${String(manifest.evidence.objects.length)} missing_in_backup=${String(manifest.evidence.missing.length)}`);
  return { manifest, lines };
}

/** `wrangler` from `--wrangler` (a command line) or the Worker's own, and the target flags of `args`. */
function wranglerCommand(args: string[]) {
  const [command = WRANGLER, ...prefix] = (option(args, '--wrangler') ?? WRANGLER).split(/\s+/);
  const target = args.includes('--remote') ? ['--remote'] : ['--local'];
  const persist = option(args, '--persist-to');
  if (persist) target.push('--persist-to', persist);
  return { command, prefix, target };
}

function bucketOf(args: string[], fallback?: string): string {
  const bucket = option(args, '--bucket') ?? fallback;
  if (bucket === undefined || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new RestoreError('--bucket is not a bucket name');
  return bucket;
}

function wrangler(args: string[], command: string[], failure: string): void {
  const { command: program, prefix } = wranglerCommand(args);
  try {
    execFileSync(program, [...prefix, ...command], {
      cwd: APP,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new RestoreError(failure);
  }
}

/** The download directory: created owner-only, never inside the repository (it holds the owner's pages). */
function privateDirectory(path: string): string {
  const root = resolve(realpathSync(dirname(resolve(path))), basename(resolve(path)));
  const rel = relative(realpathSync(resolve(APP, '..')), root);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new RestoreError('the download directory is inside the repository');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/** The newest (latest.json) or the named backup into `root`, every file owner-only, then checked. */
function download(root: string, args: string[]): string[] {
  const bucket = bucketOf(args, BUCKET);
  const { target } = wranglerCommand(args);
  const get = (key: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    wrangler(args, ['r2', 'object', 'get', `${bucket}/${key}`, '--file', path, ...target], `wrangler r2 object get failed: ${key}`);
    chmodSync(path, 0o600);
  };
  let backup = option(args, '--backup');
  if (backup === undefined) {
    get('latest.json', resolve(root, 'latest.json'));
    backup = String((JSON.parse(readFileSync(resolve(root, 'latest.json'), 'utf8')) as { key?: unknown }).key);
  }
  backup = `${backup.replace(/\/+$/, '')}/`;
  if (!PREFIX.test(backup)) throw new RestoreError('the backup is not a prefix like backups/2026-10-28T112300Z/');
  get(`${backup}manifest.json`, resolve(root, 'manifest.json'));
  const manifest = readManifest(root);
  for (const table of manifest.tables)
    for (const part of table.parts) {
      if (!part.key.startsWith(backup)) throw new RestoreError('a part key leaves the backup');
      get(part.key, resolve(root, 'parts', part.key));
    }
  for (const object of manifest.evidence.objects) get(`${EVIDENCE_ROOT}${object.key}`, resolve(root, 'evidence', object.key));
  return [`backup ${backup}`, ...verifyDownload(root).lines];
}

/** A checked download into `--bucket`: evidence, parts, then the manifest. */
function upload(root: string, args: string[]): string[] {
  const bucket = bucketOf(args);
  const { manifest, lines } = verifyDownload(root);
  const { target } = wranglerCommand(args);
  const put = (key: string, path: string, type: string) =>
    wrangler(args, ['r2', 'object', 'put', `${bucket}/${key}`, '--file', path, '--content-type', type, ...target], `wrangler r2 object put failed: ${key}`);
  for (const object of manifest.evidence.objects)
    put(`${EVIDENCE_ROOT}${object.key}`, resolve(root, 'evidence', object.key), object.key.endsWith('.jpg') ? 'image/jpeg' : 'application/json');
  for (const table of manifest.tables) for (const part of table.parts) put(part.key, resolve(root, 'parts', part.key), 'application/gzip');
  const prefix = manifest.tables.flatMap((table) => table.parts)[0]?.key.split('/').slice(0, 2).join('/');
  if (prefix === undefined) throw new RestoreError('the backup has no parts');
  put(`${prefix}/manifest.json`, resolve(root, 'manifest.json'), 'application/json');
  return [...lines, `uploaded ${prefix}/ to ${bucket}`];
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function main(): void {
  const [command = '', ...args] = process.argv.slice(2);
  const required = (name: string) => {
    const value = option(args, name);
    if (!value) throw new RestoreError(`${command} needs ${name}`);
    return value;
  };
  let lines: string[];
  if (command === 'download') lines = download(privateDirectory(required('--out')), args);
  else if (command === 'verify') lines = verifyDownload(required('--in')).lines;
  else if (command === 'upload') lines = upload(required('--in'), args);
  else throw new RestoreError('use download, verify or upload');
  for (const line of lines) console.log(line);
  console.log(`${command} PASS`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL: ${error instanceof RestoreError ? error.message : 'the command failed'}`);
    process.exitCode = 1;
  }
}
