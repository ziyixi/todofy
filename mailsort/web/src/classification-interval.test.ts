/** The interval changes only through its settings mask and reloads the authoritative next-batch time. */
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { ClassificationProvider, ClassifierStatusSchema, Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { mountApp } from './app.ts'
import { FakeServer, NOW, settle } from './test/fakeServer.ts'

async function open(server: FakeServer, path = '/settings'): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', path)
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, { now: () => NOW, confirm: () => { throw new Error('Interval needs no external-action confirmation') } })
  await settle()
  return root
}

function interval(root: HTMLElement): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>('section.card')].find(node => node.querySelector('h2')?.textContent === '自动分类间隔')
  if (found === undefined) throw new Error('Missing interval control')
  return found
}

function choice(root: HTMLElement, minutes: number): HTMLButtonElement {
  const found = [...interval(root).querySelectorAll('button')].find(node => node.textContent === `${String(minutes)} 分钟`)
  if (found === undefined) throw new Error('Missing interval choice')
  return found
}

describe('automatic classification interval', () => {
  it('shows the default 15-minute choice and leaves an unchanged click read-only', async () => {
    const server = new FakeServer()
    server.settings.classificationIntervalMinutes = 0 // A reply from before the field existed.
    const root = await open(server)
    expect([...interval(root).querySelectorAll('button')].map(node => node.textContent)).toEqual(['5 分钟', '15 分钟', '30 分钟', '60 分钟'])
    expect(choice(root, 15).getAttribute('aria-pressed')).toBe('true')
    expect(interval(root).textContent).toContain('Gmail 维护检查仍每 5 分钟')
    choice(root, 15).click()
    await settle()
    expect(server.calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it.each([ClassificationProvider.CLAUDE, ClassificationProvider.CODEX])('persists a %s interval and refreshes the next batch without changing mode/provider/prompt', async provider => {
    const server = new FakeServer()
    Object.assign(server.settings, { classificationProvider: provider, mode: Mode.LIVE, effectiveMode: Mode.SHADOW, breakerTripped: true, breakerReason: 'label_share' })
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
    expect(server.settings).toMatchObject({ classificationIntervalMinutes: 30, classificationProvider: provider, mode: Mode.LIVE, breakerTripped: true, breakerReason: 'label_share' })
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
