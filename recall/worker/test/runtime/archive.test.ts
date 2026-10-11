// The archive pushed to the owner's Dropbox (../../../docs/design.md §7.2, contracts/recall-archive-v1 §3) in workerd,
// against a fake Dropbox (fake-dropbox.ts): the connection (OAuth 2 with PKCE and the App key alone, the state used
// once, the refresh token never answered); the first pass writes exactly the contract's golden archive; a pass with
// nothing new makes no call; later changes write their day and state.json only, each blob once; a deletion adds its
// tombstone line and deletes nothing at Dropbox; passes stay within their subrequests; 429, Retry-After and backoff;
// a refreshed access token, a refused refresh token; disconnecting, connecting the same app again and another one; a
// folder holding another feed's archive; the status and ops-v1.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARCHIVE_SUBREQUESTS } from '../../src/limits.ts';
import { batch, document, page, uuid, visit } from './data.ts';
import { FakeDropbox } from './fake-dropbox.ts';
import { DAY, HOUR, MINUTE, op, reasonOf, rejection, SECOND, sha256, startHarness, type Harness } from './harness.ts';

const FIXTURES = new URL('../../../../contracts/recall-archive-v1/fixtures/', import.meta.url);
const fixture = (path: string) => readFileSync(fileURLToPath(new URL(path, FIXTURES).href));
const at = (iso: string) => Date.parse(iso);
const FEED = '0b6f3c1e-7d2a-4e5b-9c8d-1a2b3c4d5e6f';
const DEVICE = ['5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', 'MacBook · 工作'] as const;
/** The endpoints recall may call; anything else (a delete, a move) must never be called. */
const ALLOWED = new Set(['/oauth2/token', '/2/users/get_current_account', '/2/auth/token/revoke', '/2/files/upload', '/2/files/download']);

/** A harness whose outbound requests reach `dropbox()` (switchable between fakes). */
async function harness(dropbox: () => FakeDropbox): Promise<Harness> {
  return startHarness({ outbound: (request) => dropbox().handle(request) });
}

/** Connects through the owner API and the callback, as the browser does: the outcome the callback redirected to. */
async function connect(h: Harness, dropbox: FakeDropbox): Promise<string> {
  const { authorizeUrl } = await h.api.connectDropboxBackup({ name: 'dropboxBackup', appKey: dropbox.appKey, requestId: op() });
  const { query } = dropbox.approve(authorizeUrl);
  const answer = await h.fetch(`/api/dropbox/callback${query}`);
  expect(answer.status).toBe(303);
  return answer.headers.get('location') ?? '';
}

