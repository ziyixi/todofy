// The compacted change feed and deletion in workerd (../../../docs/design.md §2.3, §5.4, §7): a revision moves its
// record to a new seq, the gaps, last_seq on full and short pages, a deleted page gone at once from a feed read from 0
// with its tombstone above every cursor, feed_id, 409 cursor_ahead, consumers' sync positions; DeletePage of a page with
// 5,000 visits in one bounded call, then the alarm's chunks and R2 deletions; the blob route's 410 and 500.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAINTENANCE_ROW_LIMIT } from '../../src/limits.ts';
import { batch, document, page, uuid, visit, type ChangePage } from './data.ts';
import { DAY, HOUR, machineReason, MINUTE, op, reasonOf, rejection, SECOND, startHarness, T0, type Harness } from './harness.ts';

async function feed(h: Harness, query = '?after=0&limit=500'): Promise<ChangePage> {
  const response = await h.changes(query);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<ChangePage>();
}

async function upload(h: Harness, items: unknown[], sentMs = T0): Promise<void> {
  const response = await h.upload(batch(items, { sentMs }));
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('the compacted feed', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('moves a revised record to a new seq and leaves gaps; last_seq follows full and short pages', async () => {
    const a = (revision: number) => visit({ id: uuid(1), url: 'https://example.com/a', title: 'A', revision, spans: [[T0 - 10 * MINUTE, T0 - (10 - revision) * MINUTE]] });
    await upload(h, [await a(1), await visit({ id: uuid(2), url: 'https://example.com/b', spans: [[T0 - 9 * MINUTE, T0 - 8 * MINUTE]] })]);
    await upload(h, [await visit({ id: uuid(3), url: 'https://example.com/c', spans: [[T0 - 7 * MINUTE, T0 - 6 * MINUTE]] }), await a(2)]);
    const all = await feed(h);
    expect(all.changes.map((change) => [change.seq, change.id])).toEqual([
      [2, `visits/${uuid(2)}`],
      [3, `visits/${uuid(3)}`],
      [4, `visits/${uuid(1)}`],
    ]);
    expect(all).toMatchObject({ last_seq: 4, head_seq: 4 });
    expect(all.changes[2]?.visit).toMatchObject({ focus_seconds: 120 });
    // A full page ends at its last change, a short one at the head.
    expect(await feed(h, '?after=0&limit=2')).toMatchObject({ last_seq: 3, head_seq: 4 });
    expect((await feed(h, '?after=3&limit=2')).changes.map((change) => change.seq)).toEqual([4]);
    expect(await feed(h, '?after=3&limit=2')).toMatchObject({ last_seq: 4 });
    // The same seq always renders the same change.
    expect((await feed(h, '?after=1&limit=1')).changes).toEqual(all.changes.slice(0, 1));
  });

  it('keeps one feed identity, refuses a cursor ahead of the head (409) and bad parameters (400)', async () => {
    const first = await feed(h);
    expect((await feed(h)).feed_id).toBe(first.feed_id);
    const ahead = await h.changes('?after=99');
    expect(ahead.status).toBe(409);
    expect(await machineReason(ahead)).toBe('CURSOR_AHEAD');
    for (const query of ['?after=-1', '?limit=501', '?consumer=NAS', '?x=1']) {
      const response = await h.changes(query);
      expect(response.status, query).toBe(400);
    }
  });

  it("records each consumer's sync position, at most eight, the one unseen longest going first", async () => {
    for (let i = 0; i < 9; i++) {
      await h.clock(T0 + i * SECOND);
      await feed(h, `?after=${String(i % 4)}&consumer=archive-${String(i)}`);
    }
    const consumers = await h.sql<{ name: string; synced_seq: number }>(`SELECT name, synced_seq FROM consumers ORDER BY name`);
    expect(consumers).toHaveLength(8);
    expect(consumers.map((row) => row.name)).not.toContain('archive-0');
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.archiveConsumers[0]).toMatchObject({ consumer: 'archive-8', syncedSeq: 0, behindCount: 3, stale: false });
    expect(status.archiveConsumers.find((c) => c.consumer === 'archive-7')).toMatchObject({ syncedSeq: 3, behindCount: 1 });
    expect(status.headSeq).toBe(4);
  });
});

