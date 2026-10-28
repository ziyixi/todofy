/**
 * Watch's daily backup (../../docs/backup.md): every table of WatchState's SQLite and every evidence object its
 * snapshots reference, into the private bucket `watch-backups` (binding BACKUPS), one bounded step per alarm a second
 * apart (state.ts). The layout:
 *
 *   backups/<job start>/<table>/<n>.ndjson.gz   one gzip part per table and step: one JSON array per row
 *   backups/<job start>/manifest.json           written after every part: a prefix without it is incomplete
 *   evidence/<key>                               each object of watch-evidence, copied once (its SHA-256 in metadata)
 *   latest.json                                  {"key": "backups/<job start>/"}, after the manifest
 *
 * `<job start>` is the UTC second the job started (`2026-10-28T112300Z`). The manifest (format watch-backup-v1) holds
 * the schema version, each table with its columns, rows and every part's SHA-256, and every evidence key the snapshots
 * reference with its copy's SHA-256 and size (restore.ts and tools/backup-restore.ts read it).
 *
 * Every table is backed up but EXCLUDED_TABLES, and every meta row but OWN_META. The evidence copies are keyed by
 * their own key, which never names two contents (a capture's key is new for each capture, an image's is its hash), so
 * an object is copied once: `backup_evidence` records each copy, and a later job only lists it in its manifest.
 *
 * A job starts at RUN_UTC every day, and at once when the object has no backup state yet (the first job after the
 * release that bound the bucket). An empty store (no watch and nothing a watch made) is never backed up: a new object
 * after a disaster must not push the good backups out. While a job runs the scheduler waits and so does every write
 * (state.ts: the API answers BACKUP_RUNNING), so the copy is one consistent point: the rows, and the evidence they
 * name. A step reads at most STEP_BYTES of rows (into parts of at most PART_BYTES) or copies at most EVIDENCE_COPIES objects
 * (EVIDENCE_BYTES); a cursor moves only after its part or copy is stored, so a failed step repeats from there and
 * writes the same keys. MAX_ERRORS failed steps in a row fail the job; it starts again FAILED_RETRY_MS later, or at the
 * next daily slot after MAX_FAILED_JOBS failed jobs in a row.
 *
 * Retention is here, never an R2 lifecycle rule (a stopped job must never age out the last good copies): after each
 * new complete backup the newest KEEP complete ones are kept; older ones and every incomplete prefix older than the
 * new one are deleted, and so is every evidence copy no kept manifest names. A job never rewrites a complete backup.
 *
 * Logs carry keys' counts, step names and codes only: never a row, a URL or page text.
 */
import { Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import { sha256Hex } from './config.ts';
import { DAY, HOUR } from './limits.ts';
import { gzip } from './snapshot.ts';
import { SCHEMA_VERSION, type Store } from './store.ts';

export const BACKUP_FORMAT = 'watch-backup-v1';
export const BACKUP_ROOT = 'backups/';
export const EVIDENCE_ROOT = 'evidence/';
export const MANIFEST = 'manifest.json';
export const LATEST = 'latest.json';
/** A backup's name: `backups/<job start>/`. */
export const BACKUP_NAME = /^backups\/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\/$/;
/** Complete backups kept, the new one included: a month of days. */
export const KEEP = 30;
/** Every day at this UTC time (Mail Hero copies at 04:17, Model Router at 04:47, Tasks on Sundays at 10:00). */
export const RUN_UTC = { hour: 11, minute: 23 } as const;
/** While a job runs, the next step comes this soon; after a failed step, ERROR_RETRY_MS. */
export const CONTINUE_MS = 1000;
export const ERROR_RETRY_MS = 60_000;
export const MAX_ERRORS = 3;
export const FAILED_RETRY_MS = 6 * HOUR;
export const MAX_FAILED_JOBS = 3;
/** backup_stale: no complete backup for this long, or since the first step when there is none. */
export const BACKUP_STALE_MS = 3 * DAY;
/** Rows (as NDJSON) a part holds at most, and a step reads at most. */
export const PART_BYTES = 4 * 1024 * 1024;
export const STEP_BYTES = 16 * 1024 * 1024;
/** Rows per query of a table page. */
export const PAGE_ROWS = 100;
/** Evidence objects a step copies at most (a GET and a PUT each), and their bytes. */
export const EVIDENCE_COPIES = 40;
export const EVIDENCE_BYTES = 24 * 1024 * 1024;
/** Evidence keys a step looks at (most were copied before: a row read each, no R2 call). */
const EVIDENCE_SCAN = 1000;
const MAX_LIST_PAGES = 10;

/** The tables never backed up, and why (docs/backup.md "What is not backed up"). */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  previews: "PreviewWatch's 15-minute store of a page fetched for the block picker: a cache of the site, never read after 15 minutes",
  backup_evidence: "the backup's own record of the evidence it copied into watch-backups; a restore rebuilds it from the manifest",
};
/** The meta rows that are the store's own bookkeeping of a backup, a restore or its schema, never data. */
export const OWN_META = ['backup', 'restore', 'schema_version'] as const;

