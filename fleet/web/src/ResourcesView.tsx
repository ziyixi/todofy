import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toWire } from '@ziyixi/proto/wire-json';
import type { Node } from '@ziyixi/proto/fleet/ui/v1/node_wire';
import {
  SummarizeNodeMetricsRequest_Range as Range,
  SummarizeNodeMetricsResponseSchema,
} from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_pb';
import { client } from './api.ts';
import { RANGE_LABELS, type RangeName } from './chart.ts';
import { bytes, time } from './format.ts';
import {
  filesystemPercent, labelsOf, lastValue, nodeKey, orderRoles, roleName, toGrid, type Grid,
} from './metrics.ts';
import { SERIES_COLORS, TableDetails, TimeChart, type ChartLine } from './TimeChart.tsx';

const RANGES: readonly RangeName[] = ['day', 'week', 'month', 'half_year', 'two_years'];
const RANGE_ENUM: Readonly<Record<RangeName, Range>> = {
  day: Range.DAY, week: Range.WEEK, month: Range.MONTH, half_year: Range.HALF_YEAR, two_years: Range.TWO_YEARS,
};
const STEP_NAMES: Readonly<Record<number, string>> = {
  300: '5 分钟', 3_600: '1 小时', 10_800: '3 小时', 86_400: '1 天', 259_200: '3 天',
};
const [C1, C2, C3, C4] = SERIES_COLORS;
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Per-node history: one summary request per node and range, every series at once (at most 730 rows read). */
export function ResourcesView({ nodes, loading }: { nodes: readonly Node[]; loading: boolean }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [range, setRange] = useState<RangeName>('day');
  const node = nodes.find((item) => item.name === chosen) ?? nodes[0];
  const query = useQuery({
    queryKey: ['nodeMetrics', node?.name, range],
    queryFn: async () => toWire(SummarizeNodeMetricsResponseSchema,
      await client.summarizeNodeMetrics({ name: node?.name ?? '', range: RANGE_ENUM[range] })),
    enabled: node !== undefined,
    placeholderData: keepPreviousData,
    // A new 5-minute point at most every report; focus changes do not re-read up to 730 rows.
    staleTime: 4 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  if (!node) {
    return (
      <section className="empty-state">
        <h2>{loading ? '正在读取节点…' : '尚未收到节点指标'}</h2>
        {!loading && <p>观察器开始上报 CPU、内存、磁盘与网络数值后，这里会显示每个节点的历史曲线。
          第一份报告只有内存、磁盘与负载；CPU 与网络速率需要同一次开机内的连续两份报告。</p>}
      </section>
    );
  }
  const grid = query.data ? toGrid(query.data) : null;
  return (
    <>
      <div className="filters">
        {nodes.length > 1 ? (
          <label className="node-select">节点
            <select value={node.name} onChange={(event) => setChosen(event.target.value)}>
              {nodes.map((item) => <option key={item.name} value={item.name}>{nodeKey(item.name)}</option>)}
            </select>
          </label>
        ) : <p className="node-name">节点 <strong>{nodeKey(node.name)}</strong></p>}
        <fieldset className="segmented">
          <legend className="visually-hidden">时间范围</legend>
          {RANGES.map((name) => (
            <label key={name}>
              <input type="radio" name="range" value={name} checked={range === name} onChange={() => setRange(name)} />
              <span>{RANGE_LABELS[name]}</span>
            </label>
          ))}
        </fieldset>
      </div>
      <p className="scope-note">
        {grid ? `步长 ${STEP_NAMES[grid.stepSeconds] ?? `${grid.stepSeconds} 秒`}，每点为步长内 5 分钟样本的均值${grid.stepSeconds > 300 ? '，悬停可见峰值' : ''}。` : ''}
        时间为本地时区（{ZONE}）。空白处表示没有数据，不代表为零。最近样本：{time(node.sample_time)}
      </p>
      {query.error && <p role="alert">无法读取指标历史。登录过期时请刷新页面。</p>}
      {!grid && !query.error && <p role="status">正在读取指标历史…</p>}
      {grid && (
        <div className={query.isPlaceholderData ? 'charts refreshing' : 'charts'} aria-busy={query.isFetching}>
          <NodeCharts grid={grid} range={range} node={node} />
        </div>
      )}
    </>
  );
}

function NodeCharts({ grid, range, node }: { grid: Grid; range: RangeName; node: Node }) {
  const line = (key: string, name: string, color: string): ChartLine => ({
    key, name, color, values: grid.mean.get(key) ?? [], max: grid.max.get(key),
  });
  const keys = [...grid.mean.keys()];
  const memoryTotal = lastValue(grid.mean.get('memory_total_bytes'));
  const swapTotal = lastValue(grid.mean.get('swap_total_bytes'));
  const roles = orderRoles(labelsOf(keys, 'filesystem_used_bytes'));
  const workloads = labelsOf(keys, 'workload_memory_bytes');
  const cpuCount = node.cpu_count ?? 0;
  return (
    <>
      <section className="chart-grid" aria-label="节点">
        <TimeChart title="CPU 使用率" subtitle={cpuCount ? `占全部 ${cpuCount} 核的 CPU 时间` : '占全部 CPU 时间'}
          unit="percent" grid={grid} range={range} floor={10} ceiling={100}
          lines={[line('cpu_percent', '使用', C1), line('cpu_iowait_percent', 'I/O 等待', C2)]} />
        <TimeChart title="负载" subtitle={cpuCount ? `${cpuCount} 核；持续高于核数表示排队` : undefined} unit="load" grid={grid} range={range}
          floor={1} reference={cpuCount ? { value: cpuCount, label: `${cpuCount} 核` } : undefined}
          lines={[line('load_1m', '1 分钟', C1), line('load_5m', '5 分钟', C2), line('load_15m', '15 分钟', C3)]} />
        <TimeChart title="内存" unit="bytes" grid={grid} range={range}
          subtitle={`总量 ${bytes(memoryTotal)}${swapTotal ? ` · 交换总量 ${bytes(swapTotal)}` : ' · 无交换空间'}`}
          reference={memoryTotal ? { value: memoryTotal, label: '总量' } : undefined}
          lines={[line('memory_used_bytes', '已用', C1), ...(swapTotal ? [line('swap_used_bytes', '交换已用', C2)] : [])]} />
        <TimeChart title="磁盘使用率" subtitle="已用 ÷（已用 + 可用），按数据集计算" unit="percent" grid={grid} range={range}
          floor={10} ceiling={100}
          lines={roles.map((role, i) => ({ key: role, name: roleName(role), color: SERIES_COLORS[i] ?? C4, values: filesystemPercent(grid, role) }))} />
        <TimeChart wide title="网络" subtitle="物理网卡合计速率" unit="bytes_per_second" grid={grid} range={range}
          lines={[line('network_receive_bytes_per_second', '接收', C1), line('network_transmit_bytes_per_second', '发送', C2)]} />
      </section>
      <section className="workloads" aria-labelledby="workloads-title">
        <h2 id="workloads-title">工作负载</h2>
        <p className="scope-note">按 Pod 的 app 标签或 CronJob 汇总；同一指标共用纵轴，便于比较。</p>
        {workloads.length ? (
          <>
            <Multiples title="CPU" metric="workload_cpu_cores" unit="cores" grid={grid} range={range} labels={workloads} />
            <Multiples title="内存" metric="workload_memory_bytes" unit="bytes" grid={grid} range={range} labels={workloads} />
          </>
        ) : <p className="muted">此范围内没有工作负载数据。</p>}
      </section>
    </>
  );
}

function Multiples({ title, metric, unit, grid, range, labels }: {
  title: string; metric: string; unit: 'cores' | 'bytes'; grid: Grid; range: RangeName; labels: readonly string[];
}) {
  const lines: ChartLine[] = labels.map((label) => ({
    key: label, name: label, color: C1, values: grid.mean.get(`${metric}:${label}`) ?? [], max: grid.max.get(`${metric}:${label}`),
  }));
  const shared = Math.max(0, ...lines.flatMap((item) => item.values.filter((v): v is number => v != null)));
  return (
    <div className="multiples">
      <h3>{title}</h3>
      <div className="multiples-grid">
        {lines.map((item) => (
          <TimeChart key={item.key} compact title={item.name} unit={unit} grid={grid} range={range} fixedMax={shared} lines={[item]} />
        ))}
      </div>
      <TableDetails title={`工作负载${title}`} unit={unit} grid={grid} range={range} lines={lines} />
    </div>
  );
}
