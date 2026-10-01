import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiError, FakeServer } from '../test/fakeServer'
import { cards, sendStatus } from '../test/fixtures'
import { renderApp } from '../test/harness'
import { motion } from '../test/setup'

const title = (n: number) => `Synthetic Paper ${n}: Ranking Things With Other Things`

/** A finished 3-card deck: 1 like, 2 like, 3 dislike; the summary is on screen. */
async function finished(server = new FakeServer(cards(3))) {
  motion.reduced = true // skip the 600 ms "看完了" moment
  server.install()
  renderApp('/')
  await screen.findByRole('article', { name: title(1) })
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '喜欢' }))
  await user.click(screen.getByRole('button', { name: '喜欢' }))
  await user.click(screen.getByRole('button', { name: '不喜欢' }))
  await screen.findByRole('heading', { name: '3 篇看完了 · 喜欢 2 · 不喜欢 1' })
  await settled()
  return { server, user }
}

/** The summary has saved every decision and its arming window (SUMMARY_ARM_MS) is over. */
async function settled() {
  await waitFor(
    () => {
      expect(document.querySelector('.summary [aria-disabled="true"]')).toBeNull()
      expect(screen.queryByText('正在保存你的选择…')).not.toBeInTheDocument()
    },
    { timeout: 3000 },
  )
}

const sendButton = () => screen.getByRole('button', { name: /发送到 Todofy/ })
const status = () => screen.getByTestId('send-status')

