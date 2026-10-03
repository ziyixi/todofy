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
  files?: number; bytes?: number; source_hash?: string; marker?: NativeBackupMarker; prune_cursor?: unknown;
}
interface FileRow extends Row { path: string; kind: NativeBackupFile['kind']; bytes: number; sha256: string; object_key: string | null }
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
  private file(path: string): FileRow | undefined {
    return this.storage.sql.exec<FileRow>('SELECT * FROM native_backup_copies WHERE path=?', path).toArray()[0];
  }
  private async exported(run: Run, path: string): Promise<{ bytes: Uint8Array; value: Row }> {
    this.ready(run);
    const response = await this.backup.fetch(new Request(`https://coordinator/backup/${path}${path.includes('?') ? '&' : '?'}backup_id=${run.id}`));
    if (!response?.ok) fail('native_backup_export_failed');
    const bytes = await boundedBytes(response!.body, SOURCE_LIMIT); this.ready(run);
    try { return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }; }
    catch { return fail('native_backup_export_invalid'); }
  }
  private checkNewFile(run: Run, bytes: number): void {
    if ((run.files ?? 0) + 1 >= MAX_FILES) fail('native_backup_file_limit'); // Reserve the final manifest.
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > SOURCE_LIMIT || (run.bytes ?? 0) + bytes > this.limit(run)) fail('native_backup_snapshot_limit');
  }
  private register(run: Run, file: NativeBackupFile): void {
    this.ready(run);
    this.storage.transactionSync(() => {
      this.storage.sql.exec('INSERT INTO native_backup_copies VALUES(?,?,?,?,?)', file.path, file.kind, file.bytes, file.sha256, file.object_key ?? null);
      run.files = (run.files ?? 0) + 1; run.bytes = (run.bytes ?? 0) + file.bytes;
      if (file.object_key) run.object_cursor = file.object_key;
      this.save(run);
    });
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
    await this.env.BACKUP_STORE!.put(key, bytes, { httpMetadata: { contentType: 'application/json' }, customMetadata: { backup_id: run.id!, sha256: checksum } });
    await this.readback(key, bytes.byteLength, checksum);
    this.register(run, { path, kind, bytes: bytes.byteLength, sha256: checksum });
    return bytes.byteLength;
  }
  private async copyObject(run: Run, source: NativeBackupObject): Promise<number> {
    this.ready(run);
    const path = `objects/${await sha256Bytes(new TextEncoder().encode(source.key))}.bin`, existing = this.file(path);
    if (existing) {
      if (existing.bytes !== source.size || existing.object_key !== source.key) fail('native_backup_source_changed');
      run.object_cursor = source.key; return 0;
    }
    this.checkNewFile(run, source.size);
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
    return source.size;
  }
  private async reference(key: unknown, kind: string): Promise<FileRow> {
    if (typeof key !== 'string' || !key) return fail(`native_backup_${kind}_reference_missing`);
    const path = `objects/${await sha256Bytes(new TextEncoder().encode(key))}.bin`, file = this.file(path);
    if (!file || file.object_key !== key) return fail(`native_backup_${kind}_reference_missing`);
    return file;
  }
  private async validate(run: Run): Promise<boolean> {
    if (run.validation_table === 'messages') {
      const rows = (await this.env.DB.prepare(`SELECT rowid AS cursor,id,content_deleted_at,raw_expired_at,origin,raw_key,parsed_key,parse_state
        FROM messages WHERE rowid>? ORDER BY rowid LIMIT 10`).bind(run.validation_cursor ?? 0).all<Row>()).results;
      for (const message of rows) {
        if (!message.content_deleted_at) {
          if (!message.raw_expired_at && (message.origin !== 'synthetic_test' || message.raw_key)) await this.reference(message.raw_key, 'raw');
          if (message.parsed_key || message.parse_state === 'ready') {
            const file = await this.reference(message.parsed_key, 'parsed'), saved = await this.env.BACKUP_STORE!.get(`${run.prefix}/${file.path}`);
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
    for (const row of this.storage.sql.exec<FileRow>('SELECT * FROM native_backup_copies ORDER BY path')) {
      const file: NativeBackupFile = { path: row.path, kind: row.kind, bytes: row.bytes, sha256: row.sha256, ...(row.object_key ? { object_key: row.object_key } : {}) };
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
    run.phase = 'commit'; this.save(run);
  }
  private async step(run: Run): Promise<{ bytes: number; stop?: boolean }> {
    let bytes = 0;
    if (run.phase === 'begin') {
      if (!this.env.BACKUP_STORE) fail('native_backup_store_unconfigured');
      nextNativeBackupAt(Date.now(), this.env.NATIVE_BACKUP_AT_UTC); run.max_bytes ??= this.limit(run);
      if (this.backup.paused()) {
        if (!run.id && this.backup.current()?.executor === 'native') this.adopt(run); else run.next_at = Date.now() + 60_000;
        this.save(run); return { bytes, stop: true };
      }
      await this.backup.beginNative(); this.adopt(run);
    } else if (run.phase === 'waiting') {
      await this.backup.progress();
      if (this.backup.nativeReady(run.id!)) {
        await reserveNativeBackup(this.env, run.id!, run.date!, this.limit(run)); run.phase = 'export'; run.section = 'control';
      } else if (!this.backup.paused()) fail('native_backup_lease_expired');
      this.save(run); return { bytes, stop: true };
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
      run.inventory_cursor = data.value.next_cursor;
      run.inventory_count = (run.inventory_count ?? 0) + data.value.objects.length;
      run.inventory_bytes = (run.inventory_bytes ?? 0) + data.value.objects.reduce((sum: number, object: NativeBackupObject) => sum + object.size, 0);
      if (run.inventory_count! + (run.files ?? 0) + 3 > MAX_FILES || run.inventory_bytes! + (run.bytes ?? 0) + 2 * MANIFEST_LIMIT > this.limit(run)) fail('native_backup_snapshot_limit');
      if (data.value.complete) run.phase = 'copy'; this.save(run); return { bytes, stop: true };
    } else if (run.phase === 'copy') {
      const row = this.storage.sql.exec<{ metadata: string }>('SELECT metadata FROM backup_objects WHERE backup_id=? AND key>? ORDER BY key LIMIT 1', run.id!, run.object_cursor ?? '').toArray()[0];
      if (row) bytes = await this.copyObject(run, JSON.parse(row.metadata));
      else {
        const source = await this.exported(run, 'manifest'), body = encode(source.value.manifest);
        if (await sha256Bytes(body) !== source.value.manifest_sha256) fail('native_backup_manifest_changed');
        run.source_hash = source.value.manifest_sha256; bytes = await this.copyBytes(run, 'source-manifest.json', 'source_manifest', body); run.phase = 'journal';
      }
    } else if (run.phase === 'journal') {
      this.ready(run);
      if (!run.journal_done) {
        const page = await this.env.BACKUP_STORE!.list({ prefix: 'deletion-journal/', limit: 20, cursor: run.journal_cursor ?? undefined });
        for (const object of page.objects) {
          const value = await this.env.BACKUP_STORE!.get(object.key); if (!value || value.size > 4096) fail('native_backup_deletion_journal_invalid');
          const item = await value!.json<Row>();
          if (!UUID.test(item.id) || !['raw', 'content'].includes(item.scope) || !Number.isFinite(Date.parse(item.deleted_at)) ||
            object.key !== `deletion-journal/${item.id}/${item.scope}.json`) fail('native_backup_deletion_journal_invalid');
          this.storage.sql.exec('INSERT INTO native_backup_deletions VALUES(?,?,?) ON CONFLICT(id,scope) DO UPDATE SET deleted_at=max(deleted_at,excluded.deleted_at)', item.id, item.scope, item.deleted_at);
        }
        run.journal_count = (run.journal_count ?? 0) + page.objects.length;
        if (run.journal_count > MAX_JOURNAL_ENTRIES) fail('native_backup_deletion_journal_limit');
        run.journal_cursor = page.truncated ? page.cursor : null; run.journal_done = !page.truncated;
      } else {
        const body = encode({ version: 1, fetched_at: this.backup.current()!.cut_at,
          items: this.storage.sql.exec<Row>('SELECT id,scope,deleted_at FROM native_backup_deletions ORDER BY id,scope').toArray() });
        if (body.byteLength > MANIFEST_LIMIT) fail('native_backup_deletion_journal_limit');
        bytes = await this.copyBytes(run, 'snapshot-deletions.json', 'deletions', body); run.phase = 'validate'; run.validation_table = 'messages'; run.validation_cursor = 0;
      }
      this.save(run); return { bytes, stop: true };
    } else if (run.phase === 'validate') {
      this.ready(run); if (await this.validate(run)) run.phase = 'manifest'; this.ready(run); this.save(run); return { bytes, stop: true };
    } else if (run.phase === 'manifest') { await this.writeManifest(run); return { bytes, stop: true };
    } else if (run.phase === 'commit') { await this.backup.commitNativeVerified(run.marker!, run.source_hash!); run.phase = 'marker';
    } else if (run.phase === 'marker') { await writeNativeVerifiedMarker(this.env, run.marker!); await this.backup.finalizeNativeMarker(run.id!); run.phase = 'prune';
    } else if (run.phase === 'prune') {
      const result = await pruneNativeBackupsStep(this.env, run.id!, run.prune_cursor); run.prune_cursor = result.cursor;
      if (result.done) { this.clearCopies(); run.phase = 'complete'; run.error = null; run.next_at = this.nextDaily(); }
      this.save(run); return { bytes, stop: true };
    } else if (run.phase === 'cleanup') {
      if (!run.id || await abandonNativeBackupStep(this.env, run.id, run.date!)) { this.clearCopies(); run.phase = 'failed'; run.next_at = this.nextDaily(); }
      this.save(run); return { bytes, stop: true };
    }
    this.save(run); return { bytes };
  }
  async tick(now = Date.now()): Promise<boolean> {
    let run = this.read();
    if (run.phase === 'failed' && run.manual_required) return false;
    if ((!this.active(run) && !this.enabled()) || run.next_at > now || this.env.MAINTENANCE_MODE === 'true') return false;
    try {
      if (!this.active(run)) { this.clearCopies(); run = { phase: 'begin', next_at: now, error: null, files: 0, bytes: 0 }; this.save(run); }
      await this.storage.setAlarm(Date.now() + 60_000);
      let bytes = 0; const started = Date.now();
      for (let actions = 0; actions < 8 && bytes < 8 * MIB && Date.now() - started < 10_000; actions++) {
        run.next_at = Date.now() + 1000; const result = await this.step(run); bytes += result.bytes;
        if (result.stop || !this.active(run) || run.next_at > Date.now() + 1000) break;
      }
      this.save(run);
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
      this.save(run);
    }
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
