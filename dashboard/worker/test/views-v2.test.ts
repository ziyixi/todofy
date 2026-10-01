import { describe, expect, it } from 'vitest';
import designV2 from '../../docs/design-v2.md?raw';
import apiV2Source from '../src/api-v2-types.ts?raw';
import type { OpsReportItem, OpsSignal } from '../../../contracts/ops-v1/ops-v1.ts';
import { CANARY_MANUAL_PER_DAY, type CanaryView, type DigestView, type GuardView } from '../src/api-types.ts';
import { CF_SCRIPTS_MAX, CF_VIEW_WORKERS_MAX, DRIFT_VIEW_FINDINGS_MAX, HOME_QUOTA_IDS, V2_BODY_BUDGET, V2_BODY_MAX, V2_ROWS_READ, type ShellFields } from '../src/api-v2-types.ts';
import { runView } from '../src/canary.ts';
import { NO_DRIFT, countFindings, driftView } from '../src/drift.ts';
import { attentionView, type EvalInput } from '../src/evaluate.ts';
import { etagMatches } from '../src/v2-views.ts';
import { capWorkers, cloudflareResponse, flowsResponse, fnv1a, homeResponse, nextTickAt, opsResponse, serializeView, shell } from '../src/views-v2.ts';
import type { CfScriptsDoc, ScriptRecord } from '../src/discovery.ts';
import { REALISTIC_USAGE, usageWithScripts } from './graphql-fixture.ts';
import { DAY, LINK_ONLY_ENTRY, MIN, NOW, fortnight, input, run, scripts, signal, status, usageDoc, usageView, withLinkOnly } from './v2-fixtures.ts';

const DESIRED = { level: 'normal', reason: 'quota_normal', until: null, source: 'auto' } as const;

function base(patch: Partial<Parameters<typeof shell>[0]> = {}, attentionItems: readonly OpsReportItem[] = []): ShellFields {
  const { attention, badges } = attentionView({ now: NOW, neverRan: false, items: attentionItems, canaryEnabled: true, desired: DESIRED, statuses: input().statuses });
  return shell({ now: NOW, rev: 42, build: 'abc123', attention, badges, lastTickAt: NOW, lastRefreshAt: null, nextRefreshAt: NOW, refreshed: false, ...patch });
}

function canaryView(ev: EvalInput): CanaryView {
  return {
    enabled: true,
    hour_utc: 16,
    next_scheduled_at: new Date(NOW + 90 * MIN).toISOString(),
    today: ev.canaryRecent[0] === undefined ? null : runView(ev.canaryRecent[0]),
    active: null,
    recent: ev.canaryRecent.map(runView),
    manual_today: 0,
    manual_limit: CANARY_MANUAL_PER_DAY,
  };
}

const GUARD: GuardView = {
  desired: { level: 'normal', reason: 'quota_normal', until: null, source: 'auto' },
  override: null,
  thresholds: { shed_percent: 80, clear_percent: 70 },
  apps: {
    'mail-hero': { state: { level: 'normal', reason: null, until: null, set_at: null, deferred: [] }, last_call_at: null, last_error: null },
    todofy: { state: { level: 'normal', reason: null, until: null, set_at: null, deferred: [] }, last_call_at: null, last_error: null },
    lab: { state: { level: 'normal', reason: null, until: null, set_at: null, deferred: [] }, last_call_at: null, last_error: null },
  },
};

