import { describe, expect, it } from 'vitest';
import { DRIFT_CALLS_PER_TICK, DRIFT_CATEGORIES, DRIFT_MAX_ATTEMPTS, DRIFT_UTC_HOUR, DRIFT_VIEW_FINDINGS_MAX } from '../src/api-v2-types.ts';
import {
  CF_API_BASE,
  DESIRED,
  DRIFT_RUN_MAX_BYTES,
  NO_DRIFT,
  SCRIPT_STEP_CALLS,
  accountStepCalls,
  advanceRun,
  attemptsExhausted,
  cfGet,
  compareDrift,
  completedDoc,
  countFindings,
  driftPlan,
  driftView,
  failedDoc,
  fetchAccount,
  fetchScript,
  newDriftRun,
  parseSettings,
  runComplete,
  runTooLarge,
  type DesiredState,
  type DriftRunDoc,
  type FetchLike,
  type LiveAccount,
  type LiveScript,
} from '../src/drift.ts';
import { CF_API, SENTINEL_VALUE, SYNTHETIC_ACCOUNT, fakeCloudflare, type LiveTweaks } from './drift-fixture.ts';

const TOKEN = 'synthetic-analytics-token-000000000000';
const DAY = '2026-09-30';
const AT = (hhmm: string): number => Date.parse(`${DAY}T${hhmm}:00Z`);

/** A small desired state with every category in use (synthetic names). */
const SMALL: DesiredState = {
  version: 1,
  zones: ['example.com'],
  workers: {
    alpha: {
      config: 'alpha/wrangler.toml',
      workers_dev: false,
      preview_urls: false,
      custom_domains: ['alpha.example.com'],
      routes: [],
      crons: ['*/30 * * * *'],
      bindings: [
        { name: 'DB', type: 'd1', source: 'config' },
        { name: 'OWNER', type: 'plain_text', source: 'deploy' },
        { name: 'OPTIONAL_ID', type: 'plain_text', source: 'deploy', optional: true },
        { name: 'KEY', type: 'secret_text', source: 'manual' },
      ],
      personal: ['OPTIONAL_ID', 'OWNER'],
    },
    beta: {
      config: 'beta/wrangler.toml',
      workers_dev: true,
      preview_urls: false,
      custom_domains: [],
      routes: [],
      crons: [],
      bindings: [],
      personal: [],
    },
  },
};

/** A fetcher on the fake API that records each call. */
function api(tweaks: LiveTweaks = {}, desired: DesiredState = DESIRED): { fetcher: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(fakeCloudflare(url, tweaks, desired) ?? new Response('not found', { status: 404 }));
  };
  return { fetcher, calls };
}

/** Runs a whole check against the fake API, tick by tick; returns the documents and the calls per tick. */
async function fullCheck(tweaks: LiveTweaks = {}, desired: DesiredState = DESIRED) {
  const { fetcher, calls } = api(tweaks, desired);
  let run: DriftRunDoc = newDriftRun(AT('02:00'));
  const perTick: number[] = [];
  for (let tick = 0; tick < 5 && !runComplete(run); tick++) {
    const before = calls.length;
    const result = await advanceRun(run, TOKEN, SYNTHETIC_ACCOUNT, fetcher, desired);
    expect(result.error).toBeNull();
    perTick.push(calls.length - before);
    expect(result.calls).toBe(calls.length - before);
    run = result.run;
  }
  expect(runComplete(run)).toBe(true);
  const doc = completedDoc(NO_DRIFT, run, AT('02:30'), desired);
  return { doc, run, perTick, calls };
}

const LIVE_OK: LiveAccount = { scripts: ['alpha', 'beta'], domains: [{ hostname: 'alpha.example.com', service: 'alpha' }], routes: [], zones_unchecked: 0, truncated: false };
const SCRIPT_OK: Record<string, LiveScript> = {
  alpha: {
    crons: ['*/30 * * * *'],
    bindings: [
      { name: 'DB', type: 'd1' },
      { name: 'KEY', type: 'secret_text' },
      { name: 'OWNER', type: 'secret_text' },
    ],
    workers_dev: false,
    preview_urls: false,
  },
  beta: { crons: [], bindings: [], workers_dev: true, preview_urls: false },
};

