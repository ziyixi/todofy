/** Hourly evidence is distinct from Gmail writes and from earlier successful runs. */
import { create, type MessageInitShape } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { ClassificationBatchStatusSchema, Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { mountApp, type Host } from './app.ts'
import { FakeServer, NOW, settle } from './test/fakeServer.ts'

const host: Host = { now: () => NOW, confirm: () => true }

async function open(batch: MessageInitShape<typeof ClassificationBatchStatusSchema>, mode: Mode = Mode.LIVE): Promise<HTMLElement> {
  const server = new FakeServer()
  server.status = { effectiveMode: mode, batchStatus: create(ClassificationBatchStatusSchema, batch) }
  server.install()
  window.history.replaceState(null, '', '/overview')
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, host)
  await settle()
  const card = [...root.querySelectorAll<HTMLElement>('.card')].find((node) => node.querySelector('h2')?.textContent === '每小时分类')
  if (card === undefined) throw new Error('missing batch status')
  return card
}

describe('hourly classification evidence', () => {
  it('separates saved judgments from pending Gmail writes and shows actual usage and prompt identity', async () => {
    const card = await open({ state: 'completed', startedTime: timestampFromMs(NOW - 120_000), completedTime: timestampFromMs(NOW - 60_000), selectedCount: 10, judgedCount: 10, pendingWriteCount: 3, model: 'gpt-6.1-sol', effort: 'medium', inputTokens: 1200, outputTokens: 250, promptSha: 'abcdef0123456789' })
    expect(card.textContent).toContain('本轮检查完成')
    expect(card.textContent).toContain('gpt-6.1-sol · medium')
    expect(card.textContent).toContain('本轮选中 10 封 · 判断已保存 10 封 · 待写入 Gmail 3 封')
    expect(card.textContent).toContain('本轮 token：输入 1,200 · 输出 250')
    expect(card.textContent).toContain('Prompt abcdef012345')
    expect(card.textContent).not.toContain('超过两小时')
  })

  it('identifies a completed empty check without inventing model usage', async () => {
    const card = await open({ state: 'completed', startedTime: timestampFromMs(NOW - 60_000), completedTime: timestampFromMs(NOW), selectedCount: 0 })
    expect(card.textContent).toContain('本轮检查完成')
    expect(card.textContent).toContain('本轮没有需要模型判断的邮件，未调用模型。')
    expect(card.textContent).toContain('本轮模型用量未提供')
    expect(card.textContent).not.toContain('输入 0')
  })

  it('keeps the latest failure visible even when an earlier check succeeded', async () => {
    const card = await open({ state: 'failed', startedTime: timestampFromMs(NOW - 60_000), completedTime: timestampFromMs(NOW - 3_600_000), selectedCount: 8, errorCode: 'codex_not_logged_in', inputTokens: 20, outputTokens: 5, usagePartial: true })
    expect(card.textContent).toContain('本轮失败')
    expect(card.textContent).toContain('Codex 登录失效，请重新登录 Runner 的专用账号；邮件保持未分类。')
    expect(card.textContent).toContain('（记录不完整）')
    expect(card.textContent).not.toContain('本轮检查完成')
    expect(card.querySelectorAll('.warn')).toHaveLength(2)
  })

  it('warns when recent activity has not produced a complete check for over two hours', async () => {
    const card = await open({ state: 'running', startedTime: timestampFromMs(NOW - 60_000), completedTime: timestampFromMs(NOW - 3 * 3_600_000) })
    expect(card.textContent).toContain('正在分类')
    expect(card.textContent).toContain('超过两小时没有完整检查，最近完成 3 小时前')
    expect(card.textContent).toContain('检查 VPS 的 mailsort-runner 小时任务')
    expect(card.textContent).not.toContain('本轮检查完成')
  })

  it('does not raise a stale-run warning while the application is off', async () => {
    const card = await open({ state: 'completed', completedTime: timestampFromMs(NOW - 3 * 3_600_000) }, Mode.OFF)
    expect(card.textContent).not.toContain('超过两小时')
  })
})
