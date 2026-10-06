import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/fleet-report-v1/fixtures/healthy.json';
import { statusSnapshot } from '../src/health.ts';
import { freshness, parseReport, reportCodes } from '../src/report.ts';

const NOW = Date.parse('2026-10-03T00:00:00Z');
const read = (value: unknown = fixture) => parseReport(JSON.stringify(value), 'vps', '1', NOW);

const NO_UNKNOWN = {
  interrupted_activities: 0, packets: 0, workflow_attempts: 0,
  notion_entities: 0, notion_versions: 0, delivery: 0,
};
/** A classified observer report with old unknown records, delivered 2 h before NOW unless changed. */
const historicalUnknown = (kinds: Partial<typeof NO_UNKNOWN> = { workflow_attempts: 32 }) => {
  const byKind = { ...NO_UNKNOWN, ...kinds };
  const count = Object.values(byKind).reduce((sum, value) => sum + value, 0);
  const report = structuredClone({
    ...fixture,
    newsletter: {
      ...fixture.newsletter, unknown_count: count, unknown_revision: 7, unknown_by_kind: byKind,
      latest_delivery_state: 'provider_accepted', latest_delivery_time: '2026-10-02T22:00:00Z',
    },
  });
  const item = report.runtime.workloads[0];
  if (!item) throw new Error('missing fixture workload');
  item.health_state = 'degraded';
  item.unknown_count = count;
  return { report, item };
};
const delivered = (state: string, time: string) => {
  const { report } = historicalUnknown({});
  return { ...report, newsletter: { ...report.newsletter, latest_delivery_state: state, latest_delivery_time: time } };
};
const codes = (report: unknown, now = NOW) => statusSnapshot('newsletter', read(report), now, now, 'fleet.example.test').signals.map((item) => item.code);

const newsletterStatus = (report: unknown) => statusSnapshot('newsletter', read(report), NOW, NOW, 'fleet.example.test');
const classifiedReport = () => ({
  ...fixture,
  newsletter: {
    ...fixture.newsletter,
    unknown_count: 4,
    unknown_revision: 7,
    unknown_by_kind: {
      interrupted_activities: 2, packets: 1, workflow_attempts: 0,
      notion_entities: 0, notion_versions: 0, delivery: 1,
    },
    latest_delivery_state: 'provider_accepted',
    latest_delivery_time: '2026-10-02T23:30:00.000Z',
  },
});

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
  it('projects accepted delivery separately from historical records and healthy execution', () => {
    const view = newsletterStatus(classifiedReport());
    expect(view.health).toBe('ok');
    expect(view.signals).toContainEqual({
      code: 'newsletter_delivery_accepted', severity: 'info',
      since: '2026-10-02T23:30:00Z', metrics: {},
    });
    expect(view.signals).toContainEqual({
      code: 'newsletter_unknown', severity: 'info', metrics: { unknown_count: 4, unknown_revision: 7 },
    });
    expect(view.signals).toContainEqual({
      code: 'newsletter_side_effect_unknown', severity: 'warning', metrics: { count: 2 },
    });
    expect(view.signals.map((item) => item.code)).not.toContain('newsletter_unavailable');
    expect(view.counters).toMatchObject({ unknown_interrupted_activities: 2, unknown_delivery: 1 });
  });
  it('reports a latest provider rejection without inventing a stopped process', () => {
    const report = classifiedReport();
    report.newsletter.latest_delivery_state = 'rejected';
    const view = newsletterStatus(report);
    expect(view.signals).toContainEqual({
      code: 'newsletter_delivery_rejected', severity: 'warning',
      since: '2026-10-02T23:30:00Z', metrics: {},
    });
    expect(view.signals.map((item) => item.code)).not.toContain('newsletter_unavailable');
    expect(view.signals.map((item) => item.code)).not.toContain('newsletter_delivery_accepted');
  });
  it('keeps a failed process unavailable even after an accepted provider response', () => {
    const report = classifiedReport();
    report.newsletter.worker_healthy = false;
    expect(newsletterStatus(report).signals.map((item) => item.code)).toEqual([
      'newsletter_unavailable', 'newsletter_side_effect_unknown', 'newsletter_delivery_accepted', 'newsletter_unknown',
    ]);
  });
  it('keeps bookkeeping-only unknown records visible as info without a warning or process fault', () => {
    const { report } = historicalUnknown();
    expect(newsletterStatus(report)).toMatchObject({
      health: 'ok',
      signals: [
        { code: 'newsletter_delivery_accepted', severity: 'info', since: '2026-10-02T22:00:00Z', metrics: {} },
        { code: 'newsletter_unknown', severity: 'info', metrics: { unknown_count: 32, unknown_revision: 7 } },
      ],
      counters: { unknown_count: 32, unknown_workflow_attempts: 32, unknown_revision: 7 },
    });
    expect(codes(historicalUnknown({ interrupted_activities: 3 }).report)).not.toContain('newsletter_side_effect_unknown');
    expect(reportCodes(read(report))).toEqual(['newsletter_unknown']);
    expect(statusSnapshot('fleet', read(report), NOW, NOW, 'fleet.example.test')).toMatchObject({ health: 'ok', signals: [] });
  });
  it('warns about unknown side effects without claiming a process fault', () => {
    const { report } = historicalUnknown({ delivery: 1, packets: 2, notion_entities: 3, notion_versions: 4, workflow_attempts: 5 });
    const view = newsletterStatus(report);
    expect(view.health).toBe('ok');
    expect(view.signals[0]).toEqual({ code: 'newsletter_side_effect_unknown', severity: 'warning', metrics: { count: 10 } });
  });
  it('treats every record of an unclassified legacy report as a possible side effect', () => {
    const report = structuredClone(fixture);
    report.newsletter.unknown_count = 2;
    expect(newsletterStatus(report).signals).toContainEqual({ code: 'newsletter_side_effect_unknown', severity: 'warning', metrics: { count: 2 } });
  });
  it('keeps the side-effect fingerprint stable as the heartbeat ages and changes it with the count', () => {
    const { report, item } = historicalUnknown({ delivery: 1, workflow_attempts: 31 });
    const before = newsletterStatus(report);
    const later = statusSnapshot('newsletter', read(report), NOW, NOW + 60_000, 'fleet.example.test');
    expect(later.signals).toEqual(before.signals);
    expect(later.counters.heartbeat_age_seconds).not.toBe(before.counters.heartbeat_age_seconds);
    report.newsletter.unknown_by_kind.delivery = 2;
    report.newsletter.unknown_count = 33;
    report.newsletter.unknown_revision = 8;
    item.unknown_count = 33;
    const changed = newsletterStatus(report);
    expect(changed.signals).toContainEqual({ code: 'newsletter_side_effect_unknown', severity: 'warning', metrics: { count: 2 } });
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
      { code: 'newsletter_delivery_accepted', severity: 'info', since: '2026-10-02T22:00:00Z', metrics: {} },
      { code: 'newsletter_paused', severity: 'info', metrics: {} },
      { code: 'newsletter_unknown', severity: 'info', metrics: { unknown_count: 32, unknown_revision: 7 } },
    ]);
  });
  it('still rejects a stale runtime observation with historical unknown results', () => {
    const { report } = historicalUnknown();
    report.runtime.observed_at = '2026-10-02T23:58:59Z';
    expect(() => read(report)).toThrow('invalid_report');
  });
});

