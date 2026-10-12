/** iPhone behavior over the existing fake: visibility ends focus, reload changes identity, JPEG and resume uploads. */
import { describe, expect, it, vi } from 'vitest';
import { executeFile, probePage, queryTabs } from '../src/browser.ts';
import { captureDue, readTab, storeCapture } from '../src/capture.ts';
import type { Context } from '../src/context.ts';
import { setToken } from '../src/db.ts';
import { beat, pageVisibility, reconcile } from '../src/focus.ts';
import { compressScreenshot } from '../src/screenshot.ts';
import { INITIAL_UPLOAD, lastError, uploadState } from '../src/store.ts';
import { batchOf, flush } from '../src/upload.ts';
import { harness, INGEST_TOKEN, MINUTE, SECOND, T0, type FakeTab } from './fake-chrome.ts';
import { openSpan, queuedDocuments, queuedVisits, spansOf } from './helpers.ts';

vi.mock('../src/screenshot.ts', async (original) => ({ ...await original<typeof import('../src/screenshot.ts')>(), compressScreenshot: vi.fn() }));

async function phone() {
  const h = await harness();
  const ctx: Context = { ...h.ctx, mobile: true };
  const tab = h.browser.open('https://blog.example.com/mobile', { title: 'Synthetic phone article' });
  let visible = true;
  h.browser.script = ({ files }) => files?.[0] === 'probe.js'
    ? { documentId: tab.documentId, visible, url: tab.url }
    : { build: ctx.build, documentId: tab.documentId, visible, title: tab.title, description: '', text: 'A synthetic article.', textTruncated: false, hasPasswordField: false };
  // MV2 APIs answer asynchronously through callbacks and return no Promise.
  const { get, query, captureVisibleTab } = h.browser.api.tabs;
  const answer = <T>(work: Promise<T>, callback?: (value: T) => void) => {
    void work.then((value) => callback?.(value), (error: unknown) => {
      Object.assign(h.browser.api.runtime, { lastError: { message: error instanceof Error ? error.message : 'browser_api_failed' } });
      callback?.(undefined as T);
      delete (h.browser.api.runtime as unknown as Record<string, unknown>)['lastError'];
    });
  };
  Object.assign(h.browser.api.tabs, {
    get: (id: number, callback?: (value: FakeTab) => void) => { answer(get(id), callback); },
    query: (info: { active?: boolean; windowId?: number }, callback?: (value: FakeTab[]) => void) => { answer(query(info), callback); },
    captureVisibleTab: (_details: { format: 'png' }, callback?: (value: string) => void) => { answer(captureVisibleTab(), callback); },
    executeScript: (id: number, details: { file: string }, callback?: (value?: unknown[]) => void) => {
      const target = { tabId: id, files: [details.file] };
      h.browser.scriptCalls.push(target);
      // Injection only acknowledges completion; the native bridge need not return the script's value.
      answer(Promise.resolve(undefined), callback);
    },
    sendMessage: (id: number, message: { type: string }, callback?: (value: unknown) => void) => {
      answer(Promise.resolve().then(() => {
        const value = h.browser.script({ tabId: id, files: [message.type === 'recall-probe' ? 'probe.js' : 'capture.js'] });
        return typeof value === 'object' && value !== null ? { url: h.browser.tab(id).url, ...value } : value;
      }), callback);
    },
  });
  // iOS does not supply these desktop namespaces or Chrome document/lifecycle metadata.
  const api = h.browser.api as unknown as Record<string, unknown>;
  delete api['windows'];
  delete api['idle'];
  delete api['webNavigation'];
  return { ...h, ctx, tab, hide: () => { visible = false; }, show: () => { visible = true; } };
}

