import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/fleet-report-v1/fixtures/healthy.json';
import { statusSnapshot } from '../src/health.ts';
import { freshness, parseReport, reportCodes } from '../src/report.ts';

const NOW = Date.parse('2026-10-03T00:00:00Z');
const read = (value: unknown = fixture) => parseReport(JSON.stringify(value), 'vps', '1', NOW);

const historicalUnknown = () => {
  const report = structuredClone(fixture);
  const item = report.runtime.workloads[0];
  if (!item) throw new Error('missing fixture workload');
  item.health_state = 'degraded';
  item.unknown_count = 32;
  report.newsletter.unknown_count = 32;
  return { report, item };
};

const newsletterStatus = (report: unknown) => statusSnapshot('newsletter', read(report), NOW, NOW, 'fleet.example.test');

describe('metadata report boundary', () => {
  it('accepts a synthetic typed report and three expected daemons', () => {
    expect(read().sequence).toBe(1);
    expect(reportCodes(read())).toEqual([]);
  });
  it.each(['unexpected', 'logs', 'email'])('refuses extra content field %s', (key) => {
    expect(() => read({ ...fixture, [key]: 'not permitted' })).toThrow('invalid_report');
  });
  it('refuses unknown daemon aliases and a missing expected daemon', () => {
    const unexpected = { ...fixture, daemons: { ...fixture.daemons, injected: { state: 'active' } } };
    expect(() => read(unexpected)).toThrow('invalid_report');
    expect(() => read({ ...fixture, daemons: { k3s: { state: 'active' } } })).toThrow('invalid_report');
  });
  it('preserves the legacy shape while monitoring only configured daemons', () => {
    const configured = { k3s: { state: 'active' }, ssh: { state: 'active' }, cloudflared_platform: { state: 'active' } };
    const fresh = { ...fixture, daemons: { ...configured, cloudflared: { state: 'unknown' } }, configured_daemons: configured };
    expect(reportCodes(read(fresh))).toEqual([]);
    expect(reportCodes(read({ ...fresh, daemons: { ...fresh.daemons, ssh: { state: 'failed' } },
      configured_daemons: { ...configured, ssh: { state: 'failed' } } }))).toContain('daemon_ssh_failed');
    expect(reportCodes(read({ ...fixture, daemons: { ...fixture.daemons, cloudflared: { state: 'failed' } } }))).toContain('daemon_cloudflared_failed');
  });
  it('refuses empty, incomplete, unknown or inconsistent configured daemon maps', () => {
    for (const configured of [{}, { k3s: { state: 'active' } },
      { k3s: { state: 'active' }, ssh: { state: 'failed' } },
      { k3s: { state: 'active' }, ssh: { state: 'active' }, injected: { state: 'active' } }]) {
      expect(() => read({ ...fixture, configured_daemons: configured })).toThrow('invalid_report');
    }
  });
  it.each([{ host_key: 'another' }, { epoch: 2 }])('requires configured identity %j', (change) => {
    expect(() => read({ ...fixture, ...change })).toThrow('wrong_host');
  });
  it('refuses clock skew and old host observations', () => {
    expect(() => read({ ...fixture, observation_time: '2026-10-02T23:49:59Z' })).toThrow('report_clock');
    expect(() => read({ ...fixture, observation_time: '2026-10-03T00:02:01Z' })).toThrow('report_clock');
  });
  it('ages server receipt time without an alarm', () => {
    expect(freshness(null, NOW)).toBe('never_seen');
    expect(freshness(NOW, NOW + 600_000)).toBe('fresh');
    expect(freshness(NOW, NOW + 600_001)).toBe('stale');
    expect(freshness(NOW, NOW + 1_200_001)).toBe('missing');
  });
  it('reports drain separately from process health', () => {
    const report = read({ ...fixture, newsletter: { ...fixture.newsletter, drain_state: 'frozen', unknown_count: 2 } });
    expect(reportCodes(report)).toEqual(['newsletter_paused', 'newsletter_unknown']);
  });
  it('never equates declared release identity with independently verified actual identity', () => {
    const report = structuredClone(fixture);
    const item = report.runtime.workloads[0];
    if (!item) throw new Error('missing fixture workload');
    item.release.actual.source_sha = '2'.repeat(40);
    expect(reportCodes(read(report))).toContain('deployment_pending');
  });
  it('rejects an old runtime daemon observation inside a current host report', () => {
    const report = { ...fixture, runtime: { ...fixture.runtime, observed_at: '2026-10-02T23:58:59Z' } };
    expect(() => read(report)).toThrow('invalid_report');
  });
  it('keeps missing runtime evidence as unknown', () => {
    expect(reportCodes(read({ ...fixture, runtime: null }))).toContain('deployment_pending');
  });
  it('reports an explicitly held release even when the old process remains healthy', () => {
    const report = {
      ...fixture,
      runtime: {
        ...fixture.runtime,
        current_release: {
          name: 'releases/cfdd9a7b-3d46-4d2b-8983-6e99fb005a5a',
          request_id: 'cfdd9a7b-3d46-4d2b-8983-6e99fb005a5a',
          phase: 'held',
          etag: 'v1',
          update_time: '2026-10-03T00:00:00Z',
          error_code: 'RECONCILIATION_REQUIRED',
        },
      },
    };
    expect(reportCodes(read(report))).toContain('release_held');
  });
  it('rejects duplicate runtime workload aliases', () => {
    const report = { ...fixture, runtime: { ...fixture.runtime, workloads: [...fixture.runtime.workloads, ...fixture.runtime.workloads] } };
    expect(() => read(report)).toThrow('invalid_report');
  });
});