export interface BackupPart {
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}
export interface ManifestTable {
  name: string;
  columns: string[];
  rows: number;
  bytes: number;
  parts: BackupPart[];
}
export interface EvidenceCopy {
  key: string;
  sha256: string;
  bytes: number;
}
export interface Manifest {
  format: string;
  started_at: string;
  created_at: string;
  schema_version: number;
  tables: ManifestTable[];
  evidence: { root: string; objects: EvidenceCopy[]; missing: string[] };
  excluded: Record<string, string>;
}
/** One table of the running job. */
interface Cursor {
  table: string;
  columns: string[];
  last: number;
  done: boolean;
  parts: BackupPart[];
}
interface Job {
  prefix: string;
  started_at: number;
  phase: 'tables' | 'evidence' | 'finish';
  errors: number;
  tables: Cursor[];
  /** The last evidence key looked at, and the referenced ones the evidence bucket did not hold. */
  evidence_after: string;
  missing: string[];
}
export interface BackupState {
  /** When the object first ran a backup step (ms): a first backup's stale time runs from it. */
  since: number;
  /** When the next job may start (ms); 0 at once. */
  next_run: number;
  /** Failed jobs since the last complete one. */
  failed_jobs: number;
  status: 'never' | 'ok' | 'failed';
  last_backup_at: number | null;
  last_key: string;
  error_code: string;
  job: Job | null;
}
/** What Ops and the status view report: none of it without the binding. */
export interface BackupFacts {
  status: 'never' | 'ok' | 'failed' | 'running';
  last_backup_at: number | null;
  last_key: string;
  since: number | null;
}
export interface BackupDeps {
  readonly store: Store;
  readonly bucket: R2Bucket;
  /** watch-evidence (EVIDENCE_STORE); without it every referenced object is recorded as missing. */
  readonly evidence: R2Bucket | undefined;
}

/** Keys' counts, steps and codes only: never row content. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ backup: fields }));
}

/** `2026-10-28T11:23:00Z`: the manifest's times. */
export function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A short code for a log line or the status (never a message that could carry data). */
export function failureCode(error: unknown): string {
  return error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'storage_error';
}

/** The first RUN_UTC after `now`; with `skipToday`, not on `now`'s UTC day (a backup finished earlier that day). */
export function nextRun(now: number, skipToday = false): number {
  const today = new Date(now);
  today.setUTCHours(RUN_UTC.hour, RUN_UTC.minute, 0, 0);
  let at = today.getTime();
  if (at <= now || skipToday) at += DAY;
  return at;
}

// ---- the store's tables -------------------------------------------------------------------------------------------

/** A value of a row in a part: SQLite's text, numbers and NULL as JSON, a BLOB as {"base64": ...}. */
export type Cell = string | number | null | { base64: string };

export function encodeCell(value: SqlStorageValue): Cell {
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { base64: btoa(binary) };
  }
  return value;
}

