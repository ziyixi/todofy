/**
 * The restore of a backup (backup.ts; docs/backup.md) into this object, from its own BACKUPS bucket. The owner starts it
 * (store.ts, `POST /owner/restore`) and only into an empty store: a new object or a fresh namespace. Until it is done,
 * the object refuses every other request and pauses its own work and its backup.
 *
 * One bounded step per Alarm, a second apart: the next parts in the manifest's order, up to RESTORE_STEP_BYTES of rows. Each
 * part is read from R2 and checked against the manifest's SHA-256 and row count, then its rows go in with their rowids,
 * are read back and compared byte for byte, and the cursor moves, all in one transaction: a failed step repeats the
 * part without duplicates. RESTORE_MAX_ERRORS failed steps in a row fail the restore; the owner resumes it with the same call.
 *
 * The last step verifies every table's rows and the KV keys against the manifest, and that delivery_totals (rebuilt by
 * the deliveries triggers) matches the deliveries, and writes that to the status. It moves the Work entry numbers and
 * etags WORK_SEQ_GAP past the backup's, so no new Work notice reuses an event ID the lost store sent and no etag the lost
 * store handed out matches a restored Work, and marks every event source
 * `restored` (events.ts): the business sources take a new baseline at their next check, and the Work Watch source
 * replays from its cursor unless Watch no longer accepts it (watch-events.ts). Then the store backs itself up at once.
 */
import {
  BACKUP_FORMAT, BACKUP_KEY, CONTINUE_MS, MANIFEST, RESTORE_KEY, rowLine, SCHEMA_VERSION, sha256Hex, storeIsEmpty,
  storeTables, type BackupStorage,
} from './backup.ts';
import { RESTORED } from './events.ts';

/** Row JSON a step loads (at least one part), from at most RESTORE_STEP_PARTS parts: R2 reads count as subrequests. */
export const RESTORE_STEP_BYTES = 4 << 20;
export const RESTORE_STEP_PARTS = 20;
/**
 * Work entry numbers and etags a restored store skips. A Work notice's event ID holds its entry's number, and a Dot may
 * hold an etag of the lost store, which went on after the backup: new entries start this far past the backup's sequence,
 * and every Work's etag moves this far, more than the store writes in years.
 */
export const WORK_SEQ_GAP = 1_000_000;
export const RESTORE_RETRY_MS = 30_000;
export const RESTORE_MAX_ERRORS = 3;
const PREFIX = /^backups\/\d{4}-\d{2}-\d{2}T\d{6}Z\/$/;

interface Part { key: string; rows: number; sha256: string }
/** A table of the manifest, or the KV keys (`columns` null); `sequence` is an AUTOINCREMENT table's at the backup. */
interface Family { name: string; columns: string[] | null; rows: number; parts: Part[]; sequence?: number | null }
export interface Verification { name: string; expected: number; restored: number; ok: boolean }
export interface RestoreState {
  backup: string;
  phase: 'running' | 'done' | 'failed';
  started_at: number;
  finished_at: number | null;
  backup_created_at: string;
  schema_version: number;
  families: Family[];
  /** The next part to load. */
  next: { family: number; part: number };
  /** Rows loaded and read back, by family. */
  loaded: Record<string, number>;
  errors: number;
  error_code: string;
  verification: Verification[] | null;
}
/** What status and the owner call show. */
export interface RestoreView {
  backup: string;
  phase: RestoreState['phase'];
  started_at: string;
  finished_at: string | null;
  backup_created_at: string;
  parts: { loaded: number; total: number };
  error_code: string;
  verification: Verification[] | null;
}

class RestoreFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'RestoreFailure';
    this.code = code;
  }
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ restore: fields }));
}

export function restoreState(storage: BackupStorage): RestoreState | undefined {
  return storage.kv.get<RestoreState>(RESTORE_KEY);
}

/** A restore that has not finished, failed included: the store refuses other requests until it is done. */
export function restoreUnfinished(storage: BackupStorage): boolean {
  const state = restoreState(storage);
  return state !== undefined && state.phase !== 'done';
}

