/**
 * 时间线 (`/`, `/day/<date>`, ../../docs/design.md §8.4): what the owner did on one local day.
 *
 * - The day bar: ‹ · the date as a button opening the browser's date picker (from the first recorded day to today)
 *   · ›, and 今天 when another day is shown. ← and → move a day, `t` returns to today.
 * - The summary (sites, the union of the day's focus, pages) and 在这天里搜索, which opens 搜索 with that day.
 * - The hour grid: 24 cells shaded in five steps by the hour's focus, labeled for assistive technology; a cell scrolls
 *   the list to its hour. The grid is one Tab stop: ← → (Home, End) move between its hours.
 * - The list, oldest first like a diary: hour headings over sessions (sessions.ts), each one row that opens to its
 *   pages; sessions under 30 s fold into 还有 N 个短暂访问. A fresh visit of today opens scrolled to the latest
 *   session; back from a page returns to where the owner was, the session they opened open again.
 * - A day without visits says so, with the nearest days that have some.
 *
 * The day's visits are ListVisits on `pages/-` over its two local midnights, 500 a page.
 */
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import type { Visit } from '@ziyixi/proto/recall/ui/v1/page_pb'
import { api, listAll } from '../api.ts'
import { emptyState, keys, siteBadge } from '../components.ts'
import { addDays, dayKey, dayStart } from '../day.ts'
import { button, el, fill, typing } from '../dom.ts'
import { clock, dayTitle, duration, ms } from '../format.ts'
import { EMPTY_SEARCH, toUrl } from '../query.ts'
import { daySpans, hourSeconds, sessions, SHORT_SESSION_SECONDS, siteSlots, unionSeconds, type Session, type Span } from '../sessions.ts'
import type { ViewContext } from '../app.ts'
import { loadInto } from './common.ts'

/** Visits read for one day at most: 10 pages of 500 (an ordinary day has about 300). */
const VISIT_PAGES = 10
/** The focus that fills an hour cell's darkest step; each of the five steps is a fifth of it (12 minutes). */
const STEP_SECONDS = 720

const pad = (n: number) => String(n).padStart(2, '0')

