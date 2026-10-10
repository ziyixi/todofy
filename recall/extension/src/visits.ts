/**
 * Visits (../../docs/design.md §3.3): one document in one tab on one page (a pushState to another URL starts a new
 * visit, a fragment change does not), with its focus spans. A visit ends when its tab leaves the page or closes, after
 * 30 minutes without focus, 6 hours after its first focus or at 200 spans; the next focus starts a new one. Only a visit
 * with at least a second of focus is ever uploaded: background tabs, redirects and pages closed unseen leave nothing.
 *
 * A visit is queued when it ends, when its tab loses the focus, and every 30 minutes while it lasts, each time only if
 * it changed and with the next revision; the outbox keeps its newest revision only.
 */
import type { IngestItem } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import type { Context } from './context.ts';
import { deleteVisit, queueItem, type Visit } from './db.ts';
import { SPANS_MAX, VISIT_MAX_MS, VISIT_MIN_FOCUS_MS, VISIT_UNFOCUSED_MS } from './limits.ts';
import type { PageInfo } from './page.ts';

export const isoTime = (ms: number): string => new Date(ms).toISOString();

/** The focus of closed spans, in milliseconds. */
export function focusMs(spans: readonly (readonly [number, number])[]): number {
  return spans.reduce((sum, [start, end]) => sum + end - start, 0);
}

export function newVisit(id: string, tabId: number, documentId: string, page: PageInfo, title: string, at: number): Visit {
  return { id, tabId, documentId, page, title, spans: [], revision: 0, changed: false, queuedAt: at, captured: false };
}

/** When the visit's first focus began, or `fallback` before it has a span. */
export function firstFocus(visit: Visit, fallback: number): number {
  return visit.spans[0]?.[0] ?? fallback;
}

/**
 * Whether a visit can take no further focus at `at`: 30 minutes without focus (since its last span, or since it began
 * when it never had a span), 6 hours after its first focus, or 200 spans.
 */
export function visitOver(visit: Visit, at: number): boolean {
  const lastFocus = visit.spans[visit.spans.length - 1]?.[1] ?? visit.queuedAt;
  return visit.spans.length >= SPANS_MAX || at - lastFocus >= VISIT_UNFOCUSED_MS || at - firstFocus(visit, at) >= VISIT_MAX_MS;
}

/** A visit as recall.ingest.v1's item. */
export function visitItem(visit: Visit): IngestItem {
  return {
    kind: 'visit',
    visit: {
      id: visit.id,
      revision: visit.revision,
      page_id: visit.page.pageId,
      url: visit.page.url,
      ...(visit.page.urlTruncated ? { url_truncated: true } : {}),
      title: visit.title,
      focus_spans: visit.spans.map(([start, end]) => ({ start_time: isoTime(start), end_time: isoTime(end) })),
    },
  };
}

/** Queues the visit's next revision when it changed and had a second of focus; the caller saves the visit. */
export async function queueVisit(ctx: Context, visit: Visit, at: number): Promise<void> {
  if (!visit.changed || focusMs(visit.spans) < VISIT_MIN_FOCUS_MS) return;
  visit.revision += 1;
  visit.changed = false;
  visit.queuedAt = at;
  await queueItem(ctx.db, { id: visit.id, kind: 'visit', json: JSON.stringify(visitItem(visit)), version: visit.revision }, at);
}

/** Ends a visit that has no open span: its last revision queued, the visit out of the open visits. */
export async function endVisit(ctx: Context, visit: Visit, at: number): Promise<void> {
  await queueVisit(ctx, visit, at);
  await deleteVisit(ctx.db, visit.id);
}
