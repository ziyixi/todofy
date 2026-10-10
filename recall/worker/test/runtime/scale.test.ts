// Rows read at the design's two-year scale (../../../docs/design.md §5.3, §6.3): 65,000 pages, 220,000 visits, a third
// of the pages with a text, the word "weekly" in every text. Every row a call reads counts against the account's daily
// 5 million (shared by every app), so each search path, a search's next page, the status and ops-v1 are held to a
// bound here, whatever the store's size: a common word with and without a range, a rare word, Chinese, 最近读过, a
// site, a minimum of focus that no page reaches (the scan's bound, reported), an old week's read pages, a long range.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MessageInitShape } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { PageType, SortOrder, type SearchPagesRequestSchema } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { BEHIND_COUNT_MAX, SEARCH_MAX_MATCHES, SEARCH_MAX_VISITS, SEARCH_SCAN_PAGES } from '../../src/limits.ts';
import { DAY, HOUR, startHarness, type Harness } from './harness.ts';

const ts = timestampFromMs;
const START = Date.parse('2024-10-10T00:00:00Z');
const NOW = START + 730 * DAY;
const PAGES = 65_000;
const VISITS = 220_000;
/** A visit every 4.8 minutes over the two years, each on another page (no repeats: the most pages per range). */
const VISIT_EVERY_MS = Math.floor((730 * DAY) / VISITS);

/** Rows read at most: about three per match a search may read, or the scan; with a range, three per visit besides. */
const NO_RANGE_BOUND = 3 * SEARCH_MAX_MATCHES + 100;
const RANGE_BOUND = 3 * SEARCH_MAX_VISITS + SEARCH_MAX_MATCHES + 100;

type Request = MessageInitShape<typeof SearchPagesRequestSchema>;

describe('rows read on a synthetic two-year store', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(PAGES)})
       INSERT INTO pages (id, url, title, host_key, first_visit_ms, last_visit_ms, visit_count, focus_seconds, document_count, text_indexed)
       SELECT printf('%032x', i), 'https://site' || (i % 400) || '.example.com/p/' || i, 'page ' || i, 'com.example.site' || (i % 400) || '.', 0, 0, 0, 0,
              CASE WHEN i % 3 = 0 THEN 1 ELSE 0 END, CASE WHEN i % 3 = 0 THEN 100 ELSE 0 END FROM n`,
    );
    await h.sql(
      `INSERT INTO fts (rowid, title, url, body) SELECT rowid, title, 'site example com p',
         CASE WHEN document_count > 0 THEN 'weekly notes about storage 数据 据库 rare' || (rowid % 500) ELSE '' END FROM pages`,
    );
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(VISITS - 1)})
       INSERT INTO visits (id, seq, seq_ms, page_rowid, device_id, device_label, url, title, start_ms, end_ms, focus_seconds, spans, revision)
       SELECT printf('eeeeeeee-0000-4000-8000-%012x', i), 1 + i, 0, 1 + (i * 7919) % ${String(PAGES)}, 'x', 'x', 'u', 't', ? + i * ?, ? + i * ? + 600000, 600, '[]', 1 FROM n`,
      START,
      VISIT_EVERY_MS,
      START,
      VISIT_EVERY_MS,
    );
    await h.sql(
      `UPDATE pages SET last_visit_ms = (SELECT max(end_ms) FROM visits WHERE page_rowid = pages.rowid),
         visit_count = (SELECT count(*) FROM visits WHERE page_rowid = pages.rowid),
         focus_seconds = 600 * (SELECT count(*) FROM visits WHERE page_rowid = pages.rowid)`,
    );
    // An archive consumer 200,000 changes behind that pulled an hour ago, and one gone for two months.
    await h.sql(`INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, String(VISITS));
    await h.sql(`INSERT INTO consumers (name, synced_seq, last_pull_ms) VALUES ('nas', 20000, ?), ('old', 10, ?)`, NOW - HOUR, NOW - 60 * DAY);
    await h.clock(NOW);
  }, 300_000);
  afterAll(async () => {
    await h.dispose();
  });

  const week = { startTime: ts(START + 100 * DAY), endTime: ts(START + 107 * DAY) };
  const cases: readonly (readonly [string, Request, number, boolean])[] = [
    ['最近读过', { pageType: PageType.READ }, NO_RANGE_BOUND, false],
    ['a common word, 相关', { query: 'weekly' }, NO_RANGE_BOUND, false],
    ['a common word, 最新', { query: 'weekly', sortOrder: SortOrder.RECENT }, NO_RANGE_BOUND, false],
    ['a rare word', { query: 'rare7' }, NO_RANGE_BOUND, false],
    ['a Chinese phrase', { query: '数据库' }, NO_RANGE_BOUND, false],
    ['a site and a word', { site: 'site7.example.com', query: 'weekly' }, NO_RANGE_BOUND, false],
    ['a minimum of focus no page reaches', { minFocusSeconds: 7200 }, SEARCH_SCAN_PAGES + 100, true],
    ['a common word within 30 days', { query: 'weekly', startTime: ts(NOW - 30 * DAY), endTime: ts(NOW) }, RANGE_BOUND, false],
    ["an old week's read pages", { ...week, pageType: PageType.READ }, RANGE_BOUND, false],
    ['a common word over all time', { query: 'weekly', startTime: ts(START), endTime: ts(NOW + HOUR) }, RANGE_BOUND, true],
  ];

  for (const [label, request, bound, capped] of cases) {
    it(`${label}: at most ${String(bound)} rows, its next page next to none`, async () => {
      await h.rows();
      const first = await h.api.searchPages(request);
      expect((await h.rows()).read).toBeLessThanOrEqual(bound);
      expect(first.candidatesCapped).toBe(capped);
      if (!capped) expect(first.results).toHaveLength(10);
      if (first.nextPageToken !== '') {
        await h.api.searchPages({ ...request, pageToken: first.nextPageToken });
        expect((await h.rows()).read).toBeLessThan(10);
      }
    });
  }

  it('reads the status and ops-v1 with a few rows, however far behind an archive is', async () => {
    await h.rows();
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect((await h.rows()).read).toBeLessThan(3 * BEHIND_COUNT_MAX + 100);
    expect(status.archiveConsumers.find((c) => c.consumer === 'nas')).toMatchObject({ behindCount: BEHIND_COUNT_MAX, stale: false });
    expect(status.archiveConsumers.find((c) => c.consumer === 'old')).toMatchObject({ behindCount: 0, stale: true });
    await h.opsStatus();
    expect((await h.rows()).read).toBeLessThan(100);
  });
});
