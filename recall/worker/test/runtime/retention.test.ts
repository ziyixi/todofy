// The retention window in workerd (../../../docs/design.md §2.3, §5.4), with a real RecallState and R2 and a fake
// Dropbox (fake-dropbox.ts): nothing leaves Cloudflare while Dropbox is not connected or its last upload failed; after
// the pass that confirms them, the files past the window leave R2 while the index stays, while the pages, their visits and the
// document records stay, no tombstone is written, the feed is unchanged and the blob route answers 410; the page detail
// says where the archive keeps the text; a text read again is kept again; the owner's window and its range; a new
// Dropbox gets every line without the texts only the old one holds. Then, on seeded rows: the window's boundary and
// the bounded work of each pass, its rows read and written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { RETENTION_BATCH, RETENTION_SCAN, TEXT_RETENTION_DEFAULT_DAYS } from '../../src/limits.ts';
import { batch, document, page, uuid, visit, WEBP, type ChangePage } from './data.ts';
import { FakeDropbox } from './fake-dropbox.ts';
import { DAY, machineReason, MINUTE, op, reasonOf, rejection, SECOND, sha256, startHarness, T0, type Harness } from './harness.ts';

/** The endpoints recall may call; a delete or a move must never be called. */
const ALLOWED = new Set(['/oauth2/token', '/2/users/get_current_account', '/2/auth/token/revoke', '/2/files/upload', '/2/files/download']);

async function upload(h: Harness, items: unknown[], sentMs: number): Promise<void> {
  const response = await h.upload(batch(items, { sentMs }));
  expect(response.status, await response.clone().text()).toBe(200);
}

async function connect(h: Harness, dropbox: FakeDropbox): Promise<void> {
  const { authorizeUrl } = await h.api.connectDropboxBackup({ name: 'dropboxBackup', appKey: dropbox.appKey, requestId: op() });
  expect((await h.fetch(`/api/dropbox/callback${dropbox.approve(authorizeUrl).query}`)).headers.get('location')).toBe('/settings?dropbox=connected');
}

const status = (h: Harness) => h.api.getServiceStatus({ name: 'serviceStatus' });
const archivedIds = async (h: Harness) => (await h.sql<{ id: string }>(`SELECT id FROM documents WHERE archived_ms IS NOT NULL ORDER BY id`)).map((row) => row.id);

