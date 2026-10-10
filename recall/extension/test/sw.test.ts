// The service worker's wiring (src/sw.ts) over the fake Chrome: every listener registered at the top level, events to
// an upload, the navigation filter (no prerender, cached page or frame), the capture and the self-update on the tick,
// and messages from the extension's own pages only. The clock is faked (Date only: fake-indexeddb needs real timers).
import type { IngestBatch } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FocusState } from '../src/store.ts';
import { EXTENSION_ID, FakeBrowser, FakeFetch, INGEST_TOKEN, SECOND, T0 } from './fake-chrome.ts';

let browser: FakeBrowser;
let net: FakeFetch;

/** Lets the worker's queue of handlers run (IndexedDB answers in later tasks). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function start(): Promise<void> {
  await import('../src/sw.ts');
  await settle();
}

function message(request: unknown, senderId = EXTENSION_ID): Promise<unknown> {
  return new Promise((resolve) => {
    const keptOpen = browser.events.message.emit(request, { id: senderId }, resolve);
    if (keptOpen !== true) resolve('not answered');
  });
}

async function focus(): Promise<FocusState | undefined> {
  return (await browser.session.get('focus'))['focus'] as FocusState | undefined;
}

async function batch(index: number): Promise<IngestBatch> {
  const body = net.requests[index]?.init.body;
  if (!(body instanceof ArrayBuffer)) throw new Error('no upload');
  return JSON.parse(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).text()) as IngestBatch;
}

beforeEach(() => {
  vi.resetModules();
  browser = new FakeBrowser();
  net = new FakeFetch(browser);
  net.answer = () => new Response(JSON.stringify({ accepted_count: 1, rejected: [], denylist_patterns: [], denylist_etag: 'e1' }));
  vi.stubGlobal('chrome', browser.chrome);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('fetch', net.fetch);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the service worker', () => {
  it('registers every listener at the top level and arms the one-minute alarm', async () => {
    await start();
    for (const [name, event] of Object.entries(browser.events)) expect(event.listeners, name).toHaveLength(1);
    expect(browser.alarms.get('tick')).toEqual({ name: 'tick', periodInMinutes: 1 });
  });

  it('turns tab events into a visit, and the options page\'s save into an upload', async () => {
    await start();
    const first = browser.open('https://docs.example.com/guide', { title: 'Guide' });
    browser.events.activated.emit({ tabId: first.id, windowId: 1 });
    await settle();
    vi.setSystemTime(T0 + 30 * SECOND);
    const second = browser.open('https://docs.example.com/next', { title: 'Next' });
    browser.events.activated.emit({ tabId: second.id, windowId: 1 });
    await settle();

    expect(await message({ type: 'save', server: 'https://recall.ziyixi.science', label: 'MacBook', token: INGEST_TOKEN })).toEqual({ ok: true });
    const sent = await batch(0);
    expect(sent.device.label).toBe('MacBook');
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0]).toMatchObject({ kind: 'visit', visit: { url: 'https://docs.example.com/guide', title: 'Guide', revision: 1 } });
    expect(browser.badge).toBe('');
  });

  it('follows only an active main document: no prerender, cached page or frame', async () => {
    await start();
    const tab = browser.open('https://docs.example.com/a');
    browser.events.activated.emit({ tabId: tab.id, windowId: 1 });
    await settle();
    const before = (await focus())?.open?.documentId;
    browser.navigate(tab.id, 'https://docs.example.com/b');
    for (const [frameType, documentLifecycle] of [
      ['sub_frame', 'active'],
      ['outermost_frame', 'prerender'],
      ['outermost_frame', 'cached'],
    ] as const) {
      browser.events.committed.emit({ tabId: tab.id, frameType, documentLifecycle, documentId: tab.documentId, url: tab.url });
    }
    await settle();
    expect((await focus())?.open?.documentId).toBe(before);

    browser.events.committed.emit({ tabId: tab.id, frameType: 'outermost_frame', documentLifecycle: 'active', documentId: tab.documentId, url: tab.url });
    await settle();
    expect((await focus())?.open?.documentId).toBe(tab.documentId);
  });

  it('captures on the tick once the focus reached ten seconds', async () => {
    await start();
    browser.script = () => ({ build: '2026.1010.900', title: 'Guide', description: '', text: '正文', textTruncated: false, hasPasswordField: false });
    const tab = browser.open('https://docs.example.com/guide');
    browser.events.activated.emit({ tabId: tab.id, windowId: 1 });
    await settle();
    vi.setSystemTime(T0 + 15 * SECOND);
    browser.events.alarm.emit({ name: 'tick' });
    await settle();
    await settle();
    expect(browser.scriptCalls).toEqual([{ tabId: tab.id, documentIds: [tab.documentId], files: ['capture.js'] }]);
  });

  it('reloads into a newer build installed in its folder, after closing the span', async () => {
    await start();
    const tab = browser.open('https://docs.example.com/guide');
    browser.events.activated.emit({ tabId: tab.id, windowId: 1 });
    await settle();
    browser.files.set('BUILD', '2026.1011.800\n');
    browser.files.set('manifest.json', JSON.stringify({ version: '2026.1011.800' }));
    vi.setSystemTime(T0 + 20 * SECOND);
    browser.events.alarm.emit({ name: 'tick' });
    await settle();
    await settle();
    expect(browser.reloads).toBe(1);
    expect((await focus())?.open).toBeNull();

    // Should Chrome come back with the old code, the tick does not reload for that version again; 检查更新 still does.
    browser.events.alarm.emit({ name: 'tick' });
    await settle();
    await settle();
    expect(browser.reloads).toBe(1);
    expect(await message({ type: 'check-update' })).toEqual({ reloading: true });
    expect(browser.reloads).toBe(2);
  });

  it('makes the device once, before any handler runs', async () => {
    await start();
    const device = browser.local.values.get('device') as { id?: string } | undefined;
    expect(device?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await message({ type: 'status' })).toMatchObject({ deviceId: device?.id });
  });

  it('answers only the extension\'s own pages', async () => {
    await start();
    expect(await message({ type: 'status' }, 'another-extension')).toBe('not answered');
    expect(await message({ type: 'unknown' })).toBe('not answered');
    expect(await message({ type: 'status' })).toMatchObject({ version: '2026.1010.900', queued: 0, tokenSet: false });
  });
});
