import type { Env } from './types.ts';
import { canonicalJSON, verifyBackupReceipt, type BackupReceipt } from './backup.ts';
import { sha256 } from './security.ts';
import type { NativeBackupMarker } from './native-backup-format.ts';

type Row = Record<string, any>;
interface Lease {
  id: string; state: 'draining' | 'settling' | 'ready' | 'expired' | 'cancelled' | 'remote_verified';
  created_at: string; expires_at: number; cut_seq: number | null; cut_at: string | null;
  policy: Row | null; objects_done: boolean; object_cursor: string | null;
  control_sha256?: string; schema_sha256?: string; tables?: string[];
  manifest_sha256?: string; remote_locator?: string; verified_at?: string; receipt_sync_pending?: boolean;
  executor?: 'native' | 'external'; verification?: 'native_readback_verified'; source_manifest_sha256?: string;
  native_marker_pending?: boolean;
}
const activeStates = new Set(['draining', 'settling', 'ready']);
const TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PAGE_SIZE = 100;
const ROWID = '__mailhero_rowid';
const EXPORT_MAX_ROWS = 50_000;
const EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const responseError = (status: number, code: string) => Response.json({ error: { code } }, { status });

export async function readIntakePolicy(env: Env): Promise<Row> {
  const value = await env.DB.prepare(`SELECT s.*,r.id AS revision_id FROM app_settings s
    LEFT JOIN webhook_endpoints e ON e.id=s.current_endpoint_id
    LEFT JOIN endpoint_revisions r ON r.id=e.current_revision_id WHERE s.id=1`).first<Row>();
  if (!value) throw new Error('policy_unavailable');
  return { mode: value.mode === 'forward' && value.revision_id ? 'forward' : 'archive',
    revision: value.mode === 'forward' ? value.revision_id ?? '' : '', policy_error: '',
    lifecycle_policy_version: value.lifecycle_policy_version ?? null,
    raw_retention_days: value.raw_retention_days ?? null,
    content_retention_days: value.content_retention_days ?? null,
    ledger_retention_days: value.ledger_retention_days ?? null };
}

/** Snapshot coordinator. This object never exports application encryption keys.
 * A backup freezes normal writes but raw intake remains durably sequenced. */
