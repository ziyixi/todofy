// The service worker's wiring (src/sw.ts) over the fake Chrome: every listener registered at the top level, events to
// an upload, the navigation filter (no prerender, cached page or frame), the capture and the self-update on the tick,
// and messages from the extension's own pages only. The clock is faked (Date only: fake-indexeddb needs real timers).
import type { IngestBatch } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getVisit, oldestItems, openDb, saveVisit, setToken } from '../src/db.ts';
import { pageOf } from '../src/page.ts';
import type { FocusState } from '../src/store.ts';
import { newVisit } from '../src/visits.ts';
import type { DiagnosticAnswer } from '../src/messages.ts';
import { EXTENSION_ID, FakeBrowser, FakeFetch, INGEST_TOKEN, SECOND, T0, type FakeTab } from './fake-chrome.ts';

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

  it.each([undefined, null])('preserves an existing MV2 alarm and creates a missing alarm returned as %s', async (missing) => {
    vi.stubGlobal('RECALL_ORION', true);
    browser.alarms.set('tick', { name: 'tick', periodInMinutes: 1 });
    const create = vi.spyOn(browser.api.alarms, 'create');
    Object.assign(browser.api.alarms, { get: (name: string, callback?: (alarm: chrome.alarms.Alarm | null | undefined) => void) => {
      queueMicrotask(() => { callback?.((browser.alarms.get(name) ?? missing) as chrome.alarms.Alarm | null | undefined); });
    } });
    await start();
    expect(create).not.toHaveBeenCalled();
    browser.alarms.delete('tick');
    browser.events.installed.emit({ reason: 'update' });
    await vi.waitFor(() => { expect(create).toHaveBeenCalledOnce(); });
    expect(browser.alarms.get('tick')).toEqual({ name: 'tick', periodInMinutes: 1 });
  });

  it('retains a native alarm callback error as failed instead of pending in the diagnostic', async () => {
    vi.stubGlobal('RECALL_ORION', true);
    await start();
    const db = await openDb();
    await setToken(db, INGEST_TOKEN);
    Object.assign(browser.api.tabs, { create: () => undefined });
    Object.assign(browser.api.alarms, { get: (_name: string, callback: (alarm?: chrome.alarms.Alarm) => void) => {
      queueMicrotask(() => {
        Object.assign(browser.api.runtime, { lastError: { message: 'Synthetic native failure on https://private.example.org/' } });
        callback();
        delete (browser.api.runtime as unknown as Record<string, unknown>)['lastError'];
      });
    } });
    expect(await message({ type: 'diagnostic-start' })).toMatchObject({ ok: true });
    await vi.waitFor(async () => {
      const state = await message({ type: 'diagnostic-status' }) as DiagnosticAnswer;
      expect(state.diagnostic.steps).toContainEqual({ stage: 'alarm_setup', state: 'failed', result: 'api_error' });
    });
    await message({ type: 'diagnostic-send' });
    const diagnostic = (await batch(0)).diagnostic;
    expect(diagnostic?.steps).toContainEqual({ stage: 'alarm_setup', state: 'failed', result: 'api_error' });
    expect(JSON.stringify(diagnostic)).not.toContain('private.example');
    db.close();
  });

  it.each([
    { mobile: true, frameId: undefined, closes: true },
    { mobile: true, frameId: 3, closes: false },
    { mobile: false, frameId: undefined, closes: false },
  ])('handles pagehide with mobile=$mobile and frameId=$frameId', async ({ mobile, frameId, closes }) => {
    vi.stubGlobal('RECALL_ORION', mobile);
    await start();
    const tab = browser.open('https://docs.example.com/guide');
    const db = await openDb();
    const page = await pageOf(tab.url, { patterns: { noText: [], siteOnly: [] }, ownHosts: [] });
    if (page === null) throw new Error('synthetic page excluded');
    const visit = newVisit('synthetic-visit', tab.id, tab.documentId, page, 'Synthetic guide', T0);
    await saveVisit(db, visit);
    const open = { visitId: visit.id, tabId: tab.id, documentId: tab.documentId, start: T0 };
    await browser.session.set({ focus: { open, windowId: 1, idle: 'active' } });
    await browser.local.set({ mirror: { open, lastBeat: T0 } });
    vi.setSystemTime(T0 + 5 * SECOND);
    const sender = { id: EXTENSION_ID, tab, ...(frameId === undefined ? {} : { frameId }) };
    browser.events.message.emit({ type: 'page-visibility', documentId: tab.documentId, visible: false, at: Date.now() }, sender, () => undefined);
    await settle();
    expect((await focus())?.open).toEqual(closes ? null : open);
    expect((await getVisit(db, visit.id))?.spans).toEqual(closes ? [[T0, T0 + 5 * SECOND]] : []);
    const queued = await oldestItems(db, 10, Number.MAX_SAFE_INTEGER, Date.now());
    expect(queued.map((item) => item.kind)).toEqual(closes ? ['visit'] : []);
    db.close();
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
    await vi.waitFor(() => { expect(net.requests).toHaveLength(1); });
    const sent = await batch(0);
    expect(sent.device.label).toBe('MacBook');
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0]).toMatchObject({ kind: 'visit', visit: { url: 'https://docs.example.com/guide', title: 'Guide', revision: 1 } });
    expect(browser.badge).toBe('');
  });

  it('confirms persisted settings while the first upload is still pending', async () => {
    await start();
    let finishUpload!: (response: Response) => void;
    net.answer = () => new Promise<Response>((resolve) => { finishUpload = resolve; });
    let saved: unknown;
    const response = message({ type: 'save', server: 'https://recall.ziyixi.science', label: 'iPhone', token: INGEST_TOKEN })
      .then((answer) => { saved = answer; });
    try {
      await vi.waitFor(() => { expect(saved).toEqual({ ok: true }); });
      expect(await message({ type: 'status' })).toMatchObject({ label: 'iPhone', tokenSet: true, upload: { lastUploadAt: 0 } });
      await vi.waitFor(() => { expect(net.requests).toHaveLength(1); });
    } finally {
      finishUpload(new Response(JSON.stringify({ accepted_count: 0, rejected: [], denylist_patterns: [], denylist_etag: 'e1' })));
      await response;
      await settle();
    }
  });

  it('saves settings while a phone focus query is still waiting for the browser', async () => {
    vi.stubGlobal('RECALL_ORION', true);
    await start();
    const originalQuery = browser.api.tabs.query;
    let resume!: () => void;
    const query = vi.spyOn(browser.api.tabs, 'query').mockImplementation((info, callback?: (tabs: FakeTab[]) => void) => new Promise<FakeTab[]>((resolve) => {
      resume = () => { void originalQuery(info).then((tabs) => { callback?.(tabs); resolve(tabs); }); };
    }));
    const tab = browser.open('https://docs.example.com/guide');
    browser.events.activated.emit({ tabId: tab.id, windowId: 1 });
    await vi.waitFor(() => { expect(query).toHaveBeenCalled(); });
    let saved: unknown;
    const response = message({ type: 'save', server: 'https://recall.ziyixi.science', label: 'iPhone', token: INGEST_TOKEN })
      .then((answer) => { saved = answer; });
    try {
      await vi.waitFor(() => { expect(saved).toEqual({ ok: true }); });
      expect(await message({ type: 'status' })).toMatchObject({ label: 'iPhone', tokenSet: true });
    } finally {
      query.mockRestore();
      resume();
      await response;
      await settle();
    }
  });

  it('reports a pending local settings write without waiting for storage', async () => {
    await start();
    const originalSet = browser.local.set.bind(browser.local);
    let resume!: () => void;
    const set = vi.spyOn(browser.local, 'set').mockImplementation(async (items) => {
      await originalSet(items);
      if ('device' in items) await new Promise<void>((resolve) => { resume = resolve; });
    });
    const response = message({ type: 'save', server: 'https://recall.ziyixi.science', label: 'iPhone', token: INGEST_TOKEN });
    try {
      await vi.waitFor(async () => { expect(await message({ type: 'save-progress' })).toEqual({ phase: 'device' }); });
      expect(await message({ type: 'status' })).toMatchObject({ tokenSet: false });
    } finally {
      set.mockRestore();
      resume();
      expect(await response).toEqual({ ok: true });
      await settle();
    }
    expect(await message({ type: 'save-progress' })).toEqual({ phase: 'idle' });
    expect(await message({ type: 'save-progress' }, 'another-extension')).toBe('not answered');
  });

  it('starts and sends an owner diagnostic while the phone focus queue is blocked', async () => {
    vi.stubGlobal('RECALL_ORION', true);
    await start();
    const db = await openDb();
    await setToken(db, INGEST_TOKEN);
    const query = vi.spyOn(browser.api.tabs, 'query').mockImplementation(() => new Promise<FakeTab[]>(() => undefined));
    Object.assign(browser.api.tabs, { create: ({ url }: { url: string }, callback: (tab: FakeTab) => void) => { callback(browser.open(url)); } });
    const tab = browser.open('https://example.net/normal');
    browser.events.activated.emit({ tabId: tab.id, windowId: 1 });
    await vi.waitFor(() => { expect(query).toHaveBeenCalled(); });
    expect(await message({ type: 'diagnostic-start' })).toMatchObject({ ok: true, diagnostic: { state: 'running' } });
    expect(await message({ type: 'diagnostic-send' })).toMatchObject({ ok: true, diagnostic: { state: 'sent' } });
    expect((await batch(0)).items).toEqual([]);
    expect((await batch(0)).diagnostic?.run_id).toMatch(/^[0-9a-f-]{36}$/);
    db.close();
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

  it('uses phone mode in the Orion package even when its background reports a desktop identity', async () => {
    vi.stubGlobal('RECALL_ORION', true);
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 0 });
    await start();
    expect(await message({ type: 'status' })).toMatchObject({ mobile: true, label: 'iPhone · Orion', server: 'https://recall.ziyixi.science' });
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