/** The records of fixtures/ChangePage/first-page.json and its blob, as RecallState and R2 hold them. */
async function seedFixture(h: Harness): Promise<void> {
  await h.sql(`UPDATE meta SET value = ? WHERE key = 'feed_id'`, FEED);
  await h.sql(`UPDATE meta SET value = '5' WHERE key = 'seq'`);
  await h.sql(`INSERT INTO pages (id, url, host_key, first_visit_ms, last_visit_ms) VALUES ('3cb732b26093d5571ec48a363db593b2', 'https://docs.example.com/guide/durable-objects', 'com.example.docs.', 0, 0)`);
  await h.sql(`INSERT INTO pages (id, url, host_key, first_visit_ms, last_visit_ms) VALUES ('f9735ed632fb5291d9bc44726777dbd8', 'https://news.example.org/2026/10/sqlite-fts5-chinese', 'org.example.news.', 0, 0)`);
  const visitRow = `INSERT INTO visits (id, seq, seq_ms, page_rowid, device_id, device_label, url, title, start_ms, end_ms, focus_seconds, spans, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;
  await h.sql(visitRow, '1f3e8a27-6c4b-4f0d-a1e2-9b8c7d6e5f01', 2, at('2026-10-10T02:05:00Z'), 1, ...DEVICE, 'https://docs.example.com/guide/durable-objects', 'Durable Objects 入门 · Example Docs',
    at('2026-10-10T02:00:05Z'), at('2026-10-10T02:03:41Z'), 196,
    JSON.stringify([[at('2026-10-10T02:00:05Z'), at('2026-10-10T02:02:10Z')], [at('2026-10-10T02:02:30Z'), at('2026-10-10T02:03:41Z')]]));
  await h.sql(visitRow, 'a4b5c6d7-8e9f-4a0b-b1c2-d3e4f5a6b702', 5, at('2026-10-10T02:06:00Z'), 2, ...DEVICE, 'https://news.example.org/2026/10/sqlite-fts5-chinese', '用 FTS5 做中文搜索 | Example News',
    at('2026-10-10T02:04:02Z'), at('2026-10-10T02:04:10Z'), 8, JSON.stringify([[at('2026-10-10T02:04:02Z'), at('2026-10-10T02:04:10Z')]]));
  await h.sql(
    `INSERT INTO documents (id, seq, seq_ms, page_rowid, visit, device_id, device_label, capture_ms, url, title, description, blob_path, sha256, stored_bytes, text_bytes, text_sha256)
     VALUES (?, 3, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 185, 181, 'unused')`,
    '7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01', at('2026-10-10T02:05:00Z'), '1f3e8a27-6c4b-4f0d-a1e2-9b8c7d6e5f01', ...DEVICE, at('2026-10-10T02:00:15.250Z'),
    'https://docs.example.com/guide/durable-objects', 'Durable Objects 入门 · Example Docs', '一篇合成的示例文档：Durable Object、SQLite 存储与 alarm。',
    '2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz', '6439c89dc81886b6bd18e091105aeb31cb92aca181cefedc4d0068fba0b09bf5',
  );
  await (await h.r2()).put('blobs/2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz', fixture('archive/blobs/2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz'));
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const uploads = (dropbox: FakeDropbox) => dropbox.callsTo('/2/files/upload').map((call) => call.path);

describe('connecting Dropbox', () => {
  const dropbox = new FakeDropbox();
  let h: Harness;
  beforeAll(async () => {
    h = await harness(() => dropbox);
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('refuses an App key that is not one', async () => {
    expect(reasonOf(await rejection(h.api.connectDropboxBackup({ name: 'dropboxBackup', appKey: 'App Secret!', requestId: op() })))).toBe('INVALID_APP_KEY');
    expect((await h.fetch('/api/v1/dropboxBackup:connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"app_key":"syntheticappkey1"}' })).status).toBe(403);
  });

  it('asks Dropbox for a code with PKCE and the App key alone, and keeps only the refresh token', async () => {
    const { authorizeUrl } = await h.api.connectDropboxBackup({ name: 'dropboxBackup', appKey: dropbox.appKey, requestId: op() });
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe(dropbox.appKey);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('token_access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toBe('https://recall.example.com/api/dropbox/callback');
    const state = url.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Before the owner approves, the status says nothing is connected.
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).dropboxBackup).toMatchObject({ connected: false, appKey: '' });
    const { query } = dropbox.approve(authorizeUrl);
    const back = await h.fetch(`/api/dropbox/callback${query}`);
    expect([back.status, back.headers.get('location')]).toEqual([303, '/settings?dropbox=connected']);
    const backup = (await h.api.getServiceStatus({ name: 'serviceStatus' })).dropboxBackup;
    expect(backup).toMatchObject({ connected: true, appKey: dropbox.appKey, accountDisplayName: '合成 Dropbox', errorCode: '' });
    expect(backup?.connectTime).toBeDefined();
    const refresh = (await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'dropbox_refresh_token'`))[0]?.value ?? '';
    expect(refresh).toMatch(/^synthetic-refresh-/);
    expect(await (await h.fetch('/api/v1/serviceStatus')).text()).not.toContain(refresh);
    expect(h.logs.join('\n')).not.toContain(refresh);
    expect(h.logs.join('\n')).not.toContain(state);
    // The state works once.
    expect((await h.fetch(`/api/dropbox/callback${query}`)).headers.get('location')).toBe('/settings?dropbox=expired');
  });

  it('refuses a callback of another state, says when the owner declined, and only answers GET', async () => {
    const { authorizeUrl } = await h.api.connectDropboxBackup({ name: 'dropboxBackup', appKey: dropbox.appKey, requestId: op() });
    const { query } = dropbox.approve(authorizeUrl);
    const forged = query.replace(/state=[^&]+/, `state=${'A'.repeat(43)}`);
    expect((await h.fetch(`/api/dropbox/callback${forged}`)).headers.get('location')).toBe('/settings?dropbox=expired');
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    expect((await h.fetch(`/api/dropbox/callback?error=access_denied&state=${state}`)).headers.get('location')).toBe('/settings?dropbox=denied');
    expect((await h.fetch('/api/dropbox/callback', { method: 'POST' })).status).toBe(405);
    // A connection not finished within 15 minutes expires.
    const late = await h.api.connectDropboxBackup({ name: 'dropboxBackup', appKey: dropbox.appKey, requestId: op() });
    const lateQuery = dropbox.approve(late.authorizeUrl).query;
    await h.clock(Date.now() + 16 * MINUTE);
    expect((await h.fetch(`/api/dropbox/callback${lateQuery}`)).headers.get('location')).toBe('/settings?dropbox=expired');
  });
});

