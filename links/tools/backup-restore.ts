#!/usr/bin/env node
/**
 * Restore a daily backup of the links app (worker/src/backup-runner.ts; docs/backup.md) into a new, empty D1.
 *
 *   download  fetch a backup's manifest and parts from R2 with `wrangler r2 object get` into a private directory
 *           outside the repository, and check every part (SHA-256, rows, columns). By default the newest backup of
 *           `links-backups` (its latest.json); `--backup backups/<job start>` names one.
 *   config  write the restore target's wrangler config: its DB binding, the committed account and the absolute
 *           links/migrations. It refuses the production database's id or name, a path inside the repository and an
 *           existing file. It has no Worker, so nothing can be deployed with it.
 *   sql     check every part against the manifest again and write one SQL file of INSERTs, one per row, that a
 *           re-run leaves alone; it refuses a statement over D1's limit.
 *   verify  check that the restored database has the backup's migration applied and holds exactly the backup's rows:
 *           every table read back in key order, page by page, and compared row for row, value for value.
 *
 *   node tools/backup-restore.ts download --out <outside>/restore --remote
 *   node tools/backup-restore.ts config --database-name links-restore --database-id <uuid> --out <outside>/restore.toml
 *   node tools/backup-restore.ts sql --in <outside>/restore --out <outside>/links-restore.sql
 *   node tools/backup-restore.ts verify --in <outside>/restore --config <outside>/restore.toml --remote
 *
 * A download directory holds manifest.json and parts/<key>. `--local --persist-to <dir>` in place of `--remote` works
 * on a local copy. Files are written owner-only and row contents are never printed. Node only, no dependencies.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = resolve(APP, '..');
const PRODUCTION_CONFIG = resolve(APP, 'wrangler.toml');
const MIGRATIONS = resolve(APP, 'migrations');
const WRANGLER = resolve(APP, 'worker/node_modules/.bin/wrangler');
const FORMAT = 'links-backup-v1';
const BUCKET = 'links-backups';
const PREFIX = /^backups\/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\/$/;
const NAME = /^[a-z_][a-z0-9_]*$/;
/** D1 refuses a statement over 100 KB. A link's row holds a few KB. */
export const MAX_STATEMENT_BYTES = 90_000;
/** The tables of migrations/, in restore order (no references between them, no triggers). */
export const RESTORE_ORDER = ['links', 'link_revisions', 'request_log'];
/** Rows `verify` reads back per `wrangler d1 execute`. */
export const VERIFY_ROWS = 500;

export class RestoreError extends Error {}

interface Part {
  key: string;
  rows: number;
  sha256: string;
}
interface Table {
  name: string;
  columns: string[];
  key: string[];
  rows: number;
  parts: Part[];
}
interface Mark {
  update_time: number;
  rows: Record<string, number>;
}
interface LinksSection {
  schema_version: string;
  change_mark: { start: Mark; end: Mark };
  tables: Table[];
}
type Value = string | number | null;
export interface Backup {
  section: LinksSection;
  /** Each table's rows in key order, as arrays in its columns' order. */
  rows: Map<string, Value[][]>;
}

