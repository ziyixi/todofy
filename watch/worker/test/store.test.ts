/** Additive evidence migration against real SQLite, including rollback's older version marker. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, it } from 'vitest';
import { changeMessage } from '../src/model.ts';
import { Store } from '../src/store.ts';

function storage(): SqlStorage {
  const db = new DatabaseSync(':memory:');
  return { exec(query: string, ...params: SQLInputValue[]) {
    const statement = db.prepare(query);
    if (statement.columns().length > 0) {
      const rows = statement.all(...params).map(row => ({ ...row }));
      return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
    }
    const { changes } = statement.run(...params);
    return { toArray: () => [], rowsRead: 0, rowsWritten: Number(changes) };
  } } as unknown as SqlStorage;
}

it('adds evidence columns without losing legacy changes and tolerates rollback then re-upgrade', () => {
  const target = new Store(storage());
  target.migrate();
  for (const name of ['before_context', 'after_context', 'context_available', 'context_truncated']) target.run(`ALTER TABLE changes DROP COLUMN ${name}`);
  target.run(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
  target.run(`INSERT INTO changes (id, watch_id, state, trigger_kind, summary, added, removed, diff, detect_time)
    VALUES ('legacy', 'synthetic', 'confirmed', 'any_change', 'Synthetic change', 1, 0, '[]', 1000)`);
  target.migrate();
  const legacy = target.change('synthetic', 'legacy');
  if (legacy === undefined) throw new Error('legacy change was lost');
  expect(changeMessage(legacy, 'Synthetic').contextAvailable).toBe(false);
  target.run(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
  expect(() => { target.migrate(); }).not.toThrow();
  expect(target.getMeta('schema_version')).toBe('5');
});