describe('the archive in Dropbox', () => {
  const dropbox = new FakeDropbox();
  let h: Harness;
  beforeAll(async () => {
    h = await harness(() => dropbox);
    await seedFixture(h);
    await h.clock(at('2026-10-10T02:10:00Z'));
    expect(await connect(h, dropbox)).toBe('/settings?dropbox=connected');
  });
  afterAll(async () => {
    await h.dispose();
  });

  it("writes exactly the contract's golden archive on the first pass", async () => {
    dropbox.calls.length = 0;
    expect(await h.step(at('2026-10-10T02:15:07Z'))).toMatchObject({ archive: 'done', code: 'ok' });
    expect([...dropbox.files.keys()].sort()).toEqual(['/VERSION', '/blobs/2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz', '/changes/2026/10/10.jsonl', '/state.json']);
    expect(text(dropbox.files.get('/VERSION'))).toBe(text(fixture('archive/VERSION')));
    expect(text(dropbox.files.get('/state.json'))).toBe(text(fixture('archive/state.json')));
    expect(text(dropbox.files.get('/changes/2026/10/10.jsonl'))).toBe(text(fixture('archive/changes/2026/10/10.jsonl')));
    expect([...(dropbox.files.get('/blobs/2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz') ?? [])]).toEqual([...fixture('archive/blobs/2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz')]);
    // The folder was looked at first (no other feed's archive), the blob added before its line, state.json last.
    expect(dropbox.calls.map((call) => [call.endpoint, call.path, call.mode])).toEqual([
      ['/2/files/download', '/state.json', undefined],
      ['/2/files/upload', '/VERSION', 'overwrite'],
      ['/2/files/upload', '/blobs/2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz', 'add'],
      ['/2/files/upload', '/changes/2026/10/10.jsonl', 'overwrite'],
      ['/2/files/upload', '/state.json', 'overwrite'],
    ]);
    const backup = (await h.api.getServiceStatus({ name: 'serviceStatus' })).dropboxBackup;
    expect(backup).toMatchObject({ syncedSeq: 5, pendingCount: 0, errorCode: '' });
    expect(backup?.oldestPendingTime).toBeUndefined();
    expect(backup?.lastUploadTime).toEqual({ $typeName: 'google.protobuf.Timestamp', seconds: BigInt(at('2026-10-10T02:15:07Z') / 1000), nanos: 0 });
  });

  it('makes no call when nothing changed', async () => {
    dropbox.calls.length = 0;
    expect(await h.step(at('2026-10-10T03:15:00Z'))).toMatchObject({ archive: 'done' });
    expect(dropbox.calls).toEqual([]);
  });

  it("writes a later day's changes, each blob once, and state.json; earlier days stay as they are", async () => {
    const day = at('2026-10-11T09:00:00Z');
    await h.clock(day);
    const url = 'https://notes.example.net/fts5';
    const items = [
      await visit({ id: uuid(11), url, title: '笔记', spans: [[day - 10 * MINUTE, day - 5 * MINUTE]] }),
      await document({ id: uuid(12), visitId: uuid(11), url, captureMs: day - 9 * MINUTE, text: '第二天读到的合成正文' }),
    ];
    expect((await h.upload(batch(items, { sentMs: day }))).status).toBe(200);
    dropbox.calls.length = 0;
    expect(await h.step(day + HOUR)).toMatchObject({ archive: 'done' });
    expect(uploads(dropbox)).toEqual([`/blobs/2026/10/${uuid(12)}.txt.gz`, '/changes/2026/10/11.jsonl', '/state.json']);
    const lines = text(dropbox.files.get('/changes/2026/10/11.jsonl')).trimEnd().split('\n').map((line) => JSON.parse(line) as { seq: number; id: string });
    expect(lines.map((line) => [line.seq, line.id])).toEqual([
      [6, `visits/${uuid(11)}`],
      [7, `documents/${uuid(12)}`],
    ]);
    expect(JSON.parse(text(dropbox.files.get('/state.json')))).toMatchObject({ consumer: 'dropbox', synced_seq: 7, source: 'https://recall.example.com' });
    // A revision of the visit: today's file again, with the record at its new seq.
    expect((await h.upload(batch([await visit({ id: uuid(11), url, title: '笔记', revision: 2, spans: [[day - 10 * MINUTE, day - 2 * MINUTE]] })], { sentMs: day + 2 * HOUR }))).status).toBe(200);
    dropbox.calls.length = 0;
    expect(await h.step(day + 3 * HOUR)).toMatchObject({ archive: 'done' });
    expect(uploads(dropbox)).toEqual(['/changes/2026/10/11.jsonl', '/state.json']);
  });

  it('adds a tombstone line for a deleted page and deletes nothing at Dropbox', async () => {
    const before = text(dropbox.files.get('/changes/2026/10/10.jsonl'));
    const { pageId } = await page('https://docs.example.com/guide/durable-objects');
    expect(pageId).toBe('3cb732b26093d5571ec48a363db593b2');
    await h.clock(at('2026-10-11T13:00:00Z'));
    await h.api.deletePage({ name: `pages/${pageId}`, requestId: op() });
    dropbox.calls.length = 0;
    expect(await h.step(at('2026-10-11T13:00:01Z'))).toMatchObject({ archive: 'done' });
    expect(uploads(dropbox)).toEqual(['/changes/2026/10/11.jsonl', '/state.json']);
    const last = text(dropbox.files.get('/changes/2026/10/11.jsonl')).trimEnd().split('\n').at(-1) ?? '';
    expect(JSON.parse(last)).toMatchObject({ kind: 'tombstone', tombstone: { target: `pages/${pageId}` } });
    // The earlier day's lines and the blob stay: the archive only grows.
    expect(text(dropbox.files.get('/changes/2026/10/10.jsonl'))).toBe(before);
    expect(dropbox.files.has('/blobs/2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz')).toBe(true);
    expect(dropbox.calls.every((call) => ALLOWED.has(call.endpoint))).toBe(true);
  });
});

