import { describe, expect, it } from 'vitest';
import { fromWire } from '@ziyixi/proto/wire-json';
import { CreateInboxTaskRequestSchema } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_pb';
import mailHeroDegraded from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-degraded.json';
import todofyOk from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json';
import unavailable from '../../../contracts/ops-v1/fixtures/OpsStatus/status-unavailable.json';
import type { OpsReportItem, OpsStatus } from '@ziyixi/proto/ops/v1/ops_wire';
import { METRICS_MAX_KEYS, REPORT_MAX_ITEMS } from '../src/ops-client.ts';
import type { QuotaRow } from '../src/api-types.ts';
import { finish, newRun } from '../src/canary.ts';
import { NO_DRIFT } from '../src/drift.ts';
import { DIGEST_TASK_ATTEMPTS } from '../src/api-types.ts';
import {
  afterCall,
  candidates,
  claimDay,
  cleanMetrics,
  digestTask,
  finalizeItems,
  itemKey,
  nextDigestDay,
  withTickState,
  type DigestInput,
} from '../src/digest.ts';
import { NO_DIGEST, type DigestDoc } from '../src/docs.ts';

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
    guardFailures: { 'mail-hero': 0, todofy: 0, watch: 0, fleet: 0, newsletter: 0, 'codex-gateway': 0, 'notion-publish': 0, mailsort: 0, recall: 0, brief: 0, tasks: 0, 'personal-mcp': 0, 'model-router': 0 },
    latestFinished: null,
    lastTickAt: NOW,
    apps: {
      'mail-hero': { consecutive_failures: 0, status: null, status_at: null },
      todofy: { consecutive_failures: 0, status: todofyOk as OpsStatus, status_at: NOW - 60_000 },
      watch: { consecutive_failures: 0, status: null, status_at: null },
      fleet: { consecutive_failures: 0, status: null, status_at: null },
      newsletter: { consecutive_failures: 0, status: null, status_at: null },
      'codex-gateway': { consecutive_failures: 0, status: null, status_at: null },
      'notion-publish': { consecutive_failures: 0, status: null, status_at: null },
      mailsort: { consecutive_failures: 0, status: null, status_at: null },
      recall: { consecutive_failures: 0, status: null, status_at: null },
      brief: { consecutive_failures: 0, status: null, status_at: null },
      tasks: { consecutive_failures: 0, status: null, status_at: null },
      'personal-mcp': { consecutive_failures: 0, status: null, status_at: null },
      'model-router': { consecutive_failures: 0, status: null, status_at: null },
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
    const counts = { ...NO_DRIFT.counts, personal: 4, bindings: 1, account_changes: 3 };
    const drift = { ...NO_DRIFT, checked_at: NOW - 3_600_000, counts };
    expect(candidates(input({ drift: { configured: true, doc: drift } }))).toEqual([
      { source: 'dashboard', code: 'config_drift', severity: 'warning', metrics: { total: 5, bindings: 1, personal: 4 } },
    ]);
    // Nothing without findings, before the first check, or without the token (usage_not_configured covers that).
    expect(candidates(input({ drift: { configured: true, doc: { ...drift, counts: NO_DRIFT.counts } } }))).toEqual([]);
    expect(candidates(input({ drift: { configured: true, doc: { ...drift, counts: { ...NO_DRIFT.counts, account_changes: 3 } } } }))).toEqual([]);
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
      guardFailures: { 'mail-hero': 2, todofy: 1, watch: 0, fleet: 0, newsletter: 0, 'codex-gateway': 0, 'notion-publish': 0, mailsort: 0, recall: 0, brief: 0, tasks: 0, 'personal-mcp': 0, 'model-router': 0 },
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
        watch: { consecutive_failures: 0, status: null, status_at: null },
      fleet: { consecutive_failures: 0, status: null, status_at: null },
      newsletter: { consecutive_failures: 0, status: null, status_at: null },
      'codex-gateway': { consecutive_failures: 0, status: null, status_at: null },
      'notion-publish': { consecutive_failures: 0, status: null, status_at: null },
      mailsort: { consecutive_failures: 0, status: null, status_at: null },
      recall: { consecutive_failures: 0, status: null, status_at: null },
      brief: { consecutive_failures: 0, status: null, status_at: null },
      tasks: { consecutive_failures: 0, status: null, status_at: null },
      'personal-mcp': { consecutive_failures: 0, status: null, status_at: null },
      'model-router': { consecutive_failures: 0, status: null, status_at: null },
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
    expect(list).toHaveLength(REPORT_MAX_ITEMS);
    expect(list.slice(0, 3).map((i) => `${itemKey(i)}:${i.severity}`)).toEqual(['a:y:critical', 'b:x:critical', 'c:c00:warning']);
    expect(list[1]?.since).toBe(new Date(NOW - 1000).toISOString());
    expect(list[0]?.since).toBe(new Date(NOW).toISOString());
  });

  it('keeps metrics numeric and named by codes', () => {
    expect(cleanMetrics({ ok: 1, 'Bad-Key': 2, nan: Number.NaN, text: 'x' })).toEqual({ ok: 1 });
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${String(i)}`, i]));
    expect(Object.keys(cleanMetrics(many))).toHaveLength(METRICS_MAX_KEYS);
  });
});

describe("the day's task", () => {
  const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
  const listed = (): OpsReportItem[] =>
    items({ usage: { ...input().usage, rows: [quota('d1_rows_read', 96)] }, desired: { level: 'shed', reason: 'quota_d1_rows_read', until: NOW + 3_600_000, source: 'auto' } });
  /** A document of a day before NOW's, as an earlier release's tick left it. */
  const yesterday: DigestDoc = { ...NO_DIGEST, day: '2026-09-28', state: 'created', attempts: 1, task_id: 'task-0' };

  it("lists codes, severities, times and numbers, and is a valid TaskInbox request", () => {
    const task = digestTask(listed(), '2026-09-29', URL_);
    expect(task.title).toBe('运维摘要 2026-09-29：2 项需要关注');
    expect(task.description.split('\n')).toEqual([
      'Home 在 UTC 2026-09-29 第一次有警告或严重项目时创建此任务，每个 UTC 日最多一次：',
      '',
      '- critical · cloudflare · d1_rows_read_high · 自 2026-09-29T14:00:00.000Z · percent=96, used=96000, limit=100000, projected_percent=144',
      '- warning · dashboard · guard_shed · 自 2026-09-29T14:00:00.000Z · hours_left=1, manual=0',
      '',
      `查看 Home：${URL_}`,
    ]);
    expect(() => fromWire(CreateInboxTaskRequestSchema, { request_id: REQUEST_ID, ...task }, { strict: true })).not.toThrow();
  });

  it('lists 20 items and counts the rest', () => {
    const many: OpsReportItem[] = Array.from({ length: 23 }, (_, i) => ({ source: 'mail-hero', code: `code_${String(i)}`, severity: 'warning', since: '2026-09-29T14:00:00.000Z', metrics: {} }));
    const lines = digestTask(many, '2026-09-29', null).description.split('\n');
    expect(lines.filter((line) => line.startsWith('- warning'))).toHaveLength(REPORT_MAX_ITEMS);
    expect(lines.at(-1)).toBe('- … 另有 3 项');
  });

  it('records the first day of the release as handled, then claims a later day at its first tick with items', () => {
    const first = claimDay({ ...NO_DIGEST }, listed(), NOW, URL_, REQUEST_ID);
    expect(first).toMatchObject({ day: '2026-09-29', state: 'skipped', request: null });
    expect(claimDay(first, listed(), NOW + 3_600_000, URL_, REQUEST_ID)).toBe(first);
    const tomorrow = NOW + 86_400_000;
    expect(claimDay(first, [], tomorrow, URL_, REQUEST_ID)).toBe(first);
    const claimed = claimDay(first, listed(), tomorrow, URL_, REQUEST_ID);
    expect(claimed).toMatchObject({ day: '2026-09-30', state: 'pending', attempts: 0, item_count: 2, claimed_at: tomorrow });
    expect(claimed.request).toMatchObject({ request_id: REQUEST_ID, title: '运维摘要 2026-09-30：2 项需要关注' });
    // The day is claimed once: a later tick of it keeps the frozen request.
    expect(claimDay(claimed, [], tomorrow + 60_000, URL_, 'another')).toBe(claimed);
  });

  it('is created once, with Home\'s own receipt', () => {
    const claimed = claimDay(yesterday, listed(), NOW, URL_, REQUEST_ID);
    const created = afterCall(claimed, { ok: true, taskId: 'task-1' }, NOW + 1000);
    expect(created).toMatchObject({ state: 'created', request: null, attempts: 1, task_id: 'task-1', last_sent_at: NOW + 1000, last_generated_at: NOW, last_error: null });
    expect(created.last_receipt).toEqual({ stored: true, generated_at: '2026-09-29T14:00:00.000Z', item_count: 2 });
    expect(nextDigestDay(created)).toBe(Date.parse('2026-09-30T00:00:00Z'));
    expect(nextDigestDay(NO_DIGEST)).toBeNull();
  });

  it(`retries the same request ${String(DIGEST_TASK_ATTEMPTS)} times, then fails the day with digest_task_failed`, () => {
    let doc = claimDay(yesterday, listed(), NOW, URL_, REQUEST_ID);
    for (let attempt = 1; attempt < DIGEST_TASK_ATTEMPTS; attempt++) {
      doc = afterCall(doc, { ok: false, code: 'unavailable' }, NOW + attempt);
      expect(doc).toMatchObject({ state: 'pending', attempts: attempt, last_error: 'unavailable' });
      expect(doc.request?.request_id).toBe(REQUEST_ID);
    }
    expect(candidates(input({ digest: doc })).map((c) => c.code)).not.toContain('digest_task_failed');
    doc = afterCall(doc, { ok: false, code: 'busy' }, NOW + DIGEST_TASK_ATTEMPTS);
    expect(doc).toMatchObject({ state: 'failed', request: null, attempts: DIGEST_TASK_ATTEMPTS, last_error: 'busy' });
    expect(candidates(input({ digest: doc })).find((c) => c.code === 'digest_task_failed')).toEqual({
      source: 'dashboard',
      code: 'digest_task_failed',
      severity: 'warning',
      metrics: { attempts: DIGEST_TASK_ATTEMPTS },
      since: new Date(NOW + DIGEST_TASK_ATTEMPTS).toISOString(),
    });
    // The next day's claim ends it.
    expect(candidates(input({ now: NOW + 86_400_000, digest: doc })).map((c) => c.code)).not.toContain('digest_task_failed');
  });

  it('fails at once on invalid input', () => {
    const doc = afterCall(claimDay(yesterday, listed(), NOW, URL_, REQUEST_ID), { ok: false, code: 'invalid_input' }, NOW);
    expect(doc).toMatchObject({ state: 'failed', attempts: 1 });
  });
});
