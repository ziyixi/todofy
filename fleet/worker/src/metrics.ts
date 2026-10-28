/**
 * Node telemetry history in the FleetState SQLite. Each accepted report becomes one derived sample: gauges as sent,
 * CPU and network rates from the counter deltas since the node's previous report of the same boot. The sample is
 * folded into three tiers (sum, count and max per series), so a report writes four rows and a range reads at most
 * 730. Old rows are deleted a few at a time on later reports, never by a scan.
 */
import type { NodeMetrics } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Resolution in seconds and how long its rows are kept. */
export const TIERS = [
  { seconds: 300, keepMs: 14 * DAY },
  { seconds: 3_600, keepMs: 180 * DAY },
  { seconds: 86_400, keepMs: 730 * DAY },
] as const;
/** The tier a range reads and the steps it groups rows into: at most 288 points per series. */
export const RANGES = {
  day: { tier: 300, spanMs: DAY, step: 300 },
  week: { tier: 3_600, spanMs: 7 * DAY, step: 3_600 },
  month: { tier: 3_600, spanMs: 30 * DAY, step: 3 * 3_600 },
  half_year: { tier: 86_400, spanMs: 180 * DAY, step: 86_400 },
  two_years: { tier: 86_400, spanMs: 730 * DAY, step: 3 * 86_400 },
} as const;
export type RangeName = keyof typeof RANGES;
/** Rates are averages since the previous report; past this gap they would smear an outage into one step. */
export const MAX_RATE_GAP_SECONDS = 900;
/** Expired rows deleted per tier and node on each report; a report expires about one row per tier. */
export const PRUNE_BATCH = 32;
export const MAX_NODES = 16;

/** Output order of every series, and the digits each keeps (null: whole numbers). */
export const METRICS = {
  cpu_percent: 3,
  cpu_iowait_percent: 3,
  load_1m: 3,
  load_5m: 3,
  load_15m: 3,
  memory_used_bytes: null,
  memory_total_bytes: null,
  swap_used_bytes: null,
  swap_total_bytes: null,
  network_receive_bytes_per_second: null,
  network_transmit_bytes_per_second: null,
  filesystem_used_bytes: null,
  filesystem_available_bytes: null,
  workload_cpu_cores: 5,
  workload_memory_bytes: null,
} as const satisfies Record<string, number | null>;
export type MetricName = keyof typeof METRICS;
const ORDER = Object.keys(METRICS) as MetricName[];

/** Series key: the metric, or `metric:label` for a filesystem role or workload. */
export type Sample = Record<string, number>;
type Folded = Record<string, [sum: number, count: number, max: number]>;
interface Counters {
  readonly cpu?: { count: number; total: number; idle: number; iowait: number };
  readonly network?: { interfaces: number; receive: number; transmit: number };
}
type NodeRow = {
  node: string; boot_id: string; observed_at: number; received_at: number;
  uptime: number; cpu_count: number; counters: string; latest: string;
};

function round(metric: string, value: number): number {
  const digits = METRICS[metric.split(':', 1)[0] as MetricName];
  const scale = 10 ** (digits ?? 0);
  return Math.round(value * scale) / scale;
}

/** Relations the wire rules cannot state. A report that breaks one is refused, like any malformed report. */
export function validMetrics(metrics: NodeMetrics): boolean {
  const { cpu, memory, workloads = [] } = metrics;
  if (cpu && cpu.idle_milliseconds + cpu.iowait_milliseconds > cpu.total_milliseconds) return false;
  if (memory && (memory.available_bytes > memory.total_bytes || memory.swap_free_bytes > memory.swap_total_bytes)) return false;
  if (Object.values(metrics.filesystems ?? {}).some((fs) => fs.used_bytes + fs.available_bytes > fs.size_bytes)) return false;
  const keys = workloads.map((item) => item.workload_key);
  return keys.every((key, index) => index === 0 || (keys[index - 1] ?? '') < key);
}

function rate(delta: number, seconds: number): number | null {
  return delta >= 0 ? delta / seconds : null;
}

