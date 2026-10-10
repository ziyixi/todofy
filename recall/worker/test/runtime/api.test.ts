// The Worker's surface in workerd (../../../docs/design.md §2.1, §8.1, §9): the machine routes' refusals answered by the
// Worker alone (never reaching the object), token rotation, the owner API's settings (mask, etag, AIP-155, the owner's
// two lists), names and errors, CSRF, the daily read budget, Access without the dev bypass (a machine token never
// reaches the owner API), and ops-v1's signals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { readDetail } from '@ziyixi/proto/rpc-status';
import { SettingsSchema } from '@ziyixi/proto/recall/ui/v1/status_pb';
import { DAILY_READ_BUDGET, FEED_READ_LIMIT } from '../../src/limits.ts';
import { accessClaims, testIssuer } from '../jwt.ts';
import { batch, document, page, uuid, visit } from './data.ts';
import {
  DAY,
  EXPORT_TOKEN,
  HOUR,
  INGEST_TOKEN,
  machineReason,
  MINUTE,
  op,
  ORIGIN,
  reasonOf,
  rejection,
  sha256,
  startHarness,
  SYNTHETIC_BINDINGS,
  T0,
  type Harness,
} from './harness.ts';

describe('the machine routes', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('answers every refusal in the Worker: 404, 405, 401, 413, 400, and never wakes the object', async () => {
    const refusals: Record<string, [number, string | undefined]> = {};
    const record = async (name: string, response: Response) => {
      refusals[name] = [response.status, name.startsWith('HEAD') ? 'METHOD_NOT_ALLOWED' : await machineReason(response)];
    };
    await record('unknown path', await h.fetch('/api/machine/v1/visits', { headers: { authorization: `Bearer ${INGEST_TOKEN}` } }));
    await record('v2', await h.fetch('/api/machine/v2/changes'));
    await record('GET batches', await h.fetch('/api/machine/v1/batches', { headers: { authorization: `Bearer ${INGEST_TOKEN}` } }));
    await record('POST changes', await h.fetch('/api/machine/v1/changes', { method: 'POST' }));
    await record('HEAD blob', await h.fetch('/api/machine/v1/blobs/2026/10/x', { method: 'HEAD' }));
    await record('no token', await h.upload(batch([]), { token: null }));
    await record('wrong token', await h.upload(batch([]), { token: `${INGEST_TOKEN}x` }));
    await record('export token on ingest', await h.upload(batch([]), { token: EXPORT_TOKEN }));
    await record('ingest token on changes', await h.changes('', INGEST_TOKEN));
    await record('ingest token on blobs', await h.blob(`2026/10/${uuid(1)}.txt.gz`, INGEST_TOKEN));
    await record('long token', await h.changes('', 'x'.repeat(300)));
    // A body over 1 MiB: refused by its Content-Length, or while it streams when it has none.
    await record('content-length', await h.upload(new Uint8Array(2 * 1024 * 1024)));
    const chunks = [new Uint8Array(512 * 1024), new Uint8Array(512 * 1024), new Uint8Array(1)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    });
    await record(
      'streamed body',
      await h.fetch('/api/machine/v1/batches', { method: 'POST', headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/gzip' }, body: stream, duplex: 'half' } as RequestInit),
    );
    await record('content type', await h.upload(batch([]), { contentType: 'text/plain' }));
    expect(refusals).toEqual({
      'unknown path': [404, 'NOT_FOUND'],
      v2: [404, 'NOT_FOUND'],
      'GET batches': [405, 'METHOD_NOT_ALLOWED'],
      'POST changes': [405, 'METHOD_NOT_ALLOWED'],
      'HEAD blob': [405, 'METHOD_NOT_ALLOWED'],
      'no token': [401, 'UNAUTHORIZED'],
      'wrong token': [401, 'UNAUTHORIZED'],
      'export token on ingest': [401, 'UNAUTHORIZED'],
      'ingest token on changes': [401, 'UNAUTHORIZED'],
      'ingest token on blobs': [401, 'UNAUTHORIZED'],
      'long token': [401, 'UNAUTHORIZED'],
      'content-length': [413, 'PAYLOAD_TOO_LARGE'],
      'streamed body': [413, 'PAYLOAD_TOO_LARGE'],
      'content type': [400, 'BAD_REQUEST'],
    });
    // The object never ran: no upload or feed line, no row read or written.
    expect(h.logs.filter((line) => line.includes('"event"'))).toEqual([]);
    expect(await h.rows()).toEqual({ read: 0, written: 0 });
    // The refusals' log lines hold the request ID, status and reason only.
    for (const line of h.logs) expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(['reason', 'request_id', 'status']);
    const allowed = await h.fetch('/api/machine/v1/batches');
    expect(allowed.headers.get('allow')).toBe('POST');
  });

  it("logs an upload by its batch ID and counts, never a URL, title or text", async () => {
    h.logs.length = 0;
    const url = 'https://private.example.com/very/secret/path';
    await h.upload(batch([await visit({ id: uuid(1), url, title: '机密标题', spans: [[T0 - 2 * MINUTE, T0 - MINUTE]] })], { batchId: uuid(77) }));
    const line = h.logs.find((entry) => entry.includes('"upload"')) ?? '';
    expect(JSON.parse(line)).toMatchObject({ event: 'upload', batch_id: uuid(77), accepted: 1, rejected: 0, code: 'ok' });
    for (const entry of h.logs) {
      expect(entry).not.toContain('private.example.com');
      expect(entry).not.toContain('机密');
    }
  });
});

