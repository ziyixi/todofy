#!/usr/bin/env node
/**
 * Copies of Personal MCP's daily backups (worker/src/backup.ts; docs/backup.md). The restore itself runs inside the
 * SubscriptionStore object, from its own BACKUPS bucket (`POST /owner/restore`); this tool moves and checks copies.
 *
 *   download  fetch a backup's manifest and parts with `wrangler r2 object get` into a private directory outside the
 *             repository, and check every part against the manifest: the newest backup (latest.json) unless
 *             `--backup backups/<job start>/` names one.
 *   verify    check a download again, offline: every part's SHA-256, gzip, row count and row width; prints the rows of
 *             each table and of the KV keys.
 *   upload    put a checked download into a bucket with `wrangler r2 object put`, the parts first and the manifest last,
 *             so a bucket that lost it (or a new account's) holds a backup the restore can read. It refuses a bucket
 *             that already holds that backup's manifest: a complete backup is never rewritten.
 *
 *   node tools/backup-restore.ts download --out <outside>/restore --remote [--backup backups/<job start>/]
 *   node tools/backup-restore.ts verify --in <outside>/restore
 *   node tools/backup-restore.ts upload --in <outside>/restore --remote [--bucket <name>]
 *
 * A download directory holds manifest.json and parts/<key>. `--local --persist-to <dir>` in place of `--remote` works
 * on a local copy; `--bucket` names another bucket. Files are written owner-only and row contents are never printed
 * (the backup holds Work memory, callback URLs and signing secrets). Node only, no dependencies.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = resolve(APP, 'worker/node_modules/.bin/wrangler');
export const FORMAT = 'personal-mcp-backup-v1';
const BUCKET = 'personal-mcp-backups';
const PREFIX = /^backups\/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\/$/;

export class RestoreError extends Error {}

interface Part {
  key: string;
  rows: number;
  sha256: string;
}
interface Family {
  name: string;
  /** The row width: the table's columns (rowid first), or 2 for the KV keys' [key, value]. */
  width: number;
  rows: number;
  parts: Part[];
}
export interface Backup {
  prefix: string;
  schema_version: number;
  created_at: string;
  families: Family[];
}
interface Manifest {
  format?: unknown;
  started_at?: unknown;
  created_at?: unknown;
  schema_version?: unknown;
  tables?: { name: string; columns: string[]; rows: number; parts: Part[] }[];
  kv?: { rows: number; parts: Part[] };
}

function readManifest(root: string): Manifest {
  try {
    return JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    throw new RestoreError('manifest.json: missing or not JSON');
  }
}

/** The prefix a job writes under: its start, to the second (backup.ts). */
function prefixOf(manifest: Manifest): string {
  const prefix = `backups/${String(manifest.started_at).replaceAll(':', '')}/`;
  if (!PREFIX.test(prefix)) throw new RestoreError('manifest.json: started_at is not a job start');
  return prefix;
}

function familiesOf(manifest: Manifest): Family[] {
  if (manifest.format !== FORMAT || !Array.isArray(manifest.tables) || !manifest.kv)
    throw new RestoreError(`manifest.json: format is not ${FORMAT}`);
  return [
    ...manifest.tables.map((table) => ({ name: table.name, width: table.columns.length, rows: table.rows, parts: table.parts })),
    { name: 'kv', width: 2, rows: manifest.kv.rows, parts: manifest.kv.parts },
  ];
}

