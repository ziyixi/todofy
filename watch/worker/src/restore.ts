/**
 * A restore of a daily backup (backup.ts) into an empty WatchState (../../docs/backup.md "Restore"). The owner starts it
 * with RestoreBackup (api.ts, behind Access, Origin and CSRF like every owner mutation; the private service binding may
 * not call it). It runs inside the object, from its own BACKUPS bucket, one bounded step per alarm a second apart:
 *
 *   clear     the store's operational rows (a new object has a few from its alarm), in one transaction;
 *   evidence  each evidence object of the manifest back into the evidence bucket (EVIDENCE_STORE), its copy's SHA-256
 *             checked first; an object the bucket already holds with the same size stays as it is;
 *   tables    each part: its SHA-256 and row count checked against the manifest, then its rows inserted with the
 *             cursor in one transaction, so a repeated step never inserts a part twice;
 *   finish    the rows of every table counted against the manifest (the verification the status shows), then what
 *             keeps an old state from acting again: every undelivered notification and every task request not yet
 *             created is settled without sending (the changes stay in the inbox), and the event feed's sequence moves
 *             RESTORE_SEQUENCE_GAP ahead with its floor, so a reader's saved position expires (CURSOR_EXPIRED: one gap,
 *             then a new baseline) and no new event repeats a sequence it saw.
 *
 * The evidence goes first, so no row is visible before the objects it names. Until the restore succeeds every other
 * write is refused (RESTORE_RUNNING), the scheduler and the daily backup wait. MAX_ERRORS failed steps in a row fail
 * it: writes stay refused, and repeating RestoreBackup starts again from `clear`.
 *
 * Logs carry steps, counts and codes only.
 */
import {
  BACKUP_FORMAT,
  BACKUP_NAME,
  backupRunning,
  backupTables,
  decodeCell,
  EVIDENCE_ROOT,
  EXCLUDED_TABLES,
  failureCode,
  LATEST,
  MANIFEST,
  OWN_META,
  quoted,
  storeIsEmpty,
  type Manifest,
} from './backup.ts';
import { sha256Hex } from './config.ts';
import { gunzip } from './snapshot.ts';
import { SCHEMA_VERSION, type Store } from './store.ts';

/** Rows (decompressed) a step loads at most. */
export const RESTORE_STEP_BYTES = 16 * 1024 * 1024;
/** Evidence objects a step copies back at most, and their bytes. */
export const RESTORE_EVIDENCE = 40;
export const RESTORE_EVIDENCE_BYTES = 24 * 1024 * 1024;
export const CONTINUE_MS = 1000;
export const ERROR_RETRY_MS = 60_000;
export const MAX_ERRORS = 3;
/**
 * How far the event feed's sequence moves after a restore: more events than the app makes in centuries (a few
 * thousand a day at its bounds), so every position saved before the restore is below the new floor.
 */
export const RESTORE_SEQUENCE_GAP = 2 ** 32;

export interface RestoreState {
  backup: string;
  /** The manifest's SHA-256 when the restore started: every step checks it is the same. */
  manifest_sha256: string;
  state: 'running' | 'succeeded' | 'failed';
  phase: 'clear' | 'evidence' | 'tables' | 'finish';
  started_at: number;
  finished_at: number | null;
  error_code: string;
  errors: number;
  evidence_index: number;
  table_index: number;
  part_index: number;
  evidence: { restored: number; present: number; missing: number; mismatched: number };
  tables: { table: string; restored: number; expected: number }[];
}

export type RestoreRefusalReason = 'STORE_NOT_EMPTY' | 'BACKUP_NOT_FOUND' | 'BACKUP_UNSUPPORTED' | 'RESTORE_RUNNING' | 'BACKUP_RUNNING';

/** Why RestoreBackup does not start: an ErrorReason of watch.ui.v1 (api.ts maps it). */
export class RestoreRefusal extends Error {
  readonly reason: RestoreRefusalReason;
  constructor(reason: RestoreRefusalReason) {
    super(reason);
    this.reason = reason;
  }
}

export interface RestoreDeps {
  readonly store: Store;
  readonly backups: R2Bucket | undefined;
  readonly evidence: R2Bucket | undefined;
  readonly transact: <T>(fn: () => T) => T;
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ restore: fields }));
}

export function restoreState(store: Store): RestoreState | null {
  const value = store.getMeta('restore');
  return value === null ? null : (JSON.parse(value) as RestoreState);
}