/** The manifest's links section with every part checked (SHA-256, width and row counts), as rows by table. */
export function readBackup(root: string): Backup {
  let manifest: { format?: unknown; links?: LinksSection };
  try {
    manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    throw new RestoreError('manifest.json: missing or not JSON');
  }
  if (manifest.format !== FORMAT) throw new RestoreError(`manifest.json: format is not ${FORMAT}`);
  const section = manifest.links;
  if (!section || !Array.isArray(section.tables)) throw new RestoreError('manifest.json has no links section');
  const names = section.tables.map((table) => table.name);
  if (names.join() !== RESTORE_ORDER.join()) throw new RestoreError(`unexpected tables: ${names.join(', ')}`);
  const rows = new Map<string, Value[][]>();
  for (const table of section.tables) {
    if (![...table.columns, ...table.key].every((column) => NAME.test(column)) || !table.key.length)
      throw new RestoreError(`${table.name}: invalid column name`);
    if (!table.key.every((column) => table.columns.includes(column)))
      throw new RestoreError(`${table.name}: the key is not among the columns`);
    const values: Value[][] = [];
    for (const part of table.parts) {
      if (part.key.startsWith('/') || part.key.split('/').includes('..'))
        throw new RestoreError('a part key leaves the download directory');
      let data: Buffer;
      try {
        data = readFileSync(resolve(root, 'parts', part.key));
      } catch {
        throw new RestoreError(`${part.key}: missing`);
      }
      if (createHash('sha256').update(data).digest('hex') !== part.sha256)
        throw new RestoreError(`${part.key}: SHA-256 differs from the manifest`);
      let parsed: unknown[];
      try {
        parsed = new TextDecoder()
          .decode(gunzipSync(data))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown);
      } catch {
        throw new RestoreError(`${part.key}: not a readable gzip NDJSON part`);
      }
      if (parsed.length !== part.rows)
        throw new RestoreError(`${part.key}: ${String(parsed.length)} rows, manifest says ${String(part.rows)}`);
      for (const row of parsed) {
        if (
          !Array.isArray(row) ||
          row.length !== table.columns.length ||
          !row.every((value) => value === null || typeof value === 'string' || Number.isFinite(value))
        )
          throw new RestoreError(`${part.key}: a row does not match the manifest's columns`);
        values.push(row as Value[]);
      }
    }
    if (values.length !== table.rows)
      throw new RestoreError(`${table.name}: parts hold ${String(values.length)} rows, manifest says ${String(table.rows)}`);
    rows.set(table.name, values);
  }
  return { section, rows };
}

function literal(value: Value): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  // A NUL would end the statement in SQLite's tokenizer; a blob cast keeps it.
  if (value.includes('\0')) return `CAST(X'${Buffer.from(value).toString('hex')}' AS TEXT)`;
  return `'${value.replaceAll("'", "''")}'`;
}

/** The restore SQL: every row once, as an INSERT that a re-run leaves alone. */
export function restoreSql({ section, rows }: Backup): { sql: string; statements: number } {
  const lines = [
    `-- links restore of schema ${section.schema_version}. Load it into a new D1 with that migration (or a later,` +
      ' additive one) applied and no rows.',
  ];
  for (const table of section.tables) {
    const insert = `INSERT INTO ${table.name}(${table.columns.join(',')}) VALUES`;
    for (const row of rows.get(table.name) ?? []) {
      const statement = `${insert}(${row.map(literal).join(',')}) ON CONFLICT DO NOTHING;`;
      if (Buffer.byteLength(statement) > MAX_STATEMENT_BYTES)
        throw new RestoreError(`${table.name}: a row exceeds D1's statement limit`);
      lines.push(statement);
    }
  }
  return { sql: `${lines.join('\n')}\n`, statements: lines.length - 1 };
}

/** The production database's account, name and id, from the committed config. */
function production() {
  const config = readFileSync(PRODUCTION_CONFIG, 'utf8');
  const account = /^account_id\s*=\s*"([0-9a-f]{32})"/m.exec(config)?.[1];
  const block = config.split('[[d1_databases]]')[1]?.split('\n[')[0] ?? '';
  const name = /^database_name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
  const id = /^database_id\s*=\s*"([^"]+)"/m.exec(block)?.[1];
  if (!account || !name || !id || !/^binding\s*=\s*"DB"/m.test(block))
    throw new RestoreError(`${PRODUCTION_CONFIG} has no account_id or DB database`);
  return { account, name, id };
}

