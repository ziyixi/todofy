import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { NodeMetrics } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import legacy from '../../../contracts/fleet-report-v1/fixtures/healthy.json';
import fixture from '../../../contracts/fleet-report-v1/fixtures/node_metrics.json';
import { derive, MAX_NODES, MAX_RATE_GAP_SECONDS, METRICS, MetricStore, orderKeys, RANGES, TIERS, validMetrics } from '../src/metrics.ts';
import { parseReport, reportCodes } from '../src/report.ts';

function memorySql(db = new DatabaseSync(':memory:')): { db: DatabaseSync; sql: SqlStorage } {
  const sql = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
      const trimmed = query.trim();
      const stmt = db.prepare(trimmed);
      const params = bindings as (string | number | bigint | Uint8Array | null)[];
      if (/^(SELECT|PRAGMA|WITH)\b/i.test(trimmed)) {
        const rows = stmt.all(...params) as unknown as T[];
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`Expected 1 row, got ${rows.length}`);
            return rows[0]!;
          },
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      }
      stmt.run(...params);
      const empty: T[] = [];
      return {
        toArray: () => empty,
        one: () => { throw new Error('Expected 1 row'); },
        [Symbol.iterator]: () => empty[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  return { db, sql };
}

const AT = Date.parse(fixture.observation_time);
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture without this group');
  return value;
}
const base = fixture.metrics as NodeMetrics;
const read = (value: unknown) => parseReport(JSON.stringify(value), 'vps', '1', AT);
/** The fixture's counters advanced by five minutes on 4 CPUs: 25% busy, 5% iowait, 1 MB/s in, 0.5 MB/s out. */
function later(seconds = 300, change: (metrics: NodeMetrics) => NodeMetrics = (metrics) => metrics): NodeMetrics {
  const cpu = base.cpu;
  const network = base.network;
  if (!cpu || !network) throw new Error('fixture without counters');
  const total = cpu.cpu_count * seconds * 1000;
  return change({
    ...base,
    uptime_seconds: base.uptime_seconds + seconds,
    cpu: {
      ...cpu,
      total_milliseconds: cpu.total_milliseconds + total,
      idle_milliseconds: cpu.idle_milliseconds + total * 0.7,
      iowait_milliseconds: cpu.iowait_milliseconds + total * 0.05,
    },
    network: {
      ...network,
      receive_bytes: network.receive_bytes + seconds * 1_000_000,
      transmit_bytes: network.transmit_bytes + seconds * 500_000,
    },
  });
}
const previous = () => ({ boot_id: base.boot_id, uptime: base.uptime_seconds, counters: derive(base, null).counters });

describe('node metrics in host reports', () => {
  it('accepts the legacy report without metrics and the new fixture with them', () => {
    expect(read(legacy).metrics).toBeUndefined();
    expect(read(fixture).metrics).toEqual(fixture.metrics);
    expect(reportCodes(read(fixture))).toEqual([]);
  });
  it('refuses impossible relations as an invalid report', () => {
    const broken = (change: (metrics: NodeMetrics) => NodeMetrics) => ({ ...fixture, metrics: change(structuredClone(base)) });
    const cases = [
      broken((m) => ({ ...m, cpu: { ...must(m.cpu), idle_milliseconds: must(m.cpu).total_milliseconds } })),
      broken((m) => ({ ...m, memory: { ...must(m.memory), available_bytes: must(m.memory).total_bytes + 1 } })),
      broken((m) => ({ ...m, memory: { ...must(m.memory), swap_free_bytes: must(m.memory).swap_total_bytes + 1 } })),
      broken((m) => ({ ...m, filesystems: { root: { size_bytes: 10, used_bytes: 6, available_bytes: 5 } } })),
      broken((m) => ({ ...m, workloads: [...must(m.workloads)].reverse() })),
      broken((m) => ({ ...m, workloads: [must(must(m.workloads)[0]), must(must(m.workloads)[0])] })),
      { ...fixture, metrics: { ...base, hostname: 'private' } },
    ];
    for (const report of cases) expect(() => read(report)).toThrow('invalid_report');
    expect(validMetrics(base)).toBe(true);
  });
  it('warns about any nearly full filesystem with the existing disk_high signal', () => {
    const full = { ...fixture, metrics: { ...base, filesystems: { ...base.filesystems, k3s: { size_bytes: 100, used_bytes: 90, available_bytes: 10 } } } };
    expect(reportCodes(read(full))).toEqual(['disk_high']);
    const fine = { ...fixture, metrics: { ...base, filesystems: { k3s: { size_bytes: 100, used_bytes: 89, available_bytes: 11 } } } };
    expect(reportCodes(read(fine))).toEqual([]);
  });
});