function digestView(items: readonly OpsReportItem[]): DigestView {
  return { items, enabled: true, last_sent_at: '2026-09-29T07:00:00.000Z', last_generated_at: '2026-09-29T07:00:00.000Z', last_receipt: { stored: true, generated_at: '2026-09-29T07:00:00.000Z', item_count: items.length }, last_error: null, next_due_at: '2026-09-29T13:00:00.000Z' };
}

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** A completed check without findings (a normal day). */
const DRIFT_OK = driftView({ ...NO_DRIFT, checked_at: NOW - 8 * 60 * MIN, desired_workers: 7, last_run_day: '2026-09-29' }, true, NOW);
/** A check at its finding bound with long synthetic names, and a failed attempt (a heavy day). */
const HEAVY_FINDINGS = Array.from({ length: 50 }, (_, i) => ({
  category: 'bindings' as const,
  script: `a-long-synthetic-worker-name-${String(i % 7)}`,
  name: `A_LONG_SYNTHETIC_BINDING_NAME_${String(i).padStart(3, '0')}`,
  kind: 'changed' as const,
  expected: 'secret_text',
  actual: 'plain_text',
}));
const DRIFT_HEAVY = driftView(
  {
    ...NO_DRIFT,
    checked_at: NOW - 30 * MIN,
    desired_workers: 7,
    counts: { ...countFindings(HEAVY_FINDINGS), scripts: 3, custom_domains: 9 },
    findings: HEAVY_FINDINGS,
    last_run_day: '2026-09-28',
    running_day: '2026-09-29',
    last_error: 'http_403',
    last_error_step: 'script',
    last_error_at: NOW - 30 * MIN,
    consecutive_failed_days: 2,
  },
  true,
  NOW,
);

// ---- a heavy day: everything the bounds allow that a real day could plausibly show ----------------

/** 20 digest items (the report maximum) with 3 metrics each. */
const HEAVY_ITEMS: OpsReportItem[] = Array.from({ length: 20 }, (_, i) => ({
  source: i % 2 === 0 ? 'mail-hero' : 'todofy',
  code: `synthetic_condition_${String(i).padStart(2, '0')}`,
  severity: i < 5 ? 'critical' : 'warning',
  since: '2026-09-29T11:20:00.000Z',
  metrics: { count: 12345, percent: 87.5, age_seconds: 86400 },
}));

/** 16 signals (the ops-v1 maximum) with 3 metrics each, on a degraded app. */
const HEAVY_SIGNALS: OpsSignal[] = Array.from({ length: 16 }, (_, i) =>
  signal(i < 4 ? ['delivery_failed', 'parse_failed', 'capacity_85', 'pending_stale'][i] ?? 'x' : `future_signal_${String(i)}`, i < 8 ? 'critical' : 'warning', { count: 3, percent: 91.2, age_seconds: 7200 }, '2026-09-29T11:20:00Z'),
);

function heavyInput(): EvalInput {
  const failing = Array.from({ length: 14 }, (_, i) => run(new Date(NOW - (i + 1) * DAY).toISOString().slice(0, 10), 'failed', 'delivery', 'retry_window_expired'));
  return input({
    statuses: {
      'mail-hero': status('mail-hero', { health: 'degraded', signals: HEAVY_SIGNALS }),
      todofy: status('todofy', { health: 'degraded', signals: HEAVY_SIGNALS.map((s, i) => ({ ...s, code: i < 3 ? (['gemini_budget_95', 'attention', 'due_backlog'][i] ?? 'x') : s.code })) }),
    },
    scripts: scripts(usageWithScripts(20)),
    canaryRecent: failing,
  });
}

describe('serialization and the ETag', () => {
  it('keeps the ETag while only generated_at changes, and answers a match with no body', () => {
    const a = serializeView(base({ now: NOW }), null);
    const b = serializeView({ ...base({ now: NOW }), generated_at: new Date(NOW + 20_000).toISOString() }, null);
    expect(a.etag).toMatch(/^"42-[0-9a-f]{8}"$/);
    expect(b.etag).toBe(a.etag);
    expect(b.body).not.toBe(a.body);
    expect(serializeView(base(), a.etag)).toEqual({ etag: a.etag, body: null, bytes: 0 });
    expect(etagMatches(`W/${a.etag}, "other"`, a.etag)).toBe(true);
    // Anything else in the body changes it, the level of a stale check included.
    expect(serializeView(base({ rev: 43 }), a.etag).body).not.toBeNull();
    expect(serializeView(base({}, [{ source: 'todofy', code: 'attention', severity: 'warning', since: '2026-09-29T11:20:00.000Z', metrics: {} }]), a.etag).body).not.toBeNull();
    expect(fnv1a('')).toBe('811c9dc5');
  });

  it('rounds the time-derived refresh fields to the minute', () => {
    const shellAt = (now: number) => base({ now, nextRefreshAt: now - 5 * MIN });
    expect(shellAt(NOW + 10_000).refresh).toEqual({
      last_tick_at: new Date(NOW).toISOString(),
      next_tick_at: '2026-09-29T15:00:00.000Z',
      last_refresh_at: null,
      next_refresh_at: new Date(NOW).toISOString(),
      refreshed: false,
    });
    expect(serializeView(shellAt(NOW + 10_000), null).etag).toBe(serializeView(shellAt(NOW + 50_000), null).etag);
    expect(nextTickAt(Date.parse('2026-09-29T14:59:59Z'))).toBe(Date.parse('2026-09-29T15:00:00Z'));
    expect(nextTickAt(Date.parse('2026-09-29T15:00:00Z'))).toBe(Date.parse('2026-09-29T15:30:00Z'));
  });
});

