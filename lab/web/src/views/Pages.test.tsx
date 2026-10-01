import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SeedSchema } from '@ziyixi/proto/lab/ui/v1/library_pb'
import { FakeServer } from '../test/fakeServer'
import { cards, likedPaper, paperWire, read, sendStatus, today } from '../test/fixtures'
import { renderApp } from '../test/harness'

describe('今日 states', () => {
  it('before the first fetch: empty state with the next fetch in the browser zone and a seeds link', async () => {
    const server = new FakeServer(cards(2), today({ deck: undefined, next_fetch_time: '2026-09-30T15:30:00Z' })).install()
    renderApp('/')
    expect(await screen.findByRole('heading', { name: '第一批论文还在路上' })).toBeInTheDocument()
    // 15:30 UTC is 23:30 in Asia/Shanghai (the test zone); the date depends on the real clock, the time does not.
    expect(screen.getByText(/下次抓取：.*23:30/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '添加几篇你喜欢的论文作为种子' })).toHaveAttribute('href', '/seeds')
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('while building: names the phase', async () => {
    new FakeServer(cards(2), today({ deck: undefined, building: { day: '2026-09-30', phase: 'summarizing' } })).install()
    renderApp('/')
    expect(await screen.findByRole('heading', { name: '今天的论文正在准备' })).toBeInTheDocument()
    expect(screen.getByText(/生成简介/)).toBeInTheDocument()
  })

  it('done for today: counts, send state, next batch, older deck chip and links', async () => {
    const server = new FakeServer(
      cards(2),
      today({ older_unfinished_decks: [{ deck: 'decks/2026-09-29', kind: 'ranked', card_count: 20, decided_count: 12, finished: false }], notice: 'cap_hit' }, 'ranked', 2),
    )
    server.decideElsewhere('arxiv:2609.10001', 'like')
    server.decideElsewhere('arxiv:2609.10002', 'dislike')
    server.send = sendStatus({ state: 'created', created_task_count: 2 })
    server.sentGeneration.set('arxiv:2609.10001', 1)
    server.install()
    renderApp('/')
    expect(await screen.findByRole('heading', { name: '今天的 2 篇都看完了' })).toBeInTheDocument()
    expect(screen.getByText('喜欢 1 · 不喜欢 1')).toBeInTheDocument()
    expect(await screen.findByText('已发送：Todoist 里新增了 2 个任务')).toBeInTheDocument()
    expect(screen.getByText(/下一批：.*14:30左右/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /9月29日 还剩 8 篇/ })).toHaveAttribute('href', '/deck/2026-09-29')
    expect(screen.getByRole('note')).toHaveTextContent('今日 AI 额度已用完')
    const more = screen.getByRole('navigation', { name: '更多' })
    expect(within(more).getByRole('link', { name: '已喜欢' })).toHaveAttribute('href', '/liked')
  })

  it('a finished deck with likes but no decision yet opens on the summary', async () => {
    const server = new FakeServer(cards(1))
    server.decideElsewhere('arxiv:2609.10001', 'like')
    server.install()
    renderApp('/')
    expect(await screen.findByRole('heading', { name: '发送到 Todofy？' })).toBeInTheDocument()
  })

  it('an error loading 今日 offers a retry', async () => {
    const server = new FakeServer(cards(1))
    server.interceptors.push((call) => (call.path === '/api/v1/today' ? new Response('<html>', { status: 502 }) : null))
    server.install()
    renderApp('/')
    expect(await screen.findByRole('alert')).toHaveTextContent('服务返回了无法识别的响应（HTTP 502）')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

describe('navigation', () => {
  it('marks the current view and navigates without a reload', async () => {
    const server = new FakeServer(cards(2))
    server.install()
    renderApp('/')
    await screen.findByRole('article')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    expect(within(nav).getByRole('link', { name: '今日' })).toHaveAttribute('aria-current', 'page')
    await userEvent.setup().click(within(nav).getByRole('link', { name: '已喜欢' }))
    expect(await screen.findByRole('heading', { name: '已喜欢' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/liked')
    expect(screen.getByText('还没有喜欢的论文。去今日划一划吧。')).toBeInTheDocument()
  })
})

describe('已喜欢', () => {
  it('searches by title, pages, and unlikes with a way back', async () => {
    const server = new FakeServer(cards(1))
    server.liked = [likedPaper(1), likedPaper(2), likedPaper(3), likedPaper(7, { paper: paperWire(7, { title: 'Seven Synthetic Rankers' }) })]
    server.likedPageSize = 2
    server.install()
    renderApp('/liked')
    expect(await screen.findByText('第 1 篇的简介。')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByText('第 3 篇的简介。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^取消喜欢：Synthetic Paper 1:/ }))
    await waitFor(() => expect(server.liked.map((paper) => paper.name)).not.toContain('likedPapers/2609.10001'))
    const removed = server.mutations().find((call) => call.method === 'DELETE')
    expect(removed?.path).toMatch(/^\/api\/v1\/likedPapers\/2609\.10001\?request_id=[0-9a-f-]{36}$/)
    await user.click(screen.getByRole('button', { name: /^恢复喜欢：Synthetic Paper 1:/ }))
    await waitFor(() => expect(server.liked.map((paper) => paper.name)).toContain('likedPapers/2609.10001'))
    const created = server.mutations().find((call) => call.method === 'POST')
    expect(created?.path).toMatch(/^\/api\/v1\/likedPapers\?liked_paper_id=2609\.10001&request_id=[0-9a-f-]{36}$/)
    expect(created?.body).toEqual({})
    // The box's text is one quoted literal (AIP-160), so words that are operators stay text.
    await user.type(screen.getByRole('searchbox', { name: '按标题搜索' }), 'seven')
    await waitFor(() => expect(server.calls.some((call) => call.path === `/api/v1/likedPapers?filter=${encodeURIComponent('"seven"')}`)).toBe(true))
    expect(await screen.findByText('第 7 篇的简介。')).toBeInTheDocument()
    expect(screen.queryByText('第 3 篇的简介。')).not.toBeInTheDocument()
    await user.clear(screen.getByRole('searchbox', { name: '按标题搜索' }))
    await user.type(screen.getByRole('searchbox', { name: '按标题搜索' }), 'OR "x')
    await waitFor(() => expect(server.calls.some((call) => call.path === `/api/v1/likedPapers?filter=${encodeURIComponent('"OR \\"x"')}`)).toBe(true))
    expect(await screen.findByText('没有找到标题匹配的论文。')).toBeInTheDocument()
  })
})

describe('种子', () => {
  it('parses pasted IDs and links, adds them and shows each state', async () => {
    const server = new FakeServer(cards(1), today({ cold_start: true }))
    server.seeds = [read(SeedSchema, { name: 'seeds/2401.00001', paper_id: 'arxiv:2401.00001', title: 'An Existing Seed', state: 'resolved', create_time: '2026-09-29T00:00:00Z' })]
    server.install()
    renderApp('/seeds')
    expect(await screen.findByTestId('seed-counter')).toHaveTextContent('有 1 篇种子，再添加 2 篇效果更好')
    const user = userEvent.setup()
    const box = screen.getByRole('textbox', { name: '粘贴 arXiv ID 或链接，每行一个' })
    await user.type(box, '2409.01234{Enter}arxiv.org/abs/2310.06825v2{Enter}not an id')
    expect(screen.getByText(/识别到 2 篇 · 1 行无法识别：not an id/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '添加 2 篇' }))
    expect(await screen.findAllByText('解析中')).toHaveLength(2)
    const posted = server.mutations('import')[0]
    expect(posted?.body).toMatchObject({ inputs: ['2409.01234', '2310.06825'] })
    await user.click(screen.getByRole('button', { name: '移除种子：An Existing Seed' }))
    await waitFor(() => expect(screen.queryByText('An Existing Seed')).not.toBeInTheDocument())
    expect(server.mutations().find((call) => call.method === 'DELETE')?.path).toMatch(/^\/api\/v1\/seeds\/2401\.00001\?request_id=/)
  })
})

describe('设置', () => {
  it('validates, saves with a request_id and links to seeds', async () => {
    const server = new FakeServer(cards(1))
    server.install()
    renderApp('/settings')
    const cap = await screen.findByRole('spinbutton', { name: '每日 AI 额度上限（neurons）' })
    expect(screen.getByRole('link', { name: '管理种子论文' })).toHaveAttribute('href', '/seeds')
    const user = userEvent.setup()
    await user.clear(cap)
    await user.type(cap, '9000')
    expect(screen.getByText('请输入 0 到 5000 之间的整数')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    await user.clear(cap)
    await user.type(cap, '1500')
    await user.click(screen.getByRole('radio', { name: '每篇单独一条' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已保存，下一次排序生效')).toBeInTheDocument()
    // AIP-134: only what changed is sent, named by update_mask, so another tab's change to other fields stays.
    const patch = server.mutations().find((call) => call.method === 'PATCH')
    expect(patch?.path).toMatch(/^\/api\/v1\/settings\?request_id=[0-9a-f-]{36}&update_mask=neuron_cap%2Csend_mode$/)
    expect(patch?.body).toEqual({ neuron_cap: 1500, send_mode: 'separate' })
    expect(server.settings).toMatchObject({ neuronCap: 1500, neuronCeiling: 5000, categories: ['cs.IR', 'cs.CL', 'cs.LG'] })
  })
})
