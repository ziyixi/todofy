/**
 * Settings view unit tests: automatic classification interval, classification provider and model selection,
 * historical replay evaluation, and range undo preview truncation (PREVIEW_PAGES_MAX = 20 -> 将撤销至少 X 条).
 */
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { ReplayEvaluation_State, ReplayEvaluationSchema } from '@ziyixi/proto/mailsort/ui/v2/replay_pb'
import { ClassificationProvider, ClassifierStatusSchema, ClaudeBudgetSchema, Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { mountApp, type Host } from './app.ts'
import { classifierErrorMessage } from './format.ts'
import { FakeServer, ledgerEntry, NOW, settle } from './test/fakeServer.ts'
import { replayCard } from './views/replay.ts'

async function open(server: FakeServer, path = '/settings', confirm = vi.fn(() => true)): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', path)
  const root = document.createElement('div')
  document.body.append(root)
  const host: Host = { now: () => NOW, confirm }
  await mountApp(root, host)
  await settle()
  return root
}

function card(root: HTMLElement, title = '分类引擎'): HTMLElement {
  const section = [...root.querySelectorAll<HTMLElement>('section.card')].find((node) => node.querySelector('h2')?.textContent === title)
  if (section === undefined) throw new Error(`missing card: ${title}`)
  return section
}

function interval(root: HTMLElement): HTMLElement {
  return card(root, '自动分类间隔')
}

function choice(root: HTMLElement, minutes: number): HTMLButtonElement {
  const found = [...interval(root).querySelectorAll('button')].find(node => node.textContent === `${String(minutes)} 分钟`)
  if (found === undefined) throw new Error('Missing interval choice')
  return found
}

function model(root: HTMLElement): HTMLSelectElement {
  return card(root).querySelector<HTMLSelectElement>('select[aria-label="分类模型"]')!
}

function saveModel(root: HTMLElement, value: string): void {
  const select = model(root)
  select.value = value
  select.dispatchEvent(new Event('change'))
  card(root).querySelector<HTMLButtonElement>('button')!.click()
}

async function openReplay(server: FakeServer): Promise<HTMLElement> {
  server.install()
  const replay = await replayCard(server.labels)
  document.body.append(replay)
  return replay
}

