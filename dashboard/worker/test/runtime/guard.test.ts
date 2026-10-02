/**
 * Guard flows in workerd: the real HomeState, stub apps over real `Ops` service bindings, a fake
 * GraphQL API. Shed at 80 %, no call in a steady state, re-apply after a lost state, hold at 70 %,
 * clear below, renew R2 monthly sheds on a new UTC day, owner force/clear with CSRF.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SetGuardInput } from '@ziyixi/proto/ops/v1/ops_wire';
import type { OverrideGuardResponse } from '../../src/api-types.ts';
import { aiNeurons, graphqlBodyWithAiError } from '../graphql-fixture.ts';
import { d1Reads, expectValid, NOW, shedState, PATHS, startFlows, status, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

async function guardCalls(harness: FlowHarness): Promise<Record<string, SetGuardInput[]>> {
  const out: Record<string, SetGuardInput[]> = {};
  for (const app of ['mail-hero', 'todofy', 'lab'] as const) {
    const calls = (await harness.callsOf(app, 'setGuard')).map((args) => args[0] as SetGuardInput);
    for (const input of calls) expectValid('SetGuardInput', input);
    out[app] = calls;
  }
  return out;
}

/** Both stubs now report `input` as their effective guard (as the real apps would after setGuard). */
async function appsReport(harness: FlowHarness, input: SetGuardInput, setAt: string): Promise<void> {
  for (const app of ['mail-hero', 'todofy', 'lab'] as const) {
    const guard = input.level === 'shed' ? shedState(input.until, input.reason, setAt) : undefined;
    await harness.answer(app, 'setGuard', guard ? { value: guard } : undefined);
    await harness.answer(app, 'status', guard ? { value: await status(app, { guard }) } : undefined);
  }
}