/** The restore target's config: only the new database's DB binding and this checkout's migrations. */
export function restoreConfig(name: string, id: string): string {
  const live = production();
  const database = id.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(database))
    throw new RestoreError('--database-id is not a D1 database id (a UUID, from `wrangler d1 create`)');
  if (database === live.id || name === live.name)
    throw new RestoreError('that is the production database: restore only into a new, empty one');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new RestoreError("--database-name must be the new database's name");
  return [
    '# The restore target of links/tools/backup-restore.ts config (links/docs/backup.md). Only for `wrangler d1',
    '# migrations apply`, `d1 execute` and `backup-restore.ts verify`; it has no Worker, so nothing can be deployed',
    '# with it. Never commit it; delete it after the restore.',
    `account_id = ${JSON.stringify(live.account)}`,
    '',
    '[[d1_databases]]',
    'binding = "DB"',
    `database_name = ${JSON.stringify(name)}`,
    `database_id = ${JSON.stringify(database)}`,
    `migrations_dir = ${JSON.stringify(MIGRATIONS)}`,
    '',
  ].join('\n');
}

/** `wrangler` from `--wrangler` (a command line) or the Worker's own, and the target flags of `args`. */
function wranglerCommand(args: string[]) {
  const [command = WRANGLER, ...prefix] = (option(args, '--wrangler') ?? WRANGLER).split(/\s+/);
  const target = args.includes('--remote') ? ['--remote'] : ['--local'];
  const persist = option(args, '--persist-to');
  if (persist) target.push('--persist-to', persist);
  return { command, prefix, target };
}