/** A page's title, or its URL without the scheme when it has none (a site recorded by its site alone). */
export function titleOf(title: string, url: string): string {
  return title !== '' ? title : url.replace(/^https?:\/\//, '')
}

/** An hour cell's shade: 0 (empty) to 5. */
export function shade(seconds: number): number {
  return seconds <= 0 ? 0 : Math.min(5, Math.ceil(seconds / STEP_SECONDS))
}

async function dayVisits(day: string, deviceId: string): Promise<Visit[]> {
  const startTime = timestampFromMs(dayStart(day))
  const endTime = timestampFromMs(dayStart(addDays(day, 1)))
  return listAll(async (pageToken) => {
    const page = await api.listVisits({ parent: 'pages/-', startTime, endTime, orderBy: 'start_time', pageSize: 500, pageToken, deviceId })
    return { items: page.visits, next: page.nextPageToken }
  }, VISIT_PAGES)
}

/** The nearest days with a visit before and after `day` (ListVisits ending at its start, or starting at its end). */
async function nearestDays(day: string, today: string, deviceId: string): Promise<{ readonly before: string | null; readonly after: string | null }> {
  const first = async (request: Parameters<typeof api.listVisits>[0]) => {
    const visit = (await api.listVisits({ parent: 'pages/-', pageSize: 1, deviceId, ...request })).visits[0]
    const start = ms(visit?.startTime)
    return start === null ? null : dayKey(start)
  }
  const [before, after] = await Promise.all([
    first({ endTime: timestampFromMs(dayStart(day)), orderBy: 'start_time desc' }),
    day >= today ? Promise.resolve(null) : first({ startTime: timestampFromMs(dayStart(addDays(day, 1))), orderBy: 'start_time' }),
  ])
  return { before, after }
}

export async function renderTimeline(ctx: ViewContext, key: string | null): Promise<void> {
  const now = ctx.host.now()
  const today = dayKey(now)
  const day = key ?? today
  const params = new URLSearchParams(window.location.search)
  const hour = params.get('hour')
  const deviceId = params.get('device') ?? ''
  const path = (target: string, device: string) => `${target === today ? '/' : `/day/${target}`}${device === '' ? '' : `?device=${encodeURIComponent(device)}`}`
  const open = (target: string) => void ctx.go(path(target, deviceId))

  // The day bar.
  const picker = el('input', { type: 'date', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true', value: day, max: today })
  picker.addEventListener('change', () => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(picker.value) && picker.value !== day) open(picker.value)
  })
  const earlier = button('‹', () => open(addDays(day, -1)), { class: 'quiet icon', 'aria-label': '前一天' })
  const later = button('›', () => open(addDays(day, 1)), { class: 'quiet icon', 'aria-label': '后一天', ...(day >= today ? { disabled: true } : {}) })
  const title = dayTitle(dayStart(day), now)
  const date = button(title, () => {
    try {
      picker.showPicker()
    } catch {
      // No picker from script here (an older browser): the field takes the focus instead.
      picker.focus()
    }
  }, { class: 'day-title', 'aria-label': `${title}，选择日期` })
  const bar = el('div', { class: 'day-bar' }, earlier, el('span', { class: 'day-pick' }, date, picker), later, day === today ? null : button('今天', () => open(today), { class: 'small' }))
  const devices = el('select', { id: 'timeline-device', 'aria-label': '时间线设备' }, el('option', { value: '' }, '全部设备'))
  devices.addEventListener('change', () => void ctx.go(path(day, devices.value)))
  const deviceFilter = el('div', { class: 'device-filter' }, el('label', { for: 'timeline-device' }, '设备'), devices)
  void ctx.status().then(
    (status) => {
      const names = status.devices.map((device) => device.label)
      devices.append(...status.devices.map((device) => {
        const repeated = names.filter((name) => name === device.label).length > 1
        const sameVersion = status.devices.filter((item) => item.label === device.label && item.extensionVersion === device.extensionVersion).length > 1
        let label = repeated ? `${device.label} · ${device.extensionVersion || device.deviceId.slice(-6)}` : device.label
        if (sameVersion && device.extensionVersion !== '') label += ` · ${device.deviceId.slice(-6)}`
        return el('option', { value: device.deviceId, title: device.deviceId }, label)
      }))
      if (deviceId !== '' && !status.devices.some((device) => device.deviceId === deviceId)) devices.append(el('option', { value: deviceId }, '已移除的设备'))
      devices.value = deviceId
      const first = ms(status.firstVisitTime)
      if (first === null) return
      picker.min = dayKey(first)
      earlier.disabled = day <= dayKey(first)
    },
    () => undefined,
  )

  const content = el('div', { class: 'stack' })
  ctx.main.replaceChildren(el('h1', { class: 'visually-hidden' }, '时间线'), el('div', { class: 'body' }, bar, deviceFilter, content))

  const onKey = (event: KeyboardEvent) => {
    // ← → inside the hour grid move between its hours, not between days.
    const inGrid = event.target instanceof Element && event.target.closest('.hours') !== null
    if (event.altKey || event.ctrlKey || event.metaKey || typing(event) || inGrid) return
    if (event.key === 'ArrowLeft' && !earlier.disabled) open(addDays(day, -1))
    else if (event.key === 'ArrowRight' && !later.disabled) open(addDays(day, 1))
    else if (event.key === 't' && day !== today) open(today)
    else return
    event.preventDefault()
  }
  document.addEventListener('keydown', onKey)
  ctx.onLeave(() => {
    document.removeEventListener('keydown', onKey)
  })

  // Back from a page: the session the owner had open (the shell scrolls back to where they were).
  const kept = ctx.restored() as { readonly open?: unknown } | undefined
  const reopen = typeof kept?.open === 'string' ? kept.open : null
  ctx.keep(() => ({ open: content.querySelector('.session-main[aria-expanded="true"]')?.getAttribute('aria-controls') ?? null }))

  await loadInto(content, 6, async (box) => {
    const start = dayStart(day)
    const spans = daySpans(await dayVisits(day, deviceId), start, dayStart(addDays(day, 1)))
    if (spans.length === 0) {
      fill(box, await emptyDay(ctx, day, today, deviceId, open))
      return
    }
    fill(box, ...dayView(ctx, day, spans))
    if (kept !== undefined) {
      if (reopen !== null) box.querySelector<HTMLButtonElement>(`.session-main[aria-controls="${reopen}"]`)?.click()
      return
    }
    // Into sight on a fresh visit: the hour asked for, or today's latest session.
    const target = hour !== null && /^\d{1,2}$/.test(hour) ? headingFor(box, Number(hour)) : day === today ? [...box.querySelectorAll('.session:not([hidden])')].pop() : undefined
    target?.scrollIntoView?.({ block: hour === null ? 'end' : 'start' })
  })
}

/** A day without visits: 这天没有记录 and the nearest days that have some; before any upload, where to start. */
async function emptyDay(ctx: ViewContext, day: string, today: string, deviceId: string, open: (day: string) => void): Promise<HTMLElement> {
  const status = await ctx.status()
  if (status.firstVisitTime === undefined) {
    return emptyState('还没有记录', '浏览器扩展开始上传后，这里按天显示去过的网站。', el('div', { class: 'actions center' }, button('去设置里连接扩展', () => void ctx.go('/settings'))))
  }
  const near = await nearestDays(day, today, deviceId)
  return emptyState(
    '这天没有记录',
    '',
    el(
      'div',
      { class: 'actions center' },
      near.before === null ? null : button('上一个有记录的日子', () => open(near.before ?? today)),
      near.after === null ? null : button('下一个有记录的日子', () => open(near.after ?? today)),
    ),
  )
}

/** The heading of the hour `hour`, or of the last hour before it that has one (a session that ran into it). */
function headingFor(box: HTMLElement, hour: number): HTMLElement | undefined {
  const headings = [...box.querySelectorAll<HTMLElement>('.hour-head')]
  return headings.filter((node) => Number(node.dataset['hour']) <= hour).pop() ?? headings[0]
}

function dayView(ctx: ViewContext, day: string, spans: readonly Span[]): HTMLElement[] {
  const all = sessions(spans)
  const sites = new Map<string, Span[]>()
  for (const item of spans) sites.set(item.site, [...(sites.get(item.site) ?? []), item])
  const slots = siteSlots(new Map([...sites].map(([site, own]) => [site, unionSeconds(own)])))
  const pages = new Set(spans.map((item) => item.page)).size

  const searchDay = toUrl({ ...EMPTY_SEARCH, after: day, before: addDays(day, 1) })
  const searchLink = el('a', { href: searchDay }, '在这天里搜索')
  searchLink.addEventListener('click', (event) => {
    event.preventDefault()
    void ctx.go(searchDay)
  })
  const summary = el('p', { class: 'day-summary' }, el('span', {}, `${String(sites.size)} 个网站 · 专注 ${duration(unionSeconds(spans))} · ${String(pages)} 个页面`), searchLink)

  const list = el('div', { class: 'day-list' })
  const hours = hourSeconds(spans, day)
  // One Tab stop for the grid: its first hour with focus; ← → move between the hours that have some.
  const first = hours.findIndex((seconds) => seconds > 0)
  const cells = hours.map((seconds, index) => {
    const label = `${pad(index)} 点 · ${seconds > 0 ? `专注 ${duration(seconds)}` : '没有记录'}`
    return button(String(index), () => {
      const heading = headingFor(list, index)
      heading?.scrollIntoView?.({ block: 'start' })
      heading?.focus()
    }, { class: `hour l${String(shade(seconds))}`, 'aria-label': label, title: label, tabindex: index === first ? '0' : '-1', ...(seconds > 0 ? {} : { disabled: true }) })
  })
  const grid = el('div', { class: 'hours', role: 'group', 'aria-label': '每小时的专注' }, ...cells)
  grid.addEventListener('keydown', (event) => {
    const enabled = cells.filter((cell) => !cell.disabled)
    const at = enabled.findIndex((cell) => cell === document.activeElement)
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: enabled.length - 1 }[event.key]
    const next = to === undefined || at === -1 ? undefined : enabled[Math.max(0, Math.min(enabled.length - 1, to))]
    if (next === undefined) return
    event.preventDefault()
    for (const cell of cells) cell.tabIndex = cell === next ? 0 : -1
    next.focus()
  })

  // One session open at a time.
  let closeOpen: (() => void) | null = null
  const byHour = new Map<number, Session[]>()
  for (const session of all) {
    const at = new Date(session.start).getHours()
    byHour.set(at, [...(byHour.get(at) ?? []), session])
  }
  let rows = 0
  for (const [at, own] of byHour) {
    const short = own.filter((session) => session.seconds < SHORT_SESSION_SECONDS)
    const ul = el('ul', { class: 'rows sessions' })
    for (const session of own) {
      rows += 1
      const row = sessionRow(ctx, session, slots.get(session.site) ?? 0, `session-${String(rows)}`, (close) => {
        if (closeOpen !== close) closeOpen?.()
        closeOpen = close
      })
      row.hidden = session.seconds < SHORT_SESSION_SECONDS
      ul.append(row)
    }
    // An hour of short visits only keeps its list behind the fold too.
    ul.hidden = short.length === own.length
    const block = el('section', { class: 'hour-block' }, el('h2', { class: 'hour-head', id: `hour-${pad(at)}`, 'data-hour': String(at), tabindex: '-1' }, `${pad(at)}:00`), ul)
    if (short.length > 0) {
      const fold = button(`还有 ${String(short.length)} 个短暂访问`, () => {
        for (const row of ul.querySelectorAll<HTMLElement>('.session[hidden]')) row.hidden = false
        ul.hidden = false
        fold.remove()
      }, { class: 'quiet small fold' })
      block.append(fold)
    }
    list.append(block)
  }
  return [summary, el('div', { class: 'hours-box' }, grid), list, keys([['←', '→'], '换一天'], [['t'], '今天'], [['/'], '搜索'])]
}

