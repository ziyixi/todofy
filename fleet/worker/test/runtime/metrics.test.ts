/** Node metrics in real workerd SQLite: ingest of old and new reports, owner API, rollups, pruning and row budgets. */
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import legacy from '../../../../contracts/fleet-report-v1/fixtures/healthy.json';
import fixture from '../../../../contracts/fleet-report-v1/fixtures/node_metrics.json';
import { AT, startHarness, type Harness } from './harness.ts';

type Metrics = typeof fixture.metrics;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const UUIDS = ['6d2f8a1e-4b3c-4e5d-9f60-718293a4b5c6', '7e3a9b2f-5c4d-4f6e-8a71-8293a4b5c6d7', '8f4bac30-6d5e-4a7f-9b82-93a4b5c6d7e8'];

/** The fixture `seconds` later: 4 CPUs 25% busy and 5% iowait, 1 MB/s received, 0.5 MB/s sent. */
function advanced(seconds: number, boot = fixture.metrics.boot_id): Metrics {
  const metrics = structuredClone(fixture.metrics);
  const total = metrics.cpu.cpu_count * seconds * 1000;
  metrics.boot_id = boot;
  metrics.uptime_seconds += seconds;
  metrics.cpu.total_milliseconds += total;
  metrics.cpu.idle_milliseconds += total * 0.7;
  metrics.cpu.iowait_milliseconds += total * 0.05;
  metrics.network.receive_bytes += seconds * 1_000_000;
  metrics.network.transmit_bytes += seconds * 500_000;
  return metrics;
}
function report(sequence: number, at: number, metrics: Metrics | null) {
  const rest: Partial<typeof fixture> = { ...fixture };
  delete rest.metrics;
  return {
    ...rest, sequence, receipt_id: UUIDS[sequence - 1], observation_time: new Date(at).toISOString(), runtime: null,
    ...(metrics ? { metrics } : {}),
  };
}

