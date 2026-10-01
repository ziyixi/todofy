/**
 * The UI's shell (../../docs/design.md §9): a header with the views, a toast, and a router over the page's paths:
 *
 *   /                 the change inbox (new changes across watches) and the suppressed drawer
 *   /watches          the watches with their health
 *   /watches/<id>     one watch: its health, settings and changes
 *   /status           the health view: the scheduler, the browser ledger and every watch that is not well (the
 *                     Worker's own /health is its liveness probe)
 *   /new              adding a watch from a preview (`/new#u=<encoded url>` from the phone's share sheet or a bookmarklet)
 *
 * Mobile first, light and dark from the system, plain DOM (no framework), and nothing but the page's own API.
 */
import { el } from './dom.ts'
import { renderAdd } from './views/add.ts'
import { renderDetail } from './views/detail.ts'
import { renderHealth } from './views/health.ts'
import { renderInbox } from './views/inbox.ts'
import { renderWatches } from './views/watches.ts'

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
  /** Goes to a path of the UI (history entry, then render). */
  readonly go: (path: string) => void
}

type View = (ctx: ViewContext, ...params: string[]) => Promise<void>

const ROUTES: readonly (readonly [RegExp, View])[] = [
  [/^\/$/, renderInbox],
  [/^\/watches$/, renderWatches],
  [/^\/watches\/([a-z][a-z0-9-]{0,39})$/, renderDetail],
  [/^\/status$/, renderHealth],
  [/^\/new$/, renderAdd],
]

const TABS: readonly (readonly [string, string])[] = [
  ['/', '变化'],
  ['/watches', '监视'],
  ['/status', '健康'],
  ['/new', '添加'],
]

/** Mounts the UI into `root` and renders the current path; resolves when the first view has rendered. */
export function mountApp(root: HTMLElement, host: Host = browserHost): Promise<void> {
  const main = el('main', { id: 'view' })
  const nav = el('nav', { class: 'tabs', 'aria-label': '页面' })
  const toastBox = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true })
  root.replaceChildren(el('header', { class: 'bar' }, el('span', { class: 'brand' }, '网页监视'), nav), main, toastBox)

  const render = async (): Promise<void> => {
    const path = window.location.pathname
    nav.replaceChildren(
      ...TABS.map(([target, label]) => {
        const active = target === '/' ? path === '/' : path.startsWith(target)
        const link = el('a', { href: target, ...(active ? { 'aria-current': 'page' } : {}) }, label)
        link.addEventListener('click', (event) => {
          event.preventDefault()
          go(target)
        })
        return link
      }),
    )
    const route = ROUTES.map(([pattern, view]) => [pattern.exec(path), view] as const).find(([match]) => match !== null)
    main.replaceChildren()
    if (route === undefined) {
      main.append(el('p', { class: 'empty' }, '找不到这个页面。'))
      return
    }
    const [match, view] = route
    await view(ctx, ...(match?.slice(1) ?? []))
  }
  const go = (path: string) => {
    window.history.pushState(null, '', path)
    void render()
  }
  const ctx: ViewContext = { main, host, go }
  window.addEventListener('popstate', () => {
    void render()
  })
  return render()
}
