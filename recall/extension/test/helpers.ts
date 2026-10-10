/** Reading the extension's state back in the tests: the outbox's items as recall.ingest.v1 JSON, the open visits. */
import type { DocumentItem, IngestItem, VisitItem } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import type { Context } from '../src/context.ts';
import { allVisits, oldestItems } from '../src/db.ts';
import { loadFocus } from '../src/focus.ts';

export async function outbox(ctx: Context): Promise<IngestItem[]> {
  return (await oldestItems(ctx.db, 10_000, Number.MAX_SAFE_INTEGER, ctx.now())).map((item) => JSON.parse(item.json) as IngestItem);
}

export async function queuedVisits(ctx: Context): Promise<VisitItem[]> {
  return (await outbox(ctx)).flatMap((item) => (item.kind === 'visit' ? [item.visit] : []));
}

export async function queuedDocuments(ctx: Context): Promise<DocumentItem[]> {
  return (await outbox(ctx)).flatMap((item) => (item.kind === 'document' ? [item.document] : []));
}

/** A visit's spans as [start, end] milliseconds. */
export function spansOf(visit: VisitItem): [number, number][] {
  return visit.focus_spans.map((span) => [Date.parse(span.start_time), Date.parse(span.end_time)]);
}

export async function openVisits(ctx: Context) {
  return allVisits(ctx.db);
}

export async function openSpan(ctx: Context, at: number) {
  return (await loadFocus(ctx, at)).open;
}