function saveState(store: Store, state: RestoreState): void {
  store.setMeta('restore', JSON.stringify(state));
}

/** A restore running or not finished: every other write is refused, the scheduler and the backup wait. */
export function restoreBlocking(store: Store): boolean {
  const state = restoreState(store)?.state;
  return state === 'running' || state === 'failed';
}

/** The manifest's own rules and this schema's tables and columns; throws BACKUP_UNSUPPORTED. */
function checkManifest(store: Store, manifest: Manifest, name: string): void {
  const unsupported = () => new RestoreRefusal('BACKUP_UNSUPPORTED');
  if (manifest.format !== BACKUP_FORMAT || !Number.isInteger(manifest.schema_version) || manifest.schema_version < 1 || manifest.schema_version > SCHEMA_VERSION)
    throw unsupported();
  const tables = new Map(backupTables(store).map((table) => [table.name, new Set(table.columns)]));
  tables.set('sqlite_sequence', new Set(['name', 'seq']));
  const seen = new Set<string>();
  for (const table of manifest.tables) {
    const columns = tables.get(table.name);
    if (columns === undefined || seen.has(table.name) || Object.hasOwn(EXCLUDED_TABLES, table.name)) throw unsupported();
    seen.add(table.name);
    if (!Array.isArray(table.columns) || table.columns.length === 0 || !table.columns.every((column) => columns.has(column))) throw unsupported();
    let rows = 0;
    for (const part of table.parts) {
      if (!part.key.startsWith(`${name}${table.name}/`) || part.key.includes('..') || !/^[0-9a-f]{64}$/.test(part.sha256) || !Number.isInteger(part.rows) || part.rows < 0)
        throw unsupported();
      rows += part.rows;
    }
    if (rows !== table.rows) throw unsupported();
  }
  for (const object of manifest.evidence.objects) {
    if (object.key === '' || object.key.startsWith('/') || object.key.split('/').includes('..') || object.key.length > 1024 || !/^[0-9a-f]{64}$/.test(object.sha256) || !Number.isInteger(object.bytes))
      throw unsupported();
  }
  if (!Array.isArray(manifest.evidence.missing)) throw unsupported();
}

/** The manifest of `name` with its SHA-256, or a refusal. */
async function fetchManifest(backups: R2Bucket, name: string): Promise<{ manifest: Manifest; sha256: string }> {
  const object = await backups.get(name + MANIFEST);
  if (object === null) throw new RestoreRefusal('BACKUP_NOT_FOUND');
  const bytes = new Uint8Array(await object.arrayBuffer());
  try {
    return { manifest: JSON.parse(new TextDecoder().decode(bytes)) as Manifest, sha256: await sha256Hex(bytes) };
  } catch {
    throw new RestoreRefusal('BACKUP_UNSUPPORTED');
  }
}

/**
 * RestoreBackup: checks the bindings, the store and the named backup (the newest one when `requested` is empty), then
 * records the restore; the alarm does the rest. Repeating it while the same restore runs changes nothing.
 */
export async function startRestore(deps: RestoreDeps, requested: string, now: number): Promise<void> {
  const { store, backups, evidence } = deps;
  if (backups === undefined || evidence === undefined) throw new RestoreRefusal('BACKUP_NOT_FOUND');
  const refuse = (name: string | null) => {
    const current = restoreState(store);
    if (current?.state === 'running') {
      if (name === null || name === current.backup) return true;
      throw new RestoreRefusal('RESTORE_RUNNING');
    }
    if (backupRunning(store)) throw new RestoreRefusal('BACKUP_RUNNING');
    if (current?.state !== 'failed' && !storeIsEmpty(store)) throw new RestoreRefusal('STORE_NOT_EMPTY');
    return false;
  };
  let name: string | null = requested.trim() === '' ? null : `${requested.trim().replace(/\/+$/, '')}/`;
  if (refuse(name)) return;
  if (name === null) {
    const latest = await backups.get(LATEST);
    const key = latest === null ? null : ((await latest.json<{ key?: unknown }>()).key ?? null);
    if (typeof key !== 'string') throw new RestoreRefusal('BACKUP_NOT_FOUND');
    name = key;
  }
  if (!BACKUP_NAME.test(name)) throw new RestoreRefusal('BACKUP_NOT_FOUND');
  const { manifest, sha256 } = await fetchManifest(backups, name);
  try {
    checkManifest(store, manifest, name);
  } catch (error) {
    // A manifest of another shape fails the checks' own reads.
    throw error instanceof RestoreRefusal ? error : new RestoreRefusal('BACKUP_UNSUPPORTED');
  }
  deps.transact(() => {
    // Again after the reads: a restore or a write may have come meanwhile.
    if (refuse(name)) return;
    saveState(store, {
      backup: name,
      manifest_sha256: sha256,
      state: 'running',
      phase: 'clear',
      started_at: now,
      finished_at: null,
      error_code: '',
      errors: 0,
      evidence_index: 0,
      table_index: 0,
      part_index: 0,
      evidence: { restored: 0, present: 0, missing: 0, mismatched: 0 },
      tables: [],
    });
  });
  log({ started: name, tables: manifest.tables.length, evidence: manifest.evidence.objects.length });
}

