/**
 * Rows of RecallState's SQLite as messages of the owner API (proto/recall/ui/v1/page.proto): pages, visits, captured
 * texts and sites. Titles, URLs and texts are untrusted, scrubbed text, which the UI shows as text only.
 */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt';
import { DocumentSchema, FocusSpanSchema, PageSchema, SiteSchema, VisitSchema, type Document, type Page, type Site, type Visit } from '@ziyixi/proto/recall/ui/v1/page_pb';
import { blobKey } from './blobs.ts';
import { spansOf } from './feed.ts';
import { INDEXED_TEXT_MAX_BYTES } from './limits.ts';
import { hostOfKey, type DocumentRow, type PageRow, type SiteRow, type VisitRow } from './store.ts';

/** A timestamp, or undefined for a missing time (the field is then left unset). */
export function time(ms: number | null): Timestamp | undefined {
  return ms === null ? undefined : timestampFromMs(ms);
}

export function pageMessage(row: PageRow): Page {
  return create(PageSchema, {
    name: `pages/${row.id}`,
    url: row.url,
    title: row.title,
    site: hostOfKey(row.host_key),
    firstVisitTime: time(row.first_visit_ms),
    lastVisitTime: time(row.last_visit_ms),
    visitCount: row.visit_count,
    focusSeconds: row.focus_seconds,
    documentCount: row.document_count,
    latestCaptureTime: time(row.latest_capture_ms),
    textIndexed: row.text_indexed > 0,
    latestDocument: row.latest_document === null ? '' : `pages/${row.id}/documents/${row.latest_document}`,
    urlTruncated: row.url_truncated === 1,
  });
}

/** A visit row joined to its live page (its ID and host_key). */
export function visitMessage(row: VisitRow & { readonly page_id: string; readonly host_key: string }): Visit {
  return create(VisitSchema, {
    name: `pages/${row.page_id}/visits/${row.id}`,
    url: row.url,
    title: row.title,
    site: hostOfKey(row.host_key),
    deviceLabel: row.device_label,
    startTime: timestampFromMs(row.start_ms),
    endTime: timestampFromMs(row.end_ms),
    focusSeconds: row.focus_seconds,
    focusSpans: spansOf(row).map(([start, end]) => create(FocusSpanSchema, { startTime: timestampFromMs(start), endTime: timestampFromMs(end) })),
  });
}

/**
 * A captured text's message: `text` is the text R2 holds, '' for one the retention window moved to the Dropbox archive
 * alone (then `archive_path` names where the archive keeps it: the same path as its R2 key).
 */
export function documentMessage(row: DocumentRow, pageId: string, text = '', screenshot = '', contentError = ''): Document {
  const archived = row.archived_ms !== null;
  return create(DocumentSchema, {
    name: `pages/${pageId}/documents/${row.id}`,
    captureTime: timestampFromMs(row.capture_ms),
    title: row.title,
    description: row.description,
    deviceLabel: row.device_label,
    textBytes: row.text_bytes,
    textTruncated: row.truncated === 1,
    text,
    screenshotWebpBase64: screenshot,
    screenshotWidth: row.screenshot_width,
    screenshotHeight: row.screenshot_height,
    contentError,
    visit: `pages/${pageId}/visits/${row.visit}`,
    searchTruncated: row.text_bytes > INDEXED_TEXT_MAX_BYTES,
    textArchived: archived,
    archivePath: archived ? blobKey(row.blob_path) : '',
  });
}

export function siteMessage(row: SiteRow): Site {
  return create(SiteSchema, {
    name: `sites/${row.host}`,
    firstVisitTime: time(row.first_visit_ms),
    lastVisitTime: time(row.last_visit_ms),
    visitCount: row.visit_count,
    focusSeconds: row.focus_seconds,
  });
}