describe('token configuration and rotation', () => {
  it('answers 503 NOT_CONFIGURED while a route has no digest, and accepts the current and the previous token', async () => {
    const unconfigured = await startHarness({ bindings: { INGEST_TOKEN_SHA256: undefined, EXPORT_TOKEN_SHA256: '' } });
    try {
      const upload = await unconfigured.upload(batch([]));
      expect([upload.status, await machineReason(upload)]).toEqual([503, 'NOT_CONFIGURED']);
      expect((await unconfigured.changes()).status).toBe(503);
    } finally {
      await unconfigured.dispose();
    }
    const next = `recall_ingest_${'N'.repeat(43)}`;
    const rotated = await startHarness({ bindings: { INGEST_TOKEN_SHA256: sha256(next), INGEST_TOKEN_SHA256_PREVIOUS: sha256(INGEST_TOKEN) } });
    try {
      expect((await rotated.upload(batch([]), { token: next })).status).toBe(200);
      expect((await rotated.upload(batch([]), { token: INGEST_TOKEN })).status).toBe(200);
      expect((await rotated.upload(batch([]), { token: `recall_ingest_${'O'.repeat(43)}` })).status).toBe(401);
    } finally {
      await rotated.dispose();
    }
  });
});

describe('the owner API', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    const url = 'https://docs.example.com/a';
    const response = await h.upload(
      batch([
        await visit({ id: uuid(1), url, title: '页面', spans: [[T0 - 3 * MINUTE, T0 - 2 * MINUTE]] }),
        await document({ id: uuid(2), visitId: uuid(1), url, captureMs: T0 - 2 * MINUTE, text: '正文' }),
      ]),
    );
    expect(response.status).toBe(200);
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('reads the settings with the built-in lists and replaces only the masked field, with the etag', async () => {
    const settings = await h.api.getSettings({ name: 'settings' });
    expect(settings.denylistPatterns).toEqual([]);
    expect(settings.builtinSiteOnlyPatterns).toContain('mail.google.com');
    expect(settings.builtinDenylistPatterns).toContain('ziyixi.science');
    const updated = await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', denylistPatterns: ['bank.example.com', 'example.org/private', 'bank.example.com'], etag: settings.etag }),
      updateMask: { paths: ['denylist_patterns', 'etag'] },
      requestId: op(),
    });
    expect(updated.denylistPatterns).toEqual(['bank.example.com', 'example.org/private']);
    expect(updated.etag).not.toBe(settings.etag);

    const stale = await rejection(
      h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', denylistPatterns: [], etag: settings.etag }), updateMask: { paths: ['denylist_patterns', 'etag'] }, requestId: op() }),
    );
    expect(reasonOf(stale)).toBe('ETAG_MISMATCH');
    expect(readDetail((stale as { status: Parameters<typeof readDetail>[0] }).status, SettingsSchema)?.denylistPatterns).toEqual(['bank.example.com', 'example.org/private']);

    for (const [patterns, reason] of [
      [['https://example.com'], 'INVALID_SETTINGS'],
      [['example.com?x=1'], 'INVALID_SETTINGS'],
      [Array.from({ length: 201 }, (_, i) => `site${String(i)}.example.com`), 'LIMIT_REACHED'],
    ] as const) {
      const error = await rejection(h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', denylistPatterns: [...patterns] }), updateMask: { paths: ['denylist_patterns'] }, requestId: op() }));
      expect(reasonOf(error)).toBe(reason);
    }
    // A mask is required, and names Settings fields only: otherwise nothing changes.
    expect(reasonOf(await rejection(h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', denylistPatterns: [] }), requestId: op() })))).toBe('BAD_REQUEST');
    const unknown = { settings: create(SettingsSchema, { name: 'settings', denylistPatterns: [] }), updateMask: { paths: ['denylist_patterns', 'denylist'] }, requestId: op() };
    expect(reasonOf(await rejection(h.api.updateSettings(unknown)))).toBe('BAD_REQUEST');
    expect((await h.api.getSettings({ name: 'settings' })).denylistPatterns).toEqual(['bank.example.com', 'example.org/private']);
  });

  it("keeps the owner's site-only list beside the no-text one, at most 200 together, and applies it to uploads", async () => {
    const current = await h.api.getSettings({ name: 'settings' });
    const updated = await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', siteOnlyPatterns: ['portal.bank.example', 'portal.bank.example'], etag: current.etag }),
      updateMask: { paths: ['site_only_patterns', 'etag'] },
      requestId: op(),
    });
    expect(updated.siteOnlyPatterns).toEqual(['portal.bank.example']);
    expect(updated.denylistPatterns).toEqual(current.denylistPatterns);
    const tooMany = Array.from({ length: 201 - current.denylistPatterns.length }, (_, i) => `site${String(i)}.example.com`);
    const error = await rejection(h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', siteOnlyPatterns: tooMany }), updateMask: { paths: ['site_only_patterns'] }, requestId: op() }));
    expect(reasonOf(error)).toBe('LIMIT_REACHED');
    // An upload's answer carries the list, and the server records a matching page by its site alone.
    const url = 'https://portal.bank.example/#/accounts/12345';
    const response = await h.upload(batch([await visit({ id: uuid(30), url, title: '账户 12345', spans: [[T0 - 3 * MINUTE, T0 - 2 * MINUTE]] })]));
    expect(await response.json()).toMatchObject({ accepted_count: 1, site_only_patterns: ['portal.bank.example'] });
    const visits = await h.sql<{ url: string; title: string }>(`SELECT url, title FROM visits WHERE id = ?`, uuid(30));
    expect(visits).toEqual([{ url: 'https://portal.bank.example/', title: '' }]);
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', siteOnlyPatterns: [] }), updateMask: { paths: ['site_only_patterns'] }, requestId: op() });
  });

  it('answers a repeated request ID with the first answer, and refuses it for another resource', async () => {
    const id = op();
    const first = await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', denylistPatterns: ['a.example.com'] }), updateMask: { paths: ['denylist_patterns'] }, requestId: id });
    const again = await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', denylistPatterns: ['b.example.com'] }), updateMask: { paths: ['denylist_patterns'] }, requestId: id });
    expect(again).toEqual(first);
    expect((await h.api.getSettings({ name: 'settings' })).denylistPatterns).toEqual(['a.example.com']);
    const { pageId } = await page('https://docs.example.com/a');
    expect(reasonOf(await rejection(h.api.deletePage({ name: `pages/${pageId}`, requestId: id })))).toBe('BAD_REQUEST');
  });

  it('checks names and answers NOT_FOUND for what does not exist', async () => {
    expect(reasonOf(await rejection(h.api.getPage({ name: 'pages/xyz' })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.getPage({ name: `pages/${'0'.repeat(32)}` })))).toBe('NOT_FOUND');
    const { pageId } = await page('https://docs.example.com/a');
    expect(reasonOf(await rejection(h.api.getVisit({ name: `pages/${pageId}/visits/not-a-uuid` })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.getVisit({ name: `pages/${pageId}/visits/${uuid(9)}` })))).toBe('NOT_FOUND');
    expect(reasonOf(await rejection(h.api.getDocument({ name: `pages/${'1'.repeat(32)}/documents/${uuid(2)}` })))).toBe('NOT_FOUND');
    expect(reasonOf(await rejection(h.api.getSettings({ name: 'settings' }).then(() => h.api.getServiceStatus({ name: 'serviceStatus' })).then(() => h.api.getSite({ name: 'sites/[::1]' }))))).toBe('BAD_REQUEST');
  });

  it('needs Origin and the CSRF token for a mutation', async () => {
    const { pageId } = await page('https://docs.example.com/a');
    const response = await h.fetch(`/api/v1/pages/${pageId}?request_id=${op()}`, { method: 'DELETE', headers: { origin: ORIGIN } });
    expect(response.status).toBe(403);
    expect((await h.api.getPage({ name: `pages/${pageId}` })).visitCount).toBe(1);
  });

  it('reports devices, counts, storage and the build in the status', async () => {
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status).toMatchObject({ storageBudgetMib: 900, dailyRowBudget: 20000, dailyReadBudget: DAILY_READ_BUDGET, build: 'test' });
    expect(status.pageCount).toBeGreaterThan(0);
    expect(status.storageUsedMib).toBeGreaterThan(0);
    expect(status.rowsWrittenTodayCount).toBeGreaterThan(0);
    expect(status.rowsReadTodayCount).toBeGreaterThan(0);
    expect(status.firstVisitTime).toBeDefined();
    expect(status.devices[0]).toMatchObject({ extensionVersion: '2026.1010.900', queuedCount: 0, clockSkewSeconds: 0 });
  });
});

