/**
 * Restoring a daily backup (backup.ts) into an empty store (../../docs/backup.md "Restore"). The owner starts it with
 * StartBackupRestore (api.ts), behind the Worker's Access, Origin and CSRF checks; MailsortState reads the named
 * backup from its own BACKUPS bucket and loads it in bounded Alarm steps a second apart (state.ts tick):
 *
 * 1. schema: every table of the store is dropped and the backup's tables and indexes are created from its manifest,
 *    in one transaction. The store held none of the owner's records when the restore started (backup.ts storeEmpty),
 *    or only what a failed restore loaded;
 * 2. rows: at most RESTORE_STEP_PARTS parts (RESTORE_STEP_BYTES) per step, each read from R2 and checked against the
 *    manifest's SHA-256 and row count before it is inserted; the inserts and the cursor's move are one transaction,
 *    so a failed step repeats nothing. At most RESTORE_ROWS_PER_DAY SQLite rows are written per UTC day: the
 *    account's free allowance is shared by every Durable Object;
 * 3. finish: every table's rows are counted against the manifest (the verification GetBackupRestore shows), the
 *    store is migrated from the backup's schema version, and the restored state is made safe for the pipeline: ledger
 *    intents in flight become history (writes.ts abandonInFlight) and nothing is sent to Gmail again, an unfinished
 *    unread batch ends, and the Gmail history cursor is dropped, so intake resumes from the mailbox's current state
 *    and label changes made since the backup are never read as the owner's feedback. The daily backup then runs at once.
 *
 * Until it succeeds every other mutation is refused (RESTORE_ACTIVE) and neither the pipeline nor the backup runs.
 * BACKUP_MAX_ERRORS failed steps in a row fail it; StartBackupRestore starts a failed one again from step 1. Its state
 * lives in the object's key-value storage (`restore`), which no step drops. Table names, counts and codes are logged.
 */
import { BackupRestore_State, BackupRestoreSchema, type BackupRestore } from '@ziyixi/proto/mailsort/ui/v2/backup_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { BACKUP_FORMAT, BACKUP_PREFIX, MANIFEST, resetBackup, sqlName, storeEmpty, storeTables, type BackupManifest, type Kv } from './backup.ts';
import { BACKUP_CONTINUE_MS, BACKUP_MAX_ERRORS, BACKUP_STEP_RETRY_MS, DAY, RESTORE_ROWS_PER_DAY, RESTORE_STEP_BYTES, RESTORE_STEP_PARTS } from './limits.ts';
import { REASONS, sortError } from './reasons.ts';
import { SCHEMA_VERSION, senderHashesToBackfill, utcDay, type Store, type Value } from './store.ts';
import { endUnread } from './unread.ts';
import { abandonInFlight } from './writes.ts';

const STATE_KEY = 'restore';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface RestoreState {
  state: 'running' | 'succeeded' | 'failed';
  backup: string;
  schema_version: number;
  started_at: number;
  ended_at: number | null;
  /** `migrate` once `finish` verified the counts. */
  step: 'schema' | 'rows' | 'finish' | 'migrate';
  /** The manifest's table and part that load next. */
  table: number;
  part: number;
  errors: number;
  error_code: string;
  /** When the next step may run (ms). */
  next_step: number;
  /** The UTC day of `day_rows`, the SQLite rows the restore wrote on it. */
  day: string;
  day_rows: number;
  tables: { name: string; backup_rows: number; restored_rows: number }[];
}

export interface RestoreDeps {
  readonly store: Store;
  readonly kv: Kv;
  readonly bucket: R2Bucket | undefined;
  readonly transact: <T>(fn: () => T) => T;
}

/** A failure of the backup's own content, with its safe code. */
class RestoreFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ restore: fields }));
}

export function restoreState(kv: Kv): RestoreState | null {
  return kv.get<RestoreState>(STATE_KEY) ?? null;
}

