import { describe, expect, it } from 'vitest';
import schema from '../../../contracts/ops-v1/ops-v1.schema.json';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import mailHeroDegraded from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-degraded.json';
import todofyOk from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json';
import unavailable from '../../../contracts/ops-v1/fixtures/OpsStatus/status-unavailable.json';
import { OPS_LIMITS, type OpsReportItem, type OpsStatus } from '../../../contracts/ops-v1/ops-v1.ts';
import type { QuotaRow } from '../src/api-types.ts';
import { finish, newRun } from '../src/canary.ts';
import {
  buildReport,
  candidates,
  cleanMetrics,
  digestKey,
  finalizeItems,
  itemKey,
  overallLevel,
  reportBytes,
  shouldSend,
  withTickState,
  type DigestInput,
} from '../src/digest.ts';

const SCHEMA = schema as { $defs: Record<string, unknown> };
const NOW = Date.parse('2026-09-29T14:00:00Z');
const URL_ = 'https://home.example.com/';

function quota(id: QuotaRow['id'], percent: number): QuotaRow {
  return {
    id,
    period: 'daily',
    unit: 'rows',
    used: percent * 1000,
    limit: 100_000,
    percent,
    projected: percent * 1500,
    projected_percent: percent * 1.5,
    guard_trigger: true,
    truncated: false,
    breakdown: [],
    source: 'https://developers.cloudflare.com/',
  };
}

function input(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    now: NOW,
    usage: { configured: true, fresh: true, rows: [], fetched_at: NOW, consecutive_failures: 0, last_http_status: 200 },
    desired: { level: 'normal', reason: 'quota_normal', until: null, source: 'auto' },
    guardFailures: { 'mail-hero': 0, todofy: 0 },
    latestFinished: null,
    lastTickAt: NOW,
    apps: {
      'mail-hero': { consecutive_failures: 0, status: null, status_at: null },
      todofy: { consecutive_failures: 0, status: todofyOk as OpsStatus, status_at: NOW - 60_000 },
    },
    ...overrides,
  };
}

function items(overrides: Partial<DigestInput> = {}): OpsReportItem[] {
  return finalizeItems(candidates(input(overrides)), new Map(), NOW);
}

