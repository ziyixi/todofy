/**
 * 时间线 against the fake API: the day's request (its local midnights), the summary and 在这天里搜索, the hour grid's
 * shades, labels, jumps and its one Tab stop, sessions by site (without `www.`) with their pages and the folded short
 * visits, the sites' colors, back from a page to the session that was open, the day bar and its keys, an empty day with
 * the nearest days, and before any upload.
 */
import { onTestFinished, vi } from 'vitest'
import { homeSlot } from './sessions.ts'
import { FakeServer, page, pageId, visit } from './test/fakeServer.ts'
import { buttonNamed, open, press } from './test/helpers.ts'

/** A day of synthetic browsing on 9 October: github.com in two sessions, docs, and two short visits at 11. */
function server(): FakeServer {
  const fake = new FakeServer()
  fake.pages = [page('pr', { site: 'github.com' }), page('guide', { site: 'docs.example' })]
  fake.visits = [
    visit('pr', [['09:12', '09:30'], ['09:33', '09:40']], { site: 'github.com', title: 'Fix the alarm' }),
    visit('issue', [['09:40', '09:52']], { site: 'github.com', title: 'An issue' }),
    visit('guide', [['10:05', '10:35']], { site: 'docs.example', title: '指南：持久对象' }),
    visit('pr', [['10:40', '10:50']], { site: 'github.com', title: 'Fix the alarm' }),
    visit('flash', [['11:00:00', '11:00:10']], { site: 'a.example' }),
    visit('blink', [['11:10:00', '11:10:20']], { site: 'b.example' }),
  ]
  return fake
}

const headings = (root: HTMLElement) => [...root.querySelectorAll('.hour-head')].map((node) => node.textContent)
const sessionRows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.session:not([hidden])')]

