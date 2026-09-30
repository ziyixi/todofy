/**
 * API v2 end to end in workerd (docs/design-v2.md §5): the registry from the Worker, the four views
 * from the real SQLite HomeState (ETag/304, refresh scopes and their rate limits, rows read, body
 * budgets), Worker discovery from the GraphQL answer with 0, 5 and 20 scripts, the website probe, the
 * canary on the mail flow and the v2 mutations. All data is synthetic.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BREAKDOWN_UNCLASSIFIED } from '../../src/api-types.ts';
import {
  API_V2_VERSION,
  V2_BODY_BUDGET,
  V2_ROWS_READ,
  type CloudflareResponse,
  type FlowsResponse,
  type HomeResponse,
  type OpsResponse,
  type RegistryResponse,
} from '../../src/api-v2-types.ts';
import { REGISTRY, outboundPerTick } from '../../src/registry.ts';
import { REALISTIC_USAGE, SYNTHETIC_D1, SYNTHETIC_NS, usageWithScripts } from '../graphql-fixture.ts';
import { accessClaims, testIssuer, type TestIssuer } from '../jwt.ts';
import { GRAPHQL, SYNTHETIC_BINDINGS, WEBSITE_PROBE, startFlows, status, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
let issuer: TestIssuer;
beforeAll(async () => {
  issuer = await testIssuer();
});
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const MIN = 60_000;

/** A harness on the mockup's account (REALISTIC_USAGE) whose website answers 200. */
async function mockupDay(bindings: Record<string, string> = {}): Promise<FlowHarness> {
  const harness = await startFlows({ usage: REALISTIC_USAGE, bindings: { CANARY_UTC_HOUR: '23', ...bindings } });
  harness.routes.set(WEBSITE_PROBE, () => Response.json({ build: 'synthetic' }, { headers: { 'cache-control': 'no-store' } }));
  return harness;
}

async function view<T>(harness: FlowHarness, path: string): Promise<T> {
  const answer = await harness.v2<T>(path);
  expect(answer.status).toBe(200);
  if (answer.body === null) throw new Error(`no body for ${path}`);
  return answer.body;
}

