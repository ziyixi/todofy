// Uploads end to end in workerd (../../../docs/design.md §4, §7, §10): an upload to the feed to the blob route, the
// contract's fixtures rebuilt from uploads, idempotent retries, the server's own scrub and denylist, refusals counted
// by reason, the write budget, and a crash between the R2 put and the commit.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { SettingsSchema } from '@ziyixi/proto/recall/ui/v1/status_pb';
import { batch, document, iso, page, text, uuid, visit, type ChangePage, type IngestAnswer } from './data.ts';
import { DAY, machineReason, MINUTE, op, sha256, startHarness, T0, type Harness } from './harness.ts';

const FIXTURES = new URL('../../../../contracts/recall-archive-v1/fixtures/', import.meta.url);
const at = (value: string) => Date.parse(value);
const DOCS = 'https://docs.example.com/guide/durable-objects';
const NEWS = 'https://news.example.org/2026/10/sqlite-fts5-chinese';
const FIXTURE_TEXT = 'Durable Objects 入门\n\n一个 Durable Object 是一个有名字的单例，带自己的 SQLite 存储。\nThis synthetic page explains alarms, storage and the 30 second CPU budget.\n';

async function ok(response: Response): Promise<IngestAnswer> {
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<IngestAnswer>();
}

async function feed(h: Harness, query = '?after=0&limit=500'): Promise<ChangePage> {
  const response = await h.changes(query);
  expect(response.status).toBe(200);
  return response.json<ChangePage>();
}

