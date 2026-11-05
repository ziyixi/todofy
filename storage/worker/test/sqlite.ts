import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Dropbox } from '../src/dropbox.ts';
import type { Env } from '../src/env.ts';
import { Store, type ClientRow, type Connection } from '../src/store.ts';

export const TEST_ENV: Omit<Env, 'STORAGE'> = {
  PUBLIC_HOST: 'storage.example.test',
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'a'.repeat(64),
  ACCESS_OWNER: 'owner@example.test',
};

/** Run the production SQL against SQLite; only the Workers cursor API is adapted. */
export function sqliteStore(database = new DatabaseSync(':memory:')): { readonly store: Store; readonly database: DatabaseSync } {
  const sql = {
    exec(query: string, ...bindings: SQLInputValue[]) {
      const statement = database.prepare(query);
      const rows = statement.columns().length === 0 ? (statement.run(...bindings), []) : statement.all(...bindings);
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('expected one synthetic SQLite row'); return rows[0]; } };
    },
  } as unknown as SqlStorage;
  return { database, store: new Store(sql) };
}

export function setupConnected(store?: Store, overrides: Partial<Connection> = {}): { readonly connection: Connection; readonly provider: Dropbox } {
  const connection: Connection = {
    appKey: 'syntheticappkey',
    refreshToken: 'synthetic-private-refresh',
    generation: 'synthetic',
    ...overrides,
  };
  if (store !== undefined) store.set('connection', connection);
  const provider = new Dropbox({
    get: (key) => store?.get(key) ?? null,
    set: (key, value) => { store?.set(key, value); },
    delete: (key) => { store?.delete(key); },
    connection: () => store === undefined ? connection : store.connection(),
  }, {});
  return { connection, provider };
}

export function seedNamespaceAndKey(overrides: Partial<ClientRow> = {}, store?: Store): ClientRow {
  const id = overrides.id ?? 'synthetic';
  const row: ClientRow = {
    id,
    label: 'Synthetic',
    namespace: 'synthetic',
    access: 2,
    token_sha256: id === 'synthetic' ? 'a'.repeat(64) : id.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
    create_time: 0,
    revoked: 0,
    last_use_time: 0,
    ...overrides,
  };
  if (store !== undefined) store.addClient(row);
  return row;
}

