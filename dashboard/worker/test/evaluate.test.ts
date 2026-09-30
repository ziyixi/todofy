import { describe, expect, it } from 'vitest';
import unavailable from '../../../contracts/ops-v1/fixtures/OpsStatus/status-unavailable.json';
import type { OpsReportItem, OpsStatus } from '../../../contracts/ops-v1/ops-v1.ts';
import type { EntryDef, FlowState, Registry } from '../src/api-v2-types.ts';
import { mergeScripts } from '../src/discovery.ts';
import { attentionView, entryState, flowStates, flowSummaries, holdCodes, rollup, targetOf, type AttentionInput, type EvalInput } from '../src/evaluate.ts';
import { REGISTRY, entryById } from '../src/registry.ts';
import { DAY, HOUR, LINK_ONLY_ENTRY, MIN, NOW, failedStatus, fortnight, input, probe, run, scripts, signal, status, withLinkOnly } from './v2-fixtures.ts';

function entry(id: string, registry: Registry = REGISTRY): EntryDef {
  const found = entryById(id, registry);
  if (found === undefined) throw new Error(id);
  return found;
}

function state(id: string, patch: Partial<EvalInput> = {}) {
  return entryState(entry(id), input(patch));
}

function flow(id: string, patch: Partial<EvalInput> = {}): Omit<FlowState, 'canary'> {
  const found = flowStates(input(patch)).find((f) => f.id === id);
  if (found === undefined) throw new Error(id);
  return found;
}

function stage(f: Omit<FlowState, 'canary'>, id: string) {
  const found = f.stages.find((s) => s.id === id);
  if (found === undefined) throw new Error(id);
  return found;
}

const withSignals = (app: 'mail-hero' | 'todofy', signals: OpsStatus['signals'], health: OpsStatus['health'] = 'degraded') =>
  status(app, { health, signals });

describe('levels', () => {
  it('roll up worst first: critical > unknown > warning > held > ok; link and unmonitored never count', () => {
    expect(rollup(['ok', 'held', 'warning'])).toBe('warning');
    expect(rollup(['warning', 'unknown'])).toBe('unknown');
    expect(rollup(['unknown', 'critical', 'ok'])).toBe('critical');
    expect(rollup(['held', 'ok'])).toBe('held');
    expect(rollup(['link', 'unmonitored'])).toBeNull();
  });
});

