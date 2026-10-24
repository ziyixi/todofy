/** The unread action and progress, exercised through the generated owner API. */
import { create } from '@ziyixi/proto/protobuf'
import { Mode, UnreadClassification_State, UnreadClassificationSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { mountApp, type Host } from './app.ts'
import { FakeServer, NOW, settle } from './test/fakeServer.ts'

const host: Host = { now: () => NOW, confirm: () => true }

function liveServer(): FakeServer {
  const server = new FakeServer()
  server.settings = { ...server.settings, mode: Mode.LIVE, effectiveMode: Mode.LIVE }
  server.status = { writeScope: true }
  return server
}

async function open(server: FakeServer): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', '/labels')
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, host)
  await settle()
  const card = root.querySelector<HTMLElement>('.unread-classification')
  if (card === null) throw new Error('no unread card')
  return card
}

function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent === text)
  if (found === undefined) throw new Error(`no button ${text}`)
  return found
}

function batch(state: UnreadClassification_State = UnreadClassification_State.RUNNING) {
  return create(UnreadClassificationSchema, { name: 'unreadClassification', state, totalCount: 100, pendingCount: 60, appliedCount: 30, skippedCount: 8, failedCount: 2, deferredCount: 5 })
}

describe('current unread classification', () => {
  it('requires completed priority setup and explains the scope before any mutation', async () => {
    const server = liveServer()
    server.initializationCompleted = false
    const card = await open(server)
    expect(card.hidden).toBe(true)
    server.initializationCompleted = true
    const ready = await open(server)
    expect(ready.hidden).toBe(false)
    expect(ready.textContent).toContain('包括已归档邮件，排除垃圾邮件和回收站')
    expect(ready.textContent).toContain('P1 留在收件箱，P2–P4 归档')
    expect(ready.textContent).toContain('保留邮件、未读状态、星标和其他标签')
    expect(ready.textContent).toContain('使用现有模型预算')
    expect(server.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
  })

  it('starts once despite a second click and keeps the current mode and budgets', async () => {
    const server = liveServer()
    const settings = { ...server.settings }
    const card = await open(server)
    const start = button(card, '开始整理')
    start.click()
    start.click()
    await settle()
    const calls = server.calls.filter((call) => call.path.endsWith('/unreadClassification:start'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(String(calls[0]?.body?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0]?.headers['x-csrf-token']).toBe('csrf-token')
    expect(start.disabled).toBe(true)
    expect(button(card, '刷新进度').disabled).toBe(false)
    expect(card.textContent).toContain('总数尚未确定')
    expect(server.settings).toEqual(settings)
  })

  it('keeps scanning totals provisional and only updates batch progress on manual refresh', async () => {
    const server = liveServer()
    server.unreadClassification = batch(UnreadClassification_State.SCANNING)
    const card = await open(server)
    expect(card.textContent).toContain('已找到 100 封；总数尚未确定')
    expect(button(card, '开始整理').disabled).toBe(true)
    server.unreadClassification = batch()
    await settle()
    expect(card.textContent).toContain('总数尚未确定')
    expect(server.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(1)
    button(card, '刷新进度').click()
    await settle()
    expect(card.textContent).toContain('后台分批整理中')
    expect(card.textContent).toContain('总数 100 · 待处理 60 · 已应用 30 · 已跳过 8 · 失败 2 · 暂缓 5')
    expect(card.textContent).not.toContain('总数尚未确定')
    expect(server.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(2)
    expect(server.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
  })

  it.each([Mode.OFF, Mode.SHADOW])('keeps an active batch waiting in mode %s, including a breaker hold', async (mode) => {
    const server = liveServer()
    server.status = { effectiveMode: mode, writeScope: true }
    server.unreadClassification = batch()
    const card = await open(server)
    expect(card.textContent).toContain('等待切到正式模式后继续整理')
    expect(card.textContent).not.toContain('本轮整理已结束')
    expect(button(card, '开始整理').disabled).toBe(true)
    expect(button(card, '刷新进度').disabled).toBe(false)
  })

  it.each([
    [{ aiQuotaExhausted: true }, '今日模型配额已用完'],
    [{ neuronsToday: 7000, dailyNeuronBudget: 7000 }, '今日模型预算已用完'],
  ])('shows daily quota or budget deferral as waiting: %s', async (status, message) => {
    const server = liveServer()
    server.status = { ...server.status, ...status }
    server.unreadClassification = batch()
    const card = await open(server)
    expect(card.textContent).toContain(message)
    expect(card.textContent).toContain('等待下一个 UTC 日继续')
    expect(card.textContent).not.toContain('本轮整理已结束')
    expect(button(card, '开始整理').disabled).toBe(true)
  })

  it('reports completion with distinct applied, skipped and failed results and allows a new batch', async () => {
    const server = liveServer()
    server.unreadClassification = create(UnreadClassificationSchema, { ...batch(UnreadClassification_State.COMPLETED), totalCount: 40, pendingCount: 0, deferredCount: 0 })
    const card = await open(server)
    expect(card.textContent).toContain('本轮整理已结束')
    expect(card.textContent).toContain('总数 40 · 待处理 0 · 已应用 30 · 已跳过 8 · 失败 2 · 暂缓 0')
    expect(card.textContent).not.toContain('已应用 40')
    expect(button(card, '开始整理').disabled).toBe(false)
    button(card, '开始整理').click()
    await settle()
    expect(card.textContent).toContain('总数尚未确定')
    expect(button(card, '开始整理').disabled).toBe(true)
  })

  it('retries a lost response with the same action identity', async () => {
    const server = liveServer()
    const card = await open(server)
    const fetcher = globalThis.fetch
    let lost = false
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const response = await fetcher(url, init)
      if (!lost && url.endsWith('/unreadClassification:start')) { lost = true; throw new TypeError('lost response') }
      return response
    })
    button(card, '开始整理').click()
    await vi.waitFor(() => expect(card.textContent).toContain('总数尚未确定'), { timeout: 1500 })
    const calls = server.calls.filter((call) => call.path.endsWith('/unreadClassification:start'))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body?.['request_id']).toBe(calls[1]?.body?.['request_id'])
  })

  it('shows start failures without claiming success, then allows retry', async () => {
    const server = liveServer()
    server.unreadStartFails = true
    const card = await open(server)
    button(card, '开始整理').click()
    await vi.waitFor(() => expect(card.querySelector('[role="status"].warn')?.textContent).toContain('UNAVAILABLE'), { timeout: 1500 })
    expect(card.textContent).toContain('尚未开始整理')
    expect(button(card, '开始整理').disabled).toBe(false)
    server.unreadStartFails = false
    button(card, '开始整理').click()
    await settle()
    expect(card.querySelector<HTMLElement>('[role="status"].warn')?.hidden).toBe(true)
    expect(card.textContent).toContain('总数尚未确定')
  })

  it('preserves the last progress when refresh fails and can recover through another refresh', async () => {
    const server = liveServer()
    server.unreadClassification = batch()
    const card = await open(server)
    server.statusFails = true
    button(card, '刷新进度').click()
    await settle()
    expect(card.textContent).toContain('已应用 30')
    expect(card.textContent).toContain('状态读取失败')
    expect(button(card, '开始整理').disabled).toBe(true)
    expect(button(card, '刷新进度').disabled).toBe(false)
    server.statusFails = false
    server.unreadClassification = create(UnreadClassificationSchema, { ...batch(UnreadClassification_State.COMPLETED), pendingCount: 0, deferredCount: 0 })
    button(card, '刷新进度').click()
    await settle()
    expect(card.textContent).toContain('本轮整理已结束')
    expect(button(card, '开始整理').disabled).toBe(false)
  })
})
