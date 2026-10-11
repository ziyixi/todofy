/**
 * 页面详情 against the fake API: the head (title, site, URL as a safe link, the scrubbed and cut hints, the figures),
 * 正文 in the reader with the query's words marked and 第 n/m 处 (its buttons and the keys n and N; the first match
 * scrolled to only when it is below the screen), the capture lines, no capture, 访问 and 更多, and the
 * ⋯ actions: opening the page, the denylist addition (asked first, only denylist_patterns with the etag) and the
 * deletion (asked first, then back to where it was opened from).
 */
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { onTestFinished, vi } from 'vitest'
import { at, FakeServer, page, pageId, textOf, visit } from './test/fakeServer.ts'
import { buttonNamed, open, press, testHost, toastText } from './test/helpers.ts'

const ID = pageId('pr')
const TEXT = 'Durable Objects 的 alarm 在冷启动后重试。\n\n第二段：alarm 会再次运行。\n一行接着一行。\n\n第三段没有。'

function server(): FakeServer {
  const fake = new FakeServer()
  const pr = page('pr', { site: 'github.com', url: 'https://github.com/example/repo/pull/7', title: 'Alarm retries', lastVisitTime: timestampFromMs(at('2026-10-09 13:30')), documentCount: 3 })
  fake.addText(pr, textOf('pr', TEXT, { textTruncated: true, searchTruncated: true }))
  fake.pages = [pr]
  fake.visits = Array.from({ length: 25 }, (_, i) => visit('pr', [[`2026-10-${String(9 - (i % 9)).padStart(2, '0')} ${String(8 + Math.floor(i / 9)).padStart(2, '0')}:00`, `2026-10-${String(9 - (i % 9)).padStart(2, '0')} ${String(8 + Math.floor(i / 9)).padStart(2, '0')}:20`]], { site: 'github.com' }))
  return fake
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settled(): Promise<void> {
  for (let i = 0; i < 8; i++) await tick()
}

describe('the head', () => {
  it('shows the title, the site, the URL as a link of its own tab, and the page’s figures', async () => {
    const root = await open(server(), `/pages/${ID}`)
    expect(root.querySelector('.page-title')?.textContent).toBe('Alarm retries')
    expect(root.querySelector('.page-site')?.textContent).toBe('github.com')
    const link = root.querySelector<HTMLAnchorElement>('a.page-url')
    expect([link?.getAttribute('href'), link?.target, link?.rel]).toEqual(['https://github.com/example/repo/pull/7', '_blank', 'noopener noreferrer'])
    expect(root.querySelector('.page-head > p.meta')?.textContent).toBe('第一次 2026-09-01 · 最近 今天 13:30 · 3 次 · 共停留 10 分')
    expect(root.querySelector('.page-head .hint')).toBeNull()
  })

  it('says when the scrubber took part of the URL out or it was cut; a URL that is not http(s) is no link', async () => {
    const fake = new FakeServer()
    fake.pages = [page('a', { url: 'https://example.com/reset/[redacted]', urlTruncated: true }), page('b', { url: 'ftp://example.com/x' })]
    let root = await open(fake, `/pages/${pageId('a')}`)
    expect([...root.querySelectorAll('.page-head .hint')].map((node) => node.textContent)).toEqual(['网址里的敏感部分已去掉', '网址太长，只保存了开头'])
    root = await open(fake, `/pages/${pageId('b')}`)
    expect(root.querySelector('a.page-url')).toBeNull()
    expect(root.querySelector('p.page-url')?.textContent).toBe('ftp://example.com/x')
  })

  it('answers a page that is gone with the API’s words', async () => {
    const root = await open(new FakeServer(), `/pages/${pageId('none')}`)
    expect(root.querySelector('.error-line span')?.textContent).toBe('找不到这一项（可能已被删除）')
  })
})

describe('正文', () => {
  it('reads as paragraphs, says what was cut and what search sees, and how many captures there were', async () => {
    const root = await open(server(), `/pages/${ID}`)
    const card = [...root.querySelectorAll('.card')][0]
    expect(card?.querySelector('.card-head')?.textContent).toBe('正文10月9日保存 · 共 3 次')
    expect([...root.querySelectorAll('.reader p')].map((node) => node.textContent)).toEqual(['Durable Objects 的 alarm 在冷启动后重试。', '第二段：alarm 会再次运行。\n一行接着一行。', '第三段没有。'])
    expect([...(card?.querySelectorAll(':scope > p.hint') ?? [])].map((node) => node.textContent)).toEqual(['正文超过 64 KB，只保存了开头', '搜索只看正文前 32 KB'])
    expect(root.querySelector('.find')).toBeNull()
  })

  it('marks the query’s words from a search and steps through them', async () => {
    const root = await open(server(), `/pages/${ID}?q=alarm%20%E5%86%B7%E5%90%AF%E5%8A%A8`)
    expect([...root.querySelectorAll('.reader mark')].map((node) => node.textContent)).toEqual(['alarm', '冷启动', 'alarm'])
    expect(root.querySelector('.page-title mark')?.textContent).toBe('Alarm')
    const where = root.querySelector('.find .meta')
    expect(where?.textContent).toBe('第 1/3 处')
    expect(root.querySelector('.reader mark.current')?.textContent).toBe('alarm')
    buttonNamed(root, '下一处').click()
    expect(where?.textContent).toBe('第 2/3 处')
    expect(root.querySelector('.reader mark.current')?.textContent).toBe('冷启动')
    buttonNamed(root, '上一处').click()
    buttonNamed(root, '上一处').click()
    expect(where?.textContent).toBe('第 3/3 处')
    // n and N step as a find-in-page bar does.
    press('n')
    expect(where?.textContent).toBe('第 1/3 处')
    press('N')
    expect(where?.textContent).toBe('第 3/3 处')
  })

  it('brings the first match into sight only when it is below the screen', async () => {
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? '')
    }
    onTestFinished(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    })
    // jsdom lays nothing out: every element is at the top, in sight.
    await open(server(), `/pages/${ID}?q=alarm`)
    expect(scrolled).toEqual([])
    // Every element below the screen now.
    const below = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, window.innerHeight + 50, 10, 50))
    onTestFinished(() => {
      below.mockRestore()
    })
    await open(server(), `/pages/${ID}?q=alarm`)
    expect(scrolled).toEqual(['alarm'])
  })

  it('without a capture, says why there is no text', async () => {
    const fake = new FakeServer()
    fake.pages = [page('short')]
    const root = await open(fake, `/pages/${pageId('short')}`)
    expect(root.querySelector('.card .hint')?.textContent).toBe('停留不到 10 秒或在不保存正文的名单里，没有正文')
    expect(fake.calls.some((call) => call.path.includes('/documents/'))).toBe(false)
  })
})

