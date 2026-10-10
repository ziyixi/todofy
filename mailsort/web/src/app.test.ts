/**
 * The owner's flows in the UI against the fake API (test/fakeServer.ts, the shared transcoder): the shell's four tabs
 * (the focus kept on a tab chosen by keyboard) and status line; 待审's confirm, change and skip (ResolveReviewItem with
 * the CSRF header and a request ID each), its keyboard, its picker and its caution; 设置's mode, ceiling and breaker, the
 * range undo's preview and confirmation and the sync. 标签 has its own file, labels.test.ts.
 */
import { mountApp, type Host } from './app.ts'
import { relative } from './format.ts'
import { FakeServer, label, ledgerEntry, NOW, reviewItem, settle } from './test/fakeServer.ts'
import { Label_GmailState } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { CandidateSchema } from '@ziyixi/proto/mailsort/ui/v2/review_pb'
import { Mode, ServiceStatus_AuthState } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'

const host: Host = { now: () => NOW, confirm: () => true }

async function open(server: FakeServer, path: string, with_: Host = host): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', path)
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, with_)
  await settle()
  return root
}

const toastText = (root: HTMLElement) => root.querySelector('#toast')?.textContent ?? ''

function buttonNamed(root: ParentNode, text: string, index = 0): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].filter((node) => node.textContent === text)
  const button = found[index]
  if (button === undefined) throw new Error(`no button ${text}`)
  return button
}

/** A key pressed where the focus is (or on the page when nothing has it). */
function press(key: string): void {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLLIElement>('ul.rows > li')]

describe('the shell', () => {
  it('has exactly four tabs, the quiet status line, and answers an unknown path', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a'), reviewItem('b'), reviewItem('c')]
    const root = await open(server, '/nowhere')
    const tabs = [...root.querySelectorAll<HTMLAnchorElement>('.tabs a')]
    expect(tabs.map((a) => a.firstChild?.textContent)).toEqual(['待审', '概览', '标签', '设置'])
    expect(tabs.map((a) => a.getAttribute('href'))).toEqual(['/', '/overview', '/labels', '/settings'])
    // The queue's size on its tab.
    expect(tabs[0]?.querySelector('.chip')?.textContent).toBe('3')
    expect(tabs[0]?.getAttribute('aria-label')).toBe('待审（3 封）')
    const line = root.querySelector('.status-line')
    expect([...(line?.children ?? [])].map((part) => part.textContent)).toEqual(['影子', 'Gmail ✓ 只读', '下次运行 5 分钟后'])
    expect(root.textContent).toContain('找不到这个页面')
  })

  it('says what is wrong with Gmail instead of the check mark, and badges the live mode', async () => {
    const server = new FakeServer()
    server.status = { authState: ServiceStatus_AuthState.FAILED, effectiveMode: Mode.LIVE }
    const root = await open(server, '/settings')
    expect(root.querySelector('.status-line .chip.accent')?.textContent).toBe('正式')
    expect(root.querySelector('.status-line .problem')?.textContent).toBe('Gmail 授权失效')
    expect(root.querySelector('.tabs a[aria-current="page"]')?.textContent).toBe('设置')
  })

  it('keeps the focus on a tab chosen by keyboard: the tabs are only marked, never drawn again', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a')]
    const root = await open(server, '/')
    const overview = root.querySelector<HTMLAnchorElement>('.tabs a[href="/overview"]')
    if (overview === null) throw new Error('no tab')
    overview.focus()
    overview.click()
    await settle()
    expect(overview.isConnected).toBe(true)
    expect(document.activeElement).toBe(overview)
    expect(overview.getAttribute('aria-current')).toBe('page')
    expect(root.querySelectorAll('.tabs a[aria-current]').length).toBe(1)
    expect(root.querySelector('.tabs a .chip')?.textContent).toBe('1')
  })

  it('says 马上 for a time less than a minute ahead, 刚刚 for one just past', () => {
    expect(relative(timestampFromMs(NOW + 20_000), NOW)).toBe('马上')
    expect(relative(timestampFromMs(NOW - 20_000), NOW)).toBe('刚刚')
    expect(relative(timestampFromMs(NOW + 300_000), NOW)).toBe('5 分钟后')
    expect(relative(timestampFromMs(NOW - 3 * 3_600_000), NOW)).toBe('3 小时前')
  })

  it('moves between tabs without reloading; 规则 has no page of its own any more', async () => {
    const server = new FakeServer()
    const root = await open(server, '/rules')
    expect(root.textContent).toContain('找不到这个页面')
    root.querySelector<HTMLAnchorElement>('.tabs a[href="/labels"]')?.click()
    await settle()
    expect(window.location.pathname).toBe('/labels')
    expect(root.querySelector('.tabs a[aria-current="page"]')?.textContent).toBe('标签')
    root.querySelector<HTMLAnchorElement>('.tabs a[href="/overview"]')?.click()
    await settle()
    expect(window.location.pathname).toBe('/overview')
    expect(root.querySelector('h1')?.textContent).toBe('概览')
  })
})

