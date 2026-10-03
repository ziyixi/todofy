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
      signals: [{ code: 'newsletter_unknown', severity: 'warning', metrics: {} }],
      counters: { unknown_count: 32 },
    });
    expect(reportCodes(read(report))).toEqual(['newsletter_unknown']);
    expect(statusSnapshot('fleet', read(report), NOW, NOW, 'fleet.example.test')).toMatchObject({ health: 'ok', signals: [] });
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
      { code: 'newsletter_unknown', severity: 'warning', metrics: {} },
      { code: 'newsletter_paused', severity: 'info', metrics: {} },
    ]);
  });
  it('still rejects a stale runtime observation with historical unknown results', () => {
    const { report } = historicalUnknown();
    report.runtime.observed_at = '2026-10-02T23:58:59Z';
    expect(() => read(report)).toThrow('invalid_report');
  });
});