describe('the views', () => {
  it('home: every tile but the hidden one, one line per flow, four mini bars without contributors', () => {
    const ev = input();
    const home = homeResponse(base(), ev, usageView(), DESIRED);
    expect(home.entries.map((e) => e.id)).toEqual(['mail-hero', 'todofy', 'lab', 'website', 'notion-publish', 'newsletter']);
    // A link-only entry (synthetic: the registry has none) is a tile at level link, never probed.
    const linked = homeResponse(base(), ev, usageView(), DESIRED, withLinkOnly()).entries.find((e) => e.id === LINK_ONLY_ENTRY.id);
    expect(linked).toMatchObject({ level: 'link', reason: null, metric: null, checked_at: null });
    expect(home.flows.map((f) => f.id)).toEqual(['mail-to-task', 'gtd', 'site-publish', 'daily-newsletter', 'paper-radar', 'ops-digest']);
    expect(home.flows[0]).not.toHaveProperty('stages');
    expect(home.cloudflare.quota.map((q) => q.id)).toEqual(HOME_QUOTA_IDS);
    expect(home.cloudflare.quota.every((q) => q.breakdown.length === 0)).toBe(true);
    expect(home.cloudflare).toMatchObject({ usage_status: 'ok', workers: 5, errors_today: 3, guard_level: 'normal' });
    expect(home.digest).toEqual({ last_sent_at: '2026-09-29T07:00:00.000Z', accepted: true });
    // No URL or host in a dynamic view: those come from the registry only.
    expect(JSON.stringify(home)).not.toMatch(/ziyixi\.science|https?:\/\/(?!developers\.cloudflare\.com)/);
  });

  it('flows: the canary only on the mail flow, with its last ok run', () => {
    const ev = input({ canaryRecent: fortnight(run('2026-09-29', 'ok', null, null, 9)) });
    const flows = flowsResponse(base(), ev, canaryView(ev));
    expect(flows.flows.map((f) => [f.id, f.canary?.id ?? null])).toEqual([
      ['mail-to-task', 'mail-todofy'],
      ['gtd', null],
      ['site-publish', null],
      ['daily-newsletter', null],
      ['paper-radar', null],
      ['ops-digest', null],
    ]);
    expect(flows.flows[0]?.canary).toMatchObject({ last_ok_at: '2026-09-29T09:06:00.000Z', manual_limit: CANARY_MANUAL_PER_DAY });
    expect(flows.flows[0]?.canary?.recent).toHaveLength(14);
  });

  it.each([0, 5, 20])('cloudflare: %i scripts in the Worker table, resources and the quota rows', (count) => {
    const usage = usageWithScripts(count);
    const doc = usageDoc(usage);
    const view = cloudflareResponse(base(), NOW, usageView(usage), doc, count === 0 ? null : scripts(usage), GUARD, DRIFT_OK);
    expect(view.workers).toHaveLength(count);
    expect(view.usage.rows).toHaveLength(14);
    expect(view.resources.map((r) => r.kind)).toEqual(['d1', 'd1', 'do', 'do', 'do', 'r2', 'r2']);
    // The stored rows carry raw keys; the view joins the D1/DO/R2 ones to the registry.
    expect(doc.rows.flatMap((r) => r.breakdown).some((item) => 'kind' in item)).toBe(false);
    expect(view.usage.rows.find((r) => r.id === 'r2_storage')?.breakdown).toEqual([
      { name: 'mail-hero-store', value: 781_000_000, kind: 'r2', resource: 'mail-hero-store' },
      { name: 'backup-synthetic', value: 56_000_000, kind: 'r2', resource: null },
    ]);
    expect(view.usage.rows.find((r) => r.id === 'do_rows_written')?.breakdown.every((item) => item.kind === 'do' && item.resource === null)).toBe(true);
    expect(view.usage.rows.find((r) => r.id === 'workers_requests')?.breakdown.every((item) => !('kind' in item))).toBe(true);
    expect(view.do_storage_bytes).toBeNull();
    expect(view.workers_truncated).toBe(false);
    expect(bytes(view)).toBeLessThanOrEqual(V2_BODY_BUDGET.cloudflare);
  });

  it('ops: guard, the canary with its id, the digest and every ops-v1 app in registry order', () => {
    const ev = input();
    const ops = opsResponse(base(), GUARD, canaryView(ev), digestView([]), ev.statuses);
    expect(ops.apps.map((a) => a.entry)).toEqual(['mail-hero', 'todofy', 'lab']);
    expect(ops.apps[0]).toMatchObject({ reachable: true, error: null, consecutive_failures: 0, status: { app: 'mail-hero' } });
    expect(ops.canary.id).toBe('mail-todofy');
    expect(ops.guard.apps).toHaveProperty('todofy');
  });

  it('stays within the body budgets on the mockup day (one warning, 14 runs, 5 Workers)', () => {
    const gemini = status('todofy', { health: 'degraded', signals: [signal('gemini_budget_80', 'warning', { percent: 82 }, '2026-09-29T11:20:00Z')] });
    const ev = input({ statuses: { 'mail-hero': status('mail-hero'), todofy: gemini, lab: status('lab') }, canaryRecent: fortnight(run('2026-09-29', 'ok', null, null, 9)) });
    const item: OpsReportItem = { source: 'todofy', code: 'gemini_budget_80', severity: 'warning', since: '2026-09-29T11:20:00.000Z', metrics: { percent: 82 } };
    const day = base({}, [item]);
    const sizes = {
      home: bytes(homeResponse(day, ev, usageView(REALISTIC_USAGE), DESIRED)),
      flows: bytes(flowsResponse(day, ev, canaryView(ev))),
      cloudflare: bytes(cloudflareResponse(day, NOW, usageView(REALISTIC_USAGE), usageDoc(REALISTIC_USAGE), ev.scripts, GUARD, DRIFT_OK)),
      ops: bytes(opsResponse(day, GUARD, canaryView(ev), digestView([item]), ev.statuses)),
    };
    for (const view of ['home', 'flows', 'cloudflare', 'ops'] as const) expect({ view, bytes: sizes[view] }).toEqual({ view, bytes: Math.min(sizes[view], V2_BODY_BUDGET[view]) });
  });

  it('stays within V2_BODY_MAX on a heavy day (20 items, 16 signals per app, 14 failed runs, 20 scripts)', () => {
    const ev = heavyInput();
    const shellHeavy = base({}, HEAVY_ITEMS);
    const sizes = {
      home: bytes(homeResponse(shellHeavy, ev, usageView(usageWithScripts(20)), DESIRED)),
      flows: bytes(flowsResponse(shellHeavy, ev, canaryView(ev))),
      cloudflare: bytes(
        cloudflareResponse(shellHeavy, NOW, usageView(usageWithScripts(20)), usageDoc(usageWithScripts(20)), ev.scripts, GUARD, DRIFT_HEAVY),
      ),
      ops: bytes(opsResponse(shellHeavy, GUARD, canaryView(ev), digestView(HEAVY_ITEMS), ev.statuses)),
    };
    for (const view of ['home', 'flows', 'cloudflare', 'ops'] as const) expect({ view, bytes: sizes[view] }).toEqual({ view, bytes: Math.min(sizes[view], V2_BODY_MAX) });
  });

  it('bounds the Cloudflare view at CF_SCRIPTS_MAX remembered scripts on a heavy day, active ones first (C2)', () => {
    // 100 remembered scripts with long names: 30 active today, 70 seen on earlier days.
    const record = (i: number): ScriptRecord => {
      const active = i < 30;
      return {
        script: `a-long-remembered-worker-name-${String(i).padStart(3, '0')}`,
        first_seen_day: '2026-09-01',
        last_seen_day: active ? '2026-09-29' : `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`,
        last_active_hour: active ? NOW - 60 * MIN : null,
        day: '2026-09-29',
        today: active
          ? { requests: 1_000_000 + i, errors: 99_999, subrequests: 999_999, cpu_p50_us: 9_999, cpu_p99_us: 99_999, do_requests: 999_999, do_errors: 9_999 }
          : { requests: 0, errors: 0, subrequests: 0, cpu_p50_us: null, cpu_p99_us: null, do_requests: null, do_errors: null },
      };
    };
    const doc: CfScriptsDoc = { since: NOW - 30 * DAY, observed_at: NOW, day: '2026-09-29', truncated: true, scripts: Array.from({ length: CF_SCRIPTS_MAX }, (_, i) => record(i)) };
    const view = cloudflareResponse(base({}, HEAVY_ITEMS), NOW, usageView(usageWithScripts(20)), usageDoc(usageWithScripts(20)), doc, GUARD, DRIFT_HEAVY);
    expect(view.drift.findings).toHaveLength(DRIFT_VIEW_FINDINGS_MAX);
    expect(view.drift.findings_omitted).toBe(50 + 12 - DRIFT_VIEW_FINDINGS_MAX);
    expect(view.workers).toHaveLength(CF_VIEW_WORKERS_MAX);
    expect(view.workers_omitted).toBe(CF_SCRIPTS_MAX - CF_VIEW_WORKERS_MAX);
    // Every script active today is listed; the omitted ones are the least recently seen.
    expect(view.workers.filter((row) => row.requests > 0)).toHaveLength(30);
    const listedIdle = view.workers.filter((row) => row.requests === 0).map((row) => row.last_seen_day);
    expect(Math.min(...listedIdle.map((day) => Date.parse(day)))).toBeGreaterThanOrEqual(Date.parse('2026-09-08'));
    expect(bytes(view)).toBeLessThanOrEqual(V2_BODY_MAX);
    // Under the cap nothing is left out.
    expect(capWorkers(view.workers.slice(0, 10))).toEqual({ rows: view.workers.slice(0, 10), omitted: 0 });
  });
});

