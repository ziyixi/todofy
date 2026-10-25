import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/fleet-report-v1/fixtures/healthy.json';
import { statusSnapshot } from '../src/health.ts';
import { parseReport } from '../src/report.ts';

const NOW = Date.parse('2026-10-03T00:00:00Z');

function report(health: string = 'healthy') {
  const source = fixture.runtime.workloads[0];
  if (!source) throw new Error('missing synthetic runtime');
  const key = 'codex-gateway';
  const gateway = {
    ...source, name: `workloads/${key}`, workload_key: key,
    admission_state: 'unsupported', health_state: health,
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
});
