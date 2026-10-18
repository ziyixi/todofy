#!/usr/bin/env node
/**
 * Restore the Tasks section of a weekly backup (Todofy's job copies Tasks' D1; docs/backup.md) into a new, empty D1.
 *
 *   config  write the restore target's wrangler config: its DB binding, the committed account and the absolute
 *           tasks/migrations. It refuses the production database's id or name, a path inside the repository and an
 *           existing file. It has no Worker, so nothing can be deployed with it.
 *   sql     check every Tasks part against the manifest again and write one SQL file of INSERTs, parents first;
 *           the triggers rebuild task_labels, project_archived and the change feed. It refuses a live row whose
 *           project, section, parent or label is not in the backup (naming ids only) and a statement over D1's limit.
 *   verify  compare the restored database's row counts with the manifest and check that its migration is applied.
 *
 *   node tools/backup-restore.ts config --database-name tasks-restore --database-id <uuid> --out <outside>/restore.toml
 *   node tools/backup-restore.ts sql --in <download dir> --out <outside>/tasks-restore.sql
 *   node tools/backup-restore.ts verify --in <download dir> --config <outside>/restore.toml --remote
 *
 * The download directory is todofy/tools/backup_restore.py download's (manifest.json and parts/). Files are written
 * owner-only and row contents are never printed. Node only, no dependencies.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ExportError, privateText } from './todoist-export.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTION_CONFIG = resolve(APP, 'wrangler.toml');
const MIGRATIONS = resolve(APP, 'migrations');
const WRANGLER = resolve(APP, 'worker/node_modules/.bin/wrangler');
const FORMAT = 'todofy-d1-backup-v1';
/** D1 refuses a statement over 100 KB. A task row holds at most about 50 KB. */
export const MAX_STATEMENT_BYTES = 90_000;
/** Each table after the tables its rows reference. */
export const RESTORE_ORDER = ['projects', 'sections', 'labels', 'filters', 'tasks', 'completions', 'requests'];

export class RestoreError extends Error {}

interface Part {
  key: string;
  rows: number;
  sha256: string;
}
interface Table {
  name: string;
  columns: string[];
  rows: number;
  parts: Part[];
}
interface TasksSection {
  schema_version: string;
  change_sequence: { start: number; end: number };
  tables: Table[];
}
type Row = Record<string, unknown>;
export interface Backup {
  section: TasksSection;
  rows: Map<string, Row[]>;
}

/** The manifest's Tasks section with every part checked (SHA-256, width and row counts), as rows by table. */
export function readBackup(root: string): Backup {
  let manifest: { format?: unknown; tasks?: TasksSection };
  try {
    manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    throw new RestoreError('manifest.json: missing or not JSON');
  }
  if (manifest.format !== FORMAT) throw new RestoreError(`manifest.json: format is not ${FORMAT}`);
  const section = manifest.tasks;
  if (!section)
    throw new RestoreError('manifest.json has no tasks section: the backup was made before Tasks was in it');
  const names = section.tables.map((table) => table.name);
  if ([...names].sort().join() !== [...RESTORE_ORDER].sort().join())
    throw new RestoreError(`unexpected Tasks tables: ${names.join(', ')}`);
  section.tables.sort((a, b) => RESTORE_ORDER.indexOf(a.name) - RESTORE_ORDER.indexOf(b.name));
  const rows = new Map<string, Row[]>();
  for (const table of section.tables) {
    if (!table.columns.every((column) => /^[a-z_][a-z0-9_]*$/.test(column)))
      throw new RestoreError(`${table.name}: invalid column name`);
    const values: Row[] = [];
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
        parsed = gunzipSync(data)
          .toString('utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown);
      } catch {
        throw new RestoreError(`${part.key}: not a readable gzip NDJSON part`);
      }
      if (parsed.length !== part.rows)
        throw new RestoreError(`${part.key}: ${String(parsed.length)} rows, manifest says ${String(part.rows)}`);
      for (const row of parsed) {
        if (!Array.isArray(row) || row.length !== table.columns.length)
          throw new RestoreError(`${part.key}: a row does not match the manifest's columns`);
        values.push(Object.fromEntries(table.columns.map((column, index) => [column, row[index]])));
      }
    }
    if (values.length !== table.rows)
      throw new RestoreError(
        `${table.name}: parts hold ${String(values.length)} rows, manifest says ${String(table.rows)}`,
      );
    rows.set(table.name, values);
  }
  return { section, rows };
}

function literal(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw new RestoreError(`unsupported value type ${typeof value}`);
  // A NUL would end the statement in SQLite's tokenizer; a blob cast keeps it.
  if (value.includes('\0')) return `CAST(X'${Buffer.from(value).toString('hex')}' AS TEXT)`;
  return `'${value.replaceAll("'", "''")}'`;
}

/** Rows with every parent (same table, `parent_id`) that the backup holds before them. */
function parentsFirst(table: string, rows: Row[]): Row[] {
  const byId = new Map(rows.map((row) => [row.id as string, row]));
  const placed = new Set<string>();
  const ordered: Row[] = [];
  for (const start of rows) {
    const chain: Row[] = [];
    let row: Row | undefined = start;
    while (row && !placed.has(row.id as string)) {
      if (chain.includes(row)) {
        if (chain.some((item) => item.deleted_at === null))
          throw new RestoreError(`${table}/${row.id as string}: its parents form a cycle`);
        break;
      }
      chain.push(row);
      row = row.parent_id ? byId.get(row.parent_id as string) : undefined;
    }
    for (const item of chain.reverse()) {
      placed.add(item.id as string);
      ordered.push(item);
    }
  }
  return ordered;
}

