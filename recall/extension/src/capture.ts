/**
 * Captures (../../docs/design.md §3.4): when a visit's focus reaches ten seconds, its page's text is read once, if the
 * page was not captured today (UTC) and its level lets recall keep its text, by injecting capture.js into exactly that
 * visit's document. A page with a visible password field gives no text; a page Chrome does not let an extension script
 * (the PDF viewer, the Web Store, another extension) is a visit without text; any other failure is the device's
 * `capture_failed`. Past 200 MB of storage the extension stops capturing (visits continue).
 *
 * The capture runs in three steps so that a slow page never holds up the focus events: `captureDue` (with the state)
 * claims the visit's one capture, `readTab` runs the script, `storeCapture` (with the state again) queues the text,
 * only when the document is still on the claimed visit's page and that page still keeps its text: an SPA's route
 * change keeps the document, so the script may have read another route (a settings or account page among them).
 */
import type { IngestItem } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import { scrubText } from '../../shared/scrub.ts';
import { cutText, cutUtf8, DOCUMENT_MAX_BYTES } from '../../shared/url.ts';
import type { Context } from './context.ts';
import { getVisit, queueItem, saveVisit } from './db.ts';
import { loadFocus } from './focus.ts';
import { CAPTURE_FOCUS_MS, CAPTURE_KEY_DAYS, CAPTURE_STORAGE_MAX_BYTES, DAY } from './limits.ts';
import type { PageInfo } from './page.ts';
import { pageOf } from './page.ts';
import { isPageText, type PageText } from './page-text.ts';
import { currentDenylist } from './settings.ts';
import { capturedKeys, lastError } from './store.ts';
import { focusMs, isoTime } from './visits.ts';

export interface CaptureJob {
  readonly visitId: string;
  readonly tabId: number;
  readonly documentId: string;
  readonly page: PageInfo;
  /** `<UTC day>:<page id>`: at most one capture of a page a day. */
  readonly key: string;
}

export type ReadOutcome = { readonly kind: 'text'; readonly text: PageText } | { readonly kind: 'not_scriptable' } | { readonly kind: 'failed' };

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Chrome's refusal to script a page (the PDF viewer, the Web Store, chrome:// and extension pages). */
const NOT_SCRIPTABLE = /cannot (?:access|be scripted)/i;

/** The open span's visit when its page's capture is still to be decided (a page that keeps its text, not captured in it). */
async function pendingVisit(ctx: Context, at: number) {
  const { open } = await loadFocus(ctx, at);
  if (open === null) return null;
  const visit = await getVisit(ctx.db, open.visitId);
  if (visit === undefined || visit.captured || visit.page.level !== 'record') return null;
  return { open, visit, focus: focusMs(visit.spans) + at - open.start };
}

/** Milliseconds until the focused visit's capture is due, or null when it has none to come. */
export async function captureDelay(ctx: Context, at: number): Promise<number | null> {
  const pending = await pendingVisit(ctx, at);
  return pending === null ? null : Math.max(0, CAPTURE_FOCUS_MS - pending.focus);
}

/** The capture due now, claimed (a visit captures once), or null. */
export async function captureDue(ctx: Context, at: number): Promise<CaptureJob | null> {
  const pending = await pendingVisit(ctx, at);
  if (pending === null || pending.focus < CAPTURE_FOCUS_MS) return null;
  const { open, visit } = pending;
  visit.captured = true;
  await saveVisit(ctx.db, visit);
  const key = `${utcDay(at)}:${visit.page.pageId}`;
  if ((await capturedKeys.get(ctx.chrome)).includes(key)) return null;
  if ((await ctx.storageUsage()) > CAPTURE_STORAGE_MAX_BYTES) {
    await lastError.set(ctx.chrome, 'outbox_full', at);
    return null;
  }
  return { visitId: visit.id, tabId: open.tabId, documentId: open.documentId, page: visit.page, key };
}

/** Runs capture.js in the visit's document (its isolated world). */
export async function readTab(ctx: Context, job: CaptureJob): Promise<ReadOutcome> {
  try {
    const [first] = await ctx.chrome.scripting.executeScript({ target: { tabId: job.tabId, documentIds: [job.documentId] }, files: ['capture.js'] });
    const value: unknown = first?.result;
    return isPageText(value) ? { kind: 'text', text: value } : { kind: 'failed' };
  } catch (error) {
    return error instanceof Error && NOT_SCRIPTABLE.test(error.message) ? { kind: 'not_scriptable' } : { kind: 'failed' };
  }
}

/** Remembers today's capture of a page, keeping the keys of today and yesterday only. */
async function remember(ctx: Context, key: string, at: number): Promise<void> {
  const oldest = utcDay(at - (CAPTURE_KEY_DAYS - 1) * DAY);
  const kept = (await capturedKeys.get(ctx.chrome)).filter((existing) => existing.slice(0, 10) >= oldest && existing !== key);
  await capturedKeys.set(ctx.chrome, [...kept, key]);
}

/** Queues a captured text, scrubbed and cut again (a scrub may lengthen it). */
export async function storeCapture(ctx: Context, job: CaptureJob, outcome: ReadOutcome, at: number): Promise<void> {
  if (outcome.kind === 'not_scriptable') return;
  if (outcome.kind === 'failed') {
    await lastError.set(ctx.chrome, 'capture_failed', at);
    return;
  }
  const { text } = outcome;
  // A script of another build: this worker reloads within the minute, and the next visit captures again.
  if (text.build !== ctx.build) return;
  // The document moved to another page (an SPA's route) since the capture was claimed: that page's visit captures it.
  const now = await pageOf(text.url, await currentDenylist(ctx));
  if (now?.pageId !== job.page.pageId || now.level !== 'record') return;
  await remember(ctx, job.key, at);
  if (text.hasPasswordField) return;
  const body = cutUtf8(scrubText(text.text), DOCUMENT_MAX_BYTES);
  if (body.text.trim() === '') return;
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
    },
  };
  await queueItem(ctx.db, { id, kind: 'document', json: JSON.stringify(item), version: 1 }, at);
}