describe('automatic classification interval', () => {
  it('shows the default 15-minute choice and leaves an unchanged click read-only', async () => {
    const server = new FakeServer()
    server.settings.classificationIntervalMinutes = 0 // A reply from before the field existed.
    const root = await open(server, '/settings', () => { throw new Error('Interval needs no external-action confirmation') })
    expect([...interval(root).querySelectorAll('button')].map(node => node.textContent)).toEqual(['5 分钟', '15 分钟', '30 分钟', '60 分钟'])
    expect(choice(root, 15).getAttribute('aria-pressed')).toBe('true')
    expect(interval(root).textContent).toContain('Gmail 维护检查仍每 5 分钟')
    expect(interval(root).textContent).toContain('最近 48 小时的 Inbox 未分类邮件，已读也处理')
    choice(root, 15).click()
    await settle()
    expect(server.calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it.each([ClassificationProvider.CLAUDE, ClassificationProvider.CODEX])('persists a %s interval and refreshes the next batch without changing mode/provider/prompt', async provider => {
    const server = new FakeServer()
    Object.assign(server.settings, { classificationProvider: provider, mode: Mode.LIVE, effectiveMode: Mode.SHADOW })
    const classifier = create(ClassifierStatusSchema, { provider, configured: true, classificationIntervalMinutes: 15, nextBatchTime: timestampFromMs(NOW + 15 * 60_000) })
    server.status = { classifier }
    const prompt = server.classificationPrompt
    const root = await open(server)
    expect(interval(root).textContent).toContain('下批判断最早在 15 分钟后')
    classifier.nextBatchTime = timestampFromMs(NOW + 30 * 60_000)
    choice(root, 30).click()
    expect(choice(root, 30).disabled).toBe(true)
    await settle()
    const patch = server.calls.find(call => call.method === 'PATCH')
    const url = new URL(patch?.path ?? '/', 'https://synthetic.example')
    expect(url.pathname).toBe('/api/v2/settings')
    expect(url.searchParams.get('update_mask')).toBe('classification_interval_minutes,etag')
    expect(url.searchParams.get('request_id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(patch?.body).toMatchObject({ classification_interval_minutes: 30, etag: 's1' })
    expect(server.settings).toMatchObject({ classificationIntervalMinutes: 30, classificationProvider: provider, mode: Mode.LIVE })
    expect(server.classificationPrompt).toBe(prompt)
    expect(server.calls.filter(call => call.method !== 'GET')).toHaveLength(1)
    expect(server.calls.filter(call => call.path === '/api/v2/serviceStatus')).toHaveLength(2)
    expect(choice(root, 30).getAttribute('aria-pressed')).toBe('true')
    expect(interval(root).textContent).toContain('下批判断最早在 30 分钟后')
    expect(root.querySelector('.status-line')?.textContent).toContain('下次 Gmail 维护 5 分钟后')
    const again = await open(server)
    expect(choice(again, 30).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps the saved selection when a save fails', async () => {
    const server = new FakeServer()
    server.settingsSaveFails = true
    const root = await open(server)
    choice(root, 5).click()
    await settle()
    expect(choice(root, 15).getAttribute('aria-pressed')).toBe('true')
    expect(choice(root, 5).disabled).toBe(false)
    expect(root.textContent).toContain('请求失败（BAD_REQUEST）')
    expect(server.settings.classificationIntervalMinutes).toBe(15)
  })

  it('shows the configured cadence in overview and keeps an unavailable Codex schedule separate from Claude history', async () => {
    const server = new FakeServer()
    server.settings.classificationProvider = ClassificationProvider.CODEX
    server.status = { classifier: create(ClassifierStatusSchema, { provider: ClassificationProvider.CODEX, classificationIntervalMinutes: 60 }) }
    const settings = await open(server)
    expect(interval(settings).textContent).toContain('下批判断时间尚未提供')
    expect(interval(settings).textContent).not.toContain('1 小时后')
    const root = await open(server, '/overview')
    expect(root.textContent).toContain('自动分类间隔 60 分钟，可在设置中调整')
    expect(root.querySelector('.status-line')?.textContent).toContain('下次 Gmail 维护 5 分钟后')
  })
})

describe('classification provider', () => {
  it('keeps the saved default and distinguishes Codex from the same OpenAI API model without writing', async () => {
    const server = new FakeServer()
    const root = await open(server)
    expect(model(root).value).toBe('claude-opus-5-5')
    const options = [...model(root).options]
    expect(options.find(option => option.value === 'gpt-6.1-sol')?.textContent).toContain('VPS Codex · Sol 6.1')
    expect(options.find(option => option.value === 'openai/gpt-6.1-sol')?.textContent).toContain('OpenAI API · Sol 6.1')
    expect(options.find(option => option.value === 'openai/gpt-6-astra')?.disabled).toBe(true)
    expect(card(root).textContent).toContain('切换从下一批生效；已分类邮件不重判。')
    expect(card(root).textContent).toContain('配置状态未提供')
    expect(card(root).querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
    expect(server.calls.some((call) => call.method === 'PATCH')).toBe(false)
  })

  it('saves an OpenAI route and effort with an etag and request ID, retains mode and prompts, and survives reload', async () => {
    const server = new FakeServer()
    Object.assign(server.settings, { mode: Mode.LIVE, effectiveMode: Mode.LIVE })
    const confirm = vi.fn(() => true)
    const root = await open(server, '/settings', confirm)
    const prompt = server.classificationPrompt
    const select = model(root)
    select.value = 'openai/gpt-6.1-sol'
    select.dispatchEvent(new Event('change'))
    const effort = card(root).querySelector<HTMLSelectElement>('select[aria-label="推理强度"]')!
    effort.value = 'high'
    effort.dispatchEvent(new Event('change'))
    card(root).querySelector<HTMLButtonElement>('button')!.click()
    expect(model(root).disabled).toBe(true)
    await settle()
    const patch = server.calls.find((call) => call.method === 'PATCH')
    const url = new URL(patch?.path ?? '/', 'https://synthetic.example')
    expect(url.pathname).toBe('/api/v2/settings')
    expect(url.searchParams.get('update_mask')).toBe('classification_model,classification_effort,etag')
    expect(url.searchParams.get('request_id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(patch?.body).toMatchObject({ classification_model: 'openai/gpt-6.1-sol', classification_effort: 'high', etag: 's1' })
    expect(patch?.body).not.toHaveProperty('available_models')
    expect(server.settings).toMatchObject({ classificationProvider: ClassificationProvider.OPENAI, mode: Mode.LIVE })
    expect(server.classificationPrompt).toBe(prompt)
    expect(confirm).not.toHaveBeenCalled()
    expect(model(root).value).toBe('openai/gpt-6.1-sol')
    expect(server.calls.filter((call) => call.method !== 'GET')).toHaveLength(1)
    const again = await open(server)
    expect(model(again).value).toBe('openai/gpt-6.1-sol')
    expect(card(again).querySelector<HTMLSelectElement>('select[aria-label="推理强度"]')?.value).toBe('high')
    saveModel(again, 'gpt-6.1-sol')
    await settle()
    expect(server.settings.classificationProvider).toBe(ClassificationProvider.CODEX)
    expect(server.settings.mode).toBe(Mode.LIVE)
    expect(model(again).value).toBe('gpt-6.1-sol')
  })

  it('keeps the saved provider selected and shows a save error without claiming a switch', async () => {
    const server = new FakeServer()
    server.settingsSaveFails = true
    const root = await open(server)
    saveModel(root, 'openai/gpt-6.1-sol')
    await settle()
    expect(model(root).value).toBe('openai/gpt-6.1-sol')
    expect(model(root).disabled).toBe(false)
    expect(card(root).querySelector('[role="status"]')?.textContent).toBe('请求失败（BAD_REQUEST）')
    expect(root.querySelector('#toast')?.textContent).not.toContain('已切到')
    expect(server.settings.classificationProvider).toBe(ClassificationProvider.UNSPECIFIED)
  })

  it('shows the selected Codex configuration, model, safe error and next batch', async () => {
    const server = new FakeServer()
    server.settings.classificationProvider = ClassificationProvider.CODEX
    server.status = { classifier: create(ClassifierStatusSchema, {
      provider: ClassificationProvider.CODEX, model: 'gpt-6.1-sol', effort: 'medium', configured: false,
      lastErrorCode: 'codex_not_configured', nextBatchTime: timestampFromMs(NOW + 3_600_000),
    }) }
    const root = await open(server)
    const text = card(root).textContent
    expect(text).toContain('VPS Codex · gpt-6.1-sol · medium')
    expect(text).toContain('尚未配置，下一批无法分类')
    expect(text).toContain('VPS Codex 尚未配置')
    expect(text).toContain('下批判断最早在 1 小时后')
    expect(text).toContain('使用 Codex 订阅额度')
    expect(text).not.toContain('US$')
  })

  it('keeps Claude budget exhaustion and errors in history while Codex is selected', async () => {
    const server = new FakeServer()
    server.status = {
      deferredCount: 4,
      classifier: create(ClassifierStatusSchema, { provider: ClassificationProvider.CODEX, model: 'gpt-6.1-sol', effort: 'medium', configured: true, nextBatchTime: timestampFromMs(NOW + 1_800_000), lastSuccessTime: timestampFromMs(NOW - 300_000) }),
      claudeBudget: create(ClaudeBudgetSchema, { model: 'claude-opus-5-5', effort: 'medium', month: '2026-10', limitUsd: 20, spentUsd: 20, providerLimitReached: true, lastErrorCode: 'claude_spend_limit', nextBatchTime: timestampFromMs(NOW + 3_600_000) }),
    }
    const root = await open(server, '/overview')
    const classifier = card(root)
    expect(classifier.textContent).toContain('VPS Codex · gpt-6.1-sol · medium')
    expect(classifier.textContent).toContain('已配置')
    expect(classifier.textContent).toContain('下批判断最早在 30 分钟后')
    expect(classifier.textContent).toContain('最近成功')
    expect(classifier.textContent).not.toContain('Claude 历史请求')
    expect(classifier.querySelector('.warn')).toBeNull()
    const history = card(root, 'Claude 历史用量（当前未使用）')
    expect(history.textContent).toContain('本月费用 US$ 20.00 / 配置月上限 US$ 20.00')
    expect(history.textContent).toContain('Claude 历史请求：')
    expect(history.textContent).not.toContain('下批判断最早在')
    expect(history.textContent).not.toContain('剩余邮件等待额度恢复')
    expect(history.textContent).not.toContain('4 封暂缓')
    expect(history.querySelector('[role="meter"]')?.classList.contains('danger')).toBe(false)
    expect(history.querySelector('.warn')).toBeNull()
  })

  it('explains unknown Codex errors without showing an opaque raw code', () => {
    expect(classifierErrorMessage(ClassificationProvider.CODEX, 'codex_unknown_response')).toBe('VPS Codex 请求失败，待重试；可刷新查看状态')
    expect(classifierErrorMessage(ClassificationProvider.CODEX, 'codex_http_502')).toContain('HTTP 502')
  })

  it('describes OpenAI as API billing and preserves Claude history', async () => {
    const server = new FakeServer()
    server.settings.classificationProvider = ClassificationProvider.OPENAI
    server.settings.classificationModel = 'openai/gpt-6.1-sol'
    server.settings.classificationEffort = 'high'
    server.status = { classifier: create(ClassifierStatusSchema, { provider: ClassificationProvider.OPENAI, model: 'openai/gpt-6.1-sol', effort: 'high', configured: false, lastErrorCode: 'openai_not_configured' }) }
    const root = await open(server)
    expect(card(root).textContent).toContain('OpenAI API · openai/gpt-6.1-sol · high')
    expect(card(root).textContent).toContain('按 API 计费')
    expect(card(root).textContent).toContain('OpenAI API 尚未配置')
    expect(card(root).textContent).not.toContain('使用 Codex 订阅额度')
    const overview = await open(server, '/overview')
    expect(card(overview, 'Claude 历史用量（当前未使用）').textContent).toContain('当前使用 OpenAI API')
  })
})

describe('historical replay evaluation', () => {
  it('keeps an absent record read-only without starting a new evaluation', async () => {
    const server = new FakeServer()
    const replay = await openReplay(server)
    expect(replay.textContent).toContain('没有历史检查记录')
    expect(replay.textContent).toContain('当前分级使用设置中的提示词')
    expect([...replay.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['刷新历史记录'])
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
    expect(server.calls.some((call) => call.path.endsWith(':start'))).toBe(false)
  })

  it('shows the old counts and a stopped run without implying that Claude will continue it', async () => {
    const server = new FakeServer()
    server.replay = create(ReplayEvaluationSchema, { name: 'replayEvaluation', state: ReplayEvaluation_State.RUNNING, totalCount: 12, evaluatedCount: 9, skippedCount: 1, autoCount: 5, autoMatchCount: 4, noLabelCount: 2, noLabelMatchCount: 1, unsureCount: 2, mismatches: [{ decidedLabel: 'labels/p2', ownerLabel: 'labels/p3', mailCount: 1 }] })
    const replay = await openReplay(server)
    expect(replay.textContent).toContain('旧检查未完成，已停止：10 / 12 封')
    expect([...replay.querySelectorAll('.kpi')].map((node) => node.textContent)).toEqual(['样本12', '已判断9', '与回答一致5', '不一致2', '拿不准2', '无法读取1'])
    expect(replay.textContent).toContain('P2 → 你的回答：P3（1 封）')
    expect(replay.textContent).toContain('不代表当前 Claude 的效果')
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('reports failed history reads and refreshes without a model request', async () => {
    const server = new FakeServer()
    const replay = await openReplay(server)
    server.replayFails = true
    replay.querySelector('button')?.click()
    await settle()
    expect(replay.textContent).toContain('UNAVAILABLE')
    expect(replay.textContent).not.toContain('没有历史检查记录')
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
    expect(server.calls.some((call) => call.path.includes('serviceStatus'))).toBe(false)
  })
})

describe('range undo preview truncation and error recovery', () => {
  it('caps preview pagination at PREVIEW_PAGES_MAX (20 pages) and shows 将撤销至少 X 条', async () => {
    const server = new FakeServer()
    server.ledgerEntries = Array.from({ length: 20 * 50 + 5 }, (_, index) => ledgerEntry(String(index + 1)))
    const root = await open(server)
    const undo = card(root, '撤销')
    const previewBtn = [...undo.querySelectorAll('button')].find(node => node.textContent === '预览')!
    previewBtn.click()
    await settle(25)
    expect(server.calls.filter(call => call.path.startsWith('/api/v2/ledgerEntries'))).toHaveLength(20)
    expect(undo.textContent).toContain('将撤销 至少 1000 条')

    // Scoped to a specific label shows the label name in the capped notice and clears on cancel.
    const select = undo.querySelector<HTMLSelectElement>('select[aria-label="分级"]')!
    select.value = 'labels/p2'
    select.dispatchEvent(new Event('change'))
    previewBtn.click()
    await settle(25)
    expect(undo.textContent).toContain('将撤销“P2”的 至少 1000 条')
    const cancelBtn = [...undo.querySelectorAll('button')].find(node => node.textContent === '取消')!
    cancelBtn.click()
    expect(undo.textContent).not.toContain('至少 1000 条')
  })

  it('clears the preview spinner and shows a toast when listing ledger entries fails', async () => {
    const server = new FakeServer()
    const root = await open(server)
    const undo = card(root, '撤销')
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'busy' } }), { status: 503, headers: { 'content-type': 'application/json' } })))
    const previewBtn = [...undo.querySelectorAll('button')].find(node => node.textContent === '预览')!
    previewBtn.click()
    await settle()
    expect(undo.textContent).not.toContain('正在统计')
    expect(root.querySelector('#toast')?.textContent).toContain('UNAVAILABLE')
  })
})
