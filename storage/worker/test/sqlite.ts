import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Store } from '../src/store.ts';

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