/** A restore runs or failed: every other mutation waits, and so do the pipeline and the backup. */
export function restoreUnfinished(kv: Kv): boolean {
  const state = restoreState(kv);
  return state !== null && state.state !== 'succeeded';
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The manifest of `prefix`, every name, statement and part checked against the format before anything is loaded. */
async function readManifest(bucket: R2Bucket, prefix: string): Promise<BackupManifest> {
  const object = await bucket.get(prefix + MANIFEST);
  if (object === null) throw new RestoreFailure('manifest_missing');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await object.text()) as BackupManifest;
  } catch {
    throw new RestoreFailure('manifest_invalid');
  }
  const names = new Set<string>();
  const valid = manifest.format === BACKUP_FORMAT && count(manifest.schema_version) && manifest.schema_version > 0 && Array.isArray(manifest.tables)
    && manifest.tables.every((table) => {
      if (!IDENTIFIER.test(table.name) || table.name.startsWith('sqlite_') || table.name.startsWith('_cf_') || names.has(table.name)) return false;
      names.add(table.name);
      const statement = (sql: unknown, pattern: RegExp) => typeof sql === 'string' && pattern.test(sql) && !sql.includes(';');
      return statement(table.sql, new RegExp(`^CREATE TABLE "?${table.name}"?\\s*\\(`))
        && Array.isArray(table.indexes) && table.indexes.every((sql) => statement(sql, new RegExp(`^CREATE (UNIQUE )?INDEX [^;]* ON "?${table.name}"?\\s*\\(`)))
        && Array.isArray(table.columns) && table.columns.length > 0 && table.columns.every((column) => IDENTIFIER.test(column))
        && count(table.rows) && Array.isArray(table.parts)
        && table.parts.every((part) => part.key.startsWith(`${prefix}${table.name}/`) && !part.key.includes('..') && SHA256.test(part.sha256) && count(part.rows) && count(part.bytes))
        && table.parts.reduce((sum, part) => sum + part.rows, 0) === table.rows;
    })
    && names.has('meta');
  if (!valid) throw new RestoreFailure('manifest_invalid');
  return manifest;
}

/** Answers whether a restore may start now: a store with none of the owner's records, or after a failed restore. */
function refuseUnlessReady(deps: RestoreDeps): void {
  const current = restoreState(deps.kv);
  if (current?.state === 'running') throw sortError('RESTORE_ACTIVE');
  if (current?.state === 'succeeded' || (current === null && !storeEmpty(deps.store))) throw sortError('RESTORE_TARGET_NOT_EMPTY');
}

/** StartBackupRestore: checks the target and the backup's manifest, then records the restore; the Alarm loads it. */
export async function startRestore(deps: RestoreDeps, backup: string, now: number): Promise<RestoreState> {
  const prefix = backup.endsWith('/') ? backup : `${backup}/`;
  if (!BACKUP_PREFIX.test(prefix)) throw new RpcError(REASONS.BAD_REQUEST.code, 'BAD_REQUEST', 'backup must be a prefix like backups/2026-10-28T114100Z/');
  const bucket = deps.bucket;
  if (bucket === undefined) throw sortError('BACKUP_NOT_RESTORABLE');
  refuseUnlessReady(deps);
  let manifest: BackupManifest;
  try {
    manifest = await readManifest(bucket, prefix);
  } catch (error) {
    if (error instanceof RestoreFailure) throw sortError('BACKUP_NOT_RESTORABLE');
    throw sortError('DEPENDENCY_UNAVAILABLE');
  }
  // A backup made by a newer release has a schema this one cannot migrate from.
  if (manifest.schema_version > SCHEMA_VERSION) throw sortError('BACKUP_NOT_RESTORABLE');
  return deps.transact(() => {
    refuseUnlessReady(deps);
    const state: RestoreState = {
      state: 'running', backup: prefix, schema_version: manifest.schema_version, started_at: now, ended_at: null, step: 'schema', table: 0, part: 0,
      errors: 0, error_code: '', next_step: now, day: utcDay(now), day_rows: 0,
      tables: manifest.tables.map((table) => ({ name: table.name, backup_rows: table.rows, restored_rows: 0 })),
    };
    deps.kv.put(STATE_KEY, state);
    log({ started: prefix, tables: manifest.tables.length });
    return state;
  });
}

