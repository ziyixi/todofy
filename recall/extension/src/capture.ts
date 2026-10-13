/**
 * Capture after ten seconds of foreground focus, then once a minute while the visit continues. A failed or empty
 * attempt can run again on the next tick. Reads run outside the state queue so they do not delay focus events.
 * Only successful outbox writes update the visit's snapshot hash. Private pages and visible password fields are
 * excluded before taking screenshots, and their document and focus are checked again before anything is queued.
 */
import type { IngestItem } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import { scrubText } from '../../shared/scrub.ts';
import { cutText, cutUtf8, DOCUMENT_MAX_BYTES } from '../../shared/url.ts';
import type { Context } from './context.ts';
import { captureViewport, executeFile, getTab, probePage, readInstalledPage } from './browser.ts';
import { getVisit, queueItem, saveVisit } from './db.ts';
import { loadFocus } from './focus.ts';
import { CAPTURE_FOCUS_MS, CAPTURE_INTERVAL_MS, CAPTURE_STORAGE_MAX_BYTES } from './limits.ts';
import { pageOf, type PageInfo } from './page.ts';
import { isPageText, type PageText } from './page-text.ts';
import { compressScreenshot, visiblyChanged, type Screenshot } from './screenshot.ts';
import { currentDenylist } from './settings.ts';
import { captureStatus, focusState, lastError } from './store.ts';
import { focusMs, isoTime } from './visits.ts';
import { observe } from './diagnostic.ts';

export interface CaptureJob {
  readonly visitId: string;
  readonly tabId: number;
  readonly windowId: number;
  readonly documentId: string;
  readonly focusStart: number;
  readonly page: PageInfo;
}

export type ReadOutcome =
  | { readonly kind: 'text'; readonly text: PageText; readonly screenshot?: Screenshot; readonly screenshotFailed?: boolean }
  | { readonly kind: 'not_scriptable' }
  | { readonly kind: 'failed' };

/** Chrome's refusal to script a page (the PDF viewer, the Web Store, chrome:// and extension pages). */
const NOT_SCRIPTABLE = /cannot (?:access|be scripted)/i;

async function focusedVisit(ctx: Context, at: number) {
  const { open, windowId } = await loadFocus(ctx, at);
  if (open === null) return null;
  const visit = await getVisit(ctx.db, open.visitId);
  if (visit === undefined || visit.page.level !== 'record') return null;
  return { open, windowId, visit, focus: focusMs(visit.spans) + at - open.start };
}

/** Only the first attempt needs a short timer; later attempts use the existing minute tick. */
export async function captureDelay(ctx: Context, at: number): Promise<number | null> {
  const current = await focusedVisit(ctx, at);
  if (current === null || current.visit.lastAttemptAt !== undefined) return null;
  return Math.max(0, CAPTURE_FOCUS_MS - current.focus);
}

/** Claim an attempt before reading the page; this timestamp limits attempts without marking them successful. */
export async function captureDue(ctx: Context, at: number): Promise<CaptureJob | null> {
  const current = await focusedVisit(ctx, at);
  if (current === null || current.focus < CAPTURE_FOCUS_MS) return null;
  const { open, windowId, visit } = current;
  if (visit.lastAttemptAt !== undefined && Math.floor(at / CAPTURE_INTERVAL_MS) <= Math.floor(visit.lastAttemptAt / CAPTURE_INTERVAL_MS)) return null;
  visit.lastAttemptAt = at;
  await saveVisit(ctx.db, visit);
  if ((await ctx.storageUsage()) > CAPTURE_STORAGE_MAX_BYTES) {
    await lastError.set(ctx.chrome, 'outbox_full', at);
    return null;
  }
  return { visitId: visit.id, tabId: open.tabId, windowId, documentId: open.documentId, focusStart: open.start, page: visit.page };
}

