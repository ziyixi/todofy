#!/usr/bin/env node
/**
 * Restore a weekly backup of Tasks (worker/src/backup-runner.ts; docs/backup.md) into a new, empty D1.
 *
 *   download  fetch a backup's manifest and parts from R2 with `wrangler r2 object get` into a private directory
 *           outside the repository, and check every part. By default the newest backup of `tasks-backups` (its
 *           latest.json); `--backup backups/<job start>` names one, and `--bucket todofy-backups` reads one of the
 *           older backups Todofy made of Tasks (its `tasks` section) until they rotate out.
 *   config  write the restore target's wrangler config: its DB binding, the committed account and the absolute
 *           tasks/migrations. It refuses the production database's id or name, a path inside the repository and an
 *           existing file. It has no Worker, so nothing can be deployed with it.
 *   sql     check every Tasks part against the manifest again and write one SQL file of INSERTs, parents first;
 *           the triggers rebuild task_labels, project_archived and the change feed. It refuses a live row whose
 *           project, section, parent or label is not in the backup (naming ids only) and a statement over D1's limit.
 *   verify  compare the restored database's row counts with the manifest and check that its migration is applied.
 *
 * A backup made before 0005_focus.sql has no Focus tables; it restores with them empty and the migration's idle timer.
 * One made before 0006_planning.sql has no planning columns or tables: its tasks take the columns' defaults (no
 * planning facts) and the tables restore empty, but for the migration's empty Review board. One made before
 * 0007_timer_pause.sql has no focus_timer.paused_at: the INSERT names the backup's columns, so a paused timer restores
 * with it NULL and resumes now, as a pause made before that release does. One made before 0008_mail_gtd_inbox.sql has
 * no mail categories, GTD days, weekly reviews or TaskInbox tables: they restore as migrated (no categories).
 * One made before 0009_goals.sql restores the annual goal tables empty and task/Bet links unset.
 *
 *   node tools/backup-restore.ts download --out <outside>/restore --remote
 *   node tools/backup-restore.ts config --database-name tasks-restore --database-id <uuid> --out <outside>/restore.toml
 *   node tools/backup-restore.ts sql --in <outside>/restore --out <outside>/tasks-restore.sql
 *   node tools/backup-restore.ts verify --in <outside>/restore --config <outside>/restore.toml --remote
 *
 * A download directory holds manifest.json and parts/<key>. `--local --persist-to <dir>` in place of `--remote`
 * works on a local copy. Files are written owner-only and row contents are never printed. Node only, no dependencies.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ExportError, privateText } from './todoist-export.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTION_CONFIG = resolve(APP, 'wrangler.toml');
const MIGRATIONS = resolve(APP, 'migrations');
const WRANGLER = resolve(APP, 'worker/node_modules/.bin/wrangler');
/** Tasks' own backups, and the ones Todofy made of Tasks before (their `tasks` section). */
const FORMATS = ['tasks-d1-backup-v1', 'todofy-d1-backup-v1'];
const BUCKET = 'tasks-backups';
const PREFIX = /^backups\/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\/$/;
/** D1 refuses a statement over 100 KB. A task row holds at most about 50 KB. */
export const MAX_STATEMENT_BYTES = 90_000;
/** Each table after the tables its rows reference. */
export const RESTORE_ORDER = [
  'projects',
  'sections',
  'labels',
  'filters',
  'objectives',
  'key_results',
  'goal_progress',
  'tasks',
  'completions',
  'requests',
  'day_steps',
  'focus_entries',
  'focus_timer',
  'task_dependencies',
  'weekly_bets',
  'plan_board',
  'mail_settings',
  'gtd_days',
  'weekly_reviews',
  'task_inbox_routes',
  'task_inbox_days',
];
/** The tables 0005_focus.sql added. Older backups lack all three; the migration seeds the one timer row. */
export const FOCUS_TABLES = ['day_steps', 'focus_entries', 'focus_timer'];
/** The tables 0006_planning.sql added. Older backups lack all three; the migration seeds the one board row. */
export const PLANNING_TABLES = ['task_dependencies', 'weekly_bets', 'plan_board'];
/** The tables 0008_mail_gtd_inbox.sql added. Older backups lack all five; the migration seeds the one settings row. */
export const MAIL_GTD_TABLES = ['mail_settings', 'gtd_days', 'weekly_reviews', 'task_inbox_routes', 'task_inbox_days'];
/** The tables 0009_goals.sql added. Older backups restore them empty and task/Bet links unset. */
export const GOAL_TABLES = ['objectives', 'key_results', 'goal_progress'];
/** The tables later migrations added, oldest first: a backup lacks every table added after it was made. */
const ADDED = [
  { migration: '0005_focus.sql', tables: FOCUS_TABLES },
  { migration: '0006_planning.sql', tables: PLANNING_TABLES },
  { migration: '0008_mail_gtd_inbox.sql', tables: MAIL_GTD_TABLES },
  { migration: '0009_goals.sql', tables: GOAL_TABLES },
];
/** The one row a migration seeds, which a backed-up row of that table replaces. */
const SEEDED = ['focus_timer', 'plan_board', 'mail_settings'];

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
  if (!FORMATS.includes(manifest.format as string))
    throw new RestoreError(`manifest.json: format is not ${FORMATS.join(' or ')}`);
  const section = manifest.tasks;
  if (!section)
    throw new RestoreError('manifest.json has no tasks section: Todofy made the backup before Tasks was in it');
  const names = section.tables.map((table) => table.name);
  const given = [...names].sort().join();
  const generations = ADDED.map((_, index) => ADDED.slice(index).flatMap((added) => added.tables));
  if (![[], ...generations].some((later) => given === RESTORE_ORDER.filter((name) => !later.includes(name)).sort().join()))
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
  const objectives = live('objectives');
  const results = live('key_results');
  const missing: string[] = [];
  for (const [id, result] of results)
    if (!objectives.has(result.objective_id as string)) missing.push(`keyResults/${id}: objective ${result.objective_id as string}`);
  for (const [id, progress] of live('goal_progress'))
    if (!results.has(progress.key_result_id as string)) missing.push(`goalProgress/${id}: Key Result ${progress.key_result_id as string}`);
  for (const bet of rows.get('weekly_bets') ?? [])
    if (bet.key_result_id && !results.has(bet.key_result_id as string)) missing.push(`weeklyBets/${bet.week_start as string}-${bet.area as string}: Key Result ${bet.key_result_id as string}`);
  for (const [id, project] of projects)
    if (project.parent_id && !projects.has(project.parent_id as string))
      missing.push(`projects/${id}: parent ${project.parent_id as string}`);
  for (const [id, task] of tasks) {
    if (task.key_result_id && !results.has(task.key_result_id as string)) missing.push(`tasks/${id}: Key Result ${task.key_result_id as string}`);
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

/** The tables a backup lacks, with the rows a migrated database holds in them: none, or the one seeded row. */
export function missingTables(section: TasksSection): { name: string; rows: number; migration: string }[] {
  const names = new Set(section.tables.map((table) => table.name));
  return ADDED.flatMap(({ migration, tables }) =>
    tables
      .filter((name) => !names.has(name))
      .map((name) => ({ name, rows: SEEDED.includes(name) ? 1 : 0, migration })),
  );
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
    // The migration seeded an idle timer, an empty board and no mail categories; the backed-up ones take their place.
    if (SEEDED.includes(table.name) && ordered.length) lines.push(`DELETE FROM ${table.name};`);
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
  for (const table of [...section.tables, ...missingTables(section)]) {
    const matches = found[table.name] === table.rows;
    ok &&= matches;
    lines.push(`${matches ? 'PASS' : 'FAIL'} ${table.name} rows=${String(found[table.name])}/${String(table.rows)}`);
  }
  return { ok, lines };
}

function verify(root: string, args: string[]): { ok: boolean; lines: string[] } {
  const { section } = readBackup(root);
  const counts = [...section.tables, ...missingTables(section)].map(
    (table) => `(SELECT count(*) FROM ${table.name}) AS ${table.name}`,
  );
  const query = `SELECT (SELECT json_group_array(name) FROM d1_migrations) AS migrations, ${counts.join(', ')}`;
  const { command, prefix, target } = wranglerCommand(args);
  const config = option(args, '--config');
  if (!config) throw new RestoreError('verify needs --config (the restore target)');
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

/** `wrangler` from `--wrangler` (a command line) or the Worker's own, and the target flags of `args`. */
function wranglerCommand(args: string[]) {
  const [command = WRANGLER, ...prefix] = (option(args, '--wrangler') ?? WRANGLER).split(/\s+/);
  const target = args.includes('--remote') ? ['--remote'] : ['--local'];
  const persist = option(args, '--persist-to');
  if (persist) target.push('--persist-to', persist);
  return { command, prefix, target };
}

/** The download directory: created owner-only, never inside the repository (it holds task content). */
function privateDirectory(path: string): string {
  const root = resolve(realpathSync(dirname(resolve(path))), basename(resolve(path)));
  const rel = relative(realpathSync(resolve(APP, '..')), root);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel)))
    throw new RestoreError('the download directory is inside the repository');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
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
  if (!PREFIX.test(backup)) throw new RestoreError('the backup is not a prefix like backups/2026-10-25T100000Z/');
  get(`${backup}manifest.json`, resolve(root, 'manifest.json'));
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as { tasks?: TasksSection };
  for (const table of manifest.tasks?.tables ?? [])
    for (const part of table.parts) {
      if (!part.key.startsWith(backup) || part.key.split('/').includes('..'))
        throw new RestoreError('a part key leaves the backup');
      get(part.key, resolve(root, 'parts', part.key));
    }
  const { section } = readBackup(root);
  return [
    `backup ${backup}`,
    ...section.tables.map(
      (table) => `PASS ${table.name} rows=${String(table.rows)} parts=${String(table.parts.length)}`,
    ),
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
    const { start, end } = backup.section.change_sequence;
    lines = backup.section.tables.map((table) => `PASS ${table.name} rows=${String(table.rows)}`);
    lines.push(`statements=${String(statements)}`);
    for (const migration of ADDED.map((added) => added.migration)) {
      const absent = missingTables(backup.section).filter((table) => table.migration === migration);
      if (absent.length)
        lines.push(
          `NOTE ${absent.map((table) => table.name).join(', ')}: not in this backup (made before ${migration}); they restore as migrated`,
        );
    }
    if (start !== end)
      lines.unshift(
        `WARN Tasks changed while the backup ran (change ${String(start)} to ${String(end)}): rows may mix both`,
      );
  } else if (command === 'verify') {
    ({ ok, lines } = verify(required('--in'), args));
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
