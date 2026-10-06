/**
 * The owner's flows in the UI against the fake API (test/fakeServer.ts, the shared transcoder): the review queue's
 * confirm, correct and skip with the CSRF header and a request ID; labels; rules; the status; settings saved with an
 * explicit mask and the etag; and the tabs.
 */
import { mountApp, type Host } from './app.ts'
import { FakeServer, NOW, reviewItem, settle } from './test/fakeServer.ts'
import { ReviewItem_Kind } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import { Rule_Kind, Rule_State, RuleSchema } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
import { create } from '@ziyixi/proto/protobuf'

const host: Host = { now: () => NOW, confirm: () => true }

async function open(server: FakeServer, path: string): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', path)
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, host)
  await settle()
  return root
}

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
})

describe('状态与设置', () => {
  it('shows the grant, the queue and the neurons', async () => {
    const root = await open(new FakeServer(), '/status')
    expect(root.textContent).toContain('正常（只读）')
    expect(root.textContent).toContain('523 / 7000 neurons')
    expect(root.textContent).toContain('gmail_429')
    expect(root.textContent).toContain('2 分钟前')
  })

  it('saves the settings with an explicit mask and the etag', async () => {
    const server = new FakeServer()
    const root = await open(server, '/settings')
    const mode = root.querySelector<HTMLSelectElement>('select[aria-label="模式"]')
    if (mode === null) throw new Error('no select')
    mode.value = '3'
    buttonNamed(root, '保存').click()
    await settle()
    const patch = server.calls.find((call) => call.method === 'PATCH')
    expect(decodeURIComponent(patch?.path ?? '')).toContain('update_mask=mode,run_write_limit,daily_write_limit,daily_neuron_budget,default_threshold,precision_target,etag')
    expect(patch?.body).toMatchObject({ mode: 'live', etag: 's1' })
    expect(root.textContent).toContain('当前生效：正式打标签')
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
