import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { ReadHomeRequest, ReadHomeResponse } from '@ziyixi/proto/dashboard/mcp/v1/home_service_wire';
import { afterEach, expect, it } from 'vitest';
import {
  createMailClient,
  createReadinessClient,
  createRecallClient,
  readHomeSnapshot,
  registerContentTools,
  type ContentToolEnv,
} from '../src/content.ts';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const PAGE = 'pages/00000000000000000000000000000001';
const DOCUMENT = `${PAGE}/documents/00000000-0000-4000-8000-000000000002`;
const AT = '2026-10-20T12:00:00Z';
const handlers: ReturnType<typeof createMcpHandler>[] = [];
afterEach(async () => { await Promise.all(handlers.splice(0).map(handler => handler.close())); });

interface NativeRequest {
  source: 'mail' | 'recall';
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}
interface Sources {
  mail?: (request: NativeRequest) => Response | Promise<Response>;
  recall?: (request: NativeRequest) => Response | Promise<Response>;
  home?: (request: ReadHomeRequest) => Promise<ReadHomeResponse>;
}

function homeSnapshot(): ReadHomeResponse {
  return { generated_at: AT, build: 'synthetic', rev: 3,
    refresh: { last_tick_at: AT, next_tick_at: '2026-10-20T12:30:00Z', last_refresh_at: null, next_refresh_at: AT, refreshed: false },
    entries: [{ id: 'recall', level: 'warning', reason: 'archive_not_connected', checked_at: AT,
      consecutive_failures: 0, top_signals: [], metric: null }],
    attention: [{ occurrence_seq: 7, item: { source: 'recall', code: 'archive_not_connected', severity: 'warning',
      since: AT, metrics: {}, target: { view: 'ops', entry: 'recall' } } }],
    head_seq: 8, control_unavailable_count: 0 };
}

function tools(sources: Sources = {}) {
  const seen: NativeRequest[] = [];
  const homeReads: ReadHomeRequest[] = [];
  const binding = (source: 'mail' | 'recall') => ({ async fetch(request: Request) {
    const url = new URL(request.url);
    const call: NativeRequest = { source, method: request.method, path: url.pathname, query: url.searchParams,
      body: request.method === 'GET' ? {} : await request.json<Record<string, unknown>>() };
    seen.push(call);
    const backend = sources[source];
    if (!backend) throw new Error('Unexpected synthetic source request');
    return backend(call);
  } } as unknown as Fetcher);
  const env: ContentToolEnv = { TODOFY_MAIL: binding('mail'), RECALL: binding('recall'), HOME: {
    readHome(request) {
      homeReads.push(request);
      return sources.home?.(request) ?? Promise.resolve(homeSnapshot());
    },
  } };
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'synthetic-content', version: '1.0.0' }, { capabilities: { tools: {} } });
    registerContentTools(server, env);
    return server;
  }, { legacy: 'reject' });
  handlers.push(handler);
  return { env, seen, homeReads,
    async call(name: string, args: Record<string, unknown> = {}) {
      const response = await handler.fetch(new Request('https://mcp.example.org/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args,
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'synthetic', version: '1' } } } }),
      }));
      return response.json<{ result?: CallToolResult; error?: { code: number; message: string } }>();
    },
  };
}

function refusal(reason: string, message = 'Synthetic source refusal', status = 409) {
  return Response.json({ error: { code: status, status: 'ABORTED', message,
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'synthetic.example.org' }] } }, { status });
}

it('lists pending Mail and reads its saved summary through generated read routes', async () => {
  const client = tools({ mail: request => Response.json(request.path.endsWith(':readMailSummary')
    ? { summary: 'Synthetic mail summary.' }
    : { mail_items: [{ id: 'event-one', title: 'Synthetic mail', brief: 'Synthetic brief.', etag: 'current', has_summary: true,
      receive_time: AT }], next_page_token: 'cursor-next', categories: [{ id: '2', label: { provider: 'tasks', external_id: 'label' }, priority: 'p2' }], categories_etag: 'categories-current' }) });
  const listed = await client.call('mail_list', { page_size: 7, page_token: 'cursor-before' });
  expect(listed.result?.structuredContent).toMatchObject({ mail_items: [{ id: 'event-one', etag: 'current' }],
    categories: [{ id: '2', priority: 'p2' }], categories_etag: 'categories-current', next_page_token: 'cursor-next' });
  expect((await client.call('mail_read', { event_id: 'event-one' })).result?.structuredContent).toEqual({
    event_id: 'event-one', summary: 'Synthetic mail summary.', available: true,
  });
  expect(client.seen.map(request => [request.method, request.path, Object.fromEntries(request.query)])).toEqual([
    ['GET', '/api/plus/v1/mailItems', { page_size: '7', page_token: 'cursor-before' }],
    ['GET', '/api/plus/v1/mailItems:readMailSummary', { id: 'event-one' }],
  ]);
});