describe('访问', () => {
  it('lists the visits newest first, 20 at a time, each opening its day at its hour', async () => {
    const root = await open(server(), `/pages/${ID}`)
    const rows = () => [...root.querySelectorAll('.visits li')]
    expect(rows().length).toBe(20)
    expect(rows()[0]?.textContent).toBe('10月9日 10:00–10:2020 分 · MacBook · 工作')
    buttonNamed(root, '更多').click()
    await settled()
    expect(rows().length).toBe(25)
    expect(() => buttonNamed(root, '更多')).toThrow()
    rows()[0]?.querySelector('a')?.click()
    await settled()
    expect(`${window.location.pathname}${window.location.search}`).toBe('/day/2026-10-09?hour=10')
  })
})

describe('the ⋯ actions', () => {
  it('opens the page itself in a new tab', async () => {
    const host = testHost()
    const root = await open(server(), `/pages/${ID}`, host)
    buttonNamed(root, '页面操作').click()
    buttonNamed(root, '打开原网页').click()
    expect(host.opened).toEqual(['https://github.com/example/repo/pull/7'])
  })

  it('adds the site to the denylist after asking, sending only the patterns with the etag', async () => {
    const fake = server()
    const host = testHost()
    const root = await open(fake, `/pages/${ID}`, host)
    buttonNamed(root, '页面操作').click()
    buttonNamed(root, '以后不保存这个网站的正文').click()
    await settled()
    expect(host.asked).toEqual(['以后不保存 github.com 的正文？之后只记录访问时间、网址和标题，已保存的正文不变。'])
    const update = fake.calls.find((call) => call.method === 'PATCH')
    expect(update?.path).toMatch(/^\/api\/v1\/settings\?update_mask=denylist_patterns%2Cetag&request_id=[0-9a-f-]{36}$/)
    expect(update?.body).toEqual({ denylist_patterns: ['bank.example', 'github.com'], etag: 's1' })
    expect(update?.headers['x-csrf-token']).toBe('csrf-token')
    expect(toastText(root)).toBe('以后不保存 github.com 的正文')
    // Already there: nothing more is sent.
    buttonNamed(root, '页面操作').click()
    buttonNamed(root, '以后不保存这个网站的正文').click()
    await settled()
    expect(fake.calls.filter((call) => call.method === 'PATCH').length).toBe(1)
    expect(toastText(root)).toBe('github.com 已在不保存正文的名单里')
  })

  it('changes nothing when the owner says no', async () => {
    const fake = server()
    const root = await open(fake, `/pages/${ID}`, testHost(false))
    buttonNamed(root, '页面操作').click()
    buttonNamed(root, '以后不保存这个网站的正文').click()
    buttonNamed(root, '页面操作').click()
    buttonNamed(root, '删除这个页面的记录').click()
    await settled()
    expect(fake.calls.filter((call) => call.method !== 'GET')).toEqual([])
  })

  it('deletes the record after asking, then goes back to the search it was opened from', async () => {
    const fake = server()
    const host = testHost()
    const root = await open(fake, '/search?q=alarm', host)
    root.querySelector<HTMLAnchorElement>('a.result-link')?.click()
    await settled()
    expect(window.location.pathname).toBe(`/pages/${ID}`)
    expect(root.querySelector('.tabs a[aria-current="page"]')?.textContent).toBe('搜索')
    buttonNamed(root, '页面操作').click()
    buttonNamed(root, '删除这个页面的记录').click()
    await settled()
    expect(host.asked).toEqual(['删除这个页面的记录？访问和正文会从 recall 删除，不能恢复；Dropbox 备份只增不删，会多一条删除记录，原来的文件要在 Dropbox 里自己删。'])
    const removal = fake.calls.find((call) => call.method === 'DELETE')
    expect(removal?.path).toMatch(new RegExp(`^/api/v1/pages/${ID}\\?request_id=[0-9a-f-]{36}$`))
    expect(fake.pages).toEqual([])
    expect(toastText(root)).toBe('已删除这个页面的记录')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await settled()
    expect(`${window.location.pathname}${window.location.search}`).toBe('/search?q=alarm')
  })
})
