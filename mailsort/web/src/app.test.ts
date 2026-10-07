/**
 * The owner's flows in the UI against the fake API (test/fakeServer.ts, the shared transcoder): the shell's four tabs
 * and status line; 待审's confirm, change and skip (with the CSRF header and a request ID each), its keyboard and its
 * caution; 设置's mode, ceiling and breaker, the range undo's preview and confirmation, the sync and the filter export;
 * 标签 (its tree, 归档 and 敏感) and 规则.
 */
import { mountApp, type Host } from './app.ts'
import { FakeServer, label, ledgerEntry, NOW, reviewItem, settle } from './test/fakeServer.ts'
import { Label_GmailState } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { CandidateSchema, ReviewItem_Kind } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import { Mode, ServiceStatus_AuthState } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
import { Rule_Kind, Rule_State, RuleSchema } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
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

  it('moves between tabs without reloading, and keeps 标签 current on 规则', async () => {
    const server = new FakeServer()
    const root = await open(server, '/labels')
    buttonNamed(root, '规则').click()
    await settle()
    expect(window.location.pathname).toBe('/rules')
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
    server.reviewItems = [reviewItem('a'), reviewItem('b', { kind: ReviewItem_Kind.UNSURE, suggestedLabel: '', unsureReason: 'none', candidates: [] }), reviewItem('c')]
    const root = await open(server, '/')
    expect(rows(root).length).toBe(3)
    const [a, b] = rows(root)
    expect(a?.textContent).toContain('主题 a')
    expect(a?.querySelector('.chip.accent')?.textContent).toBe('订阅')
    expect(a?.textContent).toContain('90%')
    // An unsure mail without a suggestion: why, and no 确认.
    expect(b?.textContent).toContain('拿不准 · 都不像')
    expect(b?.querySelector('.chip')?.textContent).toBe('都不是')
    expect([...(b?.querySelectorAll('button') ?? [])].map((node) => node.textContent)).toEqual(['改为…', '跳过'])

    buttonNamed(a ?? root, '确认').click()
    await settle()
    const confirm = server.calls.find((call) => call.path.startsWith('/api/v1/reviewItems/a:confirm'))
    expect(confirm?.method).toBe('POST')
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
    expect(server.calls.find((call) => call.path.includes('/b:correct'))?.body?.['label']).toBe('labels/receipt')
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
    expect(server.calls.some((call) => call.path.startsWith('/api/v1/reviewItems/b:confirm'))).toBe(true)
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

  it('slows the owner down on a suspected phishing mail and on a trust label the model may not set', async () => {
    const server = new FakeServer()
    server.labels.push(Object.assign(label('bank', '银行'), { trustImplying: true }))
    const candidates = [create(CandidateSchema, { label: 'labels/bank', probability: 0.7 }), create(CandidateSchema, { label: 'labels/receipt', probability: 0.2 })]
    server.reviewItems = [
      reviewItem('p', { kind: ReviewItem_Kind.UNSURE, suggestedLabel: 'labels/bank', unsureReason: 'suspicious', candidates }),
      reviewItem('t', { kind: ReviewItem_Kind.UNSURE, suggestedLabel: 'labels/bank', unsureReason: 'trust_needs_rule', candidates }),
    ]
    const asked: string[] = []
    const root = await open(server, '/', { now: () => NOW, confirm: (message) => (asked.push(message), false) })
    const [phishing, trust] = rows(root)
    expect(phishing?.textContent).toContain('疑似钓鱼：先在 Gmail 里核对发件人和链接')
    expect(trust?.textContent).toContain('可信类标签只能由规则打')
    for (const row of [phishing, trust]) {
      const confirm = [...(row?.querySelectorAll('button') ?? [])].find((node) => node.textContent === '确认')
      expect(confirm?.classList.contains('primary')).toBe(false)
      confirm?.click()
    }
    await settle()
    // Asked twice, refused twice: nothing was sent.
    expect(asked.length).toBe(2)
    expect(server.calls.some((call) => call.path.includes(':confirm'))).toBe(false)
    // The phishing mail's picker starts at 都不是, the other at the model's next choice.
    const selected = (row: HTMLElement | undefined) => {
      if (row === undefined) throw new Error('no row')
      buttonNamed(row, '改为…').click()
      return row.querySelector('.picker [aria-selected="true"]')?.textContent
    }
    expect(selected(phishing)).toBe('都不是')
    expect(selected(trust)).toBe('收据')
  })

  it('says so when nothing waits', async () => {
    const root = await open(new FakeServer(), '/')
    expect(root.querySelector('.empty')?.textContent).toBe('都处理完了')
    expect(root.querySelector('.tabs a .chip')).toBeNull()
  })
})

