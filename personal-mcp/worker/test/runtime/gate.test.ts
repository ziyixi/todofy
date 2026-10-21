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

async function start(persist: string, received: unknown[]) {
  const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'], target: 'es2024', external: ['cloudflare:workers', 'node:*'], write: false, logLevel: 'silent' });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error('No bundled Worker');
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'personal-mcp', script: output.text, modules: true,
    compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { SUBSCRIPTIONS: { className: 'SubscriptionStore', useSQLite: true } },
    resourcePersistencePath: persist,
    bindings: { PUBLIC_HOST: 'mcp.example.org', ACCESS_ISSUER: 'https://test.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'test', ACCESS_OWNER: 'owner@example.org', DEV_AUTH_BYPASS: 'true',
      BUILD_SHA: 'a'.repeat(40), CALLBACK_HOSTS: 'receiver.example.org' },
    outboundService: async (request: Request) => {
      expect(request.url).toBe(callback.url);
      const body = await request.text();
      const verified = new Webhook(secret).verify(body, Object.fromEntries(request.headers)) as Record<string, unknown>;
      expect(request.headers.get('x-mcp-subscription-id')).toMatch(/^sub_/);
      if (verified.type === 'verification') return Response.json({ challenge: verified.challenge });
      expect(request.headers.get('webhook-id')).toBe(verified.eventId);
      received.push(verified);
      return new Response(null, { status: 204 });
    },
  }));
  stores.push(mf);
  await mf.ready;
  return mf;
}

async function call<T>(mf: Miniflare, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
  };
  if (method === 'tools/call') headers['Mcp-Name'] = String(params.name);
  const response = await mf.dispatchFetch('http://127.0.0.1/mcp', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {
      ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'synthetic-test', version: '1.0.0' } },
    } }),
  });
  const reply = await response.json() as { result: T; error?: unknown };
  expect(response.status, JSON.stringify(reply)).toBe(200);
  expect(reply.error).toBeUndefined();
  return reply.result;
}

type ToolReply = { structuredContent: { result?: { event_id: string; repeated?: boolean; queued?: number }; status?: {
  subscriptions: number; deliveries: Record<string, number>;
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
});