/** One session: badge, host, time range, focus and pages; it opens to its pages. */
function sessionRow(ctx: ViewContext, session: Session, slot: number, id: string, opened: (close: () => void) => void): HTMLLIElement {
  const pages = el(
    'ul',
    { class: 'session-pages', id, hidden: true },
    ...session.pages.map((page) => {
      const href = `/pages/${page.page}`
      const link = el('a', { href, class: 'session-page' }, titleOf(page.title, page.url))
      link.addEventListener('click', (event) => {
        event.preventDefault()
        void ctx.go(href)
      })
      return el('li', {}, link, el('span', { class: 'meta' }, duration(page.seconds)))
    }),
  )
  const close = () => {
    pages.hidden = true
    opener.setAttribute('aria-expanded', 'false')
  }
  const opener = button(
    el(
      'span',
      { class: 'session-line' },
      siteBadge(session.site, slot),
      el('span', { class: 'session-site' }, session.site.replace(/^www\./, '')),
      el('span', { class: 'meta session-time' }, `${clock(session.start)}–${clock(session.end)}`),
      session.deviceLabel === '' ? null : el('span', { class: 'meta session-device', title: session.deviceLabel }, session.deviceLabel),
      el('span', { class: 'session-figures' }, `${duration(session.seconds)} · ${String(session.pages.length)} 页`),
    ),
    () => {
      if (!pages.hidden) {
        close()
        return
      }
      opened(close)
      pages.hidden = false
      opener.setAttribute('aria-expanded', 'true')
    },
    { class: 'session-main', 'aria-expanded': 'false', 'aria-controls': id },
  )
  return el('li', { class: 'session' }, opener, pages)
}
