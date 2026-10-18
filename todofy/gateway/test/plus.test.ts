import { describe, expect, it } from 'vitest';
import { CommandTimerRequest_Action } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client';
import { PlusService } from '@ziyixi/proto/todofy/ui/v1/plus_service_pb';
import { fakes, hooks, owner, uiOk } from './helpers.ts';
import type { Env } from '../src/env.ts';
import { nativePlanning } from '../src/plus.ts';

const ID = '80a84747-6794-442a-8fb0-82c2910b54ab';
const COMPLETE = { task_id: 'task-one', request_id: ID, flow_date: '2026-10-13' };
/** A minimal valid request for each method Tasks calls on its Planning channel. */
const NATIVE_CALLS: Record<string, object> = {
  readPlan: {},
  listPlanningTasks: {},
  setTaskPlan: { taskId: 'task-one', etag: 'shown' },
  setTaskLead: { taskId: 'task-one', etag: 'shown' },
  appendTaskSteps: { parentId: 'task-one', steps: [{ title: 'Synthetic step' }] },
  completeTask: { taskId: 'task-one' },
  setWeeklyBet: { weekStart: '2026-10-12', area: 'work' },
  setTaskDependency: { taskId: 'task-one', prerequisiteId: 'task-two' },
  resolveDependencies: { taskIds: ['task-one'] },
  reorderTasks: { taskIds: ['task-one'], taskId: 'task-one' },
  listMailItems: {},
  readMailSummary: { id: 'event-one' },
  convertMailItem: { eventId: 'event-one', etag: 'shown' },
  deleteMailSummaries: { eventIds: ['event-one'] },
  readMailSettings: {},
  updateMailCategories: { etag: 'shown' },
  verifyPlanStore: {},
};