describe('digest items', () => {
  it('is empty for a healthy system', () => {
    expect(items()).toEqual([]);
  });

  it('reports quota rows at 80 % (warning) and 95 % (critical) with numeric metrics', () => {
    const list = items({ usage: { ...input().usage, rows: [quota('d1_rows_read', 81.5), quota('do_rows_written', 96), quota('workers_requests', 50)] } });
    expect(list.map((i) => [i.source, i.code, i.severity])).toEqual([
      ['cloudflare', 'do_rows_written_high', 'critical'],
      ['cloudflare', 'd1_rows_read_high', 'warning'],
    ]);
    expect(list[1]?.metrics).toEqual({ percent: 81.5, used: 81_500, limit: 100_000, projected_percent: 122.25 });
    // Stale usage: no quota items.
    expect(items({ usage: { ...input().usage, fresh: false, rows: [quota('d1_rows_read', 99)] } })).toEqual([]);
  });

  it('reports the analytics token missing or failing for 2 h', () => {
    expect(items({ usage: { ...input().usage, configured: false } }).map(itemKey)).toEqual(['dashboard:usage_not_configured']);
    const failing = { ...input().usage, consecutive_failures: 5, fetched_at: NOW - 2 * 3_600_000, last_http_status: 401 };
    expect(items({ usage: failing })).toMatchObject([{ code: 'usage_unavailable', metrics: { consecutive_failures: 5, http_status: 401 } }]);
    expect(items({ usage: { ...failing, fetched_at: NOW - 3_600_000 } })).toEqual([]);
    expect(items({ usage: { ...failing, fetched_at: null, last_http_status: null } })).toMatchObject([{ metrics: { http_status: 0 } }]);
  });

  it('reports stopped cron ticks (none completed for 75 minutes, or none ever)', () => {
    expect(items({ lastTickAt: NOW - 75 * 60_000 })).toEqual([]);
    expect(items({ lastTickAt: NOW - 3 * 3_600_000 })).toEqual([
      { source: 'dashboard', code: 'tick_stale', severity: 'warning', since: '2026-09-29T11:00:00.000Z', metrics: { minutes_since: 180 } },
    ]);
    expect(items({ lastTickAt: null }).map(itemKey)).toEqual(['dashboard:tick_stale']);
  });

  it('judges stored items against the current time', () => {
    const critical = { source: 'todofy', code: 'app_unreachable', severity: 'critical', since: '2026-09-29T10:00:00.000Z', metrics: {} } as const;
    const stale = withTickState([critical], NOW - 3 * 3_600_000, NOW);
    expect(stale.map(itemKey)).toEqual(['todofy:app_unreachable', 'dashboard:tick_stale']);
    expect(withTickState(stale, NOW - 60_000, NOW).map(itemKey)).toEqual(['todofy:app_unreachable']);
    expect(withTickState([], NOW - 60_000, NOW)).toEqual([]);
  });

  it('reports an active shed and repeated setGuard failures', () => {
    const list = items({
      desired: { level: 'shed', reason: 'owner_shed', until: NOW + 5_400_000, source: 'owner' },
      guardFailures: { 'mail-hero': 2, todofy: 1 },
    });
    expect(list.map(itemKey)).toEqual(['dashboard:guard_shed', 'mail-hero:guard_apply_failed']);
    expect(list[0]?.metrics).toEqual({ hours_left: 1.5, manual: 1 });
  });

  it('reports the latest finished canary run when it failed (critical) or was skipped (warning, with its reason)', () => {
    const run = newRun('canary-2026-09-29', 'scheduled', NOW - 3 * 3_600_000);
    const failed = finish({ ...run, delivery: { state: 'pending', attempts: 3, last_http_status: 503, error_code: 'http_503' } }, 'failed', 'delivery', 'timeout', NOW - 3_600_000);
    const list = items({ latestFinished: failed });
    expect(list).toEqual([
      { source: 'dashboard', code: 'canary_not_delivered', severity: 'critical', since: '2026-09-29T13:00:00.000Z', metrics: { attempts: 3, timed_out: 1, last_http_status: 503 } },
    ]);
    expect(items({ latestFinished: finish(run, 'failed', 'start', 'invalid_input', NOW) })[0]?.code).toBe('canary_start_failed');
    expect(items({ latestFinished: finish(run, 'failed', 'consumer', 'llm_quota', NOW) })[0]?.code).toBe('canary_consumer_failed');
    expect(items({ latestFinished: finish(run, 'skipped', 'start', 'canary_consumer_missing', NOW) })).toEqual([
      { source: 'dashboard', code: 'canary_skipped', severity: 'warning', since: '2026-09-29T14:00:00.000Z', metrics: { canary_consumer_missing: 1 } },
    ]);
    // contracts/ops-v1 "Daily canary" step 2: paused/unavailable is reported with its reason, never as a failure.
    for (const [stage, code] of [['start', 'no_endpoint'], ['start', 'send_paused'], ['start', 'maintenance'], ['delivery', 'endpoint_paused'], ['consumer', 'processing_paused']] as const) {
      expect(items({ latestFinished: finish(run, 'skipped', stage, code, NOW) })).toEqual([
        { source: 'dashboard', code: 'canary_skipped', severity: 'warning', since: '2026-09-29T14:00:00.000Z', metrics: { [code]: 1 } },
      ]);
    }
    expect(items({ latestFinished: finish(run, 'ok', null, null, NOW) })).toEqual([]);
  });

  it('reports unreachable and down apps and passes on warning/critical signals', () => {
    const list = items({
      apps: {
        'mail-hero': { consecutive_failures: 0, status: mailHeroDegraded as OpsStatus, status_at: NOW - 60_000 },
        todofy: { consecutive_failures: 2, status: unavailable as OpsStatus, status_at: NOW - 30 * 60_000 },
      },
    });
    const keys = list.map((i) => `${itemKey(i)}:${i.severity}`);
    expect(keys).toContain('todofy:app_unreachable:critical');
    expect(keys).toContain('todofy:app_down:critical');
    expect(keys).toContain('todofy:status_unavailable:critical');
    for (const signal of (mailHeroDegraded as OpsStatus).signals) {
      expect(keys.includes(`mail-hero:${signal.code}:${signal.severity}`)).toBe(signal.severity !== 'info');
    }
    const withSince = (mailHeroDegraded as OpsStatus).signals.find((s) => s.since !== undefined && s.severity !== 'info');
    if (withSince) expect(list.find((i) => i.code === withSince.code)?.since).toBe(withSince.since);
    // A status older than an hour contributes no signals.
    const old = items({ apps: { ...input().apps, 'mail-hero': { consecutive_failures: 0, status: mailHeroDegraded as OpsStatus, status_at: NOW - 61 * 60_000 } } });
    expect(old.filter((i) => i.source === 'mail-hero')).toEqual([]);
  });

  it('orders critical first, deduplicates, keeps 20 and uses first-seen times', () => {
    const list = finalizeItems(
      [
        { source: 'b', code: 'x', severity: 'warning', metrics: {} },
        { source: 'a', code: 'y', severity: 'critical', metrics: {} },
        { source: 'b', code: 'x', severity: 'critical', metrics: {} },
        { source: 'a', code: 'z', severity: 'info', metrics: {} },
        ...Array.from({ length: 30 }, (_, i) => ({ source: 'c', code: `c${String(i).padStart(2, '0')}`, severity: 'warning' as const, metrics: {} })),
      ],
      new Map([['b:x', NOW - 1000]]),
      NOW,
    );
    expect(list).toHaveLength(OPS_LIMITS.reportMaxItems);
    expect(list.slice(0, 3).map((i) => `${itemKey(i)}:${i.severity}`)).toEqual(['a:y:critical', 'b:x:critical', 'c:c00:warning']);
    expect(list[1]?.since).toBe(new Date(NOW - 1000).toISOString());
    expect(list[0]?.since).toBe(new Date(NOW).toISOString());
  });

  it('keeps metrics numeric and named by codes', () => {
    expect(cleanMetrics({ ok: 1, 'Bad-Key': 2, nan: Number.NaN, text: 'x' })).toEqual({ ok: 1 });
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${String(i)}`, i]));
    expect(Object.keys(cleanMetrics(many))).toHaveLength(OPS_LIMITS.metricsMaxKeys);
  });
});

describe('reports', () => {
  it('validates as OpsReport, empty included', () => {
    const list = items({ usage: { ...input().usage, rows: [quota('d1_rows_read', 81.5)] }, desired: { level: 'shed', reason: 'quota_d1_rows_read', until: NOW + 3_600_000, source: 'auto' } });
    for (const report of [buildReport(list, NOW, URL_), buildReport([], NOW, URL_), buildReport(list, NOW, null)]) {
      expect(validate(SCHEMA, 'OpsReport', report)).toEqual([]);
    }
  });

  it('is trimmed from the end to 8192 bytes of compact JSON', () => {
    const big: OpsReportItem[] = Array.from({ length: 20 }, (_, i) => ({
      source: 'mail-hero',
      code: `signal_with_a_rather_long_code_number_${String(i).padStart(2, '0')}`,
      severity: 'warning',
      since: '2026-09-29T14:00:00.000Z',
      metrics: Object.fromEntries(Array.from({ length: 12 }, (_, j) => [`metric_name_long_${String(j)}`, 123456789.123])),
    }));
    const report = buildReport(big, NOW, URL_);
    expect(reportBytes(report)).toBeLessThanOrEqual(OPS_LIMITS.reportMaxBytes);
    expect(report.items.length).toBeLessThan(20);
    expect(report.items).toEqual(big.slice(0, report.items.length));
    expect(validate(SCHEMA, 'OpsReport', report)).toEqual([]);
  });
});

describe('sending', () => {
  const list = [{ source: 'x', code: 'b', severity: 'critical', since: '2026-09-29T00:00:00Z', metrics: {} }, { source: 'x', code: 'a', severity: 'warning', since: '2026-09-29T00:00:00Z', metrics: {} }] as const;

  it('keys on the sorted source:code:severity set', () => {
    expect(digestKey(list)).toBe('x:a:warning,x:b:critical');
    expect(digestKey([...list].reverse())).toBe(digestKey(list));
    expect(digestKey([])).toBe('');
  });

  it('sends on first run, on change, after 6 h and at 23:30 UTC when an hour old', () => {
    const key = digestKey(list);
    expect(shouldSend(key, { last_key: null, last_sent_at: null }, NOW)).toBe(true);
    expect(shouldSend('', { last_key: null, last_sent_at: null }, NOW)).toBe(true);
    expect(shouldSend(key, { last_key: key, last_sent_at: NOW - 30 * 60_000 }, NOW)).toBe(false);
    expect(shouldSend(key, { last_key: 'other', last_sent_at: NOW - 60_000 }, NOW)).toBe(true);
    expect(shouldSend(key, { last_key: key, last_sent_at: NOW - 6 * 3_600_000 }, NOW)).toBe(true);
    const late = Date.parse('2026-09-29T23:30:00Z');
    expect(shouldSend(key, { last_key: key, last_sent_at: late - 60 * 60_000 }, late)).toBe(true);
    expect(shouldSend(key, { last_key: key, last_sent_at: late - 30 * 60_000 }, late)).toBe(false);
    expect(shouldSend(key, { last_key: key, last_sent_at: late - 90 * 60_000 }, Date.parse('2026-09-29T23:00:00Z') + 0)).toBe(false);
  });

  it('derives the banner level from the items', () => {
    expect(overallLevel([])).toBe('ok');
    expect(overallLevel([list[1]])).toBe('warning');
    expect(overallLevel(list)).toBe('critical');
  });
});
