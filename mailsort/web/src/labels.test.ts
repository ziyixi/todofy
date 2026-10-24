/** Fixed priority rows and the one-time setup, against the shared API transcoder. */
import { Label_GmailState } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { create } from '@ziyixi/proto/protobuf'
import { LabelCountSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { mountApp, type Host } from './app.ts'
import { example, FakeServer, label, NOW, settle } from './test/fakeServer.ts'

const asked = vi.fn(() => true)
const host: Host = { now: () => NOW, confirm: asked }

async function open(server: FakeServer): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', '/labels')
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, host)
  await settle()
  return root
}

function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent === text)
  if (found === undefined) throw new Error(`no button ${text}`)
  return found
}

function row(root: ParentNode, name: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>('.priority-row')].find((node) => node.querySelector('.leaf-name')?.textContent === name)
  if (found === undefined) throw new Error(`no row ${name}`)
  return found
}

function expand(root: ParentNode, name: string): HTMLElement {
  const found = row(root, name)
  found.querySelector<HTMLButtonElement>('.leaf-main')?.click()
  return found
}

describe('fixed priorities', () => {
  it('renders exactly four rows in urgency order with fixed inbox policy and no policy controls', async () => {
    const server = new FakeServer()
    server.labels.reverse()
    server.report = [create(LabelCountSchema, { label: 'labels/p1', autoCount: 12 })]
    const root = await open(server)
    expect(root.querySelector('h1')?.textContent).toBe('分级')
    expect([...root.querySelectorAll('.leaf-name')].map((node) => node.textContent)).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(row(root, 'P1').textContent).toContain('及时查看 · 留在收件箱')
    expect(row(root, 'P1').textContent).toContain('7 天 12 封')
    expect(row(root, 'P2').textContent).toContain('2–3 天内处理 · 自动归档')
    expect(row(root, 'P3').textContent).toContain('周末阅读 · 自动归档')
    expect(row(root, 'P4').textContent).toContain('低价值或仅供参考 · 自动归档')
    for (const name of ['P1', 'P2', 'P3', 'P4']) expand(root, name)
    expect(root.querySelectorAll('input, textarea, select')).toHaveLength(0)
    expect(root.textContent).not.toMatch(/新标签|改名|可信|钓鱼|敏感|高级|删除标签/)
    expect(root.textContent).toContain('分类保持原有未读状态')
    expect(root.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(true)
    expect(server.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
    expect(server.calls.map((call) => call.path)).toEqual(['/api/v2/serviceStatus', '/api/v2/labels?page_size=50', '/api/v2/labelReport'])
  })

  it('keeps four policies visible before setup, and when reports fail', async () => {
    const server = new FakeServer()
    server.labels = [label('old', 'Old topic')]
    server.reportFails = true
    const root = await open(server)
    expect(root.querySelectorAll('.priority-row')).toHaveLength(4)
    expect(root.textContent).not.toContain('Old topic')
    expect([...root.querySelectorAll('.priority-row .meta')].map((node) => node.textContent)).toEqual(Array<string>(4).fill('等待初始化'))
    expect(root.querySelector('.leaf-count')).toBeNull()
  })

  it('expands only the reading policy without loading learned examples', async () => {
    const server = new FakeServer()
    server.labels[1]!.exampleCount = 2
    server.examples = [example('e1', 'p2', '应在两天内回复的合成邮件'), example('e2', 'p2')]
    const root = await open(server)
    const p2 = expand(root, 'P2')
    expect(p2.querySelector('.detail')?.textContent).toContain('可以安全等两三天再看')
    expect(p2.querySelector('.leaf-main')?.getAttribute('aria-expanded')).toBe('true')
    expect(p2.querySelector('.example-list, h3')).toBeNull()
    expect(p2.querySelector('.detail button')).toBeNull()
    expand(root, 'P2')
    expect(p2.querySelector<HTMLElement>('.detail')?.hidden).toBe(true)
    expand(root, 'P2')
    expect(p2.querySelector<HTMLElement>('.detail')?.hidden).toBe(false)
    expect(p2.querySelectorAll('.detail p')).toHaveLength(1)
    expect(server.calls.some((call) => call.path.startsWith('/api/v2/examples'))).toBe(false)
    expect(server.examples).toHaveLength(2)
  })
})

describe('priority setup', () => {
  it('explains the exact action before starting and hides setup on completion', async () => {
    const server = new FakeServer()
    server.labels = [label('old', 'Old topic')]
    const originalSettings = { ...server.settings }
    const root = await open(server)
    expect(root.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(false)
    expect(root.textContent).toContain('已有邮件不会删除，收件箱位置和未读状态不变')
    expect(root.textContent).toContain('移除本应用的旧 Gmail 分类标签及旧学习记录')
    expect(server.calls.some((call) => call.path.endsWith(':initializePriorities'))).toBe(false)
    const start = button(root, '启用 P1–P4 分级')
    start.click()
    start.click()
    await settle()
    const calls = server.calls.filter((call) => call.path.endsWith(':initializePriorities'))
    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.body?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0]?.headers['x-csrf-token']).toBe('csrf-token')
    expect(root.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(true)
    expect(root.textContent).toContain('P1、P2、P3、P4 已启用')
    expect(server.settings).toEqual(originalSettings)
    expect(asked).not.toHaveBeenCalled()
  })

  it('continues bounded partial setup only after another click, with a fresh action ID', async () => {
    const server = new FakeServer()
    server.labels = []
    server.initializeIncompleteRounds = 1
    const root = await open(server)
    button(root, '启用 P1–P4 分级').click()
    await settle()
    expect(root.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(false)
    expect(root.textContent).toContain('本批设置已完成')
    expect(row(root, 'P4').textContent).toContain('等待初始化')
    expect(server.calls.filter((call) => call.path.endsWith(':initializePriorities'))).toHaveLength(1)
    button(root, '继续设置').click()
    await settle()
    const calls = server.calls.filter((call) => call.path.endsWith(':initializePriorities'))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body?.['request_id']).not.toBe(calls[1]?.body?.['request_id'])
    expect(root.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(true)
  })

  it('keeps setup available after reload when four linked labels still await final completion', async () => {
    const server = new FakeServer()
    server.initializationCompleted = false
    const root = await open(server)
    expect(server.labels.every((label) => label.gmailState === Label_GmailState.LINKED)).toBe(true)
    expect(root.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(false)
    expect(server.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(1)
    const reloaded = await open(server)
    expect(reloaded.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(false)
    button(reloaded, '启用 P1–P4 分级').click()
    await settle()
    expect(server.initializationCompleted).toBe(true)
    expect(reloaded.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(true)
    const completed = await open(server)
    expect(completed.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(true)
  })

  it('offers setup if an existing P1 policy is wrong or a Gmail label is missing', async () => {
    const server = new FakeServer()
    server.labels[0]!.keepInInbox = false
    server.labels[3]!.gmailState = Label_GmailState.MISSING
    const root = await open(server)
    expect(root.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(false)
    expect(row(root, 'P1').textContent).toContain('留在收件箱')
    expect(row(root, 'P4').textContent).toContain('Gmail 标签待恢复')
  })

  it('retries a lost setup response with the same request ID', async () => {
    const server = new FakeServer()
    server.labels = []
    const root = await open(server)
    const fetcher = globalThis.fetch
    let lost = false
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const response = await fetcher(url, init)
      if (!lost && url.endsWith(':initializePriorities')) { lost = true; throw new TypeError('lost response') }
      return response
    })
    button(root, '启用 P1–P4 分级').click()
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(true), { timeout: 1500 })
    const calls = server.calls.filter((call) => call.path.endsWith(':initializePriorities'))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body?.['request_id']).toBe(calls[1]?.body?.['request_id'])
  })

  it('keeps a failed batch visible and preserves a continuation action', async () => {
    const server = new FakeServer()
    server.labels = []
    server.initializeFails = true
    const root = await open(server)
    button(root, '启用 P1–P4 分级').click()
    await vi.waitFor(() => expect(button(root, '继续设置').disabled).toBe(false), { timeout: 1500 })
    expect(root.querySelector('[role="status"].warn')?.textContent).toContain('UNAVAILABLE')
    server.initializeFails = false
    button(root, '继续设置').click()
    await settle()
    expect(root.querySelector<HTMLElement>('.priority-setup')?.hidden).toBe(true)
  })
})
