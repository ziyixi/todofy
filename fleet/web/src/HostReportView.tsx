import type { HostReport } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import { label, percent } from './format.ts';
import { RuntimeView } from './RuntimeView.tsx';

/** Snapshot metadata, rendered as text. Freshness is stated by the enclosing owner page. */
export function HostReportView({ report }: { report: HostReport }) {
  const { cluster, newsletter } = report;
  return (
    <>
      <section>
        <h2>系统 daemon</h2>
        <p>观察器版本：<code>{report.observer_source_sha ?? '未知'}</code></p>
        <div className="grid">
          {Object.entries(report.daemons).map(([name, daemon]) => (
            <article key={name}>
              <h3>{name}</h3>
              <strong>{label(daemon.state)}</strong>
            </article>
          ))}
        </div>
        <p>磁盘：{percent(report.disk_used_percent)} · 内存：{percent(report.memory_used_percent)}</p>
      </section>
      <section>
        <h2>k3s 与发布</h2>
        <p>
          集群：{label(cluster.state)} · Newsletter ready：
          {cluster.ready_count ?? '?'} / {cluster.desired_count ?? '?'}
        </p>
        <p>重启次数：{cluster.restart_count ?? '未知'}</p>
        <RuntimeView runtime={report.runtime} />
      </section>
      <section>
        <h2>Newsletter</h2>
        <p>{label(newsletter.state)} · 发布入口：{label(newsletter.drain_state)}</p>
        <dl>
          <dt>排队</dt><dd>{newsletter.queued_count ?? '未知'}</dd>
          <dt>进行中</dt><dd>{newsletter.inflight_count ?? '未知'}</dd>
          <dt>结果待对账</dt><dd>{newsletter.unknown_count ?? '未知'}</dd>
        </dl>
        <p>进程健康或 Pod 就绪不证明模型、Notion 或邮件操作成功；排空与冻结不自动恢复。</p>
      </section>
    </>
  );
}
