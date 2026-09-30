/**
 * The owner API end to end in workerd: Access JWTs verified against a test JWKS served through the
 * outbound handler, the overview's shape and refresh rate limit, the tick deduplication, and the
 * bounded Durable Object storage (60-day canary retention, 14 recent runs).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QUOTA_RESOURCES, type OverviewResponse } from '../../src/api-types.ts';
import { accessClaims, testIssuer, type TestIssuer } from '../jwt.ts';
import { expectValid, startFlows, SYNTHETIC_BINDINGS, type FlowHarness } from './flows.ts';

const ISSUER = SYNTHETIC_BINDINGS.ACCESS_ISSUER ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS.ACCESS_AUDIENCE ?? '';

let issuer: TestIssuer;
let h: FlowHarness | undefined;
beforeAll(async () => {
  issuer = await testIssuer();
});
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

describe('Access end to end', () => {
  it('verifies Access JWTs in workerd and serves the page only to the owner', async () => {
    h = await startFlows({ bindings: { DEV_AUTH_BYPASS: 'false', ACCESS_OWNER_ALIASES: 'second@example.org' } });
    let certs = 0;
    h.routes.set(`${ISSUER}/cdn-cgi/access/certs`, () => {
      certs++;
      return Response.json(issuer.jwks);
    });
    const as = async (email: string | null, path = '/api/v1/overview') =>
      h?.fetch(path, email === null ? {} : { headers: { 'cf-access-jwt-assertion': await issuer.sign(accessClaims(ISSUER, AUDIENCE, email)) } });

    expect((await as(null))?.status).toBe(401);
    expect((await as('someone@example.com'))?.status).toBe(401);
    for (const email of ['owner@example.com', 'OWNER@example.com', 'second@example.org']) {
      const response = await as(email);
      expect(response?.status).toBe(200);
      await response?.arrayBuffer();
    }
    const page = await as('owner@example.com', '/');
    expect(page?.status).toBe(200);
    expect(page?.headers.get('content-security-policy')).toContain("default-src 'self'");
    await page?.arrayBuffer();
    expect(certs).toBe(1);

    const health = await h.fetch('/health');
    expect(await health.json()).toEqual({ service: 'home', status: 'ok', build: 'test' });

    // The CSRF token is bound to the owner and the https origin of PUBLIC_HOST.
    const jwt = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
    const csrf = await h.fetch('/api/v1/csrf', { headers: { 'cf-access-jwt-assertion': jwt } });
    const { token } = (await csrf.json()) as { token: string };
    const cookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const post = (origin: string) =>
      h?.fetch('/api/v1/guard', {
        method: 'POST',
        headers: { 'cf-access-jwt-assertion': jwt, origin, 'x-csrf-token': token, cookie },
        body: '{"level":"shed"}',
      });
    expect((await post('http://127.0.0.1'))?.status).toBe(403);
    const accepted = await post('https://home.example.com');
    expect(accepted?.status).toBe(200);
    await accepted?.arrayBuffer();
  });
});

describe('the overview', () => {
  it('is unknown before the first tick and complete after it', async () => {
    h = await startFlows();
    const before = await h.overview();
    expect(before.overall).toEqual({ level: 'unknown', items: [] });
    expect(before.apps['mail-hero']).toMatchObject({ reachable: null, status: null, url: 'https://mail.example.com/' });
    expect(before.usage).toMatchObject({ status: 'unavailable', rows: [] });
    expect(before.canary).toMatchObject({ hour_utc: 16, today: null, active: null, recent: [], manual_today: 0, manual_limit: 3 });
    expect(before.refresh).toMatchObject({ last_tick_at: null, refreshed: false });

    const now = Date.now();
    await h.tick(now - 60_000);
    const after: OverviewResponse = await h.overview();
    expect(after.version).toBe('home-v1');
    expect(after.build).toBe('test');
    expect(after.overall.level).toBe('ok');
    expect(after.usage.status).toBe('ok');
    expect(after.usage.rows.map((row) => row.id)).toEqual(QUOTA_RESOURCES);
    for (const row of after.usage.rows) expect(row.source).toMatch(/^https:\/\/developers\.cloudflare\.com\//);
    await expectValid('OpsStatus', after.apps['mail-hero'].status);
    await expectValid('OpsStatus', after.apps.todofy.status);
    expect(after.apps.todofy.url).toBe('https://todofy.example.com/');
    expect(after.guard).toMatchObject({ thresholds: { shed_percent: 80, clear_percent: 70 }, override: null });
    expect(after.digest).toMatchObject({ enabled: true, items: [] });
    expect(after.refresh.last_tick_at).toBe(new Date(now - 60_000).toISOString());
    for (const item of after.digest.items) await expectValid('OpsReportItem', item);
    // No token, owner or remote text anywhere in the answer.
    const text = JSON.stringify(after);
    expect(text).not.toContain('synthetic-analytics-token');
    expect(text).not.toContain('owner@example.com');
  });

  it('refreshes at most once a minute, and statuses at most every 10 minutes', async () => {
    h = await startFlows();
    await h.tick(Date.now() - 5 * 60_000);
    await h.called();
    const requests = h.analytics.requests.length;

    const first = await h.overview(true);
    expect(first.refresh.refreshed).toBe(true);
    expect(h.analytics.requests.length).toBe(requests + 1);
    // Statuses were polled 5 minutes ago: not again.
    expect(await h.called()).toEqual([]);
    expect(Date.parse(first.refresh.next_refresh_at) - Date.parse(first.refresh.last_refresh_at ?? '')).toBe(60_000);

    const second = await h.overview(true);
    expect(second.refresh.refreshed).toBe(false);
    expect(h.analytics.requests.length).toBe(requests + 1);
  });

  it('turns the banner to a warning when the cron ticks stopped, however clean the last items were', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    const now = Date.now();
    await h.tick(now - 60_000);
    expect((await h.overview()).overall).toEqual({ level: 'ok', items: [] });
    // Three hours without a tick (cron removed or every tick failing): the stored items are still clean.
    await h.tick(now - 4 * 3_600_000);
    const stale = await h.overview();
    expect(stale.digest.items).toEqual([]);
    expect(stale.overall).toEqual({ level: 'warning', items: [{ source: 'dashboard', code: 'tick_stale', severity: 'warning' }] });
  });

  it('keeps 10 minutes between status() polls across refreshes and ticks', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    const refreshed = await h.overview(true);
    expect(refreshed.refresh.refreshed).toBe(true);
    expect((await h.called()).sort()).toEqual(['mail-hero.status', 'todofy.status']);
    const polledAt = Date.parse(refreshed.apps.todofy.checked_at ?? '');
    // A tick 5 minutes after the refresh reuses those statuses (and still reports).
    await h.tick(polledAt + 5 * 60_000);
    const calls = await h.called();
    expect(calls.filter((call) => call.endsWith('.status'))).toEqual([]);
    expect(calls).toContain('todofy.reportOps');
    const overview = await h.overview();
    expect(overview.apps.todofy.checked_at).toBe(refreshed.apps.todofy.checked_at);
    // The next tick, 35 minutes after the refresh, polls again.
    await h.tick(polledAt + 35 * 60_000);
    expect((await h.called()).filter((call) => call.endsWith('.status')).sort()).toEqual(['mail-hero.status', 'todofy.status']);
  });

  it('polls stale statuses on refresh', async () => {
    h = await startFlows({ bindings: { CF_ANALYTICS_TOKEN: '' } });
    const refreshed = await h.overview(true);
    expect(refreshed.refresh.refreshed).toBe(true);
    expect(refreshed.usage.status).toBe('not_configured');
    expect(refreshed.overall.items).toContainEqual({ source: 'dashboard', code: 'usage_not_configured', severity: 'warning' });
    expect((await h.called()).sort()).toEqual(['mail-hero.status', 'todofy.status']);
    expect(h.analytics.requests).toEqual([]);
  });
});

describe('ticks and storage bounds', () => {
  it('skips a repeated cron event for the same slot', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick('2026-09-29T10:00:00Z');
    await h.called();
    await h.tick('2026-09-29T10:00:00Z');
    await h.tick('2026-09-29T10:05:00Z');
    expect(await h.called()).toEqual([]);
    expect(h.analytics.requests).toHaveLength(1);
  });

  it('keeps canary runs 60 days and shows the last 14', async () => {
    h = await startFlows();
    const day = (offset: number): string => new Date(Date.parse('2026-07-01T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 16; i++) {
      await h.tick(`${day(i)}T16:00:00Z`);
      await h.tick(`${day(i)}T16:30:00Z`);
    }
    const overview = await h.overview();
    expect(overview.canary.recent).toHaveLength(14);
    expect(overview.canary.recent[0]?.run_id).toBe(`canary-${day(15)}`);
    expect(overview.canary.recent.every((run) => run.outcome === 'ok')).toBe(true);

    // 61 days after the first run: the first one is gone, later ones stay.
    await h.tick(`${day(61)}T10:00:00Z`);
    await h.tick(`${day(61)}T10:30:00Z`);
    const later = await h.overview();
    const ids = later.canary.recent.map((run) => run.run_id);
    expect(ids).not.toContain(`canary-${day(0)}`);
    expect(ids).toContain(`canary-${day(2)}`);
  });
});
