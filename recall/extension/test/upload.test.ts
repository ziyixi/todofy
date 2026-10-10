// The outbox and uploads (src/db.ts, src/upload.ts): coalescing, batching, gzip, the request, every answer of the
// design's table (200, 401, 413, 429, 503, other, network), items a newer extension sent held rather than lost, the
// heartbeat and the badge. Synthetic items and tokens.
import type { IngestBatch, IngestResult } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import { describe, expect, it } from 'vitest';
import type { Context } from '../src/context.ts';
import { countHeld, countItems, oldestItems, queueItem, setToken } from '../src/db.ts';
import { HOUR, UNSUPPORTED_HOLD_MS } from '../src/limits.ts';
import { saveSettings } from '../src/settings.ts';
import { lastError, ownerDenylist, uploadState } from '../src/store.ts';
import { flush, showBadge } from '../src/upload.ts';
import { harness, INGEST_TOKEN, MINUTE, SECOND, T0, testUuid, type FakeRequest, type Harness } from './fake-chrome.ts';

const OK: IngestResult = { accepted_count: 0, rejected: [], denylist_patterns: [], denylist_etag: 'e0' };

function answer(status: number, body: unknown = OK, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function sentBatch(request: FakeRequest | undefined): Promise<IngestBatch> {
  const body = request?.init.body;
  if (!(body instanceof ArrayBuffer)) throw new Error('no gzip body');
  const text = await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text) as IngestBatch;
}

/** Queues `count` visit items (`textBytes` of title each), oldest first. */
async function queueVisits(ctx: Context, count: number, at = T0 - HOUR, textBytes = 10): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = testUuid();
    ids.push(id);
    const item = {
      kind: 'visit',
      visit: {
        id,
        revision: 1,
        page_id: '0'.repeat(32),
        url: `https://example.com/${String(i)}`,
        title: 'x'.repeat(textBytes),
        focus_spans: [{ start_time: new Date(at).toISOString(), end_time: new Date(at + SECOND).toISOString() }],
      },
    };
    await queueItem(ctx.db, { id, kind: 'visit', json: JSON.stringify(item), version: 1 }, at + i);
  }
  return ids;
}

async function ready(options: { token?: boolean } = {}): Promise<Harness> {
  const h = await harness();
  if (options.token ?? true) await setToken(h.ctx.db, INGEST_TOKEN);
  return h;
}

