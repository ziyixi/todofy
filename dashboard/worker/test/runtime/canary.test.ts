/**
 * Canary flows in workerd (docs/design.md §5.4): the day's run starts at the first tick at or after
 * CANARY_UTC_HOUR, is polled once per tick, and ends ok, failed(stage, code) or skipped; manual runs
 * are limited. Every stub answer is a contracts/ops-v1 fixture.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpsReport } from '@ziyixi/proto/ops/v1/ops_wire';
import type { CanaryStartResponse } from '../../src/api-types.ts';
import { expectValid, latest, startFlows, status, type FlowHarness } from './flows.ts';
import { fixture } from './harness.ts';

const EVENT_ID = '6d3b2f0e-4c1a-4b7e-8a52-0c9e7f1d2a31';

let h: FlowHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

/** The canary calls of the last tick(s), in order. */
async function canaryCalls(harness: FlowHarness): Promise<string[]> {
  return (await harness.called()).filter((name) => /startCanary|canaryDelivery|canaryResult/.test(name));
}

describe('the scheduled canary', () => {
  it('starts at the configured hour, polls, and ends ok with the stage timeline', async () => {
    h = await startFlows();
    await h.tick('2026-09-29T15:30:00Z');
    expect(await canaryCalls(h)).toEqual([]);

    await h.tick('2026-09-29T16:00:00Z');
    const starts = await h.callsOf('mail-hero', 'startCanary');
    expect(starts).toEqual([[{ run_id: 'canary-2026-09-29' }]]);
    expectValid('StartCanaryInput', starts[0]?.[0]);

    await h.tick('2026-09-29T16:30:00Z');
    expect(await canaryCalls(h)).toEqual(['mail-hero.canaryDelivery', 'todofy.canaryResult']);
    const run = latest(await h.snapshot());
    expect(run).toMatchObject({
      run_id: 'canary-2026-09-29',
      kind: 'scheduled',
      phase: 'done',
      outcome: 'ok',
      stage: null,
      code: null,
      event_id: EVENT_ID,
      created_at: '2026-09-29T16:00:00.000Z',
      queued_at: '2026-09-29T16:00:00.000Z',
      delivered_at: '2026-09-29T22:30:04.512Z',
      completed_at: '2026-09-29T22:31:40.000Z',
      finished_at: '2026-09-29T16:30:00.000Z',
      polls: 3,
      delivery: { state: 'delivered', attempts: 1, last_http_status: 204, error_code: null },
      consumer: { state: 'ok', waiting_code: null, error_code: null },
    });

    // One run a day.
    await h.tick('2026-09-29T17:00:00Z');
    await h.tick('2026-09-29T23:30:00Z');
    expect(await canaryCalls(h)).toEqual([]);
    await h.tick('2026-09-30T16:00:00Z');
    expect(await h.callsOf('mail-hero', 'startCanary')).toEqual([[{ run_id: 'canary-2026-09-30' }]]);
  });

  it('fails at the delivery stage with Mail Hero\'s code', async () => {
    h = await startFlows();
    await h.answer('mail-hero', 'canaryDelivery', { value: await fixture('CanaryDelivery/failed.json') });
    await h.tick('2026-09-29T16:00:00Z');
    await h.tick('2026-09-29T16:30:00Z');
    expect(latest(await h.snapshot())).toMatchObject({ outcome: 'failed', stage: 'delivery', code: 'http_400' });
    expect(await canaryCalls(h)).toEqual(['mail-hero.startCanary', 'mail-hero.canaryDelivery']);
  });

  it('fails at the consumer stage with Todofy\'s code', async () => {
    h = await startFlows();
    await h.answer('todofy', 'canaryResult', { value: await fixture('CanaryResult/failed.json') });
    await h.tick('2026-09-29T16:00:00Z');
    await h.tick('2026-09-29T16:30:00Z');
    expect(latest(await h.snapshot())).toMatchObject({ outcome: 'failed', stage: 'consumer', code: 'llm_quota', completed_at: '2026-09-29T22:34:02.000Z' });
  });

  it('times out after 2 h of pending delivery and reports it in the digest', async () => {
    h = await startFlows();
    await h.answer('mail-hero', 'canaryDelivery', { value: await fixture('CanaryDelivery/pending-retrying.json') });
    await h.tick('2026-09-29T16:00:00Z');
    for (const at of ['16:30', '17:00', '17:30']) await h.tick(`2026-09-29T${at}:00Z`);
    expect(latest(await h.snapshot()).phase).toBe('delivering');
    await h.callsOf('todofy', 'reportOps');
    await h.tick('2026-09-29T18:00:00Z');
    const run = latest(await h.snapshot());
    expect(run).toMatchObject({ phase: 'done', outcome: 'failed', stage: 'delivery', code: 'timeout', polls: 5 });
    expect(run.delivery).toMatchObject({ state: 'pending', attempts: 2, last_http_status: 503, error_code: 'http_503' });
    const reports = (await h.callsOf('todofy', 'reportOps')).map((args) => args[0] as OpsReport);
    expect(reports).toHaveLength(1);
    expectValid('OpsReport', reports[0]);
    expect(reports[0]?.items).toContainEqual({
      source: 'dashboard',
      code: 'canary_not_delivered',
      severity: 'critical',
      since: '2026-09-29T18:00:00.000Z',
      metrics: { attempts: 2, timed_out: 1, last_http_status: 503 },
    });
  });

  it('fails an unreachable Mail Hero at the deadline', async () => {
    h = await startFlows();
    await h.answer('mail-hero', 'canaryDelivery', { throw: 'unavailable' });
    await h.tick('2026-09-29T16:00:00Z');
    for (const at of ['16:30', '17:00', '17:30', '18:00']) await h.tick(`2026-09-29T${at}:00Z`);
    expect(latest(await h.snapshot())).toMatchObject({ outcome: 'failed', stage: 'delivery', code: 'unreachable' });
  });

  it('is skipped (not failed) when sending is paused until the deadline', async () => {
    h = await startFlows();
    await h.answer('mail-hero', 'startCanary', { value: await fixture('StartCanaryResult/paused-send-paused.json') });
    for (const at of ['16:00', '16:30', '17:00', '17:30']) await h.tick(`2026-09-29T${at}:00Z`);
    // While it waits, the ops view says why.
    expect(latest(await h.snapshot())).toMatchObject({ phase: 'starting', outcome: null, start_code: 'send_paused', last_call_error: null });
    await h.tick('2026-09-29T18:00:00Z');
    expect(latest(await h.snapshot())).toMatchObject({ phase: 'done', outcome: 'skipped', stage: 'start', code: 'send_paused', polls: 5 });
    // Each attempt reused the day's run_id.
    const starts = await h.callsOf('mail-hero', 'startCanary');
    expect(new Set(starts.map((args) => JSON.stringify(args[0])))).toEqual(new Set([JSON.stringify({ run_id: 'canary-2026-09-29' })]));
    expect(starts).toHaveLength(5);
    // A skipped run is reported with its reason (contracts/ops-v1 "Daily canary" step 2), as a warning, not a failure.
    expect((await h.snapshot()).digest.items.filter((i) => i.code.startsWith('canary_'))).toEqual([
      { source: 'dashboard', code: 'canary_skipped', severity: 'warning', since: '2026-09-29T18:00:00.000Z', metrics: { send_paused: 1 } },
    ]);
  });

  it('is skipped at the consumer stage when Todofy holds it', async () => {
    h = await startFlows();
    await h.answer('todofy', 'canaryResult', { value: await fixture('CanaryResult/processing-paused.json') });
    await h.tick('2026-09-29T16:00:00Z');
    for (const at of ['16:30', '17:00', '17:30', '18:00']) await h.tick(`2026-09-29T${at}:00Z`);
    expect(latest(await h.snapshot())).toMatchObject({ outcome: 'skipped', stage: 'consumer', code: 'processing_paused' });
  });

  it('never starts a canary when Todofy lacks canary_consumer', async () => {
    h = await startFlows();
    await h.answer('todofy', 'status', { value: await status('todofy', { capabilities: ['guard', 'ops_digest'] }) });
    await h.tick('2026-09-29T16:00:00Z');
    expect(await h.callsOf('mail-hero', 'startCanary')).toEqual([]);
    const snap = await h.snapshot();
    expect(latest(snap)).toMatchObject({ outcome: 'skipped', stage: 'start', code: 'canary_consumer_missing', polls: 0 });
    expect(snap.digest.items).toContainEqual(
      expect.objectContaining({ source: 'dashboard', code: 'canary_skipped', severity: 'warning', metrics: { canary_consumer_missing: 1 } }),
    );
  });

  it('waits for statuses and is skipped as status_unavailable when they never come', async () => {
    h = await startFlows();
    await h.answer('mail-hero', 'status', { throw: 'unavailable' });
    for (const at of ['16:00', '16:30', '17:00', '17:30', '18:00']) await h.tick(`2026-09-29T${at}:00Z`);
    expect(await h.callsOf('mail-hero', 'startCanary')).toEqual([]);
    expect(latest(await h.snapshot())).toMatchObject({ outcome: 'skipped', stage: 'start', code: 'status_unavailable' });
  });
});

