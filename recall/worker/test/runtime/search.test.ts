// Search and the timeline in workerd (../../../docs/design.md §6, §8.4): words, Chinese phrases, a lone CJK character,
// every filter, both sorts, both read bounds reported, snippets, paging; the timeline's overlap scan and paging; the
// sites; the index budget moving old texts out of the index; and an old week on a synthetic two-year store.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { PageType, SortOrder } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { batch, document, page, uuid, visit } from './data.ts';
import { DAY, HOUR, MINUTE, reasonOf, rejection, startHarness, type Harness } from './harness.ts';

const ts = timestampFromMs;
/** The day of T0 (2026-10-10) in UTC, and the two before it. */
const DAY0 = Date.parse('2026-10-10T00:00:00Z');

interface Seed {
  readonly n: number;
  readonly url: string;
  readonly title: string;
  readonly text?: string;
  readonly start: number;
  readonly minutes: number;
}

const SEEDS: readonly Seed[] = [
  { n: 1, url: 'https://docs.example.com/durable-objects', title: 'Durable Objects 入门', text: '一个 Durable Object 是有名字的单例，带自己的 SQLite 数据库。The alarm wakes it.', start: DAY0 + 9 * HOUR, minutes: 20 },
  { n: 2, url: 'https://gist.example.com/snippets/alarm', title: 'Alarm snippet', text: 'setAlarm schedules the next wake-up; 冷启动 优化 matters here.', start: DAY0 + 10 * HOUR, minutes: 3 },
  { n: 3, url: 'https://www.example.com/blog/fts5', title: '用 FTS5 做中文搜索', text: '中文分词：数据和据库 里没有那个词。全文检索 and ranking with bm25.', start: DAY0 - DAY + 14 * HOUR, minutes: 10 },
  { n: 4, url: 'https://news.example.org/cold-start', title: 'Cold start, explained', start: DAY0 + 11 * HOUR, minutes: 1 },
  { n: 5, url: 'https://other.example.net/late-night', title: '深夜的数据库笔记', text: '数据库的冷启动和 durable storage。', start: DAY0 - 30 * MINUTE, minutes: 60 },
];

/** The clock of the tests in this file: the end of DAY0, after every seeded visit. */
const NOW = DAY0 + DAY + HOUR;

async function seed(h: Harness): Promise<void> {
  await h.clock(NOW);
  for (const s of SEEDS) {
    const items = [await visit({ id: uuid(s.n), url: s.url, title: s.title, spans: [[s.start, s.start + s.minutes * MINUTE]] })];
    if (s.text !== undefined) items.push(await document({ id: uuid(s.n, 2), visitId: uuid(s.n), url: s.url, title: s.title, captureMs: s.start + 30 * 1000, text: s.text }));
    const response = await h.upload(batch(items, { sentMs: NOW }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted_count: items.length, rejected: [] });
  }
}

const titles = (response: { results: readonly { title: string }[] }) => response.results.map((r) => r.title);

