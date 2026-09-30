/**
 * Guard flows in workerd: the real HomeState, stub apps over real `Ops` service bindings, a fake
 * GraphQL API. Shed at 80 %, no call in a steady state, re-apply after a lost state, hold at 70 %,
 * clear below, renew R2 monthly sheds on a new UTC day, owner force/clear with CSRF.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SetGuardInput } from '../../../../contracts/ops-v1/ops-v1.ts';
import type { GuardResponse } from '../../src/api-types.ts';
import { d1Reads, expectValid, shedState, startFlows, status, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

async function guardCalls(harness: FlowHarness): Promise<Record<string, SetGuardInput[]>> {
  const out: Record<string, SetGuardInput[]> = {};
  for (const app of ['mail-hero', 'todofy'] as const) {
    const calls = (await harness.callsOf(app, 'setGuard')).map((args) => args[0] as SetGuardInput);
    for (const input of calls) await expectValid('SetGuardInput', input);
    out[app] = calls;
  }
  return out;
}

/** Both stubs now report `input` as their effective guard (as the real apps would after setGuard). */
async function appsReport(harness: FlowHarness, input: SetGuardInput, setAt: string): Promise<void> {
  for (const app of ['mail-hero', 'todofy'] as const) {
    const guard = input.level === 'shed' ? await shedState(input.until, input.reason, setAt) : undefined;
    await harness.answer(app, 'setGuard', guard ? { value: guard } : undefined);
    await harness.answer(app, 'status', guard ? { value: await status(app, { guard }) } : undefined);
  }
}

describe('automatic guard', () => {
  it('sheds at 80 %, stays quiet, re-applies a lost state, holds at 70 % and clears below', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(81) });
    const shed: SetGuardInput = { level: 'shed', reason: 'quota_d1_rows_read', until: '2026-09-30T00:10:00.000Z' };

    await h.tick('2026-09-29T10:00:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [shed], todofy: [shed] });
    expect(h.analytics.requests).toHaveLength(1);
    await appsReport(h, shed, '2026-09-29T10:00:00.000Z');

    await h.tick('2026-09-29T10:30:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [] });

    // Mail Hero lost its guard (storage reset): its status reads normal, so the dashboard re-applies.
    await h.answer('mail-hero', 'status', undefined);
    await h.tick('2026-09-29T11:00:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [shed], todofy: [] });
    await appsReport(h, shed, '2026-09-29T11:00:00.000Z');

    h.analytics.answer = d1Reads(75);
    await h.tick('2026-09-29T11:30:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [] });

    h.analytics.answer = d1Reads(60);
    await h.tick('2026-09-29T12:00:00Z');
    const normal: SetGuardInput = { level: 'normal', reason: 'quota_normal', until: null };
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [normal], todofy: [normal] });
    await appsReport(h, normal, '2026-09-29T12:00:00.000Z');

    await h.tick('2026-09-29T12:30:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [] });
    const overview = await h.overview();
    expect(overview.guard.desired).toMatchObject({ level: 'normal', source: 'auto' });
    expect(overview.guard.apps['mail-hero'].last_error).toBeNull();
  });

  it('renews a monthly R2 shed on the new UTC day before it expires', async () => {
    const r2 = { r2Ops: [{ actionType: 'PutObject', bucketName: 'bucket-synthetic', requests: 850_000 }] };
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: r2 });
    await h.tick('2026-09-29T22:30:00Z');
    const first = await guardCalls(h);
    expect(first['mail-hero']).toEqual([{ level: 'shed', reason: 'quota_r2_class_a', until: '2026-09-30T00:10:00.000Z' }]);
    await appsReport(h, first['mail-hero']?.[0] as SetGuardInput, '2026-09-29T22:30:00.000Z');

    // The 23:00 tick would start a canary (CANARY_UTC_HOUR 23); jump to midnight.
    await h.tick('2026-09-30T00:00:00Z');
    const renewed = { level: 'shed', reason: 'quota_r2_class_a', until: '2026-10-01T00:10:00.000Z' } as const;
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [renewed], todofy: [renewed] });
    expect(h.analytics.requests.at(-1)?.variables).toMatchObject({ day: '2026-09-30', month: '2026-09-01' });
  });

  it('keeps a shed without fresh usage, never enters one, and reports the failing token', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(85) });
    await h.tick('2026-09-29T10:00:00Z');
    const shed = (await guardCalls(h))['mail-hero']?.[0] as SetGuardInput;
    await appsReport(h, shed, '2026-09-29T10:00:00.000Z');

    h.analytics.answer = () => new Response('{"errors":[{"message":"synthetic secret-text"}]}', { status: 401 });
    for (const at of ['10:30', '11:00', '11:30', '12:00']) await h.tick(`2026-09-29T${at}:00Z`);
    // The shed stays (no normal call) although no usage arrived for two hours.
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [] });
    const overview = await h.overview();
    expect(overview.usage).toMatchObject({ last_error: 'http_401', consecutive_failures: 4 });
    expect(overview.digest.items.map((i) => `${i.source}:${i.code}`)).toContain('dashboard:usage_unavailable');
    expect(JSON.stringify(overview)).not.toContain('secret-text');
    expect(JSON.stringify(overview)).not.toContain('synthetic-analytics-token');

    // A GraphQL error body with 200 is a failure too; still no new shed without data.
    h.analytics.answer = () => Response.json({ data: null, errors: [{ message: 'x' }] });
    await h.tick('2026-09-30T01:00:00Z');
    const later = await h.overview();
    expect(later.usage.last_error).toBe('graphql_error');
    // The shed lapsed at 00:10: both apps are told normal, and nothing new is shed.
    const calls = await guardCalls(h);
    expect(calls['mail-hero']).toEqual([{ level: 'normal', reason: 'quota_normal', until: null }]);
  });

  it('never calls setGuard on an app that does not list the guard capability', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(90) });
    await h.answer('todofy', 'status', { value: await status('todofy', { capabilities: ['canary_consumer', 'ops_digest'] }) });
    await h.tick('2026-09-29T10:00:00Z');
    const calls = await guardCalls(h);
    expect(calls['mail-hero']).toHaveLength(1);
    expect(calls.todofy).toEqual([]);
  });

  it('records setGuard failures and retries on the next tick', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(90) });
    await h.answer('todofy', 'setGuard', { throw: 'busy' });
    await h.tick('2026-09-29T10:00:00Z');
    await h.tick('2026-09-29T10:30:00Z');
    expect((await guardCalls(h)).todofy).toHaveLength(2);
    const overview = await h.overview();
    expect(overview.guard.apps.todofy.last_error).toBe('busy');
    expect(overview.digest.items.map((i) => `${i.source}:${i.code}`)).toContain('todofy:guard_apply_failed');
  });
});