/** One query against the restored database through `wrangler d1 execute --json`: its rows. */
function query(args: string[], sql: string): Record<string, unknown>[] {
  const { command, prefix, target } = wranglerCommand(args);
  const config = option(args, '--config');
  if (!config) throw new RestoreError('verify needs --config (the restore target)');
  let output: string;
  try {
    const execute = ['d1', 'execute', 'DB', '--json', '--config', config, ...target, '--command', sql];
    output = execFileSync(command, [...prefix, ...execute], {
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 256 << 20,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new RestoreError('wrangler d1 execute failed');
  }
  const rows = (JSON.parse(output) as { results?: Record<string, unknown>[] }[])[0]?.results;
  if (!Array.isArray(rows)) throw new RestoreError('wrangler returned an unexpected result shape');
  return rows;
}

/**
 * The restored database against the backup: the migration applied, then every table read back in key order,
 * VERIFY_ROWS at a time, each row compared value for value with the backup's row at the same place.
 */
export function verifyRestore(backup: Backup, read: (sql: string) => Record<string, unknown>[]): { ok: boolean; lines: string[] } {
  const { section } = backup;
  const applied = JSON.parse(String(read('SELECT json_group_array(name) AS m FROM d1_migrations')[0]?.m ?? '[]')) as string[];
  let ok = applied.includes(section.schema_version);
  const lines = [`${ok ? 'PASS' : 'FAIL'} schema_version ${section.schema_version}${ok ? '' : ' (not applied)'}`];
  for (const table of section.tables) {
    const expected = backup.rows.get(table.name) ?? [];
    const key = table.key.join(',');
    let found = 0;
    let differing = 0;
    let after: unknown[] | null = null;
    for (;;) {
      const where: string = after === null ? '' : `WHERE (${key})>(${after.map((value) => literal(value as Value)).join(',')})`;
      const page = read(
        `SELECT json_array(${table.columns.join(',')}) AS r,json_array(${key}) AS k FROM ${table.name} ${where} ORDER BY ${key} LIMIT ${String(VERIFY_ROWS)}`,
      );
      for (const row of page) {
        const restored = JSON.stringify(JSON.parse(String(row.r)));
        if (restored !== JSON.stringify(expected[found])) differing += 1;
        found += 1;
      }
      if (page.length < VERIFY_ROWS) break;
      after = JSON.parse(String(page.at(-1)?.k)) as unknown[];
    }
    const matches = found === expected.length && differing === 0;
    ok &&= matches;
    lines.push(
      `${matches ? 'PASS' : 'FAIL'} ${table.name} rows=${String(found)}/${String(expected.length)}` +
        (differing ? ` differing=${String(differing)}` : ''),
    );
  }
  return { ok, lines };
}

/** The download directory: created owner-only, never inside the repository (it holds every link). */
function privateDirectory(path: string): string {
  const root = resolve(realpathSync(dirname(resolve(path))), basename(resolve(path)));
  if (insideRepository(root)) throw new RestoreError('the download directory is inside the repository');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function insideRepository(path: string): boolean {
  const rel = relative(realpathSync(REPOSITORY), path);
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A new owner-only file outside the repository; an existing one is never overwritten. */
async function privateText(output: string, text: string): Promise<void> {
  const target = resolve(realpathSync(dirname(resolve(output))), basename(resolve(output)));
  if (insideRepository(target)) throw new RestoreError('the output is inside the repository');
  let file: FileHandle;
  try {
    file = await open(target, 'wx', 0o600);
  } catch {
    throw new RestoreError('the output exists or cannot be created; nothing was written');
  }
  try {
    await file.writeFile(text);
  } finally {
    await file.close();
  }
}

/**
 * The backup's manifest and parts from R2 into `root` (manifest.json and parts/<key>), each object owner-only: the
 * newest one (latest.json) unless `--backup` names a prefix. Every part is then checked against the manifest.
 */
function download(root: string, args: string[]): string[] {
  const { command, prefix, target } = wranglerCommand(args);
  const bucket = option(args, '--bucket') ?? BUCKET;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new RestoreError('--bucket is not a bucket name');
  const get = (key: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      execFileSync(command, [...prefix, 'r2', 'object', 'get', `${bucket}/${key}`, '--file', path, ...target], {
        cwd: APP,
        env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new RestoreError(`wrangler r2 object get failed: ${key}`);
    }
    chmodSync(path, 0o600);
  };
  let backup = option(args, '--backup');
  if (backup === undefined) {
    get('latest.json', resolve(root, 'latest.json'));
    backup = (JSON.parse(readFileSync(resolve(root, 'latest.json'), 'utf8')) as { key?: unknown }).key as string;
  }
  backup = `${String(backup).replace(/\/+$/, '')}/`;
  if (!PREFIX.test(backup)) throw new RestoreError('the backup is not a prefix like backups/2026-10-28T052500Z/');
  get(`${backup}manifest.json`, resolve(root, 'manifest.json'));
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as { links?: LinksSection };
  for (const table of manifest.links?.tables ?? [])
    for (const part of table.parts) {
      if (!part.key.startsWith(backup) || part.key.split('/').includes('..'))
        throw new RestoreError('a part key leaves the backup');
      get(part.key, resolve(root, 'parts', part.key));
    }
  const { section } = readBackup(root);
  return [
    `backup ${backup}`,
    ...section.tables.map((table) => `PASS ${table.name} rows=${String(table.rows)} parts=${String(table.parts.length)}`),
  ];
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function main(): Promise<boolean> {
  const [command = '', ...args] = process.argv.slice(2);
  const required = (name: string) => {
    const value = option(args, name);
    if (!value) throw new RestoreError(`${command} needs ${name}`);
    return value;
  };
  let lines: string[];
  let ok = true;
  if (command === 'download') {
    lines = download(privateDirectory(required('--out')), args);
  } else if (command === 'config') {
    const out = required('--out');
    await privateText(out, restoreConfig(required('--database-name'), required('--database-id')));
    lines = [`wrote ${out}`];
  } else if (command === 'sql') {
    const backup = readBackup(required('--in'));
    const { sql, statements } = restoreSql(backup);
    await privateText(required('--out'), sql);
    lines = backup.section.tables.map((table) => `PASS ${table.name} rows=${String(table.rows)}`);
    lines.push(`statements=${String(statements)}`);
    const { start, end } = backup.section.change_mark;
    if (JSON.stringify(start) !== JSON.stringify(end))
      lines.unshift('WARN the links changed while the backup ran: rows may mix both states');
  } else if (command === 'verify') {
    ({ ok, lines } = verifyRestore(readBackup(required('--in')), (sql) => query(args, sql)));
  } else {
    throw new RestoreError('use download, config, sql or verify');
  }
  for (const line of lines) console.log(line);
  console.log(`${command} ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then(
    (ok) => {
      if (!ok) process.exitCode = 1;
    },
    (error: unknown) => {
      console.error(`FAIL: ${error instanceof RestoreError ? error.message : 'restore failed'}`);
      process.exitCode = 1;
    },
  );
