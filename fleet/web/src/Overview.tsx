import type { FleetStatus } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_wire';
import type { HostReport } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import type { Node } from '@ziyixi/proto/fleet/ui/v1/node_wire';
import { ago, bytes, bytesOf, duration, label, load, percent, rate, SHAPES, time, tone } from './format.ts';
import { HostReportView } from './HostReportView.tsx';
import { Mark } from './Mark.tsx';
import { labelsOf, latestValues, nodeFreshness, nodeKey, orderRoles, roleName } from './metrics.ts';

const NODE_STATES: Readonly<Record<string, string>> = {
  fresh: '指标及时', stale: '指标延迟', missing: '指标中断', never_seen: '尚无指标',
};

export function Overview({ view, nodes, nodesError, now }: {
  /** Undefined until the node list first answers, so an older-observer card never flashes in first. */
  view: FleetStatus; nodes: readonly Node[] | undefined; nodesError: boolean; now: number;
}) {
  const freshness = view.freshness ?? 'never_seen';
  const level = tone(freshness);
  const report = view.report ?? undefined;
  const settled = nodes !== undefined || nodesError;
  const legacy = report && settled && !nodes?.some((node) => node.name === `nodes/${report.host_key}`) ? report : undefined;
  return (
    <>
      <section className="status" aria-label="最近报告">
        <div className="status-head">
          <h2 className={`state ${level}`}><span aria-hidden="true">{SHAPES[level]} </span>{label(freshness)}</h2>
          <p>
            最后接收：{time(view.receive_time)}（{ago(view.receive_time, now)}） · 观测时间：
            {time(view.report?.observation_time)}
          </p>
        </div>
        {view.freshness !== 'fresh' && view.report && (
          <p role="status" className="notice">以下是历史观测，不能代表当前服务健康。</p>
        )}
        <p className="muted">报告中断可能是主机、网络、Tunnel 或监控身份异常，不能据此确定故障原因。</p>
        {nodes?.map((node) => <NodeSummary key={node.name} node={node} now={now} />)}
        {legacy && <NodeSummary report={legacy} reportFreshness={freshness} unread={nodesError} now={now} />}
        {nodesError && <p className="muted">节点指标暂时无法读取；以上主机状态不受影响。</p>}
      </section>
      {view.report && <HostReportView report={view.report} now={now} />}
      <section>
        <h2>最近状态变化</h2>
        {view.changes?.length ? (
          <ul className="changes">
            {view.changes.map((change, index) => (
              <li key={`${change.observation_time}-${index}`}>
                <time dateTime={change.observation_time}>{time(change.observation_time)}</time> <code>{change.code}</code>
              </li>
            ))}
          </ul>
        ) : <p>暂无记录</p>}
      </section>
    </>
  );
}

/**
 * One node's latest sample as tiles. A report without metrics (an older observer, or node metrics that could
 * not be read) keeps its two legacy percentages, as current as the report itself, and shows the rest as unknown.
 */
