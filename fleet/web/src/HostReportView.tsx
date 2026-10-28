import type { HostReport } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import { daemonLabel, label, percent, time } from './format.ts';
import { Mark } from './Mark.tsx';
import { RuntimeView } from './RuntimeView.tsx';

const CATEGORY_NAMES: Record<string, string> = {
  interrupted_activities: '运行中断', packets: '采编记录',
  workflow_attempts: '工作流步骤', notion_entities: 'Notion 创建',
  notion_versions: 'Notion 更新', delivery: '邮件投递',
};
const DELIVERY_NAMES: Record<string, string> = {
  provider_accepted: '邮件服务已接收', rejected: '邮件服务拒绝', unknown: '结果尚未确认',
};

/** Snapshot metadata, rendered as text. Freshness is stated by the enclosing owner page. */
export function HostReportView({ report }: { report: HostReport }) {
  const { cluster, newsletter } = report;
  const workerHealth = newsletter.worker_healthy === true ? '健康' : newsletter.worker_healthy === false ? '异常' : '未知';
  const delivery = newsletter.latest_delivery_state;
  return (
    <>
      <div className="pair">
        <section>
          <h2>系统 daemon</h2>
          <ul className="states">
            {Object.entries(report.configured_daemons ?? report.daemons).map(([name, daemon]) => (
              <li key={name}><span>{name}</span><Mark state={daemon.state} text={daemonLabel(daemon.state)} /></li>
            ))}
          </ul>
          <p className="muted">观察器版本：<code>{report.observer_source_sha ?? '未知'}</code></p>
          <p className="muted">报告百分比：磁盘（观察器卷）{percent(report.disk_used_percent)} · 内存 {percent(report.memory_used_percent)}</p>
        </section>
        <section>
          <h2>k3s 集群</h2>
          <ul className="states">
            <li><span>集群</span><Mark state={cluster.state} /></li>
            <li><span>Newsletter ready</span><strong>{cluster.ready_count ?? '?'} / {cluster.desired_count ?? '?'}</strong></li>
            <li><span>重启次数</span><strong>{cluster.restart_count ?? '未知'}</strong></li>
          </ul>
        </section>
      </div>
      <section>
        <h2>发布与运行时</h2>
        <RuntimeView runtime={report.runtime} />
      </section>
      <section>
        <h2>Newsletter</h2>
        <p>后台进程：{workerHealth} · 发布入口：{label(newsletter.drain_state)}</p>
        <dl className="counts">
          <div><dt>排队</dt><dd>{newsletter.queued_count ?? '未知'}</dd></div>
          <div><dt>进行中</dt><dd>{newsletter.inflight_count ?? '未知'}</dd></div>
          <div><dt>未确认完成记录</dt><dd>{newsletter.unknown_count ?? '未知'}</dd></div>
        </dl>
        {delivery
          ? <p>最近投递记录：{DELIVERY_NAMES[delivery]} · 更新于 <time dateTime={newsletter.latest_delivery_time}>{time(newsletter.latest_delivery_time)}</time></p>
          : <p>最近投递记录：暂未取得</p>}
        {newsletter.unknown_by_kind ? (
          <dl className="counts small">
            {Object.entries(newsletter.unknown_by_kind).map(([kind, count]) => <div key={kind}><dt>{CATEGORY_NAMES[kind] ?? kind}</dt><dd>{count}</dd></div>)}
          </dl>
        ) : null}
        <p className="muted">六类记录可能重复计入，合计并非失败邮件数；只有邮件投递、采编记录和 Notion 写入可能已产生实际结果，需要核对。</p>
      </section>
    </>
  );
}
