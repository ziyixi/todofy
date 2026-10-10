// The uploads against recall.ingest.v1 (proto/recall/ingest/v1/ingest.proto): batches the extension builds through its
// own code paths (visits through the focus state machine, texts through the capture, the heartbeat), read the way the
// Worker reads them (recall/worker/src/ingest.ts): the envelope strictly with its items left out, then each item
// strictly on its own. The extension ships no protobuf code; this test is where its hand-built JSON meets the IDL.
import { IngestBatchSchema, IngestItem_Kind, IngestItemSchema } from '@ziyixi/proto/recall/ingest/v1/ingest_pb';
import { timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { fromWire } from '@ziyixi/proto/wire-json';
import { describe, expect, it } from 'vitest';
import { captureDue, readTab, storeCapture } from '../src/capture.ts';
import { oldestItems, setToken } from '../src/db.ts';
import { reconcile } from '../src/focus.ts';
import { lastError } from '../src/store.ts';
import { flush } from '../src/upload.ts';
import { harness, INGEST_TOKEN, MINUTE, SECOND, T0, WINDOW_ID_NONE, type FakeRequest, type Harness } from './fake-chrome.ts';

async function sentJson(request: FakeRequest | undefined): Promise<Record<string, unknown>> {
  const body = request?.init.body;
  if (!(body instanceof ArrayBuffer)) throw new Error('no gzip body');
  return JSON.parse(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).text()) as Record<string, unknown>;
}

/**
 * The Worker's reading: the envelope strictly without its items, then each item strictly, then the rules the IDL
 * cannot state (ingest.ts): times at most a minute after sent_time, spans in order without overlaps, a visit of at
 * most six hours and at least a second of focus, an ASCII http(s) URL, version parts of at most 65535.
 */
function readAsTheWorker(json: Record<string, unknown>) {
  const batch = fromWire(IngestBatchSchema, { ...json, items: [] }, { strict: true }).message;
  const items = (json['items'] as unknown[]).map((item) => fromWire(IngestItemSchema, item, { strict: true }).message);
  const latest = (batch.sentTime ? timestampMs(batch.sentTime) : 0) + MINUTE;
  expect(batch.device?.extensionVersion.split('.').every((part) => Number(part) <= 65_535)).toBe(true);
  for (const item of items) {
    const url = item.visit?.url ?? item.document?.url ?? '';
    expect(url).toMatch(/^https?:\/\/[!-~]+$/);
    if (item.document?.captureTime) expect(timestampMs(item.document.captureTime)).toBeLessThanOrEqual(latest);
    const spans = (item.visit?.focusSpans ?? []).map((span) => [span.startTime ? timestampMs(span.startTime) : 0, span.endTime ? timestampMs(span.endTime) : 0] as const);
    if (item.visit === undefined) continue;
    expect(spans.length).toBeGreaterThan(0);
    spans.forEach(([start, end], i) => {
      expect(end).toBeGreaterThanOrEqual(start);
      expect(end).toBeLessThanOrEqual(latest);
      if (i > 0) expect(start).toBeGreaterThanOrEqual(spans[i - 1]?.[1] ?? 0);
    });
    expect((spans.at(-1)?.[1] ?? 0) - (spans[0]?.[0] ?? 0)).toBeLessThanOrEqual(6 * 60 * MINUTE);
    expect(Math.round(spans.reduce((sum, [start, end]) => sum + end - start, 0) / 1000)).toBeGreaterThanOrEqual(1);
  }
  return { batch, items };
}

async function uploadEverything(h: Harness): Promise<Record<string, unknown>> {
  await setToken(h.ctx.db, INGEST_TOKEN);
  h.net.answer = () => new Response(JSON.stringify({ accepted_count: 0, rejected: [], denylist_patterns: [], denylist_etag: '' }));
  await flush(h.ctx, h.clock.time, 'manual');
  return sentJson(h.net.requests.at(-1));
}

describe('recall.ingest.v1', () => {
  it('reads the visits and the texts the extension uploads', async () => {
    const h = await harness();
    h.browser.script = () => ({
      build: h.ctx.build,
      title: 'SQLite FTS5 与中文分词',
      description: '二元分词',
      text: '数据库的全文检索。 api_key=abcdef123456 and more text.',
      textTruncated: false,
      hasPasswordField: false,
    });
    h.browser.open('https://news.example.org/2026/10/sqlite-fts5-chinese?utm_source=feed', { title: 'SQLite FTS5 与中文分词' });
    await reconcile(h.ctx, T0);
    const job = await captureDue(h.ctx, T0 + 10 * SECOND);
    if (job === null) throw new Error('no capture');
    await storeCapture(h.ctx, job, await readTab(h.ctx, job), T0 + 10 * SECOND);
    h.browser.open(`https://maps.example.com/?view=${'x'.repeat(9000)}`, { title: 'Map' });
    await reconcile(h.ctx, T0 + 30 * SECOND);
    h.browser.open('https://mail.google.com/mail/u/0/#inbox', { title: 'Inbox (2)' });
    await reconcile(h.ctx, T0 + 40 * SECOND);
    await reconcile(h.ctx, T0 + MINUTE, { windowId: WINDOW_ID_NONE });
    await lastError.set(h.ctx.chrome, 'capture_failed', T0);
    h.clock.time = T0 + MINUTE;

    const json = await uploadEverything(h);
    const { batch, items } = readAsTheWorker(json);
    expect(batch.version).toBe('recall-ingest-v1');
    expect(batch.device?.lastErrorCode).toBe('capture_failed');
    expect(batch.sentTime && timestampMs(batch.sentTime)).toBe(T0 + MINUTE);
    expect(items.map((item) => item.kind)).toEqual([IngestItem_Kind.DOCUMENT, IngestItem_Kind.VISIT, IngestItem_Kind.VISIT, IngestItem_Kind.VISIT]);
    const [document, article, map, mail] = items;
    expect(document?.document).toMatchObject({ visitId: article?.visit?.id, pageId: article?.visit?.pageId, text: '数据库的全文检索。 api_key=[redacted] and more text.' });
    expect(map?.visit?.urlTruncated).toBe(true);
    expect(mail?.visit).toMatchObject({ url: 'https://mail.google.com/', title: '' });
    // Every item went: none is left behind.
    expect(await oldestItems(h.ctx.db, 10, Infinity, h.clock.time)).toEqual([]);
  });

  it('reads the heartbeat (a batch without items) with a label of 64 characters', async () => {
    const h = await harness();
    await h.ctx.chrome.storage.local.set({ device: { id: '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', label: '工'.repeat(64), server: 'https://recall.ziyixi.science' } });
    const { batch, items } = readAsTheWorker(await uploadEverything(h));
    expect(items).toEqual([]);
    expect(batch.device).toMatchObject({ label: '工'.repeat(64), queuedCount: 0, extensionVersion: '2026.1010.900' });
  });

  it('reads a batch of 50 items, the most an upload holds', async () => {
    const h = await harness();
    for (let i = 0; i < 60; i++) {
      h.browser.open(`https://example.com/page/${String(i)}`, { title: `第 ${String(i)} 页` });
      await reconcile(h.ctx, T0 + i * 2 * SECOND);
    }
    await reconcile(h.ctx, T0 + 2 * MINUTE, { windowId: WINDOW_ID_NONE });
    h.clock.time = T0 + 2 * MINUTE;
    const { items } = readAsTheWorker(await uploadEverything(h));
    expect(items).toHaveLength(50);
  });
});
