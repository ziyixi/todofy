/**
 * The UI's shell (../../docs/design.md §9): a header with the name, one quiet status line (the mode in force, the
 * Gmail grant, the next run) and four tabs, a toast, and a router over the page's paths:
 *
 *   /           待审: the few uncertain mails the model asks about (its options, 都不是, 其他…, 跳过; by keyboard too)
 *   /overview   概览: what the mode does, today and 7 days, the flow of mail, the 7 days per label, the model budget
 *   /labels     标签: the labels as a tree, each with its description, 归档, trusted domains, examples and switches
 *   /settings   设置: the mode, the range undo, the sync with Gmail
 *
 * Mobile first, light and dark from the system, plain DOM (no framework), and nothing but the page's own API.
 */
import { Mode, ServiceStatus_AuthState, type ServiceStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { api } from './api.ts'
import { chip, emptyState } from './components.ts'
import { el } from './dom.ts'
import { MODE_NAMES, relative } from './format.ts'
import { renderLabels } from './views/labels.ts'
import { renderOverview } from './views/overview.ts'
import { renderReview } from './views/review.ts'
import { renderSettings } from './views/settings.ts'

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
  readonly go: (path: string) => void
  /** The service status of this page view (the header's), loaded once per navigation. */
  readonly status: () => Promise<ServiceStatus>
  /** Reads the status again and repaints the header (after a choice that changes the mode or the queue). */
  readonly refreshStatus: () => void
  /** Runs `cleanup` when the page is left (a view's document listeners). */
  readonly onLeave: (cleanup: () => void) => void
}

type View = (ctx: ViewContext) => Promise<void>

const TABS: readonly (readonly [string, string, View])[] = [
  ['/', '待审', renderReview],
  ['/overview', '概览', renderOverview],
  ['/labels', '标签', renderLabels],
  ['/settings', '设置', renderSettings],
]

/** The status line's parts: the mode badge, the Gmail grant (or its problem), the next run. */
function statusParts(status: ServiceStatus, now: number): HTMLElement[] {
  const mode = status.effectiveMode
  const badge = chip(MODE_NAMES[mode] ?? '—', mode === Mode.LIVE ? 'accent' : mode === Mode.OFF ? 'warn' : 'muted')
  const gmail =
    status.authState === ServiceStatus_AuthState.OK
      ? el('span', {}, `Gmail ✓ ${status.writeScope ? '可写' : '只读'}`)
      : el('span', { class: 'problem' }, status.authState === ServiceStatus_AuthState.FAILED ? 'Gmail 授权失效' : status.authState === ServiceStatus_AuthState.NOT_CONFIGURED ? 'Gmail 未授权' : 'Gmail 未连接')
  const next = status.nextAlarmTime === undefined ? null : el('span', {}, `下次运行 ${relative(status.nextAlarmTime, now)}`)
  return [badge, gmail, ...(next === null ? [] : [next])]
}

/** Mounts the UI into `root` and renders the current path; resolves when the first view has rendered. */
export function mountApp(root: HTMLElement, host: Host = browserHost): Promise<void> {
  const main = el('main', { id: 'view' })
  const nav = el('nav', { class: 'tabs', 'aria-label': '页面' })
  const line = el('p', { class: 'status-line' })
  const toastBox = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true })
  root.replaceChildren(el('header', { class: 'top' }, el('div', { class: 'top-row' }, el('span', { class: 'brand' }, '邮件分拣'), line), nav), main, toastBox)

  // Set by refreshStatus, which every render calls before its view.
  let status!: Promise<ServiceStatus>
  let reviewCount = 0
  let leaving: (() => void)[] = []

  // The four tabs are built once and only marked afterwards, so a tab chosen by keyboard keeps the focus. 待审's
  // carries the queue's size, hidden while nothing waits.
  const queue = chip('', 'accent')
  const tabs = TABS.map(([target, label]) => {
    const link = el('a', { href: target }, label, target === '/' ? queue : null)
    link.addEventListener('click', (event) => {
      event.preventDefault()
      go(target)
    })
    return [target, link] as const
  })
  nav.append(...tabs.map(([, link]) => link))
  const paintNav = () => {
    for (const [target, link] of tabs) {
      if (target === window.location.pathname) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    queue.hidden = reviewCount === 0
    queue.textContent = queue.hidden ? '' : String(reviewCount)
    if (queue.hidden) queue.parentElement?.removeAttribute('aria-label')
    else queue.parentElement?.setAttribute('aria-label', `待审（${String(reviewCount)} 封）`)
  }
  const refreshStatus = () => {
    status = api.getServiceStatus({ name: 'serviceStatus' })
    status.then(
      (answer) => {
        line.replaceChildren(...statusParts(answer, host.now()))
        reviewCount = answer.reviewCount
        paintNav()
      },
      () => {
        line.replaceChildren(el('span', { class: 'problem' }, '状态读取失败'))
      },
    )
  }

  const render = async (): Promise<void> => {
    for (const cleanup of leaving) cleanup()
    leaving = []
    refreshStatus()
    paintNav()
    main.replaceChildren()
    const path = window.location.pathname
    const view = TABS.find(([target]) => target === path)?.[2]
    if (view === undefined) {
      main.append(emptyState('找不到这个页面'))
      return
    }
    await view(ctx)
  }
  const go = (path: string) => {
    window.history.pushState(null, '', path)
    void render()
  }
  const ctx: ViewContext = {
    main,
    host,
    go,
    status: () => status,
    refreshStatus,
    onLeave: (cleanup) => {
      leaving.push(cleanup)
    },
  }
  window.addEventListener('popstate', () => {
    void render()
  })
  return render()
}
