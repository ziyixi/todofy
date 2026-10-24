/** The shell, optional legacy corrections, mode settings and range undo, through the shared API. */
import { mountApp, type Host } from './app.ts'
import { relative } from './format.ts'
import { FakeServer, flowCount, label, ledgerEntry, NOW, reviewItem, settle } from './test/fakeServer.ts'
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v2/flow_pb'
import { CandidateSchema } from '@ziyixi/proto/mailsort/ui/v2/review_pb'
import { ReplayEvaluation_State, ReplayEvaluationSchema } from '@ziyixi/proto/mailsort/ui/v2/replay_pb'
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
  it('uses P1-P4 names in review, charts, reports, undo options and replay results', async () => {
    const server = new FakeServer()
    server.labels = [label('p1', 'P1'), label('p2', 'P2'), label('p3', 'P3'), label('p4', 'P4')]
    server.reviewItems = [reviewItem('a')]
    server.flow = [flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, 'labels/p2', 2)]
    server.replay = create(ReplayEvaluationSchema, { name: 'replayEvaluation', state: ReplayEvaluation_State.SUCCEEDED, totalCount: 1, evaluatedCount: 1, autoCount: 1, mismatches: [{ decidedLabel: 'labels/p2', ownerLabel: 'labels/p3', mailCount: 1 }] })
    const root = await open(server, '/review')
    expect(root.querySelector('.answers')?.textContent).toContain('P2')
    const navigate = async (path: string) => {
      root.querySelector<HTMLAnchorElement>(`.tabs a[href="${path}"]`)?.click()
      await settle()
      expect(root.textContent).not.toContain('旧主题')
    }
    await navigate('/overview')
    expect(root.querySelector('.flow-legend')?.textContent).toContain('P2')
    expect(root.querySelector('.report')?.textContent).toContain('P3')
    await navigate('/settings')
    expect([...root.querySelectorAll('select[aria-label="分级"] option')].map((node) => node.textContent)).toEqual(['全部分级', 'P1', 'P2', 'P3', 'P4'])
    expect(root.querySelector('.replay-mismatches')?.textContent).toContain('P2 → 你的回答：P3')
    await navigate('/labels')
    expect([...root.querySelectorAll('.leaf-name')].map((node) => node.textContent)).toEqual(['P1', 'P2', 'P3', 'P4'])
  })

  it('opens overview by default without reading a review queue', async () => {
    const server = new FakeServer()
    const root = await open(server, '/')
    expect(root.querySelector('h1')?.textContent).toBe('概览')
    expect(root.querySelector('.tabs a[aria-current="page"]')?.textContent).toBe('概览')
    expect(server.calls.some((call) => call.path.includes('reviewItems'))).toBe(false)
  })

  it('has exactly three tabs, the quiet status line, and answers an unknown path', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a'), reviewItem('b'), reviewItem('c')]
    const root = await open(server, '/nowhere')
    const tabs = [...root.querySelectorAll<HTMLAnchorElement>('.tabs a')]
    expect(tabs.map((a) => a.firstChild?.textContent)).toEqual(['概览', '分级', '设置'])
    expect(tabs.map((a) => a.getAttribute('href'))).toEqual(['/overview', '/labels', '/settings'])
    expect(root.querySelector('.tabs .chip')).toBeNull()
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
    const root = await open(server, '/review')
    const overview = root.querySelector<HTMLAnchorElement>('.tabs a[href="/overview"]')
    if (overview === null) throw new Error('no tab')
    overview.focus()
    overview.click()
    await settle()
    expect(overview.isConnected).toBe(true)
    expect(document.activeElement).toBe(overview)
    expect(overview.getAttribute('aria-current')).toBe('page')
    expect(root.querySelectorAll('.tabs a[aria-current]').length).toBe(1)
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
    expect(root.querySelector('.tabs a[aria-current="page"]')?.textContent).toBe('分级')
    root.querySelector<HTMLAnchorElement>('.tabs a[href="/overview"]')?.click()
    await settle()
    expect(window.location.pathname).toBe('/overview')
    expect(root.querySelector('h1')?.textContent).toBe('概览')
  })
})

