import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.ts';
import { setFlowTaskIds } from '../../src/store/flows.ts';
let h: Harness;
beforeAll(async () => { h = await startHarness({ bindings: { DEV_AUTH_BYPASS: 'false' } }); });
afterAll(async () => { await h.dispose(); });
beforeEach(async () => { await h.reset(); });

describe('private Focus entrypoint', () => {
  it('reads the timer through its binding while the public path still requires Access', async () => {
    expect((await h.fetch('/api/v1/timerSession')).status).toBe(401);
    const response = await h.focusFetch('/api/v1/timerSession');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'timerSession', etag: '0' });
  });

  it('does not expose credentials or unrelated owner mutations', async () => {
    expect((await h.focusFetch('/api/v1/settings')).status).toBe(404);
    expect((await h.focusFetch('/api/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    const mutation = { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Unrelated edit' }) };
    expect((await h.focusFetch('/api/v1/tasks/synthetic?update_mask=title', mutation)).status).toBe(404);
    // Estimates are Tasks' durations; this path never writes one.
    const estimate = { ...mutation, body: JSON.stringify({ estimated_minutes: 45 }) };
    expect((await h.focusFetch('/api/v1/tasks/synthetic?update_mask=estimated_minutes', estimate)).status).toBe(404);
  });

  it('moves only the dragged step between days while preserving local queue entries', async () => {
    await setFlowTaskIds(h.db(), '2026-10-13', ['local-one', 'step']);
    await setFlowTaskIds(h.db(), '2026-10-14', ['local-two', 'other-step']);
    const response = await h.focusFetch('/api/v1/flows/2026-10-13:rollover', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destination: 'flows/2026-10-14', task_ids: ['step'] }),
    });
    expect(response.status).toBe(200);
    const result = await response.json<{ flow: { task_ids: string[] }; destination_flow: { task_ids: string[] } }>();
    expect(result.flow.task_ids).toEqual(['local-one']);
    expect(result.destination_flow.task_ids).toEqual(['step', 'local-two', 'other-step']);
    expect((await h.focusFetch('/api/v1/settings')).status).toBe(404);
  });
});