describe('a day', () => {
  it('asks for the visits between the day’s local midnights', async () => {
    const fake = server()
    await open(fake, '/')
    const asked = fake.searches('/api/v1/pages/-/visits')[0]
    expect(asked?.searchParams.get('start_time')).toBe('2026-10-08T16:00:00Z')
    expect(asked?.searchParams.get('end_time')).toBe('2026-10-09T16:00:00Z')
    expect(asked?.searchParams.get('page_size')).toBe('500')
    expect(asked?.searchParams.get('order_by')).toBe('start_time')
  })

  it('sums up the day and searches within it', async () => {
    const root = await open(server(), '/')
    const summary = root.querySelector('.day-summary')
    // Focus: 18 + 7 + 12 + 30 + 10 minutes and 30 seconds.
    expect(summary?.firstChild?.textContent).toBe('4 个网站 · 专注 1 小时 18 分 · 5 个页面')
    const link = summary?.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/search?after=2026-10-09&before=2026-10-10')
    link?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/search')
    expect(root.querySelector('.filter-value')?.textContent).toBe('10月9日')
  })

  it('shades the 24 hours by their focus, labels them, and jumps to an hour', async () => {
    const root = await open(server(), '/')
    const cells = [...root.querySelectorAll<HTMLButtonElement>('.hours button')]
    expect(cells.map((cell) => cell.textContent)).toEqual(Array.from({ length: 24 }, (_, i) => String(i)))
    // 09: 37 minutes, 10: 40 minutes, 11: 30 seconds.
    expect(cells[9]?.className).toBe('hour l4')
    expect(cells[10]?.className).toBe('hour l4')
    expect(cells[11]?.className).toBe('hour l1')
    expect(cells[9]?.getAttribute('aria-label')).toBe('09 点 · 专注 37 分')
    expect(cells[11]?.getAttribute('aria-label')).toBe('11 点 · 专注 30 秒')
    expect(cells[3]?.getAttribute('aria-label')).toBe('03 点 · 没有记录')
    expect(cells[3]?.disabled).toBe(true)
    cells[10]?.click()
    expect(document.activeElement?.textContent).toBe('10:00')
  })

  it('makes the hour grid one Tab stop, ← → moving between its hours and not between days', async () => {
    const root = await open(server(), '/day/2026-10-09')
    const cells = [...root.querySelectorAll<HTMLButtonElement>('.hours button')]
    expect(cells.filter((cell) => cell.tabIndex === 0).map((cell) => cell.textContent)).toEqual(['9'])
    cells[9]?.focus()
    press('ArrowRight')
    expect(document.activeElement).toBe(cells[10])
    press('ArrowRight')
    press('ArrowRight')
    expect(document.activeElement).toBe(cells[11])
    press('Home')
    expect(document.activeElement).toBe(cells[9])
    expect(cells.filter((cell) => cell.tabIndex === 0)).toEqual([cells[9]])
    press('ArrowLeft')
    expect(window.location.pathname).toBe('/day/2026-10-09')
  })

  it('lists sessions by site under their hours, oldest first, and opens one at a time', async () => {
    const root = await open(server(), '/')
    expect(headings(root)).toEqual(['09:00', '10:00', '11:00'])
    const rows = sessionRows(root)
    expect(rows.map((row) => row.querySelector('.session-site')?.textContent)).toEqual(['github.com', 'docs.example', 'github.com'])
    expect(rows[0]?.querySelector('.session-time')?.textContent).toBe('09:12–09:52')
    expect(rows[0]?.querySelector('.session-figures')?.textContent).toBe('37 分 · 2 页')
    const first = rows[0]?.querySelector<HTMLButtonElement>('.session-main')
    first?.click()
    expect(first?.getAttribute('aria-expanded')).toBe('true')
    const pages = [...(rows[0]?.querySelectorAll('.session-pages li') ?? [])].map((item) => item.textContent)
    expect(pages).toEqual(['Fix the alarm25 分', 'An issue12 分'])
    rows[1]?.querySelector<HTMLButtonElement>('.session-main')?.click()
    expect(first?.getAttribute('aria-expanded')).toBe('false')
    expect(rows[0]?.querySelector('.session-pages')?.hasAttribute('hidden')).toBe(true)
    // A title opens the page's detail.
    rows[1]?.querySelector<HTMLAnchorElement>('.session-page')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe(`/pages/${pageId('guide')}`)
  })

  it('names a session by its host without www.', async () => {
    const fake = new FakeServer()
    fake.visits = [visit('watch', [['09:00', '10:12']], { site: 'www.video.example' })]
    const root = await open(fake, '/day/2026-10-09')
    expect(sessionRows(root)[0]?.querySelector('.session-site')?.textContent).toBe('video.example')
  })

  it('returns from a page to where the owner was, the session they opened open again, without jumping to the latest', async () => {
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.className)
    }
    onTestFinished(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    })
    const root = await open(server(), '/')
    sessionRows(root)[0]?.querySelector<HTMLButtonElement>('.session-main')?.click()
    sessionRows(root)[0]?.querySelector<HTMLAnchorElement>('.session-page')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe(`/pages/${pageId('pr')}`)
    scrolled.length = 0
    window.history.back()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/')
    expect(sessionRows(root)[0]?.querySelector('.session-main')?.getAttribute('aria-expanded')).toBe('true')
    expect(scrolled).toEqual([])
  })

  it('folds an hour’s visits under 30 seconds into one line', async () => {
    const root = await open(server(), '/')
    const block = [...root.querySelectorAll('.hour-block')][2]
    expect(block?.querySelector('ul')?.hidden).toBe(true)
    const fold = block?.querySelector<HTMLButtonElement>('.fold')
    expect(fold?.textContent).toBe('还有 2 个短暂访问')
    fold?.click()
    expect(block?.querySelector('ul')?.hidden).toBe(false)
    expect([...(block?.querySelectorAll('.session:not([hidden]) .session-site') ?? [])].map((node) => node.textContent)).toEqual(['a.example', 'b.example'])
    expect(block?.querySelector('.fold')).toBeNull()
  })

  it('colors each site by its own slot', async () => {
    const root = await open(server(), '/')
    const badge = sessionRows(root)[0]?.querySelector('.badge')
    expect(badge?.textContent).toBe('G')
    expect(badge?.className).toBe(`badge s${String(homeSlot('github.com'))}`)
    expect(badge?.getAttribute('aria-hidden')).toBe('true')
  })

  it('scrolls today to its latest session, and another day to the hour asked for', async () => {
    const scrolled: string[] = []
    // jsdom has no layout, so no scrollIntoView: a stand-in that records what was brought into sight.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.className)
    }
    onTestFinished(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    })
    await open(server(), '/')
    expect(scrolled).toEqual(['session'])
    const fake = new FakeServer()
    fake.visits = [visit('old', [['2026-10-08 09:00', '2026-10-08 09:20']]), visit('old', [['2026-10-08 14:00', '2026-10-08 14:20']])]
    scrolled.length = 0
    const root = await open(fake, '/day/2026-10-08?hour=15')
    expect(scrolled).toEqual(['hour-head'])
    expect(headings(root)).toEqual(['09:00', '14:00'])
  })
})

