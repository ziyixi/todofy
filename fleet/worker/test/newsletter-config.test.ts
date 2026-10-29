import { describe, expect, it } from 'vitest';
import type { NewsletterConfigSync } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import fixture from '../../../contracts/fleet-report-v1/fixtures/healthy.json';
import { statusSnapshot } from '../src/health.ts';
import { parseReport } from '../src/report.ts';

const NOW = Date.parse('2026-10-03T00:00:00Z');
const CONFIG = {
  active_revision: '1'.repeat(40), active_digest: 'a'.repeat(64),
  wanted_revision: '1'.repeat(40), wanted_digest: 'a'.repeat(64), wanted_commit: '2'.repeat(40),
  last_attempt_time: '2026-10-02T23:55:00Z', last_success_time: '2026-10-02T23:55:00Z',
} satisfies NewsletterConfigSync;
function report(config: unknown = CONFIG) {
  return parseReport(JSON.stringify({ ...fixture, newsletter: { ...fixture.newsletter,
    latest_delivery_state: 'provider_accepted', latest_delivery_time: '2026-10-02T23:00:00Z',
    config_sync: config } }), 'vps', '1', NOW);
}
function status(config: unknown = CONFIG) {
  return statusSnapshot('newsletter', report(config), NOW, NOW, 'fleet.example.test');
}
const signal = (state: string, severity = 'info') => ({ code: `newsletter_config_${state}`, severity, metrics: {} });

describe('Newsletter configuration observation', () => {
  it('compares the observed identity pair and projects only numeric clocks to Home', () => {
    const view = status();
    expect(view.health).toBe('ok');
    expect(view.signals).toContainEqual(signal('current'));
    expect(view.counters).toMatchObject({ newsletter_config_last_attempt_at: NOW / 1000 - 300,
      newsletter_config_last_success_at: NOW / 1000 - 300, newsletter_config_attempt_age_seconds: 300 });
    expect(Object.values(view.counters).every((value) => typeof value === 'number')).toBe(true);
    expect(status({ ...CONFIG, active_revision: 'packaged', wanted_revision: 'packaged' }).signals).toContainEqual(signal('current'));
  });
  it.each([{ active_revision: '3'.repeat(40) }, { active_digest: 'b'.repeat(64) }])('keeps an identity mismatch pending: %j', (patch) => {
    expect(status({ ...CONFIG, ...patch }).signals).toContainEqual(signal('pending'));
  });
  it('warns on safe errors and old attempts without changing process health or delivery evidence', () => {
    for (const [config, state] of [
      [{ ...CONFIG, error: 'CONFIG_GITHUB_NETWORK_ERROR' }, 'failed'],
      [{ ...CONFIG, last_attempt_time: '2026-10-02T23:29:59Z' }, 'stale'],
    ] as const) {
      const view = status(config);
      expect(view.health).toBe('ok');
      expect(view.signals).toContainEqual(signal(state, 'warning'));
      expect(view.signals).toContainEqual({ code: 'newsletter_delivery_accepted', severity: 'info', since: '2026-10-02T23:00:00Z', metrics: {} });
      expect(view.signals.map((item) => item.code)).not.toContain('newsletter_unavailable');
    }
    expect(status({ ...CONFIG, last_attempt_time: '2026-10-02T23:30:00Z' }).signals).toContainEqual(signal('current'));
  });
  it('shows an effective pin independently of an old or absent remote target', () => {
    expect(status({ ...CONFIG, pinned_digest: CONFIG.active_digest, wanted_digest: 'b'.repeat(64) }).signals).toContainEqual(signal('pinned'));
    expect(status({ active_revision: CONFIG.active_revision, active_digest: CONFIG.active_digest,
      pinned_digest: CONFIG.active_digest, last_attempt_time: CONFIG.last_attempt_time }).signals).toContainEqual(signal('pinned'));
    expect(status({ ...CONFIG, pinned_digest: 'b'.repeat(64) }).signals).toContainEqual(signal('pending'));
  });
  it.each([{}, { active_revision: 'packaged' }, { ...CONFIG, wanted_digest: undefined }])('keeps incomplete metadata unobserved: %j', (config) => {
    expect(status(config).signals).toContainEqual(signal('unobserved'));
    expect(status(config).signals).not.toContainEqual(signal('current'));
  });
  it('keeps an older producer without the optional config child unobserved', () => {
    const legacy = parseReport(JSON.stringify(fixture), 'vps', '1', NOW);
    expect(statusSnapshot('newsletter', legacy, NOW, NOW, 'fleet.example.test').signals).toContainEqual(signal('unobserved'));
  });
  it('does not reuse config signals or clocks after the host observation becomes stale', () => {
    const view = statusSnapshot('newsletter', report(), NOW, NOW + 600_001, 'fleet.example.test');
    expect(view.signals).toEqual([{ code: 'host_stale', severity: 'warning', metrics: {} }]);
    expect(view.counters).toEqual({ heartbeat_age_seconds: 600 });
  });
  it('tolerates two minutes of clock skew but keeps later clocks out of fresh configuration evidence', () => {
    const allowed = '2026-10-03T00:02:00Z';
    const future = '2026-10-03T00:02:00.001Z';
    const skewed = status({ ...CONFIG, last_attempt_time: allowed, last_success_time: allowed });
    expect(skewed.signals).toContainEqual(signal('current'));
    expect(skewed.counters).toMatchObject({ newsletter_config_last_attempt_at: NOW / 1000 + 120,
      newsletter_config_last_success_at: NOW / 1000 + 120, newsletter_config_attempt_age_seconds: 0 });
    const unobserved = status({ ...CONFIG, last_attempt_time: future, last_success_time: future });
    expect(unobserved.signals).toContainEqual(signal('unobserved'));
    expect(Object.keys(unobserved.counters).filter((key) => key.startsWith('newsletter_config_'))).toEqual([]);
    expect(status({ ...CONFIG, last_success_time: future }).counters).not.toHaveProperty('newsletter_config_last_success_at');
  });
  it.each([{ error: 'private error text' }, { active_digest: 'short' }, { last_attempt_time: 'yesterday' }, { url: 'https://private.invalid' }])('rejects unsafe configuration metadata %j', (patch) => {
    expect(() => report({ ...CONFIG, ...patch })).toThrow('invalid_report');
  });
});