describe('search', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    await seed(h);
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('finds English words, a Chinese phrase as adjacent pairs, titles and hosts', async () => {
    expect(titles(await h.api.searchPages({ query: 'alarm' })).sort()).toEqual(['Alarm snippet', 'Durable Objects 入门']);
    expect(titles(await h.api.searchPages({ query: '数据库' })).sort()).toEqual(['Durable Objects 入门', '深夜的数据库笔记']);
    expect(titles(await h.api.searchPages({ query: '"冷启动 优化"' }))).toEqual(['Alarm snippet']);
    expect(titles(await h.api.searchPages({ query: 'cold start' }))).toEqual(['Cold start, explained']);
    expect(titles(await h.api.searchPages({ query: 'gist' }))).toEqual(['Alarm snippet']);
    expect(titles(await h.api.searchPages({ query: 'ＡＬＡＲＭ snippet' }))).toEqual(['Alarm snippet']);
  });

  it('refuses a lone CJK character as QUERY_NOT_SEARCHABLE, and a query past its bounds as BAD_REQUEST', async () => {
    expect(reasonOf(await rejection(h.api.searchPages({ query: '数' })))).toBe('QUERY_NOT_SEARCHABLE');
    expect(reasonOf(await rejection(h.api.searchPages({ query: 'a b c d e f g h i j k' })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.searchPages({ sortOrder: SortOrder.RELEVANCE })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.searchPages({ site: 'https://example.com' })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.searchPages({ startTime: ts(NOW), endTime: ts(NOW) })))).toBe('BAD_REQUEST');
  });

  it('narrows by site (subdomains included, www ignored), type and a minimum of focus', async () => {
    expect(titles(await h.api.searchPages({ site: 'example.com' })).sort()).toEqual(['Alarm snippet', 'Durable Objects 入门', '用 FTS5 做中文搜索']);
    expect(titles(await h.api.searchPages({ site: 'www.gist.example.com' }))).toEqual(['Alarm snippet']);
    expect(titles(await h.api.searchPages({ pageType: PageType.READ })).sort()).toEqual(['Alarm snippet', 'Durable Objects 入门', '深夜的数据库笔记', '用 FTS5 做中文搜索']);
    expect(titles(await h.api.searchPages({ minFocusSeconds: 600 })).sort()).toEqual(['Durable Objects 入门', '深夜的数据库笔记', '用 FTS5 做中文搜索']);
  });

  it('with a time range: the visits overlapping it, a visit that crosses midnight counted whole', async () => {
    const today = await h.api.searchPages({ startTime: ts(DAY0), endTime: ts(DAY0 + DAY) });
    expect(titles(today)).toEqual(['Cold start, explained', 'Alarm snippet', 'Durable Objects 入门', '深夜的数据库笔记']);
    const late = today.results.find((r) => r.title === '深夜的数据库笔记');
    expect(late).toMatchObject({ focusSeconds: 3600, visitCount: 1 });
    expect(titles(await h.api.searchPages({ startTime: ts(DAY0 - DAY), endTime: ts(DAY0) }))).toEqual(['深夜的数据库笔记', '用 FTS5 做中文搜索']);
    expect(titles(await h.api.searchPages({ query: '数据库', startTime: ts(DAY0 + 12 * HOUR) }))).toEqual([]);
    expect(titles(await h.api.searchPages({ minFocusSeconds: 1800, startTime: ts(DAY0) }))).toEqual(['深夜的数据库笔记']);
    expect(titles(await h.api.searchPages({ pageType: PageType.READ, site: 'example.com', startTime: ts(DAY0), endTime: ts(DAY0 + DAY) }))).toEqual(['Alarm snippet', 'Durable Objects 入门']);
  });

  it('sorts by relevance (a title match first) or by the latest visit', async () => {
    const relevance = await h.api.searchPages({ query: '数据库' });
    expect(relevance.results[0]?.title).toBe('深夜的数据库笔记');
    const recent = await h.api.searchPages({ query: '数据库', sortOrder: SortOrder.RECENT });
    expect(titles(recent)).toEqual(['Durable Objects 入门', '深夜的数据库笔记']);
    expect(titles(await h.api.searchPages({ query: '数据库', sortOrder: SortOrder.RELEVANCE, startTime: ts(DAY0 - DAY) }))[0]).toBe('深夜的数据库笔记');
  });

  it('answers snippets from the text around the first match, with every occurrence highlighted', async () => {
    const result = (await h.api.searchPages({ query: '冷启动' })).results.find((r) => r.title === 'Alarm snippet');
    expect(result?.hasText).toBe(true);
    expect(result?.snippet.filter((s) => s.highlighted).map((s) => s.text)).toEqual(['冷启动']);
    expect(result?.snippet.map((s) => s.text).join('')).toContain('setAlarm schedules');
    const titleOnly = (await h.api.searchPages({ query: 'cold' })).results[0];
    expect(titleOnly?.snippet).toEqual([]);
  });

  it('pages ten at a time with tokens bound to the other fields', async () => {
    const first = await h.api.searchPages({ pageSize: 2 });
    expect(first.results).toHaveLength(2);
    const second = await h.api.searchPages({ pageSize: 2, pageToken: first.nextPageToken });
    const third = await h.api.searchPages({ pageSize: 2, pageToken: second.nextPageToken });
    expect([...titles(first), ...titles(second), ...titles(third)]).toEqual(titles(await h.api.searchPages({})));
    expect(third.nextPageToken).toBe('');
    expect(reasonOf(await rejection(h.api.searchPages({ query: 'alarm', pageToken: first.nextPageToken })))).toBe('BAD_REQUEST');
  });
});

