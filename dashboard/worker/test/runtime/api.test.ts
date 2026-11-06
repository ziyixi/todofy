/**
 * The owner API end to end in workerd: Access JWTs verified against a test JWKS served through the
 * outbound handler, the ops and cloudflare views before and after the first tick, the home refresh
 * and the status poll interval, v1's retired paths, the tick deduplication, and the bounded Durable
 * Object storage (60-day canary retention, 14 recent runs).
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QUOTA_RESOURCES } from '../../src/idl.ts';
import { type HomeView, type OpsView } from '../../src/api-types.ts';
import { accessClaims, testIssuer, type TestIssuer } from '../jwt.ts';
import { d1Reads, expectValid, NOW, PATHS, startFlows, SYNTHETIC_BINDINGS, type FlowHarness } from './flows.ts';

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
    const as = async (email: string | null, path: string = PATHS.ops) =>
      h?.fetch(path, email === null ? {} : { headers: { 'cf-access-jwt-assertion': await issuer.sign(accessClaims(ISSUER, AUDIENCE, email)) } });

    expect((await as(null))?.status).toBe(401);
    expect((await as('someone@example.com'))?.status).toBe(401);
    for (const email of ['owner@example.com', 'OWNER@example.com', 'second@example.org']) {
      const response = await as(email);
      expect(response?.status).toBe(200);
      await response?.arrayBuffer();
    }
    // The harness's DEV_NOW pins only requests the loopback bypass signed in: one Access verified reads the clock.
    const verified = (await (await as('owner@example.com'))?.json()) as OpsView;
    expect(verified.generated_at).not.toBe(new Date(NOW).toISOString());
    const page = await as('owner@example.com', '/');
    expect(page?.status).toBe(200);
    expect(page?.headers.get('content-security-policy')).toContain("default-src 'self'");
    await page?.arrayBuffer();
    expect(certs).toBe(1);

    const health = await h.fetch('/health');
    expect(await health.json()).toEqual({ service: 'home', status: 'ok', build: 'test' });

    // The CSRF token is bound to the owner and the https origin of PUBLIC_HOST.
    const jwt = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
    const csrf = await h.fetch(PATHS.csrf, { headers: { 'cf-access-jwt-assertion': jwt } });
    const { token } = (await csrf.json()) as { token: string };
    expect(token).toBe('1');
    expect(csrf.headers.get('set-cookie')).toBeNull();
    const post = (origin: string, csrfToken = token) =>
      h?.fetch(PATHS.guard, {
        method: 'POST',
        headers: { 'cf-access-jwt-assertion': jwt, origin, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
        body: '{"level":"shed","app":"mail-hero"}',
      });
    expect((await post('http://127.0.0.1'))?.status).toBe(403);
    expect((await post('https://home.example.com', ''))?.status).toBe(403);
    await h.tick(NOW); // Load the service capability before a guard mutation.
    const accepted = await post('https://home.example.com');
    expect(accepted?.status).toBe(200);
    await accepted?.arrayBuffer();
  });
});

describe('the ops and cloudflare views', () => {
  it('are unknown before the first tick and complete after it', async () => {
    h = await startFlows();
    const before = await h.snapshot();
    expect(before.overall).toEqual({ level: 'unknown', items: [] });
    expect(before.apps['mail-hero']).toMatchObject({ entry: 'mail-hero', reachable: null, status: null });
    expect(before.usage).toMatchObject({ status: 'unavailable', rows: [] });
    expect(before.canary).toMatchObject({ id: 'mail-todofy', hour_utc: 16, today: null, active: null, recent: [], manual_today: 0, manual_limit: 3 });
    expect(before.refresh).toMatchObject({ last_tick_at: null, refreshed: false });

    await h.tick(NOW - 60_000);
    const after = await h.snapshot();
    expect(after.ops.name).toBe('opsView');
    expect(after.ops.generated_at).toBe(new Date(NOW).toISOString());
    expect(after.ops.build).toBe('test');
    expect(after.overall.level).toBe('ok');
    expect(after.usage.status).toBe('ok');
    expect(after.usage.rows.map((row) => row.id)).toEqual(QUOTA_RESOURCES);
    // The fake GraphQL answers `ai: []` like the live account: no AI calls today reads 0, not 无数据.
    expect(after.usage.rows.find((row) => row.id === 'ai_neurons')).toMatchObject({ used: 0, percent: 0, limit: 10_000, breakdown: [] });
    for (const row of after.usage.rows) expect(row.source).toMatch(/^https:\/\/developers\.cloudflare\.com\//);
    expectValid('OpsStatus', after.apps['mail-hero'].status);
    expectValid('OpsStatus', after.apps.todofy.status);
    expect(after.guard).toMatchObject({ thresholds: { shed_percent: 80, clear_percent: 70 }, override: null });
    expect(after.digest).toMatchObject({ enabled: true, items: [] });
    expect(after.refresh.last_tick_at).toBe(new Date(NOW - 60_000).toISOString());
    for (const item of after.digest.items) expectValid('OpsReportItem', item);
    // No token, owner or remote text anywhere in the answers.
    const text = JSON.stringify(after);
    expect(text).not.toContain('synthetic-analytics-token');
    expect(text).not.toContain('owner@example.com');
  });

  it('turns the strip to a warning when the cron ticks stopped, however clean the last items were', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick(NOW - 60_000);
    expect((await h.snapshot()).overall).toEqual({ level: 'ok', items: [] });
    // Three hours without a tick (cron removed or every tick failing): the stored items are still clean.
    await h.tick(NOW - 4 * 3_600_000);
    const stale = await h.snapshot();
    expect(stale.digest.items).toEqual([]);
    expect(stale.overall).toEqual({ level: 'warning', items: [{ source: 'dashboard', code: 'tick_stale', severity: 'warning' }] });
  });

  it('keeps 10 minutes between status() polls across home refreshes and ticks', async () => {
    h = await startFlows({ bindings: { CANARY_UTC_HOUR: '23' } });
    const refreshed = await h.refresh<HomeView>('home');
    expect(refreshed.body?.refresh.refreshed).toBe(true);
    expect((await h.called()).sort()).toEqual(['mail-hero.status', 'todofy.status']);
    const polledAt = Date.parse((await h.snapshot()).apps.todofy.checked_at ?? '');
    // A tick 5 minutes after the refresh reuses those statuses.
    await h.tick(polledAt + 5 * 60_000);
    const calls = await h.called();
    expect(calls.filter((call) => call.endsWith('.status'))).toEqual([]);
    expect(Date.parse((await h.snapshot()).apps.todofy.checked_at ?? '')).toBe(polledAt);
    // The next tick, 35 minutes after the refresh, polls again.
    await h.tick(polledAt + 35 * 60_000);
    expect((await h.called()).filter((call) => call.endsWith('.status')).sort()).toEqual(['mail-hero.status', 'todofy.status']);
  });

  it('polls stale statuses on a home refresh and says when analytics is not configured', async () => {
    h = await startFlows({ bindings: { CF_ANALYTICS_TOKEN: '' } });
    const refreshed = await h.refresh<HomeView>('home');
    expect(refreshed.body?.refresh.refreshed).toBe(true);
    expect((await h.called()).sort()).toEqual(['mail-hero.status', 'todofy.status']);
    const cloudflare = await h.refresh('cloudflare');
    expect(cloudflare.status).toBe(200);
    const snap = await h.snapshot();
    expect(snap.usage.status).toBe('not_configured');
    expect(snap.overall.items).toContainEqual({ source: 'dashboard', code: 'usage_not_configured', severity: 'warning' });
    expect(h.analytics.requests).toEqual([]);
  });

  it('answers 410 with the reload message (code not_found, which the old UI shows) on the retired /api/v2 paths and NOT_FOUND on the retired v1 ones', async () => {
    h = await startFlows();
    for (const path of ['/api/v2/home', '/api/v2/ops', '/api/v2/registry', '/api/v2/csrf']) {
      const response = await h.fetch(path);
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found', message: '个人控制台已更新，请刷新页面' } });
    }
    for (const path of ['/api/v2/guard', '/api/v2/canary']) {
      const response = await h.post(path, {});
      expect(response.status).toBe(410);
      await response.arrayBuffer();
    }
    for (const path of ['/api/v1/overview', '/api/v1/guard', '/api/v1/canary']) {
      const response = await h.fetch(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 404, status: 'NOT_FOUND' } });
    }
    expect(await h.called()).toEqual([]);
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
    const snap = await h.snapshot();
    expect(snap.canary.recent).toHaveLength(14);
    expect(snap.canary.recent[0]?.run_id).toBe(`canary-${day(15)}`);
    expect(snap.canary.recent.every((run) => run.outcome === 'ok')).toBe(true);

    // 61 days after the first run: the first one is gone, later ones stay.
    await h.tick(`${day(61)}T10:00:00Z`);
    await h.tick(`${day(61)}T10:30:00Z`);
    const later = await h.snapshot();
    const ids = later.canary.recent.map((run) => run.run_id);
    expect(ids).not.toContain(`canary-${day(0)}`);
    expect(ids).toContain(`canary-${day(2)}`);
  });
});

it('migrates a persisted legacy guard store and preserves per-app changes across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'home-guard-migration-'));
  const options = { persist: dir, bindings: { CANARY_UTC_HOUR: '23' }, usage: d1Reads(90) };
  const seededAt = NOW - 20 * 60_000;
  const legacy = { level: 'shed', until: NOW + 23 * 3_600_000, set_at: NOW - 3_600_000 };
  const projected = { level: legacy.level, until: new Date(legacy.until).toISOString(), set_at: new Date(legacy.set_at).toISOString() };
  const guardSchema = (db: DatabaseSync) =>
    (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'guard_applied'").get() as { sql: string } | undefined)?.sql;
  try {
    h = await startFlows(options);
    await h.tick(seededAt);
    await h.dispose();
    h = undefined;

    // Recreate the schema and the global owner override from before Watch joined the guard.
    let homeFile: string | undefined;
    for (const file of (await readdir(dir, { recursive: true })).filter((name) => name.endsWith('.sqlite'))) {
      const db = new DatabaseSync(join(dir, file));
      try {
        if (guardSchema(db) === undefined) continue;
        expect(homeFile).toBeUndefined();
        homeFile = join(dir, file);
        db.exec(`CREATE TABLE guard_applied_old (
          app TEXT PRIMARY KEY CHECK (app IN ('mail-hero', 'todofy', 'former-app')),
          input TEXT, state TEXT, last_call_at INTEGER, last_error TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0);
          INSERT INTO guard_applied_old SELECT * FROM guard_applied WHERE app IN ('mail-hero', 'todofy');
          INSERT INTO guard_applied_old (app) VALUES ('former-app');
          INSERT INTO state (key, doc, updated_at) VALUES ('status:former-app', '{}', 0), ('guard_override:former-app', '{}', 0);
          DROP TABLE guard_applied;
          ALTER TABLE guard_applied_old RENAME TO guard_applied;`);
        db.prepare('INSERT INTO state (key, doc, updated_at) VALUES (?, ?, ?)').run('guard_override', JSON.stringify(legacy), legacy.set_at);
      } finally {
        db.close();
      }
    }
    if (homeFile === undefined) throw new Error('Home SQLite database was not found');

    h = await startFlows(options);
    const migrated = await h.snapshot();
    expect(migrated.guard.override).toBeNull();
    expect(migrated.apps['mail-hero'].status?.app).toBe('mail-hero');
    expect(migrated.guard.apps['mail-hero']?.last_call_at).toBe(new Date(seededAt).toISOString());
    for (const app of ['mail-hero', 'todofy', 'watch'] as const) expect(migrated.guard.apps[app]?.override).toEqual(projected);

    await h.tick(NOW);
    expect(await h.callsOf('watch', 'setGuard')).toEqual([[{ level: 'shed', reason: 'owner_shed', until: projected.until }]]);
    const response = await h.post(PATHS.guard, { app: 'mail-hero', level: 'normal' });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const restartedBuild = 'b'.repeat(40);
    await h.redeploy({ BUILD_SHA: restartedBuild });
    const restarted = await h.snapshot();
    expect(restarted.ops.build).toBe(restartedBuild);
    expect(restarted.guard.apps['mail-hero']?.override?.level).toBe('normal');
    expect(restarted.guard.apps.todofy?.override).toEqual(projected);
    expect(restarted.guard.apps.watch?.override).toEqual(projected);
    await h.dispose();
    h = undefined;

    const db = new DatabaseSync(homeFile);
    try {
      expect(guardSchema(db)).not.toContain('CHECK');
      expect(db.prepare('SELECT app FROM guard_applied ORDER BY app').all()).toEqual([
        { app: 'mail-hero' }, { app: 'todofy' }, { app: 'watch' },
      ]);
      expect(db.prepare("SELECT key FROM state WHERE key = 'guard_override' OR key GLOB '*former-app'").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    await h?.dispose();
    h = undefined;
    await rm(dir, { recursive: true, force: true });
  }
});
