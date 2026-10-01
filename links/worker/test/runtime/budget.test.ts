/**
 * D1 writes per owner action (../../../docs/design.md §5): the account's 100,000 rows a day are shared by every app,
 * and each index entry counts as a row. Measured with D1's own meta.rows_written on the store functions the API runs,
 * through the same database. A redirect writes nothing (./redirect.test.ts), and a list with nothing to purge neither.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { linkWire, type LinkContent, type LinkRow } from '../../src/model.ts';
import * as store from '../../src/store.ts';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
});

/** The database with every batch's rows written and read summed. */
function metered(db: D1Database) {
  const meter = { written: 0, read: 0 };
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          for (const result of results) {
            meter.written += result.meta.rows_written;
            meter.read += result.meta.rows_read;
          }
          return results;
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy, meter };
}

const CONTENT: LinkContent = { target: 'https://example.com/', path_mode: 'exact', visibility: 'private', description: '', tags: '[]', expire_time: null };
const respond = (row: LinkRow) => JSON.stringify(linkWire(row));

describe('rows written per action', () => {
  it('create 2 (link, revision), with a request ID 3; update 3 plus a revision; delete 2 (the purge index); list 0', async () => {
    const { db, meter } = metered(h.db);
    const now = Date.now();
    const created = await store.createLink({ db, now, requestId: '' }, 'a', CONTENT, respond);
    expect(created.kind).toBe('ok');
    expect(meter.written).toBe(2);

    meter.written = 0;
    await store.createLink({ db, now, requestId: '11111111-1111-4111-8111-111111111111' }, 'b', CONTENT, respond);
    expect(meter.written).toBe(3);

    meter.written = 0;
    const updated = await store.updateLink({ db, now, requestId: '' }, 'a', '', (row) => ({ ...row, description: 'x' }), respond);
    expect(updated.kind).toBe('ok');
    // The link row and its new revision; nothing else.
    expect(meter.written).toBe(2);

    meter.written = 0;
    await store.deleteLink({ db, now, requestId: '' }, 'a', '', respond);
    // The link row and its entry in the partial purge index.
    expect(meter.written).toBe(2);

    meter.written = 0;
    meter.read = 0;
    await store.listLinks(db, { after: null, literals: [], showDeleted: true, size: 100 }, now);
    expect(meter.written).toBe(0);

    meter.written = 0;
    const same = await store.updateLink({ db, now, requestId: '' }, 'b', '', (row) => row, respond);
    expect(same.kind).toBe('ok');
    expect(meter.written).toBe(0);
  });

  it('an import of 100 new links writes 2 rows a link', async () => {
    const { db, meter } = metered(h.db);
    const items = Array.from({ length: 100 }, (_, n) => ({ line: n + 1, key: `k${String(n)}`, content: CONTENT }));
    const result = await store.importLinks({ db, now: Date.now(), requestId: '' }, items, false, () => '');
    expect(result).toMatchObject({ kind: 'ok', value: { created: 100 } });
    expect(meter.written).toBe(200);
  });
});
