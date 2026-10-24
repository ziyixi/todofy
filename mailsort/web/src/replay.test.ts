import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { ReplayEvaluation_State, ReplayEvaluationSchema } from '@ziyixi/proto/mailsort/ui/v2/replay_pb'
import { Mode, ServiceStatus_AuthState } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { FakeServer, NOW, settle } from './test/fakeServer.ts'
import { replayCard } from './views/replay.ts'

async function open(server: FakeServer): Promise<HTMLElement> {
  server.install()
  const card = await replayCard(server.labels)
  document.body.append(card)
  return card
}

function button(root: HTMLElement, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent === name)
  if (found === undefined) throw new Error(`missing ${name}`)
  return found
}

describe('replay evaluation', () => {
  it('distinguishes never run from an empty sample without claiming mailbox accuracy', async () => {
    const server = new FakeServer()
    const card = await open(server)
    expect(card.textContent).toContain('尚未检查分类效果')
    expect(card.textContent).toContain('不代表整个邮箱的准确率')
    button(card, '检查分类效果').click()
    await settle()
    expect(card.textContent).toContain('最近 14 天没有可回放的已确认样本')
    expect(card.textContent).not.toContain('100%')
    expect(button(card, '重新检查').disabled).toBe(false)
  })

  it('disables a second start while submitting and while a run is active', async () => {
    const server = new FakeServer()
    server.replaySamples = 9
    const card = await open(server)
    const start = button(card, '检查分类效果')
    start.click()
    start.click()
    await settle()
    expect(server.calls.filter((call) => call.path.endsWith('replayEvaluation:start'))).toHaveLength(1)
    expect(button(card, '检查进行中').disabled).toBe(true)
    expect(card.textContent).toContain('进行中：0 / 9 封')
    expect(card.textContent).toContain('正常分拣、退避或临时降载可能推迟进度')
  })

  it('shows matched, mismatched, uncertain and unreadable counts separately and refreshes completion', async () => {
    const server = new FakeServer()
    server.replay = create(ReplayEvaluationSchema, { name: 'replayEvaluation', state: ReplayEvaluation_State.RUNNING, totalCount: 12, evaluatedCount: 9, skippedCount: 1, autoCount: 5, autoMatchCount: 4, noLabelCount: 2, noLabelMatchCount: 1, unsureCount: 2, mismatches: [{ decidedLabel: 'labels/p2', ownerLabel: 'labels/p3', mailCount: 1 }], reasonCounts: { model_unavailable: 1 }, createTime: timestampFromMs(NOW) })
    const card = await open(server)
    expect(card.textContent).toContain('进行中：10 / 12 封')
    expect([...card.querySelectorAll('.kpi')].map((node) => node.textContent)).toEqual(['样本12', '已判断9', '与回答一致5', '不一致2', '拿不准2', '无法读取1'])
    expect(card.textContent).toContain('P2 → 你的回答：P3（1 封）')
    expect(card.textContent).toContain('1 封因模型未能回答而记为拿不准')
    server.replay.state = ReplayEvaluation_State.SUCCEEDED
    server.replay.evaluatedCount = 11
    server.replay.completeTime = timestampFromMs(NOW + 60_000)
    button(card, '刷新状态').click()
    await settle()
    expect(card.textContent).toContain('已完成：12 / 12 封')
    expect(button(card, '重新检查').disabled).toBe(false)
  })

  it.each([
    [{ effectiveMode: Mode.OFF }, '模式已关闭'],
    [{ authState: ServiceStatus_AuthState.FAILED }, 'Gmail 尚未授权或授权已失效'],
    [{ aiQuotaExhausted: true }, '今日模型配额已用完'],
    [{ neuronsToday: 7000 }, '今日模型预算已用完'],
  ])('explains current holds and does not send a start: %j', async (status, hint) => {
    const server = new FakeServer()
    server.status = status
    const card = await open(server)
    expect(card.textContent).toContain(hint)
    expect(button(card, '检查分类效果').disabled).toBe(true)
    expect(server.calls.some((call) => call.path.endsWith(':start'))).toBe(false)
  })

  it('shows failed reads as failed observations without requesting old consolidation state', async () => {
    const server = new FakeServer()
    const card = await open(server)
    expect(server.calls.some((call) => call.path.includes('labelConsolidation'))).toBe(false)
    server.replayFails = true
    button(card, '刷新状态').click()
    await settle()
    expect(card.textContent).toContain('UNAVAILABLE')
    expect(card.textContent).not.toContain('尚未检查分类效果')
  })

  it('retries a lost response with the same request ID, creating only one run', async () => {
    const server = new FakeServer()
    server.replaySamples = 2
    const card = await open(server)
    const fetcher = globalThis.fetch
    let lost = false
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const response = await fetcher(url, init)
      if (!lost && url.endsWith('replayEvaluation:start')) { lost = true; throw new TypeError('lost response') }
      return response
    })
    button(card, '检查分类效果').click()
    await vi.waitFor(() => expect(button(card, '检查进行中').disabled).toBe(true), { timeout: 1500 })
    const calls = server.calls.filter((call) => call.path.endsWith('replayEvaluation:start'))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body?.['request_id']).toBe(calls[1]?.body?.['request_id'])
  })

  it('keeps a failed start visible and retains its request ID for an explicit retry', async () => {
    const server = new FakeServer()
    server.replayStartFails = true
    const card = await open(server)
    button(card, '检查分类效果').click()
    await vi.waitFor(() => expect(button(card, '重试本次启动').disabled).toBe(false), { timeout: 1500 })
    const first = server.calls.find((call) => call.path.endsWith('replayEvaluation:start'))?.body?.['request_id']
    expect(card.textContent).toContain('UNAVAILABLE')
    server.replayStartFails = false
    button(card, '重试本次启动').click()
    await settle()
    expect(server.calls.filter((call) => call.path.endsWith('replayEvaluation:start')).at(-1)?.body?.['request_id']).toBe(first)
  })
})