describe('a flush', () => {
  it('posts the oldest items gzipped, with the bearer token and no credentials, and removes them on 200', async () => {
    const h = await ready();
    const ids = await queueVisits(h.ctx, 3);
    h.net.answer = () => answer(200, { accepted_count: 2, rejected: [{ id: ids[2], reason: 'invalid_item' }], denylist_patterns: ['bank.example.com'], denylist_etag: 'e2' });

    expect(await flush(h.ctx, T0, 'tick')).toEqual({ kind: 'sent', items: 3, status: 200 });
    const [request] = h.net.requests;
    expect(request?.url).toBe('https://recall.ziyixi.science/api/machine/v1/batches');
    expect(request?.init).toMatchObject({
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/gzip' },
      credentials: 'omit',
      redirect: 'error',
    });
    expect(request?.init.signal).toBeInstanceOf(AbortSignal);
    const batch = await sentBatch(request);
    expect(batch).toMatchObject({ version: 'recall-ingest-v1', sent_time: new Date(T0).toISOString() });
    expect(batch.device).toEqual({ device_id: expect.any(String) as string, label: 'Chrome', extension_version: '2026.1010.900', queued_count: 3 });
    expect(batch.items.map((item) => (item.kind === 'visit' ? item.visit.id : ''))).toEqual(ids);

    // Accepted and rejected items leave the outbox alike; the refusals are counted, the owner's list stored.
    expect(await countItems(h.ctx.db)).toBe(0);
    expect(await ownerDenylist.get(h.ctx.chrome)).toEqual({ patterns: ['bank.example.com'], siteOnly: [], etag: 'e2' });
    expect(await uploadState.get(h.ctx.chrome)).toMatchObject({ lastUploadAt: T0, rejectedCount: 1, failingSince: 0 });
  });

  it("keeps the owner's site-only list from the answer", async () => {
    const h = await ready();
    h.net.answer = () => answer(200, { ...OK, denylist_etag: 'e3', site_only_patterns: ['portal.bank.example'] });
    await flush(h.ctx, T0, 'manual');
    expect(await ownerDenylist.get(h.ctx.chrome)).toEqual({ patterns: [], siteOnly: ['portal.bank.example'], etag: 'e3' });
  });

  it('holds an item recall cannot read yet (a newer build), sends the others meanwhile, and tries it again later', async () => {
    const h = await ready();
    const ids = await queueVisits(h.ctx, 2);
    h.net.answer = () => answer(200, { ...OK, accepted_count: 1, rejected: [{ id: ids[0], reason: 'unsupported_item' }] });
    await flush(h.ctx, T0, 'manual');
    // Kept, not lost: not counted as refused, and held.
    expect(await countItems(h.ctx.db)).toBe(1);
    expect(await countHeld(h.ctx.db, T0)).toBe(1);
    expect((await uploadState.get(h.ctx.chrome)).rejectedCount).toBe(0);
    // A new item goes alone while it is held; a tick with only held items is not due (no empty batch every minute).
    const [fresh] = await queueVisits(h.ctx, 1, T0);
    h.net.answer = () => answer(200, { ...OK, accepted_count: 1 });
    await flush(h.ctx, T0 + MINUTE, 'manual');
    expect((await sentBatch(h.net.requests.at(-1))).items.map((item) => (item.kind === 'visit' ? item.visit.id : ''))).toEqual([fresh]);
    const requests = h.net.requests.length;
    for (const reason of ['tick', 'tick'] as const) expect(await flush(h.ctx, T0 + 2 * MINUTE, reason)).toEqual({ kind: 'idle' });
    expect(h.net.requests.length).toBe(requests);
    // Once the hold ends it goes again, and a recall that reads it takes it.
    await flush(h.ctx, T0 + UNSUPPORTED_HOLD_MS + MINUTE, 'manual');
    expect((await sentBatch(h.net.requests.at(-1))).items.map((item) => (item.kind === 'visit' ? item.visit.id : ''))).toEqual([ids[0]]);
    expect(await countItems(h.ctx.db)).toBe(0);
  });

  it('keeps a revision queued while the upload was on its way', async () => {
    const h = await ready();
    const [id = ''] = await queueVisits(h.ctx, 1);
    h.net.answer = async () => {
      await queueItem(h.ctx.db, { id, kind: 'visit', json: '{"kind":"visit"}', version: 2 }, T0);
      return answer(200);
    };
    await flush(h.ctx, T0, 'tick');
    expect((await oldestItems(h.ctx.db, 10, Infinity, 0)).map((item) => [item.id, item.version])).toEqual([[id, 2]]);
  });

  it('goes when the last upload was five minutes ago, when 25 items wait, at startup and from the options', async () => {
    const h = await ready();
    h.net.answer = () => answer(200);
    await uploadState.set(h.ctx.chrome, { ...(await uploadState.get(h.ctx.chrome)), lastUploadAt: T0 - 2 * MINUTE });
    await queueVisits(h.ctx, 3);
    expect(await flush(h.ctx, T0, 'tick')).toEqual({ kind: 'idle' });
    expect(await flush(h.ctx, T0 + 3 * MINUTE, 'tick')).toMatchObject({ status: 200 });

    await queueVisits(h.ctx, 25);
    expect(await flush(h.ctx, T0 + 4 * MINUTE, 'tick')).toMatchObject({ items: 25 });
    await queueVisits(h.ctx, 1);
    expect(await flush(h.ctx, T0 + 5 * MINUTE, 'startup')).toMatchObject({ items: 1 });
    await queueVisits(h.ctx, 1);
    expect(await flush(h.ctx, T0 + 6 * MINUTE, 'manual')).toMatchObject({ items: 1 });
  });

  it('sends at most 50 items and 1 MiB of JSON', async () => {
    const h = await ready();
    h.net.answer = () => answer(200);
    await queueVisits(h.ctx, 60);
    expect(await flush(h.ctx, T0, 'tick')).toMatchObject({ items: 50 });
    expect(await flush(h.ctx, T0, 'manual')).toMatchObject({ items: 10 });

    await queueVisits(h.ctx, 30, T0 - HOUR, 60_000);
    // About 60 KB each: 17 fit in 1 MiB, less the room kept for the envelope.
    const sent = await flush(h.ctx, T0, 'manual');
    expect(sent).toMatchObject({ items: 17 });
    const json = JSON.stringify(await sentBatch(h.net.requests.at(-1)));
    expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(1024 * 1024);
  });

  it('sends nothing without a token', async () => {
    const h = await ready({ token: false });
    await queueVisits(h.ctx, 3);
    expect(await flush(h.ctx, T0, 'manual')).toEqual({ kind: 'idle' });
    expect(h.net.requests).toEqual([]);
  });
});