export function decodeCell(cell: unknown): string | number | null | ArrayBuffer {
  if (cell === null || typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell))) return cell;
  if (typeof cell === 'object' && Object.keys(cell).length === 1 && typeof (cell as { base64?: unknown }).base64 === 'string') {
    const binary = atob((cell as { base64: string }).base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  throw new Error('part_invalid');
}

/** A table or column name as SQL (the names come from sqlite_master and the manifest, both checked). */
export function quoted(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('name_invalid');
  return `"${name}"`;
}

/**
 * The tables a backup holds, with their columns: every table of the store but SQLite's and Cloudflare's own and
 * EXCLUDED_TABLES, then `sqlite_sequence` (the AUTOINCREMENT heads, which ids and the event feed's cursors continue).
 */
export function backupTables(store: Store): { name: string; columns: string[] }[] {
  const names = store
    .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .map((row) => row.name)
    .filter((name) => !/^(sqlite_|_cf_|__cf_)/i.test(name) && !Object.hasOwn(EXCLUDED_TABLES, name));
  const tables = names.map((name) => ({ name, columns: store.all<{ name: string }>(`PRAGMA table_info(${quoted(name)})`).map((row) => row.name) }));
  if (store.one(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`)) tables.push({ name: 'sqlite_sequence', columns: ['name', 'seq'] });
  return tables;
}

/** No watch and nothing a watch made: what a restore needs, and what is never backed up. */
export function storeIsEmpty(store: Store): boolean {
  const used = store.one<{ used: number }>(
    `SELECT EXISTS (SELECT 1 FROM watches) OR EXISTS (SELECT 1 FROM snapshots) OR EXISTS (SELECT 1 FROM changes)
       OR EXISTS (SELECT 1 FROM notifications) OR EXISTS (SELECT 1 FROM intents) OR EXISTS (SELECT 1 FROM evidence_snapshots) AS used`,
  );
  return used?.used !== 1;
}

/** The evidence keys the store's ready snapshots reference after `after`, in order. */
function referencedEvidence(store: Store, after: string, limit: number): string[] {
  return store
    .all<{ key: string }>(
      `SELECT key FROM (SELECT object_key AS key FROM evidence_snapshots WHERE ready = 1
         UNION SELECT image_key AS key FROM evidence_snapshots WHERE ready = 1 AND image_key != '')
       WHERE key > ? ORDER BY key LIMIT ?`,
      after,
      limit,
    )
    .map((row) => row.key);
}

// ---- state --------------------------------------------------------------------------------------------------------

export function backupState(store: Store): BackupState | null {
  const value = store.getMeta('backup');
  return value === null ? null : (JSON.parse(value) as BackupState);
}

function saveState(store: Store, state: BackupState): void {
  store.setMeta('backup', JSON.stringify(state));
}

/** Whether a job is copying the store: the scheduler and every write wait until it ends. */
export function backupRunning(store: Store): boolean {
  return backupState(store)?.job != null;
}

/** When the next step is due: at once without a state, a second away while a job runs. */
export function backupDue(store: Store, now: number): number {
  const state = backupState(store);
  if (state === null) return now;
  return state.job ? now : state.next_run;
}

export function backupFacts(store: Store): BackupFacts {
  const state = backupState(store);
  if (state === null) return { status: 'never', last_backup_at: null, last_key: '', since: null };
  return { status: state.job ? 'running' : state.status, last_backup_at: state.last_backup_at, last_key: state.last_key, since: state.since };
}

/**
 * Ops' view of the backup (ops-status.ts): the counter backup_age_seconds and the last backup's time once there is
 * one, the signals backup_stale (critical) and backup_failed (warning: the last job failed). Nothing without the binding.
 */
export function backupOps(facts: BackupFacts | null, now: number) {
  const counters: Record<string, number> = {};
  const signals: { code: string; severity: Severity; metrics: Record<string, number> }[] = [];
  const last = facts?.last_backup_at ?? null;
  const age = last === null ? null : Math.max(Math.floor((now - last) / 1000), 0);
  if (age !== null) counters.backup_age_seconds = age;
  const since = last ?? facts?.since ?? null;
  if (since !== null && now - since > BACKUP_STALE_MS)
    signals.push({ code: 'backup_stale', severity: Severity.CRITICAL, metrics: age === null ? { has_backup: 0 } : { age_seconds: age, has_backup: 1 } });
  if (facts?.status === 'failed') signals.push({ code: 'backup_failed', severity: Severity.WARNING, metrics: {} });
  return { counters, signals, lastBackupAt: last === null ? null : timestamp(last) };
}

// ---- the job ------------------------------------------------------------------------------------------------------

/**
 * Runs the backup's step due at `now`. `ran` is false when nothing was due (no job and not its time, or an empty store):
 * the alarm then runs the scheduler, and `next` says when the backup is due. While a job runs `next` is a second (or a
 * failed step's minute) away.
 */
export async function runBackup(deps: BackupDeps, now: number): Promise<{ ran: boolean; next: number }> {
  const { store } = deps;
  const state: BackupState = backupState(store) ?? {
    since: now,
    next_run: 0,
    failed_jobs: 0,
    status: 'never',
    last_backup_at: null,
    last_key: '',
    error_code: '',
    job: null,
  };
  if (!state.job) {
    if (state.next_run > now) return { ran: false, next: state.next_run };
    if (storeIsEmpty(store)) {
      state.next_run = nextRun(now);
      saveState(store, state);
      log({ skipped: 'empty_store' });
      return { ran: false, next: state.next_run };
    }
    const second = timestamp(now).replaceAll(':', '');
    const tables = backupTables(store).map((table) => ({ table: table.name, columns: table.columns, last: 0, done: false, parts: [] }));
    state.job = { prefix: `${BACKUP_ROOT}${second}/`, started_at: now, phase: 'tables', errors: 0, tables, evidence_after: '', missing: [] };
    // Saved before anything is read: from here on the scheduler and every write wait (state.ts).
    saveState(store, state);
  }
  const job = state.job;
  const step = job.phase;
  let retry = CONTINUE_MS;
  let finished = false;
  try {
    if (step === 'tables') await tablesStep(deps, job);
    else if (step === 'evidence') await evidenceStep(deps, job);
    else finished = await finish(deps, state, job, now);
    job.errors = 0;
  } catch (error) {
    // R2 failed (or a bug): the step runs again from the parts and copies stored so far.
    job.errors += 1;
    retry = ERROR_RETRY_MS;
    log({ error: failureCode(error), step, errors: job.errors });
    if (job.errors >= MAX_ERRORS) {
      log({ failed: failureCode(error), prefix: job.prefix });
      state.job = null;
      state.failed_jobs += 1;
      state.status = 'failed';
      state.error_code = failureCode(error);
      state.next_run = state.failed_jobs < MAX_FAILED_JOBS ? now + FAILED_RETRY_MS : nextRun(now);
    }
  }
  // Saved before retention: the job has ended, so the scheduler and the writes go on.
  saveState(store, state);
  if (finished) {
    try {
      await applyRetention(store, deps.bucket, job.prefix);
    } catch (error) {
      // The backup is complete; the next one retries the cleanup.
      log({ retention_error: failureCode(error) });
    }
  }
  return { ran: true, next: now + retry };
}

/** Pages of the tables still open into parts of at most PART_BYTES, until the step's STEP_BYTES are read. */
async function tablesStep({ store, bucket }: BackupDeps, job: Job): Promise<void> {
  let budget = STEP_BYTES;
  for (const cursor of job.tables) {
    const select = `SELECT rowid AS backup_rowid, ${cursor.columns.map(quoted).join(', ')} FROM ${quoted(cursor.table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`;
    while (!cursor.done && budget > 0) {
      const limit = Math.min(PART_BYTES, budget);
      const lines: string[] = [];
      let bytes = 0;
      let last = cursor.last;
      let done = false;
      while (!done && bytes < limit) {
        const rows = store.all<Record<string, SqlStorageValue>>(select, last, PAGE_ROWS);
        let read = 0;
        for (const row of rows) {
          if (bytes >= limit) break;
          read += 1;
          last = row.backup_rowid as number;
          if (cursor.table === 'meta' && (OWN_META as readonly string[]).includes(row.key as string)) continue;
          const line = JSON.stringify(cursor.columns.map((column) => encodeCell(row[column] ?? null)));
          lines.push(line);
          bytes += line.length + 1;
        }
        if (read === rows.length && rows.length < PAGE_ROWS) done = true;
      }
      // The cursor moves only once its part is stored: a failed put repeats this part under the same key.
      if (lines.length) {
        const key = `${job.prefix}${cursor.table}/${String(cursor.parts.length + 1).padStart(5, '0')}.ndjson.gz`;
        cursor.parts.push(await storePart(bucket, key, lines));
      }
      cursor.last = last;
      cursor.done = done;
      budget -= bytes;
    }
    if (budget <= 0) break;
  }
  if (job.tables.every((cursor) => cursor.done)) job.phase = 'evidence';
}

async function storePart(bucket: R2Bucket, key: string, lines: string[]): Promise<BackupPart> {
  const data = await gzip(new TextEncoder().encode(`${lines.join('\n')}\n`));
  const sha256 = await sha256Hex(data);
  await bucket.put(key, data, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { sha256 } });
  return { key, rows: lines.length, bytes: data.byteLength, sha256 };
}

/**
 * Copies the referenced evidence objects not copied before into evidence/<key>, one GET and one PUT each, until the
 * step's copies or bytes are spent. A key `backup_evidence` holds is already in the bucket: no R2 call.
 */
async function evidenceStep({ store, bucket, evidence }: BackupDeps, job: Job): Promise<void> {
  let copies = 0;
  let bytes = 0;
  const keys = referencedEvidence(store, job.evidence_after, EVIDENCE_SCAN);
  for (const key of keys) {
    if (store.one(`SELECT 1 AS found FROM backup_evidence WHERE key = ?`, key) === undefined) {
      if (copies >= EVIDENCE_COPIES || bytes >= EVIDENCE_BYTES) return;
      const object = evidence ? await evidence.get(key) : null;
      if (object === null) {
        // The scheduler waits during a job, so nothing deleted it meanwhile: the evidence bucket lost it.
        job.missing.push(key);
      } else {
        const data = new Uint8Array(await object.arrayBuffer());
        const sha256 = await sha256Hex(data);
        await bucket.put(`${EVIDENCE_ROOT}${key}`, data, {
          httpMetadata: { contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' },
          customMetadata: { sha256 },
        });
        store.run(`INSERT OR REPLACE INTO backup_evidence (key, sha256, bytes) VALUES (?, ?, ?)`, key, sha256, data.byteLength);
        copies += 1;
        bytes += data.byteLength;
      }
    }
    job.evidence_after = key;
  }
  if (keys.length < EVIDENCE_SCAN) job.phase = 'finish';
}

/** Writes the manifest (it marks the backup complete) and latest.json, and ends the job. */
async function finish({ store, bucket }: BackupDeps, state: BackupState, job: Job, now: number): Promise<boolean> {
  const missing = new Set(job.missing);
  const objects: EvidenceCopy[] = [];
  for (let after = '', keys = referencedEvidence(store, '', EVIDENCE_SCAN); keys.length > 0; keys = referencedEvidence(store, after, EVIDENCE_SCAN)) {
    for (const key of keys) {
      after = key;
      if (missing.has(key)) continue;
      const copy = store.one<{ sha256: string; bytes: number }>(`SELECT sha256, bytes FROM backup_evidence WHERE key = ?`, key);
      if (copy === undefined) throw new Error('evidence_not_copied');
      objects.push({ key, sha256: copy.sha256, bytes: copy.bytes });
    }
  }
  const manifest: Manifest = {
    format: BACKUP_FORMAT,
    started_at: timestamp(job.started_at),
    created_at: timestamp(now),
    schema_version: SCHEMA_VERSION,
    tables: job.tables.map((cursor) => ({
      name: cursor.table,
      columns: cursor.columns,
      rows: cursor.parts.reduce((sum, part) => sum + part.rows, 0),
      bytes: cursor.parts.reduce((sum, part) => sum + part.bytes, 0),
      parts: cursor.parts,
    })),
    evidence: { root: EVIDENCE_ROOT, objects, missing: [...missing].sort() },
    excluded: { ...EXCLUDED_TABLES },
  };
  const json = { httpMetadata: { contentType: 'application/json' } };
  await bucket.put(job.prefix + MANIFEST, JSON.stringify(manifest, null, 1), json);
  await bucket.put(LATEST, JSON.stringify({ key: job.prefix }), json);
  state.job = null;
  state.failed_jobs = 0;
  state.status = 'ok';
  state.error_code = '';
  state.last_backup_at = now;
  state.last_key = job.prefix;
  state.next_run = nextRun(now, true);
  log({ done: job.prefix, rows: manifest.tables.reduce((sum, table) => sum + table.rows, 0), evidence: objects.length, missing: missing.size });
  return true;
}

/** A complete backup's manifest, or null when the prefix has none. */
export async function readManifest(bucket: R2Bucket, prefix: string): Promise<Manifest | null> {
  const object = await bucket.get(prefix + MANIFEST);
  return object === null ? null : await object.json<Manifest>();
}

/** Every backup prefix in the bucket (one LIST of prefixes per page, never of objects). */
async function backupPrefixes(bucket: R2Bucket): Promise<string[]> {
  const prefixes: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await bucket.list({ prefix: BACKUP_ROOT, delimiter: '/', ...(cursor === undefined ? {} : { cursor }) });
    prefixes.push(...listed.delimitedPrefixes);
    if (!listed.truncated) return prefixes;
    cursor = listed.cursor;
  }
  throw new Error('too_many_backups');
}

async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

/**
 * Keeps the newest KEEP complete backups (`current` counts) and the evidence copies they name; deletes every other
 * complete backup older than them, every incomplete prefix older than `current`, and every evidence copy no kept
 * manifest names (the ones this store copied, and the ones the deleted manifests named). The copies go first, then
 * each deleted backup's manifest and its parts.
 */
export async function applyRetention(store: Store, bucket: R2Bucket, current: string): Promise<{ deleted: string[]; evidence: number }> {
  const older = (await backupPrefixes(bucket)).filter((prefix) => prefix <= current).sort().reverse();
  const kept = new Set<string>();
  const retired: { prefix: string; manifest: Manifest | null }[] = [];
  let keptCount = 0;
  for (const prefix of older) {
    const manifest = await readManifest(bucket, prefix);
    if (manifest !== null && keptCount < KEEP) {
      keptCount += 1;
      for (const object of manifest.evidence.objects) kept.add(object.key);
    } else if (manifest !== null || prefix < current) retired.push({ prefix, manifest });
  }
  const candidates = new Set(store.all<{ key: string }>(`SELECT key FROM backup_evidence`).map((row) => row.key));
  for (const { manifest } of retired) for (const object of manifest?.evidence.objects ?? []) candidates.add(object.key);
  const doomed = [...candidates].filter((key) => !kept.has(key)).sort();
  await deleteKeys(bucket, doomed.map((key) => `${EVIDENCE_ROOT}${key}`));
  for (const key of doomed) store.run(`DELETE FROM backup_evidence WHERE key = ?`, key);
  for (const { prefix, manifest } of retired) {
    if (manifest !== null) {
      // The manifest first: from then on the prefix is incomplete, never a backup missing parts.
      await bucket.delete(prefix + MANIFEST);
      await deleteKeys(bucket, manifest.tables.flatMap((table) => table.parts.map((part) => part.key)).filter((key) => key.startsWith(prefix)));
    } else {
      // An incomplete prefix (a failed job's parts): its objects are known only by listing it.
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const listed = await bucket.list({ prefix, limit: 1000 });
        const keys = listed.objects.map((object) => object.key);
        if (keys.length) await bucket.delete(keys);
        if (!listed.truncated) break;
      }
    }
    log({ deleted: prefix });
  }
  return { deleted: retired.map((item) => item.prefix), evidence: doomed.length };
}
