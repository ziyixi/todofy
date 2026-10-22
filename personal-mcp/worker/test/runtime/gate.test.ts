import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Webhook } from 'standardwebhooks';
import { create } from '@ziyixi/proto/protobuf';
import { toWire, fromWire } from '@ziyixi/proto/wire-json';
import type { HomeService, ReadHomeRequest, ReadHomeResponse } from '@ziyixi/proto/dashboard/mcp/v1/home_service_wire';
import { TaskSchema, type Task } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { ListChangesResponseSchema, ListTasksResponseSchema, TaskChangeSchema, type TaskChange } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { PollMailReadyResponseSchema } from '@ziyixi/proto/todofy/mail/v1/mail_service_pb';

const secret = `whsec_${btoa('s'.repeat(32))}`;
const callback = { mode: 'webhook', url: 'https://receiver.example.org/callback', secret };
const stores: Miniflare[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

interface RuntimeOptions {
  validChallenge?: boolean;
  tasks?: (request: Request) => Response | Promise<Response>;
  mail?: (request: Request) => Response | Promise<Response>;
  watch?: (request: Request) => Response | Promise<Response>;
  home?: HomeService['readHome'];
  callbackStatus?: number;
}

function emptyHome(): ReadHomeResponse {
  const at = '2026-10-20T12:00:00Z';
  return { generated_at: at, build: 'synthetic', rev: 1,
    refresh: { last_tick_at: at, next_tick_at: at, last_refresh_at: null, next_refresh_at: at, refreshed: false },
    entries: [], attention: [], head_seq: 0, control_unavailable_count: 0 };
}

async function start(persist: string, received: unknown[], options: RuntimeOptions = {}) {
  const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'], target: 'es2024', external: ['cloudflare:workers', 'node:*'], write: false, logLevel: 'silent' });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error('No bundled Worker');
  const mf = new Miniflare(convertV4MiniflareOptions({
    resourcePersistencePath: persist,
    workers: [{
    name: 'personal-mcp', script: output.text, modules: true,
    compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { SUBSCRIPTIONS: { className: 'SubscriptionStore', useSQLite: true } },
    serviceBindings: {
      TASKS: options.tasks ?? (() => new Response(null, { status: 503 })),
      TODOFY_MAIL: options.mail ?? (() => new Response(null, { status: 503 })),
      RECALL: () => new Response(null, { status: 503 }),
      WATCH: options.watch ?? (() => new Response(null, { status: 503 })),
      HOME: { name: 'home-fixture', entrypoint: 'HomeApi' },
    },
    bindings: { PUBLIC_HOST: 'mcp.example.org', ACCESS_ISSUER: 'https://test.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'test', ACCESS_OWNER: 'owner@example.org', DEV_AUTH_BYPASS: 'true',
      BUILD_SHA: 'a'.repeat(40), CALLBACK_HOSTS: 'receiver.example.org' },
    outboundService: async (request: Request) => {
      expect(request.url).toBe(callback.url);
      const body = await request.text();
      const verified = new Webhook(secret).verify(body, Object.fromEntries(request.headers)) as Record<string, unknown>;
      expect(request.headers.get('x-mcp-subscription-id')).toMatch(/^sub_/);
      if (verified.type === 'verification') return Response.json({ challenge: options.validChallenge === false ? 'wrong' : verified.challenge });
      expect(request.headers.get('webhook-id')).toBe(verified.eventId);
      received.push(verified);
      return new Response(null, { status: options.callbackStatus ?? 204 });
    },
    }, {
      name: 'ops-probe', modules: true, compatibilityDate: '2026-09-08',
      script: `export default { async fetch(request, env) { return Response.json(await env.OPS.status()); } }`,
      serviceBindings: { OPS: { name: 'personal-mcp', entrypoint: 'Ops' } },
    }, {
      name: 'home-fixture', modules: true, compatibilityDate: '2026-09-08',
      script: `import { WorkerEntrypoint } from 'cloudflare:workers';
        export class HomeApi extends WorkerEntrypoint {
          async readHome(input) {
            const response = await this.env.FIXTURE.fetch(new Request('https://home.fixture/read', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
            }));
            return response.json();
          }
        }
        export default { fetch() { return new Response(null, { status: 404 }); } };`,
      serviceBindings: { FIXTURE: async (request: Request) => {
        const input = await request.json<ReadHomeRequest>();
        return Response.json(await (options.home?.(input) ?? Promise.resolve(emptyHome())));
      } },
    }],
  }));
  stores.push(mf);
  await mf.ready;
  return mf;
}

async function request(mf: Miniflare, method: string, params: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
  };
  if (method === 'tools/call') headers['Mcp-Name'] = String(params.name);
  return mf.dispatchFetch('http://127.0.0.1/mcp', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {
      ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'synthetic-test', version: '1.0.0' } },
    } }),
  });
}

