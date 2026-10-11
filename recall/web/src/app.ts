/**
 * The UI's shell (../../docs/design.md §8.3): a sticky header with the name and one quiet status line (the latest
 * upload and the Dropbox backup, or the problem in the warning color), three tabs, a toast, and a router over the
 * page's paths, whose URL always holds the state (reload and back work):
 *
 *   /, /day/<YYYY-MM-DD>   时间线: a day's hours and sessions (/ is today; ?hour=9 opens at that hour)
 *   /search?q=…&site=…     搜索: words and filters (query.ts)
 *   /pages/<id>?q=…        a page's detail, over the tab it came from (the tab stays marked)
 *   /settings              设置: devices, the extension's token, the Dropbox backup, storage, the denylist
 *
 * `/` anywhere focuses the search box. Back returns to where the owner was: each history entry keeps its scroll
 * position and what its view kept of itself (the search's results, the timeline's open session), in memory, and the
 * view draws itself from that instead of asking again. Mobile first, light and dark from the system, plain DOM (no
 * framework), and nothing but the page's own API.
 */
import type { ServiceStatus } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { api } from './api.ts'
import { emptyState } from './components.ts'
import { parseDay } from './day.ts'
import { el, typing } from './dom.ts'
import { statusParts } from './health.ts'
import { renderPage } from './views/page.ts'
import { renderSearch } from './views/search.ts'
import { renderSettings } from './views/settings.ts'
import { renderTimeline } from './views/timeline.ts'

/** What the views need from the browser, replaceable in tests. */
export interface Host {
  readonly now: () => number
  readonly confirm: (message: string) => boolean
  /** Opens a page's own URL in a new tab, without a referrer. */
  readonly open: (url: string) => void
  /** Leaves the UI for `url` in this tab (Dropbox's authorization page, which comes back to /settings). */
  readonly navigate: (url: string) => void
  /** A fine pointer that hovers (a desktop): the search box takes the focus on arrival there. */
  readonly desktop: () => boolean
}

const browserHost: Host = {
  now: () => Date.now(),
  confirm: (message) => window.confirm(message),
  open: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  navigate: (url) => {
    window.location.assign(url)
  },
  desktop: () => typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover) and (pointer: fine)').matches,
}

export type Tab = 'timeline' | 'search' | 'settings'

export interface ViewContext {
  readonly main: HTMLElement
  readonly host: Host
  /** Opens a path of the UI as a new history entry. */
  readonly go: (path: string) => Promise<void>
  /** Puts a view's own state into the current entry's URL, without rendering again (the search as it changes). */
  readonly replace: (path: string) => void
  /** Leaves a page's detail for the page it was opened from (after its deletion). */
  readonly back: () => void
  /** The service status of this page view (the header's), loaded once per navigation, and again after a failure. */
  readonly status: () => Promise<ServiceStatus>
  /** Runs `cleanup` when the page is left (a view's document listeners). */
  readonly onLeave: (cleanup: () => void) => void
  /** How the view takes what it keeps of itself when the owner leaves it for another page (to come back to it). */
  readonly keep: (snapshot: () => unknown) => void
  /** What the view kept of itself in this history entry, when back returns to it; undefined on a fresh visit. */
  readonly restored: () => unknown
}

/** What a history entry keeps when the owner leaves it: where the page was scrolled, and its view's snapshot. */
interface Kept {
  readonly scrollY: number
  readonly view: unknown
}

/** History entries kept at most (the oldest go first). */
const KEPT_ENTRIES = 30

/** Scrolls the page to `y` (the page's own scroller: the view restores where it was). */
function scrollPage(y: number): void {
  const scroller = document.scrollingElement ?? document.documentElement
  scroller.scrollTop = y
}

const TABS: readonly (readonly [Tab, string, string])[] = [
  ['timeline', '/', '时间线'],
  ['search', '/search', '搜索'],
  ['settings', '/settings', '设置'],
]

/** The view of a path and the tab it marks; null when the UI has no such page. */
function route(path: string, query: URLSearchParams): { readonly tab: Tab; readonly render: (ctx: ViewContext) => Promise<void> } | null {
  if (path === '/') return { tab: 'timeline', render: (ctx) => renderTimeline(ctx, null) }
  const day = /^\/day\/([0-9-]+)$/.exec(path)
  if (day !== null) {
    const key = parseDay(day[1] ?? '')
    return key === null || key !== day[1] ? null : { tab: 'timeline', render: (ctx) => renderTimeline(ctx, key) }
  }
  if (path === '/search') return { tab: 'search', render: renderSearch }
  if (path === '/settings') return { tab: 'settings', render: renderSettings }
  const page = /^\/pages\/([0-9a-f]{32})$/.exec(path)
  if (page !== null) {
    // Over the tab it was opened from (kept in the history entry); a reloaded or shared link: 搜索 when it carries a query.
    const from = (window.history.state as { from?: unknown } | null)?.from
    const tab = TABS.some(([name]) => name === from) ? (from as Tab) : query.has('q') ? 'search' : 'timeline'
    return { tab, render: (ctx) => renderPage(ctx, page[1] ?? '') }
  }
  return null
}