describe('Orion iPhone foreground capture', () => {
  it('captures callback-only MV2 text/JPEG at ten seconds, omits unchanged content and stops at pagehide', async () => {
    const h = await phone();
    h.browser.screenshot = 'data:image/png;base64,synthetic';
    vi.mocked(compressScreenshot).mockResolvedValue({ base64: 'cGhvdG8=', preview: '390x844:' + btoa('a'.repeat(4096)), width: 390, height: 844, mediaType: 'image/jpeg' });
    await reconcile(h.ctx, T0);
    expect(await captureDue(h.ctx, T0 + 9 * SECOND)).toBeNull();
    const capture = async (at: number) => {
      const job = await captureDue(h.ctx, at);
      expect(job).not.toBeNull();
      if (job !== null) await storeCapture(h.ctx, job, await readTab(h.ctx, job), at);
    };
    await capture(T0 + 10 * SECOND);
    expect(compressScreenshot).toHaveBeenCalledWith('data:image/png;base64,synthetic');
    await capture(T0 + MINUTE);
    expect(await queuedDocuments(h.ctx)).toHaveLength(1);
    expect((await queuedDocuments(h.ctx))[0]).toMatchObject({ text: 'A synthetic article.', screenshot_jpeg_base64: 'cGhvdG8=', screenshot_width: 390, screenshot_height: 844 });
    expect((await queuedDocuments(h.ctx))[0]?.screenshot_webp_base64).toBeUndefined();
    h.hide();
    await pageVisibility(h.ctx, h.tab.id, h.tab.documentId, false, T0 + MINUTE + 2 * SECOND);
    await beat(h.ctx, T0 + 10 * MINUTE);
    expect(await openSpan(h.ctx, T0 + 10 * MINUTE)).toBeNull();
    expect(await captureDue(h.ctx, T0 + 10 * MINUTE)).toBeNull();
    expect((await queuedVisits(h.ctx)).flatMap(spansOf)).toEqual([[T0, T0 + MINUTE + 2 * SECOND]]);
    h.show();
    await pageVisibility(h.ctx, h.tab.id, h.tab.documentId, true, T0 + 11 * MINUTE);
    expect((await openSpan(h.ctx, T0 + 11 * MINUTE))?.start).toBe(T0 + 11 * MINUTE);
  });

  it('retains recent visible focus across a sessionless background recreation, but not a hidden page or long gap', async () => {
    const h = await phone();
    delete (h.browser.api.storage as unknown as Record<string, unknown>)['session'];
    await reconcile(h.ctx, T0);
    const original = await openSpan(h.ctx, T0);
    const recreated: Context = { ...h.ctx, chrome: { ...h.ctx.chrome } };
    await reconcile(recreated, T0 + 30 * SECOND);
    expect(await openSpan(recreated, T0 + 30 * SECOND)).toEqual(original);
    expect(await captureDue(recreated, T0 + 30 * SECOND)).not.toBeNull();
    h.hide();
    const hidden: Context = { ...h.ctx, chrome: { ...h.ctx.chrome } };
    await pageVisibility(hidden, h.tab.id, h.tab.documentId, false, T0 + MINUTE);
    expect(await openSpan(hidden, T0 + MINUTE)).toBeNull();
    expect((await queuedVisits(h.ctx)).flatMap(spansOf)).toEqual([[T0, T0 + MINUTE]]);
    h.show();
    await reconcile(hidden, T0 + 2 * MINUTE);
    const later: Context = { ...h.ctx, chrome: { ...h.ctx.chrome } };
    await reconcile(later, T0 + 10 * MINUTE);
    expect((await openSpan(later, T0 + 10 * MINUTE))?.start).toBe(T0 + 10 * MINUTE);
  });

  it('never treats an active tab whose document is hidden as foreground, and rejects a replaced document', async () => {
    const h = await phone();
    h.hide();
    await reconcile(h.ctx, T0);
    expect(await openSpan(h.ctx, T0)).toBeNull();
    expect(await lastError.get(h.ctx.chrome)).toBeNull();
    h.show();
    await reconcile(h.ctx, T0 + SECOND);
    const job = await captureDue(h.ctx, T0 + 11 * SECOND);
    expect(job).not.toBeNull();
    h.browser.navigate(h.tab.id, h.tab.url);
    if (job !== null) await storeCapture(h.ctx, job, await readTab(h.ctx, job), T0 + 12 * SECOND);
    expect(await queuedDocuments(h.ctx)).toEqual([]);
    expect(h.browser.screenshotCalls).toBe(0);
  });

  it('ignores unusable file completion values and reads through the callback-only content channel', async () => {
    const h = await phone();
    // Namespace presence is not permission: MV2 must use its permitted legacy method.
    const calls: unknown[] = [];
    Object.assign(h.browser.api.tabs, { executeScript: (tabId: number, details: unknown, callback?: (value?: unknown[]) => void) => {
      calls.push({ tabId, details });
      queueMicrotask(() => callback?.([null]));
    } });
    expect(await executeFile(h.ctx, h.tab.id, 'probe.js')).toEqual({ documentId: h.tab.documentId, visible: true, url: h.tab.url });
    expect(await executeFile(h.ctx, h.tab.id, 'capture.js')).toMatchObject({ text: 'A synthetic article.', documentId: h.tab.documentId });
    expect(calls).toEqual(Array.from({ length: 2 }, () => ({ tabId: h.tab.id, details: { file: 'probe.js', runAt: 'document_start' } })));
  });

  it('reads the current document through messages and rejects native injection errors', async () => {
    const h = await phone();
    expect(await probePage(h.ctx, h.tab.id)).toEqual({ documentId: h.tab.documentId, visible: true, url: h.tab.url });
    Object.assign(h.browser.api.tabs, { executeScript: (_tabId: number, _details: unknown, callback: (value?: unknown[]) => void) => {
      queueMicrotask(() => {
        Object.assign(h.browser.api.runtime, { lastError: { message: 'Cannot access contents of this page' } });
        callback();
        delete (h.browser.api.runtime as unknown as Record<string, unknown>)['lastError'];
      });
    } });
    await expect(executeFile(h.ctx, h.tab.id, 'probe.js')).rejects.toThrow('Cannot access contents of this page');
    expect(await probePage(h.ctx, h.tab.id)).toBeNull();
    expect(await lastError.get(h.ctx.chrome)).toEqual({ code: 'page_probe_failed', at: T0 });
    expect(JSON.stringify(h.browser.local.values.get('error'))).not.toContain('Cannot access');
  });

  it('reports a malformed probe with a fixed error code, without treating excluded pages as errors', async () => {
    const h = await phone();
    h.browser.script = () => ({ visible: true, url: h.tab.url });
    expect(await probePage(h.ctx, h.tab.id)).toBeNull();
    expect(await lastError.get(h.ctx.chrome)).toEqual({ code: 'page_probe_invalid_result', at: T0 });
    expect(JSON.stringify(h.browser.local.values.get('error'))).not.toContain(h.tab.url);
    const excluded = await phone();
    excluded.browser.navigate(excluded.tab.id, 'chrome-extension://synthetic/options.html');
    expect(await probePage(excluded.ctx, excluded.tab.id)).toBeNull();
    expect(await lastError.get(excluded.ctx.chrome)).toBeNull();
  });

  it('retains native tab lookup and query failures as fixed diagnostic codes', async () => {
    const h = await phone();
    h.browser.close(h.tab.id);
    expect(await probePage(h.ctx, h.tab.id)).toBeNull();
    expect(await lastError.get(h.ctx.chrome)).toEqual({ code: 'page_tab_failed', at: T0 });
    Object.assign(h.browser.api.tabs, { query: (_query: unknown, callback: (value?: unknown[]) => void) => {
      queueMicrotask(() => {
        Object.assign(h.browser.api.runtime, { lastError: { message: 'Synthetic failure on https://example.org/' } });
        callback();
        delete (h.browser.api.runtime as unknown as Record<string, unknown>)['lastError'];
      });
    } });
    await expect(queryTabs(h.ctx, { active: true })).rejects.toThrow('Synthetic failure');
    expect(await lastError.get(h.ctx.chrome)).toEqual({ code: 'page_query_failed', at: T0 });
    expect(JSON.stringify(h.browser.local.values.get('error'))).not.toContain('example.org');
  });

  it('uploads queued phone content within a minute and labels its report mobile', async () => {
    const h = await phone();
    await setToken(h.ctx.db, INGEST_TOKEN);
    await reconcile(h.ctx, T0);
    const job = await captureDue(h.ctx, T0 + 10 * SECOND);
    if (job !== null) await storeCapture(h.ctx, job, await readTab(h.ctx, job), T0 + 10 * SECOND);
    await uploadState.set(h.ctx.chrome, { ...INITIAL_UPLOAD, lastUploadAt: T0 });
    h.net.answer = () => new Response(JSON.stringify({ accepted_count: 1, rejected: [], denylist_patterns: [], denylist_etag: 'e1' }));
    expect(await flush(h.ctx, T0 + MINUTE, 'tick')).toMatchObject({ kind: 'sent', items: 1 });
    const body = h.net.requests[0]?.init.body;
    expect(body).toBeInstanceOf(ArrayBuffer);
    const batch = JSON.parse(await new Response(new Blob([body as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))).text()) as ReturnType<typeof batchOf>;
    expect(batch.device.mobile).toBe(true);
  });
});