async function call<T>(mf: Miniflare, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await request(mf, method, params);
  const reply = await response.json() as { result: T; error?: unknown };
  expect(response.status, JSON.stringify(reply)).toBe(200);
  expect(reply.error).toBeUndefined();
  return reply.result;
}

type ToolReply = { structuredContent: { result?: { event_id: string; repeated?: boolean; queued?: number }; status?: {
  subscriptions: number; deliveries: Record<string, number>;
  sources: { name: string; checked_at: number; error_code: string | null }[];
  last_subscription_request: { method: string; phase: string; event_name?: string; ttl_ms?: number | null; delivery_mode?: string;
    callback_hostname?: string; http_status?: number; rpc_code?: number; reason?: string } | null;
} } };

/** The native interfaces expose current synthetic facts; cursors and event delivery belong to the real MCP DO. */
function businessSources() {
  const at = '2026-10-20T12:00:00Z';
  const tasks = new Map<string, Task>([
    ['already-due', create(TaskSchema, { name: 'tasks/already-due', id: 'already-due', etag: '1', mustStart: true })],
    ['newly-due', create(TaskSchema, { name: 'tasks/newly-due', id: 'newly-due', etag: '1' })],
    ['external', create(TaskSchema, { name: 'tasks/external', id: 'external', etag: '1' })],
  ]);
  const changes: TaskChange[] = [];
  let taskHead = 10;
  let mailHead = 20;
  let readyMail = false;
  let home = { ...emptyHome(), head_seq: 30 };
  const reads = { taskBaselines: 0, taskCursors: [] as string[], taskPages: 0,
    mailBaselines: 0, mailCursors: [] as string[], homeCursors: [] as number[] };
  const options: RuntimeOptions = {
    async tasks(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/api/tasks/v1/tasks') {
        const input = fromWire(TaskSchema, await request.json<Record<string, unknown>>(), { strict: true }).message;
        const id = url.searchParams.get('task_id') ?? '';
        const saved = create(TaskSchema, { ...input, name: `tasks/${id}`, id, etag: '1' });
        tasks.set(id, saved);
        changes.push(create(TaskChangeSchema, { cursor: String(++taskHead), name: saved.name, task: saved }));
        return Response.json(toWire(TaskSchema, saved));
      }
      expect(request.method).toBe('GET');
      if (url.pathname === '/api/tasks/v1/changes') {
        if (url.searchParams.get('baseline') === 'true') {
          reads.taskBaselines++;
          return Response.json(toWire(ListChangesResponseSchema, create(ListChangesResponseSchema, { nextPageToken: String(taskHead) })));
        }
        const cursor = url.searchParams.get('page_token') ?? '';
        reads.taskCursors.push(cursor);
        return Response.json(toWire(ListChangesResponseSchema, create(ListChangesResponseSchema, {
          nextPageToken: String(taskHead), changes: changes.filter(change => Number(change.cursor) > Number(cursor)),
        })));
      }
      expect(url.pathname).toBe('/api/tasks/v1/tasks');
      reads.taskPages++;
      return Response.json(toWire(ListTasksResponseSchema, create(ListTasksResponseSchema, { tasks: [...tasks.values()] })));
    },
    mail(request) {
      expect(request.method).toBe('GET');
      const url = new URL(request.url);
      expect(url.pathname).toBe('/api/mail/v1/mailItems:pollReady');
      const baseline = url.searchParams.get('baseline') === 'true';
      if (baseline) reads.mailBaselines++;
      else reads.mailCursors.push(url.searchParams.get('cursor') ?? '');
      const page = fromWire(PollMailReadyResponseSchema, { cursor: String(mailHead), mail_items:
        !baseline && readyMail && Number(url.searchParams.get('cursor')) < mailHead
          ? [{ event_id: 'mail-business', ready_time: at }] : [] }, { strict: true }).message;
      return Response.json(toWire(PollMailReadyResponseSchema, page));
    },
    home(input) {
      reads.homeCursors.push(input.after_occurrence_seq);
      return Promise.resolve({ ...home, attention: home.attention.filter(item => item.occurrence_seq > input.after_occurrence_seq) });
    },
  };
  return {
    options, reads,
    advance() {
      const external = create(TaskSchema, { name: 'tasks/external', id: 'external', etag: '2', title: 'Synthetic external private title' });
      tasks.set('external', external);
      changes.push(create(TaskChangeSchema, { cursor: String(++taskHead), name: external.name, task: external }));
      tasks.set('newly-due', create(TaskSchema, { name: 'tasks/newly-due', id: 'newly-due', etag: '1', mustStart: true }));
      mailHead = 21;
      readyMail = true;
      home = { ...home, head_seq: 31, attention: [{ occurrence_seq: 31, item: {
        source: 'recall', code: 'archive_not_connected', severity: 'warning', since: at, metrics: {},
        target: { view: 'ops', entry: 'recall' },
      } }] };
    },
  };
}