/** One sample from a report and the node's previous counters; a reboot, reset or gap yields no rates. */
export function derive(metrics: NodeMetrics, previous: { boot_id: string; uptime: number; counters: Counters } | null): {
  sample: Sample; counters: Counters;
} {
  const sample: Sample = {};
  const put = (key: string, value: number | null): void => {
    if (value !== null && Number.isFinite(value)) sample[key] = round(key, value);
  };
  const { cpu, load, memory, network } = metrics;
  const counters: Counters = {
    ...(cpu ? { cpu: { count: cpu.cpu_count, total: cpu.total_milliseconds, idle: cpu.idle_milliseconds, iowait: cpu.iowait_milliseconds } } : {}),
    ...(network ? { network: { interfaces: network.interface_count, receive: network.receive_bytes, transmit: network.transmit_bytes } } : {}),
  };
  const seconds = previous?.boot_id === metrics.boot_id ? metrics.uptime_seconds - previous.uptime : 0;
  const before = seconds > 0 && seconds <= MAX_RATE_GAP_SECONDS ? previous?.counters : undefined;
  if (counters.cpu && before?.cpu && before.cpu.count === counters.cpu.count) {
    const total = counters.cpu.total - before.cpu.total;
    const idle = counters.cpu.idle - before.cpu.idle;
    const iowait = counters.cpu.iowait - before.cpu.iowait;
    if (total > 0 && idle >= 0 && iowait >= 0 && idle + iowait <= total) {
      put('cpu_percent', (100 * (total - idle - iowait)) / total);
      put('cpu_iowait_percent', (100 * iowait) / total);
    }
  }
  if (counters.network && before?.network && before.network.interfaces === counters.network.interfaces) {
    const receive = rate(counters.network.receive - before.network.receive, seconds);
    const transmit = rate(counters.network.transmit - before.network.transmit, seconds);
    if (receive !== null && transmit !== null) {
      put('network_receive_bytes_per_second', receive);
      put('network_transmit_bytes_per_second', transmit);
    }
  }
  if (load) {
    put('load_1m', load.one_minute);
    put('load_5m', load.five_minutes);
    put('load_15m', load.fifteen_minutes);
  }
  if (memory) {
    put('memory_used_bytes', memory.total_bytes - memory.available_bytes);
    put('memory_total_bytes', memory.total_bytes);
    put('swap_used_bytes', memory.swap_total_bytes - memory.swap_free_bytes);
    put('swap_total_bytes', memory.swap_total_bytes);
  }
  for (const [role, fs] of Object.entries(metrics.filesystems ?? {})) {
    put(`filesystem_used_bytes:${role}`, fs.used_bytes);
    put(`filesystem_available_bytes:${role}`, fs.available_bytes);
  }
  for (const item of metrics.workloads ?? []) {
    put(`workload_cpu_cores:${item.workload_key}`, item.cpu_cores);
    put(`workload_memory_bytes:${item.workload_key}`, item.memory_bytes);
  }
  return { sample, counters };
}

