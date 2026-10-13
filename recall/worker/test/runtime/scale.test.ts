// Rows read at the design's two-year scale (../../../docs/design.md §5.3, §6.3): 65,000 pages, 220,000 visits, a third
// of the pages with a text, the word "weekly" in every text. Every row a call reads counts against the account's daily
// 5 million (shared by every app), so each search path, a search's next page, the status and ops-v1 are held to a
// bound here, whatever the store's size: a common word with and without a range, a rare word, Chinese, 最近读过, a
// site, a minimum of focus that no page reaches (the scan's bound, reported), an old week's read pages, a long range;
// the archive's passes to Dropbox when it is connected to the whole store at once (the scan, then the days); and the
// retention window's step over two years of texts the archive confirmed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MessageInitShape } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { PageType, SortOrder, type SearchPagesRequestSchema } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import {
  ARCHIVE_RENDER_MAX,
  ARCHIVE_SCAN_ROWS,
  BEHIND_COUNT_MAX,
  MINUTE,
  RETENTION_BATCH,
  RETENTION_SCAN,
  SEARCH_MAX_MATCHES,
  SEARCH_MAX_VISITS,
  SEARCH_SCAN_PAGES,
} from '../../src/limits.ts';
import { FakeDropbox } from './fake-dropbox.ts';
import { DAY, HOUR, op, startHarness, type Harness } from './harness.ts';

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
  const dropbox = new FakeDropbox();
  beforeAll(async () => {
    h = await startHarness({ outbound: (request) => dropbox.handle(request) });
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
       SELECT printf('eeeeeeee-0000-4000-8000-%012x', i), 1 + i, ? + i * ? + 600000, 1 + (i * 7919) % ${String(PAGES)}, '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', 'x', 'https://example.com/u', 't', ? + i * ?, ? + i * ? + 600000, 600, '[]', 1 FROM n`,
      START,
      VISIT_EVERY_MS,
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

  it('reads a device timeline without scanning other devices, including a device with no visits', async () => {
    await h.rows();
    const empty = await h.api.listVisits({ parent: 'pages/-', deviceId: '911e6d72-e917-4a44-a84e-1a6b3a8a0f11' });
    expect(empty.visits).toEqual([]);
    expect((await h.rows()).read).toBeLessThan(100);
    const known = await h.api.listVisits({ parent: 'pages/-', deviceId: '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', pageSize: 50 });
    expect(known.visits).toHaveLength(50);
    expect((await h.rows()).read).toBeLessThan(300);
  });

  it('reads the status and ops-v1 with a few rows, however far behind an archive is', async () => {
    // Dropbox connected to the whole store at once: every change waits for it.
    const { authorizeUrl } = await h.api.connectDropboxBackup({ name: 'dropboxBackup', appKey: dropbox.appKey, requestId: op() });
    expect((await h.fetch(`/api/dropbox/callback${dropbox.approve(authorizeUrl).query}`)).headers.get('location')).toBe('/settings?dropbox=connected');
    await h.rows();
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect((await h.rows()).read).toBeLessThan(5 * BEHIND_COUNT_MAX + 100);
    expect(status.archiveConsumers.find((c) => c.consumer === 'nas')).toMatchObject({ behindCount: BEHIND_COUNT_MAX, stale: false });
    expect(status.archiveConsumers.find((c) => c.consumer === 'old')).toMatchObject({ behindCount: 0, stale: true });
    expect(status.dropboxBackup).toMatchObject({ connected: true, pendingCount: BEHIND_COUNT_MAX });
    await h.opsStatus();
    expect((await h.rows()).read).toBeLessThan(100);
  });

  it('scans the store in passes of a bounded read, then writes its days, each pass bounded', async () => {
    const reads: number[] = [];
    let writing = 0;
    for (let pass = 0; pass < 40 && writing < 2; pass++) {
      const uploadsBefore = dropbox.callsTo('/2/files/upload').length;
      await h.rows();
      const result = await h.step(NOW + (pass + 1) * MINUTE);
      reads.push((await h.rows()).read);
      expect(result.code).toBe('ok');
      if (dropbox.callsTo('/2/files/upload').length > uploadsBefore) writing += 1;
    }
    expect(writing).toBe(2);
    // A scan pass: its three reads of ARCHIVE_SCAN_ROWS at most; a writing pass: the days it renders (each change and
    // its page) up to ARCHIVE_RENDER_MAX, and its last day whole (about 300 changes here).
    expect(Math.max(...reads)).toBeLessThan(3 * ARCHIVE_SCAN_ROWS + 2 * ARCHIVE_RENDER_MAX + 2000);
    const days = dropbox.callsTo('/2/files/upload').filter((call) => call.path?.startsWith('/changes/'));
    expect(days[0]?.path).toBe('/changes/2026/10/10.jsonl');
  }, 120_000);

  it('moves texts past the retention window out of Cloudflare with a bounded read, however many the store holds', async () => {
    // A text for every third page over the two years, each confirmed by the archive (its blob and day file written,
    // state.json past it), and nothing left for the archive's pass to write.
    const target = (await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'archive_target'`))[0]?.value ?? '';
    const texts = Math.floor(PAGES / 3);
    const every = Math.floor((730 * DAY) / texts);
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(texts)})
       INSERT INTO documents (id, seq, seq_ms, page_rowid, visit, device_id, device_label, capture_ms, url, title, description, blob_path, sha256, stored_bytes, text_bytes, text_sha256)
       SELECT printf('cccccccc-0000-4000-8000-%012x', i), ${String(VISITS)} + i, ? + i * ? + 60000, 3 * i, 'v', 'd', 'x', ? + i * ?, 'https://example.com/', 't', '',
              printf('2025/01/cccccccc-0000-4000-8000-%012x.txt.gz', i), 'a', 1000, 3000, 'unused' FROM n`,
      START,
      every,
      START,
      every,
    );
    await h.sql(`INSERT INTO archive_blobs (path, target, content_hash) SELECT blob_path, ?, 'b' FROM documents`, target);
    await h.sql(
      `INSERT INTO archive_days (day, min_seq, max_seq, dirty, content_hash) SELECT strftime('%Y-%m-%d', seq_ms / 1000, 'unixepoch'), min(seq), max(seq), 0, 'c' FROM documents GROUP BY 1
       ON CONFLICT (day) DO UPDATE SET dirty = 0, content_hash = 'c'`,
    );
    await h.sql(`UPDATE archive_days SET dirty = 0, content_hash = coalesce(content_hash, 'c')`);
    for (const key of ['seq', 'archive_scan_seq', 'archive_seq']) {
      await h.sql(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, String(VISITS + texts));
    }
    await h.rows();
    const result = await h.step(NOW + 2 * HOUR);
    const rows = await h.rows();
    expect(result).toMatchObject({ code: 'ok', archive: 'done', retaining: true });
    expect(rows.read).toBeLessThan(3 * RETENTION_SCAN + 1000);
    expect(await h.sql(`SELECT count(*) AS n FROM documents WHERE archived_ms IS NOT NULL`)).toEqual([{ n: RETENTION_BATCH }]);
    // The oldest went first: all of them captured in the first months of the two years.
    expect(await h.sql(`SELECT max(capture_ms) < ? AS early FROM documents WHERE archived_ms IS NOT NULL`, START + 30 * DAY)).toEqual([{ early: 1 }]);
  }, 120_000);

  it('checks connection history and removes an empty device without scanning visits or snapshots', async () => {
    const known = '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10';
    const empty = '911e6d72-e917-4a44-a84e-1a6b3a8a0f11';
    // Existing archive aggregates have their own bounded reads; measure only the connections' added cost.
    await h.rows();
    await h.api.getServiceStatus({ name: 'serviceStatus' });
    const baseline = (await h.rows()).read;
    // The existing two-year fixture has 220,000 visits on known and over 20,000 snapshots on d.
    for (const id of [known, 'd', empty]) {
      await h.sql(`INSERT INTO devices (id, label, extension_version, first_seen_ms, last_seen_ms) VALUES (?, 'Synthetic device', 'test', ?, ?)`, id, START, NOW);
    }
    await h.rows();
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect((await h.rows()).read - baseline).toBeLessThan(100);
    expect(status.devices.find((device) => device.deviceId === known)?.hasRecords).toBe(true);
    expect(status.devices.find((device) => device.deviceId === 'd')?.hasRecords).toBe(true);
    expect(status.devices.find((device) => device.deviceId === empty)?.hasRecords).toBe(false);
    await h.api.deleteDevice({ name: `devices/${empty}`, requestId: op() });
    expect((await h.rows()).read).toBeLessThan(100);
    expect(await h.sql(`SELECT id FROM devices WHERE id = ?`, empty)).toEqual([]);
  });
});