describe('end of deck', () => {
  it('lists the liked papers and previews both send modes', async () => {
    await finished()
    const list = screen.getByRole('list', { name: '喜欢的论文' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: '发送到 Todofy？' })).toBeInTheDocument()
    expect(screen.getByTestId('send-preview')).toHaveTextContent('将在 Todoist 创建「论文雷达 2026-09-30 · 2 篇」和 2 个子任务')
    await userEvent.setup().click(screen.getByRole('radio', { name: '每篇单独一条' }))
    expect(screen.getByTestId('send-preview')).toHaveTextContent('将在 Todoist 创建 2 个任务')
    expect(screen.getByRole('button', { name: '暂不发送' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /回到卡片重来/ })).toBeInTheDocument()
  })

  it('removes a paper from this send (the like stays) and restores it', async () => {
    const { server, user } = await finished()
    await user.click(screen.getByRole('button', { name: `移出：${title(1)}` }))
    expect(screen.getByTestId('send-preview')).toHaveTextContent('1 篇')
    await waitFor(() => expect(server.excluded.has('arxiv:2609.10001')).toBe(true))
    expect(server.decisions()['arxiv:2609.10001']).toBe('like')
    await user.click(screen.getByRole('button', { name: `恢复：${title(1)}` }))
    await waitFor(() => expect(server.excluded.size).toBe(0))
    expect(screen.getByTestId('send-preview')).toHaveTextContent('2 篇')
  })

  it('sends explicitly and shows the created state; a later visit says it was sent', async () => {
    const { server, user } = await finished()
    expect(server.mutations('send')).toHaveLength(0)
    await user.click(screen.getByRole('radio', { name: '每篇单独一条' }))
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('已发送：Todoist 里新增了 3 个任务'))
    expect(server.mutations('send')[0]?.body).toMatchObject({ mode: 'separate' })
    // Sent papers carry a badge and can no longer be removed.
    await waitFor(() => expect(screen.getAllByText('已发送')).toHaveLength(2))
    expect(screen.queryByRole('button', { name: /^移出/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '完成' }))
    expect(await screen.findByRole('heading', { name: '今天的 3 篇都看完了' })).toBeInTheDocument()
  })

  it('polls a pending send until Todofy has created everything', async () => {
    const server = new FakeServer(cards(3))
    const soon = new Date(Date.now() + 100).toISOString()
    server.sendScript = [
      sendStatus({ state: 'pending', tasks_total: 3, tasks_created: 1, next_poll_time: soon, update_time: '2026-09-30T12:00:01Z' }),
      sendStatus({ state: 'pending', tasks_total: 3, tasks_created: 2, next_poll_time: soon, update_time: '2026-09-30T12:00:04Z' }),
      sendStatus({ state: 'created', tasks_total: 3, tasks_created: 3, update_time: '2026-09-30T12:00:07Z' }),
    ]
    const { user } = await finished(server)
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('Todofy 正在创建：1 / 3'))
    // Nothing to press while it settles.
    expect(screen.queryByRole('button', { name: /回到卡片重来/ })).not.toBeInTheDocument()
    await waitFor(() => expect(status()).toHaveTextContent('Todofy 正在创建：2 / 3'), { timeout: 5000 })
    await waitFor(() => expect(status()).toHaveTextContent('已发送：Todoist 里新增了 3 个任务'), { timeout: 5000 })
    expect(server.calls.filter((call) => call.method === 'GET' && call.path.endsWith('/send'))).toHaveLength(2)
  }, 15_000)

  it('retries a partly failed send with the frozen payload and never duplicates', async () => {
    const server = new FakeServer(cards(3))
    server.sendScript = [
      sendStatus({ state: 'failed', tasks_total: 3, tasks_created: 2, update_time: '2026-09-30T12:00:01Z' }),
      sendStatus({ state: 'created', tasks_total: 3, tasks_created: 3, update_time: '2026-09-30T12:00:05Z' }),
    ]
    const { user } = await finished(server)
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('部分失败：已创建 2 / 3'))
    // The content is frozen: no removing, no mode switch.
    expect(screen.getByRole('button', { name: `移出：${title(1)}` })).toBeDisabled()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试（不会重复创建）' }))
    await waitFor(() => expect(status()).toHaveTextContent('已发送：Todoist 里新增了 3 个任务'))
    const bodies = server.mutations('send').map((call) => call.body)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.request_id).not.toBe(bodies[1]?.request_id)
  })

  it('says a duplicate was already sent', async () => {
    const server = new FakeServer(cards(3))
    server.sendScript = [sendStatus({ state: 'duplicate' })]
    const { user } = await finished(server)
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('这组已经发送过，不会重复创建'))
    expect(screen.getByRole('button', { name: '完成' })).toBeInTheDocument()
  })

  it('keeps the confirm step open when Todofy is paused and nothing was recorded', async () => {
    const server = new FakeServer(cards(3))
    server.sendScript = [
      sendStatus({ state: 'paused', recorded: false, frozen: false, error_code: 'todoist_paused', tasks_created: 0 }),
      sendStatus({ state: 'created', update_time: '2026-09-30T12:01:00Z' }),
    ]
    const { user } = await finished(server)
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('Todofy 暂停中（Todoist 已暂停），这次没有发送'))
    // Still editable, and sending again is the same button.
    expect(screen.getByRole('button', { name: `移出：${title(1)}` })).toBeEnabled()
    expect(screen.getByRole('button', { name: '暂不发送' })).toBeInTheDocument()
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('已发送'))
  })

  it('reports a recorded pause as handed over', async () => {
    const server = new FakeServer(cards(3))
    server.sendScript = [sendStatus({ state: 'paused', recorded: true, error_code: 'maintenance', tasks_created: 0, next_poll_time: undefined })]
    const { user } = await finished(server)
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('已交给 Todofy，等它恢复后会自动创建（Todofy 维护中）'))
  })

  it('shows why a send was rejected', async () => {
    const server = new FakeServer(cards(3))
    server.sendScript = [sendStatus({ state: 'rejected', recorded: false, frozen: false, error_code: 'daily_limit', tasks_created: 0 })]
    const { user } = await finished(server)
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('没有发送：今天发送次数已达上限'))
    expect(sendButton()).toBeEnabled()
  })

  it('offers a safe retry when the outcome is unknown', async () => {
    const server = new FakeServer(cards(3))
    server.sendScript = [sendStatus({ state: 'unknown', tasks_created: 0, next_poll_time: undefined }), sendStatus({ state: 'created', update_time: '2026-09-30T12:02:00Z' })]
    const { user } = await finished(server)
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('结果未知：重试不会重复创建'))
    await user.click(screen.getByRole('button', { name: '重试（不会重复创建）' }))
    await waitFor(() => expect(status()).toHaveTextContent('已发送'))
  })

  it('shows a failed request with a retry that reuses the server’s idempotency', async () => {
    const server = new FakeServer(cards(3))
    let failures = 2
    server.interceptors.push((call) => (call.path.endsWith(':send') && call.method === 'POST' && failures-- > 0 ? apiError(502, 'UNAVAILABLE') : null))
    const { user } = await finished(server)
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('发送请求没有完成'), { timeout: 3000 })
    // The automatic repeat reused the request_id.
    const ops = server.mutations('send').map((call) => call.body?.request_id)
    expect(ops[0]).toBe(ops[1])
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('已发送'))
  })

  it('offers 补发 for papers liked after a delivered send, never resending the others', async () => {
    const server = new FakeServer(cards(3))
    const { user } = await finished(server)
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('已发送'))
    // Back to the cards: 重来, like all three, and finish again.
    await user.click(screen.getByRole('button', { name: /回到卡片重来/ }))
    await screen.findByRole('article', { name: title(1) })
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    await screen.findByRole('heading', { name: '3 篇看完了 · 喜欢 3 · 不喜欢 0' })
    await settled()
    server.sendScript = [sendStatus({ generation: 2, intent_id: 'deck-2026-09-30-g2', item_count: 1, tasks_total: 2, tasks_created: 2, update_time: '2026-09-30T13:00:00Z' })]
    const again = await screen.findByRole('button', { name: '补发新增的 1 篇' })
    expect(screen.getByTestId('send-preview')).toHaveTextContent('「论文雷达 2026-09-30（补发）· 1 篇」')
    await user.click(again)
    await waitFor(() => expect(server.sentGeneration.get('arxiv:2609.10003')).toBe(2))
    expect(server.sentGeneration.get('arxiv:2609.10001')).toBe(1)
  })

  it('暂不发送 records the choice and goes to the done screen', async () => {
    const { server, user } = await finished()
    await user.click(screen.getByRole('button', { name: '暂不发送' }))
    expect(await screen.findByRole('heading', { name: '今天的 3 篇都看完了' })).toBeInTheDocument()
    expect(server.snoozeTime).not.toBeNull()
    expect(await screen.findByText(/还有 2 篇喜欢的论文没有发送/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '去发送' }))
    expect(await screen.findByRole('heading', { name: '发送到 Todofy？' })).toBeInTheDocument()
  })

  it('never sends on a double tap on the last card: the summary ignores taps at first, sends only from the send box', async () => {
    motion.reduced = true // the summary appears at once, with no "看完了" moment
    const server = new FakeServer(cards(2)).install()
    renderApp('/')
    await screen.findByRole('article', { name: title(1) })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    // The second tap of a double tap lands on whatever is there now.
    const send = await screen.findByRole('button', { name: /发送到 Todofy/ })
    // Focus is on the heading, not on a button, and the last swipe's snackbar does not cover the preview.
    expect(screen.getByRole('heading', { name: '2 篇看完了 · 喜欢 2 · 不喜欢 0' })).toHaveFocus()
    expect(screen.queryByTestId('snackbar')).not.toBeInTheDocument()
    await user.click(send)
    await user.click(screen.getByRole('button', { name: '暂不发送' }))
    await user.click(screen.getByRole('button', { name: /回到卡片重来/ }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(server.mutations('send')).toHaveLength(0)
    expect(server.mutations('snooze')).toHaveLength(0)
    expect(server.mutations('restart')).toHaveLength(0)
    // The confirm step is announced.
    await waitFor(() => expect(screen.getByTestId('live-region')).toHaveTextContent('看完了，喜欢 2 篇。是否发送到 Todofy？'))
    // The button belongs to the send box, after the mode and its preview.
    const box = screen.getByRole('group', { name: '发送到 Todofy？' })
    const preview = within(box).getByTestId('send-preview')
    expect(within(box).getByRole('button', { name: /发送到 Todofy/ })).toBe(send)
    expect(preview.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await settled()
    await user.click(send)
    await waitFor(() => expect(status()).toHaveTextContent('已发送'))
    expect(server.mutations('send')).toHaveLength(1)
  })

  it('waits for every swipe to be saved before it lets the owner send, so one send carries every like', async () => {
    motion.reduced = true
    const server = new FakeServer(cards(4))
    server.latency = 150
    server.install()
    renderApp('/')
    await screen.findByRole('article', { name: title(1) })
    const user = userEvent.setup()
    for (let i = 0; i < 4; i++) await user.click(screen.getByRole('button', { name: '喜欢' }))
    // The header counts this session's decisions at once; the send waits for the server.
    expect(await screen.findByRole('heading', { name: '4 篇看完了 · 喜欢 4 · 不喜欢 0' })).toBeInTheDocument()
    expect(screen.getAllByText('正在保存你的选择…').length).toBeGreaterThan(0)
    // Nothing can be sent or put off while a swipe is still on its way.
    for (const name of [/发送到 Todofy/, '暂不发送']) {
      for (const button of screen.queryAllByRole('button', { name })) expect(button).toBeDisabled()
    }
    await settled()
    expect(screen.getByTestId('send-preview')).toHaveTextContent('「论文雷达 2026-09-30 · 4 篇」和 4 个子任务')
    await user.click(screen.getByRole('button', { name: /发送到 Todofy/ }))
    await waitFor(() => expect(status()).toHaveTextContent('已发送'))
    expect(new Set(server.sentGeneration.values())).toEqual(new Set([1]))
    expect(server.sentGeneration.size).toBe(4)
    await settled()
    expect(screen.queryByRole('button', { name: /补发/ })).not.toBeInTheDocument()
  })

  it('undoes just the last card from the summary and the done screen (button and Z), keeping the rest', async () => {
    const { server, user } = await finished()
    await user.click(screen.getByRole('button', { name: '撤销上一张' }))
    expect(await screen.findByRole('article', { name: title(3) })).toBeInTheDocument()
    await waitFor(() => expect(Object.keys(server.decisions())).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: '喜欢' }))
    await screen.findByRole('heading', { name: '3 篇看完了 · 喜欢 3 · 不喜欢 0' })
    await settled()
    await user.keyboard('z')
    expect(await screen.findByRole('article', { name: title(3) })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '不喜欢' }))
    await screen.findByRole('heading', { name: '3 篇看完了 · 喜欢 2 · 不喜欢 1' })
    await settled()
    await user.click(screen.getByRole('button', { name: '暂不发送' }))
    // 暂不发送 lands on the done screen with focus on its heading; 撤销上一张 works there too.
    expect(await screen.findByRole('heading', { name: '今天的 3 篇都看完了' })).toHaveFocus()
    await user.keyboard('{Meta>}z{/Meta}')
    expect(await screen.findByRole('article', { name: title(3) })).toBeInTheDocument()
    await waitFor(() => expect(server.decisions()).toEqual({ 'arxiv:2609.10001': 'like', 'arxiv:2609.10002': 'like' }))
  })

  it('says a send created nothing without calling it partial, and 稍后再说 leaves without wiping the deck', async () => {
    const server = new FakeServer(cards(3))
    server.sendScript = [sendStatus({ state: 'failed', tasks_total: 3, tasks_created: 0, error_code: 'todoist_rejected', update_time: '2026-09-30T12:00:01Z' })]
    const { user } = await finished(server)
    await user.click(sendButton())
    await waitFor(() => expect(status()).toHaveTextContent('发送失败：没有创建任务（Todoist 拒绝了请求）'))
    expect(status()).not.toHaveTextContent('部分失败')
    await user.click(screen.getByRole('button', { name: '稍后再说' }))
    expect(await screen.findByRole('heading', { name: '今天的 3 篇都看完了' })).toBeInTheDocument()
    expect(server.mutations('restart')).toHaveLength(0)
    expect(Object.keys(server.decisions())).toHaveLength(3)
  })

  it('with no likes offers only 完成 and 回到卡片重来', async () => {
    motion.reduced = true
    const server = new FakeServer(cards(2)).install()
    renderApp('/')
    await screen.findByRole('article', { name: title(1) })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '不喜欢' }))
    await user.click(screen.getByRole('button', { name: '不喜欢' }))
    expect(await screen.findByText('今天没有喜欢的论文。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /发送到 Todofy/ })).not.toBeInTheDocument()
    await settled()
    await user.click(screen.getByRole('button', { name: /回到卡片重来/ }))
    expect(await screen.findByRole('article', { name: title(1) })).toBeInTheDocument()
    await waitFor(() => expect(server.mutations('restart')).toHaveLength(1))
  })

  it('opens a liked paper read-only from the summary', async () => {
    const { user } = await finished()
    await user.click(screen.getByRole('button', { name: title(2) }))
    const dialog = screen.getByRole('dialog', { name: '论文卡片' })
    expect(within(dialog).getByText(/这是第 2 篇合成论文的简介/)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