/** Runs the restore step due at `now`; answers when the next one is due (Infinity once it ended). */
export async function runRestore(deps: RestoreDeps, now: number): Promise<number> {
  const state = restoreState(deps.kv);
  if (state?.state !== 'running') return Infinity;
  if (state.next_step > now) return state.next_step;
  if (state.day !== utcDay(now)) {
    state.day = utcDay(now);
    state.day_rows = 0;
  }
  const step = state.step;
  try {
    if (deps.bucket === undefined) throw new RestoreFailure('no_bucket');
    const manifest = await readManifest(deps.bucket, state.backup);
    state.next_step = now + BACKUP_CONTINUE_MS;
    if (step === 'schema') schemaStep(deps, state, manifest);
    else if (step === 'rows') await rowsStep(deps, deps.bucket, state, manifest, now);
    else await finishStep(deps, state, manifest, now);
    state.errors = 0;
  } catch (error) {
    // R2 or SQLite failed, or the backup itself is broken: the step runs again from what is loaded.
    state.errors += 1;
    state.next_step = now + BACKUP_STEP_RETRY_MS;
    const code = error instanceof RestoreFailure ? error.code : 'storage_error';
    log({ error: code, step, errors: state.errors });
    if (state.errors >= BACKUP_MAX_ERRORS) {
      state.state = 'failed';
      state.error_code = code;
      state.ended_at = now;
      log({ failed: code, backup: state.backup });
    }
  }
  deps.kv.put(STATE_KEY, state);
  return state.state === 'running' ? state.next_step : Infinity;
}

/** Every table dropped and the backup's created, with its indexes, in one transaction. */
function schemaStep(deps: RestoreDeps, state: RestoreState, manifest: BackupManifest): void {
  const { store } = deps;
  deps.transact(() => {
    for (const table of storeTables(store)) store.run(`DROP TABLE ${sqlName(table.name)}`);
    for (const table of manifest.tables) store.run(table.sql);
    for (const table of manifest.tables) for (const index of table.indexes) store.run(index);
    deps.kv.put(STATE_KEY, { ...state, step: 'rows' } satisfies RestoreState);
  });
  state.step = 'rows';
}

function bytesOf(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** One stored JSON value back as SQLite's (backup.ts encodeValue). */
function decodeValue(value: unknown): Value {
  if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'object' && 'blob' in value && typeof value.blob === 'string') return bytesOf(value.blob);
  if (typeof value === 'object' && 'real' in value && (value.real === 'Infinity' || value.real === '-Infinity')) return Number(value.real);
  throw new RestoreFailure('part_rows');
}

