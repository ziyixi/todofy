import { create } from '@ziyixi/proto/protobuf'
import { ReplayEvaluation_State, ReplayEvaluationSchema } from '@ziyixi/proto/mailsort/ui/v2/replay_pb'
import { FakeServer, settle } from './test/fakeServer.ts'
import { replayCard } from './views/replay.ts'

async function open(server: FakeServer): Promise<HTMLElement> {
  server.install()
  const card = await replayCard(server.labels)
  document.body.append(card)
  return card
}

describe('historical replay evaluation', () => {
  it('keeps an absent record read-only without starting a new evaluation', async () => {
    const server = new FakeServer()
    const card = await open(server)
    expect(card.textContent).toContain('没有历史检查记录')
    expect(card.textContent).toContain('当前分级使用设置中的提示词')
    expect([...card.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['刷新历史记录'])
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
    expect(server.calls.some((call) => call.path.endsWith(':start'))).toBe(false)
  })

  it('shows the old counts and a stopped run without implying that Claude will continue it', async () => {
    const server = new FakeServer()
    server.replay = create(ReplayEvaluationSchema, { name: 'replayEvaluation', state: ReplayEvaluation_State.RUNNING, totalCount: 12, evaluatedCount: 9, skippedCount: 1, autoCount: 5, autoMatchCount: 4, noLabelCount: 2, noLabelMatchCount: 1, unsureCount: 2, mismatches: [{ decidedLabel: 'labels/p2', ownerLabel: 'labels/p3', mailCount: 1 }] })
    const card = await open(server)
    expect(card.textContent).toContain('旧检查未完成，已停止：10 / 12 封')
    expect([...card.querySelectorAll('.kpi')].map((node) => node.textContent)).toEqual(['样本12', '已判断9', '与回答一致5', '不一致2', '拿不准2', '无法读取1'])
    expect(card.textContent).toContain('P2 → 你的回答：P3（1 封）')
    expect(card.textContent).toContain('不代表当前 Claude 的效果')
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('reports failed history reads and refreshes without a model request', async () => {
    const server = new FakeServer()
    const card = await open(server)
    server.replayFails = true
    card.querySelector('button')?.click()
    await settle()
    expect(card.textContent).toContain('UNAVAILABLE')
    expect(card.textContent).not.toContain('没有历史检查记录')
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
    expect(server.calls.some((call) => call.path.includes('serviceStatus'))).toBe(false)
  })
})