describe('automatic guard', () => {
  it('sheds at 80 %, stays quiet, re-applies a lost state, holds at 70 % and clears below', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(81) });
    const shed: SetGuardInput = { level: 'shed', reason: 'quota_d1_rows_read', until: '2026-09-30T01:00:00.000Z' };

    await h.tick('2026-09-29T10:00:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [shed], todofy: [shed], lab: [shed] });
    expect(h.analytics.requests).toHaveLength(1);
    await appsReport(h, shed, '2026-09-29T10:00:00.000Z');

    await h.tick('2026-09-29T10:30:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [], lab: [] });

    // Mail Hero lost its guard (storage reset): its status reads normal, so the dashboard re-applies.
    await h.answer('mail-hero', 'status', undefined);
    await h.tick('2026-09-29T11:00:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [shed], todofy: [], lab: [] });
    await appsReport(h, shed, '2026-09-29T11:00:00.000Z');

    h.analytics.answer = d1Reads(75);
    await h.tick('2026-09-29T11:30:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [], lab: [] });

    h.analytics.answer = d1Reads(60);
    await h.tick('2026-09-29T12:00:00Z');
    const normal: SetGuardInput = { level: 'normal', reason: 'quota_normal', until: null };
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [normal], todofy: [normal], lab: [normal] });
    await appsReport(h, normal, '2026-09-29T12:00:00.000Z');

    await h.tick('2026-09-29T12:30:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [], lab: [] });
    const snap = await h.snapshot();
    expect(snap.guard.desired).toMatchObject({ level: 'normal', source: 'auto' });
    expect(snap.guard.apps['mail-hero']?.last_error).toBeNull();
  });

  it('renews a monthly R2 shed on the new UTC day before it expires', async () => {
    const r2 = { r2Ops: [{ actionType: 'PutObject', bucketName: 'bucket-synthetic', requests: 850_000 }] };
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: r2 });
    await h.tick('2026-09-29T22:30:00Z');
    const first = await guardCalls(h);
    expect(first['mail-hero']).toEqual([{ level: 'shed', reason: 'quota_r2_class_a', until: '2026-09-30T01:00:00.000Z' }]);
    await appsReport(h, first['mail-hero']?.[0] as SetGuardInput, '2026-09-29T22:30:00.000Z');

    // The 23:00 tick would start a canary (CANARY_UTC_HOUR 23); jump to midnight.
    await h.tick('2026-09-30T00:00:00Z');
    const renewed = { level: 'shed', reason: 'quota_r2_class_a', until: '2026-10-01T01:00:00.000Z' } as const;
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [renewed], todofy: [renewed], lab: [renewed] });
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
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [], lab: [] });
    const snap = await h.snapshot();
    expect(snap.usage).toMatchObject({ last_error: 'http_401', consecutive_failures: 4 });
    expect(snap.digest.items.map((i) => `${i.source}:${i.code}`)).toContain('dashboard:usage_unavailable');
    expect(JSON.stringify(snap)).not.toContain('secret-text');
    expect(JSON.stringify(snap)).not.toContain('synthetic-analytics-token');

    // A GraphQL error body with 200 is a failure too; still no new shed without data.
    h.analytics.answer = () => Response.json({ data: null, errors: [{ message: 'x' }] });
    await h.tick('2026-09-30T01:00:00Z');
    const later = await h.snapshot();
    expect(later.usage.last_error).toBe('graphql_error');
    // The shed lapsed at 01:00: both apps are told normal, and nothing new is shed. The reason says
    // that no usage is known (not that the quota is normal).
    const calls = await guardCalls(h);
    expect(calls['mail-hero']).toEqual([{ level: 'normal', reason: 'usage_unknown', until: null }]);
    expect(later.guard.desired).toMatchObject({ level: 'normal', reason: 'usage_unknown', source: 'auto' });
  });

  it('does not lift a monthly R2 shed when GraphQL fails at the day change', async () => {
    const r2 = { r2Ops: [{ actionType: 'PutObject', bucketName: 'bucket-synthetic', requests: 850_000 }] };
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '12' }, usage: r2 });
    await h.tick('2026-09-29T23:30:00Z');
    const first = await guardCalls(h);
    expect(first['mail-hero']).toEqual([{ level: 'shed', reason: 'quota_r2_class_a', until: '2026-09-30T01:00:00.000Z' }]);
    await appsReport(h, first['mail-hero']?.[0] as SetGuardInput, '2026-09-29T23:30:00.000Z');

    h.analytics.answer = () => new Response('upstream', { status: 503 });
    await h.tick('2026-09-30T00:00:00Z');
    const renewed = { level: 'shed', reason: 'quota_r2_class_a', until: '2026-10-01T01:00:00.000Z' } as const;
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [renewed], todofy: [renewed], lab: [renewed] });
    await appsReport(h, renewed, '2026-09-30T00:00:00.000Z');
    await h.tick('2026-09-30T00:30:00Z');
    // No normal in between: the deferred jobs never start while R2 stays above 80 %.
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [], lab: [] });
  });

  it('never sheds for Workers AI neurons: the digest reports them, the apps are not called', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: aiNeurons(97) });
    await h.tick('2026-09-29T12:00:00Z');
    expect(h.analytics.requests).toHaveLength(1);
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [], lab: [] });
    const snap = await h.snapshot();
    expect(snap.guard.desired).toMatchObject({ level: 'normal', reason: 'quota_normal', source: 'auto' });
    const ai = snap.usage.rows.find((row) => row.id === 'ai_neurons');
    expect(ai).toMatchObject({ used: 9700, limit: 10_000, percent: 97, guard_trigger: false, projected: 19_400, projected_percent: 194 });
    expect(ai?.breakdown.map((b) => b.name)).toEqual(['@cf/meta/llama-3.1-8b-instruct', '@cf/baai/bge-m3']);
    const item = snap.digest.items.find((i) => i.code === 'ai_neurons_high');
    expect(item).toMatchObject({ source: 'cloudflare', severity: 'critical', metrics: { percent: 97, used: 9700, limit: 10_000 } });
    expectValid('OpsReportItem', item);
    expect(snap.digest.items.map((i) => i.code)).not.toContain('guard_shed');

    // 85 %: still reported (warning), still no guard call.
    h.analytics.answer = aiNeurons(85);
    await h.tick('2026-09-29T12:30:00Z');
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [], lab: [] });
    expect((await h.snapshot()).digest.items.find((i) => i.code === 'ai_neurons_high')?.severity).toBe('warning');
  });

  it('still sheds for D1 when only the Workers AI dataset answers a GraphQL error', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    h.analytics.answer = () => Response.json(graphqlBodyWithAiError(d1Reads(90)));
    await h.tick('2026-09-29T10:00:00Z');
    const shed: SetGuardInput = { level: 'shed', reason: 'quota_d1_rows_read', until: '2026-09-30T01:00:00.000Z' };
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [shed], todofy: [shed], lab: [shed] });
    const snap = await h.snapshot();
    expect(snap.usage.last_error).toBeNull();
    expect(snap.usage.rows.find((row) => row.id === 'ai_neurons')).toMatchObject({ used: null, percent: null });
    expect(snap.usage.rows.find((row) => row.id === 'd1_rows_read')).toMatchObject({ percent: 90 });
    expect(snap.digest.items.map((i) => i.code)).not.toContain('usage_unavailable');
    expect(JSON.stringify(snap)).not.toContain('secret-text');
  });

  it('clears guard_apply_failed once the shed that failed is no longer wanted', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(90) });
    await h.answer('mail-hero', 'setGuard', { throw: 'unavailable' });
    await h.tick('2026-09-29T10:00:00Z');
    await h.tick('2026-09-29T10:30:00Z');
    let snap = await h.snapshot();
    expect(snap.digest.items.map((i) => `${i.source}:${i.code}`)).toContain('mail-hero:guard_apply_failed');
    // Todofy took the shed; Mail Hero never did.
    const calls = await guardCalls(h);
    expect(calls['mail-hero']).toHaveLength(2);
    await appsReport(h, calls.todofy?.[0] as SetGuardInput, '2026-09-29T10:00:00.000Z');
    await h.answer('mail-hero', 'status', undefined);

    h.analytics.answer = d1Reads(50);
    await h.tick('2026-09-29T11:00:00Z');
    // Normal goes only to Todofy (Mail Hero never shed), and Mail Hero's failures stop counting.
    const after = await guardCalls(h);
    expect(after['mail-hero']).toEqual([]);
    expect(after.todofy).toEqual([{ level: 'normal', reason: 'quota_normal', until: null }]);
    snap = await h.snapshot();
    expect(snap.digest.items.map((i) => `${i.source}:${i.code}`)).not.toContain('mail-hero:guard_apply_failed');
    expect(snap.guard.apps['mail-hero']?.last_error).toBeNull();
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
    const snap = await h.snapshot();
    expect(snap.guard.apps.todofy?.last_error).toBe('busy');
    expect(snap.digest.items.map((i) => `${i.source}:${i.code}`)).toContain('todofy:guard_apply_failed');
  });
});