describe('upload to feed to blob', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it("rebuilds the contract's first page from the extension's uploads (revisions leave gaps)", async () => {
    const device = { device_id: '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', label: 'MacBook · 工作' };
    const visit1 = (revision: number, spans: [number, number][]) =>
      visit({ id: '1f3e8a27-6c4b-4f0d-a1e2-9b8c7d6e5f01', url: DOCS, title: 'Durable Objects 入门 · Example Docs', revision, spans });
    const visit2 = (revision: number) =>
      visit({ id: 'a4b5c6d7-8e9f-4a0b-b1c2-d3e4f5a6b702', url: NEWS, title: '用 FTS5 做中文搜索 | Example News', revision, spans: [[at('2026-10-10T02:04:02Z'), at('2026-10-10T02:04:10Z')]] });
    const doc = await document({
      id: '7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01',
      visitId: '1f3e8a27-6c4b-4f0d-a1e2-9b8c7d6e5f01',
      url: DOCS,
      title: 'Durable Objects 入门 · Example Docs',
      description: '一篇合成的示例文档：Durable Object、SQLite 存储与 alarm。',
      captureMs: at('2026-10-10T02:00:15.250Z'),
      text: FIXTURE_TEXT,
    });
    const spans: [number, number][] = [
      [at('2026-10-10T02:00:05Z'), at('2026-10-10T02:02:10Z')],
      [at('2026-10-10T02:02:30Z'), at('2026-10-10T02:03:41Z')],
    ];
    expect((await ok(await h.upload(batch([await visit1(1, spans.slice(0, 1))], { device })))).accepted_count).toBe(1);
    expect((await ok(await h.upload(batch([await visit1(2, spans), doc], { device })))).accepted_count).toBe(2);
    expect((await ok(await h.upload(batch([await visit2(1)], { device })))).accepted_count).toBe(1);
    expect((await ok(await h.upload(batch([await visit2(2)], { device })))).accepted_count).toBe(1);

    const answer = await feed(h);
    const expected = JSON.parse(readFileSync(fileURLToPath(new URL('ChangePage/first-page.json', FIXTURES).href), 'utf8')) as ChangePage;
    // The feed's identity and the gzip bytes of the text are this store's; everything else is the fixture's.
    const blob = answer.changes[1]?.blobs[0];
    expect(blob).toBeDefined();
    const patched = {
      ...expected,
      feed_id: answer.feed_id,
      changes: expected.changes.map((change) => (change.kind === 'document' ? { ...change, blobs: change.blobs.map((b) => ({ ...b, sha256: blob?.sha256, size_bytes: blob?.size_bytes })) } : change)),
    };
    expect(answer).toEqual(patched);
    expect(answer.feed_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // The blob route answers the stored bytes, gzip without Content-Encoding, with their digest.
    const response = await h.blob(blob?.path ?? '');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(blob?.size_bytes);
    expect(sha256(bytes)).toBe(blob?.sha256);
    expect(response.headers.get('content-digest')).toBe(`sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`);
    expect(new TextDecoder().decode(gunzipSync(bytes))).toBe(FIXTURE_TEXT);

    // The owner sees the page, its visits and its text.
    const { pageId } = await page(DOCS);
    const shown = await h.api.getPage({ name: `pages/${pageId}` });
    expect(shown).toMatchObject({ url: DOCS, site: 'docs.example.com', visitCount: 1, focusSeconds: 196, documentCount: 1, textIndexed: true });
    const textShown = await h.api.getDocument({ name: shown.latestDocument });
    expect(textShown).toMatchObject({ text: FIXTURE_TEXT, textBytes: 181, deviceLabel: 'MacBook · 工作', searchTruncated: false });
    expect((await h.api.getSite({ name: 'sites/docs.example.com' })).focusSeconds).toBe(196);
  });

  it('a caught-up consumer gets an empty page at the head', async () => {
    const answer = await feed(h, '?after=5&consumer=nas');
    expect(answer.changes).toEqual([]);
    expect(answer).toMatchObject({ last_seq: 5, head_seq: 5, oldest_seq: 1 });
  });

  it('retries change nothing: the same batch, an older revision, a replayed document, the same text again', async () => {
    const before = await feed(h);
    const docsVisit = await visit({ id: '1f3e8a27-6c4b-4f0d-a1e2-9b8c7d6e5f01', url: DOCS, title: 'older', revision: 1, spans: [[at('2026-10-10T02:00:05Z'), at('2026-10-10T02:00:10Z')]] });
    const replay = await document({ id: '7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01', visitId: '1f3e8a27-6c4b-4f0d-a1e2-9b8c7d6e5f01', url: DOCS, captureMs: at('2026-10-10T02:00:15.250Z'), text: FIXTURE_TEXT });
    const sameTextNextDay = await document({ id: uuid(2, 2), visitId: '1f3e8a27-6c4b-4f0d-a1e2-9b8c7d6e5f01', url: DOCS, captureMs: at('2026-10-10T02:00:15.250Z') + DAY, text: FIXTURE_TEXT });
    await h.clock(T0 + 2 * DAY);
    const answer = await ok(await h.upload(batch([docsVisit, replay, sameTextNextDay], { sentMs: T0 + 2 * DAY })));
    expect(answer).toMatchObject({ accepted_count: 3, rejected: [] });
    expect(await feed(h)).toEqual(before);
  });

  it('keeps changed captures of a page in the same day, and refuses a known document ID with other content', async () => {
    const day = at('2026-10-12T08:00:00Z');
    await h.clock(day);
    const first = await document({ id: uuid(3, 2), visitId: uuid(1), url: DOCS, captureMs: day, text: '新的一天，新的正文。' });
    const second = await document({ id: uuid(4, 2), visitId: uuid(1), url: DOCS, captureMs: day + 3 * 60 * MINUTE, text: '同一天的另一份正文。' });
    expect(await ok(await h.upload(batch([first, second], { sentMs: day + 4 * 60 * MINUTE })))).toMatchObject({ accepted_count: 2, rejected: [] });
    const conflict = await document({ id: uuid(3, 2), visitId: uuid(1), url: DOCS, captureMs: day, text: '同一个 ID，别的内容。' });
    expect(await ok(await h.upload(batch([conflict], { sentMs: day + 4 * 60 * MINUTE })))).toMatchObject({ accepted_count: 0, rejected: [{ id: uuid(3, 2), reason: 'id_conflict' }] });
    const documents = await h.sql<{ id: string }>(`SELECT id FROM documents ORDER BY seq`);
    expect(documents.map((row) => row.id)).toEqual(['7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01', uuid(3, 2), uuid(4, 2)]);
    const { pageId } = await page(DOCS);
    expect((await h.api.getPage({ name: `pages/${pageId}` })).documentCount).toBe(3);
  });

  it('leaves no object behind for a text its transaction did not keep', async () => {
    // Two captures of a new page with the same text on two UTC days, in one batch: both pass the check before their R2
    // puts, the transaction keeps the first, and the second's object is deleted again.
    const url = 'https://wiki.example.net/fts5-bigrams';
    const day = at('2026-10-13T08:00:00Z');
    await h.clock(day + DAY);
    const same = '二元分词的同一份正文。';
    const first = await document({ id: uuid(5, 2), visitId: uuid(1), url, captureMs: day, text: same });
    const second = await document({ id: uuid(6, 2), visitId: uuid(1), url, captureMs: day + DAY, text: same });
    expect(await ok(await h.upload(batch([first, second], { sentMs: day + DAY })))).toMatchObject({ accepted_count: 2, rejected: [] });
    const kept = await h.sql<{ id: string }>(`SELECT id FROM documents WHERE id IN (?, ?)`, uuid(5, 2), uuid(6, 2));
    expect(kept.map((row) => row.id)).toEqual([uuid(5, 2)]);
    const bucket = await h.r2();
    expect(await bucket.head(`blobs/2026/10/${uuid(5, 2)}.txt.gz`)).not.toBeNull();
    expect(await bucket.head(`blobs/2026/10/${uuid(6, 2)}.txt.gz`)).toBeNull();
  });
});