it('persists four business baselines and own writes, then delivers once after restart and stops unsubscribed sources', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'personal-mcp-business-'));
  directories.push(persist);
  const received: unknown[] = [];
  const sources = businessSources();
  const names = ['task.changed', 'task.must_start', 'mail.ready', 'service.attention'];
  const first = await start(persist, received, sources.options);
  for (const name of names) await call(first, 'events/subscribe', {
    name, arguments: {}, delivery: callback, ttlMs: null, cursor: null,
  });
  expect(received).toEqual([]);
  expect(sources.reads).toEqual({ taskBaselines: 1, taskCursors: [], taskPages: 1,
    mailBaselines: 1, mailCursors: [], homeCursors: [0] });
  const ownId = '00000000-0000-4000-8000-000000000071';
  const own = await call<{ structuredContent: { task: { id: string } } }>(first, 'tools/call', {
    name: 'tasks_create_inbox', arguments: { request_id: ownId, title: 'Synthetic own task' },
  });
  expect(own.structuredContent.task.id).toBe(ownId);
  const testArgs = { name: 'send_test_event', arguments: { request_id: '00000000-0000-4000-8000-000000000072' } };
  expect((await call<{ isError: boolean }>(first, 'tools/call', testArgs)).isError).toBe(true);
  sources.advance();
  await first.dispose();
  stores.splice(stores.indexOf(first), 1);
  const second = await start(persist, received, sources.options);
  const restored = await call<ToolReply>(second, 'tools/call', { name: 'connection_status', arguments: {} });
  expect(restored.structuredContent.status?.subscriptions).toBe(4);
  // Keep the production 60-second source Alarm: no direct invocation, fake clock or interval override.
  await expect.poll(() => received.length, { timeout: 70_000, interval: 500 }).toBe(4);
  const events = received as { eventId: string; name: string; data: Record<string, unknown> }[];
  expect(events.map(event => event.name).sort()).toEqual([...names].sort());
  expect(events.find(event => event.name === 'task.changed')).toMatchObject({ eventId: 'task_changed_12',
    data: { changes: [{ id: 'external', etag: '2', deleted: false }] } });
  expect(events.find(event => event.name === 'task.must_start')).toMatchObject({ eventId: 'must_start_1',
    data: { task_ids: ['newly-due'] } });
  expect(events.find(event => event.name === 'mail.ready')).toMatchObject({ eventId: 'mail_mail-business',
    data: { event_id: 'mail-business', ready_time: '2026-10-20T12:00:00Z' } });
  expect(events.find(event => event.name === 'service.attention')).toMatchObject({ eventId: 'attention_31',
    data: { occurrence_seq: 31, source: 'recall', code: 'archive_not_connected' } });
  expect(JSON.stringify(received)).not.toContain(ownId);
  expect(JSON.stringify(received)).not.toContain('Synthetic external private title');
  expect(sources.reads.taskCursors).toEqual(['10']);
  expect(sources.reads.mailCursors).toEqual(['20']);
  expect(sources.reads.homeCursors).toEqual([0, 30]);
  await expect.poll(async () => (await call<ToolReply>(second, 'tools/call', {
    name: 'connection_status', arguments: {},
  })).structuredContent.status?.deliveries.accepted).toBe(4);
  await second.dispose();
  stores.splice(stores.indexOf(second), 1);
  const third = await start(persist, received, sources.options);
  const persisted = await call<ToolReply>(third, 'tools/call', { name: 'connection_status', arguments: {} });
  expect(persisted.structuredContent.status?.deliveries.accepted).toBe(4);
  expect(persisted.structuredContent.status?.sources.map(source => source.error_code)).toEqual([null, null, null, null]);
  for (const name of names) await call(third, 'events/unsubscribe', {
    name, arguments: {}, delivery: { mode: callback.mode, url: callback.url },
  });
  const readsBeforeTestAlarm = structuredClone(sources.reads);
  await call(third, 'events/subscribe', { name: 'personal_cloud.test', arguments: {}, delivery: callback, ttlMs: null });
  await call(third, 'tools/call', testArgs);
  await expect.poll(() => received.length, { timeout: 10_000 }).toBe(5);
  expect(received[4]).toMatchObject({ name: 'personal_cloud.test' });
  expect(sources.reads).toEqual(readsBeforeTestAlarm);
  const stopped = await call<ToolReply>(third, 'tools/call', { name: 'connection_status', arguments: {} });
  expect(stopped.structuredContent.status?.sources).toEqual([]);
}, 90_000);