/** The manifest with every part checked (SHA-256, gzip, row count and width), as the job wrote it. */
export function readBackup(root: string): Backup {
  const manifest = readManifest(root);
  const families = familiesOf(manifest);
  const prefix = prefixOf(manifest);
  for (const family of families) {
    let rows = 0;
    for (const part of family.parts) {
      if (!part.key.startsWith(prefix) || part.key.split('/').includes('..'))
        throw new RestoreError('a part key leaves the backup');
      let data: Buffer;
      try {
        data = readFileSync(resolve(root, 'parts', part.key));
      } catch {
        throw new RestoreError(`${part.key}: missing`);
      }
      if (createHash('sha256').update(data).digest('hex') !== part.sha256)
        throw new RestoreError(`${part.key}: SHA-256 differs from the manifest`);
      let lines: unknown[];
      try {
        lines = new TextDecoder('utf-8', { fatal: true }).decode(gunzipSync(data)).split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
      } catch {
        throw new RestoreError(`${part.key}: not a readable gzip NDJSON part`);
      }
      if (lines.length !== part.rows)
        throw new RestoreError(`${part.key}: ${String(lines.length)} rows, manifest says ${String(part.rows)}`);
      if (!lines.every((line) => Array.isArray(line) && line.length === family.width))
        throw new RestoreError(`${part.key}: a row does not match the manifest's columns`);
      rows += lines.length;
    }
    if (rows !== family.rows)
      throw new RestoreError(`${family.name}: parts hold ${String(rows)} rows, manifest says ${String(family.rows)}`);
  }
  return { prefix, schema_version: Number(manifest.schema_version), created_at: String(manifest.created_at), families };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

/** `wrangler` from `--wrangler` (a command line) or the Worker's own, the target flags of `args` and the bucket. */
function wranglerCommand(args: string[]) {
  const [command = WRANGLER, ...prefix] = (option(args, '--wrangler') ?? WRANGLER).split(/\s+/);
  const target = args.includes('--remote') ? ['--remote'] : ['--local'];
  const persist = option(args, '--persist-to');
  if (persist) target.push('--persist-to', persist);
  const bucket = option(args, '--bucket') ?? BUCKET;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new RestoreError('--bucket is not a bucket name');
  const run = (operation: string[], failure: string) => {
    try {
      execFileSync(command, [...prefix, 'r2', 'object', ...operation, ...target], {
        cwd: APP,
        env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new RestoreError(failure);
    }
  };
  return { bucket, run };
}

/** The download directory: created owner-only, never inside the repository (it holds the store's content). */
function privateDirectory(path: string): string {
  const root = resolve(realpathSync(dirname(resolve(path))), basename(resolve(path)));
  const rel = relative(realpathSync(resolve(APP, '..')), root);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new RestoreError('the download directory is inside the repository');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function lines(backup: Backup, withParts: boolean): string[] {
  return backup.families.map(
    (family) => `PASS ${family.name} rows=${String(family.rows)}${withParts ? ` parts=${String(family.parts.length)}` : ''}`,
  );
}

/** The backup's manifest and parts into `root` (manifest.json and parts/<key>), each object owner-only, then checked. */
function download(root: string, args: string[]): string[] {
  const { bucket, run } = wranglerCommand(args);
  const get = (key: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    run(['get', `${bucket}/${key}`, '--file', path], `wrangler r2 object get failed: ${key}`);
    chmodSync(path, 0o600);
  };
  let backup = option(args, '--backup');
  if (backup === undefined) {
    get('latest.json', resolve(root, 'latest.json'));
    backup = (JSON.parse(readFileSync(resolve(root, 'latest.json'), 'utf8')) as { key?: unknown }).key as string;
  }
  backup = `${String(backup).replace(/\/+$/, '')}/`;
  if (!PREFIX.test(backup)) throw new RestoreError('the backup is not a prefix like backups/2026-10-28T052300Z/');
  get(`${backup}manifest.json`, resolve(root, 'manifest.json'));
  for (const family of familiesOf(readManifest(root)))
    for (const part of family.parts) {
      if (!part.key.startsWith(backup) || part.key.split('/').includes('..')) throw new RestoreError('a part key leaves the backup');
      get(part.key, resolve(root, 'parts', part.key));
    }
  const checked = readBackup(root);
  if (checked.prefix !== backup) throw new RestoreError('the manifest names another backup');
  return [`backup ${backup}`, ...lines(checked, true)];
}

/** A checked download into a bucket: every part, then the manifest, which makes it a complete backup there. */
function upload(root: string, args: string[]): string[] {
  const backup = readBackup(root);
  const { bucket, run } = wranglerCommand(args);
  const existing = resolve(root, 'existing-manifest.json');
  rmSync(existing, { force: true });
  let present = true;
  try {
    run(['get', `${bucket}/${backup.prefix}manifest.json`, '--file', existing], '');
  } catch {
    present = false;
  }
  rmSync(existing, { force: true });
  if (present) throw new RestoreError(`${bucket} already holds ${backup.prefix} complete; it is not rewritten`);
  let parts = 0;
  for (const family of backup.families)
    for (const part of family.parts) {
      run(['put', `${bucket}/${part.key}`, '--file', resolve(root, 'parts', part.key), '--content-type', 'application/gzip'],
        `wrangler r2 object put failed: ${part.key}`);
      parts += 1;
    }
  run(['put', `${bucket}/${backup.prefix}manifest.json`, '--file', resolve(root, 'manifest.json'), '--content-type', 'application/json'],
    `wrangler r2 object put failed: ${backup.prefix}manifest.json`);
  return [`backup ${backup.prefix}`, ...lines(backup, true), `put ${String(parts)} parts and the manifest into ${bucket}`];
}

function main(): void {
  const [command = '', ...args] = process.argv.slice(2);
  const required = (name: string) => {
    const value = option(args, name);
    if (!value) throw new RestoreError(`${command} needs ${name}`);
    return value;
  };
  let output: string[];
  if (command === 'download') output = download(privateDirectory(required('--out')), args);
  else if (command === 'verify') {
    const backup = readBackup(required('--in'));
    output = [`backup ${backup.prefix} schema_version=${String(backup.schema_version)} created_at=${backup.created_at}`, ...lines(backup, false)];
  } else if (command === 'upload') output = upload(required('--in'), args);
  else throw new RestoreError('use download, verify or upload');
  for (const line of output) console.log(line);
  console.log(`${command} PASS`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL: ${error instanceof RestoreError ? error.message : 'restore tool failed'}`);
    process.exitCode = 1;
  }
}