it('retains Mail collection identity across a lost reply and exposes stale etags', async () => {
  const receipts = new Map<string, { input: string; result: { task: { id: string; title: string; project_id: string } } }>();
  const tasks = new Map<string, unknown>();
  let loseReply = true;
  const backend = (request: NativeRequest) => {
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/api/plus/v1/mailItems:convertMailItem');
    const requestId = String(request.body['request_id']);
    const serialized = JSON.stringify(request.body);
    const previous = receipts.get(requestId);
    if (previous) return previous.input === serialized ? Response.json(previous.result) : refusal('BAD_REQUEST');
    if (request.body['etag'] !== 'current') return refusal('ETAG_MISMATCH');
    const result = { task: { id: 'native-inbox-task', title: 'Synthetic mail', project_id: '' } };
    tasks.set(result.task.id, result);
    receipts.set(requestId, { input: serialized, result });
    if (loseReply) { loseReply = false; throw new Error('Synthetic lost reply with private detail'); }
    return Response.json(result);
  };
  const input = { event_id: 'event-one', etag: 'current', request_id: REQUEST_ID,
    category_id: '2', categories_etag: 'categories-current' };
  const first = tools({ mail: backend });
  expect((await first.call('mail_collect', input)).result).toMatchObject({ isError: true,
    structuredContent: { error: { code: 'MAIL_COLLECTION_UNCONFIRMED' } } });
  const restarted = tools({ mail: backend });
  expect((await restarted.call('mail_collect', input)).result?.structuredContent).toMatchObject({ task: { id: 'native-inbox-task' } });
  expect([...tasks.keys()]).toEqual(['native-inbox-task']);
  expect(restarted.seen[0]?.body).toEqual(input);
  const stale = await restarted.call('mail_collect', { ...input, etag: 'stale', request_id: '00000000-0000-4000-8000-000000000003' });
  expect(stale.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'ETAG_MISMATCH' } } });
  expect(JSON.stringify(stale.result?.content)).toContain('Read mail_list again');
  expect([...tasks.keys()]).toEqual(['native-inbox-task']);
});

it('maps bounded Recall selectors and preserves incomplete-search evidence', async () => {
  const client = tools({ recall: () => Response.json({ results: [{ page: PAGE, title: 'Synthetic reference',
    url: 'https://docs.example.com/guide', has_text: true }], next_page_token: 'next', candidates_capped: true }) });
  const result = await client.call('recall_search', { query: 'durable objects', site: 'docs.example.com',
    start_time: AT, end_time: '2026-10-21T12:00:00Z', page_type: 'read', sort_order: 'recent',
    min_focus_seconds: 60, page_size: 3, page_token: 'before' });
  expect(result.result?.structuredContent).toMatchObject({ results: [{ page: PAGE, has_text: true }],
    candidates_capped: true, next_page_token: 'next' });
  expect(client.seen.map(request => [request.method, request.path, Object.fromEntries(request.query)])).toEqual([
    ['GET', '/api/v1/pages:search', { query: 'durable objects', site: 'docs.example.com', start_time: AT,
      end_time: '2026-10-21T12:00:00Z', page_type: 'read', sort_order: 'recent', min_focus_seconds: '60',
      page_size: '3', page_token: 'before' }],
  ]);
});

it('reads selected archived snapshot text and preserves read failures without image bytes', async () => {
  let missing = false;
  const client = tools({ recall: request => {
    if (request.path.endsWith('/documents')) return Response.json({ documents: [{ name: DOCUMENT, text_archived: true }], next_page_token: 'older-documents' });
    if (request.path.includes('/documents/')) return Response.json({ name: DOCUMENT, text: missing ? '' : 'Synthetic archived text.',
      text_bytes: 24, text_archived: true, archive_path: 'blobs/2026/10/synthetic.txt.gz', search_truncated: true,
      content_error: missing ? 'dropbox_not_connected' : '', screenshot_webp_base64: 'SYNTHETIC_WEBP_BYTES',
      screenshot_jpeg_base64: 'SYNTHETIC_JPEG_BYTES', screenshot_width: 1, screenshot_height: 1 });
    return Response.json({ name: PAGE, title: 'Synthetic reference', document_count: 1, latest_document: DOCUMENT });
  } });
  const result = await client.call('recall_read', { page: PAGE, document: DOCUMENT,
    document_page_size: 4, document_page_token: 'before-documents' });
  expect(result.result?.structuredContent).toMatchObject({ page: { name: PAGE }, next_page_token: 'older-documents',
    document: { name: DOCUMENT, text: 'Synthetic archived text.', text_archived: true, search_truncated: true,
      content_error: '', archive_path: 'blobs/2026/10/synthetic.txt.gz', screenshot_width: 1 } });
  const serialized = JSON.stringify(result.result?.structuredContent);
  expect(serialized).not.toContain('SYNTHETIC_WEBP_BYTES');
  expect(serialized).not.toContain('SYNTHETIC_JPEG_BYTES');
  expect(serialized).not.toContain('screenshot_webp_base64');
  expect(serialized).not.toContain('screenshot_jpeg_base64');
  expect(client.seen.find(request => request.path.endsWith('/documents'))?.query.get('page_size')).toBe('4');
  expect(client.seen.find(request => request.path.endsWith('/documents'))?.query.get('page_token')).toBe('before-documents');
  missing = true;
  expect((await client.call('recall_read', { page: PAGE })).result?.structuredContent).toMatchObject({
    document: { text: '', text_archived: true, content_error: 'dropbox_not_connected' },
  });
  expect(client.seen.every(request => request.method === 'GET')).toBe(true);
});