it('reports a permanent callback failure in Ops and clears it on explicit unsubscribe', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'personal-mcp-callback-failure-'));
  directories.push(persist);
  const mf = await start(persist, [], { callbackStatus: 400 });
  const params = { name: 'personal_cloud.test', arguments: {}, delivery: callback, ttlMs: null };
  await call(mf, 'events/subscribe', params);
  await call(mf, 'tools/call', { name: 'send_test_event', arguments: {
    request_id: '00000000-0000-4000-8000-000000000073',
  } });
  const probe = await mf.getWorker('ops-probe');
  await expect.poll(async () => {
    const status = await (await probe.fetch('https://ops.internal/')).json() as { counters: { failed_deliveries: number } };
    return status.counters.failed_deliveries;
  }, { timeout: 10_000 }).toBe(1);
  expect(await (await probe.fetch('https://ops.internal/')).json()).toMatchObject({
    health: 'degraded', signals: [{ code: 'delivery_failed' }], counters: { failed_deliveries: 1 },
  });
  await call(mf, 'events/unsubscribe', { name: params.name, arguments: {}, delivery: { mode: callback.mode, url: callback.url } });
  expect(await (await probe.fetch('https://ops.internal/')).json()).toMatchObject({
    health: 'ok', signals: [], counters: { active_subscriptions: 0, failed_deliveries: 0 },
  });
});

