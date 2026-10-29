import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MouseEvent } from 'react';
import { RpcStatusError } from '@ziyixi/proto/http-client';
import type { Overview } from '@ziyixi/proto/newsletter/ui/v1/overview_wire';
import { read } from './api.ts';
import { SHAPES, short, time } from './format.ts';
import { BackupPage } from './Backup.tsx';
import { IssuesPage } from './Issues.tsx';
import { ModelsPage } from './Models.tsx';
import { attentionOf, OverviewPage } from './Overview.tsx';
import { IssuePage } from './Reader.tsx';
import { runHref, useRoute, type Route } from './route.ts';
import { RunPage } from './RunDetail.tsx';
import { RunsPage } from './Runs.tsx';
import { SourcesPage } from './Sources.tsx';
import './style.css';

/** What the console knows about its connection to Newsletter, from the overview read. */
export type Link = 'checking' | 'connected' | 'not_configured' | 'unavailable' | 'signed_out' | 'unreachable' | 'failed';

/**
 * The connection state of an overview read. The Worker answers NOT_CONFIGURED when it has no Newsletter origin or no
 * login to forward, UNAVAILABLE when Newsletter, its host or the tunnel does not answer, and UNAUTHORIZED when the
 * login it got is not the owner's. When fetch itself fails (a TypeError) the page cannot tell an expired Access login,
 * whose redirect to the login page the client refuses to follow, from a lost network, so it names both, as Home does.
 */
export function linkOf(pending: boolean, error: unknown): Link {
  if (pending) return 'checking';
  if (error === null || error === undefined) return 'connected';
  if (error instanceof RpcStatusError) {
    if (error.status.reason === 'NOT_CONFIGURED') return 'not_configured';
    if (error.status.reason === 'UNAVAILABLE') return 'unavailable';
    if (error.status.reason === 'UNAUTHORIZED') return 'signed_out';
    return 'failed';
  }
  return error instanceof TypeError ? 'unreachable' : 'failed';
}

/** Why a later overview read failed, in the notices' words, said above what the earlier read showed (as Home does). */
const FAILED_REFRESH: Readonly<Partial<Record<Link, string>>> = {
  not_configured: '控制台尚未接通 Newsletter',
  unavailable: '无法连接 Newsletter 服务',
  signed_out: '登录已过期，请刷新页面',
  unreachable: '无法连接控制台，或登录已过期',
};

type Tab = 'overview' | 'issues' | 'runs' | 'sources' | 'models' | 'backup';
/** The pages with a tab; an issue's own page belongs to 期刊 and a run's to 运行. */
const TABS: readonly { page: Tab; href: string; name: string }[] = [
  { page: 'overview', href: '#/', name: '概览' },
  { page: 'issues', href: '#/issues', name: '期刊' },
  { page: 'runs', href: '#/runs', name: '运行' },
  { page: 'sources', href: '#/sources', name: '来源' },
  { page: 'models', href: '#/models', name: '模型' },
  { page: 'backup', href: '#/backup', name: '备份' },
];
const tabOf = (route: Route): Tab => (route.page === 'issue' ? 'issues' : route.page === 'run' ? 'runs' : route.page);

function Notice({ link }: { link: Exclude<Link, 'connected'> }) {
  const fleet = <a href={import.meta.env.VITE_FLEET_URL}>Fleet</a>;
  const home = <a href={import.meta.env.VITE_HOME_URL}>Home</a>;
  switch (link) {
    case 'checking':
      return <p role="status" className="muted">正在连接 Newsletter…</p>;
    case 'not_configured':
      return (
        <>
          <h2><span className="mark none" aria-hidden="true">{SHAPES.none}</span>尚未接通</h2>
          <p>控制台已就位，但还不能把读取转给 Newsletter：它的地址未配置，或这次请求没有可以转交的登录。</p>
        </>
      );
    case 'unavailable':
      return (
        <>
          <h2><span className="mark bad" aria-hidden="true">{SHAPES.bad}</span>无法连接 Newsletter 服务</h2>
          <p>主机、隧道或正在进行的发布都会造成这种情况。Notion 中的备份仍可阅读。</p>
          <p className="muted">主机与发布状态见 {fleet}，各项服务见 {home}。</p>
        </>
      );
    case 'signed_out':
      return (
        <>
          <h2><span className="mark warn" aria-hidden="true">{SHAPES.warn}</span>登录已过期</h2>
          <p>请刷新页面，重新通过 Cloudflare Access 登录。</p>
        </>
      );
    case 'unreachable':
      return (
        <>
          <h2><span className="mark warn" aria-hidden="true">{SHAPES.warn}</span>无法连接控制台，或登录已过期</h2>
          <p>请检查网络后刷新页面；登录过期时，刷新会打开 Cloudflare Access 的登录页。</p>
        </>
      );
    case 'failed':
      return (
        <>
          <h2><span className="mark warn" aria-hidden="true">{SHAPES.warn}</span>无法读取</h2>
          <p>控制台未能读取 Newsletter 的回答，稍后再试。</p>
        </>
      );
  }
}

