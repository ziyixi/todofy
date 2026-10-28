/** Synthetic node telemetry in the owner API's wire JSON. Never production values. */
const GIB = 1024 ** 3;

export const NODE = {
  name: 'nodes/vps',
  sample_time: '2026-10-03T00:05:00Z',
  receive_time: '2026-10-03T00:05:02Z',
  boot_time: '2026-10-01T00:05:00Z',
  cpu_count: 4,
  latest_values: [
    { metric: 'cpu_percent', value: 12.5 },
    { metric: 'cpu_iowait_percent', value: 0.4 },
    { metric: 'load_1m', value: 0.42 },
    { metric: 'load_5m', value: 0.5 },
    { metric: 'load_15m', value: 0.48 },
    { metric: 'memory_used_bytes', value: 6 * GIB },
    { metric: 'memory_total_bytes', value: 16 * GIB },
    { metric: 'swap_used_bytes', value: 0 },
    { metric: 'swap_total_bytes', value: 4 * GIB },
    { metric: 'network_receive_bytes_per_second', value: 1.5 * 1024 * 1024 },
    { metric: 'network_transmit_bytes_per_second', value: 200 * 1024 },
    { metric: 'filesystem_used_bytes', label: 'k3s', value: 45 * GIB },
    { metric: 'filesystem_used_bytes', label: 'root', value: 5 * GIB },
    { metric: 'filesystem_available_bytes', label: 'k3s', value: 455 * GIB },
    { metric: 'filesystem_available_bytes', label: 'root', value: 455 * GIB },
    { metric: 'workload_cpu_cores', label: 'newsletter', value: 0.015 },
    { metric: 'workload_memory_bytes', label: 'newsletter', value: 0.25 * GIB },
  ],
};

/** A 24-hour summary ending at `end` with every series; `gap` steps (indices) are left out. */
export function daySummary(end = Date.parse('2026-10-03T00:05:00Z'), gap: readonly number[] = []) {
  const step = 300;
  const start = end - 288 * step * 1000;
  const wave = (i: number, base: number, swing: number): number => base + swing * Math.sin(i / 20);
  const series = (metric: string, value: (i: number) => number, label?: string) => ({
    metric,
    ...(label ? { label } : {}),
    points: Array.from({ length: 288 }, (_, i) => i)
      .filter((i) => !gap.includes(i))
      .map((i) => ({ time: new Date(start + i * step * 1000).toISOString(), mean: value(i), max: value(i) })),
  });
  return {
    name: 'nodes/vps',
    range: 'day' as const,
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    step_seconds: step,
    series: [
      series('cpu_percent', (i) => wave(i, 12, 6)),
      series('cpu_iowait_percent', (i) => wave(i, 0.5, 0.3)),
      series('load_1m', (i) => wave(i, 0.5, 0.3)),
      series('load_5m', (i) => wave(i, 0.5, 0.2)),
      series('load_15m', (i) => wave(i, 0.5, 0.1)),
      series('memory_used_bytes', (i) => wave(i, 6 * GIB, GIB)),
      series('memory_total_bytes', () => 16 * GIB),
      series('swap_used_bytes', () => 0),
      series('swap_total_bytes', () => 4 * GIB),
      series('network_receive_bytes_per_second', (i) => wave(i, 1024 * 1024, 512 * 1024)),
      series('network_transmit_bytes_per_second', (i) => wave(i, 200 * 1024, 100 * 1024)),
      series('filesystem_used_bytes', () => 45 * GIB, 'k3s'),
      series('filesystem_used_bytes', () => 5 * GIB, 'root'),
      series('filesystem_available_bytes', () => 455 * GIB, 'k3s'),
      series('filesystem_available_bytes', () => 455 * GIB, 'root'),
      series('workload_cpu_cores', (i) => wave(i, 0.015, 0.01), 'newsletter'),
      series('workload_cpu_cores', () => 0.004, 'platform-runtime'),
      series('workload_memory_bytes', () => 0.25 * GIB, 'newsletter'),
      series('workload_memory_bytes', () => 0.07 * GIB, 'platform-runtime'),
    ],
  };
}
