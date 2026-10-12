/** iPhone behavior over the existing fake: visibility ends focus, reload changes identity, JPEG and resume uploads. */
import { describe, expect, it, vi } from 'vitest';
import { executeFile } from '../src/browser.ts';
import { captureDue, readTab, storeCapture } from '../src/capture.ts';
import type { Context } from '../src/context.ts';
import { setToken } from '../src/db.ts';
import { beat, pageVisibility, reconcile } from '../src/focus.ts';
import { compressScreenshot } from '../src/screenshot.ts';
import { INITIAL_UPLOAD, uploadState } from '../src/store.ts';
import { batchOf, flush } from '../src/upload.ts';
import { harness, INGEST_TOKEN, MINUTE, SECOND, T0 } from './fake-chrome.ts';
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
  // iOS does not supply these desktop namespaces or Chrome document/lifecycle metadata.
  const api = h.browser.api as unknown as Record<string, unknown>;
  delete api['windows'];
  delete api['idle'];
  delete api['webNavigation'];
  return { ...h, ctx, tab, hide: () => { visible = false; }, show: () => { visible = true; } };
}

describe('Orion iPhone foreground capture', () => {
  it('captures visible text/JPEG at ten seconds, omits unchanged content and stops at pagehide', async () => {
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
    await capture(T0 + MINUTE);
    expect(await queuedDocuments(h.ctx)).toHaveLength(1);
    expect((await queuedDocuments(h.ctx))[0]).toMatchObject({ screenshot_jpeg_base64: 'cGhvdG8=', screenshot_width: 390, screenshot_height: 844 });
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
    h.show();
    await reconcile(h.ctx, T0 + SECOND);
    const job = await captureDue(h.ctx, T0 + 11 * SECOND);
    expect(job).not.toBeNull();
    h.browser.navigate(h.tab.id, h.tab.url);
    if (job !== null) await storeCapture(h.ctx, job, await readTab(h.ctx, job), T0 + 12 * SECOND);
    expect(await queuedDocuments(h.ctx)).toEqual([]);
    expect(h.browser.screenshotCalls).toBe(0);
  });

  it('can inject only top-frame files through MV2 tabs.executeScript', async () => {
    const h = await phone();
    // Namespace presence is not permission: MV2 must use its permitted legacy method.
    const calls: unknown[] = [];
    Object.assign(h.browser.api.tabs, { executeScript: (tabId: number, details: unknown) => { calls.push({ tabId, details }); return Promise.resolve([{ probe: true }]); } });
    expect(await executeFile(h.ctx, h.tab.id, 'probe.js')).toEqual({ probe: true });
    expect(calls).toEqual([{ tabId: h.tab.id, details: { file: 'probe.js', frameId: 0, runAt: 'document_start' } }]);
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
