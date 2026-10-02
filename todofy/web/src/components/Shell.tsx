import { AlarmClock, BellRing, Ellipsis, Gauge, HeartPulse, Inbox, ListChecks, Newspaper, Settings, TriangleAlert } from 'lucide-react'
import type { ComponentType } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { ApiError } from '../api/client'
import { useOverview } from '../api/queries'
import { StatusBanner } from './StatusBanner'

interface NavItem {
  to: string
  label: string
  Icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
  description?: string
}

const ATTENTION: NavItem = { to: '/attention', label: '关注', Icon: BellRing }
const EVENTS: NavItem = { to: '/events', label: '事件', Icon: Inbox }
const DIGEST: NavItem = { to: '/digest', label: '日报', Icon: Newspaper }
export const MORE_ITEMS: NavItem[] = [
  { to: '/reminders', label: '提醒', Icon: AlarmClock, description: '每个 UTC 日的 Todoist 提醒' },
  { to: '/gtd', label: 'GTD', Icon: ListChecks, description: 'Todoist 每日快照计数与每周回顾' },
  { to: '/budget', label: '预算', Icon: Gauge, description: 'Gemini token 与 Todoist 调用额度' },
  { to: '/health', label: '健康', Icon: HeartPulse, description: '部署版本、运行开关与进行中的事件' },
  { to: '/setup', label: '设置', Icon: Settings, description: 'Mail Hero 接入、密钥状态与 Access' },
]
const MORE: NavItem = { to: '/more', label: '更多', Icon: Ellipsis }

function Count({ value }: { value: number | undefined }) {
  if (!value) return null
  return (
    <span className="nav-count" aria-label={`${value} 个需关注`}>
      {value > 99 ? '99+' : value}
    </span>
  )
}

function Item({ item, count, active }: { item: NavItem; count?: number | undefined; active?: boolean }) {
  const { Icon } = item
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) => ['nav-item', isActive || active ? 'active' : ''].join(' ')}
      aria-current={active ? 'page' : undefined}
    >
      <span className="nav-icon">
        <Icon size={20} aria-hidden={true} />
        {count !== undefined ? <Count value={count} /> : null}
      </span>
      <span className="nav-label">{item.label}</span>
    </NavLink>
  )
}

function OverviewFailure({ error }: { error: unknown }) {
  const failure = error instanceof ApiError ? error : null
  return (
    <div className="status-banner" role="status">
      <p className="notice tone-warn">
        <TriangleAlert size={18} aria-hidden="true" />
        <span>
          <strong>无法取得运行状态</strong>
          {failure ? (
            <>
              错误码 <code>{failure.reason}</code>
              {failure.requestId ? (
                <>
                  ，请求 ID <code>{failure.requestId}</code>
                </>
              ) : null}
            </>
          ) : null}
        </span>
      </p>
    </div>
  )
}

export function Shell() {
  const overview = useOverview()
  const { pathname } = useLocation()
  const attention = overview.data?.attentionCount
  const inMore = pathname === MORE.to || MORE_ITEMS.some((item) => pathname.startsWith(item.to))

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Todofy
        </div>
        <nav aria-label="主导航">
          <Item item={ATTENTION} count={attention} />
          <Item item={EVENTS} />
          <Item item={DIGEST} />
          <div className="nav-divider" role="separator" />
          {MORE_ITEMS.map((item) => (
            <Item key={item.to} item={item} />
          ))}
        </nav>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Todofy
          </span>
        </header>
        {overview.isError && !overview.data ? <OverviewFailure error={overview.error} /> : <StatusBanner overview={overview.data} />}
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <nav className="tabbar" aria-label="主导航">
        <Item item={ATTENTION} count={attention} />
        <Item item={EVENTS} />
        <Item item={DIGEST} />
        <Item item={MORE} active={inMore} />
      </nav>
    </div>
  )
}
