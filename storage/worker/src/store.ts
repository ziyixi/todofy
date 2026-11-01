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
}

export interface Connection {
  readonly appKey: string;
  readonly refreshToken: string;
  readonly generation: string;
}

export interface PendingConnection {
  readonly state: string;
  readonly verifier: string;
  readonly appKey: string;
  readonly redirectUri: string;
  readonly expires: number;
  readonly exchanging?: boolean;
}

/** Only connection credentials, namespace-key hashes and a cursor-signing key live here. */
export class Store {
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, namespace TEXT NOT NULL, access INTEGER NOT NULL,
      token_sha256 TEXT NOT NULL UNIQUE, create_time INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
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
}