it('connects Watch facts to filtered durable work notifications, with silent checkpoints and no task side effects', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'personal-mcp-work-sources-'));
  directories.push(persist);
  const received: unknown[] = [];
  let head = 10;
  let baselines = 0;
  let polls = 0;
  const watched = 'watches/synthetic-work-source';
  const options: RuntimeOptions = { watch(request) {
    const url = new URL(request.url);
    expect([request.method, url.pathname]).toEqual(['GET', '/api/v1/watchEvents:poll']);
    const baseline = url.searchParams.get('baseline') === 'true';
    if (baseline) baselines++;
    else polls++;
    return Response.json({ cursor: String(head), events: !baseline && Number(url.searchParams.get('cursor')) < head
      ? [{ sequence: String(head), kind: 'change_confirmed', watch: watched,
        change: `${watched}/changes/synthetic-change`, create_time: '2026-10-22T12:00:00Z' }] : [] });
  }, tasks() { throw new Error('Work changes must not create Tasks'); } };
  const id = '00000000-0000-4000-8000-000000000081';
  const other = '00000000-0000-4000-8000-000000000082';
  const first = await start(persist, received, options);
  async function tool<T>(mf: Miniflare, name: string, args: Record<string, unknown>) {
    const reply = await call<{ isError?: boolean; structuredContent: T }>(mf, 'tools/call', { name, arguments: args });
    expect(reply.isError).not.toBe(true);
    return reply.structuredContent;
  }
  const createWork = (workId: string, ref: string, type: string) => tool(first, 'work_create', {
    request_id: workId, title: 'Synthetic work', goal: 'Observe a synthetic change', scope: 'Synthetic fixtures only',
    completion_criteria: 'The synthetic result was checked', next_action: 'Read the source', links: [{ type, ref }],
  });
  await createWork(id, watched, 'watch');
  await createWork(other, 'codex://threads/synthetic', 'codex');
  expect(baselines).toBe(1);
  const params = { name: 'work.attention', arguments: { work_id: id }, delivery: callback, ttlMs: null };
  const subscribed = await call<{ id: string }>(first, 'events/subscribe', params);
  expect((await call<{ id: string }>(first, 'events/subscribe', params)).id).toBe(subscribed.id);
  const otherScope = await call<{ id: string }>(first, 'events/subscribe', { ...params, arguments: {} });
  expect(otherScope.id).not.toBe(subscribed.id);
  await call(first, 'events/unsubscribe', { ...params, arguments: {} });
  await tool(first, 'work_checkpoint', { work_id: id, request_id: crypto.randomUUID(), etag: '1',
    changes: { checkpoint: 'Synthetic own note', next_action: 'Wait for the source' } });
  await tool(first, 'work_report', { work_id: other, report_id: 'synthetic-unrelated', kind: 'progress',
    summary: 'Synthetic private progress outside this subscription', source: { type: 'codex', ref: 'codex://threads/synthetic' } });
  const report = { work_id: id, report_id: 'synthetic-linked-report', kind: 'progress',
    summary: 'Synthetic private report body', source: { type: 'watch', ref: watched } };
  await tool(first, 'work_report', report);
  expect(received).toEqual([]);
  await first.dispose();
  stores.splice(stores.indexOf(first), 1);
  const second = await start(persist, received, options);
  await expect.poll(() => received.length, { timeout: 10_000 }).toBe(1);
  expect(received[0]).toMatchObject({ name: 'work.attention', data: { work_id: id, kind: 'progress',
    source: { type: 'watch', ref: watched } } });
  expect(JSON.stringify(received)).not.toContain('Synthetic private');
  const repeated = await tool<{ repeated: boolean }>(second, 'work_report', report);
  expect(repeated.repeated).toBe(true);
  head = 11;
  // Let the production Alarm consume the source feed. No direct invocation or shortened production timer.
  await expect.poll(() => received.length, { timeout: 70_000, interval: 500 }).toBe(2);
  expect(polls).toBe(1);
  expect(baselines).toBe(1);
  const read = await tool<{ work: { etag: string }; handled_through_candidate: number;
    pending_reports: { report_id: string; evidence_ref: string }[]; sources: { watch: { error_code: null } } }>(second, 'work_get', { work_id: id });
  expect(read.work.etag).toBe('2');
  expect(read.pending_reports.map(item => item.report_id)).toEqual(['synthetic-linked-report', 'watch:11']);
  expect(read.pending_reports[1]?.evidence_ref).toBe(`${watched}/changes/synthetic-change`);
  expect(read.sources.watch.error_code).toBeNull();
  await tool(second, 'work_checkpoint', { work_id: id, request_id: crypto.randomUUID(), etag: read.work.etag,
    handled_through_report_seq: read.handled_through_candidate, changes: { state: 'done', result: 'Synthetic observation accepted' } });
  await call(second, 'events/unsubscribe', params);
  const ops = await (await (await second.getWorker('ops-probe')).fetch('https://ops.internal/')).json();
  expect(ops).toMatchObject({ health: 'ok', counters: { active_subscriptions: 0, open_work: 1, unhandled_work_reports: 1 } });
  expect(JSON.stringify(ops)).not.toContain('Synthetic');
}, 90_000);