/** The restore's step due now, or null when none runs. Answers when the next step is due. */
export async function runRestore(deps: RestoreDeps, now: number): Promise<number | null> {
  const { store, backups, evidence } = deps;
  const state = restoreState(store);
  if (state?.state !== 'running') return null;
  const step = state.phase;
  let next = now + CONTINUE_MS;
  try {
    if (backups === undefined || evidence === undefined) throw new Error('not_bound');
    const { manifest, sha256 } = await fetchManifest(backups, state.backup).catch((error: unknown) => {
      throw new Error(error instanceof RestoreRefusal ? 'manifest_missing' : failureCode(error));
    });
    if (sha256 !== state.manifest_sha256) throw new Error('manifest_changed');
    if (step === 'clear') clear(deps, state);
    else if (step === 'evidence') await evidenceStep(backups, evidence, manifest, state);
    else if (step === 'tables') await tablesStep(deps, backups, manifest, state);
    else finish(deps, manifest, state, now);
    state.errors = 0;
  } catch (error) {
    state.errors += 1;
    next = now + ERROR_RETRY_MS;
    log({ error: failureCode(error), step, errors: state.errors });
    if (state.errors >= MAX_ERRORS) {
      state.state = 'failed';
      state.error_code = failureCode(error);
      state.finished_at = now;
      log({ failed: state.error_code });
    }
  }
  saveState(store, state);
  return next;
}

/** Deletes every backed-up table's rows but the store's own meta, in one transaction. */
function clear({ store, transact }: RestoreDeps, state: RestoreState): void {
  transact(() => {
    for (const { name } of backupTables(store)) {
      if (name === 'meta') store.run(`DELETE FROM meta WHERE key NOT IN (${OWN_META.map(() => '?').join(', ')})`, ...OWN_META);
      else store.run(`DELETE FROM ${quoted(name)}`);
    }
    saveState(store, { ...state, phase: 'evidence' });
  });
  state.phase = 'evidence';
}

/** Copies evidence objects back, each copy's SHA-256 checked first, until the step's copies or bytes are spent. */
async function evidenceStep(backups: R2Bucket, evidence: R2Bucket, manifest: Manifest, state: RestoreState): Promise<void> {
  const objects = manifest.evidence.objects;
  let copies = 0;
  let bytes = 0;
  while (state.evidence_index < objects.length && copies < RESTORE_EVIDENCE && bytes < RESTORE_EVIDENCE_BYTES) {
    const entry = objects[state.evidence_index];
    if (entry === undefined) break;
    const head = await evidence.head(entry.key);
    if (head !== null && head.size === entry.bytes) state.evidence.present += 1;
    else {
      const copy = await backups.get(`${EVIDENCE_ROOT}${entry.key}`);
      if (copy === null) state.evidence.missing += 1;
      else {
        const data = new Uint8Array(await copy.arrayBuffer());
        if (data.byteLength !== entry.bytes || (await sha256Hex(data)) !== entry.sha256) state.evidence.mismatched += 1;
        else {
          await evidence.put(entry.key, data, { httpMetadata: { contentType: copy.httpMetadata?.contentType ?? 'application/octet-stream' } });
          state.evidence.restored += 1;
          copies += 1;
          bytes += data.byteLength;
        }
      }
    }
    state.evidence_index += 1;
  }
  if (state.evidence_index >= objects.length) {
    // What the backup itself could not copy: their snapshots say unavailable, as before.
    state.evidence.missing += manifest.evidence.missing.length;
    state.phase = 'tables';
  }
}

