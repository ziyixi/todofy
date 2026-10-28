import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toWire } from '@ziyixi/proto/wire-json';
import type { FleetStatus } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_wire';
import { FleetStatusSchema, ListNodesResponseSchema } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_pb';
import { client } from './api.ts';
import { Overview } from './Overview.tsx';
import { ResourcesView } from './ResourcesView.tsx';
import './style.css';

type View = 'overview' | 'resources';
const TABS: readonly { view: View; hash: string; name: string }[] = [
  { view: 'overview', hash: '#/', name: '概览' },
  { view: 'resources', hash: '#/resources', name: '资源' },
];
const viewOf = (hash: string): View => (hash.startsWith('#/resources') ? 'resources' : 'overview');

/** Hash routing: no Worker route per view, and a reload keeps the tab. */
function useView(): View {
  const [view, setView] = useState(() => viewOf(window.location.hash));
  useEffect(() => {
    const update = (): void => setView(viewOf(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return view;
}

export function App() {
  const view = useView();
  const queryClient = useQueryClient();
  const fetching = useIsFetching() > 0;
  const status = useQuery({
    queryKey: ['fleetStatus'],
    queryFn: () => client.getFleetStatus({ name: 'fleetStatus' }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => toWire(ListNodesResponseSchema, await client.listNodes({})).nodes ?? [],
    refetchInterval: 60_000,
  });
  const snapshot: FleetStatus | null = status.data ? toWire(FleetStatusSchema, status.data) : null;
  const now = status.dataUpdatedAt || Date.now();

  return (
    <main>
      <header className="masthead">
        <div>
          <p className="eyebrow">PERSONAL CLOUD / FLEET</p>
          <h1>服务器与后台服务</h1>
          <p className="muted">GitHub 发布，Cloudflare 保存观测。这里显示状态，不远程执行命令。</p>
        </div>
        <button type="button" disabled={fetching} onClick={() => void queryClient.refetchQueries({ type: 'active' })}>
          刷新状态
        </button>
      </header>
      <nav className="tabs" aria-label="视图">
        {TABS.map((tab) => (
          <a key={tab.view} href={tab.hash} aria-current={view === tab.view ? 'page' : undefined}>{tab.name}</a>
        ))}
      </nav>
      {view === 'resources' ? (
        <ResourcesView nodes={nodes.data ?? []} loading={nodes.isPending} failed={nodes.isError} />
      ) : (
        <>
          {status.error && (
            <p role="alert">无法读取状态。登录过期时请刷新页面；旧观测不代表当前健康。</p>
          )}
          {!snapshot && !status.error && <p role="status">正在读取状态…</p>}
          {snapshot && <Overview view={snapshot} nodes={nodes.data} nodesError={nodes.isError} now={now} />}
        </>
      )}
      <footer>
        <a href={import.meta.env.VITE_HOME_URL}>返回 Home</a>
        {snapshot && <> · 监控版本 <code>{snapshot.build_sha || '本地开发'}</code></>}
      </footer>
    </main>
  );
}
