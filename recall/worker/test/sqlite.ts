/**
 * RecallState's SQLite in Node (node:sqlite behind the SqlStorage surface Store uses), for the unit tests that build
 * answers from fixed synthetic rows: each statement's rows read are the rows it returned, its rows written the rows it
 * changed.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Store } from '../src/store.ts';

export function sqlStorage(databaseSize: number): SqlStorage {
  const db = new DatabaseSync(':memory:');
  return {
    databaseSize,
    exec(query: string, ...params: SQLInputValue[]) {
      const statement = db.prepare(query);
      if (statement.columns().length > 0) {
        const rows = statement.all(...params).map((row) => ({ ...row }));
        return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
      }
      const { changes } = statement.run(...params);
      return { toArray: () => [], rowsRead: 0, rowsWritten: Number(changes) };
    },
  } as unknown as SqlStorage;
}

/** A migrated Store over an empty in-memory database. */
export function memoryStore(databaseSize = 0): Store {
  const store = new Store(sqlStorage(databaseSize));
  store.migrate();
  return store;
}
