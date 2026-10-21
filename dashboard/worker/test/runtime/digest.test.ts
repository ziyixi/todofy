/**
 * Digest and app-health flows in workerd (docs/design.md §5.1, §5.5): the digest's one task a UTC day goes to Tasks'
 * TaskInbox at the first tick of the day with items (the release's first day is left to Todofy's reminder), with the
 * same frozen request on every retry, and `digest_task_failed` when the day's tries run out; an unreachable app
 * becomes an item while the other app is still handled.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpsReportItem } from '@ziyixi/proto/ops/v1/ops_wire';
import { CreateInboxTaskRequestSchema } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_pb';
import type { CreateInboxTaskRequest } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_wire';
import { fromWire } from '@ziyixi/proto/wire-json';
import { DIGEST_TASK_ATTEMPTS } from '../../src/api-types.ts';
import { d1Reads, NOW, startFlows, type FlowHarness } from './flows.ts';
import { fixture, SYNTHETIC_TASK } from './harness.ts';

let h: FlowHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

/** The day's task requests Home sent since the last call, each checked as TaskInbox reads it (strictly). */
async function tasks(harness: FlowHarness): Promise<CreateInboxTaskRequest[]> {
  const list = (await harness.callsOf('tasks', 'createInboxTask')).map((args) => args[0] as CreateInboxTaskRequest);
  for (const request of list) expect(() => fromWire(CreateInboxTaskRequestSchema, request, { strict: true })).not.toThrow();
  return list;
}

/** The stored items as `source:code:severity`. */
async function items(harness: FlowHarness): Promise<string[]> {
  return (await harness.snapshot()).digest.items.map((i: OpsReportItem) => `${i.source}:${i.code}:${i.severity}`);
}

describe("the digest's daily task", () => {
  it('creates one task a UTC day at its first tick with items, from the day after the release', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('mail-hero', 'status', { value: await fixture('OpsStatus/mail-hero-degraded.json') });
    // The release's day: Todofy's reminder had it.
    await h.tick('2026-09-29T10:00:00Z');
    await h.tick('2026-09-29T23:30:00Z');
    expect(await tasks(h)).toEqual([]);

    await h.tick('2026-09-30T00:00:00Z');
    const [task, ...more] = await tasks(h);
    expect(more).toEqual([]);
    expect(task?.title).toMatch(/^运维摘要 2026-09-30：\d+ 项需要关注$/);
    expect(task?.description).toContain('· mail-hero · ');
    expect(task?.description).toContain('查看 Home：https://home.example.com/');
    for (const at of ['00:30', '12:00', '23:30']) await h.tick(`2026-09-30T${at}:00Z`);
    expect(await tasks(h)).toEqual([]);
    const digest = (await h.snapshot()).digest;
    expect(digest).toMatchObject({ enabled: true, last_sent_at: '2026-09-30T00:00:00.000Z', last_generated_at: '2026-09-30T00:00:00.000Z', last_error: null, next_due_at: '2026-10-01T00:00:00.000Z' });
    expect(digest.last_receipt).toMatchObject({ stored: true, generated_at: '2026-09-30T00:00:00.000Z' });
  });

  it('waits for the first tick of a day that has items', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick('2026-09-29T10:00:00Z');
    await h.tick('2026-09-30T00:00:00Z');
    await h.tick('2026-09-30T00:30:00Z');
    expect(await tasks(h)).toEqual([]);
    await h.answer('mail-hero', 'status', { value: await fixture('OpsStatus/mail-hero-maintenance.json') });
    await h.tick('2026-09-30T01:00:00Z');
    const [task] = await tasks(h);
    expect(task?.description).toContain('critical · mail-hero · maintenance_mode');
  });

  it('carries quota items with numeric metrics and keeps `since` across ticks', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(96) });
    await h.tick('2026-09-29T10:00:00Z');
    const quota = (await h.snapshot()).digest.items.find((i) => i.code === 'd1_rows_read_high');
    expect(quota).toMatchObject({ source: 'cloudflare', severity: 'critical', since: '2026-09-29T10:00:00.000Z' });
    expect(quota?.metrics).toMatchObject({ percent: 96, used: 4_800_000, limit: 5_000_000 });
    expect(await items(h)).toContain('dashboard:guard_shed:warning');

    h.analytics.answer = d1Reads(85);
    await h.tick('2026-09-30T00:00:00Z');
    // The severity changed (critical -> warning); the episode's start did not.
    expect((await h.snapshot()).digest.items.find((i) => i.code === 'd1_rows_read_high')).toMatchObject({ severity: 'warning', since: '2026-09-29T10:00:00.000Z' });
    const [task] = await tasks(h);
    expect(task?.description).toContain('warning · cloudflare · d1_rows_read_high · 自 2026-09-29T10:00:00.000Z · percent=85');
  });

  it(`retries the same request on each tick, ${String(DIGEST_TASK_ATTEMPTS)} times, then raises digest_task_failed for the day`, async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('mail-hero', 'status', { value: await fixture('OpsStatus/mail-hero-degraded.json') });
    await h.answer('tasks', 'createInboxTask', { sequence: [{ throw: 'daily_limit' }, { throw: 'unavailable' }] });
    await h.tick('2026-09-30T23:30:00Z');
    const day = new Date(NOW).toISOString().slice(0, 10);
    for (let k = 0; k < DIGEST_TASK_ATTEMPTS + 2; k++) await h.tick(Date.parse(`${day}T00:00:00Z`) + k * 30 * 60_000);
    const sent = await tasks(h);
    expect(sent).toHaveLength(DIGEST_TASK_ATTEMPTS);
    expect(new Set(sent.map((request) => JSON.stringify(request))).size).toBe(1);
    const snap = await h.snapshot();
    expect(snap.digest).toMatchObject({ last_error: 'unavailable', last_sent_at: null });
    expect(snap.overall.items).toContainEqual({ source: 'dashboard', code: 'digest_task_failed', severity: 'warning' });
  });

  it('reads daily_limit as busy and succeeds on a later tick with the same request', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('mail-hero', 'status', { value: await fixture('OpsStatus/mail-hero-degraded.json') });
    await h.answer('tasks', 'createInboxTask', { sequence: [{ throw: 'daily_limit' }, { value: SYNTHETIC_TASK }] });
    await h.tick('2026-09-29T10:00:00Z');
    await h.tick('2026-09-30T00:00:00Z');
    expect((await h.snapshot()).digest).toMatchObject({ last_error: 'busy', last_sent_at: null });
    await h.tick('2026-09-30T00:30:00Z');
    const [first, second] = await tasks(h);
    expect(second).toEqual(first);
    expect((await h.snapshot()).digest).toMatchObject({ last_error: null, last_sent_at: '2026-09-30T00:30:00.000Z' });
  });
});

