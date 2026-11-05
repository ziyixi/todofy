/**
 * Guard flows in workerd: the real HomeState, stub apps over real `Ops` service bindings, a fake
 * GraphQL API. Shed at 80 %, no call in a steady state, re-apply after a lost state, hold at 70 %,
 * clear below, renew R2 monthly sheds on a new UTC day, owner force/clear with CSRF.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SetGuardInput } from '@ziyixi/proto/ops/v1/ops_wire';
import type { HomeView, OverrideGuardResponse } from '../../src/api-types.ts';
import { aiNeurons, graphqlBodyWithAiError } from '../graphql-fixture.ts';
import { d1Reads, expectValid, NOW, shedState, PATHS, startFlows, status, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

async function guardCalls(harness: FlowHarness): Promise<Record<string, SetGuardInput[]>> {
  const out: Record<string, SetGuardInput[]> = {};
  for (const app of ['mail-hero', 'todofy'] as const) {
    const calls = (await harness.callsOf(app, 'setGuard')).map((args) => args[0] as SetGuardInput);
    for (const input of calls) expectValid('SetGuardInput', input);
    out[app] = calls;
  }
  return out;
}

/** Both stubs now report `input` as their effective guard (as the real apps would after setGuard). */
async function appsReport(harness: FlowHarness, input: SetGuardInput, setAt: string): Promise<void> {
  for (const app of ['mail-hero', 'todofy'] as const) {
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
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [renewed], todofy: [renewed] });
    await appsReport(h, renewed, '2026-09-30T00:00:00.000Z');
    await h.tick('2026-09-30T00:30:00Z');
    // No normal in between: the deferred jobs never start while R2 stays above 80 %.
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [] });
  });

  it('never sheds for Workers AI neurons: the digest reports them, the apps are not called', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: aiNeurons(97) });
    await h.tick('2026-09-29T12:00:00Z');
    expect(h.analytics.requests).toHaveLength(1);
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [] });
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
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [], todofy: [] });
    expect((await h.snapshot()).digest.items.find((i) => i.code === 'ai_neurons_high')?.severity).toBe('warning');
  });

  it('still sheds for D1 when only the Workers AI dataset answers a GraphQL error', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    h.analytics.answer = () => Response.json(graphqlBodyWithAiError(d1Reads(90)));
    await h.tick('2026-09-29T10:00:00Z');
    const shed: SetGuardInput = { level: 'shed', reason: 'quota_d1_rows_read', until: '2026-09-30T01:00:00.000Z' };
    expect(await guardCalls(h)).toEqual({ 'mail-hero': [shed], todofy: [shed] });
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
    await h.answer('todofy', 'status', { value: await status('todofy', { capabilities: ['canary_consumer'] }) });
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
  it('isolates owner overrides and clear from the automatic policy on other apps', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(90) });
    await h.tick(NOW - 20 * 60_000);
    await guardCalls(h);
    const forced = await h.post(PATHS.guard, { level: 'shed', app: 'mail-hero' });
    expect(forced.status).toBe(200);
    const body = await forced.json() as OverrideGuardResponse;
    expect(body.guard.apps['mail-hero']?.desired).toMatchObject({ level: 'shed', source: 'owner' });
    expect(body.guard.apps.todofy?.desired?.source).toBe('auto');
    expect(await guardCalls(h)).toMatchObject({ todofy: [] });
    const cleared = await h.post(PATHS.guard, { level: 'normal', app: 'mail-hero' });
    expect(cleared.status).toBe(200);
    const clearBody = await cleared.json() as OverrideGuardResponse;
    expect(clearBody.guard.apps['mail-hero']?.override).toMatchObject({ level: 'normal', until: '2026-10-02T00:00:00.000Z' });
    expect(await guardCalls(h)).toEqual({
      'mail-hero': [{ level: 'normal', reason: 'owner_clear', until: null }], todofy: [],
    });
    await h.tick(NOW + 60_000);
    expect((await guardCalls(h))['mail-hero']).toEqual([]);
    await h.tick('2026-10-02T00:00:00Z');
    expect((await guardCalls(h))['mail-hero']).toMatchObject([{ level: 'shed', reason: 'quota_d1_rows_read' }]);
  });

  it('shows no aggregate shed after each guarded service is restored while account usage remains high, and excludes unguarded services', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(90) });
    await h.answer('watch', 'status', { value: await status('watch', { capabilities: [] }) });
    await h.tick(NOW - 20 * 60_000);
    for (const app of ['mail-hero', 'todofy'] as const) {
      expect((await h.post(PATHS.guard, { app, level: 'normal' })).status).toBe(200);
    }
    expect((await h.snapshot()).digest.items.some((item) => item.code === 'guard_shed')).toBe(false);
    await h.tick(NOW + 60_000);

    const home = await h.view<HomeView>('home');
    expect(home.body?.cloudflare.guard_level).toBe('normal');
    const snapshot = await h.snapshot();
    expect(snapshot.usage.rows.find((row) => row.id === 'd1_rows_read')?.percent).toBe(90);
    expect(snapshot.guard.apps.watch).toBeUndefined();
    expect(snapshot.guard.apps.mailsort).toBeUndefined();
    expect(await h.callsOf('watch', 'setGuard')).toEqual([]);
    expect(await h.callsOf('mailsort', 'setGuard')).toEqual([]);
    const mailsortGuard = await h.post(PATHS.guard, { app: 'mailsort', level: 'shed' });
    expect(mailsortGuard.status).toBe(503);
    await mailsortGuard.arrayBuffer();
    expect(snapshot.digest.items.some((item) => item.code === 'guard_shed')).toBe(false);
    expect(snapshot.ops.attention.items.some((item) => item.code === 'guard_shed')).toBe(false);
  });

  it('shows one manually delayed service in Home and its own held marker, and lets it expire independently', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick(NOW - 20 * 60_000);
    const held = shedState('2026-10-02T12:00:00.000Z', 'owner_shed', '2026-10-01T12:00:00.000Z');
    await h.answer('watch', 'setGuard', { value: held });
    expect((await h.post(PATHS.guard, { app: 'watch', level: 'shed' })).status).toBe(200);

    const home = await h.view<HomeView>('home');
    expect(home.body?.cloudflare.guard_level).toBe('shed');
    const snapshot = await h.snapshot();
    expect(snapshot.ops.attention.held).toContainEqual({ entry: 'watch', code: 'owner_shed', target: { view: 'ops', entry: 'watch' } });
    expect(snapshot.ops.attention.held.some((item) => item.code === 'owner_shed' && item.entry !== 'watch')).toBe(false);
    expect(snapshot.ops.attention.items.some((item) => item.code === 'guard_shed')).toBe(false);
    expect(await h.callsOf('watch', 'setGuard')).toHaveLength(1);
    for (const app of ['mail-hero', 'todofy'] as const) expect(await h.callsOf(app, 'setGuard')).toEqual([]);

    await h.answer('watch', 'setGuard', undefined);
    await h.tick('2026-10-02T12:01:00Z');
    expect(await h.callsOf('watch', 'setGuard')).toEqual([[{ level: 'normal', reason: 'quota_normal', until: null }]]);
    for (const app of ['mail-hero', 'todofy'] as const) expect(await h.callsOf(app, 'setGuard')).toEqual([]);
  });

  it('restores a cached remote shed even when its earlier receipt was not saved, and replays or rejects request_id reuse', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick(NOW - 20 * 60_000);
    const held = shedState('2026-10-02T00:00:00.000Z', 'owner_shed', '2026-10-01T11:50:00.000Z');
    await h.answer('mail-hero', 'status', { value: await status('mail-hero', { guard: held }) });
    await h.refresh('home');

    const response = await h.post(PATHS.guard, { app: 'mail-hero', level: 'normal' });
    expect(response.status).toBe(200);
    expect(await h.callsOf('mail-hero', 'setGuard')).toEqual([[{ level: 'normal', reason: 'owner_clear', until: null }]]);

    const requestId = 'e6316140-383e-4ee4-8467-6af6a2e03da7';
    const input = { app: 'mail-hero', level: 'shed', request_id: requestId };
    const first = await h.post(PATHS.guard, input);
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    expect(await h.callsOf('mail-hero', 'setGuard')).toHaveLength(1);

    const replay = await h.post(PATHS.guard, input);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
    expect(await h.callsOf('mail-hero', 'setGuard')).toEqual([]);

    const changed = await h.post(PATHS.guard, { ...input, app: 'todofy' });
    expect(changed.status).toBe(400);
    expect(await h.callsOf('todofy', 'setGuard')).toEqual([]);
    expect((await h.snapshot()).guard.apps.todofy?.override).toBeUndefined();
  });

  it('requires old pages to refresh instead of silently changing multiple apps', async () => {
    h = await startFlows();
    const response = await h.post(PATHS.guard, { level: 'shed' });
    expect(response.status).toBe(400);
    expect(await h.called()).toEqual([]);
  });

  it('refuses the override without CSRF', async () => {
    h = await startFlows();
    const response = await h.fetch(PATHS.guard, { method: 'POST', headers: { origin: 'http://127.0.0.1' }, body: '{"level":"shed"}' });
    expect(response.status).toBe(403);
    expect(await h.called()).toEqual([]);
  });
});