describe('the timeline and the sites', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    await seed(h);
  });
  afterAll(async () => {
    await h.dispose();
  });

  it("lists a day's visits oldest first, a visit that began the evening before included", async () => {
    const day = await h.api.listVisits({ parent: 'pages/-', startTime: ts(DAY0), endTime: ts(DAY0 + DAY) });
    expect(day.visits.map((v) => v.title)).toEqual(['深夜的数据库笔记', 'Durable Objects 入门', 'Alarm snippet', 'Cold start, explained']);
    expect(day.visits[0]).toMatchObject({ site: 'other.example.net', deviceLabel: 'MacBook · 工作', focusSeconds: 3600 });
    expect(day.visits[0]?.name).toMatch(/^pages\/[0-9a-f]{32}\/visits\//);
    const newest = await h.api.listVisits({ parent: 'pages/-', orderBy: 'start_time desc', startTime: ts(DAY0), endTime: ts(DAY0 + DAY) });
    expect(newest.visits.map((v) => v.title)).toEqual(['Cold start, explained', 'Alarm snippet', 'Durable Objects 入门', '深夜的数据库笔记']);
  });

  it('pages by a keyset, finds the previous day with records, and lists one page\'s visits', async () => {
    const first = await h.api.listVisits({ parent: 'pages/-', pageSize: 2 });
    const second = await h.api.listVisits({ parent: 'pages/-', pageSize: 2, pageToken: first.nextPageToken });
    const third = await h.api.listVisits({ parent: 'pages/-', pageSize: 2, pageToken: second.nextPageToken });
    expect([...first.visits, ...second.visits, ...third.visits].map((v) => v.title)).toEqual(['用 FTS5 做中文搜索', '深夜的数据库笔记', 'Durable Objects 入门', 'Alarm snippet', 'Cold start, explained']);
    expect(third.nextPageToken).toBe('');
    // 上一个有记录的日子: the newest visit before a day's start.
    const before = await h.api.listVisits({ parent: 'pages/-', endTime: ts(DAY0 - DAY), orderBy: 'start_time desc', pageSize: 1 });
    expect(before.visits).toEqual([]);
    const previous = await h.api.listVisits({ parent: 'pages/-', endTime: ts(DAY0 - 2 * HOUR), orderBy: 'start_time desc', pageSize: 1 });
    expect(previous.visits.map((v) => v.title)).toEqual(['用 FTS5 做中文搜索']);
    const { pageId } = await page(SEEDS[0]?.url ?? '');
    const own = await h.api.listVisits({ parent: `pages/${pageId}` });
    expect(own.visits).toHaveLength(1);
    const one = await h.api.getVisit({ name: own.visits[0]?.name ?? '' });
    expect(one.focusSpans).toHaveLength(1);
    expect(reasonOf(await rejection(h.api.listVisits({ parent: 'pages/-', orderBy: 'end_time' })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.listVisits({ parent: `pages/${'0'.repeat(32)}` })))).toBe('NOT_FOUND');
  });

  it('lists the sites most focused first, with a prefix filter', async () => {
    const sites = await h.api.listSites({});
    expect(sites.sites.map((s) => s.name)).toEqual(['sites/other.example.net', 'sites/docs.example.com', 'sites/example.com', 'sites/gist.example.com', 'sites/news.example.org']);
    expect((await h.api.listSites({ filter: '"www.gist"' })).sites.map((s) => s.name)).toEqual(['sites/gist.example.com']);
    const firstTwo = await h.api.listSites({ pageSize: 2 });
    const rest = await h.api.listSites({ pageSize: 10, pageToken: firstTwo.nextPageToken });
    expect([...firstTwo.sites, ...rest.sites].map((s) => s.name)).toEqual(sites.sites.map((s) => s.name));
    expect(reasonOf(await rejection(h.api.listSites({ filter: 'a OR b' })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.getSite({ name: 'sites/missing.example.com' })))).toBe('NOT_FOUND');
  });

  it('moves the oldest texts out of the index past its budget; title and URL stay searchable', async () => {
    await h.sql(`UPDATE meta SET value = ? WHERE key = 'indexed_text_bytes'`, String(600 * 1024 * 1024));
    let result = await h.step(NOW + MINUTE);
    expect(result.demoting).toBe(true);
    expect(titles(await h.api.searchPages({ query: 'bm25' }))).toEqual([]);
    expect(titles(await h.api.searchPages({ query: 'fts5' }))).toEqual(['用 FTS5 做中文搜索']);
    const { pageId } = await page(SEEDS[2]?.url ?? '');
    expect((await h.api.getPage({ name: `pages/${pageId}` })).textIndexed).toBe(false);
    await h.sql(`UPDATE meta SET value = '0' WHERE key = 'indexed_text_bytes'`);
    result = await h.step(NOW + 2 * MINUTE);
    expect(result.demoting).toBe(false);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.oldestIndexedTextTime).toBeDefined();
  });
});

