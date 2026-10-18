import { describe, expect, it } from 'vitest';
import { CommandTimerRequest_Action } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { fakes, hooks, owner, uiOk, uiRefusal } from './helpers.ts';
import type { Env } from '../src/env.ts';
import { nativePlanning } from '../src/plus.ts';

const TOKEN = `todofy_plus_${'a'.repeat(43)}`;
const HEADERS = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const ID = '80a84747-6794-442a-8fb0-82c2910b54ab';
const COMPLETE = { task_id: 'task-one', request_id: ID, flow_date: '2026-10-13' };

describe('Native Tasks planning transport', () => {
  it('redirects old owner setup to native planning settings without loading token setup', async () => {
    const { env, assets, core } = fakes({ TASK_SOURCE: 'tasks', TASKS_PUBLIC_URL: 'https://tasks.example.test' });
    for (const method of ['GET', 'HEAD']) {
      const response = await owner(env, '/plus', { method });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://tasks.example.test/#/settings');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(assets).toHaveLength(0);
    expect(core).toHaveLength(0);
    const legacy = fakes({ TASK_SOURCE: 'todoist' });
    expect((await owner(legacy.env, '/plus')).status).toBe(200);
    const unsigned = fakes({ TASK_SOURCE: 'tasks', TASKS_PUBLIC_URL: 'https://tasks.example.test', DEV_AUTH_BYPASS: undefined });
    const response = await owner(unsigned.env, '/plus');
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
  });
  it('refuses new extension credentials through both the owner and private native paths', async () => {
    const { env, core } = fakes({ TASK_SOURCE: 'tasks', TASKS_PUBLIC_URL: 'https://tasks.example.test' });
    const issued = await owner(env, '/api/csrf');
    const { token } = await issued.json<{ token: string }>();
    const path = '/api/plus/v1/connections:issueExtensionConnection';
    const body = JSON.stringify({ display_name: 'Synthetic legacy connection', request_id: ID });
    const response = await owner(env, path, {
      method: 'POST', body,
      headers: { origin: 'http://todofy.localhost:8787', 'content-type': 'application/json', 'x-csrf-token': token, cookie: `todofy_csrf=${token}` },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('https://tasks.example.test');
    const internal = await nativePlanning(new Request(`https://planning.internal${path}`, {
      method: 'POST', body, headers: { 'content-type': 'application/json' },
    }), env);
    expect(internal.status).toBe(400);
    expect(core).toHaveLength(0);
  });
  it('refuses the retired extension after cutover before reaching either task source', async () => {
    const { env, core } = fakes({ TASK_SOURCE: 'tasks', TASKS_PUBLIC_URL: 'https://tasks.example.test' });
    const response = await hooks(env, '/api/plus/v1/plan:read', { headers: HEADERS });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('https://tasks.example.test');
    expect(core).toHaveLength(0);
  });
  it('uses the core entrypoint that verifies the native source itself', async () => {
    const { env, core } = fakes({}, () => uiOk({ plan: {} }));
    const response = await nativePlanning(new Request('https://planning.internal/api/plus/v1/plan:read'), env);
    expect(response.status).toBe(200);
    expect(core.map(call => call.method)).toEqual(['plus_native_ui']);
  });
  it('does not fall back to the legacy FlowDay binding during a partial cutover', async () => {
    let calls = 0;
    const { env } = fakes();
    const legacy = { fetch: () => { calls++; return Promise.resolve(Response.json({})); } } as unknown as Fetcher;
    const response = await nativePlanning(new Request('https://planning.internal/api/plus/flowday/api/v1/timerSession'),
      { ...env, FLOWDAY_FOCUS: legacy });
    expect(response.status).toBe(503);
    expect(calls).toBe(0);
  });
});

function api(method: string, body: unknown) { return { method, headers: HEADERS, body: JSON.stringify(body) }; }

describe('Todoist Plus transport boundaries', () => {
  it('does not call the core or read a body without the separate extension credential', async () => {
    const { env, core } = fakes();
    expect((await hooks(env, '/api/plus/v1/plan:read')).status).toBe(401);
    expect(core).toHaveLength(0);
  });
  it('passes only a SHA256 credential to the core, with the rpc, and does not grant owner-only setup', async () => {
    const { env, core } = fakes({}, call => call.method === 'plus_auth' ? true : uiOk({ plan: {} }));
    const response = await hooks(env, '/api/plus/v1/plan:read', { headers: HEADERS });
    expect(response.status).toBe(200);
    // One core call: TodofyCore checks the digest itself.
    expect(core.map(call => call.method)).toEqual(['plus_ui']);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TOKEN)))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(core[0]?.args.slice(2)).toEqual([false, digest]);
    expect(JSON.stringify(core)).not.toContain(TOKEN);
    expect((await hooks(env, '/api/plus/v1/connections:issueExtensionConnection', api('POST', { display_name: 'Test', request_id: ID }))).status).toBe(401);
    expect((await hooks(env, '/api/plus/v1/plan:verifyPlanStore', { headers: HEADERS })).status).toBe(401);
    expect(core.filter(call => call.method === 'plus_ui')).toHaveLength(1);
  });
  it('answers the core refusing an unknown or revoked token as 401', async () => {
    const { env } = fakes({}, call => call.method === 'plus_ui' ? uiRefusal('UNAUTHORIZED') : true);
    const response = await hooks(env, '/api/plus/v1/plan:read', { headers: HEADERS });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('UNAUTHORIZED');
  });
  it('checks the token with plus_auth before the FlowDay proxy and stops at a refusal', async () => {
    let forwarded = 0;
    const { env, core } = fakes({}, call => call.method !== 'plus_auth');
    const connected = { ...env, FLOWDAY_FOCUS: { fetch: () => { forwarded++; return Promise.resolve(Response.json({})); } } as unknown as Fetcher };
    expect((await hooks(connected, '/api/plus/flowday/api/v1/timerSession', { headers: HEADERS })).status).toBe(401);
    expect(core.map(call => call.method)).toEqual(['plus_auth']);
    expect(core[0]?.args[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(forwarded).toBe(0);
  });
  it('refuses writes in maintenance but still answers the reads, the mail lookup sent as POST included', async () => {
    const { env, core } = fakes({ MAINTENANCE_MODE: 'true' }, call => call.method === 'plus_auth' ? true : uiOk({ items: [] }));
    expect((await hooks(env, '/api/plus/v1/mailItems:lookup', api('POST', { task_ids: ['task-one'] }))).status).toBe(200);
    expect(core.map(call => call.args[0])).toEqual(['LookupMailItems']);
    const deletion = await hooks(env, '/api/plus/v1/mailItems:deleteMailItems', api('POST', { task_ids: ['task-one'], request_id: ID }));
    expect(deletion.status).toBe(503);
    expect(await deletion.text()).toContain('MAINTENANCE');
    expect(core).toHaveLength(1);
  });
  it('passes no digest for the Access owner', async () => {
    const { env, core } = fakes({}, () => uiOk({ plan: {} }));
    expect((await owner(env, '/api/plus/v1/plan:read')).status).toBe(200);
    expect(core.map(call => [call.method, ...call.args.slice(2)])).toEqual([['plus_ui', true, null]]);
  });
  it('keeps owner setup behind the existing CSRF check', async () => {
    const { env, core } = fakes();
    expect((await owner(env, '/api/plus/v1/plan:confirmPlanMapping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ etag: 'mapping', request_id: ID }) })).status).toBe(403);
    expect(core).toHaveLength(0);
  });
  it('allows authenticated extension column configuration while keeping owner credential setup separate', async () => {
    const { env, core } = fakes({}, call => call.method === 'plus_auth' ? true : uiOk({ plan: { etag: 'next', enabled: true } }));
    const response = await hooks(env, '/api/plus/v1/plan:updatePlanLabels', api('POST', {
      labels: [{ role: 'candiate', id: 'month-id', label: 'Next month' },
        { role: 'focus', id: 'week-id', label: 'This week' }, { role: 'committed', id: 'commit-id', label: 'Commitments' }],
      etag: 'shown', request_id: ID,
    }));
    expect(response.status).toBe(200);
    const call = core.find(row => row.method === 'plus_ui');
    expect(call?.args[0]).toBe('UpdatePlanLabels');
    expect(call?.args[2]).toBe(false);
    expect((await response.json<{ plan: { etag: string } }>()).plan.etag).toBe('next');
  });
  it('passes a reorder to the core as ReorderTasks with a generated request ID', async () => {
    const answer = { tasks: [{ id: 'task-two', child_order: 1 }], lane_order: { lane: 'weekly', task_ids: ['task-two', 'task-one'] } };
    const { env, core } = fakes({}, call => call.method === 'plus_auth' ? true : uiOk(answer));
    const response = await hooks(env, '/api/plus/v1/tasks:reorder', api('POST', { task_ids: ['task-two', 'task-one'], task_id: 'task-two', lane: 'weekly' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
    const call = core.find(row => row.method === 'plus_ui');
    expect(call?.args[0]).toBe('ReorderTasks');
    const sent = JSON.parse(String(call?.args[1])) as { request_id: string; task_ids: string[]; task_id: string; lane: string };
    expect(sent).toEqual({ request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, task_ids: ['task-two', 'task-one'], lane: 'weekly', task_id: 'task-two' });
  });
  it('accepts an omitted optional request ID with the same fresh-identity behavior as the owner API', async () => {
    const { env, core } = fakes({}, call => call.method === 'plus_auth' ? true : uiOk({ task_id: 'task-one' }));
    expect((await hooks(env, '/api/plus/v1/tasks:completeTask', api('POST', { task_id: 'task-one' }))).status).toBe(200);
    const call = core.find(row => row.method === 'plus_ui');
    expect((JSON.parse(String(call?.args[1])) as { request_id: string }).request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('returns the configured FlowDay link without coupling the extension to one domain', async () => {
    const { env } = fakes({ FLOWDAY_PUBLIC_URL: 'https://focus.example.org' }, call => call.method === 'plus_auth' ? true : uiOk({ plan: {} }));
    expect((await hooks(env, '/api/plus/v1/plan:read', { headers: HEADERS })).status).toBe(200);
    const response = await hooks(env, '/api/plus/v1/plan:read', { headers: HEADERS });
    expect((await response.json<{ plan: { flowday_url: string } }>()).plan.flowday_url).toBe('https://focus.example.org');
  });
  it('passes the weekly review IDs from the core through next to the FlowDay link', async () => {
    const plan = { inbox_project_id: 'inbox-project', review_task_id: 'review-task', next_week_task_ids: ['kept'] };
    const { env } = fakes({ FLOWDAY_PUBLIC_URL: 'https://focus.example.org' }, call => call.method === 'plus_auth' ? true : uiOk({ plan }));
    const response = await hooks(env, '/api/plus/v1/plan:read', { headers: HEADERS });
    expect((await response.json<{ plan: unknown }>()).plan).toEqual({ ...plan, flowday_url: 'https://focus.example.org' });
  });
  it('preserves actionable FlowDay conflicts through the narrow proxy', async () => {
    const { env } = fakes({}, () => true);
    const connected = { ...env, FLOWDAY_FOCUS: { fetch: () => Promise.resolve(Response.json({ error: {
      code: 409, status: 'ABORTED', message: 'timer version changed',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TIMER_CONFLICT', domain: 'flowday.ziyixi.science' }],
    } }, { status: 409 })) } as unknown as Fetcher };
    const response = await hooks(connected, '/api/plus/flowday/api/v1/timerSession:command', api('POST', {
      name: 'timerSession', action: 'pause', etag: 'old', request_id: ID,
    }));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('TIMER_CONFLICT');
  });
  it('passes a day move through the authenticated Focus binding without a Todoist task write', async () => {
    const forwarded: unknown[] = [];
    const { env, core } = fakes({}, () => true);
    const connected = { ...env, FLOWDAY_FOCUS: { fetch: async (request: Request) => {
      forwarded.push(await request.json());
      return Response.json({ flow: { name: 'flows/2026-10-13', task_ids: ['local-one'] },
        destination_flow: { name: 'flows/2026-10-14', task_ids: ['step', 'local-two'] } });
    } } as unknown as Fetcher };
    const response = await hooks(connected, '/api/plus/flowday/api/v1/flows/2026-10-13:rollover',
      api('POST', { destination: 'flows/2026-10-14', task_ids: ['step'] }));
    expect(response.status).toBe(200);
    expect(forwarded).toEqual([expect.objectContaining({ destination: 'flows/2026-10-14', task_ids: ['step'] })]);
    expect(core.filter(call => call.method === 'plus_ui')).toHaveLength(0);
  });
  it('caps a proxied FlowDay task page at 100 tasks', async () => {
    const forwarded: string[] = [];
    const { env } = fakes({}, () => true);
    const connected = { ...env, FLOWDAY_FOCUS: { fetch: (request: Request) => {
      forwarded.push(new URL(request.url).searchParams.get('page_size') ?? '');
      return Promise.resolve(Response.json({ tasks: [] }));
    } } as unknown as Fetcher };
    for (const size of ['200', '50', '']) {
      const query = size ? `?page_size=${size}` : '';
      expect((await hooks(connected, `/api/plus/flowday/api/v1/tasks${query}`, { method: 'GET', headers: HEADERS })).status).toBe(200);
    }
    expect(forwarded).toEqual(['100', '50', '100']);
  });
  it('rejects invalid completion day before issuing the Todoist command', async () => {
    const { env, core } = fakes({}, () => true);
    expect((await hooks(env, '/api/plus/v1/tasks:completeTask', api('POST', { ...COMPLETE, flow_date: '2026-02-30' }))).status).toBe(400);
    expect(core.filter(call => call.method === 'plus_ui')).toHaveLength(0);
  });
  it('does not accept client-requested SETTLE or oversized bodies on the FlowDay proxy', async () => {
    let calls = 0;
    const { env } = fakes({}, () => true);
    const connected = { ...env, FLOWDAY_FOCUS: { fetch: () => { calls++; return Promise.resolve(Response.json({})); } } as unknown as Fetcher };
    const settle = await hooks(connected, '/api/plus/flowday/api/v1/timerSession:command', api('POST', { name: 'timerSession', action: 'settle', etag: '0', request_id: ID, task_id: 'task-one', flow_date: '2026-10-13' }));
    expect(CommandTimerRequest_Action.SETTLE).toBeGreaterThan(0);
    expect(settle.status).toBe(400);
    expect((await hooks(connected, '/api/plus/flowday/api/v1/timerSession:command', api('POST', { padding: 'x'.repeat(40000) }))).status).toBe(400);
    expect(calls).toBe(0);
  });
  it('reuses the frozen settlement request after a lost response and never creates another close identity', async () => {
    let frozen: string | null = null;
    const closeIds: string[] = [];
    const settlements: string[] = [];
    const { env } = fakes({}, call => {
      if (call.method === 'plus_auth') return true;
      if (call.method === 'plus_ui') { closeIds.push((JSON.parse(String(call.args[1])) as { request_id: string }).request_id); return uiOk({ task_id: 'task-one' }); }
      if (call.method === 'plus_focus_claim') { frozen ??= call.args[1] as string | null; return frozen; }
      throw Error('unexpected core operation');
    });
    const connected: Env = { ...env, FLOWDAY_FOCUS: { fetch: async (request: Request) => {
      if (request.method === 'GET') return Response.json({ name: 'timerSession', state: 'empty', etag: '7' });
      settlements.push(await request.text());
      if (settlements.length === 1) throw Error('response lost');
      return Response.json({ name: 'timerSession', state: 'empty', etag: '8' });
    } } as unknown as Fetcher };
    expect((await hooks(connected, '/api/plus/v1/tasks:completeTask', api('POST', COMPLETE))).status).toBe(503);
    expect((await hooks(connected, '/api/plus/v1/tasks:completeTask', api('POST', COMPLETE))).status).toBe(200);
    expect(closeIds).toEqual([ID, ID]);
    expect(settlements).toHaveLength(2);
    expect(settlements[1]).toBe(settlements[0]);
  });
  it('refreshes a stale settlement etag once without issuing another Todoist close', async () => {
    let frozen: string | null = null;
    const settlements: { request_id: string; etag: string }[] = [];
    let closes = 0;
    let reads = 0;
    const { env } = fakes({}, call => {
      if (call.method === 'plus_auth') return true;
      if (call.method === 'plus_ui') { closes++; return uiOk({ task_id: 'task-one' }); }
      if (call.method === 'plus_focus_claim') {
        if (typeof call.args[1] === 'string' && (!frozen || call.args[2] === (JSON.parse(frozen) as { etag: string }).etag)) frozen = call.args[1];
        return frozen;
      }
      throw Error('unexpected core operation');
    });
    const connected = { ...env, FLOWDAY_FOCUS: { fetch: async (request: Request) => {
      if (request.method === 'GET') return Response.json({ name: 'timerSession', state: 'empty', etag: String(++reads) });
      settlements.push(await request.json<{ request_id: string; etag: string }>());
      if (settlements.length === 1) return Response.json({ error: { code: 409, status: 'ABORTED', message: 'timer version changed' } }, { status: 409 });
      return Response.json({ name: 'timerSession', state: 'empty', etag: '3' });
    } } as unknown as Fetcher };
    expect((await hooks(connected, '/api/plus/v1/tasks:completeTask', api('POST', COMPLETE))).status).toBe(200);
    expect(closes).toBe(1);
    expect(settlements.map(item => item.etag)).toEqual(['1', '2']);
    expect(settlements[0]?.request_id).not.toBe(settlements[1]?.request_id);
  });
  it('reports a temporarily held settlement claim as unavailable after the successful Todoist close', async () => {
    const { env } = fakes({}, call => {
      if (call.method === 'plus_auth') return true;
      if (call.method === 'plus_ui') return uiOk({ task_id: 'task-one' });
      if (call.method === 'plus_focus_claim') throw Error('synthetic backup hold');
      throw Error('unexpected core operation');
    });
    const response = await hooks(env, '/api/plus/v1/tasks:completeTask', api('POST', COMPLETE));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('UNAVAILABLE');
  });
});
