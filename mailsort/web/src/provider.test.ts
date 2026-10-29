/** Provider choices use the owner API and preserve the independently selected Gmail mode. */
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { ClassificationProvider, ClassifierStatusSchema, ClaudeBudgetSchema, Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { mountApp, type Host } from './app.ts'
import { classifierErrorMessage } from './format.ts'
import { FakeServer, NOW, settle } from './test/fakeServer.ts'

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

function model(root: HTMLElement): HTMLSelectElement {
  return card(root).querySelector<HTMLSelectElement>('select[aria-label="分类模型"]')!
}

function save(root: HTMLElement, value: string): void {
  const select = model(root)
  select.value = value
  select.dispatchEvent(new Event('change'))
  card(root).querySelector<HTMLButtonElement>('button')!.click()
}

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
    save(again, 'gpt-6.1-sol')
    await settle()
    expect(server.settings.classificationProvider).toBe(ClassificationProvider.CODEX)
    expect(server.settings.mode).toBe(Mode.LIVE)
    expect(model(again).value).toBe('gpt-6.1-sol')
  })

  it('keeps the saved provider selected and shows a save error without claiming a switch', async () => {
    const server = new FakeServer()
    server.settingsSaveFails = true
    const root = await open(server)
    save(root, 'openai/gpt-6.1-sol')
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