it('discovers tools/events and preserves the subscription across a restart, then delivers once and unsubscribes', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'personal-mcp-test-'));
  directories.push(persist);
  const received: unknown[] = [];
  const first = await start(persist, received);
  const discovery = await call<{ capabilities: Record<string, unknown> }>(first, 'server/discover');
  expect(discovery.capabilities).toHaveProperty('events');
  const catalog = await call<{ events: { name: string }[] }>(first, 'events/list');
  expect(catalog.events.map(event => event.name)).toEqual([
    'personal_cloud.test', 'task.changed', 'task.must_start', 'mail.ready', 'service.attention', 'work.attention',
  ]);
  const tools = await call<{ tools: { name: string }[] }>(first, 'tools/list');
  expect(tools.tools).toHaveLength(34);
  expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
    'work_context', 'work_get', 'work_checkpoint', 'work_report', 'watch_preview', 'watch_create', 'watch_control', 'recall_activity', 'recall_view',
  ]));
  const catalogStatus = await call<ToolReply>(first, 'tools/call', { name: 'connection_status', arguments: {} });
  expect(catalogStatus.structuredContent.status?.last_subscription_request).toBeNull();
  const params = { name: 'personal_cloud.test', arguments: {}, delivery: callback, ttlMs: null, cursor: null };
  const subscription = await call<{ id: string; refreshBefore: null }>(first, 'events/subscribe', params);
  const again = await call<{ id: string }>(first, 'events/subscribe', params);
  expect(again.id).toBe(subscription.id);
  expect(subscription.refreshBefore).toBeNull();
  await first.dispose();
  stores.splice(stores.indexOf(first), 1);
  let second = await start(persist, received);
  const before = await call<ToolReply>(second, 'tools/call', { name: 'connection_status', arguments: {} });
  expect(before.structuredContent.status?.subscriptions).toBe(1);
  expect(before.structuredContent.status?.last_subscription_request).toEqual({ method: 'events/subscribe', phase: 'accepted',
    event_name: 'personal_cloud.test', ttl_ms: null, delivery_mode: 'webhook', callback_hostname: 'receiver.example.org', http_status: 200 });
  const request = { name: 'send_test_event', arguments: { request_id: '00000000-0000-4000-8000-000000000001' } };
  const queued = await call<ToolReply>(second, 'tools/call', request);
  expect(queued.structuredContent.result?.queued).toBe(1);
  const repeated = await call<ToolReply>(second, 'tools/call', request);
  expect(repeated.structuredContent.result?.repeated).toBe(true);
  // A deployment can restart the object between enqueue and its Alarm. The saved event still arrives.
  await second.dispose();
  stores.splice(stores.indexOf(second), 1);
  second = await start(persist, received);
  await expect.poll(() => received.length, { timeout: 10_000 }).toBe(1);
  expect(received[0]).toMatchObject({ eventId: 'test_00000000-0000-4000-8000-000000000001', name: 'personal_cloud.test',
    data: { message: 'Personal MCP connection test', build_sha: 'a'.repeat(40) }, cursor: null });
  const status = await call<ToolReply>(second, 'tools/call', { name: 'connection_status', arguments: {} });
  expect(status.structuredContent.status?.deliveries.accepted).toBe(1);
  await call(second, 'events/unsubscribe', params);
  await call(second, 'events/unsubscribe', params);
  const stopped = await call<ToolReply>(second, 'tools/call', { name: 'connection_status', arguments: {} });
  expect(stopped.structuredContent.status?.subscriptions).toBe(0);
  expect(stopped.structuredContent.status?.last_subscription_request).toEqual(before.structuredContent.status?.last_subscription_request);
});

