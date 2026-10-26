import type { Env } from './types.ts';
import { BackupState } from './backup-state.ts';
import { canonicalJSON } from './backup.ts';
import { sha256Bytes, sha256Stream } from './backup-checksum.ts';
import { abandonNativeBackupStep, pruneNativeBackupsStep, reserveNativeBackup, writeNativeVerifiedMarker } from './native-backup-artifacts.ts';
import type { NativeBackupFile, NativeBackupManifest, NativeBackupMarker, NativeBackupObject } from './native-backup-format.ts';

const MIB = 1024 * 1024;
const SOURCE_LIMIT = 32 * MIB;
const MANIFEST_LIMIT = 4 * MIB;
// Includes database/control exports and source objects. This is a safety bound,
// not a promise about the remaining account-wide Free allowance.
const MAX_FILES = 10_000;
const MAX_JOURNAL_ENTRIES = 20_000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * MIB;
// One Alarm tick's work. Workers Free gives a Durable Object invocation 30 s of CPU, 15 minutes of wall time and
// 1,000 subrequests to Cloudflare services (each R2 call or D1 query), at most 50 of them D1 queries. A tick stops
// far inside each, so the coordinator's own calls in the same Alarm still fit.
const TICK_MS = 10_000;
const TICK_BYTES = 8 * MIB;
const TICK_SUBREQUESTS = 400;
const TICK_QUERIES = 20;
// Objects copied at once. Each copy makes four R2 calls (two source reads, the write and its readback) and has at
// most one waiting for response headers; an invocation may have six waiting, and more would only queue.
const COPY_GROUP = 6;
// The most one step spends: a copy group, or a deletion-journal page (a list and 20 reads). A step starts only
// with this much left, and each spends at most one D1 query.
const STEP_SUBREQUESTS = COPY_GROUP * 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Row = Record<string, any>;
type Phase = 'idle' | 'begin' | 'waiting' | 'export' | 'inventory' | 'copy' | 'journal' | 'validate' |
  'manifest' | 'commit' | 'marker' | 'prune' | 'cleanup' | 'complete' | 'failed';
interface Run {
  phase: Phase; next_at: number; error: string | null; manual_required?: boolean;
  id?: string; prefix?: string; date?: string; max_bytes?: number;
  section?: 'control' | 'schema' | 'table'; tables?: string[]; table_index?: number; offset?: number;
  inventory_cursor?: string | null; object_cursor?: string; journal_cursor?: string | null; journal_done?: boolean;
  inventory_count?: number; inventory_bytes?: number; journal_count?: number;
  validation_table?: 'messages' | 'deliveries'; validation_cursor?: number;
  files?: number; bytes?: number; work?: number; source_hash?: string; marker?: NativeBackupMarker; prune_cursor?: unknown;
}
interface Progress { objects: NativeBackupObject[]; files: NativeBackupFile[]; deletions: Row[] }
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalJSON(value));
const fail = (code: string): never => { throw new Error(code); };

export function nextNativeBackupAt(now: number, schedule = '04:17'): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule)) throw new Error('native_backup_schedule_invalid');
  const [hour, minute] = schedule.split(':').map(Number), next = new Date(now);
  next.setUTCHours(hour!, minute!, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}

/** The existing Alarm makes an ordinary private R2 snapshot. A file is recorded
 * only after its entire body is read back and hashed. No archive, encryption,
 * temporary ciphertext, per-MiB jobs or external scheduler is involved. */