export function restoreView(state: RestoreState | undefined): RestoreView | null {
  if (!state) return null;
  const total = state.families.reduce((sum, family) => sum + family.parts.length, 0);
  const loaded = state.families.slice(0, state.next.family).reduce((sum, family) => sum + family.parts.length, 0) + state.next.part;
  return { backup: state.backup, phase: state.phase, started_at: new Date(state.started_at).toISOString(),
    finished_at: state.finished_at === null ? null : new Date(state.finished_at).toISOString(),
    backup_created_at: state.backup_created_at, parts: { loaded: Math.min(loaded, total), total },
    error_code: state.error_code, verification: state.verification };
}

type Started = { status: number; error?: string; message?: string; restore?: RestoreView | null };

function refused(status: number, error: string, message: string): Started {
  return { status, error, message };
}

/** An unfinished restore: resumed for the same backup (a failed one runs again), refused for another. */
function resume(storage: BackupStorage, backup: string): Started | null {
  const current = restoreState(storage);
  if (!current || current.phase === 'done') return null;
  if (current.backup !== backup) return refused(409, 'restore_unfinished', `A restore of ${current.backup} is unfinished; resume it with the same backup.`);
  if (current.phase === 'failed') storage.kv.put(RESTORE_KEY, { ...current, phase: 'running', errors: 0, error_code: '' });
  return { status: 202, restore: restoreView(restoreState(storage)) };
}

/**
 * Starts (or resumes) the restore of `backup`, a prefix like `backups/2026-10-28T052300Z/`: only into an empty store,
 * from a complete backup whose tables and columns this release has. The caller arms the Alarm on 202.
 */
export async function startRestore(storage: BackupStorage, bucket: R2Bucket | undefined, backup: unknown, now: number): Promise<Started> {
  if (!bucket) return refused(503, 'backups_not_bound', 'This deployment has no BACKUPS bucket.');
  if (typeof backup !== 'string' || !PREFIX.test(backup))
    return refused(400, 'invalid_backup', 'Name a backup as backups/<job start>/, for example backups/2026-10-28T052300Z/.');
  const resumed = resume(storage, backup);
  if (resumed) return resumed;
  if (!storeIsEmpty(storage.sql))
    return refused(409, 'store_not_empty', 'A restore only fills an empty store: point the app at a new object first (docs/backup.md).');
  const object = await bucket.get(backup + MANIFEST);
  if (!object) return refused(404, 'backup_not_found', `${backup} has no manifest: it is not a complete backup.`);
  let manifest: { format?: unknown; schema_version?: unknown; created_at?: unknown;
    tables?: { name: string; columns: string[]; rows: number; parts: Part[]; sequence?: number | null }[];
    kv?: { rows: number; parts: Part[] } };
  try { manifest = await object.json(); } catch { return refused(422, 'backup_unreadable', `${backup}${MANIFEST} is not JSON.`); }
  if (manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.tables) || !manifest.kv)
    return refused(422, 'backup_unreadable', `${backup}${MANIFEST} is not ${BACKUP_FORMAT}.`);
  if (typeof manifest.schema_version !== 'number' || manifest.schema_version > SCHEMA_VERSION)
    return refused(422, 'backup_schema_unsupported', 'The backup is newer than this release: deploy the release that made it first.');
  const tables = new Map(storeTables(storage.sql).map(table => [table.name, table.columns]));
  for (const table of manifest.tables) {
    const columns = tables.get(table.name);
    if (!columns || table.columns[0] !== 'rowid' || !table.columns.every(column => columns.includes(column)))
      return refused(422, 'backup_schema_unsupported', `This release has no table ${table.name} with the backup's columns.`);
  }
  const families: Family[] = [
    ...manifest.tables.map(table => ({ name: table.name, columns: table.columns, rows: table.rows, parts: table.parts,
      sequence: table.sequence ?? null })),
    { name: 'kv', columns: null, rows: manifest.kv.rows, parts: manifest.kv.parts },
  ];
  if (families.some(family => family.parts.some(part => !part.key.startsWith(backup))))
    return refused(422, 'backup_unreadable', 'A part of the manifest lies outside its backup.');
  // Other requests ran while the manifest was read: check again, with nothing awaited until the state is stored.
  const raced = resume(storage, backup);
  if (raced) return raced;
  if (!storeIsEmpty(storage.sql))
    return refused(409, 'store_not_empty', 'A restore only fills an empty store: point the app at a new object first (docs/backup.md).');
  const state: RestoreState = { backup, phase: 'running', started_at: now, finished_at: null,
    backup_created_at: String(manifest.created_at), schema_version: manifest.schema_version, families,
    next: { family: 0, part: 0 }, loaded: {}, errors: 0, error_code: '', verification: null };
  storage.kv.put(RESTORE_KEY, state);
  log({ started: backup, parts: families.reduce((sum, family) => sum + family.parts.length, 0) });
  return { status: 202, restore: restoreView(state) };
}