/** Series keys in output order: metric order, then label. */
export function orderKeys(keys: Iterable<string>): string[] {
  const position = (key: string): number => ORDER.indexOf(key.split(':', 1)[0] as MetricName);
  return [...keys].sort((a, b) => position(a) - position(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function split(key: string): { metric: string; label: string } {
  const index = key.indexOf(':');
  return index < 0 ? { metric: key, label: '' } : { metric: key.slice(0, index), label: key.slice(index + 1) };
}

export interface NodeView {
  name: string; sample_time: string; receive_time: string; boot_time: string; cpu_count: number;
  latest_values: { metric: string; label: string; value: number }[];
}
export interface SeriesView {
  metric: string; label: string; points: { time: string; mean: number; max: number }[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

export class MetricStore {
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS metric_nodes (
      node TEXT PRIMARY KEY, boot_id TEXT NOT NULL, observed_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      uptime REAL NOT NULL, cpu_count INTEGER NOT NULL, counters TEXT NOT NULL, latest TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS metric_points (
      node TEXT NOT NULL, resolution INTEGER NOT NULL, bucket INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (node, resolution, bucket)
    ) WITHOUT ROWID`);
  }

  private nodeRow(node: string): NodeRow | null {
    return this.sql.exec<NodeRow>('SELECT * FROM metric_nodes WHERE node=?', node).toArray()[0] ?? null;
  }

  /**
   * Runs inside the receipt transaction. Every read and parse happens before the first write, so a failure the
   * caller skips leaves no half-written sample behind.
   */
  ingest(node: string, metrics: NodeMetrics, observedAt: number, receivedAt: number): void {
    const previous = this.nodeRow(node);
    if (!previous && this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM metric_nodes').one().n >= MAX_NODES) return;
    const { sample, counters } = derive(metrics, previous && {
      boot_id: previous.boot_id, uptime: previous.uptime, counters: JSON.parse(previous.counters) as Counters,
    });
    const rows = TIERS.map((tier) => {
      const size = tier.seconds * 1000;
      const bucket = Math.floor(observedAt / size) * size;
      const row = this.sql.exec<{ data: string }>(
        'SELECT data FROM metric_points WHERE node=? AND resolution=? AND bucket=?', node, tier.seconds, bucket,
      ).toArray()[0];
      const folded = row ? JSON.parse(row.data) as Folded : {};
      for (const [key, value] of Object.entries(sample)) {
        const [sum, count, max] = folded[key] ?? [0, 0, value];
        folded[key] = [round(key, sum + value), count + 1, Math.max(max, value)];
      }
      return { resolution: tier.seconds, bucket, data: JSON.stringify(folded) };
    });
    this.sql.exec(`INSERT INTO metric_nodes(node,boot_id,observed_at,received_at,uptime,cpu_count,counters,latest)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(node) DO UPDATE SET boot_id=excluded.boot_id,
      observed_at=excluded.observed_at, received_at=excluded.received_at, uptime=excluded.uptime,
      cpu_count=excluded.cpu_count, counters=excluded.counters, latest=excluded.latest`,
    node, metrics.boot_id, observedAt, receivedAt, metrics.uptime_seconds, metrics.cpu?.cpu_count ?? 0,
    JSON.stringify(counters), JSON.stringify(sample));
    for (const row of rows) {
      this.sql.exec('INSERT OR REPLACE INTO metric_points(node,resolution,bucket,data) VALUES (?,?,?,?)',
        node, row.resolution, row.bucket, row.data);
    }
    this.prune(receivedAt);
  }

  /** At most PRUNE_BATCH expired rows per node and tier, each found through the primary key. */
  prune(now: number): void {
    const nodes = this.sql.exec<{ node: string; received_at: number }>('SELECT node, received_at FROM metric_nodes').toArray();
    for (const { node, received_at: receivedAt } of nodes) {
      for (const tier of TIERS) {
        this.sql.exec(`DELETE FROM metric_points WHERE node=? AND resolution=? AND bucket IN (
          SELECT bucket FROM metric_points WHERE node=? AND resolution=? AND bucket<? ORDER BY bucket LIMIT ?)`,
        node, tier.seconds, node, tier.seconds, now - tier.keepMs, PRUNE_BATCH);
      }
      // A node silent for longer than the longest tier has no history left to show.
      if (receivedAt < now - TIERS[2].keepMs) this.sql.exec('DELETE FROM metric_nodes WHERE node=?', node);
    }
  }

  private view(row: NodeRow): NodeView {
    const latest = JSON.parse(row.latest) as Sample;
    return {
      name: `nodes/${row.node}`,
      sample_time: iso(row.observed_at),
      receive_time: iso(row.received_at),
      boot_time: iso(Math.round((row.observed_at - row.uptime * 1000) / 1000) * 1000),
      cpu_count: row.cpu_count,
      latest_values: orderKeys(Object.keys(latest)).map((key) => ({ ...split(key), value: latest[key] ?? 0 })),
    };
  }

  node(node: string): NodeView | null {
    const row = this.nodeRow(node);
    return row ? this.view(row) : null;
  }

  nodes(): NodeView[] {
    return this.sql.exec<NodeRow>('SELECT * FROM metric_nodes ORDER BY node LIMIT ?', MAX_NODES).toArray().map((row) => this.view(row));
  }

  /**
   * Steps of `RANGES[range].step` ending at `end` (exclusive, aligned up to a step). Each point is the mean of the
   * 5-minute samples within its step (sums over counts) and their max. Null for an unknown node.
   */
  summarize(node: string, range: RangeName, end: number, metrics: readonly string[]): {
    start: number; end: number; step: number; series: SeriesView[];
  } | null {
    if (!this.nodeRow(node)) return null;
    const { tier, spanMs, step } = RANGES[range];
    const stepMs = step * 1000;
    const stop = Math.ceil(end / stepMs) * stepMs;
    const start = stop - Math.ceil(spanMs / stepMs) * stepMs;
    const rows = this.sql.exec<{ bucket: number; data: string }>(
      'SELECT bucket, data FROM metric_points WHERE node=? AND resolution=? AND bucket>=? AND bucket<? ORDER BY bucket',
      node, tier, start, stop,
    );
    const wanted = new Set(metrics);
    const series = new Map<string, Map<number, [number, number, number]>>();
    for (const row of rows) {
      const time = Math.floor(row.bucket / stepMs) * stepMs;
      for (const [key, [sum, count, max]] of Object.entries(JSON.parse(row.data) as Folded)) {
        if (wanted.size && !wanted.has(split(key).metric)) continue;
        let points = series.get(key);
        if (!points) series.set(key, points = new Map<number, [number, number, number]>());
        const point = points.get(time);
        points.set(time, point ? [point[0] + sum, point[1] + count, Math.max(point[2], max)] : [sum, count, max]);
      }
    }
    return {
      start, end: stop, step,
      series: orderKeys(series.keys()).map((key) => ({
        ...split(key),
        points: [...(series.get(key) ?? [])].map(([time, [sum, count, max]]) => ({
          time: iso(time), mean: round(key, sum / count), max,
        })),
      })),
    };
  }
}
