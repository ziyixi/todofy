#!/usr/bin/env node
/**
 * Mailsort's daily backups (worker/src/backup.ts; docs/backup.md) on the owner's machine. The restore itself runs inside
 * MailsortState (StartBackupRestore, worker/src/restore.ts), which reads the backup from its own bucket; this tool
 * fetches, checks and keeps a copy, and puts one back into a bucket that lacks it.
 *
 *   download  fetch a backup's manifest and parts with `wrangler r2 object get` into a private directory outside the
 *             repository, and check every part: the newest (latest.json) unless `--backup backups/<job start>/`.
 *   verify    check a download again: every part's SHA-256, row count and width against the manifest.
 *   sqlite    load a download into a new SQLite file with the backup's own schema and compare every table's rows with
 *             the manifest: the data readable without Cloudflare, and the restore's load checked offline.
 *   upload    put a download into a bucket (`--bucket`) with `wrangler r2 object put`: the parts, then the manifest, so a
 *             partial upload is never a complete backup; it refuses a prefix whose manifest is already there.
 *
 *   node tools/backup-restore.ts download --out <outside>/restore --remote
 *   node tools/backup-restore.ts verify --in <outside>/restore
 *   node tools/backup-restore.ts sqlite --in <outside>/restore --out <outside>/mailsort.sqlite
 *   node tools/backup-restore.ts upload --in <outside>/restore --bucket mailsort-backups --remote
 *
 * A download directory holds manifest.json and parts/<key>. `--local --persist-to <dir>` in place of `--remote` works on
 * a local bucket. Files are written owner-only and row contents are never printed. Node only, no dependencies.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = resolve(APP, 'worker/node_modules/.bin/wrangler');
export const FORMAT = 'mailsort-backup-v1';
const BUCKET = 'mailsort-backups';
const PREFIX = /^backups\/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\/$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class RestoreError extends Error {}

export interface Part {
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}
export interface Table {
  name: string;
  sql: string;
  indexes: string[];
  columns: string[];
  key: string[];
  rows: number;
  parts: Part[];
}
export interface Manifest {
  format: string;
  object: string;
  started_at: string;
  created_at: string;
  schema_version: number;
  tables: Table[];
}
export type Value = string | number | null | Uint8Array;

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The manifest's structure, checked as the restore in the object checks it. */
export function checkManifest(manifest: Manifest, prefix: string): Manifest {
  if (manifest.format !== FORMAT) throw new RestoreError(`manifest.json: format is not ${FORMAT}`);
  if (!count(manifest.schema_version) || !Array.isArray(manifest.tables)) throw new RestoreError('manifest.json: no schema version or tables');
  const names = new Set<string>();
  for (const table of manifest.tables) {
    if (!IDENTIFIER.test(table.name) || names.has(table.name)) throw new RestoreError('manifest.json: an invalid or repeated table name');
    names.add(table.name);
    const statements = [table.sql, ...table.indexes];
    if (!new RegExp(`^CREATE TABLE "?${table.name}"?\\s*\\(`).test(table.sql) || statements.some((sql) => typeof sql !== 'string' || sql.includes(';'))
      || !table.indexes.every((sql) => new RegExp(`^CREATE (UNIQUE )?INDEX [^;]* ON "?${table.name}"?\\s*\\(`).test(sql))) {
      throw new RestoreError(`${table.name}: an unexpected schema statement`);
    }
    if (!table.columns.length || !table.columns.every((column) => IDENTIFIER.test(column))) throw new RestoreError(`${table.name}: invalid column name`);
    for (const part of table.parts) {
      if (!part.key.startsWith(`${prefix}${table.name}/`) || part.key.split('/').includes('..')) throw new RestoreError('a part key leaves the backup');
      if (!/^[0-9a-f]{64}$/.test(part.sha256) || !count(part.rows)) throw new RestoreError(`${part.key}: invalid part entry`);
    }
    if (!count(table.rows) || table.parts.reduce((sum, part) => sum + part.rows, 0) !== table.rows) throw new RestoreError(`${table.name}: parts and rows disagree`);
  }
  if (!names.has('meta')) throw new RestoreError('manifest.json: no meta table');
  return manifest;
}

