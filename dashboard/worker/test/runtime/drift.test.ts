/**
 * The configuration drift check in workerd (docs/design-v2.md §10): the real HomeState runs the day's check
 * across cron ticks against a fake Cloudflare API built from the bundled desired state (synthetic ids and
 * values), stores the result, shows it on GET /api/v2/cloudflare and reports it in the ops digest that
 * Todofy's stub receives. Names only: no value, id or token reaches a view or the report.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpsReport } from '@ziyixi/proto/ops/v1/ops_wire';
import { DRIFT_CALLS_PER_TICK, DRIFT_UTC_HOUR, type CloudflareResponse, type OpsResponse } from '../../src/api-v2-types.ts';
import { outboundPerTick } from '../../src/registry.ts';
import { CF_API, SENTINEL_VALUE } from '../drift-fixture.ts';
import { GRAPHQL, SYNTHETIC_BINDINGS, startFlows, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const MIN = 60_000;
const DAY_MS = 86_400_000;
const TOKEN = SYNTHETIC_BINDINGS.CF_ANALYTICS_TOKEN ?? '';

/** DRIFT_UTC_HOUR:00 UTC `daysAgo` days before today (always in the past). */
function driftHour(daysAgo: number): number {
  return Math.floor(Date.now() / DAY_MS) * DAY_MS - daysAgo * DAY_MS + DRIFT_UTC_HOUR * 60 * MIN;
}

async function view<T>(harness: FlowHarness, path: string): Promise<T> {
  const answer = await harness.v2<T>(path);
  expect(answer.status).toBe(200);
  if (answer.body === null) throw new Error(`no body for ${path}`);
  return answer.body;
}

function driftRequests(harness: FlowHarness): number {
  return harness.cloudflare.requests.splice(0).length;
}