describe('entry health (the tile: the entry\'s own health, Q2)', () => {
  it('shows the mockup day: apps ok with their counter, link-only hosts, the site\'s latency, Notion\'s last hour', () => {
    const tiles = Object.fromEntries(withLinkOnly().entries.map((e) => [e.id, entryState(e, input())]));
    expect(tiles['mail-hero']).toMatchObject({ level: 'ok', reason: null, metric: { kind: 'counter', name: 'ingest_today_messages', value: 41 }, top_signals: [] });
    expect(tiles.todofy).toMatchObject({ level: 'ok', metric: { kind: 'counter', name: 'received_24h', value: 63 } });
    expect(tiles[LINK_ONLY_ENTRY.id]).toMatchObject({ level: 'link', reason: null, metric: null, checked_at: null });
    expect(tiles.website).toMatchObject({ level: 'ok', metric: { kind: 'latency', ms: 180 } });
    expect(tiles['notion-publish']).toMatchObject({ level: 'ok', metric: { kind: 'last_active', hour: '2026-09-29T06:00:00.000Z' } });
    expect(tiles.newsletter).toMatchObject({ level: 'unmonitored', reason: null, metric: null });
    expect(tiles.home).toMatchObject({ level: 'ok' });
  });

  it('never shows a made-up ok for an ops-v1 app it cannot see', () => {
    expect(state('mail-hero', { statuses: {} })).toMatchObject({ level: 'unknown', reason: 'never_checked', metric: null });
    const ok = status('mail-hero');
    expect(state('mail-hero', { statuses: { 'mail-hero': failedStatus(ok, 1) } })).toMatchObject({ level: 'warning', reason: 'unreachable', consecutive_failures: 1 });
    expect(state('mail-hero', { statuses: { 'mail-hero': failedStatus(ok, 2) } })).toMatchObject({ level: 'critical', reason: 'unreachable' });
    // Never read successfully and the first poll failed: unknown, but the reason is the failure, not "stale".
    const neverRead = { checked_at: NOW - 2 * MIN, ok: false, error: 'unavailable', consecutive_failures: 1, status: null, status_at: null } as const;
    expect(state('todofy', { statuses: { todofy: neverRead } })).toMatchObject({ level: 'unknown', reason: 'unreachable', consecutive_failures: 1 });
    expect(state('todofy', { statuses: { todofy: { ...neverRead, consecutive_failures: 2 } } })).toMatchObject({ level: 'critical', reason: 'unreachable' });
    // A status older than two and a half ticks says nothing any more.
    expect(state('mail-hero', { statuses: { 'mail-hero': status('mail-hero', {}, NOW - 2 * HOUR) } })).toMatchObject({ level: 'unknown', reason: 'stale' });
    const down = { ...status('todofy'), status: unavailable as OpsStatus };
    expect(state('todofy', { statuses: { todofy: down } })).toMatchObject({ level: 'critical', reason: 'status_unavailable' });
  });

  it('takes the worst signal, shows holds as 已暂停 and keeps maintenance critical', () => {
    const gemini = withSignals('todofy', [signal('gemini_budget_80', 'warning', { percent: 82 }, '2026-09-29T11:20:00Z')]);
    expect(state('todofy', { statuses: { todofy: gemini } })).toMatchObject({
      level: 'warning',
      reason: 'gemini_budget_80',
      top_signals: [{ code: 'gemini_budget_80', severity: 'warning', since: '2026-09-29T11:20:00Z' }],
    });
    const paused = withSignals('todofy', [signal('processing_paused', 'warning')]);
    expect(state('todofy', { statuses: { todofy: paused } })).toMatchObject({ level: 'held', reason: 'processing_paused' });
    const both = withSignals('todofy', [signal('processing_paused', 'warning'), signal('todoist_blocked', 'critical')]);
    expect(state('todofy', { statuses: { todofy: both } })).toMatchObject({ level: 'critical', reason: 'todoist_blocked' });
    const maintenance = withSignals('mail-hero', [signal('maintenance_mode', 'critical')]);
    expect(state('mail-hero', { statuses: { 'mail-hero': maintenance } })).toMatchObject({ level: 'critical', reason: 'maintenance_mode' });
    // Info signals are not shown as problems, except holds.
    const info = withSignals('mail-hero', [signal('backup_active', 'info'), signal('forwarding_off', 'info')], 'ok');
    const tile = state('mail-hero', { statuses: { 'mail-hero': info } });
    expect(tile).toMatchObject({ level: 'held', reason: 'forwarding_off' });
    expect(tile.top_signals.map((s) => s.code)).toEqual(['forwarding_off']);
    // Degraded without a signal to explain it.
    expect(state('mail-hero', { statuses: { 'mail-hero': withSignals('mail-hero', []) } })).toMatchObject({ level: 'warning', reason: 'app_degraded' });
  });

  it('judges the website probe: 1 failure warning, 2 critical, stale unknown, disabled 未接入', () => {
    expect(state('website', { probes: {} })).toMatchObject({ level: 'unknown', reason: 'never_checked', metric: null });
    expect(state('website', { probes: { website: probe({ ok: false, http_status: 503, error: 'http_status', consecutive_failures: 1 }) } })).toMatchObject({
      level: 'warning',
      reason: 'http_status',
      metric: null,
    });
    expect(state('website', { probes: { website: probe({ ok: false, http_status: null, latency_ms: null, error: 'timeout', consecutive_failures: 2 }) } })).toMatchObject({
      level: 'critical',
      reason: 'timeout',
    });
    expect(state('website', { probes: { website: probe({ checked_at: NOW - 2 * HOUR }) } })).toMatchObject({ level: 'unknown', reason: 'stale' });
    const off: Registry = {
      ...REGISTRY,
      entries: REGISTRY.entries.map((e) => (e.id === 'website' ? { ...e, status: { type: 'public_http', url: 'https://www.ziyixi.science/build-info.json', expect: [200], enabled: false } } : e)),
    };
    expect(entryState(entry('website', off), input(), off)).toMatchObject({ level: 'unmonitored', reason: null });
  });

  it('judges Notion 发布 by its Worker analytics: idle after 26 h, unknown until discovery watched long enough', () => {
    // Last request in the 06 hour today; 26 h after 07:00 it is idle.
    const later = NOW + DAY;
    const idleScripts = mergeScripts(scripts(), [], false, later);
    expect(entryState(entry('notion-publish'), input({ now: later, lastTickAt: later, scripts: idleScripts }))).toMatchObject({ level: 'warning', reason: 'idle' });
    expect(state('notion-publish', { scripts: null })).toMatchObject({ level: 'unknown', reason: 'never_checked' });
    expect(state('notion-publish', { analyticsConfigured: false })).toMatchObject({ level: 'unknown', reason: 'never_checked' });
    // The GraphQL answer is 2 hours old: nothing to say.
    expect(state('notion-publish', { now: NOW + 2 * HOUR, lastTickAt: NOW + 2 * HOUR })).toMatchObject({ level: 'unknown', reason: 'stale' });
    // Never seen: unknown for the first 26 h of discovery, idle after.
    const fresh = mergeScripts(null, [], false, NOW);
    expect(state('notion-publish', { scripts: fresh })).toMatchObject({ level: 'unknown', reason: 'never_seen' });
    expect(state('notion-publish', { scripts: { ...fresh, since: NOW - 27 * HOUR } })).toMatchObject({ level: 'warning', reason: 'idle' });
    // Enough requests with errors: the error rule.
    const failing = mergeScripts(null, [{ script: 'ziyixi-notion-publish', requests: 40, errors: 10, subrequests: 0, cpu_p50_us: 1, cpu_p99_us: 2, do_requests: null, do_errors: null }], false, NOW);
    expect(state('notion-publish', { scripts: failing })).toMatchObject({ level: 'critical', reason: 'error_rate' });
  });

  it('judges this dashboard by its own ticks', () => {
    expect(state('home', { lastTickAt: null })).toMatchObject({ level: 'unknown', reason: 'never_checked' });
    expect(state('home', { lastTickAt: NOW - 80 * MIN })).toMatchObject({ level: 'critical', reason: 'tick_stale' });
  });
});