/** A part's text, checked against its SHA-256 and row count. */
async function readPart(bucket: R2Bucket, part: Part): Promise<string[]> {
  const object = await bucket.get(part.key);
  if (!object) throw new RestoreFailure('part_missing');
  const data = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(data) !== part.sha256) throw new RestoreFailure('part_hash_mismatch');
  let text: string;
  try {
    text = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } catch { throw new RestoreFailure('part_unreadable'); }
  const lines = text.split('\n').filter(Boolean);
  if (lines.length !== part.rows) throw new RestoreFailure('part_rows_mismatch');
  return lines;
}

function decodeValue(value: unknown): SqlStorageValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'object' && 'blob' in value && typeof value.blob === 'string')
    return Uint8Array.from(atob(value.blob), character => character.charCodeAt(0)).buffer;
  throw new RestoreFailure('part_unreadable');
}

/** Inserts a part's rows with their rowids and reads them back: the same bytes, or the transaction rolls back. */
function load(storage: BackupStorage, family: Family, lines: string[]): void {
  let rows: unknown[][];
  try { rows = lines.map(line => JSON.parse(line) as unknown[]); } catch { throw new RestoreFailure('part_unreadable'); }
  if (!family.columns) {
    for (const row of rows) {
      const [key, value] = row;
      if (row.length !== 2 || typeof key !== 'string') throw new RestoreFailure('part_unreadable');
      storage.kv.put(key, value);
      if (JSON.stringify([key, storage.kv.get(key)]) !== JSON.stringify(row)) throw new RestoreFailure('row_mismatch');
    }
    return;
  }
  const columns = family.columns.map(column => `"${column}"`).join(',');
  const insert = `INSERT INTO "${family.name}"(${columns}) VALUES (${family.columns.map(() => '?').join(',')})`;
  for (const row of rows) {
    if (row.length !== family.columns.length) throw new RestoreFailure('part_unreadable');
    try { storage.sql.exec(insert, ...row.map(decodeValue)); }
    catch { throw new RestoreFailure('insert_failed'); }
  }
  const first = rows[0]?.[0];
  const last = rows.at(-1)?.[0];
  const stored = [...storage.sql.exec(`SELECT ${columns} FROM "${family.name}" WHERE rowid >= ? AND rowid <= ? ORDER BY rowid`,
    first as number, last as number).raw()].map(rowLine);
  if (stored.join('\n') !== lines.join('\n')) throw new RestoreFailure('row_mismatch');
}