describe('samples derived from counters', () => {
  it('has gauges but no rates for the first report of a node', () => {
    const { sample } = derive(base, null);
    expect(sample).toEqual({
      load_1m: 0.42, load_5m: 0.5, load_15m: 0.48,
      memory_used_bytes: 6_039_797_760, memory_total_bytes: 16_777_216_000, swap_used_bytes: 0, swap_total_bytes: 4_294_967_296,
      'filesystem_used_bytes:k3s': 45e9, 'filesystem_available_bytes:k3s': 455e9,
      'filesystem_used_bytes:root': 5e9, 'filesystem_available_bytes:root': 455e9,
      'filesystem_used_bytes:state': 5e8, 'filesystem_available_bytes:state': 455e9,
      'workload_cpu_cores:codex-gateway': 0.0021, 'workload_memory_bytes:codex-gateway': 104_857_600,
      'workload_cpu_cores:newsletter': 0.015, 'workload_memory_bytes:newsletter': 268_435_456,
      'workload_cpu_cores:platform-runtime': 0.004, 'workload_memory_bytes:platform-runtime': 73_400_320,
    });
  });
  it('computes the true average utilisation and rates between two reports of one boot', () => {
    expect(derive(later(), previous()).sample).toMatchObject({
      cpu_percent: 25, cpu_iowait_percent: 5,
      network_receive_bytes_per_second: 1_000_000, network_transmit_bytes_per_second: 500_000,
    });
    // One missed report still averages over its interval.
    expect(derive(later(600), previous()).sample).toMatchObject({ cpu_percent: 25, network_receive_bytes_per_second: 1_000_000 });
  });
  const CPU = ['cpu_percent', 'cpu_iowait_percent'];
  const NETWORK = ['network_receive_bytes_per_second', 'network_transmit_bytes_per_second'];
  it.each([
    ['a reboot', later(300, (m) => ({ ...m, boot_id: '0f0c8a52-7d1e-4b8a-9c3f-2a6b1d4e8f70' })), [...CPU, ...NETWORK]],
    ['a gap beyond the rate window', later(MAX_RATE_GAP_SECONDS + 1), [...CPU, ...NETWORK]],
    ['an uptime that did not advance', later(0), [...CPU, ...NETWORK]],
    ['a CPU hot-plug', later(300, (m) => ({ ...m, cpu: { ...must(m.cpu), cpu_count: 8 } })), CPU],
    ['an interface change', later(300, (m) => ({ ...m, network: { ...must(m.network), interface_count: 2 } })), NETWORK],
  ])('derives no rates from counters across %s', (_name, metrics, dropped) => {
    const { sample, counters } = derive(metrics, previous());
    for (const key of [...CPU, ...NETWORK]) {
      if (dropped.includes(key)) expect(sample).not.toHaveProperty(key);
      else expect(sample).toHaveProperty(key);
    }
    expect(sample).toHaveProperty('memory_used_bytes');
    expect(counters.cpu?.total).toBe(metrics.cpu?.total_milliseconds);
  });
  it('drops only the rate whose counter went backwards', () => {
    const reset = later(300, (m) => ({ ...m, network: { ...must(m.network), receive_bytes: 5 } }));
    const { sample } = derive(reset, previous());
    expect(sample).toHaveProperty('cpu_percent', 25);
    expect(sample).not.toHaveProperty('network_receive_bytes_per_second');
    expect(sample).not.toHaveProperty('network_transmit_bytes_per_second');
  });
  it('keeps CPU utilisation when the kernel moves time from iowait back to idle', () => {
    // Five minutes on 4 CPUs: 75% quiet in all, but iowait reads 1 s below the previous report.
    const cpu = must(base.cpu);
    const moved = later(300, (m) => ({
      ...m,
      cpu: { ...must(m.cpu), idle_milliseconds: cpu.idle_milliseconds + 901_000, iowait_milliseconds: cpu.iowait_milliseconds - 1_000 },
    }));
    const { sample } = derive(moved, previous());
    expect(sample).toHaveProperty('cpu_percent', 25);
    expect(sample).toHaveProperty('cpu_iowait_percent', 0);
  });
  it('orders series by metric, then label', () => {
    expect(orderKeys(['workload_cpu_cores:b', 'load_1m', 'filesystem_used_bytes:root', 'cpu_percent', 'workload_cpu_cores:a']))
      .toEqual(['cpu_percent', 'load_1m', 'filesystem_used_bytes:root', 'workload_cpu_cores:a', 'workload_cpu_cores:b']);
    expect(Object.keys(METRICS)).toHaveLength(15);
  });
});