/** Inserts the rows of one part. A meta row of the store's own is never in a part; sequences are set, not added. */
function insertRows(store: Store, table: string, columns: string[], rows: unknown[][]): void {
  if (table === 'sqlite_sequence') {
    for (const [name, seq] of rows) {
      store.run(`DELETE FROM sqlite_sequence WHERE name = ?`, decodeCell(name));
      store.run(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))`, decodeCell(name), decodeCell(seq));
    }
    return;
  }
  const insert = `INSERT OR REPLACE INTO ${quoted(table)} (${columns.map(quoted).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  for (const row of rows) {
    if (table === 'meta' && (OWN_META as readonly unknown[]).includes(row[columns.indexOf('key')])) continue;
    store.run(insert, ...row.map(decodeCell));
  }
}

/** Loads parts, each checked against the manifest and inserted with the cursor in one transaction. */
async function tablesStep({ store, transact }: RestoreDeps, backups: R2Bucket, manifest: Manifest, state: RestoreState): Promise<void> {
  let budget = RESTORE_STEP_BYTES;
  while (state.table_index < manifest.tables.length && budget > 0) {
    const table = manifest.tables[state.table_index];
    if (table === undefined) break;
    const part = table.parts[state.part_index];
    if (part === undefined) {
      state.table_index += 1;
      state.part_index = 0;
      continue;
    }
    const object = await backups.get(part.key);
    if (object === null) throw new Error('part_missing');
    const data = new Uint8Array(await object.arrayBuffer());
    if ((await sha256Hex(data)) !== part.sha256) throw new Error('part_mismatch');
    const text = new TextDecoder().decode(await gunzip(data));
    const rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
    if (rows.length !== part.rows || !rows.every((row): row is unknown[] => Array.isArray(row) && row.length === table.columns.length)) throw new Error('part_invalid');
    // The rows and the cursor in one transaction: a repeated step never loads a part twice.
    transact(() => {
      insertRows(store, table.name, table.columns, rows);
      saveState(store, { ...state, part_index: state.part_index + 1 });
    });
    state.part_index += 1;
    budget -= text.length;
  }
  if (state.table_index >= manifest.tables.length) state.phase = 'finish';
}

/** Counts every table against the manifest, settles what must not act again, and ends the restore. */
function finish({ store, transact }: RestoreDeps, manifest: Manifest, state: RestoreState, now: number): void {
  state.tables = manifest.tables.map((table) => {
    const where = table.name === 'meta' ? ` WHERE key NOT IN (${OWN_META.map((key) => `'${key}'`).join(', ')})` : '';
    const restored = store.one<{ n: number }>(`SELECT count(*) AS n FROM ${quoted(table.name)}${where}`)?.n ?? 0;
    return { table: table.name, restored, expected: table.rows };
  });
  if (state.tables.some((table) => table.restored !== table.expected)) throw new Error('count_mismatch');
  const done: RestoreState = { ...state, state: 'succeeded', finished_at: now };
  const settled = transact(() => {
    // The old state's deliveries: settled, never sent (the changes stay in the inbox).
    const notifications = store.run(`UPDATE notifications SET delivered_at = ? WHERE delivered_at IS NULL`, now);
    const intents = store.run(`UPDATE intents SET state = 'superseded', payload = '', event_ids = '[]', last_code = 'restored', updated_at = ? WHERE state = 'open'`, now);
    // The event feed: every saved position expires, and new sequences are past any it saw.
    const head = store.one<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = 'notifications'`)?.seq ?? 0;
    const moved = head + RESTORE_SEQUENCE_GAP;
    store.run(`DELETE FROM sqlite_sequence WHERE name = 'notifications'`);
    store.run(`INSERT INTO sqlite_sequence (name, seq) VALUES ('notifications', CAST(? AS INTEGER))`, moved);
    store.setMeta('watch_events_floor', String(moved));
    // The evidence copies the backup bucket holds: the next backup copies none of them again.
    for (const object of manifest.evidence.objects)
      store.run(`INSERT OR IGNORE INTO backup_evidence (key, sha256, bytes) VALUES (?, ?, ?)`, object.key, object.sha256, object.bytes);
    saveState(store, done);
    return notifications + intents;
  });
  Object.assign(state, done);
  log({ succeeded: state.backup, rows: state.tables.reduce((sum, table) => sum + table.restored, 0), settled, evidence: state.evidence });
}
