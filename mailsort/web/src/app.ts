/**
 * The UI's shell (../../docs/design.md §9): a header with the views, a toast, and a router over the page's paths:
 *
 *   /           待审: shadow suggestions, unsure mails and audits (confirm / correct / skip)
 *   /labels     标签: create, rename, describe, enable, live, trust, threshold; sync with Gmail
 *   /rules      规则: proposed and active rules; approve, disable, delete; export Gmail filters
 *   /examples   例子与向量库: counts per label, embedding status, rebuild, view and delete examples
 *   /accuracy   准确率: per-label precision bound, coverage, counts
 *   /flow       流程: how mail moved through the pipeline (today, 7 or 30 days), and per label
 *   /import     导入导出: the template, the owner's rule file or an export (preview, then confirm); the export
 *   /ledger     操作记录: Gmail writes; undo one or a time range; one label's (?label=)
 *   /status     运行状态: the grant, the last sync, the queue, today's Gmail and Workers AI use, error codes
 *   /settings   设置: mode, limits, the neuron budget, thresholds
 *
 * Mobile first, light and dark from the system, plain DOM (no framework), and nothing but the page's own API.
 */
import { el } from './dom.ts'
import { renderAccuracy } from './views/accuracy.ts'
import { renderExamples } from './views/examples.ts'
import { renderFlow } from './views/flow.ts'
import { renderImport } from './views/import.ts'
import { renderLabels } from './views/labels.ts'
import { renderLedger } from './views/ledger.ts'
import { renderReview } from './views/review.ts'
import { renderRules } from './views/rules.ts'
import { renderSettings } from './views/settings.ts'
import { renderStatus } from './views/status.ts'

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
}

type View = (ctx: ViewContext) => Promise<void>

const ROUTES: readonly (readonly [string, string, View])[] = [
  ['/', '待审', renderReview],
  ['/labels', '标签', renderLabels],
  ['/rules', '规则', renderRules],
  ['/flow', '流程', renderFlow],
  ['/import', '导入', renderImport],
  ['/examples', '例子', renderExamples],
  ['/accuracy', '准确率', renderAccuracy],
  ['/ledger', '记录', renderLedger],
  ['/status', '状态', renderStatus],
  ['/settings', '设置', renderSettings],
]

/** Mounts the UI into `root` and renders the current path; resolves when the first view has rendered. */
export function mountApp(root: HTMLElement, host: Host = browserHost): Promise<void> {
  const main = el('main', { id: 'view' })
  const nav = el('nav', { class: 'tabs', 'aria-label': '页面' })
  const toastBox = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true })
  root.replaceChildren(el('header', { class: 'bar' }, el('span', { class: 'brand' }, '邮件分拣'), nav), main, toastBox)

  const render = async (): Promise<void> => {
    const path = window.location.pathname
    nav.replaceChildren(
      ...ROUTES.map(([target, label]) => {
        const link = el('a', { href: target, ...(target === path ? { 'aria-current': 'page' } : {}) }, label)
        link.addEventListener('click', (event) => {
          event.preventDefault()
          go(target)
        })
        return link
      }),
    )
    main.replaceChildren()
    const route = ROUTES.find(([target]) => target === path)
    if (route === undefined) {
      main.append(el('p', { class: 'empty' }, '找不到这个页面。'))
      return
    }
    await route[2](ctx)
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
