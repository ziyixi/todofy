/**
 * Digest and app-health flows in workerd (docs/design.md §5.1, §5.5): reports go to Todofy's
 * reportOps on a change, at least every 6 h and at 23:30 UTC; failures retry; an unreachable app
 * becomes an item while the other app is still handled.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpsReport } from '../../../../contracts/ops-v1/ops-v1.ts';
import { d1Reads, expectValid, startFlows, status, type FlowHarness } from './flows.ts';
import { fixture } from './harness.ts';

let h: FlowHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

async function reports(harness: FlowHarness): Promise<OpsReport[]> {
  const list = (await harness.callsOf('todofy', 'reportOps')).map((args) => args[0] as OpsReport);
  for (const report of list) await expectValid('OpsReport', report);
  return list;
}

const keys = (report: OpsReport | undefined): string[] => (report?.items ?? []).map((i) => `${i.source}:${i.code}:${i.severity}`);

describe('the digest', () => {
  it('sends the first report, then only on change, every 6 h and at 23:30 UTC', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick('2026-09-29T10:00:00Z');
    const first = await reports(h);
    expect(first).toEqual([{ generated_at: '2026-09-29T10:00:00.000Z', items: [], dashboard_url: 'https://home.example.com/' }]);

    await h.tick('2026-09-29T10:30:00Z');
    expect(await reports(h)).toEqual([]);

    const degraded = await fixture('OpsStatus/mail-hero-degraded.json');
    await h.answer('mail-hero', 'status', { value: degraded });
    await h.tick('2026-09-29T11:00:00Z');
    const changed = await reports(h);
    expect(changed).toHaveLength(1);
    expect(keys(changed[0]).length).toBeGreaterThan(0);
    expect(keys(changed[0]).every((key) => key.startsWith('mail-hero:'))).toBe(true);

    for (const at of ['11:30', '12:00', '14:00', '16:30']) await h.tick(`2026-09-29T${at}:00Z`);
    expect(await reports(h)).toEqual([]);
    await h.tick('2026-09-29T17:00:00Z');
    const refreshed = await reports(h);
    expect(refreshed).toHaveLength(1);
    expect(keys(refreshed[0])).toEqual(keys(changed[0]));

    await h.tick('2026-09-29T22:00:00Z');
    expect(await reports(h)).toEqual([]);
    await h.tick('2026-09-29T23:30:00Z');
    expect((await reports(h)).map((r) => r.generated_at)).toEqual(['2026-09-29T23:30:00.000Z']);

    // Back to healthy: an empty report clears Todofy's ops section.
    await h.answer('mail-hero', 'status', undefined);
    await h.tick('2026-09-30T00:00:00Z');
    expect((await reports(h)).map((r) => r.items)).toEqual([[]]);
  });

  it('carries quota items with numeric metrics and keeps `since` across ticks', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(96) });
    await h.tick('2026-09-29T10:00:00Z');
    const [report] = await reports(h);
    const quota = report?.items.find((i) => i.code === 'd1_rows_read_high');
    expect(quota).toMatchObject({ source: 'cloudflare', severity: 'critical', since: '2026-09-29T10:00:00.000Z' });
    expect(quota?.metrics).toMatchObject({ percent: 96, used: 4_800_000, limit: 5_000_000 });
    expect(keys(report)).toContain('dashboard:guard_shed:warning');

    h.analytics.answer = d1Reads(85);
    await h.tick('2026-09-29T10:30:00Z');
    const [next] = await reports(h);
    // The severity changed (critical -> warning), so the set changed; the episode's start did not.
    expect(next?.items.find((i) => i.code === 'd1_rows_read_high')).toMatchObject({ severity: 'warning', since: '2026-09-29T10:00:00.000Z' });
  });

  it('sends nothing while Todofy does not list ops_digest', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('todofy', 'status', { value: await status('todofy', { capabilities: ['canary_consumer', 'guard'] }) });
    await h.tick('2026-09-29T10:00:00Z');
    await h.tick('2026-09-29T17:00:00Z');
    expect(await reports(h)).toEqual([]);
    expect((await h.overview()).digest).toMatchObject({ enabled: false, last_sent_at: null });
  });

  it('retries a failed reportOps on the next tick', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('todofy', 'reportOps', { sequence: [{ throw: 'unavailable' }, { value: await fixture('OpsReportReceipt/stored.json') }] });
    await h.tick('2026-09-29T10:00:00Z');
    expect(await reports(h)).toHaveLength(1);
    expect((await h.overview()).digest).toMatchObject({ last_error: 'unavailable', last_sent_at: null });
    await h.tick('2026-09-29T10:30:00Z');
    expect(await reports(h)).toHaveLength(1);
    const digest = (await h.overview()).digest;
    expect(digest).toMatchObject({ last_error: null, last_sent_at: '2026-09-29T10:30:00.000Z', next_due_at: '2026-09-29T16:30:00.000Z' });
    expect(digest.last_receipt).toEqual(await fixture('OpsReportReceipt/stored.json'));
    await h.tick('2026-09-29T11:00:00Z');
    expect(await reports(h)).toEqual([]);
  });

  it('counts a receipt for a newer stored report as sent', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('todofy', 'reportOps', { value: await fixture('OpsReportReceipt/kept-newer.json') });
    await h.tick('2026-09-29T10:00:00Z');
    await h.tick('2026-09-29T10:30:00Z');
    expect(await reports(h)).toHaveLength(1);
  });
});

describe('app health', () => {
  it('reports an unreachable app after two failed status calls and keeps handling the other', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick('2026-09-29T10:00:00Z');
    await reports(h);
    await h.answer('mail-hero', 'status', { throw: 'The RPC receiver does not implement the method "status"' });
    await h.tick('2026-09-29T10:30:00Z');
    expect(await reports(h)).toEqual([]);
    await h.tick('2026-09-29T11:00:00Z');
    const [report] = await reports(h);
    expect(keys(report)).toEqual(['mail-hero:app_unreachable:critical']);
    expect(report?.items[0]?.metrics).toEqual({ consecutive_failures: 2 });

    const overview = await h.overview();
    expect(overview.overall).toEqual({ level: 'critical', codes: ['app_unreachable'] });
    expect(overview.apps['mail-hero']).toMatchObject({ reachable: false, error: 'unavailable', consecutive_failures: 2, checked_at: '2026-09-29T11:00:00.000Z', status_at: '2026-09-29T10:00:00.000Z' });
    expect(overview.apps['mail-hero'].status).not.toBeNull();
    expect(overview.apps.todofy).toMatchObject({ reachable: true, consecutive_failures: 0 });
  });

  it('keeps the contract error codes and refuses invalid output', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('mail-hero', 'status', { throw: 'busy' });
    await h.answer('todofy', 'status', { value: await fixture('invalid/OpsStatus/missing-guard.json') });
    await h.tick('2026-09-29T10:00:00Z');
    const overview = await h.overview();
    expect(overview.apps['mail-hero']).toMatchObject({ reachable: false, error: 'busy', status: null });
    expect(overview.apps.todofy).toMatchObject({ reachable: false, error: 'invalid_output', status: null });
    // Without any Todofy status: no digest, no canary, no guard calls.
    expect(await h.called()).toEqual(['mail-hero.status', 'todofy.status']);
  });

  it('passes on down health and warning/critical signals', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.answer('mail-hero', 'status', { value: await fixture('OpsStatus/mail-hero-maintenance.json') });
    await h.tick('2026-09-29T10:00:00Z');
    const [report] = await reports(h);
    expect(keys(report)).toContain('mail-hero:app_down:critical');
    expect(keys(report)).toContain('mail-hero:maintenance_mode:critical');
  });
});
