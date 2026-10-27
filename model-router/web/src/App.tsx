import { Activity, FlaskConical, List, RefreshCw, Route } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api as defaultApi, type RouterApi } from './api'
import { defaultFilters } from './Filters'
import { Overview } from './Overview'
import { Playground, type PlaygroundDraft } from './Playground'
import { Requests } from './Requests'
import { Failure, Loading } from './components'
import './style.css'

function currentRoute() {
  const path = window.location.hash.replace(/^#\/?/, '')
  if (path === 'playground') return { tab: 'playground' as const }
  if (path === 'requests') return { tab: 'requests' as const }
  if (path.startsWith('requests/')) return { tab: 'requests' as const, name: path }
  return { tab: 'overview' as const }
}

const tabs = [
  { id: 'overview', label: '概览', Icon: Activity },
  { id: 'requests', label: '请求', Icon: List },
  { id: 'playground', label: 'Playground', Icon: FlaskConical },
] as const

export function App({ api = defaultApi }: { api?: RouterApi }) {
  const [route, setRoute] = useState(currentRoute)
  const [requestFilters, setRequestFilters] = useState(defaultFilters)
  const [overviewFilters, setOverviewFilters] = useState(defaultFilters)
  const [draft, setDraft] = useState<{ key: number; value: PlaygroundDraft }>({ key: 0, value: {} })
  const client = useQueryClient()
  const models = useQuery({ queryKey: ['router-models'], queryFn: () => api.listModels() })
  useEffect(() => {
    const update = () => setRoute(currentRoute())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  function selectRequest(name?: string) {
    window.location.hash = name ? `#/${name}` : '#/requests'
  }
  function copyToPlayground(value: PlaygroundDraft) {
    setDraft((current) => ({ key: current.key + 1, value }))
    window.location.hash = '#/playground'
  }
  function refresh() {
    if (route.tab === 'requests')
      setRequestFilters((current) => ({ ...current, toTime: new Date().toISOString() }))
    if (route.tab === 'overview')
      setOverviewFilters((current) => ({ ...current, toTime: new Date().toISOString() }))
    void client.invalidateQueries({ queryKey: ['router-models'] })
    void client.invalidateQueries({ queryKey: ['router-usage'] })
    if (route.name) void client.invalidateQueries({ queryKey: ['router-request', route.name] })
  }

  return (
    <div className="app-shell">
      <a
        href="#main"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('main')?.focus()
        }}
      >
        跳到主要内容
      </a>
      <header className="app-header">
        <a className="brand" href="#/overview">
          <span className="brand-mark">
            <Route size={20} aria-hidden="true" />
          </span>
          <span>
            ModelRouter<span className="brand-context">个人云</span>
          </span>
        </a>
        <div className="header-actions">
          <span className="small muted desktop-only">统一模型接口</span>
          <button className="icon-button" aria-label="刷新数据" title="刷新数据" onClick={refresh}>
            <RefreshCw size={17} />
          </button>
        </div>
      </header>
      <nav className="main-nav" aria-label="主导航">
        {tabs.map(({ id, label, Icon }) => (
          <a
            href={`#/${id}`}
            key={id}
            aria-current={route.tab === id ? 'page' : undefined}
            className={route.tab === id ? 'active' : ''}
          >
            <Icon size={17} aria-hidden="true" />
            {label}
          </a>
        ))}
      </nav>
      <main id="main" tabIndex={-1}>
        {models.isPending && <Loading>正在读取模型目录…</Loading>}
        {models.error && <Failure error={models.error} retry={() => void models.refetch()} />}
        {route.tab === 'overview' && (
          <Overview
            api={api}
            models={models.data ?? []}
            filters={overviewFilters}
            onFilter={setOverviewFilters}
            onRequest={selectRequest}
          />
        )}
        {route.tab === 'requests' && (
          <Requests
            key={requestFilters.toTime}
            api={api}
            models={models.data ?? []}
            filters={requestFilters}
            onFilter={setRequestFilters}
            selectedName={route.name}
            onSelect={selectRequest}
            onCopy={copyToPlayground}
          />
        )}
        {route.tab === 'playground' && (
          <>
            <div className="page-heading">
              <div>
                <p className="eyebrow">PLAYGROUND</p>
                <h1>试运行模型</h1>
                <p className="muted">通过同一接口发起一次推理，查看完整结果。</p>
              </div>
              <span className="retention-note">不会执行应用业务操作</span>
            </div>
            <Playground
              key={draft.key}
              api={api}
              models={models.data ?? []}
              initial={draft.value}
              onGenerated={() => {
                void client.invalidateQueries({ queryKey: ['router-requests'] })
                void client.invalidateQueries({ queryKey: ['router-usage'] })
              }}
            />
          </>
        )}
      </main>
      <footer className="app-footer">
        输入与输出保留 7 天，请求元数据保留 90 天。
        <span>API 费用与订阅 API 等价费用均为估算，不代表账单。</span>
      </footer>
    </div>
  )
}