describe('node metrics through FleetState and the owner API', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.mf.dispose();
    harness = undefined;
  });
  const api = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (!harness) throw new Error('no harness');
    const response = await harness.mf.dispatchFetch(`http://127.0.0.1/api/v1/${path}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  it('accepts a report of the current observer without metrics and lists no node', async () => {
    harness = await startHarness();
    expect(await (await harness.accept(legacy, AT)).json()).toEqual({ accepted: true, sequence: 1 });
    expect(await api('nodes')).toEqual({ status: 200, body: {} });
    expect((await api('nodes/vps')).status).toBe(404);
    expect((await api('nodes/vps:summarizeMetrics')).status).toBe(404);
  });

  it('derives rates from consecutive reports and serves the latest sample and a day of history', async () => {
    harness = await startHarness();
    const first = AT - 10 * MINUTE;
    const second = AT - 5 * MINUTE;
    expect((await harness.accept(report(1, first, fixture.metrics), first)).status).toBe(200);
    // An identical retry neither refreshes nor double-counts the sample.
    expect(await (await harness.accept(report(1, first, fixture.metrics), first + MINUTE)).json()).toEqual({ accepted: false, sequence: 1 });
    expect((await harness.accept(report(2, second, advanced(300)), second)).status).toBe(200);

    const node = await api('nodes/vps');
    expect(node.status).toBe(200);
    expect(node.body).toMatchObject({
      name: 'nodes/vps', sample_time: '2026-10-02T23:55:00Z', receive_time: '2026-10-02T23:55:00Z',
      boot_time: '2026-10-01T23:50:00Z', cpu_count: 4,
    });
    const latest = node.body.latest_values as { metric: string; label?: string; value: number }[];
    expect(latest.slice(0, 3)).toEqual([
      { metric: 'cpu_percent', value: 25 },
      { metric: 'cpu_iowait_percent', value: 5 },
      { metric: 'load_1m', value: 0.42 },
    ]);
    expect(latest).toContainEqual({ metric: 'network_receive_bytes_per_second', value: 1_000_000 });
    expect(latest).toContainEqual({ metric: 'filesystem_used_bytes', label: 'k3s', value: 45e9 });
    expect(await api('nodes')).toMatchObject({ status: 200, body: { nodes: [{ name: 'nodes/vps', cpu_count: 4 }] } });

    const day = await api('nodes/vps:summarizeMetrics?metrics=cpu_percent&metrics=workload_memory_bytes');
    expect(day).toEqual({
      status: 200,
      body: {
        name: 'nodes/vps', range: 'day', start_time: '2026-10-02T00:00:00Z', end_time: '2026-10-03T00:00:00Z', step_seconds: 300,
        series: [
          { metric: 'cpu_percent', points: [{ time: '2026-10-02T23:55:00Z', mean: 25, max: 25 }] },
          ...['codex-gateway', 'newsletter', 'platform-runtime'].map((label) => ({
            metric: 'workload_memory_bytes', label,
            points: [
              { time: '2026-10-02T23:50:00Z', mean: expect.any(Number) as number, max: expect.any(Number) as number },
              { time: '2026-10-02T23:55:00Z', mean: expect.any(Number) as number, max: expect.any(Number) as number },
            ],
          })),
        ],
      },
    });
    const week = await api('nodes/vps:summarizeMetrics?range=week&metrics=load_1m');
    expect(week.body).toMatchObject({
      range: 'week', step_seconds: 3600, start_time: '2026-09-26T00:00:00Z',
      series: [{ metric: 'load_1m', points: [{ time: '2026-10-02T23:00:00Z', mean: 0.42, max: 0.42 }] }],
    });
    const earlier = await api('nodes/vps:summarizeMetrics?range=day&end_time=2026-10-01T00:00:00Z');
    expect(earlier.body).toMatchObject({ end_time: '2026-10-01T00:00:00Z' });
    expect(earlier.body).not.toHaveProperty('series');
    // A future end is read as now.
    const future = await api('nodes/vps:summarizeMetrics?end_time=2027-01-01T00:00:00Z&metrics=cpu_percent');
    expect(future.body).toMatchObject({ end_time: '2026-10-03T00:00:00Z' });
  });

  it('starts a new baseline after a reboot instead of subtracting another boot', async () => {
    harness = await startHarness();
    const first = AT - 10 * MINUTE;
    const second = AT - 5 * MINUTE;
    await harness.accept(report(1, first, fixture.metrics), first);
    const rebooted = { ...advanced(300, '0f0c8a52-7d1e-4b8a-9c3f-2a6b1d4e8f70'), uptime_seconds: 120 };
    expect((await harness.accept(report(2, second, rebooted), second)).status).toBe(200);
    const latest = (await api('nodes/vps')).body.latest_values as { metric: string }[];
    expect(latest.map((item) => item.metric)).not.toContain('cpu_percent');
    expect(latest.map((item) => item.metric)).not.toContain('network_receive_bytes_per_second');
    expect((await api('nodes/vps')).body).toMatchObject({ boot_time: '2026-10-02T23:53:00Z' });
  });

  it('refuses malformed queries and impossible reports', async () => {
    harness = await startHarness();
    await harness.accept(report(1, AT, fixture.metrics), AT);
    for (const query of ['nodes/vps:summarizeMetrics?metrics=hostname', 'nodes/vps:summarizeMetrics?range=decade',
      'nodes/Bad:summarizeMetrics', 'nodes/vps:summarizeMetrics?end_time=2019-12-31T00:00:00Z', 'nodes?page_size=-1']) {
      expect((await api(query)).status).toBe(400);
    }
    expect((await api('nodes/other:summarizeMetrics')).status).toBe(404);
    const broken = { ...fixture.metrics, memory: { ...fixture.metrics.memory, available_bytes: 2 * fixture.metrics.memory.total_bytes } };
    expect((await harness.send(report(2, AT, broken))).status).toBe(400);
  });
});

/** MetricStore alone in a SQLite Durable Object, counting the rows each call reads and writes. */
const PROBE = `
import { DurableObject } from 'cloudflare:workers';
import { MetricStore } from './src/metrics.ts';
export class Probe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cursors = [];
    const sql = ctx.storage.sql;
    this.store = new MetricStore({ exec: (query, ...values) => {
      const cursor = sql.exec(query, ...values);
      this.cursors.push(cursor);
      return cursor;
    } });
  }
  measure(call) {
    this.cursors = [];
    const result = call();
    return {
      result: result ?? null,
      read: this.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      written: this.cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
    };
  }
  ingest(node, metrics, observed, received) { return this.measure(() => this.store.ingest(node, metrics, observed, received)); }
  summarize(node, range, end, metrics) { return this.measure(() => this.store.summarize(node, range, end, metrics)); }
  rows() {
    return this.ctx.storage.sql.exec('SELECT resolution, COUNT(*) AS n FROM metric_points GROUP BY resolution').toArray();
  }
}
export default {
  async fetch(request, env) {
    const { method, store, args } = await request.json();
    const stub = env.PROBE.get(env.PROBE.idFromName(store));
    return Response.json(await stub[method](...args));
  },
};`;

interface Measured<T> { result: T; read: number; written: number }
interface Summary { start: number; end: number; step: number; series: { metric: string; label: string; points: { time: string; mean: number; max: number }[] }[] }

describe('metric store rollups, pruning and budgets in workerd SQLite', () => {
  let mf: Miniflare;
  beforeAll(async () => {
    const result = await build({
      stdin: { contents: PROBE, resolveDir: resolve('.'), loader: 'ts' },
      bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false,
    });
    const script = result.outputFiles[0]?.text;
    if (!script) throw new Error('esbuild produced no probe');
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, script, compatibilityDate: '2026-09-29',
      durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
    }));
    await mf.ready;
  });
  afterAll(async () => {
    await mf.dispose();
  });
  /** Each test has its own object; the first argument of every method but rows() is the node. */
  async function call<T>(method: string, store: string, ...args: unknown[]): Promise<T> {
    const body = JSON.stringify({ method, store, args: method === 'rows' ? args : [store, ...args] });
    const response = await mf.dispatchFetch('http://probe/', { method: 'POST', body });
    return await response.json() as T;
  }
  const gauges = (load: number) => ({ boot_id: fixture.metrics.boot_id, uptime_seconds: 1, load: { one_minute: load, five_minutes: 0, fifteen_minutes: 0 } });

  it('folds 5-minute samples into hourly mean and max', async () => {
    const hour = Date.parse('2026-10-02T10:00:00Z');
    for (let index = 0; index < 12; index += 1) {
      await call('ingest', 'rollup', gauges(index), hour + index * 5 * MINUTE, hour + index * 5 * MINUTE);
    }
    const end = hour + 60 * MINUTE;
    const day = await call<Measured<Summary>>('summarize', 'rollup', 'day', end, ['load_1m']);
    expect(day.result.series[0]?.points).toHaveLength(12);
    const week = await call<Measured<Summary>>('summarize', 'rollup', 'week', end, ['load_1m']);
    expect(week.result.series[0]?.points).toEqual([{ time: '2026-10-02T10:00:00.000Z', mean: 5.5, max: 11 }]);
    const month = await call<Measured<Summary>>('summarize', 'rollup', 'month', end, ['load_1m']);
    expect(month.result).toMatchObject({ step: 10_800, series: [{ points: [{ time: '2026-10-02T09:00:00.000Z', mean: 5.5, max: 11 }] }] });
    expect(month.result.end - month.result.start).toBe(30 * DAY);
  });

  it('deletes expired rows a bounded batch at a time', async () => {
    const now = Date.parse('2026-10-03T00:00:00Z');
    const old = now - 20 * DAY;
    for (let index = 0; index < 40; index += 1) {
      await call('ingest', 'prune', gauges(1), old + index * 5 * MINUTE, old + index * 5 * MINUTE);
    }
    const before = await call<{ resolution: number; n: number }[]>('rows', 'prune');
    const fiveMinute = (rows: { resolution: number; n: number }[]) => rows.find((row) => row.resolution === 300)?.n ?? 0;
    const first = await call<Measured<null>>('ingest', 'prune', gauges(1), now, now);
    const afterFirst = fiveMinute(await call('rows', 'prune'));
    expect(fiveMinute(before) - afterFirst).toBe(32 - 1);
    await call('ingest', 'prune', gauges(1), now + 5 * MINUTE, now + 5 * MINUTE);
    expect(fiveMinute(await call('rows', 'prune'))).toBe(afterFirst - 8 + 1);
    expect(first.written).toBeLessThanOrEqual(4 + 2 * 32 + 4);
  });

  it('keeps a report to a handful of row writes and a two-year range to one row per day', async () => {
    const now = Date.parse('2026-10-03T00:00:00Z');
    let steady: Measured<null> | undefined;
    for (let day = 729; day >= 0; day -= 1) {
      steady = await call<Measured<null>>('ingest', 'budget', fixture.metrics, now - day * DAY, now - day * DAY);
    }
    // Measured 6 writes (the node row, three tier rows, about one expired 5-minute and hourly row) and 16 reads.
    expect(steady?.written).toBeLessThanOrEqual(8);
    expect(steady?.read).toBeLessThanOrEqual(20);
    const rows = await call<{ resolution: number; n: number }[]>('rows', 'budget');
    expect(rows.find((row) => row.resolution === 86_400)?.n).toBeGreaterThanOrEqual(730);
    const twoYears = await call<Measured<Summary>>('summarize', 'budget', 'two_years', now + DAY, []);
    expect(twoYears.read).toBeLessThanOrEqual(731 + 1);
    for (const series of twoYears.result.series) expect(series.points.length).toBeLessThanOrEqual(244);
    expect(twoYears.result.series.length).toBe(3 + 4 + 2 * 3 + 2 * 3);
    const halfYear = await call<Measured<Summary>>('summarize', 'budget', 'half_year', now + DAY, ['memory_used_bytes']);
    expect(halfYear.read).toBeLessThanOrEqual(181 + 1);
    expect(halfYear.result.series[0]?.points).toHaveLength(180);
  });
});