/** One stored JSON value back as SQLite's (worker/src/backup.ts encodeValue). */
function decodeValue(value: unknown, where: string): Value {
  if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'object' && 'blob' in value && typeof value.blob === 'string') return new Uint8Array(Buffer.from(value.blob, 'base64'));
  if (typeof value === 'object' && 'real' in value && (value.real === 'Infinity' || value.real === '-Infinity')) return Number(value.real);
  throw new RestoreError(`${where}: an unreadable value`);
}

/** A download's manifest and every table's rows, each part checked against its SHA-256, row count and width. */
export function readBackup(root: string): { manifest: Manifest; prefix: string; rows: Map<string, Value[][]> } {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    throw new RestoreError('manifest.json: missing or not JSON');
  }
  const prefix = /^(backups\/[^/]+\/)/.exec(manifest.tables?.flatMap((table) => table.parts)[0]?.key ?? '')?.[1] ?? '';
  if (!PREFIX.test(prefix)) throw new RestoreError('manifest.json: its parts name no backup prefix');
  checkManifest(manifest, prefix);
  const rows = new Map<string, Value[][]>();
  for (const table of manifest.tables) {
    const values: Value[][] = [];
    for (const part of table.parts) {
      let data: Buffer;
      try {
        data = readFileSync(resolve(root, 'parts', part.key));
      } catch {
        throw new RestoreError(`${part.key}: missing`);
      }
      if (createHash('sha256').update(data).digest('hex') !== part.sha256) throw new RestoreError(`${part.key}: SHA-256 differs from the manifest`);
      let lines: unknown[];
      try {
        lines = gunzipSync(data).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
      } catch {
        throw new RestoreError(`${part.key}: not a readable gzip NDJSON part`);
      }
      if (lines.length !== part.rows) throw new RestoreError(`${part.key}: ${String(lines.length)} rows, manifest says ${String(part.rows)}`);
      for (const line of lines) {
        if (!Array.isArray(line) || line.length !== table.columns.length) throw new RestoreError(`${part.key}: a row does not match the manifest's columns`);
        values.push(line.map((value) => decodeValue(value, part.key)));
      }
    }
    rows.set(table.name, values);
  }
  return { manifest, prefix, rows };
}

const quote = (name: string) => (name === 'rowid' ? name : `"${name}"`);

/** A new SQLite file with the backup's schema and rows; every table's count against the manifest. */
export function loadSqlite(root: string, out: string): { ok: boolean; lines: string[] } {
  const { manifest, rows } = readBackup(root);
  if (existsSync(out)) throw new RestoreError('the output exists; nothing was written');
  const db = new DatabaseSync(out);
  chmodSync(out, 0o600);
  try {
    db.exec('BEGIN');
    for (const table of manifest.tables) db.exec(table.sql);
    for (const table of manifest.tables) for (const index of table.indexes) db.exec(index);
    for (const table of manifest.tables) {
      const insert = db.prepare(`INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(', ')}) VALUES (${table.columns.map(() => '?').join(', ')})`);
      for (const row of rows.get(table.name) ?? []) insert.run(...(row as SQLInputValue[]));
    }
    db.exec('COMMIT');
    let ok = true;
    const lines = [`backup schema_version=${String(manifest.schema_version)} started_at=${manifest.started_at}`];
    for (const table of manifest.tables) {
      const found = (db.prepare(`SELECT count(*) AS n FROM ${quote(table.name)}`).get() as { n: number }).n;
      ok &&= found === table.rows;
      lines.push(`${found === table.rows ? 'PASS' : 'FAIL'} ${table.name} rows=${String(found)}/${String(table.rows)}`);
    }
    return { ok, lines };
  } finally {
    db.close();
  }
}

/** `wrangler` from `--wrangler` (a command line) or the Worker's own, and the target flags of `args`. */
function wranglerCommand(args: string[]) {
  const [command = WRANGLER, ...prefix] = (option(args, '--wrangler') ?? WRANGLER).split(/\s+/);
  const target = args.includes('--remote') ? ['--remote'] : ['--local'];
  const persist = option(args, '--persist-to');
  if (persist) target.push('--persist-to', persist);
  return { command, prefix, target };
}

