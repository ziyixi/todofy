import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Store } from '../src/store.ts';

/** Run the production SQL against SQLite; only the Workers cursor/transaction API is adapted. */
export function sqliteStore(): { readonly store: Store; readonly database: DatabaseSync } {
  const database = new DatabaseSync(':memory:');
  const sql = {
    exec(query: string, ...bindings: SQLInputValue[]) {
      const statement = database.prepare(query);
      const rows = statement.columns().length === 0 ? (statement.run(...bindings), []) : statement.all(...bindings);
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('expected one synthetic SQLite row'); return rows[0]; } };
    },
  } as unknown as SqlStorage;
  const storage = {
    sql,
    transactionSync<T>(callback: () => T): T {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
  const store = new Store(storage);
  store.set('connection', { appKey: 'synthetic', refreshToken: 'synthetic', generation: 'synthetic' });
  return { database, store };
}
