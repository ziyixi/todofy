import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Webhook } from 'standardwebhooks';

const secret = `whsec_${btoa('s'.repeat(32))}`;
const callback = { mode: 'webhook', url: 'https://receiver.example.org/callback', secret };
const stores: Miniflare[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function start(persist: string, received: unknown[], validChallenge = true,
  tasks: (request: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 })) {
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
    serviceBindings: { TASKS: tasks },
    bindings: { PUBLIC_HOST: 'mcp.example.org', ACCESS_ISSUER: 'https://test.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'test', ACCESS_OWNER: 'owner@example.org', DEV_AUTH_BYPASS: 'true',
      BUILD_SHA: 'a'.repeat(40), CALLBACK_HOSTS: 'receiver.example.org' },
    outboundService: async (request: Request) => {
      expect(request.url).toBe(callback.url);
      const body = await request.text();
      const verified = new Webhook(secret).verify(body, Object.fromEntries(request.headers)) as Record<string, unknown>;
      expect(request.headers.get('x-mcp-subscription-id')).toMatch(/^sub_/);
      if (verified.type === 'verification') return Response.json({ challenge: validChallenge ? verified.challenge : 'wrong' });
      expect(request.headers.get('webhook-id')).toBe(verified.eventId);
      received.push(verified);
      return new Response(null, { status: 204 });
    },
    }, {
      name: 'ops-probe', modules: true, compatibilityDate: '2026-09-08',
      script: `export default { async fetch(request, env) { return Response.json(await env.OPS.status()); } }`,
      serviceBindings: { OPS: { name: 'personal-mcp', entrypoint: 'Ops' } },
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
  last_subscription_request: { method: string; phase: string; event_name?: string; ttl_ms?: number | null; delivery_mode?: string;
    callback_hostname?: string; http_status?: number; rpc_code?: number; reason?: string } | null;
} } };

it('discovers tools/events and preserves the subscription across a restart, then delivers once and unsubscribes', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'personal-mcp-test-'));
  directories.push(persist);
  const received: unknown[] = [];
  const first = await start(persist, received);
  const discovery = await call<{ capabilities: Record<string, unknown> }>(first, 'server/discover');
  expect(discovery.capabilities).toHaveProperty('events');
  const catalog = await call<{ events: { name: string }[] }>(first, 'events/list');
  expect(catalog.events.map(event => event.name)).toEqual(['personal_cloud.test']);
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
  const first = await start(persist, [], true, backend);
  const initialOps = await (await (await first.getWorker('ops-probe')).fetch('https://ops.internal/')).json();
  expect(initialOps).toMatchObject({ app: 'personal-mcp', health: 'ok', signals: [], counters: { active_subscriptions: 0 } });
  const args = { request_id: '00000000-0000-4000-8000-000000000010', task_id: 'synthetic-parent',
    steps: [{ title: 'Synthetic first Step' }, { title: 'Synthetic second Step' }] };
  const partial = await call<{ isError: boolean }>(first, 'tools/call', { name: 'tasks_add_steps', arguments: args });
  expect(partial.isError).toBe(true);
  expect(saved.size, JSON.stringify({ partial, attempted })).toBe(1);
  await first.dispose();
  stores.splice(stores.indexOf(first), 1);
  const second = await start(persist, [], true, backend);
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
  const mf = await start(persist, received, false);
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
