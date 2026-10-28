import { describe, expect, it } from 'vitest';
import { filesystemPercent, labelsOf, latestValues, nodeFreshness, orderRoles, toGrid } from './metrics.ts';
import { daySummary, NODE } from './test/nodes.ts';

describe('node telemetry model', () => {
  it('places points on the step grid and leaves missing steps empty', () => {
    const grid = toGrid(daySummary(undefined, [10, 11, 200]));
    expect(grid?.count).toBe(288);
    const cpu = grid?.mean.get('cpu_percent') ?? [];
    expect(cpu).toHaveLength(288);
    expect(cpu[9]).not.toBeNull();
    expect(cpu[10]).toBeNull();
    expect(cpu[11]).toBeNull();
    expect(cpu[200]).toBeNull();
    expect(grid?.mean.get('workload_cpu_cores:newsletter')).toHaveLength(288);
  });
  it('ignores an unusable summary and points outside the range', () => {
    expect(toGrid({})).toBeNull();
    const summary = daySummary();
    const grid = toGrid({ ...summary, series: [{ metric: 'cpu_percent', points: [{ time: '2020-01-01T00:00:00Z', mean: 5, max: 5 }] }] });
    expect(grid?.mean.get('cpu_percent')?.every((v) => v === null)).toBe(true);
  });
  it('derives filesystem percent only where both sides exist', () => {
    const summary = daySummary();
    const series = summary.series.map((s) => (s.metric === 'filesystem_available_bytes' && s.label === 'k3s'
      ? { ...s, points: s.points.slice(1) } : s));
    const grid = toGrid({ ...summary, series });
    if (!grid) throw new Error('no grid');
    const k3s = filesystemPercent(grid, 'k3s');
    expect(k3s[0]).toBeNull();
    expect(k3s[1]).toBeCloseTo(9, 5);
  });
  it('reads latest values, labels and roles in a stable order', () => {
    const values = latestValues(NODE);
    expect(values.get('cpu_percent')).toBe(12.5);
    expect(values.get('filesystem_used_bytes:k3s')).toBe(45 * 1024 ** 3);
    expect(orderRoles(labelsOf(values.keys(), 'filesystem_used_bytes'))).toEqual(['root', 'k3s']);
    expect(orderRoles(['zfs', 'state', 'root'])).toEqual(['root', 'state', 'zfs']);
    expect(latestValues(undefined).size).toBe(0);
  });
  it('judges node freshness like the server', () => {
    const received = '2026-10-03T00:00:00Z';
    const at = (minutes: number): number => Date.parse(received) + minutes * 60_000;
    expect(nodeFreshness(received, at(10))).toBe('fresh');
    expect(nodeFreshness(received, at(15))).toBe('stale');
    expect(nodeFreshness(received, at(21))).toBe('missing');
    expect(nodeFreshness(undefined, at(0))).toBe('never_seen');
  });
});
