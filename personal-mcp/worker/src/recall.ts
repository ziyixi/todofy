/** Recall text, activity and screenshot reads over its existing private API. */
import type { McpServer } from '@modelcontextprotocol/server';
import { createHttpClient } from '@ziyixi/proto/http-client';
import { DocumentSchema, PageSchema, type Document } from '@ziyixi/proto/recall/ui/v1/page_pb';
import {
  ListDocumentsResponseSchema, ListVisitsRequestSchema, ListVisitsResponseSchema,
  RecallUiService, SearchPagesRequestSchema, SearchPagesResponseSchema,
} from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { z } from 'zod';
import { answer, bindingTransport } from './source-tools.ts';

export interface RecallToolEnv { RECALL: Fetcher }
const pageName = z.string().regex(/^pages\/[0-9a-f]{32}$/);
const documentName = z.string().regex(/^pages\/[0-9a-f]{32}\/documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createRecallClient(env: RecallToolEnv) {
  return createHttpClient(RecallUiService, bindingTransport(env.RECALL, 'https://recall.internal'));
}

/** Keep snapshot metadata and read failures while omitting image bytes from the MCP result. */
function textDocument(document: Document) {
  return { ...toWire(DocumentSchema, { ...document, screenshotWebpBase64: '', screenshotJpegBase64: '' }),
    text: document.text, text_archived: document.textArchived, content_error: document.contentError };
}

export function registerRecallTools(server: McpServer, env: RecallToolEnv): void {
  const recall = createRecallClient(env);

  server.registerTool('recall_search', {
    title: 'Search Recall',
    description: 'Search recorded pages and their indexed text with explicit filters. query contains words or quoted phrases; site and time filters have their own fields. Results are bounded; candidates_capped means some matches may be missing. Older archived text may have no snippet. Reading never changes the browsing record.',
    inputSchema: z.strictObject({
      query: z.string().max(200).default(''), site: z.string().max(253).default(''),
      start_time: z.iso.datetime({ offset: true }).optional(), end_time: z.iso.datetime({ offset: true }).optional(),
      page_type: z.enum(['all', 'read']).default('all'), sort_order: z.enum(['default', 'relevance', 'recent']).default('default'),
      min_focus_seconds: z.number().int().min(0).max(86400).default(0),
      page_size: z.number().int().min(1).max(10).default(10), page_token: z.string().max(4096).default(''),
    }),
    annotations: readOnly,
  }, input => answer('RECALL', async () => {
    const request = fromWire(SearchPagesRequestSchema, {
      query: input.query, site: input.site, min_focus_seconds: input.min_focus_seconds,
      page_size: input.page_size, page_token: input.page_token,
      ...(input.start_time ? { start_time: input.start_time } : {}), ...(input.end_time ? { end_time: input.end_time } : {}),
      ...(input.page_type === 'read' ? { page_type: 'read' } : {}),
      ...(input.sort_order === 'default' ? {} : { sort_order: input.sort_order }),
    }, { strict: true }).message;
    const page = await recall.searchPages(request);
    const result = toWire(SearchPagesResponseSchema, page);
    return { ...result, results: result['results'] ?? [],
      candidates_capped: page.candidatesCapped };
  }));

  server.registerTool('recall_read', {
    title: 'Read Recall page and snapshot',
    description: 'Read a page and one bounded page of snapshot metadata. Read the selected document, or the latest capture by default, as plain text. Archived reads use Recall’s verified Dropbox path. Image bytes are omitted. content_error and truncation/archive fields describe incomplete or unavailable content; do not infer success from empty text.',
    inputSchema: z.strictObject({ page: pageName, document: documentName.optional(),
      document_page_size: z.number().int().min(1).max(20).default(10),
      document_page_token: z.string().max(4096).default(''),
    }).refine(input => input.document === undefined || input.document.startsWith(`${input.page}/documents/`), 'The document must belong to the selected page.'),
    annotations: readOnly,
  }, input => answer('RECALL', async () => {
    const [page, documents] = await Promise.all([
      recall.getPage({ name: input.page }),
      recall.listDocuments({ parent: input.page, pageSize: input.document_page_size, pageToken: input.document_page_token }),
    ]);
    const selected = input.document ?? page.latestDocument;
    const document = selected ? await recall.getDocument({ name: selected }) : undefined;
    const listed = toWire(ListDocumentsResponseSchema, documents);
    return { page: toWire(PageSchema, page), ...listed,
      documents: documents.documents.map(textDocument), document: document ? textDocument(document) : null };
  }));

  server.registerTool('recall_activity', {
    title: 'Read Recall activity',
    description: 'Read one chronological page of recorded foreground visits, with timestamps, focus duration and device. This is captured history, not a live screen. Follow next_page_token with the same filters.',
    inputSchema: z.strictObject({
      start_time: z.iso.datetime({ offset: true }).optional(),
      end_time: z.iso.datetime({ offset: true }).optional(),
      device_id: z.uuid().optional(),
      page_size: z.number().int().min(1).max(100).default(25),
      page_token: z.string().max(4096).default(''),
    }).refine(input => !input.start_time || !input.end_time || Date.parse(input.start_time) < Date.parse(input.end_time),
      'end_time must follow start_time.'),
    annotations: readOnly,
  }, input => answer('RECALL', async () => {
    const request = fromWire(ListVisitsRequestSchema, {
      parent: 'pages/-', order_by: 'start_time desc', page_size: input.page_size, page_token: input.page_token,
      ...(input.start_time ? { start_time: input.start_time } : {}),
      ...(input.end_time ? { end_time: input.end_time } : {}),
      ...(input.device_id ? { device_id: input.device_id } : {}),
    }, { strict: true }).message;
    const activity = await recall.listVisits(request);
    const result = toWire(ListVisitsResponseSchema, activity);
    return { ...result, visits: result['visits'] ?? [] };
  }));

  server.registerTool('recall_view', {
    title: 'View a Recall screenshot',
    description: 'Return one captured viewport screenshot as actual MCP image content with its capture time. Uses the selected snapshot or the latest capture, including verified Dropbox cold reads. Missing images and content_error stay explicit; this never captures a new screen.',
    inputSchema: z.strictObject({ page: pageName, document: documentName.optional() })
      .refine(input => input.document === undefined || input.document.startsWith(`${input.page}/documents/`),
        'The document must belong to the selected page.'),
    annotations: readOnly,
  }, async input => {
    let screenshot: { data: string; mimeType: string } | undefined;
    const reply = await answer('RECALL', async () => {
      const page = await recall.getPage({ name: input.page });
      const selected = input.document ?? page.latestDocument;
      if (!selected) return { page: input.page, document: null, image_available: false, reason: 'no_capture' };
      const document = await recall.getDocument({ name: selected });
      if (document.screenshotWebpBase64) screenshot = { data: document.screenshotWebpBase64, mimeType: 'image/webp' };
      else if (document.screenshotJpegBase64) screenshot = { data: document.screenshotJpegBase64, mimeType: 'image/jpeg' };
      const metadata = toWire(DocumentSchema, document);
      delete metadata['screenshot_webp_base64'];
      delete metadata['screenshot_jpeg_base64'];
      delete metadata['text'];
      return { page: input.page, document: metadata, image_available: screenshot !== undefined,
        ...(screenshot ? {} : { reason: document.contentError || 'no_screenshot' }) };
    });
    return screenshot && !reply.isError
      ? { ...reply, content: [...reply.content, { type: 'image' as const, ...screenshot }] }
      : reply;
  });
}