it('reports empty sources and a page without snapshots explicitly', async () => {
  const client = tools({ mail: () => Response.json({}), recall: request => Response.json(
    request.path.endsWith(':search') || request.path.endsWith('/documents') ? {} : { name: PAGE }),
    home: () => Promise.resolve({ ...homeSnapshot(), entries: [], attention: [], head_seq: 0 }) });
  expect((await client.call('mail_list')).result?.structuredContent).toMatchObject({ mail_items: [] });
  expect((await client.call('mail_read', { event_id: 'missing' })).result?.structuredContent).toEqual({
    event_id: 'missing', summary: '', available: false,
  });
  expect((await client.call('recall_search')).result?.structuredContent).toEqual({ results: [], candidates_capped: false });
  expect((await client.call('recall_read', { page: PAGE })).result?.structuredContent).toMatchObject({ documents: [], document: null });
  expect((await client.call('cloud_status')).result?.structuredContent).toMatchObject({ entries: [], attention: [] });
  expect(client.seen.every(request => request.method === 'GET')).toBe(true);
});

it('reads cached Home facts and validates event-poll helpers through generated contracts', async () => {
  const client = tools({ mail: request => Response.json(request.path.endsWith(':pollReady') ? { cursor: '12' } : {}),
    recall: () => Response.json({ name: PAGE }), home: input => Promise.resolve({ ...homeSnapshot(),
      attention: homeSnapshot().attention.filter(entry => entry.occurrence_seq > input.after_occurrence_seq) }) });
  expect((await client.call('cloud_status')).result?.structuredContent).toMatchObject({ refresh: { refreshed: false },
    entries: [{ id: 'recall', checked_at: AT }], attention: [{ occurrence_seq: 7 }] });
  expect(client.homeReads[0]).toEqual({ after_occurrence_seq: 0 });
  expect(await readHomeSnapshot(client.env, 7)).toMatchObject({ attention: [], head_seq: 8 });
  expect(await createReadinessClient(client.env).pollMailReady({ baseline: true })).toMatchObject({ cursor: '12' });
  expect(await createMailClient(client.env).readMailSummary({ id: 'synthetic' })).toMatchObject({ summary: '' });
  expect(await createRecallClient(client.env).getPage({ name: PAGE })).toMatchObject({ name: PAGE });
  expect(client.seen.map(request => [request.method, request.path, Object.fromEntries(request.query)])).toEqual([
    ['GET', '/api/plus/v1/mailItems:pollReady', { baseline: 'true' }],
    ['GET', '/api/plus/v1/mailItems:readMailSummary', { id: 'synthetic' }],
    ['GET', `/api/v1/${PAGE}`, {}],
  ]);
  await expect(readHomeSnapshot(client.env, -1)).rejects.toThrow();
});

it('returns meaningful known source failures and hides unconfirmed transport details', async () => {
  const client = tools({ mail: () => { throw new Error('Synthetic private upstream response'); },
    recall: () => refusal('SEARCH_OVER_BUDGET', 'Synthetic budget failure', 429),
    home: () => Promise.reject(new Error('Synthetic private Home detail')) });
  const mail = await client.call('mail_read', { event_id: 'synthetic' });
  expect(mail.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'MAIL_UNAVAILABLE' } } });
  expect(JSON.stringify(mail)).not.toContain('Synthetic private');
  const recall = await client.call('recall_search', { query: 'synthetic' });
  expect(recall.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'SEARCH_OVER_BUDGET' } } });
  expect(JSON.stringify(recall)).toContain('UTC midnight');
  const home = await client.call('cloud_status');
  expect(home.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'HOME_UNAVAILABLE' } } });
  expect(JSON.stringify(home)).not.toContain('Synthetic private');
});

it('rejects unknown or oversized inputs and cross-page snapshot reads before accessing sources', async () => {
  const client = tools();
  for (const [name, input] of [
    ['mail_list', { page_size: 51 }], ['mail_list', { arbitrary_rpc: 'DeleteMailSummaries' }],
    ['mail_collect', { event_id: 'synthetic', etag: 'current' }],
    ['mail_collect', { event_id: 'synthetic', etag: 'current', request_id: REQUEST_ID, category_id: '2' }],
    ['recall_search', { page_size: 11 }], ['recall_search', { query: 'x'.repeat(201) }],
    ['recall_read', { page: PAGE, document: DOCUMENT.replace('00000000000000000000000000000001', '00000000000000000000000000000003') }],
    ['cloud_status', { refresh: true }],
  ] as const) expect((await client.call(name, input)).result?.isError, name).toBe(true);
  expect(client.seen).toEqual([]);
  expect(client.homeReads).toEqual([]);
});