describe('the heartbeat', () => {
  it('is an empty batch after 30 minutes without an upload, with the last error of the past day', async () => {
    const h = await ready();
    h.net.answer = () => answer(200);
    await uploadState.set(h.ctx.chrome, { ...(await uploadState.get(h.ctx.chrome)), lastUploadAt: T0 - 10 * MINUTE });
    await lastError.set(h.ctx.chrome, 'capture_failed', T0 - HOUR);
    expect(await flush(h.ctx, T0, 'tick')).toEqual({ kind: 'idle' });
    expect(await flush(h.ctx, T0 + 20 * MINUTE, 'tick')).toEqual({ kind: 'sent', items: 0, status: 200 });
    const batch = await sentBatch(h.net.requests[0]);
    expect(batch.items).toEqual([]);
    expect(batch.device).toMatchObject({ queued_count: 0, last_error_code: 'capture_failed' });

    // A day later the error is no longer reported.
    expect(await flush(h.ctx, T0 + 25 * HOUR, 'tick')).toMatchObject({ status: 200 });
    expect((await sentBatch(h.net.requests[1])).device.last_error_code).toBeUndefined();
  });

  it('carries the label and the server the owner set', async () => {
    const h = await ready();
    h.net.answer = () => answer(200);
    expect(await saveSettings(h.ctx, { server: 'http://127.0.0.1:8797', label: ' MacBook · 工作 ', token: '' })).toEqual({ ok: true });
    await flush(h.ctx, T0, 'manual');
    expect(h.net.requests[0]?.url).toBe('http://127.0.0.1:8797/api/machine/v1/batches');
    expect((await sentBatch(h.net.requests[0])).device.label).toBe('MacBook · 工作');
  });
});