function wrangler(args: string[], extra: string[], what: string): void {
  const { command, prefix } = wranglerCommand(args);
  try {
    execFileSync(command, [...prefix, ...extra], { cwd: APP, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new RestoreError(`wrangler ${what} failed`);
  }
}

function bucketOf(args: string[]): string {
  const bucket = option(args, '--bucket') ?? BUCKET;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new RestoreError('--bucket is not a bucket name');
  return bucket;
}

/** The download directory: created owner-only, never inside the repository (it holds the owner's mail metadata). */
function privateDirectory(path: string): string {
  const root = resolve(realpathSync(dirname(resolve(path))), basename(resolve(path)));
  const rel = relative(realpathSync(resolve(APP, '..')), root);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new RestoreError('the download directory is inside the repository');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/** The backup's manifest and parts from R2 into `root`, each object owner-only, then every part checked. */
function download(root: string, args: string[]): string[] {
  const { target } = wranglerCommand(args);
  const bucket = bucketOf(args);
  const get = (key: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    wrangler(args, ['r2', 'object', 'get', `${bucket}/${key}`, '--file', path, ...target], `r2 object get ${key}`);
    chmodSync(path, 0o600);
  };
  let backup = option(args, '--backup');
  if (backup === undefined) {
    get('latest.json', resolve(root, 'latest.json'));
    backup = (JSON.parse(readFileSync(resolve(root, 'latest.json'), 'utf8')) as { key?: unknown }).key as string;
  }
  backup = `${String(backup).replace(/\/+$/, '')}/`;
  if (!PREFIX.test(backup)) throw new RestoreError('the backup is not a prefix like backups/2026-10-28T114100Z/');
  get(`${backup}manifest.json`, resolve(root, 'manifest.json'));
  const manifest = checkManifest(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Manifest, backup);
  for (const table of manifest.tables) for (const part of table.parts) get(part.key, resolve(root, 'parts', part.key));
  return [`backup ${backup}`, ...verify(root)];
}

function verify(root: string): string[] {
  const { manifest } = readBackup(root);
  return manifest.tables.map((table) => `PASS ${table.name} rows=${String(table.rows)} parts=${String(table.parts.length)}`);
}

/** Every part, then the manifest, into `--bucket`; a prefix that already holds a manifest is refused. */
function upload(root: string, args: string[]): string[] {
  const { target } = wranglerCommand(args);
  const bucket = bucketOf(args);
  const { manifest, prefix } = readBackup(root);
  const probe = resolve(root, '.existing-manifest.json');
  let exists = true;
  try {
    wrangler(args, ['r2', 'object', 'get', `${bucket}/${prefix}manifest.json`, '--file', probe, ...target], 'r2 object get');
  } catch {
    exists = false;
  }
  if (exists) throw new RestoreError(`${bucket} already holds ${prefix}manifest.json; nothing was uploaded`);
  const put = (key: string, path: string, type: string) => wrangler(args, ['r2', 'object', 'put', `${bucket}/${key}`, '--file', path, '--content-type', type, ...target], `r2 object put ${key}`);
  for (const table of manifest.tables) for (const part of table.parts) put(part.key, resolve(root, 'parts', part.key), 'application/gzip');
  put(`${prefix}manifest.json`, resolve(root, 'manifest.json'), 'application/json');
  return [`uploaded ${prefix} to ${bucket}`, ...manifest.tables.map((table) => `PASS ${table.name} parts=${String(table.parts.length)}`)];
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function main(): boolean {
  const [command = '', ...args] = process.argv.slice(2);
  const required = (name: string) => {
    const value = option(args, name);
    if (!value) throw new RestoreError(`${command} needs ${name}`);
    return value;
  };
  let lines: string[];
  let ok = true;
  if (command === 'download') lines = download(privateDirectory(required('--out')), args);
  else if (command === 'verify') lines = verify(required('--in'));
  else if (command === 'sqlite') ({ ok, lines } = loadSqlite(required('--in'), resolve(required('--out'))));
  else if (command === 'upload') lines = upload(required('--in'), args);
  else throw new RestoreError('use download, verify, sqlite or upload');
  for (const line of lines) console.log(line);
  console.log(`${command} ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!main()) process.exitCode = 1;
  } catch (error) {
    console.error(`FAIL: ${error instanceof RestoreError ? error.message : 'restore failed'}`);
    process.exitCode = 1;
  }
}