describe('Newsletter daily delivery evidence', () => {
  it('reports a missed day only after the 07:00 Los Angeles window and its DST margin', () => {
    expect(codes(delivered('provider_accepted', '2026-10-01T22:00:00Z'))).not.toContain('newsletter_delivery_overdue');
    expect(codes(delivered('provider_accepted', '2026-10-01T19:00:00Z'))).toContain('newsletter_delivery_overdue');
    const view = newsletterStatus(delivered('provider_accepted', '2026-10-01T19:00:00Z'));
    expect(view.health).toBe('degraded');
    expect(view.signals).toContainEqual({ code: 'newsletter_delivery_overdue', severity: 'warning', since: '2026-10-01T19:00:00Z', metrics: {} });
  });
  it('waits for an unknown provider outcome to outlive one run before warning', () => {
    expect(codes(delivered('unknown', '2026-10-02T22:00:00Z'))).not.toContain('newsletter_delivery_overdue');
    expect(codes(delivered('unknown', '2026-10-02T21:00:00Z'))).toContain('newsletter_delivery_overdue');
  });
  it('leaves an old rejection to its own warning', () => {
    const signals = codes(delivered('rejected', '2026-10-01T00:00:00Z'));
    expect(signals).toContain('newsletter_delivery_rejected');
    expect(signals).not.toContain('newsletter_delivery_overdue');
  });
  it('reports missing delivery evidence as overdue', () => {
    expect(codes(fixture)).toEqual(['newsletter_delivery_overdue']);
  });
});

describe('Newsletter outcome receipt boundary', () => {
  it('accepts legacy reports without new outcome metadata', () => {
    expect(read(fixture).newsletter.unknown_by_kind).toBeUndefined();
    expect(read(classifiedReport()).newsletter.unknown_revision).toBe(7);
  });
  it('refuses inconsistent or unregistered category counts', () => {
    const report = classifiedReport();
    for (const counts of [
      { ...report.newsletter.unknown_by_kind, delivery: 2 },
      { ...report.newsletter.unknown_by_kind, delivery: -1 },
      { ...report.newsletter.unknown_by_kind, delivery: true },
      { ...report.newsletter.unknown_by_kind, unregistered: 0 },
      { ...report.newsletter.unknown_by_kind, delivery: undefined, unregistered: 1 },
      { delivery: 4 },
    ]) {
      expect(() => read({ ...report, newsletter: { ...report.newsletter, unknown_by_kind: counts } })).toThrow('invalid_report');
    }
  });
  it('refuses incomplete classification and unpaired delivery metadata', () => {
    const report = classifiedReport();
    for (const field of ['unknown_revision', 'unknown_by_kind', 'latest_delivery_state', 'latest_delivery_time']) {
      const newsletter = Object.fromEntries(Object.entries(report.newsletter).filter(([key]) => key !== field));
      expect(() => read({ ...report, newsletter })).toThrow('invalid_report');
    }
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
