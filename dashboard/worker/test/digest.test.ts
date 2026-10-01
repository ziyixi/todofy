import { describe, expect, it } from 'vitest';
import schema from '../../../contracts/ops-v1/ops-v1.schema.json';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import mailHeroDegraded from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-degraded.json';
import todofyOk from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json';
import unavailable from '../../../contracts/ops-v1/fixtures/OpsStatus/status-unavailable.json';
import { OPS_LIMITS, type OpsReportItem, type OpsStatus } from '../../../contracts/ops-v1/ops-v1.ts';
import type { QuotaRow } from '../src/api-types.ts';
import { finish, newRun } from '../src/canary.ts';
import { NO_DRIFT } from '../src/drift.ts';
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
    guardFailures: { 'mail-hero': 0, todofy: 0, lab: 0 },
    latestFinished: null,
    lastTickAt: NOW,
    apps: {
      'mail-hero': { consecutive_failures: 0, status: null, status_at: null },
      todofy: { consecutive_failures: 0, status: todofyOk as OpsStatus, status_at: NOW - 60_000 },
      lab: { consecutive_failures: 0, status: null, status_at: null },
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

  it('judges quota items on the measured value, not the percent rounded to 0.1', () => {
    // 79.95 % and 94.95 % display as 80.0 and 95.0 but are below the thresholds.
    const edge = (id: QuotaRow['id'], used: number): QuotaRow => ({ ...quota(id, Math.round(used / 100) / 10), used });
    const list = items({ usage: { ...input().usage, rows: [edge('d1_rows_read', 79_950), edge('do_rows_written', 94_950)] } });
    expect(list.map((i) => [i.code, i.severity])).toEqual([['do_rows_written_high', 'warning']]);
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

  it('reports Workers AI neurons as ai_neurons_high at 80 % (warning) and 95 % (critical)', () => {
    const ai = (percent: number): QuotaRow => ({ ...quota('ai_neurons', percent), unit: 'neurons', used: percent * 100, limit: 10_000, guard_trigger: false });
    const at = (percent: number) => items({ usage: { ...input().usage, rows: [ai(percent)] } }).map((i) => [i.source, i.code, i.severity]);
    expect(at(79.9)).toEqual([]);
    expect(at(80)).toEqual([['cloudflare', 'ai_neurons_high', 'warning']]);
    expect(at(94.9)).toEqual([['cloudflare', 'ai_neurons_high', 'warning']]);
    expect(at(95)).toEqual([['cloudflare', 'ai_neurons_high', 'critical']]);
    expect(items({ usage: { ...input().usage, rows: [ai(97)] } })[0]?.metrics).toEqual({ percent: 97, used: 9700, limit: 10_000, projected_percent: 145.5 });
    // Not a guard trigger, so no guard_shed item comes with it (the desired guard stays normal).
    expect(items({ usage: { ...input().usage, rows: [ai(99)] } }).map(itemKey)).toEqual(['cloudflare:ai_neurons_high']);
  });

  it('reports the analytics token missing or failing for 2 h', () => {
    expect(items({ usage: { ...input().usage, configured: false } }).map(itemKey)).toEqual(['dashboard:usage_not_configured']);
    const failing = { ...input().usage, consecutive_failures: 5, fetched_at: NOW - 2 * 3_600_000, last_http_status: 401 };
    expect(items({ usage: failing })).toMatchObject([{ code: 'usage_unavailable', metrics: { consecutive_failures: 5, http_status: 401 } }]);
    expect(items({ usage: { ...failing, fetched_at: NOW - 3_600_000 } })).toEqual([]);
    expect(items({ usage: { ...failing, fetched_at: null, last_http_status: null } })).toMatchObject([{ metrics: { http_status: 0 } }]);
  });

  it('reports configuration drift by category counts, and a drift check failing two days in a row', () => {
    const counts = { ...NO_DRIFT.counts, personal: 4, bindings: 1 };
    const drift = { ...NO_DRIFT, checked_at: NOW - 3_600_000, counts };
    expect(candidates(input({ drift: { configured: true, doc: drift } }))).toEqual([
      { source: 'dashboard', code: 'config_drift', severity: 'warning', metrics: { total: 5, bindings: 1, personal: 4 } },
    ]);
    // Nothing without findings, before the first check, or without the token (usage_not_configured covers that).
    expect(candidates(input({ drift: { configured: true, doc: { ...drift, counts: NO_DRIFT.counts } } }))).toEqual([]);
    expect(candidates(input({ drift: { configured: true, doc: NO_DRIFT } }))).toEqual([]);
    expect(candidates(input({ drift: { configured: false, doc: drift } }))).toEqual([]);
    expect(candidates(input({ drift: { configured: true, doc: { ...NO_DRIFT, consecutive_failed_days: 1 } } }))).toEqual([]);
    expect(candidates(input({ drift: { configured: true, doc: { ...NO_DRIFT, consecutive_failed_days: 2 } } }))).toEqual([
      { source: 'dashboard', code: 'drift_unavailable', severity: 'warning', metrics: { consecutive_failed_days: 2 } },
    ]);
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
      guardFailures: { 'mail-hero': 2, todofy: 1, lab: 0 },
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
    // Ended by the switch (CANARY_ENABLED=false): nothing to report.
    expect(items({ latestFinished: finish(run, 'skipped', 'start', 'canary_disabled', NOW) })).toEqual([]);
  });

  it('reports unreachable and down apps and passes on warning/critical signals', () => {
    const list = items({
      apps: {
        'mail-hero': { consecutive_failures: 0, status: mailHeroDegraded as OpsStatus, status_at: NOW - 60_000 },
        todofy: { consecutive_failures: 2, status: unavailable as OpsStatus, status_at: NOW - 30 * 60_000 },
        lab: { consecutive_failures: 0, status: null, status_at: null },
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

  it('does not overwrite the 23:30 report at the 00:00 tick (Todofy lists only the latest, from before the day)', () => {
    // 23:30: D1 reads at 86 % and the guard shed; the report is sent for the next day's reminder.
    const lateAt = Date.parse('2026-09-15T23:30:00Z');
    const breach = digestKey([
      { source: 'cloudflare', code: 'd1_rows_read_high', severity: 'warning', since: '2026-09-15T20:00:00Z', metrics: {} },
      { source: 'dashboard', code: 'guard_shed', severity: 'warning', since: '2026-09-15T20:00:00Z', metrics: {} },
    ]);
    const sent = { last_key: breach, last_sent_at: lateAt };
    // 00:00: the daily quota reset, the items are gone. Sending now would replace the 23:30 report
    // before Todofy's first reminder check of the day (every 10 min) claimed it.
    expect(shouldSend('', sent, Date.parse('2026-09-16T00:00:00Z'))).toBe(false);
    expect(shouldSend('', sent, Date.parse('2026-09-16T00:00:30Z'))).toBe(false);
    // Also a plain refresh (same key, last success ≥ 6 h old) waits.
    expect(shouldSend(breach, { last_key: breach, last_sent_at: Date.parse('2026-09-15T17:00:00Z') }, Date.parse('2026-09-16T00:00:00Z'))).toBe(false);
    // 00:30: the reminder check has run; the change is sent.
    expect(shouldSend('', sent, Date.parse('2026-09-16T00:30:00Z'))).toBe(true);
    // A report already sent today is not held; nor is the very first report.
    const today = { last_key: breach, last_sent_at: Date.parse('2026-09-16T00:00:00Z') };
    expect(shouldSend('', today, Date.parse('2026-09-16T00:10:00Z'))).toBe(true);
    expect(shouldSend('', { last_key: null, last_sent_at: null }, Date.parse('2026-09-16T00:00:00Z'))).toBe(true);
    // The first of a month (a monthly R2 item clearing) is the same rule.
    expect(shouldSend('', sent, Date.parse('2026-10-01T00:00:00Z'))).toBe(false);
  });

  it('derives the banner level from the items', () => {
    expect(overallLevel([])).toBe('ok');
    expect(overallLevel([list[1]])).toBe('warning');
    expect(overallLevel(list)).toBe('critical');
  });
});
