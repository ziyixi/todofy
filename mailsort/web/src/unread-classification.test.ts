/** Priority batch actions and progress, exercised through the generated owner API. */
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { ClassificationProvider, ClassifierStatusSchema, ClaudeBudgetSchema, Mode, UnreadClassification_State, UnreadClassificationSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { mountApp, type Host, type ViewContext } from './app.ts'
import { api } from './api.ts'
import { FakeServer, NOW, settle } from './test/fakeServer.ts'
import { unreadClassificationCard } from './views/unread-classification.ts'

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
    expect(ready.textContent).toContain('已有 P1–P4 标签的邮件会跳过')
    expect(ready.textContent).toContain('点击后立即排队，在所选分类引擎的可用额度和 Gmail 写入额度内分批处理')
    expect(ready.textContent).not.toContain('每小时')
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
    expect(calls[0]?.headers['x-csrf-token']).toBe('1')
    expect(calls[0]?.body?.['recheck_fallback']).toBeUndefined()
    expect(calls[0]?.body?.['recheck_initial100']).toBeUndefined()
    expect(start.disabled).toBe(true)
    expect([...card.querySelectorAll('button')].map((node) => node.textContent)).toEqual(['整理当前未读', '刷新进度'])
    expect(button(card, '刷新进度').disabled).toBe(false)
    expect(card.textContent).toContain('总数尚未确定')
    expect(server.settings).toEqual(settings)
  })

  it('immediately consumes the refreshed status after starting, without a settings request', async () => {
    const server = liveServer()
    const card = await open(server)
    const fetcher = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const response = await fetcher(url, init)
      if (url.endsWith('/unreadClassification:start')) server.unreadClassification = batch()
      return response
    })
    button(card, '整理当前未读').click()
    await settle()
    expect(card.textContent).toContain('总数 100 · 待处理 60 · 已改标 30')
    expect(card.textContent).not.toContain('总数尚未确定')
    expect(server.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(2)
    expect(server.calls.some((call) => call.path.startsWith('/api/v2/settings'))).toBe(false)
  })

  it('disables every start action during refresh or an active batch', async () => {
    const server = liveServer()
    server.unreadClassification = batch(UnreadClassification_State.COMPLETED)
    const card = await open(server)
    const start = button(card, '整理当前未读')
    expect(start.disabled).toBe(false)
    button(card, '刷新进度').click()
    expect(start.disabled).toBe(true)
    await settle()
    expect(start.disabled).toBe(false)
    for (const state of [UnreadClassification_State.SCANNING, UnreadClassification_State.RUNNING]) {
      server.unreadClassification = batch(state)
      button(card, '刷新进度').click()
      await settle()
      expect(start.disabled).toBe(true)
      expect(button(card, '刷新进度').disabled).toBe(false)
    }
    expect(server.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
  })

  it('keeps scanning totals provisional until the next progress refresh', async () => {
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
    expect(card.textContent).toContain('总数 100 · 待处理 60 · 已改标 30 · 跳过 8 · 失败 2 · 暂缓 5')
    expect(card.textContent).not.toContain('总数尚未确定')
    expect(server.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(2)
    expect(server.calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
  })

  it.each([Mode.OFF, Mode.SHADOW])('keeps an active batch waiting in mode %s', async (mode) => {
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
    { spentUsd: 20, providerLimitReached: false, message: '本月模型预算已用完，等待下个月继续' },
    { spentUsd: 3, providerLimitReached: true, message: 'Anthropic 工作区已达到消费上限，等待额度恢复后继续' },
  ])('shows a monthly budget or provider cap wait: $message', async ({ message, ...fields }) => {
    const server = liveServer()
    server.status = { writeScope: true, gmailWriteResumeTime: timestampFromMs(NOW + 16 * 3_600_000), claudeBudget: create(ClaudeBudgetSchema, { month: '2026-10', limitUsd: 20, ...fields }) }
    server.unreadClassification = batch()
    const card = await open(server)
    expect(card.textContent).toContain(message)
    expect(card.textContent).not.toContain('本轮整理已结束')
    expect(card.textContent).not.toContain('下一个 UTC 日')
    expect(card.textContent).not.toContain('已达本应用今日 Gmail 写入上限')
    expect(button(card, '整理当前未读').disabled).toBe(true)
  })

  it('keeps an absent Claude budget distinct from zero usage and preserves progress', async () => {
    const server = liveServer()
    server.status = { writeScope: true, claudeBudget: undefined }
    server.unreadClassification = batch()
    const card = await open(server)
    expect(card.textContent).toContain('Claude 用量未提供，请刷新进度或等待服务更新')
    expect(card.textContent).toContain('已改标 30')
    expect(card.textContent).not.toContain('预算已用完')
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('uses the selected Codex schedule while an exhausted Claude budget remains historical', async () => {
    const server = liveServer()
    server.status = {
      writeScope: true,
      classifier: create(ClassifierStatusSchema, { provider: ClassificationProvider.CODEX, model: 'gpt-6.1-sol', effort: 'medium', configured: true, nextBatchTime: timestampFromMs(NOW + 1_800_000) }),
      claudeBudget: create(ClaudeBudgetSchema, { limitUsd: 20, spentUsd: 20, providerLimitReached: true, lastErrorCode: 'claude_spend_limit', nextBatchTime: timestampFromMs(NOW + 3_600_000) }),
    }
    server.unreadClassification = batch()
    const card = await open(server)
    expect(card.textContent).toContain('下批判断最早在 30 分钟后')
    expect(card.textContent).not.toContain('Anthropic 工作区已达到消费上限')
    expect(card.textContent).not.toContain('本月模型预算已用完')
    expect(card.textContent).not.toContain('Claude 用量未提供')
    expect(card.textContent).not.toContain('下批判断最早在 1 小时后')
    expect(button(card, '整理当前未读').disabled).toBe(true)
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('shows the selected Codex error and Gmail quota without needing a Claude budget', async () => {
    const server = liveServer()
    server.status = {
      writeScope: true, claudeBudget: undefined,
      classifier: create(ClassifierStatusSchema, { provider: ClassificationProvider.CODEX, configured: true, lastErrorCode: 'codex_auth' }),
      gmailWriteResumeTime: timestampFromMs(NOW + 16 * 3_600_000),
    }
    server.unreadClassification = batch()
    const card = await open(server)
    expect(card.textContent).toContain('VPS Codex 授权失败')
    expect(card.textContent).not.toContain('Claude 用量未提供')
    expect(card.textContent).not.toContain('已达本应用今日 Gmail 写入上限')
    server.status.classifier = create(ClassifierStatusSchema, { provider: ClassificationProvider.CODEX, configured: true })
    button(card, '刷新进度').click()
    await settle()
    expect(card.textContent).toContain('已达本应用今日 Gmail 写入上限')
    expect(card.textContent).not.toContain('VPS Codex 授权失败')
  })

  it('shows an actual Gmail daily-cap resume time instead of calling it a model retry', async () => {
    const server = liveServer()
    server.status = { writeScope: true, gmailWriteResumeTime: timestampFromMs(NOW + 16 * 3_600_000) }
    server.unreadClassification = batch()
    const card = await open(server)
    expect(card.textContent).toContain('已达本应用今日 Gmail 写入上限')
    expect(card.textContent).toContain('10-02 08:00（本地时间）')
    expect(card.textContent).toContain('每日额度于 UTC 00:00 重置')
    expect(card.textContent).not.toContain('重试时间')
    expect(card.textContent).not.toContain('下批判断最早在')
    expect(server.calls.some((call) => call.path.startsWith('/api/v2/settings'))).toBe(false)
  })

  it('does not show a past eligibility timestamp as a future batch wait', async () => {
    const server = liveServer()
    server.status = { writeScope: true, claudeBudget: create(ClaudeBudgetSchema, { limitUsd: 20, nextBatchTime: timestampFromMs(NOW - 60_000) }) }
    server.unreadClassification = batch()
    const card = await open(server)
    expect(card.textContent).toContain('后台分批整理中')
    expect(card.textContent).toContain('进度每 30 秒自动更新')
    expect(card.textContent).not.toContain('下批判断最早在')
  })

  it.each([
    ['claude_401', 'Claude API 授权失败'],
    ['claude_not_allowed', 'Model Router 不允许本应用使用 Claude 模型'],
  ])('keeps model configuration failure %s ahead of the daily Gmail-cap explanation', async (code, message) => {
    const server = liveServer()
    server.status = { writeScope: true, gmailWriteResumeTime: timestampFromMs(NOW + 16 * 3_600_000), claudeBudget: create(ClaudeBudgetSchema, { limitUsd: 20, lastErrorCode: code }) }
    server.unreadClassification = batch()
    const card = await open(server)
    expect(card.textContent).toContain(message)
    expect(card.textContent).not.toContain('已达本应用今日 Gmail 写入上限')
  })

  it('reports completion with distinct applied, skipped and failed results and allows a new batch', async () => {
    const server = liveServer()
    server.unreadClassification = create(UnreadClassificationSchema, { ...batch(UnreadClassification_State.COMPLETED), totalCount: 40, pendingCount: 0, deferredCount: 0 })
    const card = await open(server)
    expect(card.textContent).toContain('本轮整理已结束')
    expect(card.textContent).toContain('总数 40 · 待处理 0 · 已改标 30 · 跳过 8 · 失败 2 · 暂缓 0')
    expect(card.textContent).not.toContain('已改标 40')
    expect(button(card, '整理当前未读').disabled).toBe(false)
    button(card, '整理当前未读').click()
    await settle()
    expect(card.textContent).toContain('总数尚未确定')
    expect(button(card, '整理当前未读').disabled).toBe(true)
  })

  it('keeps an older recheck batch\'s same-grade judgments apart from skips', async () => {
    const server = liveServer()
    server.unreadClassification = create(UnreadClassificationSchema, { name: 'unreadClassification', state: UnreadClassification_State.COMPLETED, totalCount: 100, unchangedCount: 100 })
    const card = await open(server)
    expect(card.textContent).toContain('总数 100 · 待处理 0 · 已改标 0 · 重判未变 100 · 跳过 0 · 失败 0 · 暂缓 0')
    expect(card.textContent).not.toContain('跳过 100')
  })

  it('retries a start after a lost response with the same request ID', async () => {
    const server = liveServer()
    const card = await open(server)
    const fetcher = globalThis.fetch
    let lost = false
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const response = await fetcher(url, init)
      if (!lost && url.endsWith('/unreadClassification:start')) { lost = true; throw new TypeError('lost response') }
      return response
    })
    button(card, '整理当前未读').click()
    await vi.waitFor(() => expect(card.textContent).toContain('总数尚未确定'), { timeout: 1500 })
    const calls = server.calls.filter((call) => call.path.endsWith('/unreadClassification:start'))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body?.['request_id']).toBe(calls[1]?.body?.['request_id'])
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
    expect(card.textContent).toContain('已改标 30')
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

/** Local lifecycle only: the card reuses the same service-status request as the shell. */
describe('active progress refresh', () => {
  const leaving: (() => void)[] = []
  afterEach(() => {
    for (const leave of leaving.splice(0)) leave()
  })

  async function activeCard(server: FakeServer) {
    server.install()
    let status = api.getServiceStatus({ name: 'serviceStatus' })
    const ctx: ViewContext = {
      main: document.createElement('main'), host, go: () => undefined,
      status: () => status,
      refreshStatus: () => { status = api.getServiceStatus({ name: 'serviceStatus' }) },
      onLeave: (cleanup) => { leaving.push(cleanup) },
    }
    const card = unreadClassificationCard(ctx, await status)
    document.body.append(card)
    return card
  }

  it('updates an active visible batch every 30 seconds and stops on completion', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const server = liveServer()
    server.unreadClassification = batch()
    const card = await activeCard(server)
    server.unreadClassification = create(UnreadClassificationSchema, { ...batch(UnreadClassification_State.COMPLETED), pendingCount: 0, deferredCount: 0 })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(card.textContent).not.toContain('本轮整理已结束')
    expect(server.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(card.textContent).toContain('本轮整理已结束')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(server.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(2)
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('pauses while hidden, refreshes once on visible return and stops when the page is left', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const server = liveServer()
    server.unreadClassification = batch()
    await activeCard(server)
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(90_000)
    expect(server.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(1)
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(server.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(2)
    for (const leave of leaving.splice(0)) leave()
    await vi.advanceTimersByTimeAsync(90_000)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(server.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(2)
  })
})
