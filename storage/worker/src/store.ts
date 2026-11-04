import { MAX_CLIENTS } from './env.ts';
import { Code } from '@ziyixi/proto/rpc-status';
import { failure } from './errors.ts';

export interface ClientRow extends Record<string, SqlStorageValue> {
  id: string;
  label: string;
  namespace: string;
  access: number;
  token_sha256: string;
  create_time: number;
  revoked: number;
  /** Milliseconds; 0 before the first counted request. */
  last_use_time: number;
}

export interface Connection {
  readonly appKey: string;
  readonly refreshToken: string;
  readonly generation: string;
  /** Milliseconds; absent on a connection installed before it was recorded. */
  readonly connectTime?: number;
}

/** One UTC day's counts of one credential, operation and outcome, the last two by wire enum name. */
export interface UsageCell {
  day: string;
  client_id: string;
  operation: string;
  outcome: string;
  requests: number;
  objects: number;
  upload_bytes: number;
  download_bytes: number;
  max_batch: number;
}

export interface UsageRow extends UsageCell, Record<string, SqlStorageValue> { namespace: string }

/** One failed request; the time is in milliseconds. */
export interface Failure {
  time: number;
  client_id: string;
  operation: string;
  reason: string;
  http_status: number;
  retry_after: number;
}

export interface FailureRow extends Failure, Record<string, SqlStorageValue> { namespace: string }

/** Counts accumulated in memory since the last flush. */
export interface PendingUsage {
  readonly cells: readonly UsageCell[];
  readonly lastUse: ReadonlyMap<string, number>;
  readonly failures: readonly Failure[];
  /** Milliseconds of the newest request Dropbox answered; 0 when none. */
  readonly success: number;
  /** Milliseconds of the newest successful PUT or batch; 0 when none. A full Dropbox still answers reads. */
  readonly writeSuccess: number;
  /** Deletes daily counts before this UTC day; empty to keep them. */
  readonly pruneBefore: string;
}

export const FAILURE_SLOTS = 50;

export interface PendingConnection {
  readonly state: string;
  readonly verifier: string;
  readonly appKey: string;
  readonly redirectUri: string;
  readonly expires: number;
  readonly exchanging?: boolean;
}

/**
 * Connection state, namespace-key hashes, the cursor-signing key, the last provider error reason and request
 * counters; no file data.
 */