/** The references Tasks' insert triggers check on live rows, checked first so a load never stops halfway. */
function missingReferences(rows: Map<string, Row[]>): string[] {
  const live = (table: string) =>
    new Map((rows.get(table) ?? []).filter((row) => row.deleted_at === null).map((row) => [row.id as string, row]));
  const projects = live('projects');
  const sections = live('sections');
  const labels = live('labels');
  const tasks = live('tasks');
  const missing: string[] = [];
  for (const [id, project] of projects)
    if (project.parent_id && !projects.has(project.parent_id as string))
      missing.push(`projects/${id}: parent ${project.parent_id as string}`);
  for (const [id, task] of tasks) {
    const project = task.project_id as string;
    if (project && !projects.has(project)) missing.push(`tasks/${id}: project ${project}`);
    const section = task.section_id as string;
    if (section && sections.get(section)?.project_id !== project) missing.push(`tasks/${id}: section ${section}`);
    const parent = task.parent_id as string;
    if (parent && tasks.get(parent)?.project_id !== project) missing.push(`tasks/${id}: parent ${parent}`);
    for (const label of JSON.parse(task.label_ids as string) as string[])
      if (!labels.has(label)) missing.push(`tasks/${id}: label ${label}`);
  }
  return missing;
}

/** The restore SQL: every row once, as an INSERT that a re-run leaves alone. */
export function restoreSql({ section, rows }: Backup): { sql: string; statements: number } {
  const missing = missingReferences(rows);
  if (missing.length)
    throw new RestoreError(`live rows reference rows the backup lacks or holds deleted: ${missing.join('; ')}`);
  const lines = [
    `-- Tasks restore of schema ${section.schema_version}. Load it into a new D1 with that migration (or a later,` +
      ' additive one) applied and no rows.',
  ];
  for (const table of section.tables) {
    const values = rows.get(table.name) ?? [];
    const ordered = table.name === 'projects' || table.name === 'tasks' ? parentsFirst(table.name, values) : values;
    const insert = `INSERT INTO ${table.name}(${table.columns.join(',')}) VALUES`;
    for (const row of ordered) {
      const statement = `${insert}(${table.columns.map((column) => literal(row[column])).join(',')}) ON CONFLICT DO NOTHING;`;
      if (Buffer.byteLength(statement) > MAX_STATEMENT_BYTES)
        throw new RestoreError(
          `${table.name}/${String(row[table.columns[0] ?? ''])}: the row exceeds D1's statement limit`,
        );
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
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))
    throw new RestoreError("--database-name must be the new database's name");
  return [
    '# The restore target of tasks/tools/backup-restore.ts config (tasks/docs/backup.md). Only for `wrangler d1',
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

/** Row counts and the applied migration of the restored database, compared with the manifest. */
function verifyLines(section: TasksSection, found: Row): { ok: boolean; lines: string[] } {
  const applied = JSON.parse(found.migrations as string) as string[];
  let ok = applied.includes(section.schema_version);
  const lines = [`${ok ? 'PASS' : 'FAIL'} schema_version ${section.schema_version}${ok ? '' : ' (not applied)'}`];
  for (const table of section.tables) {
    const matches = found[table.name] === table.rows;
    ok &&= matches;
    lines.push(`${matches ? 'PASS' : 'FAIL'} ${table.name} rows=${String(found[table.name])}/${String(table.rows)}`);
  }
  return { ok, lines };
}

function verify(root: string, args: string[]): { ok: boolean; lines: string[] } {
  const { section } = readBackup(root);
  const counts = section.tables.map((table) => `(SELECT count(*) FROM ${table.name}) AS ${table.name}`);
  const query = `SELECT (SELECT json_group_array(name) FROM d1_migrations) AS migrations, ${counts.join(', ')}`;
  const [command = WRANGLER, ...prefix] = (option(args, '--wrangler') ?? WRANGLER).split(/\s+/);
  const config = option(args, '--config');
  if (!config) throw new RestoreError('verify needs --config (the restore target)');
  const target = args.includes('--remote') ? ['--remote'] : ['--local'];
  const persist = option(args, '--persist-to');
  if (persist) target.push('--persist-to', persist);
  let output: string;
  try {
    const execute = ['d1', 'execute', 'DB', '--json', '--config', config, ...target, '--command', query];
    output = execFileSync(command, [...prefix, ...execute], {
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new RestoreError('wrangler d1 execute failed');
  }
  const found = (JSON.parse(output) as { results: Row[] }[])[0]?.results[0];
  if (!found) throw new RestoreError('wrangler returned an unexpected result shape');
  return verifyLines(section, found);
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
  if (command === 'config') {
    const out = required('--out');
    await privateText(out, restoreConfig(required('--database-name'), required('--database-id')));
    lines = [`wrote ${out}`];
  } else if (command === 'sql') {
    const backup = readBackup(required('--in'));
    const { sql, statements } = restoreSql(backup);
    await privateText(required('--out'), sql);
    const { start, end } = backup.section.change_sequence;
    lines = backup.section.tables.map((table) => `PASS ${table.name} rows=${String(table.rows)}`);
    lines.push(`statements=${String(statements)}`);
    if (start !== end)
      lines.unshift(
        `WARN Tasks changed while the backup ran (change ${String(start)} to ${String(end)}): rows may mix both`,
      );
  } else if (command === 'verify') {
    ({ ok, lines } = verify(required('--in'), args));
  } else {
    throw new RestoreError('use config, sql or verify');
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
      const exists = (error as { code?: string }).code === 'EEXIST';
      const message =
        error instanceof RestoreError || error instanceof ExportError
          ? error.message
          : exists
            ? 'the output exists; nothing was written'
            : 'restore failed';
      console.error(`FAIL: ${message}`);
      process.exitCode = 1;
    },
  );