describe("the server's own scrub and denylist for an older build's upload", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('scrubs URLs, titles and texts again, and cuts what is too long', async () => {
    const secret = ['gh', 'p_', 'AbCdEfGhJkMnPqRsTuVwXyZ0123456789AbCd'].join('');
    const url = `https://app.example.com/callback?code=abc123&state=xyz&page=2`;
    const items = [
      await visit({ id: uuid(1), url, title: `Token ${secret} 页面`, spans: [[T0 - 5 * MINUTE, T0 - 4 * MINUTE]] }),
      await document({ id: uuid(2), visitId: uuid(1), url, title: 't'.repeat(1500), captureMs: T0 - 4 * MINUTE, text: `正文 password: Synthetic-Pa55word ${secret} ${'长'.repeat(30_000)}` }),
    ];
    expect(await ok(await h.upload(batch(items)))).toMatchObject({ accepted_count: 2, rejected: [] });
    const { pageId } = await page(url);
    const shown = await h.api.getPage({ name: `pages/${pageId}` });
    expect(shown.url).toBe('https://app.example.com/callback?code=[redacted]&state=[redacted]&page=2');
    expect(shown.title).toBe('Token [redacted] 页面');
    const textShown = await h.api.getDocument({ name: shown.latestDocument });
    expect(textShown.text).not.toContain(secret);
    expect(textShown.text).toContain('password: [redacted]');
    expect(textShown.textBytes).toBeLessThanOrEqual(65_536);
    expect(textShown.textTruncated).toBe(true);
    expect(textShown.searchTruncated).toBe(true);
    expect(Array.from(textShown.title)).toHaveLength(1000);
  });

  it("records a sensitive site by its root alone (a new page ID), drops recall's own pages and a no-text page's text", async () => {
    const mail = 'https://mail.google.com/mail/u/0/#inbox/FMfcgzQSynthetic';
    const items = [
      await visit({ id: uuid(3), url: mail, title: '收件箱 (3) - 主题很私密', spans: [[T0 - 3 * MINUTE, T0 - 2 * MINUTE]] }),
      await document({ id: uuid(4), visitId: uuid(3), url: mail, captureMs: T0 - 2 * MINUTE, text: '私密邮件正文' }),
      await visit({ id: uuid(5), url: 'https://recall.example.com/search?q=secret', title: '搜索', spans: [[T0 - 3 * MINUTE, T0 - 2 * MINUTE]] }),
      await visit({ id: uuid(6), url: 'https://shop.example.com/account/login', title: '登录', spans: [[T0 - 3 * MINUTE, T0 - 2 * MINUTE]] }),
      await document({ id: uuid(7), visitId: uuid(6), url: 'https://shop.example.com/account/login', captureMs: T0 - 2 * MINUTE, text: '登录页的正文' }),
    ];
    expect(await ok(await h.upload(batch(items)))).toMatchObject({ accepted_count: 5, rejected: [] });
    const root = await page('https://mail.google.com/');
    const mailPage = await h.api.getPage({ name: `pages/${root.pageId}` });
    expect(mailPage).toMatchObject({ url: 'https://mail.google.com/', title: '', site: 'mail.google.com', visitCount: 1, documentCount: 0 });
    expect((await h.sql<{ n: number }>(`SELECT count(*) AS n FROM pages WHERE url LIKE '%recall.example.com%'`))[0]?.n).toBe(0);
    const login = await page('https://shop.example.com/account/login');
    expect(await h.api.getPage({ name: `pages/${login.pageId}` })).toMatchObject({ title: '登录', documentCount: 0 });
    expect((await h.sql<{ n: number }>(`SELECT count(*) AS n FROM documents`))[0]?.n).toBe(1);
  });

  it("applies the owner's new pattern to the next upload at once, and hands the list back", async () => {
    const updated = await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', denylistPatterns: ['Example.NET/private/'] }), updateMask: { paths: ['denylist_patterns'] }, requestId: op() });
    expect(updated.denylistPatterns).toEqual(['example.net/private']);
    const url = 'https://notes.example.net/private/diary';
    const answer = await ok(await h.upload(batch([await document({ id: uuid(8), visitId: uuid(9), url, captureMs: T0 - MINUTE, text: '日记' })])));
    expect(answer).toMatchObject({ accepted_count: 1, denylist_patterns: ['example.net/private'], denylist_etag: updated.etag });
    expect((await h.sql<{ n: number }>(`SELECT count(*) AS n FROM documents WHERE id = ?`, uuid(8)))[0]?.n).toBe(0);
  });
});