describe('owner override', () => {
  it('forces shed on every app, then clears and suppresses the automatic shed until 00:00 UTC', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(90) });
    // Statuses first, so the capabilities are known.
    await h.tick(NOW - 20 * 60_000);
    await guardCalls(h);

    const forced = await h.post(PATHS.guard, { level: 'shed' });
    expect(forced.status).toBe(200);
    const body = (await forced.json()) as OverrideGuardResponse;
    expect(body.guard.desired).toMatchObject({ level: 'shed', reason: 'owner_shed', source: 'owner' });
    expect(body.guard.override?.level).toBe('shed');
    const shedCalls = await guardCalls(h);
    expect(shedCalls['mail-hero']).toMatchObject([{ level: 'shed', reason: 'owner_shed' }]);
    expect(shedCalls.todofy).toMatchObject([{ level: 'shed', reason: 'owner_shed' }]);
    expect(shedCalls.lab).toMatchObject([{ level: 'shed', reason: 'owner_shed' }]);
    // 24 h from the request (NOW).
    expect(shedCalls['mail-hero']?.[0]?.until).toBe('2026-10-02T12:00:00.000Z');
    expect(body.guard.override?.until).toBe('2026-10-02T12:00:00.000Z');

    const cleared = await h.post(PATHS.guard, { level: 'normal' });
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as OverrideGuardResponse;
    expect(clearedBody.guard.desired).toMatchObject({ level: 'normal', reason: 'owner_clear', source: 'owner' });
    expect(await guardCalls(h)).toEqual({
      'mail-hero': [{ level: 'normal', reason: 'owner_clear', until: null }],
      todofy: [{ level: 'normal', reason: 'owner_clear', until: null }],
      lab: [{ level: 'normal', reason: 'owner_clear', until: null }],
    });

    expect(clearedBody.guard.override).toMatchObject({ level: 'normal', until: '2026-10-02T00:00:00.000Z' });
    // 90 % usage on the next tick: the automatic shed stays suppressed.
    await h.tick(NOW + 60_000);
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [], lab: [] });
    // Until 00:00 UTC: the first tick of the next day sheds again.
    await h.tick('2026-10-02T00:00:00Z');
    expect((await guardCalls(h))['mail-hero']).toMatchObject([{ level: 'shed', reason: 'quota_d1_rows_read' }]);
  });

  it('refuses the override without CSRF', async () => {
    h = await startFlows();
    const response = await h.fetch(PATHS.guard, { method: 'POST', headers: { origin: 'http://127.0.0.1' }, body: '{"level":"shed"}' });
    expect(response.status).toBe(403);
    expect(await h.called()).toEqual([]);
  });
});