describe('documented budgets', () => {
  /** The first "≤ N KiB" (and "≤ M rows read") of each `GET <route>` row of a table in `text`. */
  function documented(text: string): Map<string, { kib: number; rows: number | null }> {
    const found = new Map<string, { kib: number; rows: number | null }>();
    for (const line of text.split('\n')) {
      const route = /\|\s*`?GET\s+([a-z]+)/.exec(line)?.[1];
      const kib = /≤ (\d+) KiB/.exec(line)?.[1];
      if (route === undefined || kib === undefined) continue;
      const rows = /≤ (\d+) rows read/.exec(line)?.[1];
      found.set(route, { kib: Number(kib), rows: rows === undefined ? null : Number(rows) });
    }
    return found;
  }

  it('the route table of api-v2-types.ts states V2_BODY_BUDGET and V2_ROWS_READ', () => {
    const header = apiV2Source.split('*/', 1)[0] ?? '';
    const rows = documented(header);
    expect([...rows.keys()].sort()).toEqual(Object.keys(V2_BODY_BUDGET).sort());
    for (const [view, budget] of Object.entries(V2_BODY_BUDGET)) {
      expect({ view, kib: rows.get(view)?.kib }).toEqual({ view, kib: budget / 1024 });
      if (view in V2_ROWS_READ) expect({ view, rows: rows.get(view)?.rows }).toEqual({ view, rows: V2_ROWS_READ[view as keyof typeof V2_ROWS_READ] });
    }
  });

  it('the route table of docs/design-v2.md states V2_BODY_BUDGET', () => {
    const rows = documented(designV2.split('\n| Route | Served by | Budget |', 2)[1]?.split('\n\n', 1)[0] ?? '');
    expect([...rows.keys()].sort()).toEqual(Object.keys(V2_BODY_BUDGET).sort());
    for (const [view, budget] of Object.entries(V2_BODY_BUDGET)) expect({ view, kib: rows.get(view)?.kib }).toEqual({ view, kib: budget / 1024 });
  });
});
