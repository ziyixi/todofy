import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/fleet-report-v1/fixtures/healthy.json';
import { freshness, parseReport, reportCodes } from '../src/report.ts';

const NOW = Date.parse('2026-10-03T00:00:00Z');
const read = (value: unknown = fixture) => parseReport(JSON.stringify(value), 'vps', '1', NOW);

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
