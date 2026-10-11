/**
 * The UI's shell (../../docs/design.md §11): a sticky header with the name, one quiet status line (the deployment's
 * mode, what needs the owner, the next run or the step being made, today's and the month's cost against the budget)
 * and four tabs, a toast, and a router over the page's paths, whose URL always holds the state:
 *
 *   /                    期刊: the issues, newest first
 *   /issues/<YYYY-MM-DD> an issue: its items with their quotes and votes, 还有, and what it cost
 *   /sources             来源: each source's health, volume, last item and learned weight
 *   /profile             偏好: the topics' learned weights and 重置
 *   /settings            设置: 暂停, 恢复调用, the monthly budget, the run's state
 *
 * Back returns to where the owner was scrolled. Mobile first, light and dark from the system, plain DOM (no framework),
 * and nothing but the page's own API.
 */
import { Mode, ServiceStatus_KeyState, type ServiceStatus } from '@ziyixi/proto/brief/ui/v1/status_pb'
import { api } from './api.ts'
import { chip, emptyState } from './components.ts'
import { el } from './dom.ts'
import { budget, issueDay, MODE_NAMES, relative, stepName, usd } from './format.ts'
import { renderIssue } from './views/issue.ts'
import { renderIssues } from './views/issues.ts'
import { renderProfile } from './views/profile.ts'
import { renderSettings } from './views/settings.ts'
import { renderSources } from './views/sources.ts'

/** What the views need from the browser, replaceable in tests. */
export interface Host {
  readonly now: () => number
  readonly confirm: (message: string) => boolean
}

const browserHost: Host = {
  now: () => Date.now(),
  confirm: (message) => window.confirm(message),
}

export interface ViewContext {
  readonly main: HTMLElement
  readonly host: Host
  /** Opens a path of the UI as a new history entry. */
  readonly go: (path: string) => Promise<void>
  /** The service status of this page view (the header's), loaded once per navigation. */
  readonly status: () => Promise<ServiceStatus>
  /** Reads the status again and repaints the header (after 暂停, 恢复调用 or a new budget). */
  readonly refreshStatus: () => void
}

type View = (ctx: ViewContext) => Promise<void>

/** Scrolls the page to `y` (the page's own scroller). */
function scrollPage(y: number): void {
  const scroller = document.scrollingElement ?? document.documentElement
  scroller.scrollTop = y
}

const TABS: readonly (readonly [string, string])[] = [
  ['/', '期刊'],
  ['/sources', '来源'],
  ['/profile', '偏好'],
  ['/settings', '设置'],
]

/** The view of a path and the tab it marks; null when the UI has no such page. */
function route(path: string): { readonly tab: string; readonly render: View } | null {
  if (path === '/') return { tab: '/', render: renderIssues }
  if (path.startsWith('/issues/')) {
    const day = issueDay(path.slice(1))
    return day === '' ? null : { tab: '/', render: (ctx) => renderIssue(ctx, day) }
  }
  const view = { '/sources': renderSources, '/profile': renderProfile, '/settings': renderSettings }[path]
  return view === undefined ? null : { tab: path, render: view }
}

/** The status line's parts: the mode, what needs the owner (in the warning color), the next run, the costs. */
export function statusParts(status: ServiceStatus, now: number): HTMLElement[] {
  const quiet = (text: string) => el('span', {}, text)
  const problem = (text: string) => el('span', { class: 'problem' }, text)
  const parts = [chip(MODE_NAMES[status.mode] ?? '—', status.mode === Mode.LIVE ? 'accent' : status.mode === Mode.OFF ? 'warn' : 'muted')]
  if (status.paused) parts.push(problem('已暂停'))
  if (status.keyState === ServiceStatus_KeyState.REJECTED) parts.push(problem('调用被拒'))
  else if (status.keyState === ServiceStatus_KeyState.NOT_CONFIGURED) parts.push(problem('未设置 Claude 密钥'))
  if (!status.mailConfigured && (status.mode === Mode.SHADOW || status.mode === Mode.LIVE)) parts.push(problem('发信未配置'))
  if (status.currentIssue !== '') parts.push(quiet(`制作中：${stepName(status.currentStep)}`))
  else if (status.nextAlarmTime !== undefined) parts.push(quiet(`下次运行 ${relative(status.nextAlarmTime, now)}`))
  parts.push(quiet(`今日 ${usd(status.todayCostUsd)}`))
  const month = `本月 ${usd(status.monthCostUsd)} / ${budget(status.monthlyBudgetUsd)}`
  parts.push(status.monthlyBudgetUsd > 0 && status.monthCostUsd >= status.monthlyBudgetUsd ? problem(month) : quiet(month))
  return parts
}

/** Mounts the UI into `root` and renders the current path; resolves when the first view has rendered. */
export function mountApp(root: HTMLElement, host: Host = browserHost): Promise<void> {
  const main = el('main', { id: 'view' })
  const nav = el('nav', { class: 'tabs', 'aria-label': '页面' })
  const line = el('p', { class: 'status-line' })
  const toastBox = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true })
  root.replaceChildren(el('header', { class: 'top' }, el('div', { class: 'top-row' }, el('span', { class: 'brand' }, '简报'), line), nav), main, toastBox)
  window.history.scrollRestoration = 'manual'

  // Set by refreshStatus, which every render calls before its view.
  let status!: Promise<ServiceStatus>

  // The tabs are built once and only marked afterwards, so a tab chosen by keyboard keeps the focus.
  const tabs = TABS.map(([target, label]) => {
    const link = el('a', { href: target }, label)
    link.addEventListener('click', (event) => {
      event.preventDefault()
      void go(target)
    })
    return [target, link] as const
  })
  nav.append(...tabs.map(([, link]) => link))

  const refreshStatus = () => {
    status = api.getServiceStatus({ name: 'serviceStatus' })
    status.then(
      (answer) => {
        line.replaceChildren(...statusParts(answer, host.now()))
      },
      () => {
        line.replaceChildren(el('span', { class: 'problem' }, '状态读取失败'))
      },
    )
  }

  const render = async (): Promise<void> => {
    refreshStatus()
    const found = route(window.location.pathname)
    for (const [target, link] of tabs) {
      if (target === found?.tab) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    main.replaceChildren()
    if (found === null) {
      main.append(emptyState('找不到这个页面'))
      return
    }
    await found.render(ctx)
  }
  const go = (path: string): Promise<void> => {
    // The entry being left keeps where it was scrolled, for back.
    window.history.replaceState({ scrollY: window.scrollY }, '')
    window.history.pushState(null, '', path)
    scrollPage(0)
    return render()
  }
  const ctx: ViewContext = { main, host, go, status: () => status, refreshStatus }
  // A UI mounted again (a test's next page) leaves the one before it deaf.
  window.addEventListener('popstate', () => {
    if (!root.isConnected) return
    const scrollY = (window.history.state as { scrollY?: unknown } | null)?.scrollY
    void render().then(() => {
      if (typeof scrollY === 'number') scrollPage(scrollY)
    })
  })
  return render()
}