describe('the bundled desired state', () => {
  it('names every production Worker, and the fake API built from it shows no drift', async () => {
    expect(Object.keys(DESIRED.workers).sort()).toEqual(['home', 'lab', 'mail-hero', 'todofy', 'todofy-core', 'ziyixi-notion-publish', 'ziyixi-website']);
    expect(DESIRED.workers.home?.crons).toEqual(['*/30 * * * *']);
    const { doc } = await fullCheck();
    expect(doc.findings).toEqual([]);
    expect(driftView(doc, true, AT('03:00')).status).toBe('ok');
  });

  it('holds names only: no address, id or value', () => {
    const text = JSON.stringify(DESIRED);
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe('comparison', () => {
  it('finds nothing when the live state matches', () => {
    expect(compareDrift(SMALL, LIVE_OK, SCRIPT_OK)).toEqual([]);
  });

  it('reports each category by name only, and an optional value may be absent', () => {
    const findings = compareDrift(
      SMALL,
      {
        scripts: ['alpha', 'gamma'],
        domains: [{ hostname: 'other.example.com', service: 'alpha' }, { hostname: 'gamma.example.com', service: 'gamma' }],
        routes: [{ pattern: 'example.com/*', script: '(none)' }],
        zones_unchecked: 0,
        truncated: false,
      },
      {
        alpha: {
          crons: ['0 * * * *'],
          bindings: [
            { name: 'DB', type: 'r2_bucket' },
            { name: 'OWNER', type: 'plain_text' },
            { name: 'STRAY', type: 'kv_namespace' },
          ],
          workers_dev: true,
          preview_urls: false,
        },
      },
    );
    expect(findings).toEqual([
      { category: 'scripts', script: 'beta', name: 'beta', kind: 'missing' },
      { category: 'scripts', script: 'gamma', name: 'gamma', kind: 'extra' },
      { category: 'custom_domains', script: 'alpha', name: 'alpha.example.com', kind: 'missing' },
      { category: 'custom_domains', script: 'alpha', name: 'other.example.com', kind: 'extra' },
      { category: 'custom_domains', script: 'gamma', name: 'gamma.example.com', kind: 'extra' },
      { category: 'routes', script: '(none)', name: 'example.com/*', kind: 'extra' },
      { category: 'crons', script: 'alpha', name: '*/30 * * * *', kind: 'missing' },
      { category: 'crons', script: 'alpha', name: '0 * * * *', kind: 'extra' },
      { category: 'bindings', script: 'alpha', name: 'DB', kind: 'changed', expected: 'd1', actual: 'r2_bucket' },
      { category: 'bindings', script: 'alpha', name: 'KEY', kind: 'missing', expected: 'secret_text' },
      { category: 'bindings', script: 'alpha', name: 'STRAY', kind: 'extra', actual: 'kv_namespace' },
      { category: 'workers_dev', script: 'alpha', name: 'workers_dev', kind: 'changed', expected: 'false', actual: 'true' },
      { category: 'personal', script: 'alpha', name: 'OWNER', kind: 'changed', expected: 'secret_text', actual: 'plain_text' },
    ]);
    expect(countFindings(findings)).toEqual({ scripts: 2, custom_domains: 3, routes: 1, crons: 2, bindings: 3, workers_dev: 1, personal: 1 });
  });

  it('wants every personal value as a deploy secret, so a live plain_text one is a bindings change', async () => {
    // Every wrapper writes its personal values with --secrets-file (Mail Hero's receive address, the owner addresses,
    // Todofy's Todoist projects), so no Worker lists a `personal` --var.
    expect(Object.values(DESIRED.workers).flatMap((worker) => worker.personal)).toEqual([]);
    const core = new Map((DESIRED.workers['todofy-core']?.bindings ?? []).map((b) => [b.name, b]));
    for (const name of ['TODOIST_DEFAULT_PROJECT_ID', 'TODOIST_OPS_PROJECT_ID', 'TODOIST_REVIEW_PROJECT_ID']) {
      expect(core.get(name)).toEqual({ name, type: 'secret_text', source: 'deploy' });
    }
    // The live state before the first deploy that moves them: the project a plain var, an optional one not set.
    const { doc } = await fullCheck({ bindings: { 'todofy-core': { TODOIST_DEFAULT_PROJECT_ID: 'plain_text', TODOIST_OPS_PROJECT_ID: null } } });
    expect(doc.findings).toEqual([
      { category: 'bindings', script: 'todofy-core', name: 'TODOIST_DEFAULT_PROJECT_ID', kind: 'changed', expected: 'secret_text', actual: 'plain_text' },
      { category: 'bindings', script: 'todofy-core', name: 'TODOIST_OPS_PROJECT_ID', kind: 'missing', expected: 'secret_text' },
    ]);
    expect(driftView(doc, true, AT('03:00'))).toMatchObject({ status: 'drift', counts: { bindings: 2, personal: 0 } });
  });

  it('detects a toml change: a Custom Domain removed from the committed state is reported as extra', async () => {
    const changed: DesiredState = { ...DESIRED, workers: { ...DESIRED.workers, home: { ...(DESIRED.workers.home as NonNullable<typeof DESIRED.workers.home>), custom_domains: [] } } };
    const live = await fullCheck({}, DESIRED);
    const compared = compareDrift(changed, live.run.account as LiveAccount, live.run.scripts);
    expect(compared).toEqual([{ category: 'custom_domains', script: 'home', name: 'home.ziyixi.science', kind: 'extra' }]);
  });
});

describe('reading the API', () => {
  it('makes only GETs to fixed paths, with the token only in the authorization header', async () => {
    const { calls } = await fullCheck();
    expect(calls.length).toBe(accountStepCalls() + 3 * Object.keys(DESIRED.workers).length);
    for (const call of calls) {
      expect(call.url.startsWith(`${CF_API_BASE}/`)).toBe(true);
      expect(call.init.method).toBe('GET');
      expect(call.init.body).toBeUndefined();
      expect(call.init.redirect).toBe('manual');
      const headers = new Headers(call.init.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(call.url).not.toContain(TOKEN);
      expect([...headers].filter(([name]) => name !== 'authorization').some(([, value]) => value.includes(TOKEN))).toBe(false);
    }
    const paths = new Set(calls.map((c) => c.url.slice(CF_API.length).replace(/\/scripts\/[a-z0-9_-]+\//, '/scripts/<s>/')));
    expect([...paths].sort()).toEqual([
      `/accounts/${SYNTHETIC_ACCOUNT}/workers/domains`,
      `/accounts/${SYNTHETIC_ACCOUNT}/workers/scripts`,
      `/accounts/${SYNTHETIC_ACCOUNT}/workers/scripts/<s>/schedules`,
      `/accounts/${SYNTHETIC_ACCOUNT}/workers/scripts/<s>/settings`,
      `/accounts/${SYNTHETIC_ACCOUNT}/workers/scripts/<s>/subdomain`,
      `/zones/${'f'.repeat(32)}/workers/routes`,
    ]);
  });

  it('keeps binding names and types only, never a value', async () => {
    expect(parseSettings({ bindings: [{ name: 'X', type: 'plain_text', text: SENTINEL_VALUE }, { name: 'J', type: 'json', json: { v: SENTINEL_VALUE } }] })).toEqual([
      { name: 'J', type: 'json' },
      { name: 'X', type: 'plain_text' },
    ]);
    const { doc, run } = await fullCheck({ bindings: { 'todofy-core': { TODOIST_DEFAULT_PROJECT_ID: 'plain_text' } } });
    expect(JSON.stringify(run)).not.toContain(SENTINEL_VALUE);
    expect(JSON.stringify(doc)).not.toContain(SENTINEL_VALUE);
    expect(JSON.stringify(driftView(doc, true, AT('03:00')))).not.toContain(SENTINEL_VALUE);
    expect(JSON.stringify(run)).not.toMatch(/[0-9a-f]{32}/);
  });

  it('turns failures into codes, never remote text', async () => {
    const answer = (response: Response | Error): FetchLike => () => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response));
    expect(await cfGet(TOKEN, '/x', answer(new Response('denied: secret detail', { status: 403 })))).toEqual({ ok: false, code: 'http_403', http_status: 403 });
    expect(await cfGet(TOKEN, '/x', answer(Response.json({ success: false, errors: [{ message: 'detail' }] })))).toEqual({ ok: false, code: 'api_error', http_status: 200 });
    expect(await cfGet(TOKEN, '/x', answer(new Response('not json')))).toEqual({ ok: false, code: 'invalid_response', http_status: 200 });
    expect(await cfGet(TOKEN, '/x', answer(new Response('{}', { headers: { 'content-length': '2000000' } })))).toEqual({ ok: false, code: 'invalid_response', http_status: 200 });
    expect(await cfGet(TOKEN, '/x', answer(new TypeError('network')))).toEqual({ ok: false, code: 'network_error', http_status: null });
    expect(await cfGet(TOKEN, '/x', answer(new DOMException('timed out', 'TimeoutError')))).toEqual({ ok: false, code: 'timeout', http_status: null });
    const denied = api({ fail: { path: /\/settings$/, status: 403 } });
    expect(await fetchScript(TOKEN, SYNTHETIC_ACCOUNT, 'home', denied.fetcher)).toEqual({ ok: false, code: 'http_403', step: 'script', http_status: 403 });
    const noDomains = api({ fail: { path: /\/domains$/, status: 403 } });
    expect(await fetchAccount(TOKEN, SYNTHETIC_ACCOUNT, noDomains.fetcher)).toEqual({ ok: false, code: 'http_403', step: 'account', http_status: 403 });
    expect(await fetchAccount(TOKEN, 'not-an-account', noDomains.fetcher)).toMatchObject({ ok: false, code: 'bad_account' });
  });

  it('cannot check the routes of a zone no Custom Domain names, and says so', async () => {
    const { doc } = await fullCheck({ dropDomains: Object.values(DESIRED.workers).flatMap((w) => [...w.custom_domains]) });
    expect(doc.zones_unchecked).toBe(1);
    expect(doc.counts.custom_domains).toBe(Object.values(DESIRED.workers).flatMap((w) => w.custom_domains).length);
  });
});

describe('a run across ticks', () => {
  it(`never makes more than DRIFT_CALLS_PER_TICK = ${String(DRIFT_CALLS_PER_TICK)} calls in one tick`, async () => {
    const { perTick } = await fullCheck();
    expect(perTick).toEqual([12, 12]);
    expect(Math.max(...perTick)).toBeLessThanOrEqual(DRIFT_CALLS_PER_TICK);
    // The account step always leaves room for at least one Worker, so every tick makes progress.
    expect(accountStepCalls() + SCRIPT_STEP_CALLS).toBeLessThanOrEqual(DRIFT_CALLS_PER_TICK);
  });

  it('retries a failed step on the next tick, keeps what it read, and gives up after DRIFT_MAX_ATTEMPTS', async () => {
    const flaky = api({ fail: { path: /\/home\/settings$/, status: 500 } });
    let run = newDriftRun(AT('02:00'));
    const first = await advanceRun(run, TOKEN, SYNTHETIC_ACCOUNT, flaky.fetcher);
    expect(first.error).toMatchObject({ code: 'http_500', step: 'script' });
    expect(first.run.account).not.toBeNull();
    // home failed; the other two Workers of the batch are kept.
    expect(Object.keys(first.run.scripts).sort()).toEqual(['lab', 'mail-hero']);
    run = first.run;
    for (let attempt = 2; attempt <= DRIFT_MAX_ATTEMPTS; attempt++) {
      const next = await advanceRun(run, TOKEN, SYNTHETIC_ACCOUNT, flaky.fetcher);
      expect(next.calls).toBeLessThanOrEqual(DRIFT_CALLS_PER_TICK);
      run = next.run;
    }
    expect(attemptsExhausted(run)).toBe(true);
    const doc = failedDoc(NO_DRIFT, run, { code: 'http_500', step: 'script' }, AT('03:00'), true);
    expect(doc).toMatchObject({ checked_at: null, last_run_day: DAY, running_day: null, consecutive_failed_days: 1, last_error: 'http_500' });
    expect(driftView(doc, true, AT('03:30')).status).toBe('failing');
  });

  it('plans one check per UTC day from DRIFT_UTC_HOUR, and records an unfinished earlier run as a failed day', () => {
    const hour = String(DRIFT_UTC_HOUR).padStart(2, '0');
    expect(driftPlan(AT('01:30'), null, NO_DRIFT, true)).toEqual({ kind: 'idle' });
    expect(driftPlan(AT(`${hour}:00`), null, NO_DRIFT, true)).toEqual({ kind: 'start' });
    expect(driftPlan(AT('12:00'), null, { ...NO_DRIFT, last_run_day: DAY }, true)).toEqual({ kind: 'idle' });
    expect(driftPlan(AT('12:00'), null, NO_DRIFT, false)).toEqual({ kind: 'idle' });
    const running = newDriftRun(AT(`${hour}:00`));
    expect(driftPlan(AT(`${hour}:30`), running, NO_DRIFT, true)).toEqual({ kind: 'continue', run: running });
    expect(driftPlan(AT(`${hour}:00`) + 86_400_000, running, NO_DRIFT, true)).toEqual({ kind: 'abandon', run: running });
  });
});

describe('storage bound', () => {
  it('keeps a run of this account far under the state row limit, and flags one that would not fit', async () => {
    const { run } = await fullCheck();
    expect(new TextEncoder().encode(JSON.stringify(run)).byteLength).toBeLessThan(DRIFT_RUN_MAX_BYTES / 4);
    expect(runTooLarge(run)).toBe(false);
    const huge = Array.from({ length: 100 }, (_, i) => ({ name: `A_VERY_LONG_SYNTHETIC_BINDING_NAME_NUMBER_${String(i).padStart(4, '0')}_XXXXXXXXXXXXXXX`, type: 'durable_object_namespace' }));
    const scripts = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`w${String(i)}`, { crons: [], bindings: huge, workers_dev: false, preview_urls: false }]));
    expect(runTooLarge({ ...run, scripts })).toBe(true);
  });
});

describe('the view', () => {
  it('says not_configured without the token, never_checked before the first check, and lists at most DRIFT_VIEW_FINDINGS_MAX', () => {
    expect(driftView(NO_DRIFT, false, AT('03:00')).status).toBe('not_configured');
    expect(driftView(NO_DRIFT, true, AT('03:00'))).toMatchObject({ status: 'never_checked', in_progress: false, desired_workers: 7 });
    expect(driftView({ ...NO_DRIFT, running_day: DAY }, true, AT('03:00')).in_progress).toBe(true);
    const many = Array.from({ length: 40 }, (_, i) => ({ category: 'bindings' as const, script: 'alpha', name: `B_${String(i)}`, kind: 'extra' as const, actual: 'plain_text' }));
    const view = driftView({ ...NO_DRIFT, checked_at: AT('02:30'), counts: countFindings(many), findings: many }, true, AT('03:00'));
    expect(view.findings).toHaveLength(DRIFT_VIEW_FINDINGS_MAX);
    expect(view.findings_omitted).toBe(40 - DRIFT_VIEW_FINDINGS_MAX);
    expect(Object.keys(view.counts)).toEqual([...DRIFT_CATEGORIES]);
  });
});