describe('待审', () => {
  /** A row's answer buttons, as their accessible names (`P2，60%`), then 其他… and 跳过. */
  const buttons = (row: HTMLElement | undefined) => [...(row?.querySelectorAll('.answers > button') ?? [])].map((node) => node.getAttribute('aria-label') ?? node.textContent)

  /** The answer of `row` whose accessible name starts with `name`. */
  function answer(row: HTMLElement | undefined, name: string): HTMLButtonElement {
    const found = [...(row?.querySelectorAll<HTMLButtonElement>('.answers > button') ?? [])].find((node) => (node.getAttribute('aria-label') ?? node.textContent).split('，')[0] === name)
    if (found === undefined) throw new Error(`no answer ${name}`)
    return found
  }

  it('answers with one tap, through 其他… and with 都不是, and skips, with CSRF and a request ID each', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a'), reviewItem('b', { reason: 'model_unavailable', candidates: [] }), reviewItem('c'), reviewItem('d')]
    const root = await open(server, '/review')
    expect(rows(root).length).toBe(4)
    const [a, b] = rows(root)
    expect(a?.textContent).toContain('主题 a')
    expect(a?.textContent).toContain('Sender <example.com>')
    expect(a?.querySelector('p.hint')?.textContent).toBe('把握不够')
    // The model's options in its order (都不是 where it ranked it), the first primary, then 其他… and 跳过.
    expect(buttons(a)).toEqual(['P2，60%', '都不是，30%', 'P3，10%', '其他…', '跳过'])
    expect(answer(a, 'P2').classList.contains('primary')).toBe(true)
    expect(answer(a, 'P2').textContent).toBe('P260%')
    expect(answer(a, '都不是').classList.contains('primary')).toBe(false)
    // A mail the model gave no answer for: why, where to answer, and 都不是 without being suggested (not primary).
    expect(b?.querySelector('p.hint')?.textContent).toBe('模型暂不可用：可用 其他… 选分级')
    expect(buttons(b)).toEqual(['都不是', '其他…', '跳过'])
    expect(answer(b, '都不是').classList.contains('primary')).toBe(false)

    answer(a, 'P2').click()
    await settle()
    const confirm = server.calls.find((call) => call.path.startsWith('/api/v2/reviewItems/a:resolve'))
    expect(confirm?.method).toBe('POST')
    expect(confirm?.body?.['label']).toBe('labels/p2')
    expect(confirm?.headers['x-csrf-token']).toBe('csrf-token')
    expect(String(confirm?.body?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(toastText(root)).toBe('已确认：P2')
    expect(rows(root).length).toBe(3)

    buttonNamed(rows(root)[0] ?? root, '其他…').click()
    const search = root.querySelector<HTMLInputElement>('.picker input')
    if (search === null) throw new Error('no picker')
    expect(document.activeElement).toBe(search)
    // Every label; 都不是 has its own button.
    expect([...root.querySelectorAll('.picker [role="option"]')].map((node) => node.textContent)).toEqual(['P1', 'P2', 'P3', 'P4'])
    search.value = 'P3'
    search.dispatchEvent(new Event('input'))
    expect([...root.querySelectorAll('.picker [role="option"]')].map((node) => node.textContent)).toEqual(['P3'])
    press('Enter')
    await settle()
    expect(server.calls.find((call) => call.path.includes('/b:resolve'))?.body?.['label']).toBe('labels/p3')
    expect(toastText(root)).toBe('已选：P3')

    answer(rows(root)[0], '都不是').click()
    await settle()
    const none = server.calls.find((call) => call.path.includes('/c:resolve'))
    expect(none?.body?.['label'] ?? '').toBe('')
    expect(server.reviewItems.find((item) => item.name === 'reviewItems/c')?.resolvedLabel).toBe('')
    expect(toastText(root)).toBe('已改为：都不是')

    buttonNamed(root, '跳过').click()
    await settle()
    expect(server.calls.some((call) => call.path.includes('/d:skip'))).toBe(true)
    expect(root.querySelector('.empty strong')?.textContent).toBe('没有需要你确认的邮件')
  })

  it('moves with j and k, chooses with Enter and the digits, opens 其他… with c and skips with s', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a'), reviewItem('b'), reviewItem('c')]
    const root = await open(server, '/review')
    expect(root.querySelector('.keys')?.textContent).toBe('j k 移动 · 1–4 选择 · c 其他 · s 跳过')
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
    expect(server.calls.find((call) => call.path.startsWith('/api/v2/reviewItems/b:resolve'))?.body?.['label']).toBe('labels/p2')
    // The row after it took its place and the focus.
    expect(rows(root).map((row) => row.getAttribute('aria-label'))).toEqual(['主题 a', '主题 c'])
    expect(document.activeElement).toBe(rows(root)[1])

    // Three answers: 4 chooses nothing, 2 is the second (都不是).
    press('4')
    await settle()
    expect(server.calls.some((call) => call.path.includes('/c:resolve'))).toBe(false)
    press('2')
    await settle()
    expect(server.calls.find((call) => call.path.includes('/c:resolve'))?.body?.['label'] ?? '').toBe('')
    expect(rows(root).map((row) => row.getAttribute('aria-label'))).toEqual(['主题 a'])

    press('c')
    const search = root.querySelector<HTMLInputElement>('.picker input')
    expect(document.activeElement).toBe(search)
    // Typing in the search box is typing: j and 1 do nothing else.
    search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    search?.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    expect(document.activeElement).toBe(search)
    press('Escape')
    expect(root.querySelector('.picker')).toBeNull()
    expect(document.activeElement?.textContent).toBe('其他…')

    press('s')
    await settle()
    expect(server.calls.some((call) => call.path.includes('/a:skip'))).toBe(true)
    expect(server.calls.some((call) => call.path.includes('/a:resolve'))).toBe(false)
    expect(root.querySelector('.empty strong')?.textContent).toBe('没有需要你确认的邮件')
  })

  it('resolves a legacy entry without trust or scam warnings or confirmations', async () => {
    const server = new FakeServer()
    server.labels[0]!.trustImplying = true
    server.reviewItems = [reviewItem('a', { reason: 'suspicious', teachableDomain: 'bank.example.net', candidates: [create(CandidateSchema, { label: 'labels/p1', probability: 0.7 })] })]
    const asked: string[] = []
    const root = await open(server, '/review', { now: () => NOW, confirm: (message) => (asked.push(message), false) })
    expect(root.querySelector('#view')?.textContent).not.toMatch(/可信|钓鱼|bank.example.net/)
    expect(root.querySelector('.answers .primary')?.textContent).toBe('P170%')
    answer(rows(root)[0], 'P1').click()
    await settle()
    expect(asked).toEqual([])
    expect(server.calls.find((call) => call.path.includes('/a:resolve'))?.body?.['label']).toBe('labels/p1')
  })

  it('opens 其他… on Enter for a mail the model gave no answer for, never choosing 都不是', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('m', { reason: 'model_unavailable', candidates: [] })]
    const root = await open(server, '/review')
    press('j')
    press('Enter')
    await settle()
    expect(server.calls.some((call) => call.path.includes(':resolve'))).toBe(false)
    expect(document.activeElement).toBe(root.querySelector('.picker input'))
  })

  it('gives a button only to the options worth one: the first always, the others from 5 %', async () => {
    const server = new FakeServer()
    const candidates = [create(CandidateSchema, { label: 'labels/p2', probability: 0.92 }), create(CandidateSchema, { label: 'labels/p3', probability: 0.04 }), create(CandidateSchema, { label: '', probability: 0.04 })]
    server.reviewItems = [reviewItem('a', { candidates }), reviewItem('b', { candidates: [create(CandidateSchema, { label: '', probability: 0.5 }), create(CandidateSchema, { label: 'labels/p3', probability: 0.3 })] })]
    const root = await open(server, '/review')
    expect(buttons(rows(root)[0])).toEqual(['P2，92%', '都不是', '其他…', '跳过'])
    // 都不是 ranked first is the primary answer, as any first option.
    expect(buttons(rows(root)[1])).toEqual(['都不是，50%', 'P3，30%', '其他…', '跳过'])
    expect(answer(rows(root)[1], '都不是').classList.contains('primary')).toBe(true)
    answer(rows(root)[1], '都不是').click()
    await settle()
    expect(toastText(root)).toBe('已确认：都不是')
  })

  it('says why a mail is unsure in plain words, never 阈值', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('u', { reason: 'views_disagree' }), reviewItem('v')]
    const root = await open(server, '/review')
    expect(rows(root)[0]?.textContent).toContain('两次判断不一致')
    expect(rows(root)[1]?.textContent).toContain('把握不够')
    expect(root.querySelector('#view')?.textContent).not.toContain('阈值')
  })

  it('highlights in 其他… the first label the buttons do not offer, scrolled into sight once on the page', async () => {
    // jsdom has no scrollIntoView: record what is scrolled to, and whether it was on the page then.
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.isConnected ? this.textContent : `${this.textContent}（不在页面上）`)
    }
    try {
      const server = new FakeServer()
      server.reviewItems = [reviewItem('a', { candidates: [create(CandidateSchema, { label: 'labels/p2', probability: 0.6 }), create(CandidateSchema, { label: 'labels/p3', probability: 0.3 })] })]
      const root = await open(server, '/review')
      buttonNamed(root, '其他…').click()
      expect(root.querySelector('.picker [aria-selected="true"]')?.textContent).toBe('P1')
      expect(scrolled.at(-1)).toBe('P1')
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('says it is quiet when nothing waits', async () => {
    const root = await open(new FakeServer(), '/review')
    expect(root.querySelector('.empty strong')?.textContent).toBe('没有需要你确认的邮件')
    expect(root.querySelector('.empty span')?.textContent).toBe('拿不准的邮件已归 P1，并留在收件箱。')
    expect(root.querySelector('.tabs a .chip')).toBeNull()
  })
})

