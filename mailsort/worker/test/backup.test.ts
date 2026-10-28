/**
 * What the daily backup copies (src/backup.ts) over the store on Node's SQLite (./fakes/sql.ts): every table of the
 * current schema, read in rowid or key order, documented in docs/backup.md; and what counts as an empty store. The
 * job itself runs against R2 in the workerd suites (runtime/backup.test.ts, runtime/backup-steps.test.ts).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { encodeValue, planTables, SELF_FILLED, storeEmpty, storeTables } from '../src/backup.ts';
import { Store } from '../src/store.ts';
import { memorySql } from './fakes/sql.ts';

const DOCS = readFileSync(decodeURIComponent(new URL('../../docs/backup.md', import.meta.url).pathname), 'utf8');

function store(): Store {
  const value = new Store(memorySql());
  value.migrate();
  return value;
}

test('every table of the current schema is backed up with its statement, and docs/backup.md names each one', () => {
  const plan = planTables(store());
  const names = plan.map((table) => table.name);
  expect(names).toEqual(storeTables(store()).map((table) => table.name));
  expect(names).toHaveLength(22);
  for (const name of names) expect(DOCS, name).toContain(`\`${name}\``);
  for (const table of plan) expect(table.sql, table.name).toMatch(/^CREATE TABLE /);
  // A rowid table carries its rowid; a WITHOUT ROWID table is read in primary key order.
  const keys = Object.fromEntries(plan.map((table) => [table.name, table.key]));
  expect(keys).toMatchObject({ meta: ['rowid'], decisions: ['rowid'], flow: ['day', 'stage', 'outcome', 'label'], trusted_domains: ['label_id', 'domain'], replay: ['job_id', 'message_id'] });
  for (const table of plan) expect(table.columns[0] === 'rowid', table.name).toBe(table.key[0] === 'rowid');
  expect(plan.find((table) => table.name === 'ledger')?.indexes).toHaveLength(3);
});

test('a store is empty while only the tables a new object fills by itself hold rows', () => {
  const target = store();
  expect([...SELF_FILLED].sort()).toEqual(['meta', 'pending', 'requests', 'usage']);
  target.run(`INSERT INTO pending (message_id, added_at) VALUES ('abc0000000000001', 1)`);
  target.addUsage('2026-10-01', 'gmail_calls', 3);
  target.putRequest('r1', 'UpdateSettings', 'settings', '{}', 1);
  expect(storeEmpty(target)).toBe(true);
  target.run(`INSERT INTO labels (id, seq, display_name, gmail_state, create_time, update_time, etag) VALUES ('p1', 1, 'P1', 'pending', 1, 1, 'e')`);
  expect(storeEmpty(target)).toBe(false);
});

test('values keep their type: a blob as base64, an infinity by name, everything else as JSON', () => {
  expect(encodeValue(new Uint8Array([0, 255, 16]).buffer)).toEqual({ blob: 'AP8Q' });
  expect(encodeValue(-Infinity)).toEqual({ real: '-Infinity' });
  expect(encodeValue(0.30000000000000004)).toBe(0.30000000000000004);
  expect(encodeValue(null)).toBeNull();
  expect(encodeValue('合成')).toBe('合成');
});
