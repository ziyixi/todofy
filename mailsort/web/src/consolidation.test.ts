import { create } from '@ziyixi/proto/protobuf'
import { LabelConsolidation_Phase, LabelConsolidation_State, LabelConsolidationSchema } from '@ziyixi/proto/mailsort/ui/v2/consolidation_pb'
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { FakeServer, label, settle } from './test/fakeServer.ts'
import { parseConsolidationPlan } from './views/consolidation-plan.ts'
import { consolidationPanel } from './views/consolidation.ts'

const labels = [label('a', '旧/甲'), label('b', '旧/乙')]
const plan = JSON.stringify([{ sources: ['旧/甲', '旧/乙'], display_name: 'Updates', description: 'Product updates' }])

function button(root: HTMLElement, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent === name)
  if (found === undefined) throw new Error(`missing ${name}`)
  return found
}

describe('private consolidation plan', () => {
  it('resolves full source names to fresh IDs and etags, keeping the first source as target', () => {
    expect(parseConsolidationPlan(plan, labels)[0]).toMatchObject({ targetLabel: 'labels/a', displayName: 'Updates', sources: [{ label: 'labels/a', etag: 'etag-a' }, { label: 'labels/b', etag: 'etag-b' }] })
  })

  it.each([
    'not json', '[]',
    JSON.stringify([{ sources: ['missing'], display_name: 'Updates' }]),
    JSON.stringify([{ sources: ['旧/甲', '旧/甲'], display_name: 'Updates' }]),
    JSON.stringify([{ sources: ['旧/甲'], display_name: 'Invalid/Name' }]),
    JSON.stringify([{ sources: ['旧/甲'], display_name: 'Updates', unexpected: true }]),
  ])('refuses invalid plans before any request: %s', (text) => {
    expect(() => parseConsolidationPlan(text, labels)).toThrow()
  })

  it('preserves omitted descriptions and distinguishes an explicit empty description', () => {
    const input = { sources: ['旧/甲'], display_name: 'Updates' }
    expect(parseConsolidationPlan(JSON.stringify([input]), labels)[0]?.description).toBeUndefined()
    expect(parseConsolidationPlan(JSON.stringify([{ ...input, description: '' }]), labels)[0]?.description).toBe('')
  })

  it('refuses an ambiguous source name', () => {
    expect(() => parseConsolidationPlan(plan, [...labels, label('other', '旧/甲')])).toThrow('不唯一')
  })

  it('previews a private plan and submits only on explicit confirmation, ignoring duplicate clicks', async () => {
    const server = new FakeServer()
    server.labels = labels
    server.status = { effectiveMode: Mode.LIVE, writeScope: true }
    server.install()
    const panel = await consolidationPanel(labels)
    document.body.append(panel)
    const input = panel.querySelector('textarea')!
    input.value = plan
    input.dispatchEvent(new Event('input'))
    button(panel, '预览计划').click()
    await settle()
    expect(panel.textContent).toContain('旧/甲 + 旧/乙 → Updates')
    expect(server.calls.some((call) => call.path.endsWith(':start'))).toBe(false)
    const start = button(panel, '确认开始整理')
    start.click()
    start.click()
    await settle()
    const starts = server.calls.filter((call) => call.path.endsWith('labelConsolidation:start'))
    expect(starts).toHaveLength(1)
    expect(starts[0]?.body?.['groups']).toEqual([{ sources: [{ label: 'labels/a', etag: 'etag-a' }, { label: 'labels/b', etag: 'etag-b' }], target_label: 'labels/a', display_name: 'Updates', description: 'Product updates' }])
    expect(input.value).toBe('')
    expect(panel.textContent).toContain('进行中 · 核对标签')
  })

  it('invalidates preview when the private plan changes', async () => {
    const server = new FakeServer()
    server.labels = labels
    server.status = { effectiveMode: Mode.LIVE, writeScope: true }
    server.install()
    const panel = await consolidationPanel(labels)
    const input = panel.querySelector('textarea')!
    input.value = plan
    button(panel, '预览计划').click()
    await settle()
    expect(button(panel, '确认开始整理').hidden).toBe(false)
    input.value = '[]'
    input.dispatchEvent(new Event('input'))
    expect(button(panel, '确认开始整理').hidden).toBe(true)
  })

  it('allows explicit consolidation in shadow mode without changing the sorting mode', async () => {
    const server = new FakeServer()
    server.labels = labels
    server.status = { effectiveMode: Mode.SHADOW, writeScope: true }
    server.install()
    const panel = await consolidationPanel(labels)
    panel.querySelector('textarea')!.value = plan
    button(panel, '预览计划').click()
    await settle()
    expect(button(panel, '确认开始整理').disabled).toBe(false)
    button(panel, '确认开始整理').click()
    await settle()
    expect(server.calls.some((call) => call.path.endsWith('labelConsolidation:start'))).toBe(true)
    expect(server.settings.mode).toBe(Mode.SHADOW)
  })

  it.each([
    [Mode.OFF, false, '模式已关闭'],
    [Mode.SHADOW, true, 'Gmail 写入已熔断'],
  ])('holds consolidation while off or the write breaker is tripped', async (mode, breaker, message) => {
    const server = new FakeServer()
    server.labels = labels
    server.status = { effectiveMode: mode, writeScope: true }
    server.settings.breakerTripped = breaker
    server.install()
    const panel = await consolidationPanel(labels)
    panel.querySelector('textarea')!.value = plan
    button(panel, '预览计划').click()
    await settle()
    expect(panel.textContent).toContain(message)
    expect(button(panel, '确认开始整理').disabled).toBe(true)
  })

  it('resumes the blocked plan with its exact etag and shows observed failures', async () => {
    const server = new FakeServer()
    server.status = { effectiveMode: Mode.LIVE, writeScope: true }
    server.consolidation = create(LabelConsolidationSchema, { name: 'labelConsolidation', jobId: 'job-old', state: LabelConsolidation_State.BLOCKED, phase: LabelConsolidation_Phase.MOVE, errorCode: 'message_changed', nextAction: 'resume', etag: 'c1', processedCount: 4 })
    server.install()
    const panel = await consolidationPanel(labels)
    expect(panel.textContent).toContain('需要处理 · 移动标签关联 · 已处理 4 次标签关联')
    expect(panel.textContent).toContain('邮件的标签在整理期间发生变化')
    button(panel, '继续整理').click()
    await settle()
    expect(server.calls.find((call) => call.path.endsWith(':resume'))?.body).toMatchObject({ etag: 'c1' })
    expect(button(panel, '继续整理').hidden).toBe(true)
    server.consolidationFails = true
    button(panel, '刷新整理状态').click()
    await settle()
    expect(panel.textContent).toContain('整理状态未读到')
    expect(panel.textContent).not.toContain('进行中 ·')
  })
})