describe('the read bounds', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    await seed(h);
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('a range with more than 20,000 visits reads its newest ones and says so', async () => {
    const [{ rowid } = { rowid: 0 }] = await h.sql<{ rowid: number }>(`SELECT rowid FROM pages ORDER BY rowid LIMIT 1`);
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20050)
       INSERT INTO visits (id, seq, seq_ms, page_rowid, device_id, device_label, url, title, start_ms, end_ms, focus_seconds, spans, revision)
       SELECT printf('ffffffff-0000-4000-8000-%012x', i), 1000 + i, 0, ?, 'x', 'x', 'u', 't', ? - i * 1000, ? - i * 1000 + 500, 1, '[]', 1 FROM n`,
      rowid,
      DAY0 - 3 * DAY,
      DAY0 - 3 * DAY,
    );
    const capped = await h.api.searchPages({ startTime: ts(DAY0 - 4 * DAY), endTime: ts(DAY0 - 2 * DAY) });
    expect(capped.candidatesCapped).toBe(true);
    const narrow = await h.api.searchPages({ startTime: ts(DAY0 - 3 * DAY - HOUR), endTime: ts(DAY0 - 2 * DAY) });
    expect(narrow.candidatesCapped).toBe(false);
    // An empty answer still says whether the bound was reached.
    expect(await h.api.searchPages({ site: 'nothing.example.com', startTime: ts(DAY0 - 4 * DAY), endTime: ts(DAY0 - 2 * DAY) })).toMatchObject({ results: [], candidatesCapped: true });
  });

  it('without a range, more than 2,000 matches are read up to the bound, said only when the other fields left too few', async () => {
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2100)
       INSERT INTO pages (id, url, title, host_key, last_visit_ms, visit_count, focus_seconds) SELECT printf('%032x', i), 'https://bulk.example.com/' || i, 'bulk page', 'com.example.bulk.', ? - i, 1, 1 FROM n`,
      DAY0 - 5 * DAY,
    );
    await h.sql(`INSERT INTO fts (rowid, title, url, body) SELECT rowid, 'bulk page', 'bulk example com', '' FROM pages WHERE host_key = 'com.example.bulk.'`);
    // The best 2,000 matches hold the best 200 results: complete.
    expect((await h.api.searchPages({ query: 'bulk' })).candidatesCapped).toBe(false);
    // A type that none of the best 2,000 has: the bound may hide others.
    expect(await h.api.searchPages({ query: 'bulk', pageType: PageType.READ })).toMatchObject({ results: [], candidatesCapped: true });
    // 最新 past the bound scans the pages by their latest visit instead, and a site of 2,100 pages is read whole.
    const recent = await h.api.searchPages({ query: 'bulk', sortOrder: SortOrder.RECENT });
    expect(recent).toMatchObject({ candidatesCapped: false });
    expect(recent.results[0]?.url).toBe('https://bulk.example.com/1');
    expect((await h.api.searchPages({ site: 'bulk.example.com' })).candidatesCapped).toBe(false);
    expect((await h.api.searchPages({ query: 'alarm' })).candidatesCapped).toBe(false);
    // A search reaches at most 200 results.
    let token = '';
    let count = 0;
    do {
      const pageOf = await h.api.searchPages({ query: 'bulk', pageToken: token });
      count += pageOf.results.length;
      token = pageOf.nextPageToken;
    } while (token !== '');
    expect(count).toBe(200);
  });
});

