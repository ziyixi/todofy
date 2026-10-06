/**
 * The owner's flows in the UI against the fake API (test/fakeServer.ts, the shared transcoder): the review queue's
 * confirm, correct and skip with the CSRF header and a request ID; labels; rules; the status; settings saved with an
 * explicit mask and the etag; and the tabs.
 */
import { mountApp, type Host } from './app.ts'
import { example, FakeServer, label, ledgerEntry, NOW, reviewItem, settle } from './test/fakeServer.ts'
import { ReviewItem_Kind } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import { Mode } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
import { Rule_Kind, Rule_State, RuleSchema } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
import { create } from '@ziyixi/proto/protobuf'

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

function buttonNamed(root: HTMLElement, text: string, index = 0): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].filter((node) => node.textContent === text)
  const button = found[index]
  if (button === undefined) throw new Error(`no button ${text}`)
  return button
}

describe('待审', () => {
  it('confirms, corrects and skips with CSRF and a request ID each', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a'), reviewItem('b', { kind: ReviewItem_Kind.UNSURE, suggestedLabel: '', unsureReason: 'none' }), reviewItem('c')]
    const root = await open(server, '/')
    expect(root.querySelectorAll('.review-item').length).toBe(3)
    expect(root.textContent).toContain('主题 a')
    expect(root.textContent).toContain('建议：订阅')
    expect(root.textContent).toContain('都不像')

    buttonNamed(root, '确认').click()
    await settle()
    const confirm = server.calls.find((call) => call.path.startsWith('/api/v1/reviewItems/a:confirm'))
    expect(confirm?.method).toBe('POST')
    expect(confirm?.headers['x-csrf-token']).toBe('csrf-token')
    expect(String(confirm?.body?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(root.querySelectorAll('.review-item').length).toBe(2)

    const select = root.querySelector<HTMLSelectElement>('.review-item select')
    if (select === null) throw new Error('no select')
    select.value = 'labels/receipt'
    buttonNamed(root, '改为所选').click()
    await settle()
    expect(server.calls.find((call) => call.path.includes(':correct'))?.body?.['label']).toBe('labels/receipt')

    buttonNamed(root, '跳过').click()
    await settle()
    expect(root.textContent).toContain('没有待审的邮件')
  })

  it('slows the owner down on a suspected phishing mail and on a trust label the model may not set', async () => {
    const server = new FakeServer()
    server.labels.push(Object.assign(label('bank', '银行'), { trustImplying: true }))
    server.reviewItems = [
      reviewItem('p', { kind: ReviewItem_Kind.UNSURE, suggestedLabel: 'labels/bank', unsureReason: 'suspicious' }),
      reviewItem('t', { kind: ReviewItem_Kind.UNSURE, suggestedLabel: 'labels/bank', unsureReason: 'trust_needs_rule' }),
    ]
    const asked: string[] = []
    const root = await open(server, '/', { now: () => NOW, confirm: (message) => (asked.push(message), false) })
    const [phishing, trust] = [...root.querySelectorAll<HTMLElement>('.review-item')]
    expect(phishing?.textContent).toContain('疑似钓鱼：请先在 Gmail 里核对发件人')
    expect(trust?.textContent).toContain('可信类标签只允许规则')
    for (const card of [phishing, trust]) {
      const confirm = [...(card?.querySelectorAll('button') ?? [])].find((node) => node.textContent === '确认')
      expect(confirm?.classList.contains('primary')).toBe(false)
      confirm?.click()
    }
    await settle()
    // Asked twice, refused twice: nothing was sent.
    expect(asked.length).toBe(2)
    expect(server.calls.some((call) => call.path.includes(':confirm'))).toBe(false)
    // The phishing card's select starts at 都不是.
    expect(phishing?.querySelector('select')?.value).toBe('')
    expect(trust?.querySelector('select')?.value).toBe('labels/bank')
  })
})

describe('标签', () => {
  it('creates a label and saves an edit with every field and the etag in the mask', async () => {
    const server = new FakeServer()
    const root = await open(server, '/labels')
    expect(root.textContent).toContain('分拣/订阅')
    const name = root.querySelector<HTMLInputElement>('input[aria-label="新标签名称"]')
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

  it('says what a sync from Gmail did, and that imported labels need a description', async () => {
    const server = new FakeServer()
    const root = await open(server, '/labels')
    buttonNamed(root, '从 Gmail 同步').click()
    await settle()
    expect(toastText(root)).toBe('已同步：关联 1，导入 1（未启用，请补说明），Gmail 中缺失 0')
    expect(root.textContent).toContain('还没有说明：模型只能凭名称判断')
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

  it('shows how many rules the filter export left out', async () => {
    const server = new FakeServer()
    server.rules = [create(RuleSchema, { name: 'rules/r1', kind: Rule_Kind.LIST_ID, value: 'digest.news.example.com', label: 'labels/newsletter', state: Rule_State.ACTIVE })]
    server.exportSkipped = 2
    const root = await open(server, '/rules')
    buttonNamed(root, '导出为 Gmail 过滤器').click()
    await settle()
    expect(root.textContent).toContain('已导出 1 条；2 条未导出（可信类规则需 DMARC，过滤器无法检查）')
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Gmail 过滤器文件"]')?.hidden).toBe(false)
  })
})

describe('状态与设置', () => {
  it('shows the grant, the queue and the neurons', async () => {
    const root = await open(new FakeServer(), '/status')
    expect(root.textContent).toContain('正常（只读）')
    expect(root.textContent).toContain('523 / 7000 neurons')
    expect(root.textContent).toContain('gmail_429')
    expect(root.textContent).toContain('2 分钟前')
  })

  it('saves only the changed fields with the etag: a mode change names mode', async () => {
    const server = new FakeServer()
    const root = await open(server, '/settings')
    const mode = root.querySelector<HTMLSelectElement>('select[aria-label="模式"]')
    if (mode === null) throw new Error('no select')
    mode.value = '3'
    buttonNamed(root, '保存').click()
    await settle()
    const patch = server.calls.find((call) => call.method === 'PATCH')
    expect(decodeURIComponent(patch?.path ?? '')).toContain('update_mask=mode,etag')
    expect(patch?.body).toMatchObject({ mode: 'live', etag: 's1' })
    expect(root.textContent).toContain('当前生效：正式打标签')
  })

  it('a budget-only save leaves a tripped breaker alone; 解除熔断 clears it', async () => {
    const server = new FakeServer()
    Object.assign(server.settings, { mode: Mode.LIVE, effectiveMode: Mode.SHADOW, breakerTripped: true, breakerReason: 'label_share' })
    const root = await open(server, '/settings')
    expect(root.textContent).toContain('熔断：某个标签占比突增')
    expect(root.textContent).not.toContain('label_share')
    const budget = [...root.querySelectorAll<HTMLInputElement>('input[type="number"]')].find((input) => input.value === '7000')
    if (budget === undefined) throw new Error('no budget input')
    budget.value = '5000'
    buttonNamed(root, '保存').click()
    await settle()
    const save = server.calls.find((call) => call.method === 'PATCH')
    expect(decodeURIComponent(save?.path ?? '')).toContain('update_mask=daily_neuron_budget,etag')
    expect(decodeURIComponent(save?.path ?? '')).not.toContain('mode')
    expect(server.settings).toMatchObject({ breakerTripped: true, dailyNeuronBudget: 5000 })
    expect(root.textContent).toContain('熔断')

    buttonNamed(root, '解除熔断').click()
    await settle()
    const reset = server.calls.filter((call) => call.method === 'PATCH')[1]
    expect(decodeURIComponent(reset?.path ?? '')).toContain('update_mask=mode,etag')
    expect(server.settings).toMatchObject({ breakerTripped: false, effectiveMode: Mode.LIVE })
  })

  it('a save with no change sends nothing', async () => {
    const server = new FakeServer()
    const root = await open(server, '/settings')
    buttonNamed(root, '保存').click()
    await settle()
    expect(server.calls.some((call) => call.method === 'PATCH')).toBe(false)
    expect(toastText(root)).toBe('没有改动')
  })
})

describe('操作记录', () => {
  it('undoes a time range in rounds of 20 until none is left, and says how many', async () => {
    const server = new FakeServer()
    server.ledgerEntries = Array.from({ length: 45 }, (_, i) => ledgerEntry(`e${String(i).padStart(2, '0')}`))
    const root = await open(server, '/ledger')
    const [start, end] = [...root.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')]
    if (start === undefined || end === undefined) throw new Error('no range inputs')
    start.value = '2026-10-01T00:00'
    end.value = '2026-10-02T00:00'
    buttonNamed(root, '撤销这段时间').click()
    await settle(20)
    expect(server.calls.filter((call) => call.path === '/api/v1/ledgerEntries:undo').length).toBe(3)
    expect(new Set(server.calls.filter((call) => call.path === '/api/v1/ledgerEntries:undo').map((call) => String(call.body?.['request_id']))).size).toBe(3)
    expect(server.ledgerEntries.every((item) => !item.undoable)).toBe(true)
    expect(toastText(root)).toBe('已撤销 45 条')
  })

  it('offers 撤销 only where the server accepts it, names the mail, and loads older pages', async () => {
    const server = new FakeServer()
    server.ledgerEntries = [ledgerEntry('a1', { undoable: false, subject: '已在 Gmail 改过的邮件' }), ...Array.from({ length: 59 }, (_, i) => ledgerEntry(`b${String(i).padStart(2, '0')}`))]
    const root = await open(server, '/ledger')
    const cards = () => [...root.querySelectorAll<HTMLElement>('article.card')]
    expect(cards().length).toBe(50)
    expect(cards()[0]?.textContent).toContain('已在 Gmail 改过的邮件')
    expect(cards()[0]?.textContent).not.toContain('撤销')
    expect(cards()[1]?.textContent).toContain('撤销')
    expect(cards()[1]?.textContent).toContain('Sender <example.com>')
    buttonNamed(root, '加载更多').click()
    await settle()
    expect(cards().length).toBe(60)
    expect([...root.querySelectorAll('button')].some((node) => node.textContent === '加载更多')).toBe(false)
  })
})

describe('例子', () => {
  it('loads older examples page by page', async () => {
    const server = new FakeServer()
    server.examples = Array.from({ length: 70 }, (_, i) => example(`x${String(i)}`))
    const root = await open(server, '/examples')
    expect(root.querySelectorAll('article.card').length).toBe(50)
    buttonNamed(root, '加载更多').click()
    await settle()
    expect(root.querySelectorAll('article.card').length).toBe(70)
  })
})

describe('the shell', () => {
  it('has every view as a tab and answers an unknown path', async () => {
    const root = await open(new FakeServer(), '/nowhere')
    expect([...root.querySelectorAll('.tabs a')].map((a) => a.textContent)).toEqual(['待审', '标签', '规则', '例子', '准确率', '记录', '状态', '设置'])
    expect(root.textContent).toContain('找不到这个页面')
  })

  it('renders the accuracy, examples and ledger views', async () => {
    for (const [path, text] of [
      ['/accuracy', '92%'],
      ['/examples', '还没有例子'],
      ['/ledger', '还没有写入 Gmail 的记录'],
    ] as const) {
      const root = await open(new FakeServer(), path)
      expect(root.textContent).toContain(text)
      document.body.replaceChildren()
    }
  })
})
