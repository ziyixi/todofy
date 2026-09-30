import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OverviewResponse } from '../../worker/src/api-types.ts'
import { ApiError } from './api/client'
import { useOverview, useRefresh } from './api/queries'
import { ActionsSection } from './components/ActionsSection'
import { AppCard } from './components/AppCard'
import { CanarySection } from './components/CanarySection'
import { DigestSection } from './components/DigestSection'
import { QuotaSection } from './components/QuotaSection'
import { StatusBanner } from './components/StatusBanner'
import { Button, Notice, Time, useNow } from './components/ui'
import { browserTimeZone, formatClockSeconds, formatRelative } from './lib/format'

const SECTIONS = [
  ['apps', '应用'],
  ['quota', '用量'],
  ['canary', '金丝雀'],
  ['actions', '操作'],
  ['digest', '摘要'],
] as const

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.requestId ? `${error.message}（请求 ${error.requestId}）` : error.message
  return '加载失败，请稍后重试'
}

export function App() {
  const overview = useOverview()
  const now = useNow()
  const data = overview.data
  const loaded = data !== undefined

  // A link to a section (#canary) arrives before the data; scroll once the sections exist.
  useEffect(() => {
    if (!loaded || !window.location.hash) return
    const id = window.location.hash.slice(1)
    if (/^[a-z-]+$/.test(id)) document.getElementById(id)?.scrollIntoView?.()
  }, [loaded])

  return (
    <>
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <h1>运维面板</h1>
            <span className="small muted">Mail Hero · Todofy · Cloudflare</span>
          </div>
          {data ? <RefreshControl overview={data} now={now} /> : null}
        </div>
        {data ? (
          <nav className="section-nav" aria-label="页面部分">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`}>
                {label}
              </a>
            ))}
          </nav>
        ) : null}
      </header>

      <main id="main" tabIndex={-1} aria-busy={overview.isFetching}>
        {overview.isPending ? (
          <p className="loading" role="status">
            正在加载…
          </p>
        ) : null}
        {overview.isError && !data ? (
          <div className="load-error">
            <Notice tone="danger" alert>
              无法加载运维数据：{errorMessage(overview.error)}
            </Notice>
            <Button onClick={() => void overview.refetch()}>重试</Button>
          </div>
        ) : null}
        {data ? (
          <>
            {overview.isError ? (
              <Notice tone="warn" alert>
                自动更新失败：{errorMessage(overview.error)}。下面显示的是 {formatRelative(data.generated_at, now)} 的数据。
              </Notice>
            ) : null}
            <Dashboard overview={data} now={now} />
          </>
        ) : null}
      </main>

      <footer className="footer small muted">
        <span>时间按浏览器时区（{browserTimeZone()}）显示</span>
        {data ? <span>版本 {data.build.slice(0, 12)}</span> : null}
      </footer>
    </>
  )
}

function Dashboard({ overview, now }: { overview: OverviewResponse; now: Date }) {
  return (
    <div className="layout">
      <StatusBanner overview={overview} now={now} />
      <section id="apps" className="apps" aria-label="应用">
        <AppCard card={overview.apps['mail-hero']} guard={overview.guard.apps['mail-hero']} now={now} />
        <AppCard card={overview.apps.todofy} guard={overview.guard.apps.todofy} now={now} />
      </section>
      <QuotaSection usage={overview.usage} now={now} />
      <div className="columns">
        <CanarySection canary={overview.canary} now={now} />
        <div className="stack">
          <ActionsSection overview={overview} now={now} />
          <DigestSection digest={overview.digest} now={now} />
        </div>
      </div>
    </div>
  )
}

function RefreshControl({ overview, now }: { overview: OverviewResponse; now: Date }) {
  const refresh = useRefresh()
  const [message, setMessage] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const nextAt = new Date(overview.refresh.next_refresh_at).getTime()
  const waiting = nextAt > Math.max(clock, now.getTime())

  // Re-enable the button exactly when the Worker's one-per-minute refresh window opens.
  useEffect(() => {
    const delay = nextAt - Date.now()
    if (delay <= 0) return
    const timer = window.setTimeout(() => setClock(Date.now()), delay + 50)
    return () => window.clearTimeout(timer)
  }, [nextAt])

  function run() {
    setMessage(null)
    refresh.mutate(undefined, {
      onSuccess: (fresh) => setMessage(fresh.refresh.refreshed ? '已刷新。' : '距上次刷新不足 1 分钟，显示的是缓存数据。'),
      onError: (error) => setMessage(`刷新失败：${errorMessage(error)}`),
    })
  }

  return (
    <div className="refresh">
      <div className="refresh-row">
        <Button onClick={run} disabled={refresh.isPending || waiting} aria-describedby="refresh-note">
          <RefreshCw size={16} aria-hidden="true" className={refresh.isPending ? 'spin' : undefined} />
          {refresh.isPending ? '正在刷新…' : '刷新'}
        </Button>
        <span id="refresh-note" className="small muted">
          {waiting ? (
            <>{formatClockSeconds(overview.refresh.next_refresh_at)} 后可再次刷新</>
          ) : (
            <>
              数据生成于 <Time iso={overview.generated_at} now={now} relative={false} />
            </>
          )}
        </span>
      </div>
      <p className="small refresh-message" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  )
}