describe('the daily drift check', () => {
  it('runs across three ticks within DRIFT_CALLS_PER_TICK calls each, with GETs only, and shows ok', async () => {
    h = await startFlows();
    const start = driftHour(1);
    await h.tick(start - 30 * MIN);
    expect(driftRequests(h)).toBe(0);
    await h.tick(start);
    const first = h.cloudflare.requests.splice(0);
    expect(first).toHaveLength(DRIFT_CALLS_PER_TICK);
    for (const request of first) {
      expect(request.method).toBe('GET');
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.url.startsWith(`${CF_API}/`)).toBe(true);
    }
    // The whole tick (RPCs, GraphQL, probe, drift) stays within outboundPerTick().
    const tick = [...(await h.called()), ...h.outboundLog.splice(0)];
    expect(tick.length).toBeLessThanOrEqual(outboundPerTick());
    expect((await view<CloudflareResponse>(h, 'cloudflare')).drift).toMatchObject({ status: 'never_checked', checked_at: null });

    // Four Workers, then the last two of the nine (three calls each).
    await h.tick(start + 30 * MIN);
    expect(driftRequests(h)).toBe(12);
    expect((await view<CloudflareResponse>(h, 'cloudflare')).drift).toMatchObject({ status: 'never_checked', checked_at: null });
    await h.tick(start + 60 * MIN);
    expect(driftRequests(h)).toBe(6);
    const cloudflare = await view<CloudflareResponse>(h, 'cloudflare');
    expect(cloudflare.drift).toMatchObject({ status: 'ok', in_progress: false, desired_workers: 9, findings: [], findings_omitted: 0, last_error: null });
    expect(cloudflare.drift.checked_at).toBe(new Date(start + 60 * MIN).toISOString());
    const ops = await view<OpsResponse>(h, 'ops');
    expect(ops.digest.items.filter((item) => item.code === 'config_drift')).toEqual([]);
    // Once a day: later ticks of the same day make no drift call.
    await h.tick(start + 90 * MIN);
    expect(driftRequests(h)).toBe(0);
    // The GraphQL query still carries the same token; nothing else got it.
    expect(h.analytics.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(h.outboundLog.every((url) => url === GRAPHQL || url.startsWith(`${CF_API}/`) || url.startsWith('https://www.'))).toBe(true);
  });

  it('reports drift by name on the Cloudflare view and by counts in the digest, never a value', async () => {
    h = await startFlows();
    h.cloudflare.tweaks = {
      bindings: { 'todofy-core': { TODOIST_DEFAULT_PROJECT_ID: 'plain_text' } },
      extraScripts: ['synthetic-orphan'],
      extraDomains: [{ hostname: 'stray.ziyixi.science', service: 'home' }],
    };
    const start = driftHour(1);
    for (let k = 0; k < 3; k++) await h.tick(start + k * 30 * MIN);
    const cloudflare = await view<CloudflareResponse>(h, 'cloudflare');
    expect(cloudflare.drift.status).toBe('drift');
    expect(cloudflare.drift.counts).toEqual({ scripts: 1, custom_domains: 1, routes: 0, crons: 0, bindings: 1, workers_dev: 0, personal: 0 });
    expect(cloudflare.drift.findings).toContainEqual({ category: 'scripts', script: 'synthetic-orphan', name: 'synthetic-orphan', kind: 'extra' });
    expect(cloudflare.drift.findings).toContainEqual({ category: 'custom_domains', script: 'home', name: 'stray.ziyixi.science', kind: 'extra' });
    expect(cloudflare.drift.findings).toContainEqual({ category: 'bindings', script: 'todofy-core', name: 'TODOIST_DEFAULT_PROJECT_ID', kind: 'changed', expected: 'secret_text', actual: 'plain_text' });
    // The strip points at the Cloudflare view.
    expect(cloudflare.attention.items).toContainEqual(expect.objectContaining({ source: 'dashboard', code: 'config_drift', target: { view: 'cloudflare' } }));

    const ops = await view<OpsResponse>(h, 'ops');
    const item = ops.digest.items.find((i) => i.code === 'config_drift');
    expect(item).toMatchObject({ source: 'dashboard', severity: 'warning', metrics: { total: 3, scripts: 1, custom_domains: 1, bindings: 1 } });
    // Todofy got it in a report: counts only.
    const reports = (await h.callsOf('todofy', 'reportOps')).map((args) => args[0] as OpsReport);
    const last = reports.at(-1);
    expect(last?.items.find((i) => i.code === 'config_drift')?.metrics).toEqual({ total: 3, scripts: 1, custom_domains: 1, bindings: 1 });
    const reportText = JSON.stringify(reports);
    expect(reportText).not.toContain('TODOIST_DEFAULT_PROJECT_ID');
    expect(reportText).not.toContain('synthetic-orphan');

    for (const text of [JSON.stringify(cloudflare), JSON.stringify(ops), reportText]) {
      expect(text).not.toContain(SENTINEL_VALUE);
      expect(text).not.toContain(TOKEN);
    }
    // No id of the API answers (account, zone, script tags, binding ids) reaches the drift panel.
    expect(JSON.stringify(cloudflare.drift)).not.toMatch(/[0-9a-f]{32}/);
  });

  it('retries a failing step on later ticks, gives the day up after three attempts, and reports drift_unavailable on the second day', async () => {
    h = await startFlows();
    h.cloudflare.tweaks = { fail: { path: /\/settings$/, status: 403 } };
    for (const daysAgo of [2, 1]) {
      const start = driftHour(daysAgo);
      for (let k = 0; k < 4; k++) await h.tick(start + k * 30 * MIN);
      // Three attempts that day (the fourth tick makes no call).
      const cloudflare = await view<CloudflareResponse>(h, 'cloudflare');
      expect(cloudflare.drift).toMatchObject({ status: 'failing', last_error: 'http_403', last_error_step: 'script', consecutive_failed_days: daysAgo === 2 ? 1 : 2, in_progress: false });
    }
    const ops = await view<OpsResponse>(h, 'ops');
    expect(ops.digest.items).toContainEqual(expect.objectContaining({ source: 'dashboard', code: 'drift_unavailable', severity: 'warning', metrics: { consecutive_failed_days: 2 } }));
    expect(ops.digest.items.filter((item) => item.code === 'config_drift')).toEqual([]);

    // The API answers again: the next day's check succeeds and both items clear.
    h.cloudflare.tweaks = {};
    const today = driftHour(0);
    if (today + 60 * MIN < Date.now()) {
      for (let k = 0; k < 3; k++) await h.tick(today + k * 30 * MIN);
      const after = await view<OpsResponse>(h, 'ops');
      expect(after.digest.items.filter((item) => item.code === 'drift_unavailable' || item.code === 'config_drift')).toEqual([]);
      expect((await view<CloudflareResponse>(h, 'cloudflare')).drift).toMatchObject({ status: 'ok', consecutive_failed_days: 0 });
    }
  });

  it('makes no call without the token and says not_configured', async () => {
    h = await startFlows({ bindings: { CF_ANALYTICS_TOKEN: '' } });
    await h.tick(driftHour(1));
    await h.tick(driftHour(1) + 30 * MIN);
    expect(driftRequests(h)).toBe(0);
    expect((await view<CloudflareResponse>(h, 'cloudflare')).drift.status).toBe('not_configured');
  });
});
