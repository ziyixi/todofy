#!/usr/bin/env node
/** Restore request logs into an empty, migrated D1 and a newly created private body bucket. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { bodyKey, hasRetainedBody, pageKey, type BackupComplete, type RequestRow } from '../worker/src/backup.ts';

const APP = resolve(import.meta.dirname, '..');
const REPO = dirname(APP);
const WRANGLER = resolve(APP, 'worker/node_modules/.bin/wrangler');
const BACKUP_BUCKET = 'model-router-backups';
const MAX_SQL_BYTES = 90_000;

export class RestoreError extends Error {}
export interface LocalBackup {
  complete: BackupComplete;
  rows: RequestRow[];
  bodyKeys: string[];
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function readMetadata(directory: string): LocalBackup {
  const complete = JSON.parse(readFileSync(resolve(directory, 'complete.json'), 'utf8')) as BackupComplete;
  if (![complete.page_count, complete.requests, complete.bodies, complete.body_bytes, complete.started_ms, complete.completed_ms].every(count))
    throw new RestoreError('invalid_backup_completion');
  const rows: RequestRow[] = [];
  for (let page = 0; page < complete.page_count; page += 1) {
    const data = new TextDecoder().decode(gunzipSync(readFileSync(resolve(directory, pageKey('', page)))));
    for (const line of data.split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as RequestRow;
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || row.state === 'running')
        throw new RestoreError('invalid_backup_request');
      rows.push(row);
    }
  }
  if (rows.length !== complete.requests) throw new RestoreError('backup_request_count_mismatch');
  const bodyKeys = rows.filter((row) => hasRetainedBody(row, complete.started_ms)).map((row) => {
    bodyKey('', row.body_key);
    return row.body_key;
  });
  if (bodyKeys.length !== complete.bodies) throw new RestoreError('backup_body_count_mismatch');
  return { complete, rows, bodyKeys };
}

export function verifyFiles(backup: LocalBackup, directory: string): void {
  const bytes = backup.bodyKeys.reduce((sum, key) => sum + statSync(resolve(directory, 'bodies', key)).size, 0);
  if (bytes !== backup.complete.body_bytes) throw new RestoreError('backup_body_bytes_mismatch');
}

function literal(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new RestoreError('invalid_backup_value');
}

/** Explicit columns preserve every SELECT * value, including historical generation JSON and expiry. */
export function restoreSql(backup: LocalBackup): string {
  return backup.rows.map((row) => {
    const columns = Object.keys(row);
    if (!columns.every((column) => /^[a-z_][a-z0-9_]*$/.test(column))) throw new RestoreError('invalid_backup_column');
    const line = `INSERT INTO requests (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map((column) => literal(row[column])).join(',')});`;
    if (new TextEncoder().encode(line).length > MAX_SQL_BYTES) throw new RestoreError('backup_row_exceeds_d1_statement_limit');
    return line;
  }).join('\n') + '\n';
}

function wrangler(args: string[]): string {
  try {
    return execFileSync(WRANGLER, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new RestoreError('wrangler_operation_failed');
  }
}

function option(args: string[], key: string): string {
  const index = args.indexOf(key);
  if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new RestoreError(`required_option_${key.slice(2)}`);
  return args[index + 1]!;
}

function privateDirectory(path: string): string {
  const directory = resolve(path);
  const fromRepo = relative(REPO, directory);
  if (fromRepo === '' || (fromRepo !== '..' && !fromRepo.startsWith('../') && !isAbsolute(fromRepo))) throw new RestoreError('backup_directory_must_be_outside_checkout');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function download(date: string, directory: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new RestoreError('invalid_backup_date');
  const prefix = `daily/${date}/`;
  function get(key: string, local: string): void {
    const path = resolve(directory, local);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    wrangler(['r2', 'object', 'get', `${BACKUP_BUCKET}/${prefix}${key}`, '--file', path, '--remote']);
    chmodSync(path, 0o600);
  }
  get('complete.json', 'complete.json');
  const marker = JSON.parse(readFileSync(resolve(directory, 'complete.json'), 'utf8')) as BackupComplete;
  if (!count(marker.page_count)) throw new RestoreError('invalid_backup_completion');
  for (let page = 0; page < marker.page_count; page += 1) get(pageKey('', page), pageKey('', page));
  const backup = readMetadata(directory);
  for (const key of backup.bodyKeys) get(`bodies/${key}`, `bodies/${key}`);
  verifyFiles(backup, directory);
  console.log(JSON.stringify({ requests: backup.complete.requests, bodies: backup.complete.bodies, body_bytes: backup.complete.body_bytes }));
}

function databaseCount(config: string): number {
  const result = JSON.parse(wrangler(['d1', 'execute', 'DB', '--config', config, '--command', 'SELECT count(*) AS n FROM requests', '--json', '--remote'])) as { results?: { n?: number }[] }[];
  const found = result[0]?.results?.[0]?.n;
  if (!count(found)) throw new RestoreError('invalid_restore_count_response');
  return found;
}

function restore(directory: string, config: string, bucket: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket) || ['model-router-request-bodies', BACKUP_BUCKET].includes(bucket))
    throw new RestoreError('new_empty_body_bucket_required');
  const backup = readMetadata(directory);
  verifyFiles(backup, directory);
  if (databaseCount(config) !== 0) throw new RestoreError('restore_database_not_empty');
  const sqlFile = resolve(directory, 'requests.sql');
  writeFileSync(sqlFile, restoreSql(backup), { mode: 0o600 });
  let uploaded = 0;
  for (const key of backup.bodyKeys) {
    wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--file', resolve(directory, 'bodies', key), '--content-type', 'application/json', '--remote']);
    uploaded += 1;
  }
  if (backup.rows.length) wrangler(['d1', 'execute', 'DB', '--config', config, '--file', sqlFile, '--remote']);
  const restored = databaseCount(config);
  if (restored !== backup.complete.requests || uploaded !== backup.complete.bodies) throw new RestoreError('restore_count_mismatch');
  console.log(JSON.stringify({ restored_requests: restored, uploaded_bodies: uploaded, body_bytes: backup.complete.body_bytes }));
}

function main(args: string[]): void {
  const command = args[0];
  if (command === 'download') download(option(args, '--date'), privateDirectory(option(args, '--out')));
  else if (command === 'restore') restore(privateDirectory(option(args, '--in')), resolve(option(args, '--config')), option(args, '--bucket'));
  else throw new RestoreError('usage_download_or_restore');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof RestoreError ? error.message : 'invalid_backup_or_command');
    process.exitCode = 1;
  }
}