describe('manual canary runs', () => {
  it('starts at once, refuses a second while active, and lets ticks finish it', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '0' } });
    const response = await h.post('/api/v2/canary', { canary_id: 'mail-todofy' });
    expect(response.status).toBe(202);
    const { run } = (await response.json()) as CanaryStartResponse;
    expect(run).toMatchObject({ kind: 'manual', phase: 'delivering', event_id: EVENT_ID, polls: 1 });
    expect(run.run_id).toMatch(/^canary-manual-\d{8}T\d{6}Z$/);
    expect(await h.callsOf('mail-hero', 'startCanary')).toEqual([[{ run_id: run.run_id }]]);

    const second = await h.post('/api/v2/canary', { canary_id: 'mail-todofy' });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: 'canary_active' } });

    // The next tick advances the manual run and does not start the scheduled one alongside it.
    await h.tick(Date.now() + 60_000);
    const snap = await h.snapshot();
    expect(snap.canary.active).toBeNull();
    expect(snap.canary.recent.map((r) => [r.kind, r.outcome])).toEqual([['manual', 'ok']]);
    expect(snap.canary.manual_today).toBe(1);
    expect(await h.callsOf('mail-hero', 'startCanary')).toEqual([]);
  });

  it('allows three manual runs per UTC day', async () => {
    h = await startFlows();
    // Mail Hero without canary_producer: each run ends (skipped) at once, freeing the next.
    await h.answer('mail-hero', 'status', { value: await status('mail-hero', { capabilities: ['guard'] }) });
    for (let i = 0; i < 3; i++) {
      const response = await h.post('/api/v2/canary', { canary_id: 'mail-todofy' });
      expect(response.status).toBe(202);
      expect(((await response.json()) as CanaryStartResponse).run).toMatchObject({ outcome: 'skipped', code: 'canary_producer_missing' });
    }
    // Started within the same second, yet three distinct run IDs.
    expect(new Set((await h.snapshot()).canary.recent.map((r) => r.run_id)).size).toBe(3);
    const fourth = await h.post('/api/v2/canary', { canary_id: 'mail-todofy' });
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({ error: { code: 'canary_limit' } });
    // status() was polled once for all of them (at most every 10 minutes).
    expect(await h.callsOf('mail-hero', 'status')).toHaveLength(1);
  });
});