it('keeps Step identities across restart after a partial native write and reports private Ops status', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'personal-mcp-steps-'));
  directories.push(persist);
  const saved = new Map<string, Record<string, unknown>>();
  const attempted: string[] = [];
  let failSecond = true;
  const backend = async (request: Request) => {
    expect(request.method).toBe('POST');
    const body = await request.json<Record<string, unknown>>();
    const taskId = new URL(request.url).searchParams.get('task_id') ?? '';
    attempted.push(taskId);
    if (saved.size === 1 && !saved.has(taskId) && failSecond) {
      failSecond = false;
      return Response.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'Synthetic unavailable' } }, { status: 503 });
    }
    const task = saved.get(taskId) ?? { name: `tasks/${taskId}`, id: taskId, etag: '1',
      title: body.title, kind: 'step', parent_id: body.parent_id };
    saved.set(taskId, task);
    return Response.json(task);
  };
  const first = await start(persist, [], { tasks: backend });
  const initialOps = await (await (await first.getWorker('ops-probe')).fetch('https://ops.internal/')).json();
  expect(initialOps).toMatchObject({ app: 'personal-mcp', health: 'ok', signals: [], counters: { active_subscriptions: 0 } });
  const args = { request_id: '00000000-0000-4000-8000-000000000010', task_id: 'synthetic-parent',
    steps: [{ title: 'Synthetic first Step' }, { title: 'Synthetic second Step' }] };
  const partial = await call<{ isError: boolean }>(first, 'tools/call', { name: 'tasks_add_steps', arguments: args });
  expect(partial.isError).toBe(true);
  expect(saved.size, JSON.stringify({ partial, attempted })).toBe(1);
  await first.dispose();
  stores.splice(stores.indexOf(first), 1);
  const second = await start(persist, [], { tasks: backend });
  const complete = await call<{ structuredContent: { tasks: { id: string }[] } }>(second, 'tools/call', {
    name: 'tasks_add_steps', arguments: args,
  });
  expect(saved.size).toBe(2);
  expect(attempted.slice(2)).toEqual(attempted.slice(0, 2));
  expect(complete.structuredContent.tasks.map(task => task.id)).toEqual([...saved.keys()]);
  const conflict = await call<{ isError: boolean }>(second, 'tools/call', {
    name: 'tasks_add_steps', arguments: { ...args, steps: [{ title: 'Different input' }] },
  });
  expect(conflict.isError).toBe(true);
  expect(saved.size).toBe(2);
  const ops = await (await (await second.getWorker('ops-probe')).fetch('https://ops.internal/')).json();
  expect(ops).toMatchObject({ app: 'personal-mcp', health: 'ok', counters: { active_subscriptions: 0, pending_deliveries: 0 } });
  expect(JSON.stringify(ops)).not.toContain('Synthetic');
});

it('reports only safe subscription fields for host, signed challenge and pre-schema failures', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'personal-mcp-test-'));
  directories.push(persist);
  const received: unknown[] = [];
  const mf = await start(persist, received, { validChallenge: false });
  const before = await call<ToolReply>(mf, 'tools/call', { name: 'connection_status', arguments: {} });
  expect(before.structuredContent.status?.last_subscription_request).toBeNull();
  const unauthorized = await mf.dispatchFetch('https://mcp.example.org/mcp', { method: 'POST',
    headers: { 'Mcp-Method': 'events/subscribe' }, body: secret });
  expect(unauthorized.status).toBe(401);
  const unauthenticatedStatus = await call<ToolReply>(mf, 'tools/call', { name: 'connection_status', arguments: {} });
  expect(unauthenticatedStatus.structuredContent.status?.last_subscription_request).toBeNull();
  const unapprovedUrl = 'https://unapproved.example.org/private-callback?token=synthetic-private-token';
  for (const [delivery, ttlMs, code, reason] of [
    [{ ...callback, url: unapprovedUrl }, null, -32015, 'callback_host_unapproved'],
    [callback, null, -32015, 'challenge_failed'],
    [callback, 0, -32602, 'invalid_params'],
  ] as const) {
    const response = await request(mf, 'events/subscribe', { name: 'personal_cloud.test', arguments: {}, delivery, ttlMs });
    expect(await response.json()).toMatchObject({ error: { code } });
    const status = await call<ToolReply>(mf, 'tools/call', { name: 'connection_status', arguments: {} });
    expect(status.structuredContent.status?.subscriptions).toBe(0);
    expect(status.structuredContent.status?.last_subscription_request).toEqual({ method: 'events/subscribe', phase: 'rejected',
      event_name: 'personal_cloud.test', ttl_ms: ttlMs, delivery_mode: 'webhook',
      callback_hostname: new URL(delivery.url).hostname, http_status: response.status, rpc_code: code, reason });
    const serialized = JSON.stringify(status);
    for (const privateValue of [callback.url, unapprovedUrl, secret, 'synthetic-private-token']) {
      expect(serialized).not.toContain(privateValue);
    }
    await call(mf, 'events/list');
    await call(mf, 'events/unsubscribe', { name: 'personal_cloud.test', arguments: {},
      delivery: { mode: delivery.mode, url: delivery.url } });
    const afterCleanup = await call<ToolReply>(mf, 'tools/call', { name: 'connection_status', arguments: {} });
    expect(afterCleanup.structuredContent.status?.last_subscription_request).toEqual(status.structuredContent.status?.last_subscription_request);
  }
  expect(received).toHaveLength(0);
});
