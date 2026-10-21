/** Explicit Mail, Recall and cached Home tools. Scheduling and subscription cursors belong to the MCP store. */
import { ProtocolError, type CallToolResult, type McpServer } from '@modelcontextprotocol/server';
import { ReadHomeRequestSchema, ReadHomeResponseSchema } from '@ziyixi/proto/dashboard/mcp/v1/home_service_pb';
import type { HomeService, ReadHomeResponse } from '@ziyixi/proto/dashboard/mcp/v1/home_service_wire';
import { createHttpClient, RpcStatusError, type HttpSend } from '@ziyixi/proto/http-client';
import { DocumentSchema, PageSchema, type Document } from '@ziyixi/proto/recall/ui/v1/page_pb';
import {
  ListDocumentsResponseSchema,
  RecallUiService,
  SearchPagesRequestSchema,
  SearchPagesResponseSchema,
} from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { MailReadinessService } from '@ziyixi/proto/todofy/ui/v1/mail_ready_pb';
import {
  ConvertMailItemResponseSchema,
  ListMailItemsResponseSchema,
  MailItemSchema,
  PlusService,
} from '@ziyixi/proto/todofy/ui/v1/plus_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { z } from 'zod';

export interface ContentToolEnv {
  TODOFY_MAIL: Fetcher;
  RECALL: Fetcher;
  HOME: HomeService;
}

const mailId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).refine(value => !value.startsWith('tmp-'), 'Use the saved Mail ID.');
const etag = z.string().min(1).max(64);
const pageName = z.string().regex(/^pages\/[0-9a-f]{32}$/);
const documentName = z.string().regex(/^pages\/[0-9a-f]{32}\/documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function bindingTransport(binding: Fetcher, origin: string): HttpSend {
  return call => binding.fetch(new Request(`${origin}${call.url}`, {
    method: call.httpMethod,
    ...(call.body === undefined ? {} : { body: call.body, headers: { 'content-type': 'application/json' } }),
  }));
}

export function createMailClient(env: Pick<ContentToolEnv, 'TODOFY_MAIL'>) {
  return createHttpClient(PlusService, bindingTransport(env.TODOFY_MAIL, 'https://mail.internal'));
}

export function createReadinessClient(env: Pick<ContentToolEnv, 'TODOFY_MAIL'>) {
  return createHttpClient(MailReadinessService, bindingTransport(env.TODOFY_MAIL, 'https://mail.internal'));
}

export function createRecallClient(env: Pick<ContentToolEnv, 'RECALL'>) {
  return createHttpClient(RecallUiService, bindingTransport(env.RECALL, 'https://recall.internal'));
}

/** Validates both sides of Home's generated private binding, without refreshing or controlling a source. */
export async function readHomeSnapshot(env: Pick<ContentToolEnv, 'HOME'>, afterOccurrenceSeq = 0): Promise<ReadHomeResponse> {
  const request = toWire(ReadHomeRequestSchema, fromWire(ReadHomeRequestSchema, {
    after_occurrence_seq: afterOccurrenceSeq,
  }, { strict: true }).message);
  const response = await env.HOME.readHome(request);
  return toWire(ReadHomeResponseSchema, fromWire(ReadHomeResponseSchema, response).message);
}

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  ETAG_MISMATCH: 'The Mail entry changed. Read mail_list again and review the requested collection before retrying.',
  NOT_FOUND: 'The requested record is no longer available.',
  QUERY_NOT_SEARCHABLE: 'Use a searchable phrase; one Chinese, Japanese or Korean character alone is not enough.',
  SEARCH_OVER_BUDGET: 'Recall has reached its daily read budget. Search is available after the next UTC midnight.',
  MAINTENANCE: 'The source is under maintenance. Repeat the request later; keep the same request_id for a collection.',
  UNAVAILABLE: 'The source is temporarily unavailable. Repeat the request later; keep the same request_id for a collection.',
};