export class BackupState {
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;
  private readonly pipelineRunning: () => boolean;
  constructor(storage: DurableObjectStorage, env: Env, pipelineRunning: () => boolean) {
    this.storage = storage; this.env = env; this.pipelineRunning = pipelineRunning;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS backup_control(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mutation_leases(id TEXT PRIMARY KEY,created INTEGER NOT NULL)');
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS backup_objects
      (backup_id TEXT NOT NULL,key TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(backup_id,key))`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS backup_object_pages
      (backup_id TEXT NOT NULL,cursor TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(backup_id,cursor))`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS backup_blocks
      (backup_id TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(backup_id,name))`);
    // Keyset position after each full database page, keyed by its block name.
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS backup_table_cursors
      (backup_id TEXT NOT NULL,name TEXT NOT NULL,last_rowid INTEGER NOT NULL,PRIMARY KEY(backup_id,name))`);
  }
  private read(): Lease | null {
    const value = this.storage.sql.exec<{ value: string }>('SELECT value FROM backup_control WHERE id=1').toArray()[0]?.value;
    return value ? JSON.parse(value) : null;
  }
  private save(lease: Lease): void {
    this.storage.sql.exec('INSERT INTO backup_control VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(lease));
  }
  current(): Lease | null {
    const lease = this.read();
    if (lease && activeStates.has(lease.state) && lease.expires_at <= Date.now()) {
      lease.state = 'expired'; this.save(lease);
    }
    return lease;
  }
  paused(): boolean { const lease = this.current(); return !!lease && activeStates.has(lease.state); }
  nextExpiry(): number | null { const lease = this.current(); return lease && activeStates.has(lease.state) ? lease.expires_at : null; }
  frozenPolicy(): Row | null { const lease = this.current(); return lease && activeStates.has(lease.state) ? lease.policy : null; }
  /** Internal entry point, never selected by an HTTP request body. */
  async beginNative(): Promise<string> {
    const response = await this.fetch(new Request('https://coordinator/backup/begin', {
      method: 'POST', body: JSON.stringify({ lease_seconds: 1800 }),
    }), 'native');
    if (!response?.ok) throw new Error('native_backup_begin_unavailable');
    const value = await response.json() as Row;
    const lease = this.current();
    if (!lease || lease.id !== value.backup_id || !activeStates.has(lease.state)) throw new Error('native_backup_begin_unavailable');
    lease.executor = 'native'; this.save(lease);
    return lease.id;
  }
  nativeReady(id: string): boolean { return this.requireReady(id)?.executor === 'native'; }
  async cancelNative(id: string): Promise<void> {
    const lease = this.current();
    if (lease?.id !== id || lease.executor !== 'native' || !activeStates.has(lease.state)) return;
    lease.state = 'cancelled'; this.save(lease);
  }
  /** The native runner has copied and read-back verified every snapshot file.
   * This is intentionally not exposed by fetch(): the external HMAC contract
   * cannot be bypassed by setting a request's proof/type field. */
  async commitNativeVerified(marker: NativeBackupMarker, sourceManifestHash: string): Promise<void> {
    const completed = this.current();
    if (completed?.id === marker.backup_id && completed.state === 'remote_verified' &&
      completed.verification === 'native_readback_verified' && completed.manifest_sha256 === marker.manifest_sha256 &&
      completed.source_manifest_sha256 === sourceManifestHash && completed.remote_locator === marker.key) return;
    const lease = this.requireReady(marker.backup_id);
    if (!lease || lease.executor !== 'native' || marker.proof !== 'native_readback_verified' ||
      !/^[0-9a-f]{64}$/.test(marker.manifest_sha256) || !/^[0-9a-f]{64}$/.test(marker.sha256)) throw new Error('native_backup_not_ready');
    const exported = await this.fetch(new Request(`https://coordinator/backup/manifest?backup_id=${lease.id}`));
    if (!exported?.ok) throw new Error('native_backup_incomplete');
    const manifest = await exported.json() as Row;
    if (manifest.manifest_sha256 !== sourceManifestHash || !this.nativeReady(lease.id)) throw new Error('native_backup_manifest_changed');
    lease.state = 'remote_verified'; lease.manifest_sha256 = marker.manifest_sha256;
    lease.source_manifest_sha256 = sourceManifestHash; lease.remote_locator = marker.key;
    lease.verified_at = marker.verified_at; lease.verification = marker.proof;
    lease.receipt_sync_pending = true; lease.native_marker_pending = true; this.save(lease);
  }
  async finalizeNativeMarker(id: string): Promise<void> {
    const lease = this.current();
    if (lease?.id !== id || lease.state !== 'remote_verified' || lease.verification !== 'native_readback_verified') throw new Error('native_backup_not_committed');
    lease.native_marker_pending = false; this.save(lease);
    await this.syncReceipt();
  }
  status(): Row {
    const lease = this.current();
    const writers = this.storage.sql.exec<{ count: number; oldest: number | null }>('SELECT count(*) count,min(created) oldest FROM mutation_leases').one();
    return { ...(lease ?? { state: 'idle' }), executor: lease?.executor ?? 'external', backup_id: lease?.id ?? null, paused: this.paused(),
      active_writers: writers.count, oldest_writer_at: writers.oldest,
      pending_uploads: lease?.cut_seq === null || !lease ? null : this.storage.sql.exec<{ count: number }>(
        "SELECT count(*) count FROM ingest_uploads WHERE seq<=? AND status='uploading'", lease.cut_seq).one().count };
  }
  async progress(): Promise<void> {
    let lease = this.current();
    if (!lease || !activeStates.has(lease.state)) return;
    const progressingID = lease.id;
    if (lease.state === 'draining') {
      if (this.pipelineRunning() || this.storage.sql.exec<{ n: number }>('SELECT count(*) n FROM mutation_leases').one().n) return;
      const policy = await readIntakePolicy(this.env);
      lease = this.current();
      if (!lease || lease.id !== progressingID || lease.state !== 'draining') return;
      lease.policy = policy;
      lease.cut_seq = this.storage.sql.exec<{ seq: number }>('SELECT value seq FROM intake_control WHERE id=1').one().seq;
      lease.cut_at = new Date().toISOString(); lease.state = 'settling'; this.save(lease);
    }
    if (lease.state === 'settling') {
      const waiting = this.storage.sql.exec<{ key: string; seq: number }>(
        "SELECT key,seq FROM ingest_uploads WHERE seq<=? AND status='uploading' ORDER BY seq LIMIT 20", lease.cut_seq!).toArray();
      for (const item of waiting) {
        const object = await this.env.MAIL_STORE.head(item.key);
        if (object && object.customMetadata?.ingest_seq === String(item.seq)) this.storage.sql.exec(
          "UPDATE ingest_uploads SET status='saved',settled=? WHERE key=? AND status='uploading'", Date.now(), item.key);
      }
      lease = this.current();
      if (!lease || lease.id !== progressingID || lease.state !== 'settling') return;
      const pending = this.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM ingest_uploads WHERE seq<=? AND status='uploading'", lease.cut_seq!).one().n;
      if (!pending) { lease.state = 'ready'; this.save(lease); }
    }
  }
  async syncReceipt(): Promise<void> {
    const lease = this.current();
    if (lease?.state !== 'remote_verified' || !lease.receipt_sync_pending || !lease.verified_at || lease.native_marker_pending) return;
    try {
      await this.env.DB.prepare('UPDATE app_settings SET last_backup_at=? WHERE id=1 AND (last_backup_at IS NULL OR last_backup_at<?)')
        .bind(lease.verified_at, lease.verified_at).run();
      const current = this.current();
      if (current?.id === lease.id && current.state === 'remote_verified') { current.receipt_sync_pending = false; this.save(current); }
    } catch { /* Receipt is durable in DO; Alarm retries the metadata index. */ }
  }
  private requireReady(id: string | null): Lease | null {
    const lease = this.current(); return lease?.id === id && lease.state === 'ready' ? lease : null;
  }
  private nativeRunActive(): boolean {
    // The native runner must durably finish its marker/index/rotation before an
    // external begin may replace backup_control. Its progress is written before
    // releasing this guard, so a crash cannot strand an old completion behind a
    // new lease. Older objects/tests may not have initialized the runner yet.
    if (!this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='native_backup_control'").toArray().length) return false;
    const row = this.storage.sql.exec<{ value: string }>('SELECT value FROM native_backup_control WHERE id=1').toArray()[0];
    if (!row) return false;
    const value = JSON.parse(row.value) as { phase?: string };
    return !!value.phase && !['idle', 'complete', 'failed'].includes(value.phase);
  }
  private block(lease: Lease, name: string, value: Row): void {
    this.storage.sql.exec('INSERT INTO backup_blocks VALUES(?,?,?) ON CONFLICT(backup_id,name) DO UPDATE SET value=excluded.value',
      lease.id, name, canonicalJSON(value));
  }
  private blockValue(lease: Lease, name: string): Row | null {
    const row = this.storage.sql.exec<{ value: string }>('SELECT value FROM backup_blocks WHERE backup_id=? AND name=?', lease.id, name).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  private async exportBlock(lease: Lease, name: string, data: unknown, extra: Row = {}): Promise<Response> {
    const serialized = canonicalJSON(data), hash = await sha256(serialized);
    if (!this.requireReady(lease.id)) return responseError(409, 'backup_lease_expired');
    this.block(lease, name, { name, sha256: hash, bytes: new TextEncoder().encode(serialized).length, ...extra });
    return new Response(serialized, { headers: { 'Content-Type': 'application/json', 'X-Content-SHA256': hash } });
  }
  private manifestFits(lease: Lease): boolean {
    const objects = this.storage.sql.exec<{ n: number; bytes: number }>('SELECT count(*) n,COALESCE(sum(length(CAST(metadata AS BLOB))),0) bytes FROM backup_objects WHERE backup_id=?', lease.id).one();
    const blocks = this.storage.sql.exec<{ n: number; bytes: number }>('SELECT count(*) n,COALESCE(sum(length(CAST(value AS BLOB))),0) bytes FROM backup_blocks WHERE backup_id=?', lease.id).one();
    return objects.n + blocks.n <= EXPORT_MAX_ROWS && objects.bytes + blocks.bytes + 1024 <= EXPORT_MAX_BYTES;
  }
  private async manifest(lease: Lease): Promise<{ value: Row; hash: string }> {
    const blocks = this.storage.sql.exec<{ value: string }>('SELECT value FROM backup_blocks WHERE backup_id=? ORDER BY name', lease.id).toArray().map(row => JSON.parse(row.value));
    const objects = this.storage.sql.exec<{ metadata: string }>('SELECT metadata FROM backup_objects WHERE backup_id=? ORDER BY key', lease.id).toArray().map(row => JSON.parse(row.metadata));
    const value = { version: 1, backup_id: lease.id, created_at: lease.created_at, cut_at: lease.cut_at,
      cut_seq: lease.cut_seq, blocks, objects, credential_key_included: false };
    return { value, hash: await sha256(canonicalJSON(value)) };
  }
  async fetch(request: Request, executor: 'native' | 'external' = 'external'): Promise<Response | null> {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/mutation/begin' && request.method === 'POST') {
      if (this.paused()) return responseError(503, 'backup_in_progress');
      const id = crypto.randomUUID(); this.storage.sql.exec('INSERT INTO mutation_leases VALUES(?,?)', id, Date.now());
      return Response.json({ id });
    }
    if (path === '/mutation/end' && request.method === 'POST') {
      const input = await request.json() as Row;
      if (typeof input.id !== 'string') return responseError(400, 'invalid_lease');
      this.storage.sql.exec('DELETE FROM mutation_leases WHERE id=?', input.id);
      return new Response(null, { status: 204 });
    }
    if (!path.startsWith('/backup/')) return null;
    if (path === '/backup/writers' && request.method === 'GET') {
      const rows = this.storage.sql.exec<{ id: string; created: number }>('SELECT id,created FROM mutation_leases ORDER BY created LIMIT 100').toArray();
      return Response.json({ writers: rows.map(row => ({ id: row.id, created_at: new Date(row.created).toISOString(), age_ms: Math.max(0,Date.now()-row.created) })) });
    }
    if (path === '/backup/reconcile-writer' && request.method === 'POST') {
      const input = await request.json() as Row;
      if (this.env.MAINTENANCE_MODE !== 'true' || input.confirmed_quiescent !== true || typeof input.writer_id !== 'string') return responseError(409, 'maintenance_and_quiescence_confirmation_required');
      if (this.paused()) return responseError(409, 'cancel_backup_before_writer_reconciliation');
      const writer = this.storage.sql.exec<{ created: number }>('SELECT created FROM mutation_leases WHERE id=?', input.writer_id).toArray()[0];
      if (!writer) return responseError(404, 'writer_not_found');
      if (Date.now()-writer.created < 15*60_000) return responseError(409, 'writer_not_old_enough');
      this.storage.sql.exec('DELETE FROM mutation_leases WHERE id=?', input.writer_id);
      return Response.json({ reconciled: true, writer_id: input.writer_id });
    }
    if (path === '/backup/status' && request.method === 'GET') {
      await this.progress(); await this.syncReceipt(); const { policy: _policy, ...publicStatus } = this.status(); return Response.json(publicStatus);
    }
    if (path === '/backup/begin' && request.method === 'POST') {
      if (executor === 'external' && this.env.NATIVE_BACKUP_ENABLED === 'true') return responseError(410, 'native_backup_runner_required');
      if (this.paused()) return responseError(409, 'backup_already_active');
      if (executor === 'external' && this.nativeRunActive()) return responseError(409, 'native_backup_completion_pending');
      await this.syncReceipt();
      if (this.current()?.receipt_sync_pending) return responseError(503, 'backup_receipt_index_pending');
      const input = await request.json() as Row;
      const seconds = input.lease_seconds ?? 900;
      if (!Number.isInteger(seconds) || seconds < 30 || seconds > 1800) return responseError(400, 'invalid_lease_duration');
      if (this.paused()) return responseError(409, 'backup_already_active');
      const lease: Lease = { id: crypto.randomUUID(), state: 'draining', created_at: new Date().toISOString(),
        expires_at: Date.now() + seconds * 1000, cut_seq: null, cut_at: null, policy: null, objects_done: false, object_cursor: null, executor };
      this.save(lease);
      // Previous inventories are backup-only metadata. Keep the last receipt in
      // the external verified backup instead of growing the live DO forever.
      this.storage.sql.exec('DELETE FROM backup_objects'); this.storage.sql.exec('DELETE FROM backup_blocks'); this.storage.sql.exec('DELETE FROM backup_object_pages');
      this.storage.sql.exec('DELETE FROM backup_table_cursors');
      await this.progress();
      const { policy: _policy, ...publicStatus } = this.status(); return Response.json(publicStatus);
    }
    if (path === '/backup/cancel' && request.method === 'POST') {
      const input = await request.json() as Row, lease = this.current();
      if (lease?.executor === 'native' && executor === 'external') return responseError(409, 'native_backup_owned');
      if (!lease || lease.id !== input.backup_id || !activeStates.has(lease.state)) return responseError(409, 'backup_not_active');
      lease.state = 'cancelled'; this.save(lease); return Response.json({ backup_id: lease.id, state: lease.state });
    }
    const input = request.method === 'POST' ? await request.json() as Row : null;
    const completed = this.current();
    if (path === '/backup/finish' && completed?.executor === 'native' && executor === 'external') return responseError(409, 'native_backup_owned');
    if (path === '/backup/finish' && completed && completed.id === input?.backup_id && completed.state === 'remote_verified' && input?.manifest_sha256 === completed.manifest_sha256) {
      await this.syncReceipt(); return Response.json({ backup_id: completed.id, state: completed.state, manifest_sha256: completed.manifest_sha256, receipt_sync_pending: this.current()?.receipt_sync_pending ?? false });
    }
    const lease = this.requireReady(input?.backup_id ?? url.searchParams.get('backup_id'));
    if (!lease) return responseError(409, 'backup_not_ready_or_expired');
    if (path === '/backup/control' && request.method === 'GET') {
      // Completed ingestion history is already represented in D1 and immutable
      // R2 metadata. Keep only the upload state still needed by scheduler jobs.
      // Keys come from the unsettled-status index and the job list, never from
      // a walk over all intake history.
      const uploadPredicate = `u.key IN(SELECT key FROM ingest_uploads INDEXED BY ingest_uploads_status WHERE status='uploading' AND seq<=?
        UNION SELECT substr(id,7) FROM jobs WHERE substr(id,1,6)='parse:') AND u.seq<=?`;
      const totals = this.storage.sql.exec<{ n: number; bytes: number }>(`SELECT sum(n) n,sum(bytes) bytes FROM (
        SELECT count(*) n,COALESCE(sum(1024+6*length(CAST(policy AS BLOB))),0) bytes FROM ingest_uploads u WHERE ${uploadPredicate}
        UNION ALL SELECT count(*),COALESCE(sum(1024+6*length(CAST(payload AS BLOB))),0) FROM jobs
        UNION ALL SELECT count(*),count(*)*1024 FROM capacity_allocations WHERE released=0
        UNION ALL SELECT count(*),count(*)*512 FROM ingress_reservations
        UNION ALL SELECT count(*),count(*)*128 FROM control)`, lease.cut_seq!, lease.cut_seq!).one();
      if (totals.n > EXPORT_MAX_ROWS || totals.bytes > EXPORT_MAX_BYTES) return responseError(413, 'backup_control_export_limit');
      const uploads = this.storage.sql.exec<Row>(`SELECT * FROM ingest_uploads u WHERE ${uploadPredicate} ORDER BY seq`, lease.cut_seq!, lease.cut_seq!).toArray();
      const postCut = new Set(this.storage.sql.exec<{ key: string }>('SELECT key FROM ingest_uploads WHERE seq>?', lease.cut_seq!).toArray().map(row => row.key));
      const jobs = this.storage.sql.exec<Row>('SELECT * FROM jobs ORDER BY id').toArray().filter(row => !postCut.has(JSON.parse(row.payload).key));
      const allocations = this.storage.sql.exec<Row>('SELECT * FROM capacity_allocations WHERE released=0 ORDER BY key').toArray().filter(row => !postCut.has(row.key));
      return this.exportBlock(lease, 'control.json', { version: 1, cut_seq: lease.cut_seq, policy: lease.policy, jobs,
        ingress_reservations: this.storage.sql.exec<Row>('SELECT * FROM ingress_reservations ORDER BY id').toArray().filter(row => !postCut.has(row.id)),
        uploads, capacity: this.storage.sql.exec<Row>('SELECT * FROM capacity_control').toArray(), allocations,
        control: this.storage.sql.exec<Row>('SELECT * FROM control ORDER BY id').toArray(), alarm_restore: 'rebuild_and_force_pause' });
    }
    if (path === '/backup/database-schema' && request.method === 'GET') {
      const rows = (await this.env.DB.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND sql IS NOT NULL ORDER BY type,name`).all<Row>()).results;
      const tables = rows.filter(row => row.type === 'table' && TABLE_NAME.test(row.name)).map(row => row.name);
      if (!tables.includes('app_settings') || !tables.includes('messages')) return responseError(503, 'backup_schema_invalid');
      if (!this.requireReady(lease.id)) return responseError(409, 'backup_lease_expired');
      lease.tables = tables; this.save(lease);
      return this.exportBlock(lease, 'database-schema.json', { schema: rows, tables });
    }
    if (path === '/backup/database' && request.method === 'GET') {
      const table = url.searchParams.get('table') ?? '', offset = Number(url.searchParams.get('offset') ?? 0);
      if (!lease.tables?.includes(table) || !TABLE_NAME.test(table) || !Number.isSafeInteger(offset) || offset < 0 || offset % PAGE_SIZE) return responseError(400, 'invalid_export_page');
      const name = `database/${table}/${offset}.json`, previous = `database/${table}/${offset - PAGE_SIZE}.json`;
      if (offset && !this.blockValue(lease, previous)) return responseError(409, 'export_pages_out_of_order');
      // Keyset pages read ~100 rows each. A page exported by an older Worker in
      // this lease has no cursor, so continue it with the equivalent OFFSET.
      const cursor = offset ? this.storage.sql.exec<{ last_rowid: number }>('SELECT last_rowid FROM backup_table_cursors WHERE backup_id=? AND name=?', lease.id, previous).toArray()[0] : null;
      const select = `SELECT rowid AS "${ROWID}",* FROM "${table}"`;
      const rows = (await (!offset ? this.env.DB.prepare(`${select} ORDER BY rowid LIMIT ?`).bind(PAGE_SIZE)
        : cursor ? this.env.DB.prepare(`${select} WHERE rowid>? ORDER BY rowid LIMIT ?`).bind(cursor.last_rowid, PAGE_SIZE)
          : this.env.DB.prepare(`${select} ORDER BY rowid LIMIT ? OFFSET ?`).bind(PAGE_SIZE, offset)).all<Row>()).results;
      const last = rows.at(-1)?.[ROWID];
      for (const row of rows) delete row[ROWID];
      if (rows.length === PAGE_SIZE) this.storage.sql.exec(`INSERT INTO backup_table_cursors VALUES(?,?,?)
        ON CONFLICT(backup_id,name) DO UPDATE SET last_rowid=excluded.last_rowid`, lease.id, name, last);
      return this.exportBlock(lease, `database/${table}/${offset}.json`, { table, offset, rows, next_offset: rows.length === PAGE_SIZE ? offset + PAGE_SIZE : null },
        { table, offset, rows: rows.length, complete: rows.length < PAGE_SIZE });
    }
    if (path === '/backup/objects' && request.method === 'GET') {
      const cursor = url.searchParams.get('cursor') || null;
      const cached = this.storage.sql.exec<{ value: string }>('SELECT value FROM backup_object_pages WHERE backup_id=? AND cursor=?',lease.id,cursor ?? '').toArray()[0];
      if (cached) return new Response(cached.value, { headers: { 'Content-Type': 'application/json' } });
      if (cursor !== lease.object_cursor || lease.objects_done) return responseError(409, 'object_pages_out_of_order');
      const page = await this.env.MAIL_STORE.list({ cursor: cursor ?? undefined, limit: PAGE_SIZE, include: ['customMetadata', 'httpMetadata'] });
      if (!this.requireReady(lease.id)) return responseError(409, 'backup_lease_expired');
      const objects = page.objects.filter(object => !object.key.startsWith('raw/') ||
        !object.customMetadata?.ingest_seq || Number(object.customMetadata.ingest_seq) <= lease.cut_seq!).map(object => ({
          key: object.key, size: object.size, etag: object.etag, uploaded: object.uploaded.toISOString(),
          customMetadata: object.customMetadata ?? {}, httpMetadata: object.httpMetadata ?? {},
        }));
      for (const object of objects) this.storage.sql.exec('INSERT OR REPLACE INTO backup_objects VALUES(?,?,?)', lease.id, object.key, canonicalJSON(object));
      lease.object_cursor = page.truncated ? page.cursor : null; lease.objects_done = !page.truncated; this.save(lease);
      const value = canonicalJSON({ objects, next_cursor: lease.object_cursor, complete: lease.objects_done });
      this.storage.sql.exec('INSERT INTO backup_object_pages VALUES(?,?,?)', lease.id, cursor ?? '', value);
      return new Response(value, { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/backup/object' && request.method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      const saved = this.storage.sql.exec<{ metadata: string }>('SELECT metadata FROM backup_objects WHERE backup_id=? AND key=?', lease.id, key).toArray()[0];
      if (!saved) return responseError(404, 'object_not_in_snapshot');
      const expected = JSON.parse(saved.metadata), object = await this.env.MAIL_STORE.get(key, { onlyIf: { etagMatches: expected.etag } });
      if (!object || !('body' in object) || object.size !== expected.size || !this.requireReady(lease.id)) return responseError(409, 'snapshot_object_changed');
      return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size), ETag: object.httpEtag } });
    }
    if ((path === '/backup/manifest' || path === '/backup/finish') && !this.manifestFits(lease)) return responseError(413, 'backup_manifest_export_limit');
    if (path === '/backup/manifest' && request.method === 'GET') {
      if (!lease.objects_done || !lease.tables || !this.blockValue(lease, 'control.json') || !this.blockValue(lease, 'database-schema.json')) return responseError(409, 'snapshot_export_incomplete');
      for (const table of lease.tables) {
        const blocks = this.storage.sql.exec<{ value: string }>('SELECT value FROM backup_blocks WHERE backup_id=? AND name LIKE ?', lease.id, `database/${table}/%`).toArray();
        if (!blocks.some(block => JSON.parse(block.value).complete)) return responseError(409, 'snapshot_export_incomplete');
      }
      const manifest = await this.manifest(lease);
      return Response.json({ manifest: manifest.value, manifest_sha256: manifest.hash });
    }
    if (path === '/backup/finish' && request.method === 'POST') {
      const manifest = await this.manifest(lease), receipt = input!.receipt as BackupReceipt;
      // Require the same completeness checks as manifest export before accepting
      // a remote verifier's receipt; possession of BACKUP_TOKEN alone is not proof.
      const ready = await this.fetch(new Request(`https://coordinator/backup/manifest?backup_id=${lease.id}`));
      if (!ready?.ok || !receipt || input!.manifest_sha256 !== manifest.hash || receipt.backup_id !== lease.id ||
        receipt.manifest_sha256 !== manifest.hash || typeof receipt.remote_locator !== 'string' || receipt.remote_locator.length < 1 || receipt.remote_locator.length > 1024 ||
        !Number.isFinite(Date.parse(receipt.verified_at)) || Date.parse(receipt.verified_at) < Date.parse(lease.created_at) ||
        Date.parse(receipt.verified_at) > Date.now() + 60_000 || !await verifyBackupReceipt(this.env, receipt, String(input!.receipt_mac ?? '')) || !this.requireReady(lease.id)) {
        return responseError(409, 'remote_verification_required');
      }
      // The authoritative commit is synchronous while the lease is valid.
      // D1 is only a retryable status index and cannot make an expired lease
      // appear successful if it responds after the expiry boundary.
      lease.state = 'remote_verified'; lease.manifest_sha256 = manifest.hash;
      lease.remote_locator = receipt.remote_locator; lease.verified_at = receipt.verified_at; lease.receipt_sync_pending = true; this.save(lease);
      await this.syncReceipt();
      return Response.json({ backup_id: lease.id, state: lease.state, manifest_sha256: manifest.hash, receipt_sync_pending: this.current()?.receipt_sync_pending ?? false });
    }
    return responseError(404, 'not_found');
  }
}
