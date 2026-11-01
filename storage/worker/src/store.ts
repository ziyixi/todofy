import { MAX_CLIENTS } from './env.ts';
import { Code } from '@ziyixi/proto/rpc-status';
import type { ObjectMetadata } from '@ziyixi/proto/storage/objects/v1/objects_pb';
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

export const MAX_LIST_PAGES = 1024;
export const MAX_LIST_PAGE_BYTES = 512 * 1024;
export const MAX_LIST_CACHE_BYTES = 64 * 1024 * 1024;

export interface ListPageData {
  readonly generation: string;
  readonly namespace: string;
  readonly prefix: string;
  readonly expires: number;
  readonly provider: string;
  readonly objects: readonly ObjectMetadata[];
}

export interface ListPage extends ListPageData {
  readonly id: string;
  readonly nextPage: string | null;
}

interface ListPageRow extends Record<string, SqlStorageValue> {
  id: string;
  value: string;
  next_page: string | null;
}

/** Connection state, namespace-key hashes and bounded short-lived pagination metadata. */
export class Store {
  private readonly sql: SqlStorage;
  private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

  constructor(storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>) {
    this.storage = storage;
    this.sql = storage.sql;
    const sql = this.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, namespace TEXT NOT NULL, access INTEGER NOT NULL,
      token_sha256 TEXT NOT NULL UNIQUE, create_time INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS list_pages (
      id TEXT PRIMARY KEY, expires INTEGER NOT NULL, value TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, next_page TEXT
    )`);
    sql.exec('CREATE INDEX IF NOT EXISTS list_pages_expiry ON list_pages(expires)');
  }

  get(key: string): unknown {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM metadata WHERE key = ?', key).toArray()[0];
    return row === undefined ? null : JSON.parse(row.value) as unknown;
  }

  set(key: string, value: unknown): void {
    const resetPages = key === 'connection' && this.connection()?.generation !== (value as Connection).generation;
    this.sql.exec('INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    if (resetPages) this.sql.exec('DELETE FROM list_pages');
  }

  delete(key: string): void {
    this.sql.exec('DELETE FROM metadata WHERE key = ?', key);
    if (key === 'connection') this.sql.exec('DELETE FROM list_pages');
  }

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

  listPage(id: string, now: number): ListPage | null {
    this.sql.exec('DELETE FROM list_pages WHERE expires <= ?', now);
    const row = this.sql.exec<ListPageRow>('SELECT id,value,next_page FROM list_pages WHERE id = ?', id).toArray()[0];
    return row === undefined ? null : { ...JSON.parse(row.value) as ListPageData, id: row.id, nextPage: row.next_page };
  }

  saveListPage(page: ListPageData, now: number, parent?: string): ListPage {
    return this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM list_pages WHERE expires <= ?', now);
      if (page.expires <= now || page.generation !== this.connection()?.generation) throw failure(Code.INVALID_ARGUMENT, 'CURSOR_INVALID');
      if (parent !== undefined) {
        const previous = this.listPage(parent, now);
        if (previous === null) throw failure(Code.INVALID_ARGUMENT, 'CURSOR_INVALID');
        if (previous.nextPage !== null) {
          const existing = this.listPage(previous.nextPage, now);
          if (existing === null) throw failure(Code.INVALID_ARGUMENT, 'CURSOR_INVALID');
          return existing;
        }
      }
      const value = JSON.stringify(page);
      const bytes = new TextEncoder().encode(value).byteLength;
      if (bytes > MAX_LIST_PAGE_BYTES) throw failure(Code.RESOURCE_EXHAUSTED, 'RESOURCE_EXHAUSTED');
      const usage = this.sql.exec<{ count: number; bytes: number }>('SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes FROM list_pages').one();
      if (usage.count >= MAX_LIST_PAGES || usage.bytes + bytes > MAX_LIST_CACHE_BYTES) throw failure(Code.RESOURCE_EXHAUSTED, 'RESOURCE_EXHAUSTED');
      const id = crypto.randomUUID();
      this.sql.exec('INSERT INTO list_pages(id,expires,value,size_bytes) VALUES (?,?,?,?)', id, page.expires, value, bytes);
      if (parent !== undefined) this.sql.exec('UPDATE list_pages SET next_page = ? WHERE id = ?', id, parent);
      return { ...page, id, nextPage: null };
    });
  }
}