/**
 * The skip link moves focus to the page's content without following its href: the location hash names the page
 * (route.ts), and #main would read as the overview.
 */
function skipToMain(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  document.getElementById('main')?.focus();
}

function AttentionLine({ overview }: { overview: Overview }) {
  const attention = attentionOf(overview);
  return (
    <p className={`attention ${attention.tone}`} role="status">
      <span className="shape" aria-hidden="true">{SHAPES[attention.tone]}</span>
      <span className="attention-text">{attention.text}</span>
      {attention.run ? <a href={runHref(attention.run)}>查看运行 →</a> : null}
    </p>
  );
}

function Page({ route, overview }: { route: Route; overview: Overview }) {
  switch (route.page) {
    case 'overview':
      return <OverviewPage overview={overview} />;
    case 'issues':
      return <IssuesPage month={route.month} filter={route.filter} />;
    case 'issue':
      return <IssuePage key={route.id} id={route.id} view={route.view} />;
    case 'runs':
      return <RunsPage month={route.month} />;
    case 'run':
      return <RunPage key={route.id} id={route.id} />;
    case 'sources':
      return <SourcesPage />;
    case 'models':
      return <ModelsPage days={route.days} />;
    case 'backup':
      return <BackupPage />;
  }
}

export function App() {
  const route = useRoute();
  const queryClient = useQueryClient();
  const fetching = useIsFetching() > 0;
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: read.overview,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });
  const link = linkOf(overview.isPending && overview.fetchStatus !== 'idle', overview.data ? null : overview.error);
  // A failed refresh keeps the pages of the last good read; say so rather than show them as current.
  const failedRefresh = overview.data && overview.isRefetchError
    ? FAILED_REFRESH[linkOf(false, overview.error)] ?? '无法读取' : null;
  const generated = overview.data?.generate_time;
  const current = tabOf(route);

  return (
    <>
      <a className="skip" href="#main" onClick={skipToMain}>跳到正文</a>
      <header className="masthead">
        <div className="masthead-title">
          <p className="eyebrow"><span className="brand" aria-hidden="true" />PERSONAL CLOUD / NEWSLETTER</p>
          <h1>每日简报</h1>
          <p className="muted">记录以 Newsletter 的 SQLite 为准；Notion 是异步备份。</p>
        </div>
        <div className="actions">
          <button type="button" disabled={fetching} onClick={() => void queryClient.refetchQueries({ type: 'active' })}>
            {fetching ? '正在刷新' : '刷新'}
          </button>
          {generated ? <p className="muted">数据时间 <time dateTime={generated}>{time(generated)}</time></p> : null}
        </div>
      </header>
      {overview.data ? <AttentionLine overview={overview.data} /> : null}
      {failedRefresh ? (
        <p className="notice refresh-failed" role="status">
          刷新失败：{failedRefresh}。下方保留 {time(generated, true)} 读取的记录。
        </p>
      ) : null}
      <nav className="tabs" aria-label="页面">
        {TABS.map((tab) => (
          <a key={tab.page} href={tab.href} aria-current={tab.page === current ? 'page' : undefined}>{tab.name}</a>
        ))}
      </nav>
      <main id="main" tabIndex={-1}>
        {link === 'connected' && overview.data
          ? <Page route={route} overview={overview.data} />
          : <section className={`card state${link === 'unavailable' ? ' wide' : ''}`} aria-live="polite"><Notice link={link === 'connected' ? 'checking' : link} /></section>}
      </main>
      <footer>
        <a href={import.meta.env.VITE_HOME_URL}>返回 Home</a>
        <a href={import.meta.env.VITE_FLEET_URL}>Fleet</a>
        <span>引擎 <code>{short(overview.data?.engine_revision)}</code></span>
        <span>配置 <code>{short(overview.data?.config?.active_revision)}</code></span>
      </footer>
    </>
  );
}
