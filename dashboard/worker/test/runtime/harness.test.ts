/**
 * The harness itself: the bundle starts in workerd and its cron handler runs; the stubs answer
 * ops-v1 fixtures over a real service binding with `entrypoint = "Ops"`, follow scenarios, record calls
 * and reject methods ops-v1.ts does not declare for that app. The dashboard's own flows live in the
 * other runtime test files.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validate } from '../../../../contracts/ops-v1/validate.mjs';
import { contractSchema, startHarness, type Harness } from './harness.ts';

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

describe('workerd harness', () => {
  it('starts the bundled Worker "home" and runs its cron handler', async () => {
    const response = await harness.fetch('/health');
    expect(response.status).toBeGreaterThanOrEqual(200);
    await response.arrayBuffer();
    await harness.scheduled(new Date('2026-09-29T16:00:00Z'));
    // The tick's own calls (statuses, the day's canary start, the first digest); flows are tested elsewhere.
    expect((await harness.calls('mail-hero')).map((call) => call.method)).toEqual(['status', 'startCanary']);
    expect((await harness.calls('todofy')).map((call) => call.method)).toEqual(['status', 'reportOps']);
  });

  it('serves schema-valid fixtures over RPC and records the calls', async () => {
    const schema = await contractSchema();
    const status = await harness.rpc('mail-hero', 'status');
    expect(validate(schema, 'OpsStatus', status.ok)).toEqual([]);
    const result = await harness.rpc('todofy', 'canaryResult', 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710016');
    expect(validate(schema, 'CanaryResult', result.ok)).toEqual([]);
    expect((await harness.calls('mail-hero')).map((call) => call.method)).toEqual(['status']);
    expect(await harness.calls('todofy')).toEqual([
      { app: 'todofy', method: 'canaryResult', args: ['f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710016'] },
    ]);
  });

  it('follows scenarios: values, error codes and sequences', async () => {
    await harness.scenario('mail-hero', {
      status: { throw: 'busy' },
      canaryDelivery: { sequence: [{ value: { state: 'pending', attempts: 1 } }, { throw: 'unavailable' }] },
    });
    expect(await harness.rpc('mail-hero', 'status')).toEqual({ error: 'busy' });
    expect(await harness.rpc('mail-hero', 'canaryDelivery', 'x')).toEqual({ ok: { state: 'pending', attempts: 1 } });
    expect(await harness.rpc('mail-hero', 'canaryDelivery', 'x')).toEqual({ error: 'unavailable' });
    await harness.scenario('mail-hero', {});
  });

  it('rejects methods the contract does not declare for that app', async () => {
    const wrongApp = await harness.rpc('mail-hero', 'reportOps', { generated_at: '2026-09-29T00:00:00Z', items: [] });
    expect(wrongApp.error).toBeTypeOf('string');
    expect(wrongApp.ok).toBeUndefined();
    const other = await harness.rpc('todofy', 'startCanary', { run_id: 'canary-2026-09-29' });
    expect(other.ok).toBeUndefined();
  });
});