/** The generated PlusService client over the private Planning channel. */
function planningClient(env: Env) {
  return createHttpClient(PlusService, call => nativePlanning(new Request(`https://planning.internal${call.url}`, {
    method: call.httpMethod, headers: { 'content-type': 'application/json' }, ...(call.body === undefined ? {} : { body: call.body }),
  }), env));
}
/** One request on the private Planning channel, as Tasks forwards it. */
function channel(env: Env, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return nativePlanning(new Request(`https://planning.internal${path}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}
/** A FlowDay focus stand-in on the native binding. */
function withFocus(env: Env, fetch: (request: Request) => Response | Promise<Response>): Env {
  return { ...env, FLOWDAY_NATIVE_FOCUS: { fetch } as unknown as Fetcher };
}

describe('Native Tasks planning transport', () => {
  it('reaches the core for exactly the methods Tasks calls and refuses every other PlusService method', async () => {
    const { env, core } = fakes({}, call => uiOk(call.args[0] === 'ReadPlan' ? { plan: {} } : {}));
    const client = planningClient(env) as unknown as Record<string, (input: object) => Promise<unknown>>;
    const native = PlusService.methods.filter(method => method.localName in NATIVE_CALLS);
    expect(native).toHaveLength(Object.keys(NATIVE_CALLS).length);
    for (const method of native) await client[method.localName]?.(NATIVE_CALLS[method.localName] ?? {});
    expect(core.map(call => [call.method, call.args[0]])).toEqual(native.map(method => ['plus_native_ui', method.name]));
    for (const method of PlusService.methods.filter(method => !(method.localName in NATIVE_CALLS))) {
      const refused = await client[method.localName]?.({}).catch((error: unknown) => error);
      expect(refused instanceof RpcStatusError ? refused.status.reason : refused, method.name).toBe('ACTION_NOT_ALLOWED');
    }
    expect(core).toHaveLength(native.length);
  });
  it('answers a retired method path with NOT_FOUND before reading its body', async () => {
    const { env, core } = fakes({}, () => uiOk({}));
    const response = await nativePlanning(new Request('https://planning.internal/api/plus/v1/mailItems:deleteMailItems', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    }), env);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('NOT_FOUND');
    expect(core).toHaveLength(0);
  });
  it('uses the core entrypoint that verifies the native source itself', async () => {
    const { env, core } = fakes({}, () => uiOk({ plan: {} }));
    const response = await nativePlanning(new Request('https://planning.internal/api/plus/v1/plan:read'), env);
    expect(response.status).toBe(200);
    expect(core.map(call => call.method)).toEqual(['plus_native_ui']);
  });
  it('routes native mail actions without legacy task or destination placeholders', async () => {
    const { env, core } = fakes({}, () => uiOk({}));
    const actions = [
      ['mailItems:convertMailItem', 'ConvertMailItem', { event_id: 'event-one', etag: 'shown' }],
      ['mailItems:deleteSummaries', 'DeleteMailSummaries', { event_ids: ['event-one'] }],
      ['mailSettings:updateCategories', 'UpdateMailCategories', { categories: [], etag: 'shown' }],
    ] as const;
    for (const [path, method, body] of actions) {
      const response = await nativePlanning(new Request(`https://planning.internal/api/plus/v1/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), env);
      expect(response.status).toBe(200);
      const sent = core.at(-1);
      expect(sent?.method).toBe('plus_native_ui');
      expect(sent?.args[0]).toBe(method);
      const parsed = JSON.parse(String(sent?.args[1])) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('task_id');
      expect(parsed).not.toHaveProperty('destination');
      if (method !== 'UpdateMailCategories') expect(parsed['request_id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
  it('settles only the descendant proven by a successful native completion replay', async () => {
    let frozen: string | null = null;
    const settlements: Record<string, unknown>[] = [];
    const { env, core } = fakes({}, call => {
      if (call.method === 'plus_native_ui') return uiOk({ task_id: 'parent' });
      if (call.method === 'plus_focus_claim') { frozen ??= call.args[1] as string | null; return frozen; }
      throw Error('unexpected core operation');
    });
    const native: Env = { ...env, FLOWDAY_NATIVE_FOCUS: { fetch: async (request: Request) => {
      if (request.method === 'GET') return Response.json({ name: 'timerSession', state: 'running', task_id: 'child', flow_date: '2026-10-12', etag: '7' });
      settlements.push(await request.json<Record<string, unknown>>());
      return Response.json({ name: 'timerSession', state: 'idle', etag: '8' });
    } } as unknown as Fetcher };
    const response = await nativePlanning(new Request('https://planning.internal/api/plus/v1/tasks:completeTask', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        task_id: 'parent', task_etag: 'original-task-etag', request_id: ID, flow_task_id: 'child', flow_date: '2026-10-12',
      }),
    }), native);
    expect(response.status).toBe(200);
    const sent = core.find(call => call.method === 'plus_native_ui');
    expect(JSON.parse(String(sent?.args[1]))).toMatchObject({ task_id: 'parent', task_etag: 'original-task-etag', request_id: ID, flow_task_id: 'child' });
    expect(settlements).toEqual([expect.objectContaining({ action: 'settle', task_id: 'child', flow_date: '2026-10-12' })]);
  });
  it('never forwards an estimate write to FlowDay: an estimate is the Tasks duration', async () => {
    let calls = 0;
    const { env } = fakes();
    const native: Env = { ...env, FLOWDAY_NATIVE_FOCUS: { fetch: () => { calls++; return Promise.resolve(Response.json({})); } } as unknown as Fetcher };
    const response = await nativePlanning(new Request('https://planning.internal/api/plus/flowday/api/v1/tasks/step?update_mask=estimated_minutes', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ estimated_minutes: 45 }),
    }), native);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('ACTION_NOT_ALLOWED');
    expect(calls).toBe(0);
  });
  it('forwards to FlowDay only the reads and queue and timer commands Plan and Focus use', async () => {
    const forwarded: string[] = [];
    const { env } = fakes();
    const native: Env = { ...env, FLOWDAY_NATIVE_FOCUS: { fetch: (request: Request) => {
      forwarded.push(`${request.method} ${new URL(request.url).pathname}`);
      return Promise.resolve(Response.json({}));
    } } as unknown as Fetcher };
    const focus = (path: string, init: RequestInit = {}) => nativePlanning(new Request(`https://planning.internal/api/plus/flowday/api/v1/${path}`,
      { headers: { 'content-type': 'application/json' }, ...init }), native);
    for (const [path, init] of [
      ['tasks:sync', { method: 'POST', body: JSON.stringify({ mode: 'manual' }) }],
      ['tasks/step', {}],
      ['timeEntries', {}],
      ['tasks', { method: 'POST', body: JSON.stringify({ title: 'Synthetic' }) }],
    ] as const) {
      const response = await focus(path, init);
      expect(response.status, path).toBe(400);
      expect(await response.text(), path).toContain('ACTION_NOT_ALLOWED');
    }
    expect(forwarded).toEqual([]);
    for (const path of ['tasks', 'flows/2026-10-13', 'timerSession']) expect((await focus(path)).status, path).toBe(200);
    expect(forwarded).toEqual(['GET /api/v1/tasks', 'GET /api/v1/flows/2026-10-13', 'GET /api/v1/timerSession']);
  });
  it('answers unavailable without FlowDay\'s native focus binding', async () => {
    const { env } = fakes();
    const response = await nativePlanning(new Request('https://planning.internal/api/plus/flowday/api/v1/timerSession'), env);
    expect(response.status).toBe(503);
  });
  it('serves the Planning API on neither the owner host nor the hooks hosts', async () => {
    const { env, core } = fakes({}, () => uiOk({ plan: {} }));
    for (const path of ['/api/plus/v1/plan:read', '/api/plus/flowday/api/v1/timerSession']) {
      expect((await hooks(env, path)).status, path).toBe(404);
      expect((await owner(env, path)).status, path).toBe(404);
    }
    expect(core).toHaveLength(0);
  });
});