/** Runs the restore's next step; answers when the next one is due, or null when it is done or failed. */
export async function restoreStep(storage: BackupStorage, bucket: R2Bucket | undefined, now: number): Promise<number | null> {
  const state = restoreState(storage);
  if (state?.phase !== 'running') return null;
  try {
    if (!bucket) throw new RestoreFailure('backups_not_bound');
    let budget = RESTORE_STEP_BYTES;
    let reads = 0;
    while (budget > 0 && reads < RESTORE_STEP_PARTS && state.next.family < state.families.length) {
      const family = state.families[state.next.family];
      const part = family?.parts[state.next.part];
      if (!family || !part) {
        state.next = { family: state.next.family + 1, part: 0 };
        continue;
      }
      reads += 1;
      const lines = await readPart(bucket, part);
      const next = { family: state.next.family, part: state.next.part + 1 };
      const loaded = { ...state.loaded, [family.name]: (state.loaded[family.name] ?? 0) + lines.length };
      storage.transactionSync(() => {
        load(storage, family, lines);
        storage.kv.put(RESTORE_KEY, { ...state, next, loaded, errors: 0 });
      });
      state.next = next;
      state.loaded = loaded;
      state.errors = 0;
      budget -= lines.reduce((sum, line) => sum + line.length + 1, 0);
    }
    if (state.next.family < state.families.length) return now + CONTINUE_MS;
    finish(storage, state, now);
    return null;
  } catch (error) {
    const code = error instanceof RestoreFailure ? error.code : 'storage_error';
    const latest = restoreState(storage) ?? state;
    const errors = latest.errors + 1;
    const failed = errors >= RESTORE_MAX_ERRORS;
    log({ error: code, errors, ...(failed ? { failed: latest.backup } : {}) });
    storage.kv.put(RESTORE_KEY, { ...latest, errors, error_code: code, ...(failed ? { phase: 'failed', finished_at: now } : {}) });
    return failed ? null : now + RESTORE_RETRY_MS;
  }
}

function count(sql: SqlStorage, table: string): number {
  return sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`).one().n;
}

/** The verification, the event sources' marks and the backup's fresh start, in one transaction. */
function finish(storage: BackupStorage, state: RestoreState, now: number): void {
  const verification: Verification[] = state.families.map(family => {
    const restored = family.columns ? count(storage.sql, family.name) : state.loaded[family.name] ?? 0;
    return { name: family.name, expected: family.rows, restored, ok: restored === family.rows };
  });
  const tables = new Set(state.families.map(family => family.name));
  if (tables.has('deliveries')) {
    const byState = (query: string) => JSON.stringify(storage.sql.exec<{ state: string; n: number }>(query).toArray()
      .map(row => [row.state, row.n]));
    const expected = byState('SELECT state, count(*) AS n FROM deliveries GROUP BY state ORDER BY state');
    const rebuilt = byState('SELECT state, count AS n FROM delivery_totals WHERE count <> 0 ORDER BY state');
    const deliveries = count(storage.sql, 'deliveries');
    verification.push({ name: 'delivery_totals', expected: deliveries,
      restored: storage.sql.exec<{ n: number | null }>('SELECT sum(count) AS n FROM delivery_totals').one().n ?? 0,
      ok: expected === rebuilt });
  }
  const ok = verification.every(item => item.ok);
  storage.transactionSync(() => {
    // Checked at once: the business sources take their new baselines, the Watch source reads on from its cursor.
    if (tables.has('event_sources')) storage.sql.exec('UPDATE event_sources SET error_code=?, checked_at=0', RESTORED);
    // Never below the backup's sequence: entries after its last row may have been numbered (and sent) already.
    const sequence = state.families.find(family => family.name === 'work_entries')?.sequence ?? 0;
    if (tables.has('work_entries')) {
      storage.sql.exec("DELETE FROM sqlite_sequence WHERE name='work_entries'");
      storage.sql.exec("INSERT INTO sqlite_sequence VALUES ('work_entries', max((SELECT coalesce(max(seq), 0) FROM work_entries), ?) + ?)",
        sequence, WORK_SEQ_GAP);
    }
    if (tables.has('work')) storage.sql.exec('UPDATE work SET etag = etag + ?', WORK_SEQ_GAP);
    storage.kv.delete(BACKUP_KEY);
    storage.kv.put(RESTORE_KEY, { ...state, phase: ok ? 'done' : 'failed', finished_at: now, verification,
      error_code: ok ? '' : 'verification_failed' });
  });
  log({ [ok ? 'done' : 'failed']: state.backup, rows: verification.reduce((sum, item) => sum + item.restored, 0) });
}
