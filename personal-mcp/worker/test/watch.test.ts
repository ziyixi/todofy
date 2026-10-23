import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { registerWatchTools, type WatchToolEnv } from '../src/watch.ts';
import { WorkStore, type WorkStorage } from '../src/work-store.ts';
import type { WorkCreateInput } from '../src/work-model.ts';

const WATCH = 'watches/synthetic-watch';
const CHANGE = `${WATCH}/changes/0000000000000001`;
const SNAPSHOT = `${WATCH}/snapshots/0000000000000001`;
const AT = '2026-10-22T12:00:00Z';
const settings = { display_name: 'Synthetic registration', uri: 'https://example.org/synthetic',
  intent: 'Tell the owner when synthetic registration opens',
  source: { html: { include_selectors: ['main'] } }, trigger: { text_appears: { text: 'Registration is open' } } };
const handlers: ReturnType<typeof createMcpHandler>[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  await Promise.all(handlers.splice(0).map(handler => handler.close()));
  for (const database of databases.splice(0)) database.close();
});

function uuid(value: number) { return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`; }
function watch(overrides: Record<string, unknown> = {}) {
  return { ...settings, name: WATCH, etag: 'revision-one', state: 'active', notify_policy: 'digest', latest_snapshot: SNAPSHOT, ...overrides };
}
interface NativeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

function tools(backend: (request: NativeRequest) => Response | Promise<Response>) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const sql = {
    exec(query: string, ...bindings: SqlStorageValue[]) {
      if (query.trimStart().startsWith('CREATE')) { database.exec(query); return { toArray: () => [] }; }
      const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) satisfies SQLInputValue[];
      const rows = database.prepare(query).all(...values);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  let transaction = 0;
  const storage: WorkStorage = { sql, transactionSync<T>(action: () => T): T {
    const savepoint = `watch_test_${String(++transaction)}`;
    database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = action();
      database.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      database.exec(`ROLLBACK TO ${savepoint}`);
      database.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  } };
  const work = new WorkStore(storage);
  const seen: NativeRequest[] = [];
  const env: WatchToolEnv = { WATCH: { async fetch(request: Request) {
    const url = new URL(request.url);
    const call = { method: request.method, path: url.pathname, query: url.searchParams,
      body: request.method === 'GET' ? {} : await request.json<Record<string, unknown>>() };
    seen.push(call);
    return backend(call);
  } } as unknown as Fetcher };
  let preparations = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'synthetic-watch', version: '1' }, { capabilities: { tools: {} } });
    registerWatchTools(server, env, work, () => { preparations++; return Promise.resolve(); });
    return server;
  }, { legacy: 'reject' });
  handlers.push(handler);
  return { work, seen, preparations: () => preparations,
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

function createWork(work: WorkStore, number: number, fields: Partial<WorkCreateInput> = {}) {
  return work.create({ request_id: uuid(number), title: 'Synthetic work', goal: 'Observe synthetic registration',
    scope: 'Synthetic resources only', completion_criteria: 'The current condition is checked and dedicated follow-up stops',
    next_action: 'Preview the synthetic page', ...fields }).work;
}

it('reads source-owned watches through generated list and get routes without changing notification policy', async () => {
  const client = tools(request => Response.json(request.path.endsWith('/synthetic-watch')
    ? watch({ state: 'broken', notify_policy: 'urgent' })
    : { watches: [watch()], next_page_token: 'more' }));
  const list = await client.call('watch_list', { filter: 'registration', page_size: 2, page_token: 'previous' });
  expect(list.result?.structuredContent).toMatchObject({ watches: [{ name: WATCH, notify_policy: 'digest' }], next_page_token: 'more' });
  const read = await client.call('watch_get', { name: WATCH });
  expect(read.result?.structuredContent).toMatchObject({ name: WATCH, state: 'broken', notify_policy: 'urgent', latest_snapshot: SNAPSHOT });
  expect(client.seen.map(call => [call.method, call.path, Object.fromEntries(call.query)])).toEqual([
    ['GET', '/api/v1/watches', { page_size: '2', page_token: 'previous', filter: 'registration' }],
    ['GET', '/api/v1/watches/synthetic-watch', {}],
  ]);
  expect(client.preparations()).toBe(0);
  expect(client.work.list().works).toEqual([]);
});

it('recovers a lost create reply with the same native identity and attaches one owned NONE watch', async () => {
  const saved = new Map<string, ReturnType<typeof watch>>();
  let loseReply = true;
  const client = tools(request => {
    expect([request.method, request.path]).toEqual(['POST', '/api/v1/watches']);
    expect(request.body).toMatchObject({ ...settings, notify_policy: 'none' });
    const requestId = request.query.get('request_id') ?? '';
    expect(request.query.get('watch_id')).toBe(`w-${requestId}`);
    if (!saved.has(requestId)) saved.set(requestId, watch({ ...request.body, name: `watches/w-${requestId}` }));
    if (loseReply) { loseReply = false; throw new Error('Synthetic response loss after source persistence'); }
    return Response.json(saved.get(requestId));
  });
  const work = createWork(client.work, 1);
  const input = { work_id: work.id, request_id: uuid(2), ...settings };
  expect((await client.call('watch_create', input)).result?.isError).toBe(true);
  expect(client.work.get({ work_id: work.id }).work.links).toEqual([]);
  const retried = await client.call('watch_create', input);
  expect(retried.result?.structuredContent).toMatchObject({ work_id: work.id, linked: true,
    watch: { name: `watches/w-${uuid(2)}`, notify_policy: 'none' } });
  await client.call('watch_create', input);
  expect(saved.size).toBe(1);
  expect(client.seen.map(call => call.query.get('request_id'))).toEqual([uuid(2), uuid(2), uuid(2)]);
  expect(client.work.get({ work_id: work.id }).work).toMatchObject({ etag: '2', links: [
    { type: 'watch', ref: `watches/w-${uuid(2)}`, owned: true, stop_state: 'unconfirmed' },
  ] });
});

it('requires an open work before creating a dedicated watch', async () => {
  const client = tools(() => { throw new Error('Closed work must not reach the source'); });
  const closed = createWork(client.work, 10, { state: 'cancelled', result: 'Synthetic responsibility cancelled' });
  const reply = await client.call('watch_create', { work_id: closed.id, request_id: uuid(11), ...settings });
  expect(reply.error?.message ?? reply.result?.isError).toBeTruthy();
  expect((await client.call('watch_create', { request_id: uuid(12), ...settings })).result?.isError).toBe(true);
  expect(client.seen).toEqual([]);
  expect(client.preparations()).toBe(0);
});

it('updates only selected fields and the current etag while retaining an existing urgent policy', async () => {
  const client = tools(request => Response.json(watch({ ...request.body, etag: 'revision-two', notify_policy: 'urgent' })));
  const reply = await client.call('watch_update', { name: WATCH, request_id: uuid(21), etag: 'revision-one',
    changes: { intent: 'Report only synthetic registration for the selected cohort' } });
  expect(client.seen).toHaveLength(1);
  const request = client.seen[0];
  expect([request?.method, request?.path]).toEqual(['PATCH', '/api/v1/watches/synthetic-watch']);
  expect(Object.fromEntries(request?.query ?? [])).toEqual({ update_mask: 'intent,etag', request_id: uuid(21) });
  expect(request?.body).toEqual({ intent: 'Report only synthetic registration for the selected cohort', etag: 'revision-one' });
  expect(reply.result?.structuredContent).toMatchObject({ etag: 'revision-two', notify_policy: 'urgent', uri: settings.uri,
    source: settings.source, trigger: settings.trigger });
});

it('confirms pause by reading current state, rejects a stale pause receipt and preserves shared work links', async () => {
  let confirmPause = false;
  let actualState = 'active';
  const receipts = new Map<string, ReturnType<typeof watch>>();
  const client = tools(request => {
    if (request.method === 'GET') {
      expect(request.path).toBe('/api/v1/watches/synthetic-watch');
      return Response.json(watch({ state: actualState }));
    }
    expect(request.body.etag).toBe('revision-one');
    const requestId = request.body.request_id;
    expect(typeof requestId).toBe('string');
    if (typeof requestId !== 'string') throw new Error('Expected a synthetic request identity');
    const previous = receipts.get(requestId);
    if (previous) return Response.json(previous);
    const desiredState = request.path.endsWith(':pause') ? 'paused' : 'active';
    if (desiredState === 'active' || confirmPause) actualState = desiredState;
    const receipt = watch({ state: desiredState });
    receipts.set(requestId, receipt);
    return Response.json(receipt);
  });
  const owner = createWork(client.work, 30, { links: [{ type: 'watch', ref: WATCH, owned: true }] });
  const shared = createWork(client.work, 31, { links: [{ type: 'watch', ref: WATCH }] });
  const invalid = await client.call('watch_control', { name: WATCH, action: 'pause', request_id: uuid(32) });
  expect(invalid.result?.isError).toBe(true);
  expect(client.seen).toHaveLength(0);
  const unconfirmed = await client.call('watch_control', { name: WATCH, action: 'pause', etag: 'revision-one', request_id: uuid(33) });
  expect(unconfirmed.result?.isError).toBe(true);
  expect(client.work.get({ work_id: owner.id }).work.links[0]?.stop_state).toBe('unconfirmed');
  confirmPause = true;
  await client.call('watch_control', { name: WATCH, action: 'pause', etag: 'revision-one', request_id: uuid(34) });
  const stopped = client.work.get({ work_id: owner.id }).work.links[0];
  expect(stopped).toMatchObject({ owned: true, stop_state: 'stopped' });
  expect(typeof stopped?.observed_at).toBe('string');
  expect(stopped?.observation).toContain('PauseWatch');
  expect(client.work.get({ work_id: shared.id }).work).toMatchObject({ etag: '1', links: [
    { type: 'watch', ref: WATCH, owned: false, stop_state: 'unconfirmed', observed_at: null },
  ] });
  await client.call('watch_control', { name: WATCH, action: 'resume', etag: 'revision-one', request_id: uuid(35) });
  expect(client.work.get({ work_id: owner.id }).work.links[0]).toMatchObject({ stop_state: 'unconfirmed', observed_at: null, observation: '' });
  const stale = await client.call('watch_control', { name: WATCH, action: 'pause', etag: 'revision-one', request_id: uuid(34) });
  expect(stale.result?.isError).toBe(true);
  expect(client.work.get({ work_id: owner.id }).work.links[0]?.stop_state).toBe('unconfirmed');
  expect(client.seen.map(call => [call.method, call.path])).toEqual([
    ['POST', '/api/v1/watches/synthetic-watch:pause'], ['GET', '/api/v1/watches/synthetic-watch'],
    ['POST', '/api/v1/watches/synthetic-watch:pause'], ['GET', '/api/v1/watches/synthetic-watch'],
    ['POST', '/api/v1/watches/synthetic-watch:resume'], ['GET', '/api/v1/watches/synthetic-watch'],
    ['POST', '/api/v1/watches/synthetic-watch:pause'], ['GET', '/api/v1/watches/synthetic-watch'],
  ]);
});

it('returns current preview evidence and fetch freshness without creating a watch or work follow-up', async () => {
  const client = tools(request => {
    expect([request.method, request.path]).toEqual(['POST', '/api/v1/watches:preview']);
    expect(request.body).toMatchObject({ watch: { ...settings, name: WATCH }, refresh: true });
    return Response.json({ fetch: { http_status: 200, fetch_time: AT, cached: true,
      next_fetch_time: '2026-10-22T12:15:00Z', robots_allowed: true },
    extracted_lines: ['Registration is open'], normalized_lines: ['Registration is open'],
    trigger: { fired: true, trigger_kind: 'text_appears' } });
  });
  const work = createWork(client.work, 40);
  const reply = await client.call('watch_preview', { ...settings, name: WATCH, refresh: true });
  expect(reply.result?.structuredContent).toMatchObject({ fetch: { fetch_time: AT, cached: true,
    next_fetch_time: '2026-10-22T12:15:00Z' }, extracted_lines: ['Registration is open'], trigger: { fired: true } });
  expect(client.work.get({ work_id: work.id }).work.links).toEqual([]);
  expect(client.preparations()).toBe(0);
  expect(client.seen).toHaveLength(1);
});

it('reads frozen change evidence by name or collection and keeps missing or truncated context explicit', async () => {
  const client = tools(request => Response.json(request.path.endsWith('/changes/0000000000000001')
    ? { name: CHANGE, state: 'confirmed', summary: 'Synthetic historical change', context_available: false }
    : { changes: [{ name: `${WATCH}/changes/0000000000000002`, state: 'confirmed',
      before_context: ['Registration is closed'], after_context: ['Registration is open'],
      before_snapshot: SNAPSHOT, after_snapshot: `${WATCH}/snapshots/0000000000000002`,
      context_available: true, context_truncated: true }], next_page_token: 'more' }));
  const old = await client.call('watch_changes', { name: CHANGE });
  expect(old.result?.structuredContent).toMatchObject({ name: CHANGE, context_available: false,
    context_truncated: false, before_context: [], after_context: [] });
  const list = await client.call('watch_changes', { parent: 'watches/-', page_size: 2, page_token: 'previous' });
  expect(list.result?.structuredContent).toMatchObject({ changes: [{ context_available: true, context_truncated: true,
    before_context: ['Registration is closed'], after_context: ['Registration is open'],
    before_snapshot: SNAPSHOT, after_snapshot: `${WATCH}/snapshots/0000000000000002` }], next_page_token: 'more' });
  expect(client.seen.map(call => [call.method, call.path, Object.fromEntries(call.query)])).toEqual([
    ['GET', '/api/v1/watches/synthetic-watch/changes/0000000000000001', {}],
    ['GET', '/api/v1/watches/-/changes', { page_size: '2', page_token: 'previous' }],
  ]);
  expect(client.work.list().works).toEqual([]);
});

it.each(['http', 'browser'])('passes the native %s fetcher through preview, create and selected updates', async fetcher => {
  const client = tools(request => Response.json(request.path.endsWith(':preview')
    ? { extracted_lines: ['Synthetic evidence'] }
    : watch({ ...request.body, name: `watches/w-${uuid(51)}` })));
  const work = createWork(client.work, 50);
  const config = { ...settings, fetcher, check_interval_minutes: 360 };
  await client.call('watch_preview', config);
  await client.call('watch_create', { ...config, work_id: work.id, request_id: uuid(51) });
  await client.call('watch_update', { name: WATCH, request_id: uuid(52), etag: 'revision-one', changes: { fetcher } });
  expect(client.seen.map(call => call.path.endsWith(':preview') ? (call.body.watch as Record<string, unknown>).fetcher : call.body.fetcher))
    .toEqual([fetcher, fetcher, fetcher]);
  expect(client.seen[2]?.query.get('update_mask')).toBe('fetcher,etag');
});

it('reads stored snapshot windows with source completeness and metadata while keeping representations separate', async () => {
  const client = tools(request => {
    expect([request.method, request.path]).toEqual(['GET', '/api/v1/watches/synthetic-watch/snapshots/0000000000000001']);
    return Response.json({ name: SNAPSHOT, create_time: AT, uri: 'https://example.org/synthetic', title: 'Synthetic page',
      markdown: 'A😀BC', structure_json: '{"synthetic":true}', links: [{ text: 'Synthetic link', url: 'https://example.org/item' }],
      metadata: [{ name: 'description', content: 'Synthetic metadata' }], content_available: true, content_truncated: true,
      image_available: false, image_error: 'not_captured' });
  });
  const first = await client.call('watch_read', { snapshot: SNAPSHOT, limit: 2 });
  expect(first.result?.structuredContent).toMatchObject({ name: SNAPSHOT, create_time: AT, title: 'Synthetic page',
    markdown: 'A😀', representation: 'markdown', offset: 0, next_offset: 2, total_characters: 4,
    content_available: true, content_truncated: true, image_available: false, image_error: 'not_captured',
    links: [{ text: 'Synthetic link' }], metadata: [{ name: 'description' }] });
  expect(first.result?.structuredContent).not.toHaveProperty('structure_json');
  const rest = await client.call('watch_read', { snapshot: SNAPSHOT, offset: 2, limit: 2 });
  expect(rest.result?.structuredContent).toMatchObject({ markdown: 'BC', next_offset: null, content_truncated: true });
  const structure = await client.call('watch_read', { snapshot: SNAPSHOT, representation: 'structure' });
  expect(structure.result?.structuredContent).toMatchObject({ structure_json: '{"synthetic":true}', next_offset: null });
  expect(structure.result?.structuredContent).not.toHaveProperty('markdown');
  expect(client.preparations()).toBe(0);
  expect(client.work.list().works).toEqual([]);
});

it('keeps old or unavailable snapshot content explicit and rejects unbounded windows before a source call', async () => {
  const client = tools(() => Response.json({ name: SNAPSHOT, content_error: 'historical_evidence_unavailable',
    image_error: 'not_captured', content_truncated: true }));
  const read = await client.call('watch_read', { snapshot: SNAPSHOT });
  expect(read.result?.structuredContent).toMatchObject({ markdown: '', content_available: false,
    content_truncated: true, content_error: 'historical_evidence_unavailable', image_available: false, next_offset: null });
  for (const input of [{ snapshot: CHANGE }, { snapshot: SNAPSHOT, limit: 24001 }, { snapshot: SNAPSHOT, offset: -1 }]) {
    expect((await client.call('watch_read', input)).result?.isError).toBe(true);
  }
  expect(client.seen).toHaveLength(1);
});

it('returns a stored screenshot as an actual MCP image without leaking base64 into text', async () => {
  const bytes = btoa('synthetic-jpeg-bytes');
  const client = tools(request => {
    expect([request.method, request.path]).toEqual(['GET', '/api/v1/watches/synthetic-watch/snapshots/0000000000000001/image']);
    return Response.json({ name: `${SNAPSHOT}/image`, available: true, jpeg_base64: bytes, width: 800, height: 600 });
  });
  const reply = await client.call('watch_view', { snapshot: SNAPSHOT });
  expect(reply.result?.structuredContent).toMatchObject({ snapshot: SNAPSHOT, image_available: true,
    image: { name: `${SNAPSHOT}/image`, available: true, width: 800, height: 600 } });
  expect(reply.result?.content).toContainEqual({ type: 'image', data: bytes, mimeType: 'image/jpeg' });
  expect(JSON.stringify(reply.result?.structuredContent)).not.toContain(bytes);
  expect(reply.result?.content.filter(item => item.type === 'text').map(item => item.text).join('')).not.toContain(bytes);
  expect(client.preparations()).toBe(0);
});

it('keeps missing screenshots and source errors explicit without reading another snapshot or fetching a page', async () => {
  const client = tools(() => Response.json({ name: `${SNAPSHOT}/image`, available: false, error: 'image_pruned' }));
  const reply = await client.call('watch_view', { snapshot: SNAPSHOT });
  expect(reply.result?.structuredContent).toMatchObject({ snapshot: SNAPSHOT, image_available: false, reason: 'image_pruned' });
  expect(reply.result?.content.some(item => item.type === 'image')).toBe(false);
  expect(client.seen).toHaveLength(1);
});
