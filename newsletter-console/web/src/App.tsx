import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { client } from './api.ts';
import './style.css';

/** What the console knows about its connection to Newsletter, from the overview read. */
export type Link = 'checking' | 'connected' | 'not_configured' | 'unavailable' | 'signed_out' | 'unreachable' | 'failed';

/**
 * The connection state of an overview read. The Worker answers NOT_CONFIGURED until it forwards reads to Newsletter,
 * UNAVAILABLE when Newsletter, its host or the tunnel does not answer, and UNAUTHORIZED when the login it got is not
 * the owner's. When fetch itself fails (a TypeError) the page cannot tell an expired Access login, whose redirect to
 * the login page the client refuses to follow, from a lost network, so it names both, as Home does.
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

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

function State({ link }: { link: Link }) {
  switch (link) {
    case 'checking':
      return <p role="status" className="muted">正在连接 Newsletter…</p>;
    case 'connected':
      return (
        <>
          <h2><span className="mark ok" aria-hidden="true">●</span> 已连接 Newsletter</h2>
          <p>概览、期刊与运行页面随后上线。</p>
        </>
      );
    case 'not_configured':
      return (
        <>
          <h2><span className="mark unknown" aria-hidden="true">○</span> 尚未接通</h2>
          <p>控制台已就位，Newsletter 的只读接口尚未接通。</p>
          <p className="muted">
            接通后，这里按 Newsletter 的记录显示期刊正文、运行与失败、来源与配置版本、模型调用、投递，以及 Notion
            备份的同步状态。
          </p>
        </>
      );
    case 'unavailable':
      return (
        <>
          <h2><span className="mark bad" aria-hidden="true">■</span> 无法连接 Newsletter 服务</h2>
          <p>主机、隧道或正在进行的发布都会造成这种情况。Notion 中的备份仍可阅读。</p>
        </>
      );
    case 'signed_out':
      return (
        <>
          <h2><span className="mark warn" aria-hidden="true">▲</span> 登录已过期</h2>
          <p>请刷新页面，重新通过 Cloudflare Access 登录。</p>
        </>
      );
    case 'unreachable':
      return (
        <>
          <h2><span className="mark warn" aria-hidden="true">▲</span> 无法连接控制台，或登录已过期</h2>
          <p>请检查网络后刷新页面；登录过期时，刷新会打开 Cloudflare Access 的登录页。</p>
        </>
      );
    case 'failed':
      return (
        <>
          <h2><span className="mark warn" aria-hidden="true">▲</span> 无法读取</h2>
          <p>控制台未能读取 Newsletter 的回答，稍后再试。</p>
        </>
      );
  }
}

export function App() {
  const queryClient = useQueryClient();
  const fetching = useIsFetching() > 0;
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: () => client.getOverview({ name: 'overview' }),
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });
  const link = linkOf(overview.isPending && overview.fetchStatus !== 'idle', overview.error);
  const checked = Math.max(overview.dataUpdatedAt, overview.errorUpdatedAt);

  return (
    <>
      <a className="skip" href="#main">跳到正文</a>
      <header className="masthead">
        <div>
          <p className="eyebrow"><span className="brand" aria-hidden="true" />PERSONAL CLOUD / NEWSLETTER</p>
          <h1>每日简报</h1>
          <p className="muted">记录以 Newsletter 的 SQLite 为准；Notion 是异步备份。</p>
        </div>
        <div className="actions">
          <button type="button" disabled={fetching} onClick={() => void queryClient.refetchQueries({ type: 'active' })}>
            刷新
          </button>
          {checked > 0 && <p className="muted">检查于 <time dateTime={new Date(checked).toISOString()}>{clock.format(checked)}</time></p>}
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <section className="state" aria-live="polite">
          <State link={link} />
        </section>
      </main>
      <footer>
        <a href={import.meta.env.VITE_HOME_URL}>返回 Home</a>
      </footer>
    </>
  );
}