export class Store {
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, namespace TEXT NOT NULL, access INTEGER NOT NULL,
      token_sha256 TEXT NOT NULL UNIQUE, create_time INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    )`);
    // The retired list page cache; dropping the table also drops its index.
    sql.exec('DROP TABLE IF EXISTS list_pages');
    if (!sql.exec<{ name: string }>('PRAGMA table_info(clients)').toArray().some((column) => column.name === 'last_use_time')) {
      sql.exec('ALTER TABLE clients ADD COLUMN last_use_time INTEGER NOT NULL DEFAULT 0');
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT NOT NULL, client_id TEXT NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL,
      requests INTEGER NOT NULL, objects INTEGER NOT NULL, upload_bytes INTEGER NOT NULL, download_bytes INTEGER NOT NULL,
      max_batch INTEGER NOT NULL, PRIMARY KEY (day, client_id, operation, outcome)
    ) WITHOUT ROWID`);
    sql.exec(`CREATE TABLE IF NOT EXISTS recent_failures (
      slot INTEGER PRIMARY KEY, time INTEGER NOT NULL, client_id TEXT NOT NULL, operation TEXT NOT NULL,
      reason TEXT NOT NULL, http_status INTEGER NOT NULL, retry_after INTEGER NOT NULL
    )`);
  }

  get(key: string): unknown {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM metadata WHERE key = ?', key).toArray()[0];
    return row === undefined ? null : JSON.parse(row.value) as unknown;
  }

  set(key: string, value: unknown): void {
    this.sql.exec('INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  delete(key: string): void { this.sql.exec('DELETE FROM metadata WHERE key = ?', key); }

  connection(): Connection | null { return this.get('connection') as Connection | null; }

  client(id: string): ClientRow | null {
    return this.sql.exec<ClientRow>('SELECT * FROM clients WHERE id = ?', id).toArray()[0] ?? null;
  }

  authenticate(hash: string): ClientRow | null {
    return this.sql.exec<ClientRow>('SELECT * FROM clients WHERE token_sha256 = ? AND revoked = 0', hash).toArray()[0] ?? null;
  }

  clients(after: string, limit: number): ClientRow[] {
    return this.sql.exec<ClientRow>('SELECT * FROM clients WHERE revoked = 0 AND id > ? ORDER BY id LIMIT ?', after, limit).toArray();
  }

  addClient(row: ClientRow): void {
    const count = this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM clients WHERE revoked = 0').one().count;
    if (count >= MAX_CLIENTS) throw failure(Code.RESOURCE_EXHAUSTED, 'CLIENT_LIMIT');
    this.sql.exec('INSERT INTO clients(id,label,namespace,access,token_sha256,create_time) VALUES (?,?,?,?,?,?)',
      row.id, row.label, row.namespace, row.access, row.token_sha256, row.create_time);
  }

  revokeClient(id: string): void { this.sql.exec('UPDATE clients SET revoked = 1 WHERE id = ?', id); }

  /** Adds pending counts: one upsert per counted cell, never one per request. The caller runs it in one transaction. */
  addUsage(pending: PendingUsage): void {
    for (const row of pending.cells) {
      this.sql.exec(`INSERT INTO usage_daily(day,client_id,operation,outcome,requests,objects,upload_bytes,download_bytes,max_batch) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(day,client_id,operation,outcome) DO UPDATE SET requests = requests + excluded.requests, objects = objects + excluded.objects,
        upload_bytes = upload_bytes + excluded.upload_bytes, download_bytes = download_bytes + excluded.download_bytes,
        max_batch = max(max_batch, excluded.max_batch)`,
      row.day, row.client_id, row.operation, row.outcome, row.requests, row.objects, row.upload_bytes, row.download_bytes, row.max_batch);
    }
    for (const [id, time] of pending.lastUse) this.sql.exec('UPDATE clients SET last_use_time = ? WHERE id = ? AND last_use_time < ?', time, id, time);
    if (pending.failures.length > 0) {
      // A ring of the newest failures: the sequence picks the slot to overwrite.
      const sequence = this.get('failure_sequence');
      let next = typeof sequence === 'number' ? sequence : 0;
      for (const failure of pending.failures) {
        this.sql.exec(`INSERT INTO recent_failures(slot,time,client_id,operation,reason,http_status,retry_after) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(slot) DO UPDATE SET time = excluded.time, client_id = excluded.client_id, operation = excluded.operation,
          reason = excluded.reason, http_status = excluded.http_status, retry_after = excluded.retry_after`,
        next % FAILURE_SLOTS, failure.time, failure.client_id, failure.operation, failure.reason, failure.http_status, failure.retry_after);
        next++;
      }
      this.set('failure_sequence', next % FAILURE_SLOTS);
    }
    // A success counted before the current connection was installed belongs to an earlier one.
    const connection = this.connection();
    const since = connection?.connectTime ?? 0;
    for (const [key, time] of [['last_success', pending.success], ['last_write_success', pending.writeSuccess]] as const) {
      const stored = this.get(key);
      if (connection !== null && time >= since && time > (typeof stored === 'number' ? stored : 0)) this.set(key, time);
    }
    if (pending.pruneBefore !== '') this.sql.exec('DELETE FROM usage_daily WHERE day < ?', pending.pruneBefore);
  }

  /** Daily counts from a UTC day on, the newest day first, with each credential's namespace. */
  usage(fromDay: string, limit: number): UsageRow[] {
    return this.sql.exec<UsageRow>(`SELECT u.day, u.client_id, c.namespace, u.operation, u.outcome, u.requests, u.objects,
      u.upload_bytes, u.download_bytes, u.max_batch FROM usage_daily u JOIN clients c ON c.id = u.client_id
      WHERE u.day >= ? ORDER BY u.day DESC, u.client_id, u.operation, u.outcome LIMIT ?`, fromDay, limit).toArray();
  }

  /** The newest failures first, at most FAILURE_SLOTS. */
  failures(): FailureRow[] {
    return this.sql.exec<FailureRow>(`SELECT f.time, f.client_id, c.namespace, f.operation, f.reason, f.http_status, f.retry_after
      FROM recent_failures f JOIN clients c ON c.id = f.client_id ORDER BY f.time DESC, f.slot DESC`).toArray();
  }
}