describe('refusals', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('refuses an item that breaks a rule alone, keeps the others, and counts the refusals by reason', async () => {
    const good = await visit({ id: uuid(1), url: 'https://example.com/a', spans: [[T0 - 2 * MINUTE, T0 - MINUTE]] });
    // A host with an underscore is a host (the archive's Site format allows it).
    const underscore = await visit({ id: uuid(11), url: 'https://my_team.example.com/wiki/a', spans: [[T0 - 2 * MINUTE, T0 - MINUTE]] });
    const bad = [
      await visit({ id: uuid(2), url: 'ftp://example.com/x', rawUrl: true, spans: [[T0 - 2 * MINUTE, T0 - MINUTE]] }),
      await visit({ id: uuid(3), url: 'https://example.com/b', spans: [[T0 - 2 * MINUTE, T0 - MINUTE], [T0 - 90 * 1000, T0]] }),
      await visit({ id: uuid(4), url: 'https://example.com/c', spans: [[T0, T0 + 2 * MINUTE]] }),
      await visit({ id: uuid(5), url: 'https://example.com/d', spans: [[T0 - 7 * 60 * MINUTE, T0 - MINUTE]] }),
      await visit({ id: uuid(6), url: 'https://example.com/e', spans: [[T0 - 400, T0]] }),
      await visit({ id: uuid(7), url: 'https://exa!mple.com/f', rawUrl: true, pageId: 'a'.repeat(32), spans: [[T0 - 2 * MINUTE, T0 - MINUTE]] }),
      { kind: 'visit', visit: { id: uuid(8), revision: 1 } },
      { kind: 'note', visit: {} },
      'not an object',
    ];
    // A newer extension's items: an optional field and a kind this build does not know. They wait in its outbox.
    const newer = await visit({ id: uuid(9), url: 'https://example.com/g', spans: [[T0 - 2 * MINUTE, T0 - MINUTE]] });
    const withField = { ...(newer as { kind: string; visit: object }), visit: { ...(newer as { visit: object }).visit, scroll_depth: 0.5 } };
    const star = { kind: 'star', star: { id: uuid(10), note: 'synthetic' } };
    const answer = await ok(await h.upload(batch([good, underscore, ...bad, withField, star])));
    expect(answer.accepted_count).toBe(2);
    expect(answer.rejected).toEqual([
      { id: uuid(2), reason: 'invalid_item' },
      { id: uuid(3), reason: 'invalid_item' },
      { id: uuid(4), reason: 'invalid_item' },
      { id: uuid(5), reason: 'invalid_item' },
      { id: uuid(6), reason: 'invalid_item' },
      { id: uuid(7), reason: 'invalid_item' },
      { id: uuid(8), reason: 'invalid_item' },
      { id: '', reason: 'invalid_item' },
      { id: '', reason: 'invalid_item' },
      { id: uuid(9), reason: 'unsupported_item' },
      { id: uuid(10), reason: 'unsupported_item' },
    ]);
    expect((await h.api.listSites({})).sites.map((site) => site.name)).toContain('sites/my_team.example.com');
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.rejectedItems).toEqual([expect.objectContaining({ reason: 'invalid_item', count: 9 }), expect.objectContaining({ reason: 'unsupported_item', count: 2 })]);
    expect(status.devices).toEqual([expect.objectContaining({ deviceId: '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', label: 'MacBook · 工作', stale: false })]);
  });

  it('refuses a whole batch that is not gzip, not JSON, of another version, too long, or too large', async () => {
    const statuses: Record<string, [number, string | undefined]> = {};
    const record = async (name: string, response: Response) => {
      statuses[name] = [response.status, await machineReason(response)];
    };
    await record('not gzip', await h.upload(new TextEncoder().encode('{"version":"recall-ingest-v1"}')));
    await record('not json', await h.upload(new Uint8Array(gzipSync('not json'))));
    await record('version', await h.upload({ ...(batch([]) as object), version: 'recall-ingest-v2' }));
    await record('51 items', await h.upload(batch(Array.from({ length: 51 }, () => ({})))));
    await record('label', await h.upload(batch([], { device: { label: '' } })));
    await record('chrome version', await h.upload(batch([], { device: { extension_version: '2026.70000.1' } })));
    await record('content type', await h.upload(batch([]), { contentType: 'application/json' }));
    await record('4 MiB', await h.upload({ ...(batch([]) as object), padding: 'x'.repeat(5 * 1024 * 1024) }));
    expect(statuses).toEqual({
      'not gzip': [400, 'BAD_REQUEST'],
      'not json': [400, 'BAD_REQUEST'],
      version: [400, 'BAD_REQUEST'],
      '51 items': [400, 'BAD_REQUEST'],
      label: [400, 'BAD_REQUEST'],
      'chrome version': [400, 'BAD_REQUEST'],
      'content type': [400, 'BAD_REQUEST'],
      '4 MiB': [413, 'PAYLOAD_TOO_LARGE'],
    });
  });

  it('answers 429 past the daily write budget, until the next UTC day; the owner still writes', async () => {
    await h.sql(`INSERT INTO usage (day, rows_written) VALUES (?, 20000) ON CONFLICT (day) DO UPDATE SET rows_written = 20000`, iso(T0).slice(0, 10));
    const response = await h.upload(batch([]));
    expect(response.status).toBe(429);
    expect(await machineReason(response)).toBe('UPLOAD_OVER_BUDGET');
    const retryAfter = Number(response.headers.get('retry-after'));
    const untilMidnight = (Date.parse(`${iso(T0 + DAY).slice(0, 10)}T00:00:00Z`) - T0) / 1000;
    expect(retryAfter).toBeGreaterThanOrEqual(untilMidnight);
    expect(retryAfter).toBeLessThanOrEqual(untilMidnight + 600);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.recentErrorCodes).toContain('upload_over_budget');
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', denylistPatterns: ['example.com'] }), updateMask: { paths: ['denylist_patterns'] }, requestId: op() });
    await h.clock(T0 + DAY);
    expect((await h.upload(batch([], { sentMs: T0 + DAY }))).status).toBe(200);
  });
});

