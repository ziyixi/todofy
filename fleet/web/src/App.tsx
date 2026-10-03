import { useQuery } from '@tanstack/react-query';
import { toWire } from '@ziyixi/proto/wire-json';
import type { FleetStatus } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_wire';
import { FleetStatusSchema } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_pb';
import { client } from './api.ts';
import { HostReportView } from './HostReportView.tsx';
import { label, time } from './format.ts';
import './style.css';

function Snapshot({ view }: { view: FleetStatus }) {
  return (
    <>
      <section aria-label="最近报告">
        <h2>{label(view.freshness ?? 'never_seen')}</h2>
        <p>
          最后接收：{time(view.receive_time)} · 观测时间：
          {time(view.report?.observation_time)}
        </p>
        {view.freshness !== 'fresh' && view.report && (
          <p role="status">以下是历史观测，不能代表当前服务健康。</p>
        )}
        <p>报告中断可能是主机、网络、Tunnel 或监控身份异常，不能据此确定故障原因。</p>
      </section>
      {view.report && <HostReportView report={view.report} />}
      <section>
        <h2>最近状态变化</h2>
        {view.changes?.length ? (
          <ul>
            {view.changes.map((change, index) => (
              <li key={`${change.observation_time}-${index}`}>
                <time>{time(change.observation_time)}</time> <code>{change.code}</code>
              </li>
            ))}
          </ul>
        ) : <p>暂无记录</p>}
      </section>
      <footer>监控版本 <code>{view.build_sha || '本地开发'}</code></footer>
    </>
  );
}

export function App() {
  const query = useQuery({
    queryKey: ['fleetStatus'],
    queryFn: () => client.getFleetStatus({ name: 'fleetStatus' }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const view: FleetStatus | null = query.data
    ? toWire(FleetStatusSchema, query.data)
    : null;

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">PERSONAL CLOUD / FLEET</p>
          <h1>服务器与后台服务</h1>
          <p>GitHub 发布，Cloudflare 保存观测。这里显示状态，不远程执行命令。</p>
        </div>
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >刷新状态</button>
      </header>
      {query.error && (
        <p role="alert">无法读取状态。登录过期时请刷新页面；旧观测不代表当前健康。</p>
      )}
      {!view && !query.error && <p role="status">正在读取状态…</p>}
      {view && <Snapshot view={view} />}
    </main>
  );
}
