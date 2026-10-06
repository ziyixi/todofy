/**
 * MailsortState's SQL API (SqlStorage) over Node's own SQLite, in memory, for unit tests of code that reads and writes
 * the store without a Durable Object (the import plan, the flow counters, the schema's migration). The workerd suites
 * run the real thing; this only has to give the same rows for the statements store.ts sends.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export function memorySql(): SqlStorage {
  const db = new DatabaseSync(':memory:');
  const exec = (query: string, ...params: unknown[]) => {
    const bound: SQLInputValue[] = params.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : (value as SQLInputValue)));
    const statement = db.prepare(query);
    const reads = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(query);
    let rows: Record<string, unknown>[] = [];
    let written = 0;
    if (reads) rows = statement.all(...bound);
    else written = Number(statement.run(...bound).changes);
    return { toArray: () => rows, rowsRead: rows.length, rowsWritten: written, columnNames: [], one: () => rows[0], raw: () => rows.values(), next: () => ({ done: true, value: undefined }), [Symbol.iterator]: () => rows.values() };
  };
  return { exec, databaseSize: 0, Cursor: Object } as unknown as SqlStorage;
}