describe('flows (stage chains)', () => {
  it('shows the mockup: one warning stage in 邮件 → 任务, the canary verifying delivery and the digest only', () => {
    const todofy = withSignals('todofy', [signal('gemini_budget_80', 'warning', { percent: 82 }, '2026-09-29T11:20:00Z')]);
    const mail = flow('mail-to-task', { statuses: { 'mail-hero': status('mail-hero'), todofy }, canaryRecent: fortnight(run('2026-09-29', 'ok', null, null, 9)) });
    expect(mail).toMatchObject({ level: 'warning', partial: false, coverage: { monitored: 5, total: 6 }, first_issue: { stage: 'consume', code: 'gemini_budget_80' } });
    expect(mail.stages.map((s) => [s.id, s.level, s.canary])).toEqual([
      ['forward', 'unmonitored', null],
      ['ingest', 'ok', null],
      ['parse', 'ok', null],
      ['deliver', 'ok', 'verified'],
      ['consume', 'warning', 'verified'],
      ['tasks', 'ok', null],
    ]);
    expect(stage(mail, 'ingest').counters).toEqual([
      { name: 'ingest_today_messages', value: 41 },
      { name: 'capacity_used_bytes', value: 1288490188 },
    ]);
    expect(stage(mail, 'ingest').analytics).toMatchObject({ requests: 268, errors: 0, error_percent: 0 });
    expect(stage(mail, 'consume')).toMatchObject({
      reason: 'gemini_budget_80',
      signals: [{ code: 'gemini_budget_80', severity: 'warning', since: '2026-09-29T11:20:00Z', metrics: { percent: 82 } }],
      analytics: { requests: 310, errors: 2 },
    });
    expect(mail.freshness).toEqual({ kind: 'canary', at: '2026-09-29T09:06:00.000Z', ok_runs: 13, runs: 14 });
  });

  it('marks the other flows as the mockup does: 网站发布 2/3, Newsletter partial, 运维摘要 by the digest', () => {
    const flows = Object.fromEntries(flowStates(input()).map((f) => [f.id, f]));
    expect(flows['site-publish']).toMatchObject({ level: 'ok', partial: false, coverage: { monitored: 2, total: 3 }, freshness: { kind: 'activity', at: '2026-09-29T06:00:00.000Z' } });
    expect(stage(flows['site-publish'] as FlowState, 'serve').probe).toEqual({ checked_at: new Date(NOW - MIN).toISOString(), ok: true, http_status: 200, latency_ms: 180 });
    // 1 of 3 stages monitored: 部分接入, whatever the level.
    expect(flows['daily-newsletter']).toMatchObject({ level: 'ok', partial: true, coverage: { monitored: 1, total: 3 }, freshness: { kind: 'none' } });
    expect(flows['ops-digest']).toMatchObject({ level: 'ok', freshness: { kind: 'digest', at: '2026-09-29T07:00:00.000Z', accepted: true } });
    expect(flowSummaries(input()).map((f) => f.id)).toEqual(['mail-to-task', 'gtd', 'site-publish', 'daily-newsletter', 'ops-digest']);
  });

  it('maps the GTD loop onto Todofy counters; a late review is shown but is not a fault', () => {
    const gtd = flow('gtd');
    expect(gtd.coverage).toEqual({ monitored: 4, total: 5 });
    expect(stage(gtd, 'clarify').counters).toEqual([
      { name: 'inbox_open', value: 23 },
      { name: 'inbox_oldest_days', value: 41 },
    ]);
    expect(stage(gtd, 'reflect').counters.map((c) => c.name)).toEqual(['review_age_days', 'completed_7d']);
    expect(stage(gtd, 'engage').level).toBe('unmonitored'); // FlowDay is a link only
    const overdue = withSignals('todofy', [signal('review_overdue', 'info')], 'ok');
    const late = flow('gtd', { statuses: { 'mail-hero': status('mail-hero'), todofy: overdue } });
    expect(stage(late, 'reflect').level).toBe('ok');
    expect(stage(late, 'reflect').signals.map((s) => s.code)).toEqual(['review_overdue']);
    const stale = withSignals('todofy', [signal('gtd_snapshot_stale', 'warning')]);
    expect(stage(flow('gtd', { statuses: { 'mail-hero': status('mail-hero'), todofy: stale } }), 'reflect')).toMatchObject({
      level: 'warning',
      reason: 'gtd_snapshot_stale',
    });
  });

  it('shows a hold as 已暂停 on its stage, never as a fault', () => {
    const paused = withSignals('mail-hero', [signal('force_send_paused', 'warning')]);
    const mail = flow('mail-to-task', { statuses: { 'mail-hero': paused, todofy: status('todofy') } });
    expect(stage(mail, 'deliver')).toMatchObject({ level: 'held', held: true, reason: 'force_send_paused' });
    expect(stage(mail, 'ingest')).toMatchObject({ level: 'ok', held: false });
    expect(mail.level).toBe('held');
    // Maintenance is claimed by the first stage of the app and stays critical.
    const maintenance = withSignals('mail-hero', [signal('maintenance_mode', 'critical')], 'down');
    const down = flow('mail-to-task', { statuses: { 'mail-hero': maintenance, todofy: status('todofy') } });
    expect(stage(down, 'ingest')).toMatchObject({ level: 'critical', reason: 'maintenance_mode' });
    // Later stages of the app see the app down through its health.
    expect(stage(down, 'parse')).toMatchObject({ level: 'critical', reason: 'maintenance_mode' });
  });

  it('marks a failed canary stage critical and leaves the later stage unverified; a skip is 已暂停, an old run 未验证', () => {
    const today = '2026-09-29';
    const at = (outcome: 'ok' | 'failed' | 'skipped', stageId: 'start' | 'delivery' | 'consumer', code: string) => fortnight(run(today, outcome, stageId, code, 9));
    const delivery = flow('mail-to-task', { canaryRecent: at('failed', 'delivery', 'http_503') });
    expect(stage(delivery, 'deliver')).toMatchObject({ level: 'critical', reason: 'canary_failed', canary: 'failed' });
    expect(stage(delivery, 'consume')).toMatchObject({ level: 'ok', canary: 'unverified' });
    const consumer = flow('mail-to-task', { canaryRecent: at('failed', 'consumer', 'llm_quota') });
    expect([stage(consumer, 'deliver').canary, stage(consumer, 'consume').canary, stage(consumer, 'consume').level]).toEqual(['verified', 'failed', 'critical']);
    const start = flow('mail-to-task', { canaryRecent: at('failed', 'start', 'unreachable') });
    expect(stage(start, 'deliver').canary).toBe('failed');
    const skipped = flow('mail-to-task', { canaryRecent: at('skipped', 'start', 'send_paused') });
    expect([stage(skipped, 'deliver').canary, stage(skipped, 'deliver').level]).toEqual(['held', 'ok']);
    // The latest run finished 2026-09-28T16:06; 31 h later it no longer verifies anything.
    const old = flow('mail-to-task', { now: Date.parse('2026-09-29T23:30:00Z'), lastTickAt: Date.parse('2026-09-29T23:30:00Z') });
    expect(stage(old, 'deliver').canary).toBe('unverified');
    expect(flow('mail-to-task', { canaryRecent: [] }).freshness).toEqual({ kind: 'canary', at: null, ok_runs: 0, runs: 0 });
  });

  it('lists a signal code no stage places as 未归类的信号 once, on the first flow of its app', () => {
    const future = withSignals('todofy', [signal('future_signal', 'warning')]);
    const flows = flowStates(input({ statuses: { 'mail-hero': status('mail-hero'), todofy: future } }));
    expect(flows.find((f) => f.id === 'mail-to-task')?.unclassified).toEqual([{ entry: 'todofy', code: 'future_signal', severity: 'warning' }]);
    for (const other of flows.filter((f) => f.id !== 'mail-to-task')) expect(other.unclassified).toEqual([]);
    // A code another flow places is not unclassified anywhere.
    const reminder = withSignals('todofy', [signal('reminder_failed', 'warning')]);
    expect(flowStates(input({ statuses: { todofy: reminder } })).flatMap((f) => f.unclassified)).toEqual([]);
  });

  it('names the worst stage as the first issue, not an earlier lesser one', () => {
    const mailHero = withSignals('mail-hero', [signal('capacity_70', 'warning', { percent: 72 }), signal('endpoint_blocked', 'critical')]);
    const mail = flow('mail-to-task', { statuses: { 'mail-hero': mailHero, todofy: status('todofy') } });
    expect(stage(mail, 'ingest').level).toBe('warning');
    expect(stage(mail, 'deliver').level).toBe('critical');
    expect(mail).toMatchObject({ level: 'critical', first_issue: { stage: 'deliver', code: 'endpoint_blocked' } });
  });

  it('shows unmonitored stages as 未接入 and an unreachable app on every one of its stages', () => {
    const unreachable = failedStatus(status('todofy'), 2);
    const f = flow('daily-newsletter', { statuses: { 'mail-hero': status('mail-hero'), todofy: unreachable } });
    expect(f.stages.map((s) => s.level)).toEqual(['critical', 'unmonitored', 'unmonitored']);
    expect(f).toMatchObject({ level: 'critical', partial: true, first_issue: { stage: 'report', code: 'unreachable' } });
  });
});