export function NodeSummary({ node, report, reportFreshness, unread = false, now }: {
  node?: Node; report?: HostReport; reportFreshness?: string; unread?: boolean; now: number;
}) {
  const values = latestValues(node);
  const get = (key: string): number | undefined => values.get(key);
  const freshness = node ? nodeFreshness(node.receive_time, now) : reportFreshness ?? 'never_seen';
  const cpuCount = node?.cpu_count ?? 0;
  const memoryUsed = get('memory_used_bytes');
  const memoryTotal = get('memory_total_bytes');
  const swapUsed = get('swap_used_bytes');
  const roles = orderRoles(labelsOf(values.keys(), 'filesystem_used_bytes'));
  const receive = get('network_receive_bytes_per_second');
  const transmit = get('network_transmit_bytes_per_second');
  const load1 = get('load_1m');
  const name = node ? nodeKey(node.name) : report?.host_key ?? '';
  return (
    <article className={freshness === 'fresh' ? 'node' : 'node dated'} aria-label={`节点 ${name}`}>
      <header>
        <h3>{name}</h3>
        {node ? (
          <p><Mark state={freshness} text={NODE_STATES[freshness]} /> · 样本 {time(node.sample_time)}（{ago(node.sample_time, now)}）</p>
        ) : unread
          ? <p><Mark state="unknown" text="指标暂时无法读取" /> · 只显示主机报告中的百分比</p>
          : <p><Mark state="unknown" text="未上报指标" /> · 观察器尚未发送节点数值</p>}
        <p className="uptime">{uptime(node, now)}</p>
      </header>
      <dl className="tiles">
        <div>
          <dt>CPU 使用率</dt>
          <dd className="value">{percent(get('cpu_percent'))}</dd>
          <dd>{cpuCount ? `${cpuCount} 核` : '核数未知'}{get('cpu_iowait_percent') != null ? ` · I/O 等待 ${percent(get('cpu_iowait_percent'))}` : ''}</dd>
          {node && get('cpu_percent') == null && <dd className="muted">需要同一次开机内的连续两份报告</dd>}
        </div>
        <div>
          <dt>内存</dt>
          {memoryUsed != null && memoryTotal ? <>
            <dd className="value">{bytesOf(memoryUsed, memoryTotal)}</dd>
            <dd><Meter value={(100 * memoryUsed) / memoryTotal} /> {percent((100 * memoryUsed) / memoryTotal)}{swapUsed != null ? ` · 交换 ${bytes(swapUsed)}` : ''}</dd>
          </> : <>
            <dd className="value">{percent(report?.memory_used_percent)}</dd>
            <dd>{report?.memory_used_percent != null ? '只有百分比' : '未上报'}</dd>
          </>}
        </div>
        <div className="disks">
          <dt>磁盘</dt>
          {roles.length ? roles.map((role) => {
            const used = get(`filesystem_used_bytes:${role}`) ?? 0;
            const total = used + (get(`filesystem_available_bytes:${role}`) ?? 0);
            const share = total > 0 ? (100 * used) / total : null;
            return (
              <dd key={role} className="disk">
                <span>{roleName(role)}</span>
                {share != null && <Meter value={share} />}
                <span>{percent(share)} · {bytesOf(used, total)}</span>
              </dd>
            );
          }) : <>
            <dd className="value">{percent(report?.disk_used_percent)}</dd>
            <dd>{report?.disk_used_percent != null ? '观察器卷，只有百分比' : '未上报'}</dd>
          </>}
        </div>
        <div>
          <dt>网络</dt>
          <dd className="value">{receive != null ? `↓ ${rate(receive)}` : '未知'}</dd>
          <dd>{transmit != null ? `↑ ${rate(transmit)}` : node ? '需要连续两份报告' : '未上报'}</dd>
        </div>
        <div>
          <dt>负载</dt>
          <dd className="value">{load(load1)}</dd>
          <dd>{load1 != null ? `5 分钟 ${load(get('load_5m'))} · 15 分钟 ${load(get('load_15m'))}` : '未上报'}</dd>
        </div>
      </dl>
    </article>
  );
}

/** Up to now while fresh; otherwise only as far as the last sample proves. */
function uptime(node: Node | undefined, now: number): string {
  const boot = Date.parse(node?.boot_time ?? '');
  if (!node?.boot_time || !Number.isFinite(boot)) return '运行时间：未知';
  const since = `（开机于 ${time(node.boot_time)}）`;
  if (nodeFreshness(node.receive_time, now) === 'fresh') return `运行时间：${duration((now - boot) / 1000)}${since}`;
  const sample = Date.parse(node.sample_time ?? '');
  return Number.isFinite(sample) && sample > boot
    ? `运行时间：截至最近样本已运行 ${duration((sample - boot) / 1000)}${since}`
    : `运行时间：未知${since}`;
}

/** Usage against capacity; the word and number beside it carry the meaning, the bar only reinforces it. */
function Meter({ value }: { value: number }) {
  const level = value >= 90 ? 'bad' : value >= 80 ? 'warn' : 'ok';
  return <span className={`meter ${level}`} aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></span>;
}
