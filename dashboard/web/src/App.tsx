import { Cloud, Gauge, House, RefreshCw, Settings2, Workflow, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { HomeView as HomeViewData, ShellFields, ViewId } from '../../worker/src/api-types.ts'
import { ApiError } from './api/client'
import { useRefreshHome, useRegistry, useView } from './api/queries'
import { AttentionStrip } from './components/AttentionStrip'
import { AttentionFeedback, AttentionProvider } from './components/AttentionActions'
import { Button, Notice, useNow } from './components/ui'
import { browserTimeZone, formatRelative, refreshDeclinedText, refreshWaitText } from './lib/format'
import { routeHash, useRoute } from './router'
import { CloudflareView } from './views/CloudflareView'
import { FlowsView } from './views/FlowsView'
import { HomeView } from './views/HomeView'
import { OpsView } from './views/OpsView'

interface Tab {
  readonly view: ViewId
  readonly label: string
  /** The part of the label a phone's bottom bar leaves out. */
  readonly longTail?: string
  readonly icon: LucideIcon
}

/** The four views (docs/design-v2.md §1): a tab row on desktop, a fixed bottom bar on a phone. */
const TABS: readonly Tab[] = [
  { view: 'home', label: '首页', icon: House },
  { view: 'flows', label: '业务流程', icon: Workflow },
  { view: 'cloudflare', label: 'Cloudflare', longTail: ' 监控', icon: Cloud },
  { view: 'ops', label: '操作与记录', icon: Settings2 },
]

function tabName(view: ViewId): string {
  const tab = TABS.find((item) => item.view === view)
  return tab ? `${tab.label}${tab.longTail ?? ''}` : ''
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.requestId ? `${error.message}（请求 ${error.requestId}）` : error.message
  return '加载失败，请稍后重试'
}

/** When the shown data was last produced by a tick or an owner refresh. */
function dataAt(shell: ShellFields): string | null {
  const { last_tick_at: tick, last_refresh_at: refresh } = shell.refresh
  if (tick && refresh) return new Date(tick) > new Date(refresh) ? tick : refresh
  return tick ?? refresh
}

export function App() {
  const route = useRoute()
  const now = useNow()
  const registry = useRegistry()
  const home = useView('home', route.view === 'home')
  const flows = useView('flows', route.view === 'flows')
  const cloudflare = useView('cloudflare', route.view === 'cloudflare')
  const ops = useView('ops', route.view === 'ops')
  const active = { home, flows, cloudflare, ops }[route.view]
  const shell: ShellFields | undefined = active.data
  const main = useRef<HTMLElement>(null)
  const firstView = useRef(true)

  useEffect(() => {
    document.title = route.view === 'home' ? '个人控制台' : `${tabName(route.view)} · 个人控制台`
    if (firstView.current) {
      firstView.current = false
      return
    }
    // A tab change is a page change for keyboard and screen-reader users: start at the new view.
    main.current?.focus({ preventScroll: true })
    window.scrollTo?.({ top: 0 })
  }, [route.view])

  function skipToMain(event: MouseEvent<HTMLAnchorElement>) {
    // The hash is the router's: move focus without changing it.
    event.preventDefault()
    main.current?.focus()
  }

  return (
    <AttentionProvider attention={shell?.attention}>
      <a className="skip-link" href="#main" onClick={skipToMain}>
        跳到主要内容
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <Gauge size={22} aria-hidden="true" className="brand-icon" />
            <span className="brand-name">个人控制台</span>
          </div>
          <nav className="tabs" aria-label="视图">
            {TABS.map((tab) => {
              const current = route.view === tab.view
              const badge = shell?.badges[tab.view] ?? 0
              const Icon = tab.icon
              return (
                <a key={tab.view} className="tab" href={routeHash({ view: tab.view })} aria-current={current ? 'page' : undefined}>
                  <span className="tab-icon-wrap">
                    <Icon size={20} aria-hidden="true" className="tab-icon" />
                    {badge > 0 ? (
                      <span className="tab-badge" aria-hidden="true">
                        {badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="tab-label" aria-hidden="true">
                    {tab.label}
                    {tab.longTail ? <span className="tab-long">{tab.longTail}</span> : null}
                  </span>
                  <span className="visually-hidden">
                    {tabName(tab.view)}
                    {badge > 0 ? `，${badge} 项需关注` : ''}
                  </span>
                </a>
              )
            })}
          </nav>
          <TopRefresh shell={shell} home={home.data} now={now} />
        </div>
      </header>

      <AttentionFeedback />
      <main id="main" ref={main} tabIndex={-1} aria-busy={active.isFetching}>
        {registry.isPending ? <ViewLoading /> : null}
        {registry.isError && !registry.data ? (
          <div className="load-error">
            <Notice tone="danger" alert>
              无法加载页面配置：{errorMessage(registry.error)}
            </Notice>
            <Button onClick={() => void registry.refetch()}>重试</Button>
          </div>
        ) : null}
        {registry.data ? (
          <>
            {shell ? <AttentionStrip key={route.view} reg={registry.data} shell={shell} now={now} /> : null}
            {active.isError && active.data ? (
              <Notice tone="warn" alert>
                自动更新失败：{errorMessage(active.error)}。下面显示的是 {formatRelative(active.data.generated_at, now)} 的数据。
              </Notice>
            ) : null}
            {active.isError && !active.data ? (
              <div className="load-error">
                <Notice tone="danger" alert>
                  无法加载{tabName(route.view)}数据：{errorMessage(active.error)}
                </Notice>
                <Button onClick={() => void active.refetch()}>重试</Button>
              </div>
            ) : null}
            {route.view === 'home' ? (
              <HomeView registry={registry.data} home={home.data} failed={home.isError && !home.data} now={now} />
            ) : active.isPending ? (
              <ViewLoading />
            ) : null}
            {route.view === 'flows' && flows.data ? <FlowsView registry={registry.data} flows={flows.data} focus={route.flow} focusStage={route.stage} now={now} /> : null}
            {route.view === 'cloudflare' && cloudflare.data ? (
              <CloudflareView registry={registry.data} cloudflare={cloudflare.data} focus={route.script} now={now} />
            ) : null}
            {route.view === 'ops' && ops.data ? <OpsView registry={registry.data} ops={ops.data} now={now} /> : null}
          </>
        ) : null}
      </main>

      <footer className="footer small muted">
        <span>时区：浏览器本地（{browserTimeZone()}）</span>
        {registry.data ? <span>构建 {registry.data.build.slice(0, 7)}</span> : null}
        <span>用量为整个 Cloudflare 账户</span>
      </footer>
    </AttentionProvider>
  )
}

function ViewLoading() {
  return (
    <div className="view-loading" role="status">
      <span className="visually-hidden">正在加载</span>
      <div className="skeleton-block" aria-hidden="true" />
      <div className="skeleton-block" aria-hidden="true" />
    </div>
  )
}

/**
 * 刷新: re-reads the app statuses and probes now (RefreshHomeView, which the Worker answers with fresh
 * data at most once a minute), then the visible view. Disabled until the Worker's window opens.
 */
function TopRefresh({ shell, home, now }: { shell: ShellFields | undefined; home: HomeViewData | undefined; now: Date }) {
  const refresh = useRefreshHome()
  const [message, setMessage] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const nextAt = home ? new Date(home.refresh.next_refresh_at).getTime() : 0
  const waiting = nextAt > Math.max(clock, now.getTime())
  const at = shell ? dataAt(shell) : null

  // Re-enable the button exactly when the Worker's one-per-minute refresh window opens.
  useEffect(() => {
    const delay = nextAt - Date.now()
    if (delay <= 0) return
    const timer = window.setTimeout(() => setClock(Date.now()), delay + 50)
    return () => window.clearTimeout(timer)
  }, [nextAt])

  const wait = waiting && home ? refreshWaitText(home.refresh.next_refresh_at, new Date(Math.max(clock, now.getTime()))) : null

  function run() {
    // Inside the Worker's window the button stays focusable and says why nothing happens.
    if (wait !== null) {
      setMessage(`${wait}。`)
      return
    }
    setMessage(null)
    refresh.mutate(undefined, {
      onSuccess: (fresh) => setMessage(fresh.refresh.refreshed ? '已刷新。' : refreshDeclinedText(fresh.refresh.next_refresh_at, new Date())),
      onError: (error) => setMessage(`刷新失败：${errorMessage(error)}`),
    })
  }

  return (
    <div className="top-refresh">
      {/* The data age is always shown (design §3.4: the strip does not repeat it). */}
      <span id="refresh-note" className="small muted top-age">
        {at ? (
          <>
            <span className="top-age-word">数据 </span>
            <time dateTime={at}>{formatRelative(at, now)}</time>
          </>
        ) : null}
      </span>
      {wait !== null ? (
        <span id="refresh-wait" className="visually-hidden">
          {wait}
        </span>
      ) : null}
      <Button
        onClick={run}
        disabled={refresh.isPending}
        aria-disabled={wait !== null ? true : undefined}
        aria-label="刷新"
        aria-describedby={wait !== null ? 'refresh-note refresh-wait' : 'refresh-note'}
        title={wait ?? undefined}
        className="btn-refresh"
      >
        <RefreshCw size={16} aria-hidden="true" className={refresh.isPending ? 'spin' : undefined} />
        <span className="btn-refresh-label">{refresh.isPending ? '正在刷新…' : '刷新'}</span>
      </Button>
      <p className="small refresh-message" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  )
}