describe('the daily read budget', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('charges every call its rows read; the feed stops first, the searches at the budget, the timeline never', async () => {
    const day = new Date(T0).toISOString().slice(0, 10);
    await h.api.getServiceStatus({ name: 'serviceStatus' });
    const [charged] = await h.sql<{ rows_read: number }>(`SELECT rows_read FROM usage WHERE day = ?`, day);
    expect(charged?.rows_read).toBeGreaterThan(0);

    await h.sql(`UPDATE usage SET rows_read = ? WHERE day = ?`, FEED_READ_LIMIT, day);
    const feed = await h.changes('?after=0&consumer=nas');
    expect(feed.status).toBe(429);
    expect(await machineReason(feed)).toBe('FEED_OVER_BUDGET');
    expect(Number(feed.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await h.api.searchPages({ query: 'durable' })).results).toEqual([]);
    expect((await h.opsStatus())['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reads_over_budget', severity: 'warning' })]));

    await h.sql(`UPDATE usage SET rows_read = ? WHERE day = ?`, DAILY_READ_BUDGET, day);
    expect(reasonOf(await rejection(h.api.searchPages({ query: 'durable' })))).toBe('SEARCH_OVER_BUDGET');
    expect((await h.api.listVisits({ parent: 'pages/-' })).visits).toEqual([]);
    await h.clock(T0 + DAY);
    expect((await h.api.searchPages({ query: 'durable' })).results).toEqual([]);
  });
});

