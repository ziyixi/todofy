import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/fleet-report-v1/fixtures/healthy.json';
import { statusSnapshot } from '../src/health.ts';
import { parseReport } from '../src/report.ts';

const NOW = Date.parse('2026-10-03T00:00:00Z');
const INFERENCE = {
  started_at: '2026-10-02T23:00:00Z', observed_at: '2026-10-03T00:00:00Z',
  model: 'gpt-6.1-sol', effort: 'medium', sdk_version: '0.163.0',
  request_count: 2, success_count: 1, failure_count: 1, active_count: 0,
  input_tokens: 101, output_tokens: 23, usage_reported_count: 1,
  last_completed_at: '2026-10-02T23:59:00Z', last_duration_ms: 500, average_duration_ms: 750,
  last_error_code: 'codex_quota', recent_requests: [{
    sequence: 2, completed_at: '2026-10-02T23:59:00Z', model: 'gpt-6.1-sol', effort: 'medium',
    duration_ms: 500, error_code: 'codex_quota', input_tokens: 0, output_tokens: 0, usage_available: false,
  }],
};

function report(health: string = 'healthy', inference = false) {
  const source = fixture.runtime.workloads[0];
  if (!source) throw new Error('missing synthetic runtime');
  const key = 'codex-gateway';
  const gateway = {
    ...source, name: `workloads/${key}`, workload_key: key,
    admission_state: 'unsupported', health_state: health,
    ...(inference ? { inference_status: INFERENCE } : {}),
    release: {
      ...source.release,
      desired: { ...source.release.desired, workload_key: key },
      actual: { ...source.release.actual, workload_key: key },
    },
  };
  return parseReport(JSON.stringify({
    ...fixture,
    newsletter: { ...fixture.newsletter, drain_state: 'frozen' },
    runtime: { ...fixture.runtime, workloads: [gateway, ...fixture.runtime.workloads] },
  }), 'vps', '1', NOW);
}

describe('Codex gateway process projection', () => {
  it('reports its verified process while Newsletter is paused', () => {
    expect(statusSnapshot('codex-gateway', report(), NOW, NOW, 'fleet.example.test')).toMatchObject({
      app: 'codex-gateway', health: 'ok', signals: [], capabilities: [],
      counters: { heartbeat_age_seconds: 0 },
    });
  });
  it('keeps failed gateway process evidence visible without calling inference', () => {
    const status = statusSnapshot('codex-gateway', report('unknown'), NOW, NOW, 'fleet.example.test');
    expect(status.health).toBe('degraded');
    expect(status.signals.map((item) => item.code)).toEqual(['codex_gateway_unavailable', 'deployment_pending']);
  });
  it('carries bounded inference observations only from a fresh gateway report', () => {
    const value = report('healthy', true);
    expect(statusSnapshot('codex-gateway', value, NOW, NOW, 'fleet.example.test')).toMatchObject({
      health: 'ok', codex_inference: INFERENCE,
    });
    expect(statusSnapshot('codex-gateway', value, NOW, NOW + 11 * 60_000, 'fleet.example.test')).not.toHaveProperty('codex_inference');
    expect(statusSnapshot('fleet', value, NOW, NOW, 'fleet.example.test')).not.toHaveProperty('codex_inference');
    expect(statusSnapshot('codex-gateway', report(), NOW, NOW, 'fleet.example.test')).not.toHaveProperty('codex_inference');
  });
});