export class NativeBackupRunner {
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;
  private readonly backup: BackupState;
  /** What the current tick has spent; steps that can repeat within a tick count their R2 calls and D1 queries. */
  private spent = { bytes: 0, subrequests: 0, queries: 0 };
  private objects: NativeBackupObject[] = [];
  private copiedFiles = new Map<string, NativeBackupFile>();
  private deletions: Row[] = [];
  private progressDirty = false;
  constructor(storage: DurableObjectStorage, env: Env, backup: BackupState) {
    this.storage = storage; this.env = env; this.backup = backup;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS native_backup_control(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
    if (!storage.sql.exec('SELECT id FROM native_backup_control WHERE id=1').toArray().length) {
      storage.sql.exec('INSERT INTO native_backup_control VALUES(1,?)', JSON.stringify({ phase: 'idle', next_at: Date.now(), error: null }));
    }
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS native_backup_copies(path TEXT PRIMARY KEY,kind TEXT NOT NULL,
      bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,object_key TEXT) WITHOUT ROWID`);
    storage.sql.exec('CREATE TABLE IF NOT EXISTS native_backup_deletions(id TEXT NOT NULL,scope TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(id,scope)) WITHOUT ROWID');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS native_backup_requests(id TEXT PRIMARY KEY,created INTEGER NOT NULL) WITHOUT ROWID');
  }
  private read(): Run {
    return JSON.parse(this.storage.sql.exec<{ value: string }>('SELECT value FROM native_backup_control WHERE id=1').one().value);
  }
  private save(run: Run): void {
    const value = JSON.stringify(run), stored = this.storage.sql.exec<{ value: string }>('SELECT value FROM native_backup_control WHERE id=1').one().value;
    if (stored !== value) this.storage.sql.exec('UPDATE native_backup_control SET value=? WHERE id=1', value);
  }
  private active(run: Run): boolean { return !['idle', 'complete', 'failed'].includes(run.phase); }
  private enabled(): boolean { return this.env.NATIVE_BACKUP_ENABLED === 'true'; }
  private nextDaily(): number {
    const schedule = this.env.NATIVE_BACKUP_AT_UTC ?? '04:17';
    return nextNativeBackupAt(Date.now(), /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule) ? schedule : '04:17');
  }
  nextWake(): number | null {
    const run = this.read();
    if (run.phase === 'failed' && run.manual_required) return null;
    return this.active(run) || this.enabled() ? run.next_at : null;
  }
  status(): Row {
    const run = this.read();
    return { build_sha: this.env.BUILD_SHA ?? null, enabled: this.enabled(), phase: run.phase, next_at: run.phase === 'failed' && run.manual_required ? null : new Date(run.next_at).toISOString(),
      backup_id: run.id ?? null, error: run.error, manual_required: !!run.manual_required, verification: run.marker?.proof ?? null };
  }
  requestRun(id: string): Row {
    if (!UUID.test(id)) fail('native_backup_request_invalid');
    if (this.storage.sql.exec('SELECT id FROM native_backup_requests WHERE id=?', id).toArray().length) {
      return { version: 2, request_id: id, accepted: true, duplicate: true, ...this.status() };
    }
    this.storage.transactionSync(() => {
      if (this.storage.sql.exec<{ n: number }>('SELECT count(*) n FROM native_backup_requests').one().n >= 1000) fail('native_backup_request_limit');
      this.storage.sql.exec('INSERT INTO native_backup_requests VALUES(?,?)', id, Date.now());
      if (!this.active(this.read())) { this.clearCopies(); this.save({ phase: 'begin', next_at: Date.now(), error: null, files: 0, bytes: 0 }); }
    });
    return { version: 2, request_id: id, accepted: true, duplicate: false, ...this.status() };
  }
  private clearCopies(): void {
    this.storage.sql.exec('DELETE FROM native_backup_copies');
    this.storage.sql.exec('DELETE FROM native_backup_deletions');
  }
  private ready(run: Run): void { if (!run.id || !this.backup.nativeReady(run.id)) fail('native_backup_lease_expired'); }
  private limit(run: Run): number {
    const bytes = run.max_bytes ?? Number(this.env.NATIVE_BACKUP_MAX_BYTES ?? MAX_SNAPSHOT_BYTES);
    if (!Number.isSafeInteger(bytes) || bytes < MIB || bytes > MAX_SNAPSHOT_BYTES) fail('native_backup_snapshot_limit');
    return bytes;
  }
  private adopt(run: Run): void {
    const lease = this.backup.current()!;
    run.id = lease.id; run.date = lease.created_at.slice(0, 10); run.prefix = `snapshots-v2/${run.date}/${run.id}`; run.phase = 'waiting';
  }
  private file(path: string): NativeBackupFile | undefined { return this.copiedFiles.get(path); }
  private workKey(run: Run, slot: number): string { return `native-work/${run.id}/${slot % 2}.json`; }
  private async loadProgress(run: Run): Promise<void> {
    this.objects = []; this.copiedFiles = new Map(); this.deletions = []; this.progressDirty = false;
    if (!run.id || ['commit', 'marker', 'prune', 'cleanup'].includes(run.phase)) return;
    let progress: Progress = { objects: [], files: [], deletions: [] };
    if (run.work !== undefined) {
      this.spent.subrequests++;
      const saved = await this.env.BACKUP_STORE!.get(this.workKey(run, run.work));
      if (!saved) fail('native_backup_checkpoint_missing');
      progress = JSON.parse(new TextDecoder().decode(await boundedBytes(saved!.body, SOURCE_LIMIT)));
    } else if (run.id) {
      // Finish a snapshot already running on the previous Worker without changing its identity or format.
      progress.objects = this.storage.sql.exec<{ metadata: string }>('SELECT metadata FROM backup_objects WHERE backup_id=? ORDER BY key', run.id).toArray().map(row => JSON.parse(row.metadata));
      progress.files = this.storage.sql.exec<Row>('SELECT * FROM native_backup_copies ORDER BY path').toArray().map(row => ({
        path: row.path, kind: row.kind, bytes: row.bytes, sha256: row.sha256, ...(row.object_key ? { object_key: row.object_key } : {}),
      }));
      progress.deletions = this.storage.sql.exec<Row>('SELECT id,scope,deleted_at FROM native_backup_deletions ORDER BY id,scope').toArray();
      if (run.phase === 'journal') {
        // The old per-item SQL upserts could be ahead of its page cursor; re-read this small ledger once.
        progress.deletions = []; run.journal_cursor = null; run.journal_done = false; run.journal_count = 0;
      }
      if (run.phase === 'inventory' && progress.objects.length) {
        const lease = this.backup.current()!;
        run.inventory_count = progress.objects.length;
        run.inventory_bytes = progress.objects.reduce((sum, object) => sum + object.size, 0);
        run.inventory_cursor = lease.object_cursor;
        if (lease.objects_done) run.phase = 'copy';
      }
    }
    this.objects = progress.objects; this.copiedFiles = new Map(progress.files.map(file => [file.path, file]));
    this.deletions = progress.deletions;
    this.progressDirty = run.work === undefined && !!(progress.objects.length || progress.files.length || progress.deletions.length);
  }
  private async checkpoint(run: Run): Promise<void> {
    if (run.id && this.progressDirty) {
      const work = (run.work ?? 0) + 1;
      const body = encode({ objects: this.objects, files: [...this.copiedFiles.values()], deletions: this.deletions });
      if (body.byteLength > SOURCE_LIMIT) fail('native_backup_checkpoint_limit');
      // Two slots keep the current checkpoint intact until its replacement and DO cursor are durable.
      this.spent.subrequests++;
      await this.env.BACKUP_STORE!.put(this.workKey(run, work), body, { httpMetadata: { contentType: 'application/json' } });
      run.work = work;
    }
    this.save(run); this.progressDirty = false;
    if (run.id && ['complete', 'failed'].includes(run.phase)) {
      await this.env.BACKUP_STORE!.delete([this.workKey(run, 0), this.workKey(run, 1)]);
    }
  }
  private async exported(run: Run, path: string): Promise<{ bytes: Uint8Array; value: Row }> {
    this.ready(run);
    const response = await this.backup.fetch(new Request(`https://coordinator/backup/${path}${path.includes('?') ? '&' : '?'}backup_id=${run.id}`), 'native');
    // An export makes at most one call: a D1 query for the database, an R2 list for the objects.
    this.spent.subrequests++; if (path.startsWith('database')) this.spent.queries++;
    if (!response?.ok) fail('native_backup_export_failed');
    const bytes = await boundedBytes(response!.body, SOURCE_LIMIT); this.ready(run);
    try { return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }; }
    catch { return fail('native_backup_export_invalid'); }
  }
  /** `queued` are new files of the same copy group, not yet recorded. */
  private checkNewFile(run: Run, bytes: number, queued = { files: 0, bytes: 0 }): void {
    if ((run.files ?? 0) + queued.files + 1 >= MAX_FILES) fail('native_backup_file_limit'); // Reserve the final manifest.
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > SOURCE_LIMIT || (run.bytes ?? 0) + queued.bytes + bytes > this.limit(run)) fail('native_backup_snapshot_limit');
  }
  private register(run: Run, file: NativeBackupFile): void {
    this.ready(run);
    this.copiedFiles.set(file.path, file); this.progressDirty = true;
    run.files = (run.files ?? 0) + 1; run.bytes = (run.bytes ?? 0) + file.bytes;
  }
  private async readback(key: string, bytes: number, expected: string): Promise<void> {
    const object = await this.env.BACKUP_STORE!.get(key);
    if (!object || object.size !== bytes) fail('native_backup_readback_failed');
    const checked = await sha256Stream(object!.body);
    if (checked.bytes !== bytes || checked.sha256 !== expected) fail('native_backup_readback_failed');
  }
  private async copyBytes(run: Run, path: string, kind: NativeBackupFile['kind'], bytes: Uint8Array): Promise<number> {
    this.ready(run);
    const checksum = await sha256Bytes(bytes), existing = this.file(path);
    if (existing) {
      if (existing.bytes !== bytes.byteLength || existing.sha256 !== checksum || existing.kind !== kind) fail('native_backup_source_changed');
      return 0;
    }
    this.checkNewFile(run, bytes.byteLength);
    const key = `${run.prefix}/${path}`;
    this.spent.subrequests += 2;
    await this.env.BACKUP_STORE!.put(key, bytes, { httpMetadata: { contentType: 'application/json' }, customMetadata: { backup_id: run.id!, sha256: checksum } });
    await this.readback(key, bytes.byteLength, checksum);
    this.register(run, { path, kind, bytes: bytes.byteLength, sha256: checksum });
    return bytes.byteLength;
  }
  /** Copies the next objects at once, as many as the tick's byte budget lets start. The cursor passes the group
   * only after every copy in it is recorded, so a failure or a restart cannot leave an object behind it uncopied. */
  private async copyGroup(run: Run, sources: NativeBackupObject[]): Promise<number> {
    this.ready(run);
    const copies: { source: NativeBackupObject; path: string }[] = [], queued = { files: 0, bytes: 0 };
    let cursor = run.object_cursor;
    for (const source of sources) {
      // As when copying one by one: another copy starts only while the tick is below its bytes.
      if (copies.length && this.spent.bytes + queued.bytes >= TICK_BYTES) break;
      const path = `objects/${await sha256Bytes(new TextEncoder().encode(source.key))}.bin`, existing = this.file(path);
      if (existing) {
        if (existing.bytes !== source.size || existing.object_key !== source.key) fail('native_backup_source_changed');
      } else {
        this.checkNewFile(run, source.size, queued);
        copies.push({ source, path }); queued.files++; queued.bytes += source.size;
      }
      cursor = source.key;
    }
    // Every copy settles before the group's outcome, so none runs on after a failure has ended the tick.
    const results = await Promise.allSettled(copies.map(copy => this.copyObject(run, copy.source, copy.path)));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    run.object_cursor = cursor;
    return queued.bytes;
  }
  private async copyObject(run: Run, source: NativeBackupObject, path: string): Promise<void> {
    this.ready(run); this.spent.subrequests += 4;
    // The first streaming read obtains a full SHA for metadata. The second uses
    // the same frozen ETag and an exact-length stream. Neither buffers the mail.
    const first = await this.env.MAIL_STORE.get(source.key, { onlyIf: { etagMatches: source.etag } });
    if (!first || !('body' in first) || first.size !== source.size) fail('native_backup_source_changed');
    const checksum = await sha256Stream((first as R2ObjectBody).body);
    if (checksum.bytes !== source.size) fail('native_backup_source_changed');
    this.ready(run);
    const second = await this.env.MAIL_STORE.get(source.key, { onlyIf: { etagMatches: source.etag } });
    if (!second || !('body' in second) || second.size !== source.size) fail('native_backup_source_changed');
    const key = `${run.prefix}/${path}`, fixed = new FixedLengthStream(source.size);
    const pipe = (second as R2ObjectBody).body.pipeTo(fixed.writable); pipe.catch(() => {});
    try {
      await this.env.BACKUP_STORE!.put(key, fixed.readable, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { backup_id: run.id!, sha256: checksum.sha256 } });
      await pipe;
    } catch (error) { await fixed.readable.cancel().catch(() => {}); throw error; }
    await this.readback(key, source.size, checksum.sha256);
    this.register(run, { path, kind: 'object', bytes: source.size, sha256: checksum.sha256, object_key: source.key });
  }
  private async reference(key: unknown, kind: string): Promise<NativeBackupFile> {
    if (typeof key !== 'string' || !key) return fail(`native_backup_${kind}_reference_missing`);
    const path = `objects/${await sha256Bytes(new TextEncoder().encode(key))}.bin`, file = this.file(path);
    if (!file || file.object_key !== key) return fail(`native_backup_${kind}_reference_missing`);
    return file;
  }
  private async validate(run: Run): Promise<boolean> {
    this.spent.subrequests++; this.spent.queries++;
    if (run.validation_table === 'messages') {
      const rows = (await this.env.DB.prepare(`SELECT rowid AS cursor,id,content_deleted_at,raw_expired_at,origin,raw_key,parsed_key,parse_state
        FROM messages WHERE rowid>? ORDER BY rowid LIMIT 10`).bind(run.validation_cursor ?? 0).all<Row>()).results;
      for (const message of rows) {
        if (!message.content_deleted_at) {
          if (!message.raw_expired_at && (message.origin !== 'synthetic_test' || message.raw_key)) await this.reference(message.raw_key, 'raw');
          if (message.parsed_key || message.parse_state === 'ready') {
            const file = await this.reference(message.parsed_key, 'parsed');
            // Read back like a copy: one R2 call, and its bytes count toward the tick's.
            this.spent.subrequests++; this.spent.bytes += file.bytes;
            const saved = await this.env.BACKUP_STORE!.get(`${run.prefix}/${file.path}`);
            if (!saved || saved.size !== file.bytes) fail('native_backup_parsed_reference_invalid');
            const bytes = await boundedBytes(saved!.body, SOURCE_LIMIT);
            if (await sha256Bytes(bytes) !== file.sha256) fail('native_backup_parsed_reference_invalid');
            let parsed: Row;
            try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
            catch { return fail('native_backup_parsed_reference_invalid'); }
            if (!Array.isArray(parsed!.attachments)) fail('native_backup_parsed_reference_invalid');
            for (const attachment of parsed!.attachments) {
              if (!attachment || typeof attachment !== 'object') fail('native_backup_attachment_reference_invalid');
              if (attachment.storage_status !== 'omitted') await this.reference(attachment.r2_key, 'attachment');
            }
          }
        }
        run.validation_cursor = message.cursor;
      }
      if (rows.length < 10) { run.validation_table = 'deliveries'; run.validation_cursor = 0; }
      return false;
    }
    const rows = (await this.env.DB.prepare(`SELECT d.rowid AS cursor,d.*,m.id AS live_message_id,m.content_deleted_at
      FROM deliveries d LEFT JOIN messages m ON m.id=d.message_id WHERE d.rowid>? ORDER BY d.rowid LIMIT 100`).bind(run.validation_cursor ?? 0).all<Row>()).results;
    const emptyHash = await sha256Bytes(new Uint8Array());
    for (const delivery of rows) {
      if (!delivery.live_message_id) fail('native_backup_delivery_message_missing');
      if (!delivery.content_deleted_at) {
        if (delivery.payload_key === null && delivery.state === 'failed' && ['invalid_payload', 'message_needs_review'].includes(delivery.last_error)) {
          if (delivery.payload_size_bytes !== 0 || delivery.payload_sha256 !== emptyHash) fail('native_backup_payload_reference_missing');
        } else {
          const file = await this.reference(delivery.payload_key, 'payload');
          if (file.bytes !== delivery.payload_size_bytes || file.sha256 !== delivery.payload_sha256) fail('native_backup_payload_reference_mismatch');
        }
      }
      run.validation_cursor = delivery.cursor;
    }
    return rows.length < 100;
  }
  private async writeManifest(run: Run): Promise<void> {
    this.ready(run); const lease = this.backup.current()!, files: NativeBackupFile[] = []; let budget = 0;
    for (const file of [...this.copiedFiles.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      budget += encode(file).byteLength; if (budget > MANIFEST_LIMIT - 4096) fail('native_backup_manifest_limit'); files.push(file);
    }
    if (files.length !== run.files || files.reduce((sum, file) => sum + file.bytes, 0) !== run.bytes) fail('native_backup_checkpoint_invalid');
    const manifest: NativeBackupManifest = { version: 2, format: 'mailhero.native-backup.v2', encrypted: false,
      backup_id: run.id!, created_at: lease.created_at, cut_at: lease.cut_at!, cut_seq: lease.cut_seq!, build_sha: this.env.BUILD_SHA ?? null,
      source_manifest_sha256: run.source_hash!, credential_key_included: false, files };
    const bytes = encode(manifest), checksum = await sha256Bytes(bytes);
    if (bytes.byteLength > MANIFEST_LIMIT || (run.bytes ?? 0) + bytes.byteLength > this.limit(run)) fail('native_backup_manifest_limit');
    const key = `${run.prefix}/manifest.json`;
    await this.env.BACKUP_STORE!.put(key, bytes, { httpMetadata: { contentType: 'application/json' }, customMetadata: { backup_id: run.id!, sha256: checksum, manifest_sha256: checksum } });
    await this.readback(key, bytes.byteLength, checksum); this.ready(run);
    run.marker = { version: 2, backup_id: run.id!, key, sha256: checksum, manifest_sha256: checksum, created_at: lease.created_at,
      verified_at: new Date().toISOString(), size_bytes: (run.bytes ?? 0) + bytes.byteLength, object_count: files.length + 1, proof: 'native_readback_verified' };
    run.phase = 'commit';
  }
  private async step(run: Run): Promise<{ bytes: number; stop?: boolean }> {
    let bytes = 0;
    if (run.phase === 'begin') {
      if (!this.env.BACKUP_STORE) fail('native_backup_store_unconfigured');
      nextNativeBackupAt(Date.now(), this.env.NATIVE_BACKUP_AT_UTC); run.max_bytes ??= this.limit(run);
      if (this.backup.paused()) {
        if (!run.id && this.backup.current()?.executor === 'native') this.adopt(run); else run.next_at = Date.now() + 60_000;
        return { bytes, stop: true };
      }
      await this.backup.beginNative(); this.adopt(run);
    } else if (run.phase === 'waiting') {
      await this.backup.progress();
      if (this.backup.nativeReady(run.id!)) {
        await reserveNativeBackup(this.env, run.id!, run.date!, this.limit(run)); run.phase = 'export'; run.section = 'control';
      } else if (!this.backup.paused()) fail('native_backup_lease_expired');
      return { bytes, stop: true };
    } else if (run.phase === 'export') {
      if (run.section === 'control') {
        const data = await this.exported(run, 'control'); bytes = await this.copyBytes(run, 'control.json', 'control', data.bytes); run.section = 'schema';
      } else if (run.section === 'schema') {
        const data = await this.exported(run, 'database-schema'); bytes = await this.copyBytes(run, 'database-schema.json', 'schema', data.bytes);
        run.tables = data.value.tables; run.table_index = 0; run.offset = 0; run.section = 'table';
      } else {
        const table = run.tables?.[run.table_index ?? 0], offset = run.offset ?? 0;
        if (!table) run.phase = 'inventory';
        else {
          const data = await this.exported(run, `database?table=${encodeURIComponent(table)}&offset=${offset}`);
          bytes = await this.copyBytes(run, `database/${table}/${offset}.json`, 'database', data.bytes);
          if (data.value.next_offset === null) { run.table_index = (run.table_index ?? 0) + 1; run.offset = 0; } else run.offset = data.value.next_offset;
        }
      }
    } else if (run.phase === 'inventory') {
      const data = await this.exported(run, `objects${run.inventory_cursor ? `?cursor=${encodeURIComponent(run.inventory_cursor)}` : ''}`);
      this.objects.push(...data.value.objects); this.progressDirty = true;
      run.inventory_cursor = data.value.next_cursor;
      run.inventory_count = (run.inventory_count ?? 0) + data.value.objects.length;
      run.inventory_bytes = (run.inventory_bytes ?? 0) + data.value.objects.reduce((sum: number, object: NativeBackupObject) => sum + object.size, 0);
      if (run.inventory_count! + (run.files ?? 0) + 3 > MAX_FILES || run.inventory_bytes! + (run.bytes ?? 0) + 2 * MANIFEST_LIMIT > this.limit(run)) fail('native_backup_snapshot_limit');
      if (data.value.complete) run.phase = 'copy';
    } else if (run.phase === 'copy') {
      const sources = this.objects.filter(object => object.key > (run.object_cursor ?? '')).slice(0, COPY_GROUP);
      if (sources.length) bytes = await this.copyGroup(run, sources);
      else {
        const source = await this.backup.prepareNativeManifest(this.objects), body = encode(source.manifest);
        if (await sha256Bytes(body) !== source.manifest_sha256) fail('native_backup_manifest_changed');
        run.source_hash = source.manifest_sha256; bytes = await this.copyBytes(run, 'source-manifest.json', 'source_manifest', body); run.phase = 'journal';
      }
    } else if (run.phase === 'journal') {
      this.ready(run);
      if (!run.journal_done) {
        const page = await this.env.BACKUP_STORE!.list({ prefix: 'deletion-journal/', limit: 20, cursor: run.journal_cursor ?? undefined });
        this.spent.subrequests += 1 + page.objects.length;
        const items: Row[] = [];
        for (const object of page.objects) {
          const value = await this.env.BACKUP_STORE!.get(object.key); if (!value || value.size > 4096) fail('native_backup_deletion_journal_invalid');
          const item = await value!.json<Row>();
          if (!UUID.test(item.id) || !['raw', 'content'].includes(item.scope) || !Number.isFinite(Date.parse(item.deleted_at)) ||
            object.key !== `deletion-journal/${item.id}/${item.scope}.json`) fail('native_backup_deletion_journal_invalid');
          items.push({ id: item.id, scope: item.scope, deleted_at: item.deleted_at });
        }
        this.deletions.push(...items); this.progressDirty ||= items.length > 0;
        run.journal_count = (run.journal_count ?? 0) + page.objects.length;
        if (run.journal_count > MAX_JOURNAL_ENTRIES) fail('native_backup_deletion_journal_limit');
        run.journal_cursor = page.truncated ? page.cursor : null; run.journal_done = !page.truncated;
      } else {
        const body = encode({ version: 1, fetched_at: this.backup.current()!.cut_at,
          items: [...this.deletions].sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope)) });
        if (body.byteLength > MANIFEST_LIMIT) fail('native_backup_deletion_journal_limit');
        bytes = await this.copyBytes(run, 'snapshot-deletions.json', 'deletions', body); run.phase = 'validate'; run.validation_table = 'messages'; run.validation_cursor = 0;
      }
    } else if (run.phase === 'validate') {
      this.ready(run); if (await this.validate(run)) run.phase = 'manifest'; this.ready(run);
    } else if (run.phase === 'manifest') { await this.writeManifest(run); return { bytes, stop: true };
    } else if (run.phase === 'commit') { await this.backup.commitNativeVerified(run.marker!, run.source_hash!); run.phase = 'marker';
    } else if (run.phase === 'marker') { await writeNativeVerifiedMarker(this.env, run.marker!); await this.backup.finalizeNativeMarker(run.id!); run.phase = 'prune';
    } else if (run.phase === 'prune') {
      const result = await pruneNativeBackupsStep(this.env, run.id!, run.prune_cursor); run.prune_cursor = result.cursor;
      if (result.done) { this.clearCopies(); run.phase = 'complete'; run.error = null; run.next_at = this.nextDaily(); }
      return { bytes, stop: true };
    } else if (run.phase === 'cleanup') {
      if (!run.id || await abandonNativeBackupStep(this.env, run.id, run.date!)) { this.clearCopies(); run.phase = 'failed'; run.next_at = this.nextDaily(); }
      return { bytes, stop: true };
    }
    return { bytes };
  }
  async tick(now = Date.now()): Promise<boolean> {
    let run = this.read();
    if (run.phase === 'failed' && run.manual_required) return false;
    if ((!this.active(run) && !this.enabled()) || run.next_at > now || this.env.MAINTENANCE_MODE === 'true') return false;
    try {
      if (!this.active(run)) { this.clearCopies(); run = { phase: 'begin', next_at: now, error: null, files: 0, bytes: 0 }; this.save(run); }
      await this.storage.setAlarm(Date.now() + 60_000);
      this.spent = { bytes: 0, subrequests: 0, queries: 0 };
      await this.loadProgress(run); const started = Date.now();
      while (this.spent.bytes < TICK_BYTES && this.spent.subrequests + STEP_SUBREQUESTS <= TICK_SUBREQUESTS &&
        this.spent.queries < TICK_QUERIES && Date.now() - started < TICK_MS) {
        run.next_at = Date.now() + 1000; const result = await this.step(run); this.spent.bytes += result.bytes;
        if (result.stop || !this.active(run) || run.next_at > Date.now() + 1000) break;
      }
    } catch (error) {
      const known = error instanceof Error && /^native_backup_[a-z_]{1,64}$/.test(error.message), code = known ? error.message : 'native_backup_failed';
      const lease = this.backup.current();
      if (!run.id && run.phase === 'begin' && lease?.executor === 'native' && this.backup.paused()) this.adopt(run);
      if (lease && lease.id === run.id && lease.state === 'remote_verified' && lease.verification === 'native_readback_verified') {
        run.next_at = Date.now() + 60_000; run.error = 'native_backup_completion_retry';
      } else if (!known && lease && lease.id === run.id && this.backup.paused() && lease.expires_at > Date.now() + 30_000) {
        run.next_at = Date.now() + 30_000; run.error = 'native_backup_stage_retry';
      } else {
        if (run.id) await this.backup.cancelNative(run.id).catch(() => undefined);
        run.error = code; run.phase = run.id ? 'cleanup' : 'failed'; run.manual_required ||= known && code !== 'native_backup_lease_expired';
        run.next_at = run.id ? Date.now() + 60_000 : this.nextDaily();
      }
    }
    await this.checkpoint(run);
    return true;
  }
}

async function boundedBytes(stream: ReadableStream<Uint8Array> | null, maximum: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength; if (length > maximum) { await reader.cancel(); fail('native_backup_source_limit'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