describe('设置', () => {
  it('has only the mode, the undo and Gmail', async () => {
    const root = await open(new FakeServer(), '/settings')
    expect([...root.querySelectorAll('h2')].map((node) => node.textContent)).toEqual(['模式', '撤销', 'Gmail'])
    expect(root.querySelectorAll('input[type="number"]').length).toBe(0)
    expect(root.querySelector('[aria-label="模式"] [aria-pressed="true"]')?.textContent).toBe('影子')
    expect(root.textContent).toContain('只给建议，不改 Gmail')
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
    expect(root.textContent).toContain('部署上限是“影子”，现在按影子运行')
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
    expect(server.calls.some((call) => call.path === '/api/v1/ledgerEntries:undo')).toBe(false)
    buttonNamed(root, '确认撤销').click()
    await settle(20)
    const undos = server.calls.filter((call) => call.path === '/api/v1/ledgerEntries:undo')
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
    expect(server.calls.find((call) => call.path === '/api/v1/ledgerEntries:undo')?.body?.['label']).toBe('labels/travel')
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

  it('downloads the Gmail filter file and folds away why some rules were left out', async () => {
    const server = new FakeServer()
    server.rules = [create(RuleSchema, { name: 'rules/r1', kind: Rule_Kind.LIST_ID, value: 'digest.news.example.com', label: 'labels/newsletter', state: Rule_State.ACTIVE })]
    server.exportSkipped = 2
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:filters'), revokeObjectURL: vi.fn() })
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const root = await open(server, '/settings')
    buttonNamed(root, '导出').click()
    await settle()
    expect(toastText(root)).toBe('已导出 1 条规则')
    const link = root.querySelector<HTMLAnchorElement>('a[download]')
    expect(link?.getAttribute('download')).toBe('mailsort-filters.xml')
    expect(link?.getAttribute('href')).toBe('blob:filters')
    expect(clicked).toHaveBeenCalledTimes(1)
    const why = root.querySelector('details.more')
    expect(why?.querySelector('summary')?.textContent).toBe('2 条没有导出')
    expect(why?.textContent).toContain('过滤器查不了 DMARC')
  })
})

describe('标签', () => {
  it('creates a label and saves an edit with every field and the etag in the mask', async () => {
    const server = new FakeServer()
    const root = await open(server, '/labels')
    expect(root.textContent).toContain('订阅')
    expect(root.textContent).not.toContain('分拣/')
    // The sync moved to 设置 and the template's import is gone.
    expect([...root.querySelectorAll('button')].map((node) => node.textContent)).not.toContain('从 Gmail 同步')
    expect([...root.querySelectorAll('button')].map((node) => node.textContent)).not.toContain('套用推荐模板')
    const name = root.querySelector<HTMLInputElement>('input[aria-label="新标签路径"]')
    if (name === null) throw new Error('no input')
    name.value = '出行'
    buttonNamed(root, '创建').click()
    await settle()
    expect(server.labels.map((item) => item.displayName)).toContain('出行')

    const description = root.querySelector<HTMLTextAreaElement>('textarea')
    if (description === null) throw new Error('no textarea')
    description.value = 'newsletter weekly'
    buttonNamed(root, '保存').click()
    await settle()
    const patch = server.calls.find((call) => call.method === 'PATCH')
    expect(patch?.path).toContain('update_mask=')
    expect(decodeURIComponent(patch?.path ?? '')).toContain('etag')
    expect(patch?.body?.['description']).toBe('newsletter weekly')
    // The threshold input allows only what the API accepts.
    expect(root.querySelector<HTMLInputElement>('input[aria-label="阈值"]')?.min).toBe('0.5')
  })

  it('says what a label without a description means, and shows one that adopted the owner’s Gmail label', async () => {
    const server = new FakeServer()
    const [first, second] = server.labels
    if (first === undefined || second === undefined) throw new Error('no label')
    first.description = ''
    second.gmailState = Label_GmailState.ADOPTED
    const root = await open(server, '/labels')
    expect(root.textContent).toContain('还没有说明：模型不会选这个标签，只有规则和例子能打它')
    expect(root.textContent).toContain('已沿用 Gmail 原有标签')
  })

  it('groups nested labels under their top level and saves 归档 and 敏感 with the mask', async () => {
    const server = new FakeServer()
    server.labels = [label('finance-invest', '金融/投资'), label('finance-bank-pay', '金融/银行支付'), Object.assign(label('account-security', '账号安全'), { keepInInbox: true }), label('travel', '出行')]
    const root = await open(server, '/labels')
    const groups = [...root.querySelectorAll('.label-group')]
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['金融', '账号安全', '出行'])
    expect(groups[0]?.querySelectorAll('.label-card').length).toBe(2)
    expect(groups[0]?.querySelector('.group-name')?.textContent).toContain('2 个标签')
    const security = groups[1]?.querySelector('.label-card')
    const archive = [...(security?.querySelectorAll('label.check') ?? [])].find((node) => node.textContent.startsWith('归档'))?.querySelector('input')
    expect(archive?.classList.contains('switch')).toBe(true)
    expect(archive?.checked).toBe(false)
    if (archive) archive.checked = true
    const save = [...(security?.querySelectorAll('button') ?? [])].find((node) => node.textContent === '保存')
    save?.click()
    await settle()
    const patch = server.calls.find((call) => call.method === 'PATCH' && call.path.startsWith('/api/v1/labels/account-security'))
    expect(patch?.path).toContain('keep_in_inbox')
    expect(patch?.path).toContain('sensitive')
    expect(patch?.body?.['keep_in_inbox']).toBeUndefined()
  })

  it('nests a three-level path under its own prefix, not beside its parent’s siblings', async () => {
    const server = new FakeServer()
    server.labels = [label('life-car-service', '生活/汽车/保养'), label('life-health', '生活/医疗'), label('life-car-insurance', '生活/汽车/保险'), label('travel', '出行')]
    const root = await open(server, '/labels')
    const top = [...root.querySelectorAll('.label-group')]
    expect(top.map((group) => group.getAttribute('aria-label'))).toEqual(['生活', '出行'])
    expect(top[0]?.querySelector(':scope > .group-name')?.textContent).toContain('3 个标签')
    const car = top[0]?.querySelector('.label-subgroup')
    expect(car?.getAttribute('aria-label')).toBe('生活/汽车')
    expect(car?.querySelector('h3')?.textContent).toContain('2 个标签')
    expect([...(car?.querySelectorAll('.label-card strong') ?? [])].map((node) => node.textContent)).toEqual(['生活/汽车/保养', '生活/汽车/保险'])
    // 生活/医疗 is a card right under 生活, beside the 汽车 section.
    const direct = [...(top[0]?.querySelector(':scope > .list.nested')?.children ?? [])].map((node) => node.getAttribute('aria-label') ?? node.querySelector('strong')?.textContent)
    expect(direct).toEqual(['生活/汽车', '生活/医疗'])
  })
})

describe('规则', () => {
  it('lists proposals first and approves one', async () => {
    const server = new FakeServer()
    server.rules = [create(RuleSchema, { name: 'rules/r1', kind: Rule_Kind.LIST_ID, value: 'digest.news.example.com', label: 'labels/newsletter', state: Rule_State.PROPOSED, correctionCount: 2 })]
    const root = await open(server, '/rules')
    expect(root.textContent).toContain('待批准（1）')
    expect(root.textContent).toContain('digest.news.example.com')
    buttonNamed(root, '批准').click()
    await settle()
    expect(server.rules[0]?.state).toBe(Rule_State.ACTIVE)
  })

  it('creates a carve-out that keeps its mail in the inbox', async () => {
    const server = new FakeServer()
    const root = await open(server, '/rules')
    const value = root.querySelector<HTMLInputElement>('input[aria-label="值"]')
    const includes = root.querySelector<HTMLInputElement>('input[aria-label="主题包含"]')
    const keep = root.querySelector<HTMLInputElement>('input[aria-label="留在收件箱"]')
    if (value === null || includes === null || keep === null) throw new Error('no form')
    value.value = 'notice@parcel.example.cn'
    includes.value = '取件码，pickup code'
    keep.checked = true
    buttonNamed(root, '创建').click()
    await settle()
    const rule = server.calls.find((call) => call.method === 'POST' && call.path.startsWith('/api/v1/rules?'))?.body
    expect(rule).toMatchObject({ value: 'notice@parcel.example.cn', subject_includes: ['取件码', 'pickup code'], keep_in_inbox: true })
    expect(root.textContent).toContain('主题包含：取件码、pickup code')
    expect(root.textContent).toContain('留在收件箱')
  })
})