describe('retention and range budgets', () => {
  const DAY = 24 * 60 * 60_000;

  it('reads at most 730 rows and answers at most 300 points per series for every range', () => {
    for (const range of Object.values(RANGES)) {
      const tier = TIERS.find((item) => item.seconds === range.tier);
      if (!tier) throw new Error('range without a tier');
      expect(range.spanMs / (range.tier * 1000)).toBeLessThanOrEqual(730);
      expect(Math.ceil(range.spanMs / (range.step * 1000))).toBeLessThanOrEqual(300);
      expect(range.spanMs).toBeLessThanOrEqual(tier.keepMs);
      expect(range.step % range.tier).toBe(0);
    }
  });

  it('retains 730 days in SQLite and summarizes two_years and half_year within point budgets', () => {
    const { db, sql } = memorySql();
    const store = new MetricStore(sql);
    const now = Date.parse('2026-10-03T00:00:00Z');
    for (let day = 729; day >= 0; day -= 1) {
      store.ingest('vps', base, now - day * DAY, now - day * DAY);
    }
    const rows = db.prepare('SELECT resolution, COUNT(*) AS n FROM metric_points GROUP BY resolution').all() as { resolution: number; n: number }[];
    expect(rows.find((row) => row.resolution === 86_400)?.n).toBeGreaterThanOrEqual(730);

    const twoYears = store.summarize('vps', 'two_years', now + DAY, []);
    expect(twoYears).not.toBeNull();
    for (const series of twoYears!.series) {
      expect(series.points.length).toBeLessThanOrEqual(244);
    }
    expect(twoYears!.series.length).toBe(3 + 4 + 2 * 3 + 2 * 3);

    const halfYear = store.summarize('vps', 'half_year', now + DAY, ['memory_used_bytes']);
    expect(halfYear?.series[0]?.points).toHaveLength(180);
  });

  it('caps tracked nodes at MAX_NODES and prunes nodes silent beyond the 730-day retention tier', () => {
    const { sql } = memorySql();
    const store = new MetricStore(sql);
    const now = Date.parse('2026-10-03T00:00:00Z');
    for (let index = 0; index < MAX_NODES + 2; index += 1) {
      store.ingest(`node-${String(index).padStart(2, '0')}`, base, now, now);
    }
    expect(store.nodes()).toHaveLength(MAX_NODES);
    expect(store.node(`node-${String(MAX_NODES + 1).padStart(2, '0')}`)).toBeNull();
    expect(store.summarize('unknown-node', 'day', now, [])).toBeNull();

    // Advance beyond 730 days so the silent nodes are pruned when a fresh node reports.
    const future = now + 731 * DAY;
    store.ingest('node-00', base, future, future);
    expect(store.nodes().map((item) => item.name)).toEqual(['nodes/node-00']);
  });
});

