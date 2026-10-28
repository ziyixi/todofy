/** The owner API's node telemetry, shaped for the views. Names are the API's; nothing is invented here. */
import type { MetricSeries, Node } from '@ziyixi/proto/fleet/ui/v1/node_wire';
import type { SummarizeNodeMetricsResponse } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_wire';

/** The server's freshness rule (worker/src/report.ts): fresh up to 10 minutes, stale up to 20, then missing. */
const FRESH_MS = 10 * 60_000;
const MISSING_MS = 20 * 60_000;
export function nodeFreshness(receiveTime: string | undefined, now: number): 'fresh' | 'stale' | 'missing' | 'never_seen' {
  if (!receiveTime) return 'never_seen';
  const age = Math.max(0, now - Date.parse(receiveTime));
  return age <= FRESH_MS ? 'fresh' : age <= MISSING_MS ? 'stale' : 'missing';
}

export const nodeKey = (name: string | undefined): string => (name ?? '').replace(/^nodes\//, '');

/** Series key as the Worker forms it: `metric` or `metric:label`. */
const key = (metric: string | undefined, label: string | undefined): string => (label ? `${metric ?? ''}:${label}` : metric ?? '');

/** The latest sample as a lookup; absent values stay absent. */
export function latestValues(node: Node | undefined): ReadonlyMap<string, number> {
  return new Map((node?.latest_values ?? []).map((item) => [key(item.metric, item.label), item.value ?? 0]));
}
/** Labels present for a labelled metric (filesystem roles, workload keys), sorted. */
export function labelsOf(keys: Iterable<string>, metric: string): string[] {
  const prefix = `${metric}:`;
  return [...new Set([...keys].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)))].sort();
}

/** Filesystem roles the observer reports, in a fixed order so a role keeps its colour. */
export const FILESYSTEM_ROLES: readonly string[] = ['root', 'k3s', 'state'];
const ROLE_NAMES: Readonly<Record<string, string>> = { root: '系统', k3s: 'k3s 数据', state: '观察器状态' };
export const roleName = (role: string): string => ROLE_NAMES[role] ?? role;
export function orderRoles(roles: readonly string[]): string[] {
  const rank = (role: string): number => {
    const index = FILESYSTEM_ROLES.indexOf(role);
    return index < 0 ? FILESYSTEM_ROLES.length : index;
  };
  return [...roles].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** A summary on a fixed step grid: every series is an array over the steps, null where the step has no data. */
export interface Grid {
  readonly start: number;
  readonly end: number;
  readonly stepSeconds: number;
  readonly count: number;
  readonly mean: ReadonlyMap<string, readonly (number | null)[]>;
  readonly max: ReadonlyMap<string, readonly (number | null)[]>;
}

export function toGrid(response: SummarizeNodeMetricsResponse): Grid | null {
  const start = Date.parse(response.start_time ?? '');
  const end = Date.parse(response.end_time ?? '');
  const stepSeconds = response.step_seconds ?? 0;
  if (!Number.isFinite(start) || !Number.isFinite(end) || stepSeconds <= 0 || end <= start) return null;
  const count = Math.round((end - start) / (stepSeconds * 1000));
  const mean = new Map<string, (number | null)[]>();
  const max = new Map<string, (number | null)[]>();
  for (const series of response.series ?? []) addSeries(series);
  return { start, end, stepSeconds, count, mean, max };

  function addSeries(series: MetricSeries): void {
    const means: (number | null)[] = new Array<number | null>(count).fill(null);
    const maxes: (number | null)[] = new Array<number | null>(count).fill(null);
    for (const point of series.points ?? []) {
      const index = Math.round((Date.parse(point.time ?? '') - start) / (stepSeconds * 1000));
      if (index >= 0 && index < count) {
        means[index] = point.mean ?? 0;
        maxes[index] = point.max ?? point.mean ?? 0;
      }
    }
    mean.set(key(series.metric, series.label), means);
    max.set(key(series.metric, series.label), maxes);
  }
}

/** used / (used + available) per step; a step missing either side is a gap. */
export function filesystemPercent(grid: Grid, role: string): (number | null)[] {
  const used = grid.mean.get(`filesystem_used_bytes:${role}`) ?? [];
  const available = grid.mean.get(`filesystem_available_bytes:${role}`) ?? [];
  return Array.from({ length: grid.count }, (_, i) => {
    const u = used[i];
    const a = available[i];
    return u == null || a == null || u + a <= 0 ? null : (100 * u) / (u + a);
  });
}

export const lastValue = (values: readonly (number | null)[] | undefined): number | null => {
  for (let i = (values?.length ?? 0) - 1; i >= 0; i -= 1) {
    const value = values?.[i];
    if (value != null) return value;
  }
  return null;
};