/** The same foreground span must still own the visible tab, even if a tab was switched away and back. */
async function sameFocus(ctx: Context, job: CaptureJob): Promise<boolean> {
  try {
    if (ctx.mobile) {
      const [state, tab, probe] = await Promise.all([focusState.get(ctx.chrome), getTab(ctx, job.tabId), probePage(ctx, job.tabId, job.documentId)]);
      if (state?.open?.visitId !== job.visitId || state.open.start !== job.focusStart || !tab.active || tab.incognito || !probe?.visible || probe.documentId !== job.documentId) return false;
      const page = await pageOf(probe.url, await currentDenylist(ctx));
      return page?.pageId === job.page.pageId && page.level === 'record';
    }
    const [state, window, tab, frame] = await Promise.all([
      focusState.get(ctx.chrome),
      ctx.chrome.windows.getLastFocused(),
      ctx.chrome.tabs.get(job.tabId),
      ctx.chrome.webNavigation.getFrame({ tabId: job.tabId, frameId: 0 }),
    ]);
    if (state?.idle !== 'active' || state.windowId !== job.windowId || state.open?.visitId !== job.visitId || state.open.start !== job.focusStart) return false;
    if (!window.focused || window.id !== job.windowId || !tab.active || tab.windowId !== job.windowId || tab.incognito) return false;
    if (frame?.documentId !== job.documentId || frame.documentLifecycle !== 'active') return false;
    const page = await pageOf(tab.url ?? frame.url, await currentDenylist(ctx));
    return page?.pageId === job.page.pageId && page.level === 'record';
  } catch {
    return false;
  }
}

async function readPage(ctx: Context, job: CaptureJob): Promise<PageText | null> {
  if (!ctx.mobile) {
    const value = await executeFile(ctx, job.tabId, 'capture.js', job.documentId);
    return isPageText(value) ? value : null;
  }
  const probe = await probePage(ctx, job.tabId, job.documentId);
  if (probe === null || !probe.visible) return null;
  const page = await pageOf(probe.url, await currentDenylist(ctx));
  if (page?.pageId !== job.page.pageId || page.level !== 'record') return null;
  const value = await readInstalledPage(ctx, job.tabId, { type: 'recall-capture-current', expectedDocumentId: job.documentId, url: probe.url, build: ctx.build });
  return isPageText(value) ? value : null;
}

async function allowedPage(ctx: Context, job: CaptureJob, text: PageText): Promise<boolean> {
  if (text.build !== ctx.build || text.hasPasswordField || (ctx.mobile && (text.documentId !== job.documentId || text.visible !== true))) return false;
  const page = await pageOf(text.url, await currentDenylist(ctx));
  return page?.pageId === job.page.pageId && page.level === 'record';
}

/** Text remains useful when screenshot capture or encoding fails. */
export async function readTab(ctx: Context, job: CaptureJob): Promise<ReadOutcome> {
  let text: PageText | null;
  try {
    text = await readPage(ctx, job);
  } catch (error) {
    return error instanceof Error && NOT_SCRIPTABLE.test(error.message) ? { kind: 'not_scriptable' } : { kind: 'failed' };
  }
  if (text === null) return { kind: 'failed' };
  if (!(await allowedPage(ctx, job, text)) || !(await sameFocus(ctx, job))) return { kind: 'text', text };
  try {
    const png = await captureViewport(ctx, job.windowId, job.tabId);
    if (!(await sameFocus(ctx, job))) return { kind: 'text', text };
    // An in-page sign-in dialog may have appeared without a navigation while Chrome captured the viewport.
    const after = await readPage(ctx, job);
    if (after === null || !(await allowedPage(ctx, job, after))) return { kind: 'text', text };
    const screenshot = await compressScreenshot(png);
    return screenshot === null ? { kind: 'text', text, screenshotFailed: true } : { kind: 'text', text, screenshot };
  } catch {
    return { kind: 'text', text, screenshotFailed: true };
  }
}

