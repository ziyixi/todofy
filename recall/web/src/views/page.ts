/**
 * 页面详情 (`/pages/<id>`, ../../docs/design.md §8.6), over the tab it was opened from:
 *
 * - The head: the title, the site and the URL (a link opening a new tab without a referrer; a hint when the scrubber
 *   took part of it out or it was cut), then the first and latest visit, the visits and the focus. Behind ⋯: 打开原网页,
 *   以后不保存这个网站的内容 (adds the site to the denylist) and 删除这个页面的记录, each that changes something asking first.
 * - 历史快照: captures newest first, 20 at a time. Selecting one loads its text and viewport screenshot, from R2 or
 *   Dropbox. Text remains plain paragraphs with search matches (snapshots.ts).
 * - 访问: the visits, newest first, 20 at a time; a date opens that day's timeline at that hour.
 *
 * Titles, URLs and texts are untrusted page content: text nodes only, never HTML.
 */
import type { Page, Visit } from '@ziyixi/proto/recall/ui/v1/page_pb'
import type { Settings } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { api, errorMessage } from '../api.ts'
import { card, errorLine, menu, type MenuAction } from '../components.ts'
import { dayKey } from '../day.ts'
import { button, el, fill, toast } from '../dom.ts'
import { clock, dateText, duration, ms, shortWhen } from '../format.ts'
import { highlightWords, marked } from '../marks.ts'
import type { ViewContext } from '../app.ts'
import { act, frame } from './common.ts'
import { titleOf } from './timeline.ts'
import { DOCUMENTS_PAGE, snapshotsCard } from './snapshots.ts'

/** Visits shown at a time. */
const VISITS_PAGE = 20

/** Only an http(s) URL is a link (the Worker normalizes every URL to one; anything else stays text). */
function linkable(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export async function renderPage(ctx: ViewContext, id: string): Promise<void> {
  const now = ctx.host.now()
  const words = highlightWords(new URLSearchParams(window.location.search).get('q') ?? '')
  await frame(ctx.main, '页面详情', async (body) => {
    const page = await api.getPage({ name: `pages/${id}` })
    const [documents, visits] = await Promise.all([
      api.listDocuments({ parent: page.name, pageSize: DOCUMENTS_PAGE }),
      api.listVisits({ parent: page.name, orderBy: 'start_time desc', pageSize: VISITS_PAGE }),
    ])
    fill(body, head(ctx, page, words, now), await snapshotsCard(ctx, page, documents.documents, documents.nextPageToken, words, now), visitsCard(ctx, page, visits.visits, visits.nextPageToken, now))
    // The first match into sight only when it is below it: one near the top stays where it is, under the title.
    const first = body.querySelector('.reader mark.current')
    if (first !== null && first.getBoundingClientRect().bottom > window.innerHeight) first.scrollIntoView?.({ block: 'center' })
  })
}

function head(ctx: ViewContext, page: Page, words: readonly string[], now: number): HTMLElement {
  const first = ms(page.firstVisitTime)
  const last = ms(page.lastVisitTime)
  const actions: MenuAction[] = []
  if (linkable(page.url)) actions.push(['打开原网页', () => ctx.host.open(page.url)])
  // An IPv6 literal has no denylist pattern.
  if (!page.site.startsWith('[')) actions.push(['以后不保存这个网站的内容', () => void denySite(ctx, page.site)])
  actions.push(['删除这个页面的记录', () => void deletePage(ctx, page), 'danger'])
  const facts = [
    first === null ? '' : `第一次 ${dayKey(first)}`,
    last === null ? '' : `最近 ${shortWhen(last, now)}`,
    `${String(page.visitCount)} 次`,
    `共停留 ${duration(page.focusSeconds)}`,
  ].filter((part) => part !== '')
  return el(
    'section',
    { class: 'page-head' },
    el('div', { class: 'page-title-row' }, el('h2', { class: 'page-title' }, ...marked(titleOf(page.title, page.url), words)), menu('页面操作', actions)),
    el('p', { class: 'page-site' }, page.site),
    linkable(page.url) ? el('a', { class: 'page-url mono', href: page.url, target: '_blank', rel: 'noopener noreferrer' }, page.url) : el('p', { class: 'page-url mono' }, page.url),
    page.url.includes('[redacted]') ? el('p', { class: 'hint' }, '网址里的敏感部分已去掉') : null,
    page.urlTruncated ? el('p', { class: 'hint' }, '网址太长，只保存了开头') : null,
    el('p', { class: 'meta' }, facts.join(' · ')),
  )
}

function visitsCard(ctx: ViewContext, page: Page, first: readonly Visit[], firstToken: string, now: number): HTMLElement {
  const list = el('ul', { class: 'visits' })
  const more = el('div', { class: 'actions' })
  const add = (visits: readonly Visit[], next: string) => {
    list.append(...visits.map((visit) => visitRow(ctx, visit, now)))
    fill(
      more,
      next === ''
        ? null
        : button('更多', () => {
            void api.listVisits({ parent: page.name, orderBy: 'start_time desc', pageSize: VISITS_PAGE, pageToken: next }).then(
              (answer) => add(answer.visits, answer.nextPageToken),
              (error: unknown) => fill(more, errorLine(errorMessage(error), () => add([], next))),
            )
          }),
    )
  }
  add(first, firstToken)
  return card('访问', `${String(page.visitCount)} 次`, list, more)
}

function visitRow(ctx: ViewContext, visit: Visit, now: number): HTMLLIElement {
  const start = ms(visit.startTime) ?? 0
  const end = ms(visit.endTime) ?? start
  const href = `/day/${dayKey(start)}?hour=${String(new Date(start).getHours())}`
  const link = el('a', { href }, `${dateText(start, now)} ${clock(start)}–${clock(end)}`)
  link.addEventListener('click', (event) => {
    event.preventDefault()
    void ctx.go(href)
  })
  return el('li', {}, link, el('span', { class: 'meta' }, [duration(visit.focusSeconds), visit.deviceLabel].filter((part) => part !== '').join(' · ')))
}

/** Adds the page's site to the owner's denylist (asks first): only `denylist_patterns`, with the settings' etag. */
async function denySite(ctx: ViewContext, site: string): Promise<void> {
  if (!ctx.host.confirm(`以后不保存 ${site} 的正文和截图？之后只记录访问时间、网址和标题，已保存的内容不变。`)) return
  let settings: Settings
  try {
    settings = await api.getSettings({ name: 'settings' })
  } catch (error) {
    toast(errorMessage(error))
    return
  }
  if (settings.denylistPatterns.includes(site)) {
    toast(`${site} 已在不保存内容的名单里`)
    return
  }
  await act(
    (requestId) =>
      api.updateSettings({ settings: { name: 'settings', denylistPatterns: [...settings.denylistPatterns, site], etag: settings.etag }, updateMask: { paths: ['denylist_patterns', 'etag'] }, requestId }),
    `以后不保存 ${site} 的正文和截图`,
    () => undefined,
  )
}

/** Deletes the page's record (asks first), then leaves for where it was opened from. */
async function deletePage(ctx: ViewContext, page: Page): Promise<void> {
  if (!ctx.host.confirm('删除这个页面的记录？访问、正文和截图会从 recall 删除，不能恢复；Dropbox 备份只增不删，会多一条删除记录，原来的文件要在 Dropbox 里自己删。')) return
  await act((requestId) => api.deletePage({ name: page.name, requestId }), '已删除这个页面的记录', () => ctx.back())
}