describe('deleting a page', () => {
  let h: Harness;
  const doomed = 'https://doomed.example.net/diary';
  const kept = 'https://kept.example.net/notes';
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('takes its records out of the feed at once and adds one tombstone above every cursor', async () => {
    await upload(h, [
      await visit({ id: uuid(1), url: doomed, title: '日记', spans: [[T0 - 30 * MINUTE, T0 - 20 * MINUTE]] }),
      await document({ id: uuid(2), visitId: uuid(1), url: doomed, captureMs: T0 - 25 * MINUTE, text: '不想留下的正文' }),
      await visit({ id: uuid(3), url: kept, title: '笔记', spans: [[T0 - 19 * MINUTE, T0 - 18 * MINUTE]] }),
    ]);
    const before = await feed(h);
    expect(before.changes).toHaveLength(3);
    const { pageId } = await page(doomed);
    await h.clock(T0 + MINUTE);
    await h.api.deletePage({ name: `pages/${pageId}`, requestId: op() });

    const after = await feed(h);
    expect(after.changes.map((change) => change.kind)).toEqual(['visit', 'tombstone']);
    expect(after.changes[1]).toMatchObject({ seq: 4, kind: 'tombstone', tombstone: { target: `pages/${pageId}` } });
    expect(after.changes[1]?.page_id).toBeUndefined();
    // A consumer that had read up to the old head still finds the tombstone above its cursor.
    expect((await feed(h, `?after=${String(before.head_seq)}`)).changes.map((change) => change.kind)).toEqual(['tombstone']);
    // Gone from the API and the search at once.
    expect(reasonOf(await rejection(h.api.getPage({ name: `pages/${pageId}` })))).toBe('NOT_FOUND');
    expect((await h.api.searchPages({ query: '日记' })).results).toEqual([]);
    expect((await h.api.listVisits({ parent: 'pages/-' })).visits.map((v) => v.title)).toEqual(['笔记']);
    expect(reasonOf(await rejection(h.api.deletePage({ name: `pages/${pageId}`, requestId: op() })))).toBe('NOT_FOUND');
  });

  it("takes the deleted page's text out of R2 at once (410), and the alarm removes its rows", async () => {
    const path = `2026/10/${uuid(2)}.txt.gz`;
    const gone = await h.blob(path);
    expect(gone.status).toBe(410);
    expect(await machineReason(gone)).toBe('BLOB_DELETED');
    expect(await (await h.r2()).head(`blobs/${path}`)).toBeNull();
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ purging: false, deferred: false, code: 'ok' });
    expect(await h.sql(`SELECT id FROM visits WHERE page_rowid NOT IN (SELECT rowid FROM pages)`)).toEqual([]);
    expect(await h.sql(`SELECT * FROM purges`)).toEqual([]);
  });

  it('drops a late visit or capture that began before the deletion; a new visit records the page again', async () => {
    const { pageId } = await page(doomed);
    await upload(h, [
      await visit({ id: uuid(1), url: doomed, revision: 2, spans: [[T0 - 30 * MINUTE, T0 - 10 * MINUTE]] }),
      await document({ id: uuid(4), visitId: uuid(1), url: doomed, captureMs: T0 - 15 * MINUTE, text: '迟到的正文' }),
    ], T0 + 3 * MINUTE);
    expect(reasonOf(await rejection(h.api.getPage({ name: `pages/${pageId}` })))).toBe('NOT_FOUND');
    await h.clock(T0 + DAY);
    await upload(h, [await visit({ id: uuid(5), url: doomed, title: '又来了', spans: [[T0 + DAY - 2 * MINUTE, T0 + DAY - MINUTE]] })], T0 + DAY);
    expect(await h.api.getPage({ name: `pages/${pageId}` })).toMatchObject({ title: '又来了', visitCount: 1 });
  });

  it("answers 500 for a live record whose object is gone (a wrong binding or a lost object), and says so", async () => {
    await upload(h, [await document({ id: uuid(6), visitId: uuid(3), url: kept, captureMs: T0 + DAY - MINUTE, text: '会丢的正文' })], T0 + DAY);
    const path = `2026/10/${uuid(6)}.txt.gz`;
    await (await h.r2()).delete(`blobs/${path}`);
    const lost = await h.blob(path);
    expect(lost.status).toBe(500);
    expect(await machineReason(lost)).toBe('BLOB_MISSING');
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).recentErrorCodes).toContain('blob_missing');
    expect((await h.blob('2026/10/not-a-path.txt.gz')).status).toBe(404);
    expect((await h.blob('../2026/10/x')).status).toBe(404);
  });
});

describe('the deletion ledger and a device whose clock is off', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it("compares a late item's time with the deletion on recall's clock, moved by the batch's skew", async () => {
    const fast = 10 * MINUTE;
    const url = 'https://skew.example.org/page';
    const { pageId } = await page(url);
    // The device runs ten minutes fast: a visit that began at 09:55 (recall's clock) is stamped 10:05.
    await upload(h, [await visit({ id: uuid(1), url, spans: [[T0 - 5 * MINUTE + fast, T0 - 4 * MINUTE + fast]] })], T0 + fast);
    await h.clock(T0);
    await h.api.deletePage({ name: `pages/${pageId}`, requestId: op() });
    // Its later revision, stamped after the deletion by the device's clock, began before it: dropped.
    await h.clock(T0 + MINUTE);
    await upload(h, [await visit({ id: uuid(1), url, revision: 2, spans: [[T0 - 5 * MINUTE + fast, T0 + fast]] })], T0 + MINUTE + fast);
    expect(reasonOf(await rejection(h.api.getPage({ name: `pages/${pageId}` })))).toBe('NOT_FOUND');
    // A device ten minutes slow: a visit that began after the deletion is kept, though stamped before it.
    const slow = -10 * MINUTE;
    await h.clock(T0 + 2 * MINUTE);
    await upload(h, [await visit({ id: uuid(2), url, spans: [[T0 + MINUTE + slow, T0 + 2 * MINUTE + slow]] })], T0 + 2 * MINUTE + slow);
    expect(await h.api.getPage({ name: `pages/${pageId}` })).toMatchObject({ visitCount: 1 });
  });
});

