/**
 * 搜索 against the fake API: 最近读过 before anything is typed; operators typed into the box becoming chips (and their
 * hints, with nothing searched while one does not parse), Enter, Backspace and the box's own ✕; each chip's popover
 * (presets of the last n days, custom ranges and a single day, the site picker with a typed domain first and the
 * server's prefix filter, Escape and a click outside) and where the focus goes; the URL holding the state; results with
 * marked titles, snippets and their figures; 加载更多, the count and the focus; the caps' lines; no results with a drop
 * button per chip and the index's reach; the retention window's coverage line; a lone Chinese character, alone or beside other terms; the day's read budget;
 * the sort; the keyboard; back from a page showing the results as they were.
 */
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { addDays, dayStart } from './day.ts'
import { at, FakeServer, HOUR, NOW, page, pageId, site, textOf, visit } from './test/fakeServer.ts'
import { buttonNamed, open, press, testHost, type, urlParams } from './test/helpers.ts'

/** Three pages: two read (one on github.com with Chinese text), one without text. */
function server(): FakeServer {
  const fake = new FakeServer()
  const pr = page('pr', { site: 'github.com', url: 'https://github.com/example/repo/pull/7', title: 'Durable alarm retries', lastVisitTime: timestampFromMs(at('2026-10-09 13:30')), focusSeconds: 600 })
  const guide = page('guide', { site: 'docs.example', title: '持久对象指南', lastVisitTime: timestampFromMs(at('2026-10-08 20:00')), focusSeconds: 1500, visitCount: 5 })
  const plain = page('plain', { site: 'news.example', title: 'A durable headline', lastVisitTime: timestampFromMs(at('2026-10-07 08:00')), focusSeconds: 20 })
  fake.addText(pr, textOf('pr', 'The alarm handler retries the durable write after a cold start of the object.'))
  fake.addText(guide, textOf('guide', '冷启动优化：数据库的持久对象在第一次请求时加载。'))
  fake.pages = [pr, guide, plain]
  fake.visits = [visit('pr', [['13:20', '13:30']], { site: 'github.com' }), visit('guide', [['2026-10-08 19:35', '2026-10-08 20:00']], { site: 'docs.example' }), visit('plain', [['2026-10-07 07:59', '2026-10-07 08:00']], { site: 'news.example' })]
  fake.sites = [site('docs.example', 1500), site('github.com', 600), site('news.example', 20)]
  return fake
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settled(): Promise<void> {
  for (let i = 0; i < 8; i++) await tick()
}

// By attribute: jsdom answers `#q` from the document's first element of that ID, which may be an earlier test page's.
const box = (root: HTMLElement) => root.querySelector<HTMLInputElement>('[id="q"]') ?? (() => { throw new Error('no box') })()
const titles = (root: HTMLElement) => [...root.querySelectorAll('.result-title')].map((node) => node.textContent)
const chips = (root: HTMLElement) => [...root.querySelectorAll('.filters > *')].map((node) => (node.classList.contains('set') ? `[${node.querySelector('.filter-value')?.textContent ?? ''}]` : node.textContent))
const lastSearch = (fake: FakeServer) => fake.searches('/api/v1/pages:search').pop()?.searchParams ?? new URLSearchParams()

async function submit(root: HTMLElement, text: string): Promise<void> {
  type(box(root), text)
  box(root).form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settled()
}

describe('before anything is typed', () => {
  it('lists the pages read lately, newest first', async () => {
    const fake = server()
    const root = await open(fake, '/search')
    expect(lastSearch(fake).get('page_type')).toBe('read')
    expect(root.querySelector('.results-line .meta')?.textContent).toBe('最近读过')
    expect(root.querySelector<HTMLElement>('.results-line .segmented')?.hidden).toBe(true)
    expect(titles(root)).toEqual(['Durable alarm retries', '持久对象指南'])
    expect(chips(root)).toEqual(['时间 ▾', '网站 ▾', '类型 ▾', '停留 ▾'])
  })

  it('takes the focus on a desktop only', async () => {
    let root = await open(server(), '/search')
    expect(document.activeElement).not.toBe(box(root))
    root = await open(server(), '/search', testHost(true, true))
    expect(document.activeElement).toBe(box(root))
  })
})

describe('the box', () => {
  it('turns operators followed by a space into chips, keeps the words, and searches with both', async () => {
    const fake = server()
    const root = await open(fake, '/search')
    type(box(root), 'durable site:github.com ')
    await settled()
    expect(box(root).value).toBe('durable ')
    expect(chips(root)).toEqual(['时间 ▾', '[github.com]', '类型 ▾', '停留 ▾'])
    expect([lastSearch(fake).get('query'), lastSearch(fake).get('site')]).toEqual(['durable', 'github.com'])
    expect(urlParams().toString()).toBe('q=durable&site=github.com')
    expect(titles(root)).toEqual(['Durable alarm retries'])
  })

  it('on Enter takes the last operator too, and Backspace in an empty box removes the last chip', async () => {
    const fake = server()
    const root = await open(fake, '/search')
    await submit(root, 'site:github.com type:read')
    expect(box(root).value).toBe('')
    expect(chips(root)).toEqual(['时间 ▾', '[github.com]', '[读过]', '停留 ▾'])
    box(root).focus()
    press('Backspace')
    await settled()
    expect(chips(root)).toEqual(['时间 ▾', '[github.com]', '类型 ▾', '停留 ▾'])
    expect(lastSearch(fake).get('page_type')).toBeNull()
  })

  it('leaves an operator that does not parse as text, with one hint line', async () => {
    const root = await open(server(), '/search')
    type(box(root), 'after:2026-13-01 ')
    await settled()
    expect(box(root).value).toBe('after:2026-13-01 ')
    const hint = root.querySelector<HTMLElement>('.op-hint')
    expect(hint?.hidden).toBe(false)
    expect(hint?.textContent).toBe('after: 需要日期，如 after:2026-10-01 或 after:昨天')
    type(box(root), 'after:2026-10-01 ')
    await settled()
    expect(hint?.hidden).toBe(true)
    expect(chips(root)[0]).toBe('[10月1日 起]')
  })

  it('searches nothing while an operator that does not parse is in the box, and reads 昨天 as a date', async () => {
    const fake = server()
    const root = await open(fake, '/search')
    const before = fake.searches('/api/v1/pages:search').length
    type(box(root), '数据库 after:明天 site:github.com ')
    await settled()
    // site: became a chip, yet nothing was searched: the hint says what after: needs.
    expect(chips(root)[1]).toBe('[github.com]')
    expect(fake.searches('/api/v1/pages:search').length).toBe(before)
    expect(root.querySelector('.op-hint')?.textContent).toBe('after: 需要日期，如 after:2026-10-01 或 after:昨天')
    await submit(root, '数据库 after:昨天')
    expect(chips(root)[0]).toBe('[10月8日 起]')
    expect(lastSearch(fake).get('query')).toBe('数据库')
  })

  it('names a lone Chinese character that took no part beside other terms', async () => {
    const root = await open(server(), '/search')
    await submit(root, '持久 对')
    const hint = root.querySelector<HTMLElement>('.terms-hint')
    expect(hint?.hidden).toBe(false)
    expect(hint?.textContent).toBe('「对」是单个汉字，没有参与搜索，可以连着前后的字写，如「持久对」')
    await submit(root, '持久对象')
    expect(hint?.hidden).toBe(true)
  })

  it("says when today's read budget is spent, without 重试", async () => {
    const fake = server()
    fake.overBudget = true
    const root = await open(fake, '/search?q=durable')
    expect(root.querySelector('.results-area')?.textContent).toBe('今天的搜索额度用完了，明天（UTC 零点后）再搜；时间线和页面照常能看')
    expect(root.querySelector('.results-area .error-line')).toBeNull()
  })

  it('explains a query of a lone Chinese character', async () => {
    const root = await open(server(), '/search')
    await submit(root, '数')
    expect(root.querySelector('.results-area')?.textContent).toBe('单个汉字搜不到，请多输入一个字')
  })

  it('clears the box with Escape and searches again', async () => {
    const fake = server()
    const root = await open(fake, '/search?q=durable')
    box(root).focus()
    press('Escape')
    await settled()
    expect(box(root).value).toBe('')
    expect(window.location.search).toBe('')
    expect(root.querySelector('.results-line .meta')?.textContent).toBe('最近读过')
  })

  it("searches again when the box's own ✕ empties it", async () => {
    const fake = server()
    const root = await open(fake, '/search?q=durable')
    type(box(root), '')
    await settled()
    expect(window.location.search).toBe('')
    expect(lastSearch(fake).get('query')).toBeNull()
    expect(root.querySelectorAll('.results mark').length).toBe(0)
  })
})

describe('the chips', () => {
  it('sets a time preset of the last n days, today included, and gives the focus back to the chip', async () => {
    const fake = server()
    const root = await open(fake, '/search')
    buttonNamed(root, '时间 ▾').click()
    const popover = root.querySelector<HTMLElement>('.popover')
    expect(popover?.hidden).toBe(false)
    expect([...(popover?.querySelectorAll('.segmented button') ?? [])].map((node) => node.textContent)).toEqual(['今天', '7 天', '30 天', '自定义'])
    buttonNamed(popover ?? root, '7 天').click()
    await settled()
    expect(popover?.hidden).toBe(true)
    expect(chips(root)[0]).toBe('[近 7 天]')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('时间：近 7 天')
    expect(lastSearch(fake).get('start_time')).toBe(new Date(dayStart(addDays('2026-10-09', -6))).toISOString().replace('.000', ''))
    expect(urlParams().get('after')).toBe('2026-10-03')
    // Opened again, the focus is on the chosen preset, not the first.
    root.querySelector<HTMLButtonElement>('.filter-value')?.click()
    expect(document.activeElement?.textContent).toBe('7 天')
    // 任何时间 clears it.
    buttonNamed(popover ?? root, '任何时间').click()
    await settled()
    expect(chips(root)[0]).toBe('时间 ▾')
  })

  it('takes a custom range of two dates, the second included', async () => {
    const fake = server()
    const root = await open(fake, '/search')
    buttonNamed(root, '时间 ▾').click()
    buttonNamed(root, '自定义').click()
    const [from, to] = [...root.querySelectorAll<HTMLInputElement>('.popover input[type="date"]')]
    if (from === undefined || to === undefined) throw new Error('no dates')
    expect(document.activeElement).toBe(from)
    from.value = '2026-09-01'
    to.value = '2026-09-30'
    buttonNamed(root, '确定').click()
    await settled()
    expect(chips(root)[0]).toBe('[9月1日 至 9月30日]')
    expect([urlParams().get('after'), urlParams().get('before')]).toEqual(['2026-09-01', '2026-10-01'])
    expect(lastSearch(fake).get('end_time')).toBe('2026-09-30T16:00:00Z')
  })

  it('takes one day when only 从 is picked', async () => {
    const fake = server()
    const root = await open(fake, '/search')
    buttonNamed(root, '时间 ▾').click()
    buttonNamed(root, '自定义').click()
    const [from, to] = [...root.querySelectorAll<HTMLInputElement>('.popover input[type="date"]')]
    if (from === undefined || to === undefined) throw new Error('no dates')
    from.value = '2026-09-15'
    from.dispatchEvent(new Event('change'))
    expect(to.value).toBe('2026-09-15')
    buttonNamed(root, '确定').click()
    await settled()
    expect(chips(root)[0]).toBe('[9月15日]')
    expect([urlParams().get('after'), urlParams().get('before')]).toEqual(['2026-09-15', '2026-09-16'])
  })

  it('closes on Escape and on a click outside; one popover at a time', async () => {
    const root = await open(server(), '/search')
    const popover = root.querySelector<HTMLElement>('.popover')
    buttonNamed(root, '类型 ▾').click()
    expect(popover?.getAttribute('aria-label')).toBe('类型')
    buttonNamed(root, '停留 ▾').click()
    expect(popover?.getAttribute('aria-label')).toBe('停留')
    press('Escape')
    expect(popover?.hidden).toBe(true)
    expect(document.activeElement?.textContent).toBe('停留 ▾')
    buttonNamed(root, '类型 ▾').click()
    await tick()
    document.body.click()
    expect(popover?.hidden).toBe(true)
  })

  it('sets the type and the least focus, presets and custom', async () => {
    const fake = server()
    const root = await open(fake, '/search')
    buttonNamed(root, '类型 ▾').click()
    buttonNamed(root, '读过').click()
    await settled()
    buttonNamed(root, '停留 ▾').click()
    buttonNamed(root, '2 分').click()
    await settled()
    expect(chips(root)).toEqual(['时间 ▾', '网站 ▾', '[读过]', '[停留 ≥ 2 分]'])
    expect([lastSearch(fake).get('page_type'), lastSearch(fake).get('min_focus_seconds')]).toEqual(['read', '120'])
    root.querySelectorAll<HTMLButtonElement>('.filter-value')[1]?.click()
    buttonNamed(root, '自定义').click()
    const field = root.querySelector<HTMLInputElement>('.popover input')
    if (field === null) throw new Error('no field')
    field.value = 'soon'
    buttonNamed(root, '确定').click()
    expect(root.querySelector('.popover .hint.warn')?.textContent).toBe('需要时长，如 5m、90s、1h')
    field.value = '5m'
    buttonNamed(root, '确定').click()
    await settled()
    expect(chips(root)[3]).toBe('[停留 ≥ 5 分]')
    expect(urlParams().get('dwell')).toBe('300')
    // ✕ removes a chip; the focus stays on the chip, idle now.
    buttonNamed(root, '去掉 停留').click()
    await settled()
    expect(chips(root)[3]).toBe('停留 ▾')
    expect(document.activeElement?.textContent).toBe('停留 ▾')
  })

  it('picks a site from the top sites as one types, or takes a typed host on Enter', async () => {
    const fake = server()
    const root = await open(fake, '/search')
    buttonNamed(root, '网站 ▾').click()
    await settled()
    const input = root.querySelector<HTMLInputElement>('.popover .picker input')
    if (input === null) throw new Error('no picker')
    expect(document.activeElement).toBe(input)
    const options = () => [...root.querySelectorAll('.picker [role="option"]')].map((node) => node.textContent)
    expect(options()).toEqual(['docs.example', 'github.com', 'news.example'])
    type(input, 'git')
    await settled()
    expect(options()).toEqual(['github.com'])
    press('Enter')
    await settled()
    expect(chips(root)[1]).toBe('[github.com]')
    expect(fake.searches('/api/v1/sites').length).toBe(1)
    root.querySelector<HTMLButtonElement>('.filter-value')?.click()
    await settled()
    const again = root.querySelector<HTMLInputElement>('.popover .picker input')
    if (again === null) throw new Error('no picker')
    type(again, 'https://www.Example.org/path')
    await settled()
    expect(options()).toEqual(['example.org（含子域名）'])
    press('Enter')
    await settled()
    expect(chips(root)[1]).toBe('[example.org]')
  })

  it('takes a typed domain over a subdomain that holds it, and ranks the hosts that start with the text first', async () => {
    const fake = server()
    fake.sites = [site('docs.example.org', 900), site('mail.example.org', 800), site('gist.example.net', 700), site('example.net', 600), site('example.org', 10)]
    const root = await open(fake, '/search')
    buttonNamed(root, '网站 ▾').click()
    await settled()
    const input = root.querySelector<HTMLInputElement>('.popover .picker input')
    if (input === null) throw new Error('no picker')
    const options = () => [...root.querySelectorAll('.picker [role="option"]')].map((node) => node.textContent)
    type(input, 'example.org')
    await settled()
    expect(options()).toEqual(['example.org（含子域名）', 'docs.example.org', 'mail.example.org'])
    press('Enter')
    await settled()
    expect(chips(root)[1]).toBe('[example.org]')
    root.querySelector<HTMLButtonElement>('.filter-value')?.click()
    await settled()
    const again = root.querySelector<HTMLInputElement>('.popover .picker input')
    if (again === null) throw new Error('no picker')
    type(again, 'exa')
    await settled()
    expect(options()).toEqual(['example.net', 'example.org', 'docs.example.org', 'mail.example.org', 'gist.example.net'])
  })

  it('asks the server’s prefix filter past the 200 sites it loaded', async () => {
    const fake = server()
    fake.sites = [...Array.from({ length: 200 }, (_, i) => site(`s${String(i)}.example`, 1000 + i)), site('zeta.example', 1)]
    const root = await open(fake, '/search')
    buttonNamed(root, '网站 ▾').click()
    await settled()
    const input = root.querySelector<HTMLInputElement>('.popover .picker input')
    if (input === null) throw new Error('no picker')
    type(input, 'zeta')
    await new Promise((resolve) => setTimeout(resolve, 250))
    await settled()
    expect(fake.searches('/api/v1/sites').map((url) => [url.searchParams.get('page_size'), url.searchParams.get('filter')])).toEqual([
      ['200', null],
      ['20', '"zeta"'],
    ])
    expect([...root.querySelectorAll('.picker [role="option"]')].map((node) => node.textContent)).toEqual(['zeta.example'])
  })
})

describe('the URL', () => {
  it('holds the whole search, so a reload shows the same', async () => {
    const fake = server()
    const root = await open(fake, '/search?q=durable&site=github.com&after=2026-10-01&before=2026-10-10&type=read&dwell=120&sort=recent')
    expect(box(root).value).toBe('durable')
    expect(chips(root)).toEqual(['[10月1日 至 10月9日]', '[github.com]', '[读过]', '[停留 ≥ 2 分]'])
    const asked = lastSearch(fake)
    expect(Object.fromEntries(asked)).toEqual({
      query: 'durable',
      start_time: '2026-09-30T16:00:00Z',
      end_time: '2026-10-09T16:00:00Z',
      site: 'github.com',
      page_type: 'read',
      min_focus_seconds: '120',
      sort_order: 'recent',
    })
    expect(root.querySelector('.results-line [aria-pressed="true"]')?.textContent).toBe('最新')
  })
})

describe('results', () => {
  it('shows each result’s title and snippet with the words marked, its site, date, focus and visits', async () => {
    const root = await open(server(), '/search')
    await submit(root, 'durable')
    expect(root.querySelector('.results-line .meta')?.textContent).toBe('2 个结果')
    const [pr, plain] = [...root.querySelectorAll('.result')]
    expect(pr?.querySelector('.result-title mark')?.textContent).toBe('Durable')
    expect(pr?.querySelector('.result-meta')?.textContent).toBe('github.com · 今天 13:30 · 停留 10 分 · 3 次')
    expect(pr?.querySelector('.snippet mark')?.textContent).toBe('durable')
    // Without a snippet, the URL in small mono.
    expect(plain?.querySelector('.result-url.mono')?.textContent).toBe('https://news.example/plain')
    expect(plain?.querySelector('.result-meta')?.textContent).toBe('news.example · 10月7日 · 停留 20 秒 · 3 次')
    const link = pr?.querySelector<HTMLAnchorElement>('a.result-link')
    expect(link?.getAttribute('href')).toBe(`/pages/${pageId('pr')}?q=durable`)
    link?.click()
    await settled()
    expect(window.location.pathname).toBe(`/pages/${pageId('pr')}`)
  })

  it('offers 相关 · 最新 with words only', async () => {
    const fake = server()
    const root = await open(fake, '/search?q=durable')
    const sort = root.querySelector('.results-line .segmented')
    expect([...(sort?.querySelectorAll('button') ?? [])].map((node) => [node.textContent, node.getAttribute('aria-pressed')])).toEqual([
      ['相关', 'true'],
      ['最新', 'false'],
    ])
    buttonNamed(root, '最新').focus()
    buttonNamed(root, '最新').click()
    await settled()
    expect(lastSearch(fake).get('sort_order')).toBe('recent')
    expect(urlParams().get('sort')).toBe('recent')
    // The toggle is not drawn again: it keeps the focus.
    expect(document.activeElement?.textContent).toBe('最新')
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true')
  })

  it('adds the next ten with 加载更多 and gives the exact count on the last page', async () => {
    const fake = server()
    fake.pages = Array.from({ length: 15 }, (_, i) => page(`p${String(i)}`, { title: `durable ${String(i)}`, lastVisitTime: timestampFromMs(NOW - i * HOUR) }))
    const root = await open(fake, '/search?q=durable')
    expect(root.querySelectorAll('.result').length).toBe(10)
    expect(root.querySelector('.results-line .meta')?.textContent).toBe('10+ 个结果')
    buttonNamed(root, '加载更多').click()
    await settled()
    expect(root.querySelectorAll('.result').length).toBe(15)
    expect(root.querySelector('.results-line .meta')?.textContent).toBe('15 个结果')
    expect(() => buttonNamed(root, '加载更多')).toThrow()
    // The focus goes to the first result it added.
    expect(document.activeElement).toBe(root.querySelectorAll('.result-link')[10])
  })

  it('shows the results as they were when back returns from a page, 加载更多 included, without searching again', async () => {
    const fake = server()
    fake.pages = Array.from({ length: 15 }, (_, i) => page(`p${String(i)}`, { title: `durable ${String(i)}`, lastVisitTime: timestampFromMs(NOW - i * HOUR) }))
    const root = await open(fake, '/search?q=durable')
    buttonNamed(root, '加载更多').click()
    await settled()
    root.querySelectorAll<HTMLAnchorElement>('.result-link')[12]?.click()
    await settled()
    expect(window.location.pathname).toBe(`/pages/${pageId('p12')}`)
    const searches = fake.searches('/api/v1/pages:search').length
    window.history.back()
    await settled()
    await settled()
    expect(window.location.pathname).toBe('/search')
    expect(root.querySelectorAll('.result').length).toBe(15)
    expect(root.querySelector('.results-line .meta')?.textContent).toBe('15 个结果')
    expect(fake.searches('/api/v1/pages:search').length).toBe(searches)
  })

  it('says which read bound a capped search reached', async () => {
    const fake = server()
    fake.capped = true
    let root = await open(fake, '/search?q=durable')
    expect(root.querySelector('.cap')?.textContent).toBe('匹配的页面太多，只看了最相关的 2000 个，加个条件或换个词试试')
    root = await open(fake, '/search?q=durable&sort=recent')
    expect(root.querySelector('.cap')?.textContent).toBe('结果可能不全：只看了最近访问的 5000 个页面，加个时间范围或换个条件试试')
    root = await open(fake, '/search?dwell=3600')
    expect(root.querySelector('.cap')?.textContent).toBe('结果可能不全：只看了最近访问的 5000 个页面，加个时间范围或换个条件试试')
    root = await open(fake, '/search?q=durable&after=2026-10-01')
    expect(root.querySelector('.cap')?.textContent).toBe('这段时间访问太多，只看了最近的 2 万次访问，缩短时间试试')
  })

  it('without results, drops a chip at a time and says what the index covers', async () => {
    const fake = server()
    fake.status = { oldestIndexedTextTime: timestampFromMs(at('2025-03-04 10:00')) }
    const root = await open(fake, '/search?q=durable&site=docs.example&type=read')
    expect(root.querySelector('.empty strong')?.textContent).toBe('没有找到')
    expect([...root.querySelectorAll('.empty button')].map((node) => node.textContent)).toEqual(['去掉 网站：docs.example', '去掉 类型：读过'])
    expect([...root.querySelectorAll('.empty p.hint')].map((node) => node.textContent)).toEqual(['正文只搜每页前 32 KB', '正文搜索覆盖 2025年3月 起，更早的页面只按标题和网址搜索（全文仍在页面详情和 Dropbox 归档里）'])
    buttonNamed(root, '去掉 网站：docs.example').click()
    await settled()
    expect(titles(root)).toEqual(['Durable alarm retries'])
  })

  it('does not limit text search coverage to the seven-day R2 window', async () => {
    const fake = server()
    fake.status = { textRetentionDays: 7, archivedTextCount: 12 }
    const root = await open(fake, '/search?q=durable')
    expect(titles(root)).toEqual(['Durable alarm retries', 'A durable headline'])
    expect(root.querySelector('.coverage')).toBeNull()
  })

  it('moves between results with ↓ ↑ and j k, from and back to the box', async () => {
    const root = await open(server(), '/search?q=durable')
    const links = [...root.querySelectorAll<HTMLAnchorElement>('.result-link')]
    box(root).focus()
    press('ArrowDown')
    expect(document.activeElement).toBe(links[0])
    press('j')
    expect(document.activeElement).toBe(links[1])
    press('j')
    expect(document.activeElement).toBe(links[1])
    press('k')
    press('ArrowUp')
    expect(document.activeElement).toBe(box(root))
  })
})