async function answer(source: 'MAIL' | 'RECALL' | 'HOME', action: () => Promise<Record<string, unknown>>, collect = false): Promise<CallToolResult> {
  try {
    const result = await action();
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    const code = error instanceof RpcStatusError ? error.status.reason ?? error.status.status ?? `${source}_REQUEST_FAILED`
      : collect ? 'MAIL_COLLECTION_UNCONFIRMED' : `${source}_UNAVAILABLE`;
    const message = error instanceof RpcStatusError ? REASON_MESSAGES[code] ?? error.status.message
      : collect ? 'Could not confirm the Mail collection. Retry with the same request_id, etag and input.'
        : 'Could not read the source. Try the same read again later.';
    const result = { error: { code, message } };
    return { isError: true, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
}

/** Keep snapshot metadata and read failures while omitting image bytes from the MCP result. */
function textDocument(document: Document) {
  return { ...toWire(DocumentSchema, { ...document, screenshotWebpBase64: '', screenshotJpegBase64: '' }),
    text: document.text, text_archived: document.textArchived, content_error: document.contentError };
}

export function registerContentTools(server: McpServer, env: ContentToolEnv): void {
  const mail = createMailClient(env);
  const recall = createRecallClient(env);

  server.registerTool('mail_list', {
    title: 'List pending Mail',
    description: 'Read one page of summarized mail awaiting an owner decision, with briefs, current etags and optional category shortcuts. Reading never creates tasks. Follow next_page_token for more.',
    inputSchema: z.strictObject({ page_size: z.number().int().min(1).max(50).default(25),
      page_token: z.string().max(256).default('') }),
    annotations: readOnly,
  }, input => answer('MAIL', async () => {
    const page = await mail.listMailItems({ pageSize: input.page_size, pageToken: input.page_token });
    return { ...toWire(ListMailItemsResponseSchema, page), mail_items: page.mailItems.map(item => toWire(MailItemSchema, item)) };
  }));

  server.registerTool('mail_read', {
    title: 'Read Mail summary',
    description: 'Read one saved plain-text Mail summary. available=false means the summary is absent; it may have been deleted. Reading never creates a task.',
    inputSchema: z.strictObject({ event_id: mailId }),
    annotations: readOnly,
  }, input => answer('MAIL', async () => {
    const result = await mail.readMailSummary({ id: input.event_id });
    return { event_id: input.event_id, summary: result.summary, available: result.summary.length > 0 };
  }));

  server.registerTool('mail_collect', {
    title: 'Collect Mail into Tasks Inbox',
    description: 'Create an Inbox task from a pending Mail summary only on explicit owner instruction. Use the current mail etag. A chosen category adds its label and priority. The pending entry is consumed; its summary stays readable. For an exact retry, reuse request_id, etag and all input fields.',
    inputSchema: z.strictObject({ event_id: mailId, etag, request_id: z.uuidv4(),
      category_id: z.string().regex(/^[1-9][0-9]{0,18}$/).optional(), categories_etag: etag.optional(),
    }).refine(input => Boolean(input.category_id) === Boolean(input.categories_etag), 'Supply category_id and categories_etag together.'),
    annotations: { ...readOnly, readOnlyHint: false },
  }, input => answer('MAIL', async () => {
    const result = await mail.convertMailItem({ eventId: input.event_id, etag: input.etag, requestId: input.request_id,
      categoryId: input.category_id ?? '', categoriesEtag: input.categories_etag ?? '' });
    return { event_id: input.event_id, ...toWire(ConvertMailItemResponseSchema, result) };
  }, true));

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

  server.registerTool('cloud_status', {
    title: 'Read current cloud status',
    description: 'Read Home’s cached service states, freshness and current undismissed attention. This does not refresh providers, run a canary, dismiss attention or change a guard. Check source timestamps before treating the state as current.',
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, () => answer('HOME', async () => ({ ...await readHomeSnapshot(env) })));
}