describe('deleting a page with 5,000 visits', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('is one bounded call; the alarm then removes 500 rows a run with the R2 objects', async () => {
    const url = 'https://busy.example.org/dashboard';
    await upload(h, [
      await visit({ id: uuid(1), url, title: '仪表盘', spans: [[T0 - 10 * MINUTE, T0 - 9 * MINUTE]] }),
      await document({ id: uuid(2), visitId: uuid(1), url, captureMs: T0 - 9 * MINUTE, text: '仪表盘正文' }),
    ]);
    const [{ rowid } = { rowid: 0 }] = await h.sql<{ rowid: number }>(`SELECT rowid FROM pages`);
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
       INSERT INTO visits (id, seq, seq_ms, page_rowid, device_id, device_label, url, title, start_ms, end_ms, focus_seconds, spans, revision)
       SELECT printf('00000000-0000-4000-8000-%012x', i), 100 + i, ?, ?, '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', 'x', ?, 't', ? - i * 60000, ? - i * 60000 + 5000, 5, '[]', 1 FROM n`,
      T0,
      rowid,
      url,
      T0 - DAY,
      T0 - DAY,
    );
    await h.sql(`UPDATE pages SET visit_count = 5000`);
    await h.sql(`UPDATE meta SET value = '5000' WHERE key = 'visit_count'`);
    await h.rows();
    const { pageId } = await page(url);
    await h.api.deletePage({ name: `pages/${pageId}`, requestId: op() });
    const meter = await h.rows();
    // The page, its index row, its site, the tombstone, the purge, the request log and the counters: a few dozen rows.
    expect(meter.written).toBeLessThan(60);
    expect(meter.read).toBeLessThan(200);

    let runs = 0;
    for (let result = await h.step(T0 + MINUTE); result.purging; result = await h.step(T0 + (runs + 2) * MINUTE)) runs += 1;
    expect(runs).toBeGreaterThanOrEqual(9);
    expect(await h.sql(`SELECT count(*) AS n FROM visits`)).toEqual([{ n: 0 }]);
    expect(await h.sql(`SELECT count(*) AS n FROM documents`)).toEqual([{ n: 0 }]);
    expect(await (await h.r2()).head(`blobs/2026/10/${uuid(2)}.txt.gz`)).toBeNull();
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status).toMatchObject({ pageCount: 0, visitCount: 0, documentCount: 0, blobStoredMib: 0 });
  });

  it("stops purging for the day once today's rows written reach the maintenance limit, and goes on the next day", async () => {
    const url = 'https://busy.example.org/feed';
    await h.clock(T0 + HOUR);
    await upload(h, [await visit({ id: uuid(11), url, spans: [[T0 + HOUR - 2 * MINUTE, T0 + HOUR - MINUTE]] })], T0 + HOUR);
    const [{ rowid } = { rowid: 0 }] = await h.sql<{ rowid: number }>(`SELECT rowid FROM pages`);
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
       INSERT INTO visits (id, seq, seq_ms, page_rowid, device_id, device_label, url, title, start_ms, end_ms, focus_seconds, spans, revision)
       SELECT printf('00000000-0000-4000-9000-%012x', i), 10000 + i, ?, ?, '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', 'x', ?, 't', ? - i * 60000, ? - i * 60000 + 5000, 5, '[]', 1 FROM n`,
      T0,
      rowid,
      url,
      T0,
      T0,
    );
    const { pageId } = await page(url);
    await h.api.deletePage({ name: `pages/${pageId}`, requestId: op() });
    const day = new Date(T0 + HOUR).toISOString().slice(0, 10);
    await h.sql(`UPDATE usage SET rows_written = ? WHERE day = ?`, MAINTENANCE_ROW_LIMIT, day);
    const held = await h.step(T0 + HOUR + MINUTE);
    expect(held).toMatchObject({ purging: false, deferred: true, code: 'ok' });
    expect(held.next).toBeGreaterThan(T0 + HOUR + 2 * MINUTE);
    expect((await h.sql<{ n: number }>(`SELECT count(*) AS n FROM visits`))[0]?.n).toBe(1201);
    let result = await h.step(T0 + DAY + MINUTE);
    expect(result).toMatchObject({ purging: true, deferred: false });
    for (let runs = 2; result.purging; runs += 1) result = await h.step(T0 + DAY + runs * MINUTE);
    expect(await h.sql(`SELECT count(*) AS n FROM visits`)).toEqual([{ n: 0 }]);
  });
});