/** Mounts the UI into `root` and renders the current path; resolves when the first view has rendered. */
export function mountApp(root: HTMLElement, host: Host = browserHost): Promise<void> {
  const main = el('main', { id: 'view' })
  const nav = el('nav', { class: 'tabs', 'aria-label': '页面' })
  const line = el('p', { class: 'status-line' })
  const toastBox = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true })
  const header = el('header', { class: 'top' }, el('div', { class: 'top-row' }, el('span', { class: 'brand' }, '浏览记录'), line), nav)
  root.replaceChildren(header, main, toastBox)
  // The sticky header's height, for what sticks under it (a page's find bar).
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--top-height', `${String(header.offsetHeight)}px`)
    }).observe(header)
  }
  window.history.scrollRestoration = 'manual'

  // Set by readStatus, which every render calls before its view.
  let status!: Promise<ServiceStatus>
  let statusFailed = false
  let current: Tab | null = null
  let leaving: (() => void)[] = []
  const kept = new Map<string, Kept>()
  let snapshot: (() => unknown) | null = null
  let restoring: Kept | undefined

  // The tabs are built once and only marked afterwards, so a tab chosen by keyboard keeps the focus.
  const tabs = TABS.map(([name, target, label]) => {
    const link = el('a', { href: target }, label)
    link.addEventListener('click', (event) => {
      event.preventDefault()
      void go(target)
    })
    return [name, link] as const
  })
  nav.append(...tabs.map(([, link]) => link))
  const paintNav = () => {
    for (const [name, link] of tabs) {
      if (name === current) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
  }

  const readStatus = () => {
    statusFailed = false
    status = api.getServiceStatus({ name: 'serviceStatus' })
    status.then(
      (answer) => {
        line.replaceChildren(...statusParts(answer, host.now()))
      },
      () => {
        statusFailed = true
        line.replaceChildren(el('span', { class: 'problem' }, '状态读取失败'))
      },
    )
  }

  /** This history entry's key (each entry gets one, so that what it kept can be found again). */
  const entryKey = (): string => {
    const state = window.history.state as { key?: unknown } | null
    if (typeof state?.key === 'string') return state.key
    const key = crypto.randomUUID()
    window.history.replaceState({ ...(state ?? {}), key }, '')
    return key
  }

  /** Renders the current path; `restore` (back or forward) draws the view from what its entry kept, if anything. */
  const render = async (restore = false): Promise<void> => {
    for (const cleanup of leaving) cleanup()
    leaving = []
    snapshot = null
    restoring = restore ? kept.get(entryKey()) : undefined
    readStatus()
    const found = route(window.location.pathname, new URLSearchParams(window.location.search))
    current = found?.tab ?? null
    paintNav()
    main.replaceChildren()
    if (found === null) {
      main.append(emptyState('找不到这个页面'))
      return
    }
    const back = restoring
    await found.render(ctx)
    restoring = undefined
    if (back !== undefined) scrollPage(back.scrollY)
  }
  const go = (path: string): Promise<void> => {
    kept.set(entryKey(), { scrollY: window.scrollY, view: snapshot?.() })
    for (const key of kept.keys()) {
      if (kept.size <= KEPT_ENTRIES) break
      kept.delete(key)
    }
    window.history.pushState({ from: current, key: crypto.randomUUID() }, '', path)
    scrollPage(0)
    return render()
  }
  const ctx: ViewContext = {
    main,
    host,
    go,
    replace: (path) => {
      window.history.replaceState(window.history.state, '', path)
    },
    back: () => {
      if ((window.history.state as { from?: unknown } | null)?.from != null) window.history.back()
      else void go('/')
    },
    // A view's 重试 after a failed status asks again.
    status: () => {
      if (statusFailed) readStatus()
      return status
    },
    onLeave: (cleanup) => {
      leaving.push(cleanup)
    },
    keep: (take) => {
      snapshot = take
    },
    restored: () => restoring?.view,
  }
  // A UI mounted again (a test's next page) leaves the one before it deaf.
  window.addEventListener('popstate', () => {
    if (root.isConnected) void render(true)
  })
  // `/` anywhere focuses the search box (on 搜索 itself, or after opening it).
  document.addEventListener('keydown', (event) => {
    if (!root.isConnected || event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey || typing(event)) return
    event.preventDefault()
    const focusBox = () => document.querySelector<HTMLInputElement>('#q')?.focus()
    if (current === 'search' && window.location.pathname === '/search') focusBox()
    else void go('/search').then(focusBox)
  })
  return render()
}