describe('the canary switch (CANARY_ENABLED)', () => {
  it('starts nothing while false, refuses manual runs, and never reports a missing run', async () => {
    // Hour 0: every tick is past the canary hour. Ticks up to a minute ago keep the views current.
    h = await startFlows({ bindings: { CANARY_ENABLED: 'false', CANARY_UTC_HOUR: '0' } });
    const now = Date.now();
    for (const minutes of [150, 120, 90, 60, 30, 1]) await h.tick(now - minutes * 60_000);
    // The digest went out, without any canary item (none for "not run today" either).
    const reports = (await h.callsOf('todofy', 'reportOps')).map((args) => args[0] as OpsReport);
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expectValid('OpsReport', report);
      expect(report.items.filter((item) => item.code.startsWith('canary_'))).toEqual([]);
    }
    expect(await canaryCalls(h)).toEqual([]);

    const response = await h.post('/api/v2/canary', { canary_id: 'mail-todofy' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'canary_disabled', message: '金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）' },
    });
    // Refused before anything is called (no status poll, no startCanary).
    expect(await h.called()).toEqual([]);

    const snap = await h.snapshot();
    expect(snap.canary).toMatchObject({ enabled: false, next_scheduled_at: null, active: null, today: null, recent: [], manual_today: 0 });
    // Shown on the page as an info item that leaves the level alone ...
    expect(snap.overall).toEqual({ level: 'ok', items: [{ source: 'dashboard', code: 'canary_disabled', severity: 'info' }] });
    // ... and never part of the digest.
    expect(snap.digest.items).toEqual([]);
  });

  it('keeps polling a run in progress to its end, then starts no new one until switched back on', async () => {
    h = await startFlows();
    await h.answer('mail-hero', 'canaryDelivery', { value: await fixture('CanaryDelivery/pending-retrying.json') });
    await h.tick('2026-09-29T16:00:00Z');
    expect(latest(await h.snapshot())).toMatchObject({ run_id: 'canary-2026-09-29', phase: 'delivering' });
    await canaryCalls(h);

    // Switched off with the run in flight (the step before a Todofy rollback).
    await h.redeploy({ CANARY_ENABLED: 'false' });
    const manual = await h.post('/api/v2/canary', { canary_id: 'mail-todofy' });
    expect(manual.status).toBe(409);
    expect(await manual.json()).toMatchObject({ error: { code: 'canary_disabled' } });
    const during = await h.snapshot();
    expect(during.canary).toMatchObject({ enabled: false, next_scheduled_at: null, active: { run_id: 'canary-2026-09-29' } });

    await h.tick('2026-09-29T16:30:00Z');
    expect(await canaryCalls(h)).toEqual(['mail-hero.canaryDelivery']);
    await h.answer('mail-hero', 'canaryDelivery', undefined);
    await h.tick('2026-09-29T17:00:00Z');
    expect(await canaryCalls(h)).toEqual(['mail-hero.canaryDelivery', 'todofy.canaryResult']);
    const drained = await h.snapshot();
    expect(drained.canary.active).toBeNull();
    expect(latest(drained)).toMatchObject({ run_id: 'canary-2026-09-29', phase: 'done', outcome: 'ok' });

    // No run the next day while off.
    for (const at of ['2026-09-30T16:00:00Z', '2026-09-30T16:30:00Z']) await h.tick(at);
    expect(await canaryCalls(h)).toEqual([]);
    expect((await h.snapshot()).digest.items.filter((i) => i.code.startsWith('canary_'))).toEqual([]);

    // Switched back on: the day's scheduled run starts at the next tick.
    await h.redeploy({ CANARY_ENABLED: 'true' });
    const enabled = await h.snapshot();
    expect(enabled.canary.enabled).toBe(true);
    expect(enabled.canary.next_scheduled_at).toEqual(expect.any(String));
    expect(enabled.overall.items.filter((item) => item.code === 'canary_disabled')).toEqual([]);
    await h.tick('2026-09-30T17:00:00Z');
    expect(await h.callsOf('mail-hero', 'startCanary')).toEqual([[{ run_id: 'canary-2026-09-30' }]]);
  });

  it('ends a run that was not queued yet without another start attempt, and without a digest item', async () => {
    h = await startFlows();
    await h.answer('mail-hero', 'startCanary', { value: await fixture('StartCanaryResult/paused-send-paused.json') });
    await h.tick('2026-09-29T16:00:00Z');
    expect(latest(await h.snapshot())).toMatchObject({ phase: 'starting', start_code: 'send_paused' });
    await canaryCalls(h);

    await h.redeploy({ CANARY_ENABLED: 'false' });
    await h.tick('2026-09-29T16:30:00Z');
    expect(await canaryCalls(h)).toEqual([]);
    const snap = await h.snapshot();
    expect(snap.canary.active).toBeNull();
    expect(latest(snap)).toMatchObject({ phase: 'done', outcome: 'skipped', stage: 'start', code: 'canary_disabled', polls: 1 });
    expect(snap.digest.items.filter((i) => i.code.startsWith('canary_'))).toEqual([]);
  });
});
