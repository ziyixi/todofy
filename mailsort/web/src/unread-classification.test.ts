/** Priority batch actions and progress, exercised through the generated owner API. */
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

describe('priority batch classification', () => {
  it('requires completed priority setup and explains the scope before any mutation', async () => {
    const server = liveServer()
    server.initializationCompleted = false
    const card = await open(server)
    expect(card.hidden).toBe(true)
    server.initializationCompleted = true
    const ready = await open(server)
    expect(ready.hidden).toBe(false)
    expect(ready.querySelector('h2')?.textContent).toBe('批量分级')
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
    const start = button(card, '整理当前未读')
    start.click()
    start.click()
    await settle()
    const calls = server.calls.filter((call) => call.path.endsWith('/unreadClassification:start'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(String(calls[0]?.body?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0]?.headers['x-csrf-token']).toBe('csrf-token')
    expect(calls[0]?.body?.['recheck_fallback']).toBeUndefined()
    expect(calls[0]?.body?.['recheck_initial100']).toBeUndefined()
    expect(start.disabled).toBe(true)
    expect(button(card, '重判保底 P1').disabled).toBe(true)
    expect(button(card, '重判原100封').disabled).toBe(true)
    expect(button(card, '刷新进度').disabled).toBe(false)
    expect(card.textContent).toContain('总数尚未确定')
    expect(server.settings).toEqual(settings)
  })

  it('requests only unread fallback P1 for rechecking and explains the cohort', async () => {
    const server = liveServer()
    const card = await open(server)
    expect(card.textContent).toContain('重判保底 P1 只处理当前未读邮件；已读和已手动调整的邮件不动。')
    const recheck = button(card, '重判保底 P1')
    recheck.click()
    recheck.click()
    button(card, '整理当前未读').click()
    await settle()
    const calls = server.calls.filter((call) => call.path.endsWith('/unreadClassification:start'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body?.['recheck_fallback']).toBe(true)
    expect(calls[0]?.body?.['recheck_initial100']).toBeUndefined()
    expect(String(calls[0]?.body?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0]?.headers['x-csrf-token']).toBe('csrf-token')
    expect(recheck.disabled).toBe(true)
    expect(button(card, '整理当前未读').disabled).toBe(true)
    expect(button(card, '重判原100封').disabled).toBe(true)
    expect(button(card, '刷新进度').disabled).toBe(false)
  })

  it('requests the original 100 regardless of read or archive state and locks all actions while starting', async () => {
    const server = liveServer()
    const settings = { ...server.settings }
    const card = await open(server)
    expect(card.textContent).toContain('新分级启用后最早自动分级的100封，包括已读和已归档邮件')
    expect(card.textContent).toContain('跳过已手动调整的邮件，保留已读状态')
    expect(card.textContent).toContain('重判后级别未变时只更新判断证据，计入已跳过，不写入 Gmail')
    const recheck = button(card, '重判原100封')
    recheck.click()
    expect(recheck.disabled).toBe(true)
    expect(button(card, '整理当前未读').disabled).toBe(true)
    expect(button(card, '重判保底 P1').disabled).toBe(true)
    expect(button(card, '刷新进度').disabled).toBe(true)
    recheck.click()
    button(card, '整理当前未读').click()
    button(card, '重判保底 P1').click()
    await settle()
    const calls = server.calls.filter((call) => call.path.endsWith('/unreadClassification:start'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body?.['recheck_initial100']).toBe(true)
    expect(calls[0]?.body?.['recheck_fallback']).toBeUndefined()
    expect(String(calls[0]?.body?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0]?.headers['x-csrf-token']).toBe('csrf-token')
    expect(recheck.disabled).toBe(true)
    expect(button(card, '刷新进度').disabled).toBe(false)
    expect(card.textContent).toContain('正在收集本轮邮件')
    expect(server.settings).toEqual(settings)
  })

  it('disables every start action during refresh or an active batch', async () => {
    const server = liveServer()
    server.unreadClassification = batch(UnreadClassification_State.COMPLETED)
    const card = await open(server)
    const start = button(card, '整理当前未读')
    const recheck = button(card, '重判保底 P1')
    const recheckInitial = button(card, '重判原100封')
    expect(recheckInitial.disabled).toBe(false)
    expect(start.disabled).toBe(false)
    expect(recheck.disabled).toBe(false)
    button(card, '刷新进度').click()
    expect(start.disabled).toBe(true)
    expect(recheck.disabled).toBe(true)
    expect(recheckInitial.disabled).toBe(true)
    await settle()
    expect(start.disabled).toBe(false)
    expect(recheck.disabled).toBe(false)
    expect(recheckInitial.disabled).toBe(false)
    for (const state of [UnreadClassification_State.SCANNING, UnreadClassification_State.RUNNING]) {
      server.unreadClassification = batch(state)
      button(card, '刷新进度').click()
      await settle()
      expect(start.disabled).toBe(true)
      expect(recheck.disabled).toBe(true)
      expect(recheckInitial.disabled).toBe(true)
      expect(button(card, '刷新进度').disabled).toBe(false)
    }
    expect(server.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
  })

  it('keeps scanning totals provisional and only updates batch progress on manual refresh', async () => {
    const server = liveServer()
    server.unreadClassification = batch(UnreadClassification_State.SCANNING)
    const card = await open(server)
    expect(card.textContent).toContain('已找到 100 封；总数尚未确定')
    expect(button(card, '整理当前未读').disabled).toBe(true)
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
    expect(button(card, '整理当前未读').disabled).toBe(true)
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
    expect(button(card, '整理当前未读').disabled).toBe(true)
  })

  it('reports completion with distinct applied, skipped and failed results and allows a new batch', async () => {
    const server = liveServer()
    server.unreadClassification = create(UnreadClassificationSchema, { ...batch(UnreadClassification_State.COMPLETED), totalCount: 40, pendingCount: 0, deferredCount: 0 })
    const card = await open(server)
    expect(card.textContent).toContain('本轮整理已结束')
    expect(card.textContent).toContain('总数 40 · 待处理 0 · 已应用 30 · 已跳过 8 · 失败 2 · 暂缓 0')
    expect(card.textContent).not.toContain('已应用 40')
    expect(button(card, '整理当前未读').disabled).toBe(false)
    button(card, '整理当前未读').click()
    await settle()
    expect(card.textContent).toContain('总数尚未确定')
    expect(button(card, '整理当前未读').disabled).toBe(true)
  })

  it.each([
    { label: '整理当前未读', recheckFallback: undefined, recheckInitial100: undefined },
    { label: '重判保底 P1', recheckFallback: true, recheckInitial100: undefined },
    { label: '重判原100封', recheckFallback: undefined, recheckInitial100: true },
  ])('retries $label after a lost response with the same action identity and scope', async ({ label, recheckFallback, recheckInitial100 }) => {
    const server = liveServer()
    const card = await open(server)
    const fetcher = globalThis.fetch
    let lost = false
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const response = await fetcher(url, init)
      if (!lost && url.endsWith('/unreadClassification:start')) { lost = true; throw new TypeError('lost response') }
      return response
    })
    button(card, label).click()
    await vi.waitFor(() => expect(card.textContent).toContain('总数尚未确定'), { timeout: 1500 })
    const calls = server.calls.filter((call) => call.path.endsWith('/unreadClassification:start'))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body?.['request_id']).toBe(calls[1]?.body?.['request_id'])
    for (const call of calls) {
      expect(call.body?.['recheck_fallback']).toBe(recheckFallback)
      expect(call.body?.['recheck_initial100']).toBe(recheckInitial100)
    }
  })

  it('shows start failures without claiming success, then allows retry', async () => {
    const server = liveServer()
    server.unreadStartFails = true
    const card = await open(server)
    button(card, '整理当前未读').click()
    await vi.waitFor(() => expect(card.querySelector('[role="status"].warn')?.textContent).toContain('UNAVAILABLE'), { timeout: 1500 })
    expect(card.textContent).toContain('尚未开始整理')
    expect(button(card, '整理当前未读').disabled).toBe(false)
    server.unreadStartFails = false
    button(card, '整理当前未读').click()
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
    expect(button(card, '整理当前未读').disabled).toBe(true)
    expect(button(card, '刷新进度').disabled).toBe(false)
    server.statusFails = false
    server.unreadClassification = create(UnreadClassificationSchema, { ...batch(UnreadClassification_State.COMPLETED), pendingCount: 0, deferredCount: 0 })
    button(card, '刷新进度').click()
    await settle()
    expect(card.textContent).toContain('本轮整理已结束')
    expect(button(card, '整理当前未读').disabled).toBe(false)
  })
})