describe('Access and CSRF on /api/v2', () => {
  it('verifies Access JWTs on every v2 path and binds the v2 CSRF token to the owner and PUBLIC_HOST', async () => {
    const ISSUER = SYNTHETIC_BINDINGS.ACCESS_ISSUER ?? '';
    const AUDIENCE = SYNTHETIC_BINDINGS.ACCESS_AUDIENCE ?? '';
    h = await startFlows({ bindings: { DEV_AUTH_BYPASS: 'false', CANARY_UTC_HOUR: '23' } });
    h.routes.set(`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(issuer.jwks));
    const jwt = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
    const stranger = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'someone@example.com'));
    for (const path of ['registry', 'home', 'flows', 'cloudflare', 'ops', 'csrf']) {
      expect((await h.fetch(`/api/v2/${path}`)).status).toBe(401);
      const refused = await h.fetch(`/api/v2/${path}`, { headers: { 'cf-access-jwt-assertion': stranger } });
      expect(refused.status).toBe(401);
      await refused.arrayBuffer();
      const owner = await h.fetch(`/api/v2/${path}`, { headers: { 'cf-access-jwt-assertion': jwt } });
      expect(owner.status).toBe(200);
      await owner.arrayBuffer();
    }
    const csrf = await h.fetch('/api/v2/csrf', { headers: { 'cf-access-jwt-assertion': jwt } });
    const { token } = (await csrf.json()) as { token: string };
    const cookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const guard = (origin: string, csrfToken = token) =>
      h?.fetch('/api/v2/guard', { method: 'POST', headers: { 'cf-access-jwt-assertion': jwt, origin, 'x-csrf-token': csrfToken, cookie }, body: '{"level":"normal"}' });
    expect((await guard('https://evil.example.com'))?.status).toBe(403);
    expect((await guard('https://home.example.com', 'forged.token'))?.status).toBe(403);
    const accepted = await guard('https://home.example.com');
    expect(accepted?.status).toBe(200);
    await accepted?.arrayBuffer();
  });
});

describe('GET /api/v2/registry', () => {
  it('is served by the Worker per build, 304 on its ETag, and carries no probe URL or binding', async () => {
    h = await mockupDay();
    const first = await h.v2<RegistryResponse>('registry');
    expect(first).toMatchObject({ status: 200, etag: '"test"' });
    expect(first.bytes).toBeLessThanOrEqual(V2_BODY_BUDGET.registry);
    expect(first.body?.entries.map((e) => e.id)).toEqual(['mail-hero', 'todofy', 'lab', 'website', 'notion-publish', 'newsletter', 'home']);
    const text = JSON.stringify(first.body);
    expect(text).not.toContain('build-info');
    expect(text).not.toContain('MAIL_HERO');
    expect((await h.v2('registry', '"test"')).status).toBe(304);
    // No tick, no DO view: nothing went out.
    expect(h.outboundLog).toEqual([]);
  });
});

describe('GET /api/v2/home', () => {
  it('is honest before the first tick: unknown, never checked and 未接入', async () => {
    h = await mockupDay();
    const home = await view<HomeResponse>(h, 'home');
    expect(home).toMatchObject({ version: API_V2_VERSION, build: 'test', rev: 0, attention: { level: 'unknown', items: [], held: [] } });
    const levels = Object.fromEntries(home.entries.map((e) => [e.id, [e.level, e.reason]]));
    expect(levels).toEqual({
      'mail-hero': ['unknown', 'never_checked'],
      todofy: ['unknown', 'never_checked'],
      lab: ['unknown', 'never_checked'],
      website: ['unknown', 'never_checked'],
      'notion-publish': ['unknown', 'never_checked'],
      newsletter: ['unmonitored', null],
    });
    expect(home.cloudflare).toMatchObject({ usage_status: 'unavailable', quota: [], workers: 0, errors_today: 0 });
    expect(h.outboundLog).toEqual([]);
  });

  it('shows the mockup day after a tick, and answers 304 until something changes', async () => {
    h = await mockupDay();
    await h.tick(Date.now() - MIN);
    const first = await h.v2<HomeResponse>('home');
    const home = first.body;
    if (home === null) throw new Error('no body');
    expect(first.etag).toMatch(/^"1-[0-9a-f]{8}"$/);
    expect(first.bytes).toBeLessThanOrEqual(V2_BODY_BUDGET.home);
    expect(await h.lastRowsRead()).toBeLessThanOrEqual(V2_ROWS_READ.home);
    expect(home.attention).toEqual({ level: 'ok', items: [], info: [], held: [] });
    expect(home.badges).toEqual({ home: 0, flows: 0, cloudflare: 0, ops: 0 });
    const tiles = Object.fromEntries(home.entries.map((e) => [e.id, e]));
    expect(tiles['mail-hero']).toMatchObject({ level: 'ok', metric: { kind: 'counter', name: 'ingest_today_messages', value: 41 } });
    expect(tiles.todofy).toMatchObject({ level: 'ok', metric: { kind: 'counter', name: 'received_24h', value: 63 } });
    expect(tiles.website?.level).toBe('ok');
    expect(tiles.website?.metric?.kind).toBe('latency');
    // Notion 发布 had requests this hour (first answer of discovery).
    expect(tiles['notion-publish']).toMatchObject({ level: 'ok', metric: { kind: 'last_active' } });
    expect(home.flows.map((f) => [f.id, f.level, f.partial])).toEqual([
      ['mail-to-task', 'ok', false],
      ['gtd', 'ok', false],
      ['site-publish', 'ok', false],
      ['daily-newsletter', 'ok', true],
      ['paper-radar', 'ok', false],
      ['ops-digest', 'ok', false],
    ]);
    expect(home.cloudflare).toMatchObject({ usage_status: 'ok', workers: 5, errors_today: 3, guard_level: 'normal' });
    expect(home.cloudflare.quota.map((q) => q.id)).toEqual(['workers_requests', 'd1_rows_read', 'ai_neurons', 'r2_storage']);
    expect(home.digest.accepted).toBe(true);

    const again = await h.v2('home', first.etag);
    expect(again).toMatchObject({ status: 304, body: null });
    await h.tick(Date.now() + 29 * MIN);
    const after = await h.v2<HomeResponse>('home', first.etag);
    expect(after.status).toBe(200);
    expect(after.etag).toMatch(/^"2-/);
  });

  it('refreshes due statuses and the probe at most once a minute, statuses every 10 minutes', async () => {
    h = await mockupDay();
    const refreshed = await view<HomeResponse>(h, 'home?refresh=1');
    expect(refreshed.refresh.refreshed).toBe(true);
    expect((await h.called()).sort()).toEqual(['mail-hero.status', 'todofy.status']);
    expect(h.outboundLog).toEqual([WEBSITE_PROBE]);
    expect(h.analytics.requests).toEqual([]);
    expect(refreshed.entries.find((e) => e.id === 'website')?.level).toBe('ok');
    // Within the minute: nothing is fetched again.
    const second = await view<HomeResponse>(h, 'home?refresh=1');
    expect(second.refresh.refreshed).toBe(false);
    expect(await h.called()).toEqual([]);
    expect(h.outboundLog).toHaveLength(1);
    // The next status poll is 10 minutes after the last one.
    expect(Date.parse(second.refresh.next_refresh_at) - Date.parse(refreshed.refresh.last_refresh_at ?? '')).toBeGreaterThanOrEqual(10 * MIN - MIN);
  });

  it('shows a failing website on its tile, its flow and (as one observed item) the strip; the digest is unchanged', async () => {
    h = await mockupDay();
    h.routes.set(WEBSITE_PROBE, () => new Response('bad gateway', { status: 502 }));
    await h.tick(Date.now() - 31 * MIN);
    await h.tick(Date.now() - MIN);
    const home = await view<HomeResponse>(h, 'home');
    expect(home.entries.find((e) => e.id === 'website')).toMatchObject({ level: 'critical', reason: 'http_status', consecutive_failures: 2, metric: null });
    expect(home.flows.find((f) => f.id === 'site-publish')).toMatchObject({ level: 'critical', first_issue: { stage: 'serve', code: 'http_status' } });
    // The strip says what the tile says (F1): one observed item, not one per stage; the badge counts it.
    expect(home.attention.level).toBe('critical');
    expect(home.attention.items).toEqual([
      { source: 'website', code: 'http_status', severity: 'critical', since: null, metrics: {}, target: { view: 'home', entry: 'website' }, observed: 'critical' },
    ]);
    expect(home.badges).toEqual({ home: 1, flows: 0, cloudflare: 0, ops: 0 });
    // The digest to Todofy keeps v1's item set.
    const ops = await view<OpsResponse>(h, 'ops');
    expect(ops.digest.items).toEqual([]);
    expect(h.outboundLog.filter((url) => url === WEBSITE_PROBE)).toHaveLength(2);
  });
});

describe('GET /api/v2/cloudflare', () => {
  it.each([0, 5, 20])('lists %i discovered Workers, their resources and the 14 quota rows', async (count) => {
    h = await startFlows({ usage: usageWithScripts(count), bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick(Date.now() - MIN);
    const answer = await h.v2<CloudflareResponse>('cloudflare');
    const cf = answer.body;
    if (cf === null) throw new Error('no body');
    expect(answer.bytes).toBeLessThanOrEqual(V2_BODY_BUDGET.cloudflare);
    expect(await h.lastRowsRead()).toBeLessThanOrEqual(V2_ROWS_READ.cloudflare);
    expect(cf.usage.rows).toHaveLength(14);
    expect(cf.workers).toHaveLength(count);
    expect(cf.workers.filter((w) => w.entry === null)).toHaveLength(Math.max(0, count - 5));
    expect(cf.workers_truncated).toBe(false);
    expect(cf.resources.map((r) => r.kind)).toEqual(['d1', 'd1', 'do', 'do', 'do', 'r2', 'r2']);
    expect(cf.resources.find((r) => r.id === 'mail-hero-store')).toMatchObject({ resource: 'mail-hero-store', entry: 'mail-hero' });
    expect(Object.keys(cf.guard.apps).sort()).toEqual(['lab', 'mail-hero', 'todofy']);
    if (count >= 5) {
      expect(cf.workers.find((w) => w.script === 'todofy-core')).toMatchObject({ entry: 'todofy', requests: 96, do_requests: 632, cpu_p99_us: 6207 });
      // Errors first, then requests.
      const errors = cf.workers.map((w) => w.errors);
      expect(errors).toEqual([...errors].sort((a, b) => b - a));
    }
  });

  it('names the D1, DO and R2 contributors by the registry, known and unknown IDs alike', async () => {
    const match = (id: string): string => {
      const found = REGISTRY.resources.find((r) => r.id === id)?.match;
      if (found == null) throw new Error(id);
      return found;
    };
    const [db0, db1] = REALISTIC_USAGE.d1Databases ?? [];
    const [ns0, ns1, ns2] = REALISTIC_USAGE.doNamespaces ?? [];
    if (db0 === undefined || db1 === undefined || ns0 === undefined || ns1 === undefined || ns2 === undefined) throw new Error('fixture');
    h = await startFlows({
      usage: {
        ...REALISTIC_USAGE,
        // The registry's own identifiers for one database and two namespaces; the others stay synthetic.
        d1Databases: [{ ...db0, id: match('mail-hero-db') }, db1],
        doNamespaces: [{ ...ns0, id: match('mail-coordinator') }, { ...ns1, id: match('todofy-core-do') }, ns2],
        // One R2 operation without a bucket: marked r2 with no resource (the page reads 未归类操作).
        r2Ops: [...(REALISTIC_USAGE.r2Ops ?? []), { actionType: 'PutObject', bucketName: '', requests: 5 }],
      },
      bindings: { CANARY_UTC_HOUR: '23' },
    });
    await h.tick(Date.now() - MIN);
    const cf = await view<CloudflareResponse>(h, 'cloudflare');
    const items = (id: string) => (cf.usage.rows.find((r) => r.id === id)?.breakdown ?? []).map((item) => [item.kind, item.resource]);
    expect(items('d1_rows_read')).toEqual([
      ['d1', 'mail-hero-db'],
      ['d1', null],
    ]);
    expect(items('do_rows_written')).toEqual([
      ['do', 'mail-coordinator'],
      ['do', 'todofy-core-do'],
      ['do', null],
    ]);
    expect(items('r2_storage')).toEqual([
      ['r2', 'mail-hero-store'],
      ['r2', null],
    ]);
    expect(cf.usage.rows.find((r) => r.id === 'r2_class_a')?.breakdown.at(-1)).toEqual({ name: BREAKDOWN_UNCLASSIFIED, value: 5, kind: 'r2', resource: null });
    expect(cf.usage.rows.find((r) => r.id === 'd1_rows_read')?.breakdown[1]?.name).toBe(SYNTHETIC_D1[1]);
    expect(cf.usage.rows.find((r) => r.id === 'do_rows_written')?.breakdown[2]?.name).toBe(SYNTHETIC_NS[2]);
    // Script items keep only their name and value.
    expect(items('do_requests').every(([kind, resource]) => kind === undefined && resource === undefined)).toBe(true);
    // The same join as the resource table.
    expect(cf.resources.filter((r) => r.kind === 'do').map((r) => r.resource)).toEqual(['mail-coordinator', 'todofy-core-do', null]);
    // 首页's mini bars still carry no contributors.
    const home = await view<HomeResponse>(h, 'home');
    expect(home.cloudflare.quota.every((q) => q.breakdown.length === 0)).toBe(true);
  });

  it('remembers a Worker that had no request today, and re-queries GraphQL at most once a minute', async () => {
    h = await startFlows({ usage: REALISTIC_USAGE, bindings: { CANARY_UTC_HOUR: '23' } });
    await h.tick(Date.now() - 31 * MIN);
    // The next answer lacks notion-publish (as after 00:00 UTC for an idle cron Worker).
    h.analytics.answer = { ...REALISTIC_USAGE, scripts: (REALISTIC_USAGE.scripts ?? []).filter((s) => s.script !== 'ziyixi-notion-publish') };
    const refreshed = await view<CloudflareResponse>(h, 'cloudflare?refresh=1');
    expect(refreshed.refresh.refreshed).toBe(true);
    expect(h.analytics.requests).toHaveLength(2);
    expect(refreshed.workers.map((w) => w.script)).toContain('ziyixi-notion-publish');
    const again = await view<CloudflareResponse>(h, 'cloudflare?refresh=1');
    expect(again.refresh.refreshed).toBe(false);
    expect(h.analytics.requests).toHaveLength(2);
    // A cloudflare refresh never polls the apps.
    const calls = await h.called();
    expect(calls.filter((call) => call.endsWith('.status'))).toEqual(['mail-hero.status', 'todofy.status']);
  });
});

describe('GET /api/v2/flows and /api/v2/ops', () => {
  it('verifies delivery and the digest with the canary, and shows a hold on its stage', async () => {
    const start = Date.now() - 70 * MIN;
    h = await mockupDay({ CANARY_UTC_HOUR: String(new Date(start).getUTCHours()) });
    await h.tick(start);
    await h.tick(start + 35 * MIN);
    const answer = await h.v2<FlowsResponse>('flows');
    const flows = answer.body;
    if (flows === null) throw new Error('no body');
    expect(answer.bytes).toBeLessThanOrEqual(V2_BODY_BUDGET.flows);
    expect(await h.lastRowsRead()).toBeLessThanOrEqual(V2_ROWS_READ.flows);
    const mail = flows.flows.find((f) => f.id === 'mail-to-task');
    expect(mail?.canary).toMatchObject({ id: 'mail-todofy', today: { outcome: 'ok' } });
    expect(mail?.freshness).toMatchObject({ kind: 'canary', ok_runs: 1, runs: 1 });
    expect(mail?.stages.map((s) => [s.id, s.level, s.canary])).toEqual([
      ['forward', 'unmonitored', null],
      ['ingest', 'ok', null],
      ['parse', 'ok', null],
      ['deliver', 'ok', 'verified'],
      ['consume', 'ok', 'verified'],
      ['tasks', 'ok', null],
    ]);

    // Mail Hero's delivery force-paused: 已暂停 on 投递, a held tag, no alarm.
    await h.answer('mail-hero', 'status', { value: await status('mail-hero', { health: 'degraded', signals: [{ code: 'force_send_paused', severity: 'warning', metrics: {} }] }) });
    await h.tick(Date.now() - 2 * MIN);
    const held = await view<FlowsResponse>(h, 'flows');
    expect(held.flows[0]?.stages.find((s) => s.id === 'deliver')).toMatchObject({ level: 'held', held: true, reason: 'force_send_paused' });
    expect(held.attention.held).toEqual([{ entry: 'mail-hero', code: 'force_send_paused', target: { view: 'flows', flow: 'mail-to-task', stage: 'deliver', entry: 'mail-hero' } }]);
    expect(held.badges.flows).toBe(0);
  });

  it('marks the delivery stage failed when the canary fails there, and targets the item at it', async () => {
    const start = Date.now() - 40 * MIN;
    h = await mockupDay({ CANARY_UTC_HOUR: String(new Date(start).getUTCHours()) });
    await h.answer('mail-hero', 'canaryDelivery', { value: { state: 'failed', attempts: 3, last_http_status: 400, error_code: 'http_400' } });
    await h.tick(start);
    await h.tick(Date.now() - 5 * MIN);
    const flows = await view<FlowsResponse>(h, 'flows');
    const deliver = flows.flows[0]?.stages.find((s) => s.id === 'deliver');
    expect(deliver).toMatchObject({ level: 'critical', reason: 'canary_failed', canary: 'failed' });
    expect(flows.flows[0]?.stages.find((s) => s.id === 'consume')?.canary).toBe('unverified');
    expect(flows.attention.items).toContainEqual(expect.objectContaining({ code: 'canary_not_delivered', target: { view: 'flows', flow: 'mail-to-task', stage: 'deliver' } }));
    expect(flows.badges.flows).toBe(1);
  });

  it('serves the ops view and keeps the v1 mutation flows under v2', async () => {
    h = await mockupDay();
    await h.tick(Date.now() - MIN);
    const before = await h.v2<OpsResponse>('ops');
    const ops = before.body;
    if (ops === null) throw new Error('no body');
    expect(before.bytes).toBeLessThanOrEqual(V2_BODY_BUDGET.ops);
    expect(await h.lastRowsRead()).toBeLessThanOrEqual(V2_ROWS_READ.ops);
    expect(ops.apps.map((a) => [a.entry, a.reachable, a.status?.app])).toEqual([
      ['mail-hero', true, 'mail-hero'],
      ['todofy', true, 'todofy'],
      ['lab', true, 'lab'],
    ]);
    expect(ops.canary).toMatchObject({ id: 'mail-todofy', enabled: true, manual_limit: 3 });
    expect(ops.digest.enabled).toBe(true);
    await h.called();

    // Force shed through v2: both apps get setGuard, the view changes, the strip shows a hold.
    const shed = await h.post('/api/v2/guard', { level: 'shed' });
    expect(shed.status).toBe(200);
    expect(((await shed.json()) as { guard: { desired: { level: string } } }).guard.desired.level).toBe('shed');
    expect((await h.called()).sort()).toEqual(['mail-hero.setGuard', 'todofy.setGuard']);
    const after = await h.v2<OpsResponse>('ops', before.etag);
    expect(after.status).toBe(200);
    expect(after.body?.guard.override?.level).toBe('shed');
    expect(after.body?.attention.held).toContainEqual({ entry: 'home', code: 'owner_shed', target: { view: 'ops' } });

    const canary = await h.post('/api/v2/canary', { canary_id: 'mail-todofy' });
    expect(canary.status).toBe(202);
    expect((await h.post('/api/v2/canary', { canary_id: 'other' })).status).toBe(400);
    const active = await view<OpsResponse>(h, 'ops');
    expect(active.canary.manual_today).toBe(1);
  });
});

describe('budgets of a view', () => {
  it('reads a bounded number of rows with a full canary history and 20 Workers', async () => {
    h = await startFlows({ usage: usageWithScripts(20) });
    const day = (offset: number): string => new Date(Date.now() - (16 - offset) * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 16; i++) {
      await h.tick(`${day(i)}T16:00:00Z`);
      await h.tick(`${day(i)}T16:30:00Z`);
    }
    await h.tick(Date.now() - MIN);
    const rows: Record<string, number> = {};
    for (const name of ['home', 'flows', 'cloudflare', 'ops'] as const) {
      const answer = await h.v2(name);
      expect(answer.status).toBe(200);
      expect(answer.bytes).toBeLessThanOrEqual(V2_BODY_BUDGET[name]);
      rows[name] = await h.lastRowsRead();
    }
    expect(Object.entries(rows).map(([name, n]) => [name, Math.min(n, V2_ROWS_READ[name as keyof typeof V2_ROWS_READ])])).toEqual(Object.entries(rows));
  });
});

describe('budgets of a tick', () => {
  it(`makes at most outboundPerTick() = ${String(outboundPerTick())} outbound calls`, async () => {
    const start = Date.now() - 40 * MIN;
    h = await mockupDay({ CANARY_UTC_HOUR: String(new Date(start).getUTCHours()) });
    await h.tick(start);
    const first = [...(await h.called()), ...h.outboundLog.splice(0)];
    // 2 status + 1 probe + 1 GraphQL + startCanary + canaryDelivery + reportOps (+ canaryResult when delivered at once).
    expect(first.length).toBeLessThanOrEqual(outboundPerTick());
    expect(first).toContain(WEBSITE_PROBE);
    expect(first).toContain(GRAPHQL);
    await h.tick(Date.now() - 5 * MIN);
    const second = [...(await h.called()), ...h.outboundLog.splice(0)];
    expect(second.length).toBeLessThanOrEqual(outboundPerTick());
    expect(second.filter((call) => call === WEBSITE_PROBE)).toHaveLength(1);
  });
});