describe('the answers', () => {
  it('401 stops the uploads until the token changes, with the badge', async () => {
    const h = await ready();
    await queueVisits(h.ctx, 2);
    h.net.answer = () => answer(401);
    await flush(h.ctx, T0, 'tick');
    expect(await uploadState.get(h.ctx.chrome)).toMatchObject({ tokenRefused: true });
    expect(await flush(h.ctx, T0 + 10 * MINUTE, 'manual')).toEqual({ kind: 'idle' });
    await showBadge(h.ctx, T0 + 10 * MINUTE);
    expect([h.browser.badge, h.browser.title]).toEqual(['!', 'recall：令牌无效']);
    // Nothing in the outbox expires.
    expect(await countItems(h.ctx.db)).toBe(2);

    expect(await saveSettings(h.ctx, { server: 'https://recall.ziyixi.science', label: 'Chrome', token: `recall_ingest_${'B'.repeat(43)}` })).toEqual({ ok: true });
    h.net.answer = () => answer(200);
    expect(await flush(h.ctx, T0 + 11 * MINUTE, 'manual')).toMatchObject({ status: 200 });
    expect(h.net.requests.at(-1)?.init.headers).toMatchObject({ authorization: `Bearer recall_ingest_${'B'.repeat(43)}` });
    await showBadge(h.ctx, T0 + 11 * MINUTE);
    expect(h.browser.badge).toBe('');
  });

  it('a 401 for a token the owner replaced during the upload does not stop the new one', async () => {
    const h = await ready();
    await queueVisits(h.ctx, 1);
    const newToken = `recall_ingest_${'C'.repeat(43)}`;
    h.net.answer = async () => {
      expect(await saveSettings(h.ctx, { server: 'https://recall.ziyixi.science', label: 'Chrome', token: newToken })).toEqual({ ok: true });
      return answer(401);
    };
    expect(await flush(h.ctx, T0, 'tick')).toMatchObject({ status: 401 });
    expect((await uploadState.get(h.ctx.chrome)).tokenRefused).toBe(false);
    h.net.answer = () => answer(200);
    expect(await flush(h.ctx, T0 + MINUTE, 'manual')).toMatchObject({ status: 200 });
    expect(h.net.requests.at(-1)?.init.headers).toMatchObject({ authorization: `Bearer ${newToken}` });
  });

  it('413 halves the batch, and each success doubles it back', async () => {
    const h = await ready();
    await queueVisits(h.ctx, 40);
    h.net.answer = () => answer(413);
    await flush(h.ctx, T0, 'tick');
    expect((await uploadState.get(h.ctx.chrome)).batchLimit).toBe(20);
    h.net.answer = () => answer(200);
    expect(await flush(h.ctx, T0, 'manual')).toMatchObject({ items: 20 });
    expect((await uploadState.get(h.ctx.chrome)).batchLimit).toBe(40);
  });

  it('429 waits Retry-After, in seconds or as a date, without the failure badge', async () => {
    const h = await ready();
    await queueVisits(h.ctx, 1);
    h.net.answer = () => answer(429, {}, { 'retry-after': '120' });
    await flush(h.ctx, T0, 'tick');
    expect(await flush(h.ctx, T0 + 60 * SECOND, 'tick')).toEqual({ kind: 'idle' });
    h.net.answer = () => answer(429, {}, { 'retry-after': new Date(T0 + 3 * HOUR).toUTCString() });
    expect(await flush(h.ctx, T0 + 121 * SECOND, 'tick')).toMatchObject({ status: 429 });
    expect((await uploadState.get(h.ctx.chrome)).nextAttemptAt).toBe(T0 + 3 * HOUR);
    await showBadge(h.ctx, T0 + 2 * HOUR);
    expect(h.browser.badge).toBe('');
  });

  it('503 waits Retry-After, or backs off without one', async () => {
    const h = await ready();
    await queueVisits(h.ctx, 1);
    h.net.answer = () => answer(503, {}, { 'retry-after': '60' });
    await flush(h.ctx, T0, 'tick');
    expect((await uploadState.get(h.ctx.chrome)).nextAttemptAt).toBe(T0 + MINUTE);
    h.net.answer = () => answer(503);
    await flush(h.ctx, T0 + MINUTE, 'tick');
    expect(await uploadState.get(h.ctx.chrome)).toMatchObject({ backoffMs: MINUTE, nextAttemptAt: T0 + 2 * MINUTE });
  });

  it('a network error or another answer backs off from a minute, doubling to an hour; the badge after an hour', async () => {
    const h = await ready();
    const [id = ''] = await queueVisits(h.ctx, 1);
    h.net.answer = () => {
      throw new TypeError('Failed to fetch');
    };
    const backoffs: number[] = [];
    let at = T0;
    for (let i = 0; i < 8; i++) {
      await flush(h.ctx, at, 'tick');
      const upload = await uploadState.get(h.ctx.chrome);
      backoffs.push(upload.backoffMs / MINUTE);
      await showBadge(h.ctx, at);
      if (at - T0 < HOUR) expect(h.browser.badge).toBe('');
      at = upload.nextAttemptAt;
    }
    expect(backoffs).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(h.browser.badge).toBe('!');
    expect((await oldestItems(h.ctx.db, 10, Infinity, 0)).find((item) => item.id === id)?.attempts).toBe(8);
    expect((await lastError.get(h.ctx.chrome))?.code).toBe('upload_failed');

    h.net.answer = () => answer(500);
    await flush(h.ctx, at, 'tick');
    expect((await uploadState.get(h.ctx.chrome)).backoffMs).toBe(HOUR);
    h.net.answer = () => answer(200);
    await flush(h.ctx, at + HOUR, 'tick');
    expect(await uploadState.get(h.ctx.chrome)).toMatchObject({ backoffMs: 0, failingSince: 0, nextAttemptAt: 0 });
  });

  it('a 200 that is not recall\'s answer keeps the items and backs off', async () => {
    const h = await ready();
    await queueVisits(h.ctx, 2);
    h.net.answer = () => new Response('<html>a captive portal</html>', { status: 200 });
    await flush(h.ctx, T0, 'tick');
    expect(await countItems(h.ctx.db)).toBe(2);
    expect((await uploadState.get(h.ctx.chrome)).backoffMs).toBe(MINUTE);
  });
});