describe('the attention strip', () => {
  const base = (patch: Partial<AttentionInput> = {}): AttentionInput => ({
    now: NOW,
    neverRan: false,
    items: [],
    canaryEnabled: true,
    desired: { level: 'normal', reason: 'quota_normal', until: null, source: 'auto' },
    statuses: { 'mail-hero': status('mail-hero'), todofy: status('todofy') },
    ...patch,
  });
  const item = (source: string, code: string, severity: OpsReportItem['severity'] = 'warning'): OpsReportItem => ({ source, code, severity, since: '2026-09-29T11:20:00.000Z', metrics: {} });

  it('targets each item at the flow stage that claims it, else its entry or view', () => {
    expect(targetOf('todofy', 'gemini_budget_80')).toEqual({ view: 'flows', flow: 'mail-to-task', stage: 'consume', entry: 'todofy' });
    expect(targetOf('todofy', 'reminder_failed')).toEqual({ view: 'flows', flow: 'mail-to-task', stage: 'tasks', entry: 'todofy' });
    expect(targetOf('mail-hero', 'backup_stale')).toEqual({ view: 'ops', entry: 'mail-hero' });
    expect(targetOf('mail-hero', 'app_unreachable')).toEqual({ view: 'home', entry: 'mail-hero' });
    expect(targetOf('todofy', 'guard_apply_failed')).toEqual({ view: 'ops', entry: 'todofy' });
    expect(targetOf('cloudflare', 'd1_rows_read_high')).toEqual({ view: 'cloudflare' });
    expect(targetOf('dashboard', 'usage_unavailable')).toEqual({ view: 'cloudflare' });
    expect(targetOf('dashboard', 'tick_stale')).toEqual({ view: 'flows', flow: 'ops-digest', stage: 'collect' });
    expect(targetOf('dashboard', 'canary_not_delivered')).toEqual({ view: 'flows', flow: 'mail-to-task', stage: 'deliver' });
    expect(targetOf('dashboard', 'canary_consumer_failed')).toEqual({ view: 'flows', flow: 'mail-to-task', stage: 'consume' });
    expect(targetOf('dashboard', 'canary_skipped')).toEqual({ view: 'flows', flow: 'mail-to-task' });
    expect(targetOf('dashboard', 'guard_shed')).toEqual({ view: 'ops' });
  });

  it('keeps the item set, counts badges per view, and is unknown before anything ran', () => {
    const items = [item('todofy', 'gemini_budget_80'), item('cloudflare', 'd1_rows_read_high', 'critical'), item('dashboard', 'tick_stale')];
    const { attention, badges } = attentionView(base({ items }));
    expect(attention.level).toBe('critical');
    // Worst first (stable within a level).
    expect(attention.items.map((i) => i.code)).toEqual(['d1_rows_read_high', 'gemini_budget_80', 'tick_stale']);
    expect(badges).toEqual({ home: 0, flows: 2, cloudflare: 1, ops: 0 });
    expect(attention.info).toEqual([]);
    expect(attentionView(base({ neverRan: true })).attention).toEqual({ level: 'unknown', items: [], info: [], held: [] });
    expect(attentionView(base()).attention.level).toBe('ok');
  });

  it('shows switches that hold work as 已暂停, outside the level and the badges; maintenance stays an alarm', () => {
    const paused = withSignals('todofy', [signal('processing_paused', 'warning'), signal('maintenance_mode', 'critical')]);
    const { attention, badges } = attentionView(
      base({ statuses: { 'mail-hero': withSignals('mail-hero', [signal('forwarding_off', 'info')], 'ok'), todofy: paused }, items: [item('todofy', 'processing_paused'), item('todofy', 'maintenance_mode', 'critical')] }),
    );
    expect(attention.items.map((i) => i.code)).toEqual(['maintenance_mode']);
    expect(attention.held).toEqual([
      { entry: 'mail-hero', code: 'forwarding_off', target: { view: 'flows', flow: 'mail-to-task', stage: 'deliver', entry: 'mail-hero' } },
      { entry: 'todofy', code: 'processing_paused', target: { view: 'flows', flow: 'mail-to-task', stage: 'consume', entry: 'todofy' } },
    ]);
    expect(badges.flows).toBe(1);
    expect(holdCodes('todofy')).toEqual(new Set(['processing_paused', 'todoist_paused', 'reminder_disabled']));
  });

  it('never says 全部正常 while a tile or a flow is worse: a failing site probe becomes one observed item (F1)', () => {
    const failing = probe({ ok: false, http_status: 503, error: 'http_status', consecutive_failures: 1 });
    const evaluation = input({ probes: { website: failing } });
    const { attention, badges } = attentionView(base({ evaluation }));
    expect(attention.level).toBe('warning');
    // One item for the cause: the 网站发布 stage on the same entry and code is not repeated.
    expect(attention.items).toEqual([
      { source: 'website', code: 'http_status', severity: 'warning', since: null, metrics: {}, target: { view: 'home', entry: 'website' }, observed: 'warning' },
    ]);
    expect(badges).toEqual({ home: 1, flows: 0, cloudflare: 0, ops: 0 });
    // The healthy mockup day stays quiet.
    const quiet = attentionView(base({ evaluation: input() }));
    expect(quiet.attention).toMatchObject({ level: 'ok', items: [] });
    // Before anything ran the strip says so, whatever the (never checked) tiles are.
    expect(attentionView(base({ neverRan: true, evaluation: input({ statuses: {}, probes: {}, scripts: null }) })).attention.items).toEqual([]);
  });

  it('shows an app that failed once as ◆ 未知 above the warnings, and counts it in the badges (F1)', () => {
    const down = failedStatus(status('todofy', {}, NOW - 2 * HOUR), 1);
    const evaluation = input({ statuses: { 'mail-hero': status('mail-hero'), todofy: down } });
    const gemini = item('mail-hero', 'backup_stale');
    const { attention, badges } = attentionView(base({ items: [gemini], statuses: evaluation.statuses, evaluation }));
    expect(attention.level).toBe('unknown');
    // Worst first: the unknown tile, then the digest warning. Todofy's stages (same cause) are not repeated.
    expect(attention.items.map((i) => [i.source, i.code, i.observed ?? i.severity])).toEqual([
      ['todofy', 'unreachable', 'unknown'],
      ['mail-hero', 'backup_stale', 'warning'],
    ]);
    expect(attention.items[0]?.target).toEqual({ view: 'home', entry: 'todofy' });
    expect(badges).toEqual({ home: 1, flows: 0, cloudflare: 0, ops: 1 });
    // Two failures: the digest's app_unreachable explains it; no observed duplicate.
    const twice = input({ statuses: { 'mail-hero': status('mail-hero'), todofy: failedStatus(status('todofy'), 2) } });
    const digest = item('todofy', 'app_unreachable', 'critical');
    const critical = attentionView(base({ items: [digest], statuses: twice.statuses, evaluation: twice })).attention;
    expect(critical.level).toBe('critical');
    expect(critical.items.map((i) => i.code)).toEqual(['app_unreachable']);
  });

  it('adds a stage\'s own error rate and an unregistered Worker\'s error rate, each once (F1)', () => {
    const failing = mergeScripts(
      scripts(),
      [
        { script: 'mail-hero', requests: 100, errors: 30, subrequests: 0, cpu_p50_us: 1, cpu_p99_us: 2, do_requests: null, do_errors: null },
        { script: 'stray-worker', requests: 50, errors: 5, subrequests: 0, cpu_p50_us: 1, cpu_p99_us: 2, do_requests: null, do_errors: null },
      ],
      false,
      NOW,
    );
    const { attention, badges } = attentionView(base({ evaluation: input({ scripts: failing }) }));
    const rows = attention.items.map((i) => [i.source, i.code, i.observed, i.target]);
    expect(rows).toContainEqual(['cloudflare', 'error_rate', 'warning', { view: 'cloudflare', script: 'stray-worker' }]);
    const mailHero = rows.filter((row) => row[0] === 'mail-hero');
    expect(mailHero).toHaveLength(1);
    expect(mailHero[0]?.[1]).toBe('error_rate');
    expect(mailHero[0]?.[2]).toBe('critical');
    expect(attention.level).toBe('critical');
    expect(badges.cloudflare).toBe(1);
  });

  it('shows the owner\'s forced shed as a hold, an automatic shed as an alarm, and the canary switch as info', () => {
    const shed = [item('dashboard', 'guard_shed')];
    const owner = attentionView(base({ items: shed, desired: { level: 'shed', reason: 'owner_shed', until: NOW + DAY, source: 'owner' } })).attention;
    expect(owner.items).toEqual([]);
    expect(owner.held).toEqual([{ entry: 'home', code: 'owner_shed', target: { view: 'ops' } }]);
    const auto = attentionView(base({ items: shed, desired: { level: 'shed', reason: 'quota_d1_rows_read', until: NOW + DAY, source: 'auto' } })).attention;
    expect(auto.items.map((i) => i.code)).toEqual(['guard_shed']);
    const off = attentionView(base({ canaryEnabled: false })).attention;
    expect(off.info).toEqual([{ source: 'dashboard', code: 'canary_disabled', severity: 'info', since: null, metrics: {}, target: { view: 'flows', flow: 'mail-to-task' } }]);
    expect(off.level).toBe('ok');
  });
});