describe('a crash between the R2 put and the commit', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('leaves an object no row names; the retry writes the same key and commits', async () => {
    const items = [
      await visit({ id: uuid(1), url: 'https://example.org/read', title: '读', spans: [[T0 - 5 * MINUTE, T0 - MINUTE]] }),
      await document({ id: uuid(2), visitId: uuid(1), url: 'https://example.org/read', captureMs: T0 - 4 * MINUTE, text: text(2000) }),
    ];
    await h.failNextCommit();
    const crashed = await h.upload(batch(items));
    expect(crashed.status).toBe(500);
    const bucket = await h.r2();
    const key = `blobs/2026/10/${uuid(2)}.txt.gz`;
    expect(await bucket.head(key)).not.toBeNull();
    expect(await h.sql(`SELECT id FROM documents`)).toEqual([]);
    expect((await feed(h)).changes).toEqual([]);

    expect(await ok(await h.upload(batch(items)))).toMatchObject({ accepted_count: 2, rejected: [] });
    const changes = (await feed(h)).changes;
    expect(changes.map((change) => change.kind)).toEqual(['visit', 'document']);
    const stored = await h.blob(`2026/10/${uuid(2)}.txt.gz`);
    expect(sha256(new Uint8Array(await stored.arrayBuffer()))).toBe(changes[1]?.blobs[0]?.sha256);
  });
});
