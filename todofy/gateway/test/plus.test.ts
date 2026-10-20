import { describe, expect, it } from 'vitest';
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client';
import { PlusService } from '@ziyixi/proto/todofy/ui/v1/plus_service_pb';
import { fakes, hooks, owner, uiOk } from './helpers.ts';
import type { Env } from '../src/env.ts';
import { nativePlanning } from '../src/plus.ts';

/** A minimal valid request for each method Tasks calls on its Planning channel. */
const NATIVE_CALLS: Record<string, object> = {
  readPlan: {},
  readWeeklyReview: { weekStart: '2026-10-12' },
  listPlanningTasks: {},
  setTaskPlan: { taskId: 'task-one', etag: 'shown' },
  setTaskLead: { taskId: 'task-one', etag: 'shown' },
  appendTaskSteps: { parentId: 'task-one', steps: [{ title: 'Synthetic step' }] },
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
  it('answers a retired method path, and the retired FlowDay proxy, with NOT_FOUND before reading the body', async () => {
    const { env, core } = fakes({}, () => uiOk({}));
    for (const path of ['/api/plus/v1/mailItems:deleteMailItems', '/api/plus/flowday/api/v1/timerSession:command']) {
      const response = await nativePlanning(new Request(`https://planning.internal${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
      }), env);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toContain('NOT_FOUND');
    }
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
  it('serves the Planning API on neither the owner host nor the hooks hosts', async () => {
    const { env, core } = fakes({}, () => uiOk({ plan: {} }));
    for (const path of ['/api/plus/v1/plan:read', '/api/plus/v1/mailItems']) {
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
    const { env, core } = fakes({}, () => uiOk({ deleted_event_ids: ['event-one'] }));
    expect((await channel(env, '/api/plus/v1/mailItems:deleteSummaries', 'POST', { event_ids: ['event-one'] })).status).toBe(200);
    const call = core.find(row => row.method === 'plus_native_ui');
    expect((JSON.parse(String(call?.args[1])) as { request_id: string }).request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