describe('Newsletter process and release projection', () => {
  it('keeps historical unknown results as attention without a process fault or pending release', () => {
    const { report } = historicalUnknown();
    expect(newsletterStatus(report)).toMatchObject({
      health: 'degraded',
      signals: [{ code: 'newsletter_unknown', severity: 'warning', metrics: { unknown_count: 32 } }],
      counters: { unknown_count: 32 },
    });
    expect(reportCodes(read(report))).toEqual(['newsletter_unknown']);
    expect(statusSnapshot('fleet', read(report), NOW, NOW, 'fleet.example.test')).toMatchObject({ health: 'ok', signals: [] });
  });
  it('keeps an attention fingerprint stable as the heartbeat ages and changes it when the unknown count changes', () => {
    const { report, item } = historicalUnknown();
    const before = newsletterStatus(report);
    const later = statusSnapshot('newsletter', read(report), NOW, NOW + 60_000, 'fleet.example.test');
    expect(later.signals).toEqual(before.signals);
    expect(later.counters.heartbeat_age_seconds).not.toBe(before.counters.heartbeat_age_seconds);
    report.newsletter.unknown_count = 33;
    item.unknown_count = 33;
    const changed = newsletterStatus(report);
    expect(changed.signals).toEqual([{ code: 'newsletter_unknown', severity: 'warning', metrics: { unknown_count: 33 } }]);
    expect(changed.counters.unknown_count).toBe(33);
  });
  it.each(['unknown', 'unhealthy', 'unsupported'] as const)('keeps %s runtime health unavailable despite unknown results', (health) => {
    const { report, item } = historicalUnknown();
    item.health_state = health;
    expect(newsletterStatus(report).signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
  });
  it.each([0, undefined])('requires positive runtime unknown evidence, not just the separate process report: %s', (count) => {
    const { report, item } = historicalUnknown();
    Object.assign(item, { unknown_count: count });
    const signals = newsletterStatus(report).signals;
    expect(signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
    expect(signals).toContainEqual({ code: 'deployment_pending', severity: 'warning', metrics: {} });
  });
  it('does not substitute the process report for missing runtime evidence', () => {
    const { report } = historicalUnknown();
    const signals = newsletterStatus({ ...report, runtime: null }).signals;
    expect(signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
    expect(signals).toContainEqual({ code: 'deployment_pending', severity: 'warning', metrics: {} });
  });
  it.each(['stopped', 'unknown'] as const)('keeps a %s process unavailable despite unknown results', (process) => {
    const { report, item } = historicalUnknown();
    item.process_state = process;
    const signals = newsletterStatus(report).signals;
    expect(signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
    expect(signals).toContainEqual({ code: 'deployment_pending', severity: 'warning', metrics: {} });
  });
  it.each(['degraded', 'unavailable', 'unknown'] as const)('keeps a %s cluster unavailable', (state) => {
    const { report } = historicalUnknown();
    report.cluster.state = state;
    expect(newsletterStatus(report).signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
  });
  it('keeps zero ready replicas unavailable', () => {
    const { report } = historicalUnknown();
    report.cluster.ready_count = 0;
    expect(newsletterStatus(report).signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
  });
  it('keeps an unhealthy Newsletter worker unavailable', () => {
    const { report } = historicalUnknown();
    report.newsletter.worker_healthy = false;
    expect(newsletterStatus(report).signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
  });
  it.each(['source_sha', 'image_digest', 'request_id', 'generation'] as const)('keeps mismatched actual %s pending despite historical unknown results', (field) => {
    const { report, item } = historicalUnknown();
    const actual = item.release.actual;
    if (field === 'source_sha') actual.source_sha = '2'.repeat(40);
    if (field === 'image_digest') actual.image_digest = `sha256:${'2'.repeat(64)}`;
    if (field === 'request_id') actual.request_id = 'cfdd9a7b-3d46-4d2b-8983-6e99fb005a5b';
    if (field === 'generation') actual.generation = 2;
    const signals = newsletterStatus(report).signals;
    expect(signals).toContainEqual({ code: 'deployment_pending', severity: 'warning', metrics: {} });
    expect(signals).not.toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
  });
  it('keeps frozen admission paused and the release pending', () => {
    const { report, item } = historicalUnknown();
    item.admission_state = 'frozen';
    item.release.state = 'paused';
    report.newsletter.drain_state = 'frozen';
    expect(newsletterStatus(report).signals).toEqual([
      { code: 'deployment_pending', severity: 'warning', metrics: {} },
      { code: 'newsletter_unknown', severity: 'warning', metrics: { unknown_count: 32 } },
      { code: 'newsletter_paused', severity: 'info', metrics: {} },
    ]);
  });
  it('still rejects a stale runtime observation with historical unknown results', () => {
    const { report } = historicalUnknown();
    report.runtime.observed_at = '2026-10-02T23:58:59Z';
    expect(() => read(report)).toThrow('invalid_report');
  });
});

describe('runtime reconcile observations', () => {
  const plan = {
    name: 'reconcilePlan', base_release: 'releases/6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    base_etag: 'version-1', fingerprint: 'a'.repeat(64), observed_at: '2026-10-03T00:00:00Z',
    state: 'clean', changes: [],
  };
  const reported = (change: object) => ({ ...fixture, runtime: { ...fixture.runtime, reconcile_plan: { ...plan, ...change } } });
  it('keeps clean checks and intentional pauses free of drift alerts', () => {
    expect(reportCodes(read(reported({})))).toEqual([]);
    expect(reportCodes(read(reported({ state: 'manual_required', reason_code: 'BUSINESS_PAUSED' })))).toEqual([]);
  });
  it.each([['repairable', 'runtime_drift'], ['unavailable', 'runtime_comparison_unavailable']])('reports %s as %s', (state, code) => {
    expect(reportCodes(read(reported({ state })))).toContain(code);
  });
  it('reports ownership conflicts and rejects old comparison times', () => {
    expect(reportCodes(read(reported({ state: 'manual_required', changes: [{ resource_key: 'newsletter', action: 'conflict', reason_code: 'RUNTIME_OWNERSHIP_CONFLICT' }] })))).toContain('runtime_repair_manual');
    expect(() => read(reported({ observed_at: '2026-10-02T23:58:59Z' }))).toThrow('invalid_report');
  });
});