/** Queue changed content; an empty page or failed read leaves the next tick free to try again. */
export async function storeCapture(ctx: Context, job: CaptureJob, outcome: ReadOutcome, at: number): Promise<boolean> {
  await observe(ctx, { stage: 'capture_store', state: 'pending' }, job.tabId);
  if (outcome.kind === 'not_scriptable') {
    await observe(ctx, { stage: 'capture_store', state: 'skipped', result: 'excluded' }, job.tabId);
    await captureStatus.set(ctx.chrome, { at, text: 'excluded', screenshot: 'excluded' });
    return false;
  }
  if (outcome.kind === 'failed') {
    await observe(ctx, { stage: 'capture_store', state: 'failed', result: 'failed' }, job.tabId);
    await lastError.set(ctx.chrome, 'capture_failed', at);
    await captureStatus.set(ctx.chrome, { at, text: 'failed', screenshot: 'none' });
    return false;
  }
  const { text } = outcome;
  if (!(await allowedPage(ctx, job, text))) {
    await observe(ctx, { stage: 'capture_store', state: 'skipped', result: 'excluded' }, job.tabId);
    await captureStatus.set(ctx.chrome, { at, text: 'excluded', screenshot: 'excluded' });
    return false;
  }
  if (outcome.screenshotFailed) await lastError.set(ctx.chrome, 'screenshot_failed', at);
  const screenshot = outcome.screenshot !== undefined && await sameFocus(ctx, job) ? outcome.screenshot : undefined;
  const body = cutUtf8(scrubText(text.text), DOCUMENT_MAX_BYTES);
  let imageStatus: 'webp' | 'jpeg' | 'failed' | 'none' = outcome.screenshotFailed ? 'failed' : 'none';
  if (screenshot !== undefined) imageStatus = screenshot.mediaType === 'image/jpeg' ? 'jpeg' : 'webp';
  if (body.text.trim() === '' && screenshot === undefined) {
    await observe(ctx, { stage: 'capture_store', state: 'returned', result: 'empty' }, job.tabId);
    await captureStatus.set(ctx.chrome, { at, text: 'empty', screenshot: imageStatus });
    return false;
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.text)));
  const snapshotTextHash = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const visit = await getVisit(ctx.db, job.visitId);
  if (visit?.snapshotTextHash === snapshotTextHash && (screenshot === undefined || !visiblyChanged(visit.screenshotPreview, screenshot.preview))) {
    await observe(ctx, { stage: 'capture_store', state: 'returned', result: 'unchanged' }, job.tabId);
    await captureStatus.set(ctx.chrome, { at, text: 'unchanged', screenshot: imageStatus });
    return false;
  }
  const id = ctx.uuid();
  const item: IngestItem = {
    kind: 'document',
    document: {
      id,
      visit_id: job.visitId,
      page_id: job.page.pageId,
      url: job.page.url,
      ...(job.page.urlTruncated ? { url_truncated: true } : {}),
      title: cutText(scrubText(text.title)),
      description: cutText(scrubText(text.description)),
      capture_time: isoTime(at),
      text: body.text,
      ...(text.textTruncated || body.truncated ? { text_truncated: true } : {}),
      ...(screenshot === undefined ? {} : { ...(screenshot.mediaType === 'image/jpeg' ? { screenshot_jpeg_base64: screenshot.base64 } : { screenshot_webp_base64: screenshot.base64 }), screenshot_width: screenshot.width, screenshot_height: screenshot.height }),
    },
  };
  await queueItem(ctx.db, { id, kind: 'document', json: JSON.stringify(item), version: 1 }, at);
  await observe(ctx, { stage: 'capture_store', state: 'returned', result: 'saved' }, job.tabId);
  await captureStatus.set(ctx.chrome, { at, text: body.text.trim() === '' ? 'empty' : 'saved', screenshot: imageStatus });
  if (visit !== undefined) await saveVisit(ctx.db, { ...visit, snapshotTextHash, ...(screenshot === undefined ? {} : { screenshotPreview: screenshot.preview }) });
  return true;
}