describe('设置', () => {
  it('has the mode, undo and replay evaluation', async () => {
    const root = await open(new FakeServer(), '/settings')
    expect([...root.querySelectorAll('h2')].map((node) => node.textContent)).toEqual(['模式', '撤销', '检查分类效果'])
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
    expect(asked).toEqual(['切到正式？新邮件会打上 P1、P2、P3、P4 标签。P1 留在收件箱，P2、P3、P4 自动归档，未读状态保持不变。'])
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

  it('says when 正式 cannot write yet: the grant is read-only', async () => {
    const server = new FakeServer()
    Object.assign(server.settings, { mode: Mode.LIVE, effectiveMode: Mode.LIVE })
    const root = await open(server, '/settings')
    const line = root.querySelector('.card p.hint')
    expect(line?.textContent).toBe('Gmail 只读授权，还不会写入：在本机运行 mint-token.mjs --scope modify')
    expect(line?.classList.contains('warn')).toBe(true)
    // With the write grant, what live does.
    server.status = { writeScope: true }
    const again = await open(server, '/settings')
    expect(again.querySelector('.card p.hint')?.textContent).toBe('按 P1、P2、P3、P4 分级；P1 留在收件箱，P2、P3、P4 归档，未读状态不变')
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
    server.labels = [label('p4', 'P4'), label('p2', 'P2')]
    server.ledgerEntries = [ledgerEntry('t1', { label: 'labels/p4' }), ledgerEntry('n1'), ledgerEntry('t2', { label: 'labels/p4' })]
    const root = await open(server, '/settings')
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="分级"]')
    if (select === null) throw new Error('no select')
    expect(select.options[0]?.textContent).toBe('全部分级')
    select.value = 'labels/p4'
    select.dispatchEvent(new Event('change'))
    buttonNamed(root, '预览').click()
    await settle(10)
    expect(root.textContent).toContain('将撤销“P4”的 2 条')
    buttonNamed(root, '确认撤销').click()
    await settle(10)
    expect(server.calls.find((call) => call.path === '/api/v2/ledgerEntries:undo')?.body?.['label']).toBe('labels/p4')
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

  it('keeps old label consolidation and Gmail import out of settings and out of API reads', async () => {
    const server = new FakeServer()
    const root = await open(server, '/settings')
    expect(root.textContent).not.toMatch(/整理标签|从 Gmail 同步|可信域名/)
    expect(server.calls.some((call) => /labelConsolidation|:sync/.test(call.path))).toBe(false)
  })
})