describe('Planning channel behaviour', () => {
  it('refuses writes in maintenance but still answers the reads', async () => {
    const { env, core } = fakes({ MAINTENANCE_MODE: 'true' }, () => uiOk({ plan: {} }));
    expect((await channel(env, '/api/plus/v1/plan:read')).status).toBe(200);
    const conversion = await channel(env, '/api/plus/v1/mailItems:convertMailItem', 'POST', { event_id: 'event-one', etag: 'shown' });
    expect(conversion.status).toBe(503);
    expect(await conversion.text()).toContain('MAINTENANCE');
    expect(core.map(call => call.args[0])).toEqual(['ReadPlan']);
  });
  it('passes a reorder to the core as ReorderTasks with a generated request ID', async () => {
    const answer = { tasks: [{ id: 'task-two', sort_order: 1 }], lane_order: { lane: 'weekly', task_ids: ['task-two', 'task-one'] } };
    const { env, core } = fakes({}, () => uiOk(answer));
    const response = await channel(env, '/api/plus/v1/tasks:reorder', 'POST', { task_ids: ['task-two', 'task-one'], task_id: 'task-two', lane: 'weekly' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
    const call = core.find(row => row.method === 'plus_native_ui');
    expect(call?.args[0]).toBe('ReorderTasks');
    const sent = JSON.parse(String(call?.args[1])) as { request_id: string; task_ids: string[]; task_id: string; lane: string };
    expect(sent).toEqual({ request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, task_ids: ['task-two', 'task-one'], lane: 'weekly', task_id: 'task-two' });
  });
  it('gives an omitted optional request ID a fresh identity', async () => {
    const { env, core } = fakes({}, () => uiOk({ task_id: 'task-one' }));
    expect((await channel(env, '/api/plus/v1/tasks:completeTask', 'POST', { task_id: 'task-one' })).status).toBe(200);
    const call = core.find(row => row.method === 'plus_native_ui');
    expect((JSON.parse(String(call?.args[1])) as { request_id: string }).request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('adds the configured FlowDay link to the plan and passes the weekly review IDs through', async () => {
    const plan = { review_task_id: 'review-task', next_week_task_ids: ['kept'] };
    const { env } = fakes({ FLOWDAY_PUBLIC_URL: 'https://focus.example.org' }, () => uiOk({ plan }));
    const response = await channel(env, '/api/plus/v1/plan:read');
    expect((await response.json<{ plan: unknown }>()).plan).toEqual({ ...plan, flowday_url: 'https://focus.example.org' });
  });
  it('preserves actionable FlowDay conflicts', async () => {
    const { env } = fakes();
    const focus = withFocus(env, () => Response.json({ error: {
      code: 409, status: 'ABORTED', message: 'timer version changed',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TIMER_CONFLICT', domain: 'flowday.ziyixi.science' }],
    } }, { status: 409 }));
    const response = await channel(focus, '/api/plus/flowday/api/v1/timerSession:command', 'POST', {
      name: 'timerSession', action: 'pause', etag: 'old', request_id: ID,
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('TIMER_CONFLICT');
  });
  it('passes a day move to FlowDay without a task write', async () => {
    const forwarded: unknown[] = [];
    const { env, core } = fakes();
    const focus = withFocus(env, async request => {
      forwarded.push(await request.json());
      return Response.json({ flow: { name: 'flows/2026-10-13', task_ids: ['local-one'] },
        destination_flow: { name: 'flows/2026-10-14', task_ids: ['step', 'local-two'] } });
    });
    const response = await channel(focus, '/api/plus/flowday/api/v1/flows/2026-10-13:rollover', 'POST', { destination: 'flows/2026-10-14', task_ids: ['step'] });
    expect(response.status).toBe(200);
    expect(forwarded).toEqual([expect.objectContaining({ destination: 'flows/2026-10-14', task_ids: ['step'] })]);
    expect(core).toHaveLength(0);
  });
  it('caps a FlowDay task page at 100 tasks', async () => {
    const forwarded: string[] = [];
    const { env } = fakes();
    const focus = withFocus(env, request => {
      forwarded.push(new URL(request.url).searchParams.get('page_size') ?? '');
      return Response.json({ tasks: [] });
    });
    for (const size of ['200', '50', '']) {
      expect((await channel(focus, `/api/plus/flowday/api/v1/tasks${size ? `?page_size=${size}` : ''}`)).status).toBe(200);
    }
    expect(forwarded).toEqual(['100', '50', '100']);
  });
  it('rejects an invalid completion day before completing the task', async () => {
    const { env, core } = fakes();
    expect((await channel(env, '/api/plus/v1/tasks:completeTask', 'POST', { ...COMPLETE, flow_date: '2026-02-30' })).status).toBe(400);
    expect(core).toHaveLength(0);
  });
  it('does not accept a client-requested SETTLE or an oversized body for FlowDay', async () => {
    let calls = 0;
    const { env } = fakes();
    const focus = withFocus(env, () => { calls++; return Response.json({}); });
    const settle = await channel(focus, '/api/plus/flowday/api/v1/timerSession:command', 'POST',
      { name: 'timerSession', action: 'settle', etag: '0', request_id: ID, task_id: 'task-one', flow_date: '2026-10-13' });
    expect(CommandTimerRequest_Action.SETTLE).toBeGreaterThan(0);
    expect(settle.status).toBe(400);
    expect((await channel(focus, '/api/plus/flowday/api/v1/timerSession:command', 'POST', { padding: 'x'.repeat(40000) })).status).toBe(400);
    expect(calls).toBe(0);
  });
  it('reuses the frozen settlement request after a lost response and never creates another completion identity', async () => {
    let frozen: string | null = null;
    const closeIds: string[] = [];
    const settlements: string[] = [];
    const { env } = fakes({}, call => {
      if (call.method === 'plus_native_ui') { closeIds.push((JSON.parse(String(call.args[1])) as { request_id: string }).request_id); return uiOk({ task_id: 'task-one' }); }
      if (call.method === 'plus_focus_claim') { frozen ??= call.args[1] as string | null; return frozen; }
      throw Error('unexpected core operation');
    });
    const focus = withFocus(env, async request => {
      if (request.method === 'GET') return Response.json({ name: 'timerSession', state: 'empty', etag: '7' });
      settlements.push(await request.text());
      if (settlements.length === 1) throw Error('response lost');
      return Response.json({ name: 'timerSession', state: 'empty', etag: '8' });
    });
    expect((await channel(focus, '/api/plus/v1/tasks:completeTask', 'POST', COMPLETE)).status).toBe(503);
    expect((await channel(focus, '/api/plus/v1/tasks:completeTask', 'POST', COMPLETE)).status).toBe(200);
    expect(closeIds).toEqual([ID, ID]);
    expect(settlements).toHaveLength(2);
    expect(settlements[1]).toBe(settlements[0]);
  });
  it('refreshes a stale settlement etag once without completing the task again', async () => {
    let frozen: string | null = null;
    const settlements: { request_id: string; etag: string }[] = [];
    let closes = 0;
    let reads = 0;
    const { env } = fakes({}, call => {
      if (call.method === 'plus_native_ui') { closes++; return uiOk({ task_id: 'task-one' }); }
      if (call.method === 'plus_focus_claim') {
        if (typeof call.args[1] === 'string' && (!frozen || call.args[2] === (JSON.parse(frozen) as { etag: string }).etag)) frozen = call.args[1];
        return frozen;
      }
      throw Error('unexpected core operation');
    });
    const focus = withFocus(env, async request => {
      if (request.method === 'GET') return Response.json({ name: 'timerSession', state: 'empty', etag: String(++reads) });
      settlements.push(await request.json<{ request_id: string; etag: string }>());
      if (settlements.length === 1) return Response.json({ error: { code: 409, status: 'ABORTED', message: 'timer version changed' } }, { status: 409 });
      return Response.json({ name: 'timerSession', state: 'empty', etag: '3' });
    });
    expect((await channel(focus, '/api/plus/v1/tasks:completeTask', 'POST', COMPLETE)).status).toBe(200);
    expect(closes).toBe(1);
    expect(settlements.map(item => item.etag)).toEqual(['1', '2']);
    expect(settlements[0]?.request_id).not.toBe(settlements[1]?.request_id);
  });
  it('reports a temporarily held settlement claim as unavailable after the completion', async () => {
    const { env } = fakes({}, call => {
      if (call.method === 'plus_native_ui') return uiOk({ task_id: 'task-one' });
      if (call.method === 'plus_focus_claim') throw Error('synthetic backup hold');
      throw Error('unexpected core operation');
    });
    const response = await channel(env, '/api/plus/v1/tasks:completeTask', 'POST', COMPLETE);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('UNAVAILABLE');
  });
});
