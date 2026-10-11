/**
 * 页面详情 (`/pages/<id>`, ../../docs/design.md §8.6), over the tab it was opened from:
 *
 * - The head: the title, the site and the URL (a link opening a new tab without a referrer; a hint when the scrubber
 *   took part of it out or it was cut), then the first and latest visit, the visits and the focus. Behind ⋯: 打开原网页,
 *   以后不保存这个网站的正文 (adds the site to the denylist) and 删除这个页面的记录, each that changes something asking first.
 * - 正文: the latest capture's text in the reader style, paragraphs split on blank lines, the query's words marked
 *   when the page came from a search (`第 1/5 处` with ↑ ↓ and the keys n and N, in a bar that sticks under the header;
 *   the first match brought into sight when it is below it); what was cut or is not searched. A text the retention
 *   window moved to the Dropbox archive alone says 正文已归档到 Dropbox, with its path in the app folder.
 * - 访问: the visits, newest first, 20 at a time; a date opens that day's timeline at that hour.
 *
 * Titles, URLs and texts are untrusted page content: text nodes only, never HTML.
 */
import type { Document, Page, Visit } from '@ziyixi/proto/recall/ui/v1/page_pb'
import type { Settings } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { api, errorMessage } from '../api.ts'
import { card, errorLine, keys, menu, type MenuAction } from '../components.ts'
import { dayKey } from '../day.ts'
import { button, el, fill, toast, typing } from '../dom.ts'
import { clock, dateText, duration, ms, shortWhen } from '../format.ts'
import { highlightWords, marked } from '../marks.ts'
import type { ViewContext } from '../app.ts'
import { act, frame } from './common.ts'
import { titleOf } from './timeline.ts'

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
    const [document, visits] = await Promise.all([
      page.latestDocument === '' ? Promise.resolve(null) : api.getDocument({ name: page.latestDocument }),
      api.listVisits({ parent: page.name, orderBy: 'start_time desc', pageSize: VISITS_PAGE }),
    ])
    fill(body, head(ctx, page, words, now), textCard(ctx, page, document, words, now), visitsCard(ctx, page, visits.visits, visits.nextPageToken, now))
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
  if (!page.site.startsWith('[')) actions.push(['以后不保存这个网站的正文', () => void denySite(ctx, page.site)])
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

function textCard(ctx: ViewContext, page: Page, document: Document | null, words: readonly string[], now: number): HTMLElement {
  if (document === null) return card('正文', '', el('p', { class: 'hint' }, '停留不到 10 秒或在不保存正文的名单里，没有正文'))
  const captured = ms(document.captureTime)
  const meta = `${captured === null ? '' : `${dateText(captured, now)}保存`}${page.documentCount > 1 ? ` · 共 ${String(page.documentCount)} 次` : ''}`
  if (document.textArchived) {
    return card(
      '正文',
      meta,
      el('p', { class: 'archived-title' }, '正文已归档到 Dropbox'),
      el('p', { class: 'hint' }, '超过云端保留的天数，正文已从云端移除，只留在 Dropbox 归档里（gzip 压缩的纯文本）；页面和访问记录仍在这里，标题和网址仍能搜到。'),
      el('p', { class: 'archive-path' }, 'Dropbox 应用文件夹里的 ', el('code', { class: 'mono' }, document.archivePath)),
    )
  }
  const reader = el(
    'div',
    { class: 'reader' },
    ...document.text
      .split(/\n\s*\n/u)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph !== '')
      .map((paragraph) => el('p', {}, ...marked(paragraph, words))),
  )
  const marks = [...reader.querySelectorAll('mark')]
  let find: HTMLElement | null = null
  if (marks.length > 0) {
    let current = 0
    const where = el('span', { class: 'meta', 'aria-live': 'polite' })
    const show = (index: number, scroll: boolean) => {
      current = (index + marks.length) % marks.length
      marks.forEach((mark, i) => mark.classList.toggle('current', i === current))
      where.textContent = `第 ${String(current + 1)}/${String(marks.length)} 处`
      if (scroll) marks[current]?.scrollIntoView?.({ block: 'center' })
    }
    show(0, false)
    find = el(
      'div',
      { class: 'find' },
      where,
      button('↑', () => show(current - 1, true), { class: 'quiet icon', 'aria-label': '上一处' }),
      button('↓', () => show(current + 1, true), { class: 'quiet icon', 'aria-label': '下一处' }),
      keys([['n'], '下一处'], [['N'], '上一处']),
    )
    // n and N (Shift+n) as in a find-in-page bar, whenever the focus is not in a field.
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || typing(event) || (event.key !== 'n' && event.key !== 'N')) return
      event.preventDefault()
      show(current + (event.key === 'n' ? 1 : -1), true)
    }
    window.document.addEventListener('keydown', onKey)
    ctx.onLeave(() => {
      window.document.removeEventListener('keydown', onKey)
    })
  }
  return card(
    '正文',
    meta,
    find,
    document.textTruncated ? el('p', { class: 'hint' }, '正文超过 64 KB，只保存了开头') : null,
    document.searchTruncated ? el('p', { class: 'hint' }, '搜索只看正文前 32 KB') : null,
    reader,
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
  if (!ctx.host.confirm(`以后不保存 ${site} 的正文？之后只记录访问时间、网址和标题，已保存的正文不变。`)) return
  let settings: Settings
  try {
    settings = await api.getSettings({ name: 'settings' })
  } catch (error) {
    toast(errorMessage(error))
    return
  }
  if (settings.denylistPatterns.includes(site)) {
    toast(`${site} 已在不保存正文的名单里`)
    return
  }
  await act(
    (requestId) =>
      api.updateSettings({ settings: { name: 'settings', denylistPatterns: [...settings.denylistPatterns, site], etag: settings.etag }, updateMask: { paths: ['denylist_patterns', 'etag'] }, requestId }),
    `以后不保存 ${site} 的正文`,
    () => undefined,
  )
}

/** Deletes the page's record (asks first), then leaves for where it was opened from. */
async function deletePage(ctx: ViewContext, page: Page): Promise<void> {
  if (!ctx.host.confirm('删除这个页面的记录？访问和正文会从 recall 删除，不能恢复；Dropbox 备份只增不删，会多一条删除记录，原来的文件要在 Dropbox 里自己删。')) return
  await act((requestId) => api.deletePage({ name: page.name, requestId }), '已删除这个页面的记录', () => ctx.back())
}