describe('a large first upload', () => {
  const dropbox = new FakeDropbox();
  let h: Harness;
  const DAYS = 90;
  const TEXTS = 40;
  const start = at('2026-06-01T12:00:00Z');
  beforeAll(async () => {
    h = await harness(() => dropbox);
    await h.sql(`INSERT INTO pages (id, url, host_key, first_visit_ms, last_visit_ms) VALUES (?, 'https://example.com/a', 'com.example.', 0, 0)`, 'a'.repeat(32));
    // A visit a day for 90 days, and 40 texts with their blobs in R2.
    for (let i = 0; i < DAYS; i++) {
      await h.sql(
        `INSERT INTO visits (id, seq, seq_ms, page_rowid, device_id, device_label, url, title, start_ms, end_ms, focus_seconds, spans, revision) VALUES (?, ?, ?, 1, ?, ?, 'https://example.com/a', 'A', ?, ?, 5, '[]', 1)`,
        uuid(i + 1, 1), i * 2 + 1, start + i * DAY, ...DEVICE, start + i * DAY, start + i * DAY + 5 * SECOND,
      );
    }
    const bucket = await h.r2();
    for (let i = 0; i < TEXTS; i++) {
      const bytes = gzipSync(`合成正文 ${String(i)}`);
      const path = `2026/06/${uuid(i + 1, 2)}.txt.gz`;
      await bucket.put(`blobs/${path}`, bytes);
      await h.sql(
        `INSERT INTO documents (id, seq, seq_ms, page_rowid, visit, device_id, device_label, capture_ms, url, title, description, blob_path, sha256, stored_bytes, text_bytes, text_sha256)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'https://example.com/a', 'A', '', ?, ?, ?, 20, 'unused')`,
        uuid(i + 1, 2), i * 2 + 2, start + i * DAY, uuid(i + 1, 1), ...DEVICE, start + i * DAY, path, sha256(bytes), bytes.byteLength,
      );
    }
    await h.sql(`UPDATE meta SET value = ? WHERE key = 'seq'`, String(DAYS * 2));
    await h.clock(start + DAYS * DAY);
    await connect(h, dropbox);
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('writes it in passes of at most the subrequests a pass may make, each file once, newest day first', async () => {
    let passes = 0;
    let result;
    do {
      const before = dropbox.calls.length;
      result = await h.step(start + DAYS * DAY + passes * MINUTE);
      expect(dropbox.calls.length - before).toBeLessThanOrEqual(ARCHIVE_SUBREQUESTS);
      passes += 1;
    } while (result.archive === 'more' && passes < 50);
    expect(result.archive).toBe('done');
    expect(passes).toBeGreaterThan(2);
    const written = uploads(dropbox);
    expect(new Set(written).size).toBe(written.length);
    expect(written.filter((path) => path?.startsWith('/changes/'))).toHaveLength(DAYS);
    expect(written.filter((path) => path?.startsWith('/blobs/'))).toHaveLength(TEXTS);
    expect(written.find((path) => path?.startsWith('/changes/'))).toBe('/changes/2026/08/29.jsonl');
    expect(written.at(-1)).toBe('/state.json');
    expect(JSON.parse(text(dropbox.files.get('/state.json')))).toMatchObject({ synced_seq: DAYS * 2 });
  });
});

describe('Dropbox failing', () => {
  let dropbox = new FakeDropbox();
  let h: Harness;
  const t = at('2026-10-10T08:00:00Z');
  beforeAll(async () => {
    h = await harness(() => dropbox);
    await h.clock(t);
    await connect(h, dropbox);
    expect(await h.step(t)).toMatchObject({ archive: 'done' });
  });
  afterAll(async () => {
    await h.dispose();
  });

  async function change(now: number): Promise<void> {
    await h.clock(now);
    const id = uuid(Math.floor(now / 1000) % 100_000);
    expect((await h.upload(batch([await visit({ id, url: `https://example.com/${id}`, spans: [[now - 2 * MINUTE, now - MINUTE]] })], { sentMs: now }))).status).toBe(200);
  }

  it('waits as long as a 429 asks, says so, and goes on after', async () => {
    await change(t + HOUR);
    dropbox.failNext('/2/files/upload', () => new Response(JSON.stringify({ error_summary: 'too_many_requests/' }), { status: 429, headers: { 'retry-after': '120', 'content-type': 'application/json' } }));
    const failed = await h.step(t + 2 * HOUR);
    expect(failed).toMatchObject({ archive: 'retry', next: t + 2 * HOUR + 120 * SECOND });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).dropboxBackup).toMatchObject({ errorCode: 'dropbox_rate_limited', pendingCount: 1 });
    const calls = dropbox.calls.length;
    expect(await h.step(t + 2 * HOUR + MINUTE)).toMatchObject({ archive: 'retry' });
    expect(dropbox.calls.length).toBe(calls);
    expect(await h.step(t + 2 * HOUR + 121 * SECOND)).toMatchObject({ archive: 'done' });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).dropboxBackup).toMatchObject({ errorCode: '', pendingCount: 0 });
  });

  it("takes too_many_write_operations' retry_after, and doubles its own backoff after failures", async () => {
    await change(t + 3 * HOUR);
    const tooMany = () => new Response(JSON.stringify({ error_summary: 'too_many_write_operations/', error: { reason: { '.tag': 'too_many_write_operations' }, retry_after: 2 } }), { status: 429, headers: { 'content-type': 'application/json' } });
    dropbox.failNext('/2/files/upload', tooMany);
    expect(await h.step(t + 4 * HOUR)).toMatchObject({ archive: 'retry', next: t + 4 * HOUR + 2 * SECOND });
    dropbox.failNext('/2/files/upload', () => new Response('', { status: 503 }));
    // The second failure in a row: two minutes.
    expect(await h.step(t + 4 * HOUR + 2 * SECOND)).toMatchObject({ archive: 'retry', next: t + 4 * HOUR + 2 * SECOND + 2 * MINUTE });
    expect(await h.step(t + 4 * HOUR + 2 * SECOND + 2 * MINUTE)).toMatchObject({ archive: 'done' });
  });

  it('refreshes an access token Dropbox no longer takes, with the App key and the refresh token', async () => {
    await change(t + 5 * HOUR);
    dropbox.expireAccessTokens();
    expect(await h.step(t + 6 * HOUR)).toMatchObject({ archive: 'retry' });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).dropboxBackup?.errorCode).toBe('dropbox_token');
    const tokens = dropbox.callsTo('/oauth2/token').length;
    expect(await h.step(t + 6 * HOUR + MINUTE)).toMatchObject({ archive: 'done' });
    expect(dropbox.callsTo('/oauth2/token').length).toBe(tokens + 1);
  });

  it('disconnects when Dropbox refuses the refresh token, and raises archive_not_connected', async () => {
    await change(t + 7 * HOUR);
    dropbox.revokeEverything();
    expect(await h.step(t + 8 * HOUR)).toMatchObject({ archive: 'retry' });
    expect(await h.step(t + 8 * HOUR + MINUTE)).toMatchObject({ archive: 'idle' });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).dropboxBackup).toMatchObject({ connected: false, errorCode: 'dropbox_refused' });
    expect(((await h.opsStatus())['signals'] as { code: string }[]).map((s) => s.code)).toContain('archive_not_connected');
  });

  it('connects again, goes on where it stopped with the same app, and writes everything again to another', async () => {
    expect(await connect(h, dropbox)).toBe('/settings?dropbox=connected');
    const before = uploads(dropbox).length;
    expect(await h.step(t + 9 * HOUR)).toMatchObject({ archive: 'done' });
    // Only what changed since: the waiting change's day and state.json.
    expect(uploads(dropbox).slice(before)).toEqual(['/changes/2026/10/10.jsonl', '/state.json']);
    // DisconnectDropboxBackup revokes the token at Dropbox; the files stay.
    const backup = await h.api.disconnectDropboxBackup({ name: 'dropboxBackup', requestId: op() });
    expect(backup).toMatchObject({ connected: false, errorCode: '', appKey: dropbox.appKey });
    expect(dropbox.callsTo('/2/auth/token/revoke')).toHaveLength(1);
    expect(dropbox.files.size).toBeGreaterThan(0);
    // Another Dropbox (another account and app): the whole archive again.
    const old = dropbox;
    dropbox = new FakeDropbox('otherappkey2');
    expect(await connect(h, dropbox)).toBe('/settings?dropbox=connected');
    expect(await h.step(t + 10 * HOUR)).toMatchObject({ archive: 'done' });
    expect([...dropbox.files.keys()].sort()).toEqual([...old.files.keys()].sort());
    for (const fake of [old, dropbox]) expect(fake.calls.every((call) => ALLOWED.has(call.endpoint) || call.endpoint === '/oauth2/authorize')).toBe(true);
  });

  it("never writes into a folder that holds another feed's archive", async () => {
    await h.api.disconnectDropboxBackup({ name: 'dropboxBackup', requestId: op() });
    dropbox = new FakeDropbox('thirdappkey3');
    dropbox.files.set('/state.json', new TextEncoder().encode(JSON.stringify({ version: 'recall-archive-v1', feed_id: '11111111-2222-4333-8444-555555555555' })));
    await connect(h, dropbox);
    expect(await h.step(t + 11 * HOUR)).toMatchObject({ archive: 'retry' });
    expect(uploads(dropbox)).toEqual([]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).dropboxBackup).toMatchObject({ connected: true, errorCode: 'dropbox_other_feed' });
  });
});