describe('app health', () => {
  it('reports an unreachable app after two failed status calls and keeps handling the other', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick('2026-09-29T10:00:00Z');
    await h.answer('mail-hero', 'status', { throw: 'The RPC receiver does not implement the method "status"' });
    await h.tick('2026-09-29T10:30:00Z');
    expect(await items(h)).toEqual([]);
    await h.tick('2026-09-29T11:00:00Z');
    const snap = await h.snapshot();
    expect(snap.digest.items.map((i) => `${i.source}:${i.code}:${i.severity}`)).toEqual(['mail-hero:app_unreachable:critical']);
    expect(snap.digest.items[0]?.metrics).toEqual({ consecutive_failures: 2 });

    expect(snap.overall.level).toBe('critical');
    // (These synthetic ticks lie in the past, so the banner also says the ticks stopped.)
    expect(snap.overall.items.filter((item) => item.code !== 'tick_stale')).toEqual([{ source: 'mail-hero', code: 'app_unreachable', severity: 'critical' }]);
    expect(snap.apps['mail-hero']).toMatchObject({ reachable: false, error: 'unavailable', consecutive_failures: 2, checked_at: '2026-09-29T11:00:00.000Z', status_at: '2026-09-29T10:00:00.000Z' });
    expect(snap.apps['mail-hero'].status).not.toBeNull();
    expect(snap.apps.todofy).toMatchObject({ reachable: true, consecutive_failures: 0 });
  });

  it('keeps the source of each banner item, so the same code from both apps stays two entries', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('mail-hero', 'status', { throw: 'unavailable' });
    await h.answer('todofy', 'status', { throw: 'busy' });
    await h.tick(NOW - 40 * 60_000);
    await h.tick(NOW - 5 * 60_000);
    const snap = await h.snapshot();
    expect(snap.overall).toEqual({
      level: 'critical',
      items: [
        { source: 'mail-hero', code: 'app_unreachable', severity: 'critical' },
        { source: 'todofy', code: 'app_unreachable', severity: 'critical' },
      ],
    });
  });

  it('keeps the contract error codes and refuses invalid output', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('mail-hero', 'status', { throw: 'busy' });
    await h.answer('todofy', 'status', { value: await fixture('invalid/OpsStatus/missing-guard.json') });
    await h.tick('2026-09-29T10:00:00Z');
    const snap = await h.snapshot();
    expect(snap.apps['mail-hero']).toMatchObject({ reachable: false, error: 'busy', status: null });
    expect(snap.apps.todofy).toMatchObject({ reachable: false, error: 'invalid_output', status: null });
    // Without any Todofy status: no canary and no guard calls.
    expect(await h.called()).toEqual(['mail-hero.status', 'todofy.status']);
  });

  it('passes on down health and warning/critical signals', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('mail-hero', 'status', { value: await fixture('OpsStatus/mail-hero-maintenance.json') });
    await h.tick('2026-09-29T10:00:00Z');
    expect(await items(h)).toContain('mail-hero:app_down:critical');
    expect(await items(h)).toContain('mail-hero:maintenance_mode:critical');
  });
});