describe('Access without the dev bypass', () => {
  it('a machine token never reaches the owner API, and an Access login never replaces a machine token', async () => {
    const issuer = await testIssuer();
    const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
    const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';
    const h = await startHarness({ bindings: { DEV_AUTH_BYPASS: undefined }, routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(issuer.jwks)]]) });
    try {
      const jwt = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
      expect((await h.fetch('/api/v1/serviceStatus', { headers: { authorization: `Bearer ${INGEST_TOKEN}` } })).status).toBe(401);
      expect((await h.fetch('/api/v1/serviceStatus', { headers: { authorization: `Bearer ${EXPORT_TOKEN}` } })).status).toBe(401);
      expect((await h.fetch('/api/v1/serviceStatus', { headers: { 'cf-access-jwt-assertion': jwt } })).status).toBe(200);
      expect((await h.fetch('/api/machine/v1/changes', { headers: { 'cf-access-jwt-assertion': jwt } })).status).toBe(401);
      expect((await h.fetch('/health')).status).toBe(200);
    } finally {
      await h.dispose();
    }
  });
});

describe('ops-v1', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('says no_device before the first upload, lists no capability, and refuses a guard', async () => {
    const status = await h.opsStatus();
    expect(status).toMatchObject({ version: 'ops-v1', app: 'recall', health: 'ok', modes: { maintenance: false }, capabilities: [], ui_url: 'https://recall.example.com/' });
    expect((status['signals'] as { code: string }[]).map((s) => s.code)).toEqual(['no_device']);
    await expect(h.opsSetGuard({ level: 'shed', reason: 'd1_reads_high', until: new Date(T0 + HOUR).toISOString() })).rejects.toThrow('invalid_input');
  });

  it('raises device_stale, archive_behind, no_captures, items_rejected and upload_over_budget', async () => {
    // Yesterday: a device's last upload (a visit of ten minutes, no text) and the archive's last pull.
    const yesterday = T0 - DAY;
    await h.clock(yesterday);
    const long = await visit({ id: uuid(1), url: 'https://example.com/long', spans: [[yesterday - 10 * MINUTE, yesterday - MINUTE]] });
    expect((await h.upload(batch([long], { sentMs: yesterday }))).status).toBe(200);
    await h.changes('?after=0&consumer=nas');
    // Today: another device uploads an item recall refuses.
    await h.clock(T0);
    const other = { device_id: '6e1d4c63-9b6f-4a9f-8c9f-3e8d2b7a5f21', label: 'Mac mini' };
    expect((await h.upload(batch([{ kind: 'visit' }], { device: other }))).status).toBe(200);
    await h.clock(T0 + 2 * HOUR);
    await h.sql(`INSERT INTO usage (day, over_budget) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET over_budget = 1`, new Date(T0).toISOString().slice(0, 10));
    const status = await h.opsStatus();
    expect(status['health']).toBe('degraded');
    expect((status['signals'] as { code: string; severity: string }[]).map((s) => [s.code, s.severity])).toEqual([
      ['archive_behind', 'warning'],
      ['device_stale', 'warning'],
      ['items_rejected', 'warning'],
      ['no_captures', 'warning'],
      ['upload_over_budget', 'warning'],
    ]);
    expect(status['counters']).toEqual({ visits_today: 0, texts_today: 0, rows_written_today: expect.any(Number) as number, rows_read_today: expect.any(Number) as number });
  });

  it('raises no no_captures for long visits that can have no text or whose text recall had, nor items_rejected for a newer build', async () => {
    const day1 = T0 + 2 * DAY;
    await h.clock(day1);
    const url = 'https://example.com/read-again';
    // Yesterday (day1): a capture of a page, and a long visit on a site-only page (no capture can come).
    const first = [
      await visit({ id: uuid(41), url, spans: [[day1 - 10 * MINUTE, day1 - MINUTE]] }),
      await document({ id: uuid(42), visitId: uuid(41), url, captureMs: day1 - 5 * MINUTE, text: '一样的正文' }),
      await visit({ id: uuid(43), url: 'https://mail.google.com/mail/u/0/', spans: [[day1 - 30 * MINUTE, day1 - 20 * MINUTE]] }),
    ];
    expect((await h.upload(batch(first, { sentMs: day1 }))).status).toBe(200);
    // The next day: a long visit whose capture repeats the page's latest text (skipped, yet a capture), and an item
    // only a newer Worker reads.
    const day2 = day1 + DAY;
    await h.clock(day2);
    const second = [
      await visit({ id: uuid(44), url, spans: [[day2 - 10 * MINUTE, day2 - MINUTE]] }),
      await document({ id: uuid(45), visitId: uuid(44), url, captureMs: day2 - 5 * MINUTE, text: '一样的正文' }),
      { kind: 'star', star: { id: uuid(46) } },
    ];
    expect(await (await h.upload(batch(second, { sentMs: day2 }))).json()).toMatchObject({ accepted_count: 2, rejected: [{ id: uuid(46), reason: 'unsupported_item' }] });
    await h.clock(day2 + DAY);
    const codes = ((await h.opsStatus())['signals'] as { code: string }[]).map((s) => s.code);
    expect(codes).not.toContain('no_captures');
    expect(codes).not.toContain('items_rejected');
  });
});