describe('the retention window with Dropbox', () => {
  let dropbox = new FakeDropbox();
  let h: Harness;
  const read = 'https://docs.example.com/guide/alarms';
  const kept = 'https://notes.example.org/today';
  const doomed = 'https://news.example.net/old';
  const later = T0 + (TEXT_RETENTION_DEFAULT_DAYS + 5) * DAY;
  /** A text's blob path: the UTC month of its capture (T0's, or `later`'s for the texts read again). */
  const blobPath = (n: number) => `${n < 5 ? '2026/10' : new Date(later).toISOString().slice(0, 7).replace('-', '/')}/${uuid(n)}.txt.gz`;

  beforeAll(async () => {
    h = await startHarness({ outbound: (request) => dropbox.handle(request) });
    await upload(
      h,
      [
        await visit({ id: uuid(1), url: read, title: 'Alarm 指南', spans: [[T0 - 10 * MINUTE, T0 - 5 * MINUTE]] }),
        await document({ id: uuid(2), visitId: uuid(1), url: read, captureMs: T0 - 9 * MINUTE, text: '合成正文：持久对象的闹钟 alarm 与存储 keyword-zephyr。', screenshot: WEBP }),
        await visit({ id: uuid(3), url: doomed, title: '旧闻', spans: [[T0 - 4 * MINUTE, T0 - 3 * MINUTE]] }),
        await document({ id: uuid(4), visitId: uuid(3), url: doomed, captureMs: T0 - 4 * MINUTE + 15 * SECOND, text: '要删除的合成正文 keyword-quokka。' }),
      ],
      T0,
    );
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('keeps every text in Cloudflare while Dropbox is not connected, and says so', async () => {
    await h.clock(later);
    expect(await h.step(later)).toMatchObject({ retaining: false, archive: 'idle', code: 'ok' });
    expect(await archivedIds(h)).toEqual([]);
    expect(await (await h.r2()).head(`blobs/${blobPath(2)}`)).not.toBeNull();
    expect(await status(h)).toMatchObject({ textRetentionDays: TEXT_RETENTION_DEFAULT_DAYS, archivedTextCount: 0, documentCount: 2, textRetentionPausedReason: 'dropbox_not_connected' });
  });

  it('keeps every text while the last upload to Dropbox failed', async () => {
    await connect(h, dropbox);
    // The owner deletes a page meanwhile: its text leaves recall by the deletion, never by retention.
    const { pageId } = await page(doomed);
    await h.api.deletePage({ name: `pages/${pageId}`, requestId: op() });
    dropbox.failNext('/2/files/upload', () => new Response('', { status: 503 }));
    const failed = await h.step(later + MINUTE);
    expect(failed).toMatchObject({ archive: 'retry', retaining: false });
    expect(await archivedIds(h)).toEqual([]);
    expect(await status(h)).toMatchObject({ archivedTextCount: 0, textRetentionPausedReason: 'dropbox_failing' });
  });

  it('moves the texts past the window out of Cloudflare once the pass confirmed them; the page and its visits stay, no tombstone', async () => {
    const head = (await status(h)).headSeq;
    const tombstones = await h.sql(`SELECT id FROM tombstones`);
    const before = await (await h.changes('?after=0&limit=500')).json<ChangePage>();
    expect(await h.step(later + 5 * MINUTE)).toMatchObject({ archive: 'done', retaining: false, code: 'ok' });
    expect(await archivedIds(h)).toEqual([uuid(2)]);
    expect(dropbox.files.has(`/blobs/${blobPath(2)}`)).toBe(true);
    const imagePath = blobPath(2).replace('.txt.gz', '.webp');
    expect(btoa(String.fromCharCode(...(dropbox.files.get(`/blobs/${imagePath}`) ?? [])))).toBe(WEBP);
    expect(await (await h.r2()).head(`blobs/${imagePath}`)).toBeNull();
    expect(await (await h.r2()).head(`blobs/${blobPath(2)}`)).toBeNull();
    // The page, its visits and the document's record stay; the page detail says where the archive keeps the text.
    const { pageId } = await page(read);
    const shown = await h.api.getPage({ name: `pages/${pageId}` });
    expect(shown).toMatchObject({ visitCount: 1, documentCount: 1, textIndexed: true, latestDocument: `pages/${pageId}/documents/${uuid(2)}` });
    expect((await h.api.listVisits({ parent: `pages/${pageId}` })).visits).toHaveLength(1);
    expect(await h.api.getDocument({ name: shown.latestDocument })).toMatchObject({ textArchived: true, archivePath: `blobs/${blobPath(2)}`, text: '合成正文：持久对象的闹钟 alarm 与存储 keyword-zephyr。', textBytes: 70, screenshotWebpBase64: WEBP, screenshotWidth: 1, screenshotHeight: 1, contentError: '' });
    const privateRead = await h.serviceFetch(`/api/v1/${shown.latestDocument}`);
    expect(privateRead.status).toBe(200);
    const privateDocument = await privateRead.json<{ text_archived: boolean; text: string; content_error?: string }>();
    expect(privateDocument).toMatchObject({ text_archived: true, text: '合成正文：持久对象的闹钟 alarm 与存储 keyword-zephyr。' });
    expect(privateDocument.content_error ?? '').toBe('');
    // Still found by archived text; snippets only read R2 and remain optional.
    expect((await h.api.searchPages({ query: 'keyword-zephyr' })).results).toHaveLength(1);
    expect((await h.api.searchPages({ query: 'Alarm 指南' })).results.map((result) => [result.page, result.hasText, result.snippet.length])).toEqual([[`pages/${pageId}`, true, 0]]);
    // Not a deletion: no tombstone, no new seq, the feed renders the same changes; the blob route answers 410.
    expect(await h.sql(`SELECT id FROM tombstones`)).toEqual(tombstones);
    expect((await status(h)).headSeq).toBe(head);
    expect(await (await h.changes('?after=0&limit=500')).json<ChangePage>()).toEqual(before);
    const gone = await h.blob(blobPath(2));
    expect([gone.status, await machineReason(gone)]).toEqual([410, 'BLOB_DELETED']);
    expect(await status(h)).toMatchObject({ archivedTextCount: 1, documentCount: 1, textRetentionPausedReason: '' });
    expect((await status(h)).recentErrorCodes).not.toContain('blob_missing');
    expect(dropbox.calls.every((call) => ALLOWED.has(call.endpoint) || call.endpoint === '/oauth2/authorize')).toBe(true);
  });

  it('keeps a text read again after its archive, and finds it by its words again', async () => {
    await upload(
      h,
      [
        await visit({ id: uuid(5), url: read, title: 'Alarm 指南', spans: [[later + 10 * MINUTE, later + 12 * MINUTE]] }),
        await document({ id: uuid(6), visitId: uuid(5), url: read, captureMs: later + 10 * MINUTE + 15 * SECOND, text: '合成正文：持久对象的闹钟 alarm 与存储 keyword-zephyr。' }),
        await visit({ id: uuid(7), url: kept, title: '今天', spans: [[later + 13 * MINUTE, later + 14 * MINUTE]] }),
        await document({ id: uuid(8), visitId: uuid(7), url: kept, captureMs: later + 13 * MINUTE + 15 * SECOND, text: '今天的合成正文 keyword-ibex。' }),
      ],
      later + 15 * MINUTE,
    );
    expect((await h.api.searchPages({ query: 'keyword-zephyr' })).results).toHaveLength(1);
    expect(await status(h)).toMatchObject({ archivedTextCount: 1, documentCount: 3 });
  });

  it("is the owner's: 7 to 3650 days, or every text kept", async () => {
    const settings = await h.api.getSettings({ name: 'settings' });
    expect(settings.textRetentionDays).toBe(TEXT_RETENTION_DEFAULT_DAYS);
    for (const days of [6, 3651, 0]) {
      expect(reasonOf(await rejection(h.api.updateSettings({ settings: { name: 'settings', textRetentionDays: days }, updateMask: { paths: ['text_retention_days'] }, requestId: op() })))).toBe('INVALID_RETENTION');
    }
    const off = await h.api.updateSettings({ settings: { name: 'settings', etag: settings.etag }, updateMask: { paths: ['text_retention_days', 'etag'] }, requestId: op() });
    expect(off.textRetentionDays).toBeUndefined();
    expect(off.etag).not.toBe(settings.etag);
    expect(await status(h)).toMatchObject({ textRetentionDays: 0, textRetentionPausedReason: '' });
    // The lists are untouched by it.
    expect(off.denylistPatterns).toEqual(settings.denylistPatterns);
    const back = await h.api.updateSettings({ settings: { name: 'settings', textRetentionDays: 30, etag: off.etag }, updateMask: { paths: ['text_retention_days', 'etag'] }, requestId: op() });
    expect(back.textRetentionDays).toBe(30);
  });

  it('writes every line to a new Dropbox, without the texts only the old one holds', async () => {
    await h.api.disconnectDropboxBackup({ name: 'dropboxBackup', requestId: op() });
    const old = dropbox;
    dropbox = new FakeDropbox('otherappkey2');
    await connect(h, dropbox);
    expect(await h.step(later + DAY)).toMatchObject({ archive: 'done', code: 'ok' });
    expect(dropbox.files.has(`/blobs/${blobPath(2)}`)).toBe(false);
    expect(dropbox.files.has(`/blobs/${blobPath(6)}`)).toBe(true);
    expect([...dropbox.files.keys()].filter((path) => path.startsWith('/changes/')).sort()).toEqual([...old.files.keys()].filter((path) => path.startsWith('/changes/')).sort());
    expect((await status(h)).recentErrorCodes).not.toContain('blob_missing');
    // Within the window: nothing more leaves Cloudflare.
    expect(await archivedIds(h)).toEqual([uuid(2)]);
  });
});

describe('the retention window on many texts', () => {
  let h: Harness;
  const now = T0 + 400 * DAY;
  const window = 30;
  const cutoff = now - window * DAY;
  const TEXTS = 2 * RETENTION_BATCH + 50;
  const TARGET = 'dbid:AASynthetic syntheticappkey1';
  const path = (n: number) => `2026/08/${uuid(n, 2)}.txt.gz`;

  beforeAll(async () => {
    h = await startHarness({ outbound: (request) => new FakeDropbox().handle(request) });
    await h.sql(`INSERT INTO pages (id, url, title, host_key, first_visit_ms, last_visit_ms) VALUES (?, 'https://example.com/a', 'A', 'com.example.', 0, 0)`, 'a'.repeat(32));
    await h.sql(`INSERT INTO fts (rowid, title, url, body) VALUES (1, 'a', 'example com a', '')`);
    const bucket = await h.r2();
    // TEXTS texts past the window, oldest first, a minute apart; one more captured exactly at the window's edge.
    for (let i = 0; i <= TEXTS; i++) {
      const bytes = gzipSync(`合成正文 ${String(i)}`);
      const captureMs = i === TEXTS ? cutoff : cutoff - DAY - (TEXTS - i) * MINUTE;
      await bucket.put(`blobs/${path(i)}`, bytes);
      await h.sql(
        `INSERT INTO documents (id, seq, seq_ms, page_rowid, visit, device_id, device_label, capture_ms, url, title, description, blob_path, sha256, stored_bytes, text_bytes, text_sha256)
         VALUES (?, ?, ?, 1, ?, 'd', 'x', ?, 'https://example.com/a', 'A', '', ?, ?, ?, 20, 'unused')`,
        uuid(i, 2), i + 1, captureMs + MINUTE, uuid(i, 1), captureMs, path(i), sha256(bytes), bytes.byteLength,
      );
      await h.sql(`INSERT INTO archive_blobs (path, target, content_hash) VALUES (?, ?, ?)`, path(i), TARGET, 'b'.repeat(64));
      await h.sql(
        `INSERT INTO archive_days (day, min_seq, max_seq, dirty, content_hash) VALUES (?, ?, ?, 0, ?) ON CONFLICT (day) DO UPDATE SET max_seq = excluded.max_seq`,
        new Date(captureMs + MINUTE).toISOString().slice(0, 10), i + 1, i + 1, 'c'.repeat(64),
      );
    }
    const head = String(TEXTS + 1);
    await h.sql(`UPDATE meta SET value = ? WHERE key = 'seq'`, head);
    await h.sql(`INSERT INTO meta (key, value) VALUES ('document_count', ?), ('archived_count', '0')`, head);
    // Connected, everything written: the archive's pass has nothing to do and makes no call.
    for (const [key, value] of [['dropbox_refresh_token', 'synthetic-refresh'], ['dropbox_app_key', 'syntheticappkey1'], ['archive_target', TARGET], ['archive_checked', TARGET], ['archive_version', TARGET], ['archive_seq', head], ['archive_scan_seq', head]] as const) {
      await h.sql(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
    }
    await h.clock(now);
    await h.api.updateSettings({ settings: { name: 'settings', textRetentionDays: window }, updateMask: { paths: ['text_retention_days'] }, requestId: op() });
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('moves at most a batch a pass, oldest first, each pass bounded in rows; the text at the edge stays', async () => {
    const bucket = await h.r2();
    const counts: number[] = [];
    let result;
    let passes = 0;
    do {
      await h.rows();
      // At one clock, so that the window's edge stays where it is.
      result = await h.step(now);
      const rows = await h.rows();
      expect(result).toMatchObject({ archive: 'done', code: 'ok' });
      expect(rows.read).toBeLessThan(3 * RETENTION_SCAN + 500);
      expect(rows.written).toBeLessThan(10 * RETENTION_BATCH + 100);
      counts.push((await archivedIds(h)).length);
      passes += 1;
    } while (result.retaining && passes < 10);
    expect(counts).toEqual([RETENTION_BATCH, 2 * RETENTION_BATCH, TEXTS]);
    // A full batch brings the alarm back a minute later; the last one leaves it for the daily run.
    expect(result.next).toBeGreaterThan(now + MINUTE);
    expect(await bucket.head(`blobs/${path(0)}`)).toBeNull();
    expect(await bucket.head(`blobs/${path(TEXTS - 1)}`)).toBeNull();
    expect(await bucket.head(`blobs/${path(TEXTS)}`)).not.toBeNull();
    expect(await h.sql(`SELECT archived_ms FROM documents WHERE id = ?`, uuid(TEXTS, 2))).toEqual([{ archived_ms: null }]);
    expect(await status(h)).toMatchObject({ archivedTextCount: TEXTS, textRetentionDays: window });
    expect(await h.sql(`SELECT count(*) AS n FROM tombstones`)).toEqual([{ n: 0 }]);
  });
});