describe('待审', () => {
  it('confirms, changes through the searchable picker and skips, with CSRF and a request ID each', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a'), reviewItem('b', { reason: 'model_unavailable', candidates: [] }), reviewItem('c')]
    const root = await open(server, '/')
    expect(rows(root).length).toBe(3)
    const [a, b] = rows(root)
    expect(a?.textContent).toContain('主题 a')
    expect(a?.querySelector('.chip.accent')?.textContent).toBe('订阅')
    expect(a?.textContent).toContain('60%')
    // A mail the model could not read: why, and no 确认.
    expect(b?.textContent).toContain('模型暂不可用')
    expect(b?.querySelector('.chip')?.textContent).toBe('都不是')
    expect([...(b?.querySelectorAll('button') ?? [])].map((node) => node.textContent)).toEqual(['改为…', '跳过'])

    buttonNamed(a ?? root, '确认').click()
    await settle()
    const confirm = server.calls.find((call) => call.path.startsWith('/api/v2/reviewItems/a:resolve'))
    expect(confirm?.method).toBe('POST')
    expect(confirm?.body?.['label']).toBe('labels/newsletter')
    expect(confirm?.headers['x-csrf-token']).toBe('csrf-token')
    expect(String(confirm?.body?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(toastText(root)).toBe('已确认：订阅')
    expect(rows(root).length).toBe(2)
    // The header follows the queue.
    expect(root.querySelector('.tabs a .chip')?.textContent).toBe('2')

    buttonNamed(rows(root)[0] ?? root, '改为…').click()
    const search = root.querySelector<HTMLInputElement>('.picker input')
    if (search === null) throw new Error('no picker')
    expect(document.activeElement).toBe(search)
    expect([...root.querySelectorAll('.picker [role="option"]')].map((node) => node.textContent)).toEqual(['都不是', '订阅', '收据'])
    search.value = '收'
    search.dispatchEvent(new Event('input'))
    expect([...root.querySelectorAll('.picker [role="option"]')].map((node) => node.textContent)).toEqual(['收据'])
    press('Enter')
    await settle()
    expect(server.calls.find((call) => call.path.includes('/b:resolve'))?.body?.['label']).toBe('labels/receipt')
    expect(toastText(root)).toBe('已改为：收据')

    buttonNamed(root, '跳过').click()
    await settle()
    expect(server.calls.some((call) => call.path.includes('/c:skip'))).toBe(true)
    expect(root.textContent).toContain('都处理完了')
  })

  it('moves with j and k, confirms with Enter, opens the picker with c and skips with s', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a'), reviewItem('b'), reviewItem('c')]
    const root = await open(server, '/')
    press('j')
    expect(document.activeElement).toBe(rows(root)[0])
    press('j')
    press('j')
    press('j')
    // The last row stays the last.
    expect(document.activeElement).toBe(rows(root)[2])
    press('k')
    expect(document.activeElement).toBe(rows(root)[1])
    expect(rows(root)[1]?.classList.contains('active')).toBe(true)
    press('Enter')
    await settle()
    expect(server.calls.some((call) => call.path.startsWith('/api/v2/reviewItems/b:resolve'))).toBe(true)
    // The row after it took its place and the focus.
    expect(rows(root).map((row) => row.getAttribute('aria-label'))).toEqual(['主题 a', '主题 c'])
    expect(document.activeElement).toBe(rows(root)[1])

    press('c')
    const search = root.querySelector<HTMLInputElement>('.picker input')
    expect(document.activeElement).toBe(search)
    // Typing in the search box is typing: j does not move.
    search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    expect(document.activeElement).toBe(search)
    press('Escape')
    expect(root.querySelector('.picker')).toBeNull()
    expect(document.activeElement?.textContent).toBe('改为…')

    press('s')
    await settle()
    expect(server.calls.some((call) => call.path.includes('/c:skip'))).toBe(true)
    expect(rows(root).map((row) => row.getAttribute('aria-label'))).toEqual(['主题 a'])
    expect(root.querySelector('.keys')?.textContent).toContain('跳过')
  })

  it('slows the owner down on a suspected phishing mail and on a trust label for a sender not trusted yet', async () => {
    const server = new FakeServer()
    server.labels.push(Object.assign(label('bank', '银行'), { trustImplying: true }))
    const candidates = [create(CandidateSchema, { label: 'labels/bank', probability: 0.7 }), create(CandidateSchema, { label: 'labels/receipt', probability: 0.2 })]
    server.reviewItems = [reviewItem('p', { reason: 'suspicious', candidates }), reviewItem('t', { reason: 'untrusted_sender', candidates })]
    const asked: string[] = []
    const root = await open(server, '/', { now: () => NOW, confirm: (message) => (asked.push(message), false) })
    const [phishing, trust] = rows(root)
    expect(phishing?.textContent).toContain('疑似钓鱼：先在 Gmail 里核对发件人和链接')
    expect(trust?.textContent).toContain('发件人还不可信')
    // The warning line says why: the small text says nothing more.
    expect([...(phishing?.querySelectorAll('.suggestion .meta') ?? [])].map((node) => node.textContent)).toEqual(['70%'])
    for (const row of [phishing, trust]) {
      const confirm = [...(row?.querySelectorAll('button') ?? [])].find((node) => node.textContent === '确认')
      expect(confirm?.classList.contains('primary')).toBe(false)
      confirm?.click()
    }
    await settle()
    // Asked twice, refused twice: nothing was sent.
    expect(asked.length).toBe(2)
    expect(server.calls.some((call) => call.path.includes(':resolve'))).toBe(false)
    // The phishing mail's picker starts at 都不是, the other at the model's next choice.
    const selected = (row: HTMLElement | undefined) => {
      if (row === undefined) throw new Error('no row')
      buttonNamed(row, '改为…').click()
      return row.querySelector('.picker [aria-selected="true"]')?.textContent
    }
    expect(selected(phishing)).toBe('都不是')
    expect(selected(trust)).toBe('收据')
  })

  it('says why a mail is unsure in plain words, never 阈值', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('u', { reason: 'views_disagree' }), reviewItem('v')]
    const root = await open(server, '/')
    expect(rows(root)[0]?.textContent).toContain('两次判断不一致')
    expect(rows(root)[1]?.textContent).toContain('把握不够')
    expect(root.querySelector('#view')?.textContent).not.toContain('阈值')
  })

  it('scrolls 改为…’s highlighted label into sight once the picker is on the page', async () => {
    // jsdom has no scrollIntoView: record what is scrolled to, and whether it was on the page then.
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.isConnected ? this.textContent : `${this.textContent}（不在页面上）`)
    }
    try {
      const server = new FakeServer()
      server.reviewItems = [reviewItem('a', { candidates: [create(CandidateSchema, { label: 'labels/newsletter', probability: 0.6 }), create(CandidateSchema, { label: 'labels/receipt', probability: 0.3 })] })]
      const root = await open(server, '/')
      buttonNamed(root, '改为…').click()
      expect(root.querySelector('.picker [aria-selected="true"]')?.textContent).toBe('收据')
      expect(scrolled.at(-1)).toBe('收据')
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('says so when nothing waits', async () => {
    const root = await open(new FakeServer(), '/')
    expect(root.querySelector('.empty')?.textContent).toBe('都处理完了')
    const queue = root.querySelector<HTMLElement>('.tabs a .chip')
    expect(queue?.hidden).toBe(true)
    expect(queue?.parentElement?.hasAttribute('aria-label')).toBe(false)
  })
})