describe('a synthetic two-year store', () => {
  let h: Harness;
  const START = Date.parse('2024-10-10T00:00:00Z');
  beforeAll(async () => {
    h = await startHarness();
    // 730 days, 30 visits a day over 9,000 pages; a third of the pages have a text; the word "weekly" is common.
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 9000)
       INSERT INTO pages (id, url, title, host_key, first_visit_ms, last_visit_ms, visit_count, focus_seconds, document_count, text_indexed)
       SELECT printf('%032x', i), 'https://site' || (i % 40) || '.example.com/p/' || i, 'page ' || i, 'com.example.site' || (i % 40) || '.', 0, 0, 0, 0,
              CASE WHEN i % 3 = 0 THEN 1 ELSE 0 END, CASE WHEN i % 3 = 0 THEN 100 ELSE 0 END FROM n`,
    );
    await h.sql(
      `INSERT INTO fts (rowid, title, url, body) SELECT rowid, title, 'site example com p', CASE WHEN document_count > 0 THEN 'weekly notes about storage' ELSE '' END FROM pages`,
    );
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 21899)
       INSERT INTO visits (id, seq, seq_ms, page_rowid, device_id, device_label, url, title, start_ms, end_ms, focus_seconds, spans, revision)
       SELECT printf('eeeeeeee-0000-4000-8000-%012x', i), 1 + i, 0, 1 + (i * 7919) % 9000, 'x', 'x', 'u', 't', ? + (i / 30) * 86400000 + (i % 30) * 1800000,
              ? + (i / 30) * 86400000 + (i % 30) * 1800000 + 600000, 600, '[]', 1 FROM n`,
      START,
      START,
    );
    await h.sql(`UPDATE pages SET last_visit_ms = (SELECT max(end_ms) FROM visits WHERE page_rowid = pages.rowid), visit_count = (SELECT count(*) FROM visits WHERE page_rowid = pages.rowid)`);
  });
  afterAll(async () => {
    await h.dispose();
  });

  it("finds an old week's read pages and a common word within a range, complete and within the read bounds", async () => {
    const week = { startTime: ts(START + 100 * DAY), endTime: ts(START + 107 * DAY) };
    await h.rows();
    const read = await h.api.searchPages({ ...week, pageType: PageType.READ, pageSize: 10 });
    const meter = await h.rows();
    expect(read.candidatesCapped).toBe(false);
    expect(read.results.length).toBe(10);
    expect(read.results.every((r) => r.hasText)).toBe(true);
    const expected = await h.sql<{ n: number }>(
      `SELECT count(DISTINCT v.page_rowid) AS n FROM visits v JOIN pages p ON p.rowid = v.page_rowid WHERE v.start_ms < ? AND v.end_ms > ? AND p.document_count > 0`,
      START + 107 * DAY,
      START + 100 * DAY,
    );
    let all = read.results.length;
    for (let token = read.nextPageToken; token !== ''; ) {
      const next = await h.api.searchPages({ ...week, pageType: PageType.READ, pageToken: token });
      all += next.results.length;
      token = next.nextPageToken;
    }
    expect(all).toBe(Math.min(200, expected[0]?.n ?? 0));
    // A week is about 210 visits: the search reads about those and their pages, not the store.
    expect(meter.read).toBeLessThan(5000);
    const word = await h.api.searchPages({ query: 'weekly', ...week });
    expect(word.candidatesCapped).toBe(false);
    expect(word.results.length).toBe(10);
  });
});