describe('the day bar', () => {
  it('names the day, moves by a day with ‹ › and the arrow keys, and returns with 今天 or t', async () => {
    const fake = server()
    const root = await open(fake, '/')
    expect(root.querySelector('.day-title')?.textContent).toBe('10月9日 周五')
    expect(buttonNamed(root, '后一天').disabled).toBe(true)
    expect(() => buttonNamed(root, '今天')).toThrow()
    buttonNamed(root, '前一天').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/day/2026-10-08')
    press('ArrowLeft')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/day/2026-10-07')
    press('ArrowRight')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/day/2026-10-08')
    press('t')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/')
    buttonNamed(root, '前一天').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    buttonNamed(root, '今天').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/')
  })

  it('opens the browser’s date picker, from the first recorded day to today', async () => {
    const root = await open(server(), '/')
    const picker = root.querySelector<HTMLInputElement>('.day-pick input[type="date"]')
    expect([picker?.min, picker?.max, picker?.value]).toEqual(['2026-09-01', '2026-10-09', '2026-10-09'])
    const shown = vi.fn()
    if (picker !== null) picker.showPicker = shown
    root.querySelector<HTMLButtonElement>('.day-title')?.click()
    expect(shown).toHaveBeenCalledOnce()
    if (picker !== null) picker.value = '2026-09-15'
    picker?.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/day/2026-09-15')
  })

  it('stops at the first recorded day', async () => {
    const root = await open(server(), '/day/2026-09-01')
    expect(buttonNamed(root, '前一天').disabled).toBe(true)
  })

  it('answers a day that is no date with the missing page', async () => {
    const root = await open(server(), '/day/2026-13-01')
    expect(root.textContent).toContain('找不到这个页面')
  })
})

describe('an empty day', () => {
  it('says so and offers the nearest days with visits', async () => {
    const fake = new FakeServer()
    fake.visits = [visit('a', [['2026-10-02 09:00', '2026-10-02 09:20']]), visit('b', [['2026-10-07 21:00', '2026-10-07 21:10']]), visit('c', [['2026-10-09 08:00', '2026-10-09 08:10']])]
    const root = await open(fake, '/day/2026-10-05')
    expect(root.querySelector('.empty strong')?.textContent).toBe('这天没有记录')
    const asked = fake.searches('/api/v1/pages/-/visits')
    expect(asked.map((url) => [url.searchParams.get('page_size'), url.searchParams.get('order_by')])).toEqual([
      ['500', 'start_time'],
      ['1', 'start_time desc'],
      ['1', 'start_time'],
    ])
    buttonNamed(root, '下一个有记录的日子').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/day/2026-10-07')
    const again = await open(fake, '/day/2026-10-05')
    buttonNamed(again, '上一个有记录的日子').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/day/2026-10-02')
  })

  it('before any upload, says where to start', async () => {
    const fake = new FakeServer()
    fake.status = { devices: [], firstVisitTime: undefined }
    const root = await open(fake, '/')
    expect(root.querySelector('.empty strong')?.textContent).toBe('还没有记录')
    buttonNamed(root, '去设置里连接扩展').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.location.pathname).toBe('/settings')
  })
})