describe('设置', () => {
  it('has only the mode, the undo and Gmail', async () => {
    const root = await open(new FakeServer(), '/settings')
    expect([...root.querySelectorAll('h2')].map((node) => node.textContent)).toEqual(['模式', '撤销', 'Gmail'])
    expect(root.querySelectorAll('input[type="number"]').length).toBe(0)
    expect(root.querySelector('[aria-label="模式"] [aria-pressed="true"]')?.textContent).toBe('影子')
    expect(root.textContent).toContain('只判断和记录，不改 Gmail')
    expect(root.textContent).not.toContain('导出过滤器')
  })

  it('changes the mode with only mode and the etag in the mask, after asking for 正式', async () => {
    const server = new FakeServer()
    const asked: string[] = []
    const root = await open(server, '/settings', { now: () => NOW, confirm: (message) => (asked.push(message), true) })
    buttonNamed(root, '正式').click()
    await settle()
    expect(asked).toEqual(['切到正式？开了“正式打”的标签会在 Gmail 里打标签并归档。'])
    const patch = server.calls.find((call) => call.method === 'PATCH')
    expect(decodeURIComponent(patch?.path ?? '')).toContain('update_mask=mode,etag')
    expect(patch?.body).toMatchObject({ mode: 'live', etag: 's1' })
    expect(toastText(root)).toBe('已切到正式')
    expect(root.querySelector('[aria-label="模式"] [aria-pressed="true"]')?.textContent).toBe('正式')
    expect(root.querySelector('.status-line .chip')?.textContent).toBe('正式')
    // Choosing the mode in force sends nothing.
    buttonNamed(root, '正式').click()
    await settle()
    expect(server.calls.filter((call) => call.method === 'PATCH').length).toBe(1)
  })

  it('explains the deployment’s ceiling in one line', async () => {
    const server = new FakeServer()
    Object.assign(server.settings, { mode: Mode.LIVE, effectiveMode: Mode.SHADOW })
    const root = await open(server, '/settings')
    expect(root.textContent).toContain('受部署上限限制，按影子运行')
  })

  it('names a tripped breaker in the owner’s words, and 解除熔断 clears it', async () => {
    const server = new FakeServer()
    Object.assign(server.settings, { mode: Mode.LIVE, effectiveMode: Mode.SHADOW, breakerTripped: true, breakerReason: 'label_share' })
    const root = await open(server, '/settings')
    expect(root.textContent).toContain('已熔断（某个标签占比突增），暂按影子运行')
    expect(root.textContent).not.toContain('label_share')
    buttonNamed(root, '解除熔断').click()
    await settle()
    const reset = server.calls.find((call) => call.method === 'PATCH')
    expect(decodeURIComponent(reset?.path ?? '')).toContain('update_mask=mode,etag')
    expect(server.settings).toMatchObject({ breakerTripped: false, effectiveMode: Mode.LIVE })
    expect(root.querySelector('#view')?.textContent).not.toContain('熔断')
  })

  it('previews a range undo, then undoes it in rounds of 20 until none is left', async () => {
    const server = new FakeServer()
    const old = timestampFromMs(NOW - 3 * 86_400_000)
    server.ledgerEntries = [
      ...Array.from({ length: 45 }, (_, i) => ledgerEntry(`e${String(i).padStart(2, '0')}`)),
      ledgerEntry('gone', { undoable: false }),
      ...Array.from({ length: 10 }, (_, i) => ledgerEntry(`old${String(i)}`, { createTime: old })),
    ]
    const root = await open(server, '/settings')
    // 24 小时 is the default range.
    expect(root.querySelector('[aria-label="时间"] [aria-pressed="true"]')?.textContent).toBe('24 小时')
    buttonNamed(root, '预览').click()
    await settle(10)
    expect(root.textContent).toContain('将撤销 45 条')
    expect(server.calls.some((call) => call.path === '/api/v2/ledgerEntries:undo')).toBe(false)
    buttonNamed(root, '确认撤销').click()
    await settle(20)
    const undos = server.calls.filter((call) => call.path === '/api/v2/ledgerEntries:undo')
    expect(undos.length).toBe(3)
    expect(new Set(undos.map((call) => String(call.body?.['request_id']))).size).toBe(3)
    expect(server.ledgerEntries.filter((item) => item.undoable).map((item) => item.name)).toEqual(Array.from({ length: 10 }, (_, i) => `ledgerEntries/old${String(i)}`))
    expect(toastText(root)).toBe('已撤销 45 条')
    expect(root.textContent).not.toContain('确认撤销')
  })

  it('undoes one label’s entries only when a label is chosen, and says so in the preview', async () => {
    const server = new FakeServer()
    server.labels = [label('travel', '出行'), label('newsletter', '订阅')]
    server.ledgerEntries = [ledgerEntry('t1', { label: 'labels/travel' }), ledgerEntry('n1'), ledgerEntry('t2', { label: 'labels/travel' })]
    const root = await open(server, '/settings')
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="标签"]')
    if (select === null) throw new Error('no select')
    expect(select.options[0]?.textContent).toBe('全部标签')
    select.value = 'labels/travel'
    select.dispatchEvent(new Event('change'))
    buttonNamed(root, '预览').click()
    await settle(10)
    expect(root.textContent).toContain('将撤销“出行”的 2 条')
    buttonNamed(root, '确认撤销').click()
    await settle(10)
    expect(server.calls.find((call) => call.path === '/api/v2/ledgerEntries:undo')?.body?.['label']).toBe('labels/travel')
    expect(server.ledgerEntries.map((item) => [item.name, item.undoable])).toEqual([
      ['ledgerEntries/t1', false],
      ['ledgerEntries/n1', true],
      ['ledgerEntries/t2', false],
    ])
    expect(toastText(root)).toBe('已撤销 2 条')
  })

  it('says when there is nothing to undo, and checks a range of one’s own', async () => {
    const server = new FakeServer()
    server.ledgerEntries = [ledgerEntry('old', { createTime: timestampFromMs(NOW - 2 * 86_400_000) })]
    const root = await open(server, '/settings')
    buttonNamed(root, '1 小时').click()
    buttonNamed(root, '预览').click()
    await settle(10)
    expect(root.textContent).toContain('这段时间没有可撤销的写入')
    expect([...root.querySelectorAll('button')].some((node) => node.textContent === '确认撤销')).toBe(false)

    buttonNamed(root, '自定义').click()
    const [start, end] = [...root.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')]
    if (start === undefined || end === undefined) throw new Error('no range inputs')
    expect(start.closest('[hidden]')).toBeNull()
    buttonNamed(root, '预览').click()
    expect(toastText(root)).toBe('请选择开始和结束时间')
    start.value = '2026-08-01T00:00'
    end.value = '2026-09-15T00:00'
    buttonNamed(root, '预览').click()
    expect(toastText(root)).toBe('最多 31 天')
    start.value = '2026-09-29T00:00'
    end.value = '2026-09-30T00:00'
    buttonNamed(root, '预览').click()
    await settle(10)
    expect(root.textContent).toContain('将撤销 1 条')
  })

  it('says what a sync from Gmail did', async () => {
    const server = new FakeServer()
    const root = await open(server, '/settings')
    buttonNamed(root, '同步').click()
    await settle()
    expect(toastText(root)).toBe('已同步：关联 1，改名 0，Gmail 中缺失 0')
    expect(server.labels[0]?.gmailState).toBe(Label_GmailState.ADOPTED)
  })
})