describe('owner override', () => {
  it('forces shed on both apps, then clears and suppresses the automatic shed until 00:00 UTC', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(90) });
    // Statuses first, so the capabilities are known.
    await h.tick(Date.now() - 20 * 60_000);
    await guardCalls(h);

    const forced = await h.post('/api/v1/guard', { level: 'shed' });
    expect(forced.status).toBe(200);
    const body = (await forced.json()) as GuardResponse;
    expect(body.guard.desired).toMatchObject({ level: 'shed', reason: 'owner_shed', source: 'owner' });
    expect(body.guard.override?.level).toBe('shed');
    const shedCalls = await guardCalls(h);
    expect(shedCalls['mail-hero']).toMatchObject([{ level: 'shed', reason: 'owner_shed' }]);
    expect(shedCalls.todofy).toMatchObject([{ level: 'shed', reason: 'owner_shed' }]);
    const until = Date.parse(shedCalls['mail-hero']?.[0]?.until ?? '');
    expect(until - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(until - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);

    const cleared = await h.post('/api/v1/guard', { level: 'normal' });
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as GuardResponse;
    expect(clearedBody.guard.desired).toMatchObject({ level: 'normal', reason: 'owner_clear', source: 'owner' });
    expect(await guardCalls(h)).toEqual({
      'mail-hero': [{ level: 'normal', reason: 'owner_clear', until: null }],
      todofy: [{ level: 'normal', reason: 'owner_clear', until: null }],
    });

    // 90 % usage on the next tick: the automatic shed stays suppressed.
    await h.tick(Date.now() + 60_000);
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [] });
  });

  it('refuses the override without CSRF', async () => {
    h = await startFlows();
    const response = await h.fetch('/api/v1/guard', { method: 'POST', headers: { origin: 'http://127.0.0.1' }, body: '{"level":"shed"}' });
    expect(response.status).toBe(403);
    expect(await h.called()).toEqual([]);
  });
});