async function sha256(data: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Parts, each checked, then inserted with the cursor's move in one transaction, within the step's and the day's budget. */
async function rowsStep(deps: RestoreDeps, bucket: R2Bucket, state: RestoreState, manifest: BackupManifest, now: number): Promise<void> {
  const { store } = deps;
  let parts = 0;
  let bytes = 0;
  while (parts < RESTORE_STEP_PARTS && bytes < RESTORE_STEP_BYTES) {
    if (state.day_rows >= RESTORE_ROWS_PER_DAY) {
      state.next_step = Math.floor(now / DAY) * DAY + DAY;
      log({ waiting: 'daily_rows', rows: state.day_rows });
      return;
    }
    const table = manifest.tables[state.table];
    if (table === undefined) {
      state.step = 'finish';
      return;
    }
    const part = table.parts[state.part];
    if (part === undefined) {
      state.table += 1;
      state.part = 0;
      continue;
    }
    const object = await bucket.get(part.key);
    if (object === null) throw new RestoreFailure('part_missing');
    const data = new Uint8Array(await object.arrayBuffer());
    if ((await sha256(data)) !== part.sha256) throw new RestoreFailure('part_checksum');
    let rows: Value[][];
    try {
      const text = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      rows = text.split('\n').filter((line) => line !== '').map((line) => {
        const row = JSON.parse(line) as unknown;
        if (!Array.isArray(row) || row.length !== table.columns.length) throw new RestoreFailure('part_rows');
        return row.map(decodeValue);
      });
    } catch {
      throw new RestoreFailure('part_rows');
    }
    if (rows.length !== part.rows) throw new RestoreFailure('part_rows');
    const insert = `INSERT INTO ${sqlName(table.name)} (${table.columns.map(sqlName).join(', ')}) VALUES (${table.columns.map(() => '?').join(', ')})`;
    const index = state.table;
    const next = deps.transact(() => {
      let written = 0;
      for (const row of rows) written += store.run(insert, ...row);
      const moved: RestoreState = {
        ...state,
        part: state.part + 1,
        day_rows: state.day_rows + written,
        tables: state.tables.map((entry, at) => (at === index ? { ...entry, restored_rows: entry.restored_rows + rows.length } : entry)),
      };
      deps.kv.put(STATE_KEY, moved);
      return moved;
    });
    Object.assign(state, next);
    parts += 1;
    bytes += data.byteLength;
  }
}

/** Counts against the manifest, the migration, the safe pipeline state; then the restore has succeeded. */
async function finishStep(deps: RestoreDeps, state: RestoreState, manifest: BackupManifest, now: number): Promise<void> {
  const { store } = deps;
  // Counted once: a repeat after the migration below (the step failed, or the object restarted after it) keeps the
  // verified counts, since a migration may add, drop or change rows and tables.
  if (state.step === 'finish') {
    state.tables = manifest.tables.map((table) => ({ name: table.name, backup_rows: table.rows, restored_rows: store.count(`SELECT count(*) AS n FROM ${sqlName(table.name)}`) }));
    if (state.tables.some((table) => table.restored_rows !== table.backup_rows)) throw new RestoreFailure('count_mismatch');
    state.step = 'migrate';
    deps.kv.put(STATE_KEY, state);
  }
  store.migrate(deps.transact, await senderHashesToBackfill(store));
  const done: RestoreState = { ...state, state: 'succeeded', ended_at: now };
  const abandoned = deps.transact(() => {
    const rows = abandonInFlight(store, 'restored');
    endUnread(store);
    store.deleteMeta('history_cursor');
    deps.kv.put(STATE_KEY, done);
    resetBackup(deps.kv);
    return rows;
  });
  Object.assign(state, done);
  log({ succeeded: state.backup, tables: state.tables.length, rows: state.tables.reduce((sum, table) => sum + table.restored_rows, 0), abandoned });
}

const STATES: Readonly<Record<RestoreState['state'], BackupRestore_State>> = {
  running: BackupRestore_State.RUNNING,
  succeeded: BackupRestore_State.SUCCEEDED,
  failed: BackupRestore_State.FAILED,
};

export function restoreMessage(state: RestoreState, now: number): BackupRestore {
  const waiting = state.state === 'running' && state.next_step > now + BACKUP_STEP_RETRY_MS;
  return create(BackupRestoreSchema, {
    name: 'backupRestore',
    state: STATES[state.state],
    backup: state.backup,
    schemaVersion: state.schema_version,
    startTime: timestampFromMs(state.started_at),
    ...(state.ended_at === null ? {} : { endTime: timestampFromMs(state.ended_at) }),
    ...(waiting ? { resumeTime: timestampFromMs(state.next_step) } : {}),
    errorCode: state.error_code,
    tables: state.tables.map((table) => ({ table: table.name, backupRows: table.backup_rows, restoredRows: table.restored_rows })),
  });
}
