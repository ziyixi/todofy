import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LikedPaper, Seed, SettingsResponse } from '../../../worker/src/api-types.ts'
import { FakeServer, json } from '../test/fakeServer'
import { cards, paper, sendStatus, today } from '../test/fixtures'
import { renderApp } from '../test/harness'

describe('今日 states', () => {
  it('before the first fetch: empty state with the next fetch in the browser zone and a seeds link', async () => {
    const server = new FakeServer(cards(2), today({ deck: null, next_run_at: '2026-09-30T15:30:00Z' })).install()
    renderApp('/')
    expect(await screen.findByRole('heading', { name: '第一批论文还在路上' })).toBeInTheDocument()
    // 15:30 UTC is 23:30 in Asia/Shanghai (the test zone); the date depends on the real clock, the time does not.
    expect(screen.getByText(/下次抓取：.*23:30/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '添加几篇你喜欢的论文作为种子' })).toHaveAttribute('href', '/seeds')
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('while building: names the phase', async () => {
    new FakeServer(cards(2), today({ deck: null, building: { day: '2026-09-30', phase: 'summarizing' } })).install()
    renderApp('/')
    expect(await screen.findByRole('heading', { name: '今天的论文正在准备' })).toBeInTheDocument()
    expect(screen.getByText(/生成简介/)).toBeInTheDocument()
  })

  it('done for today: counts, send state, next batch, older deck chip and links', async () => {
    const server = new FakeServer(
      cards(2),
      today({ older_unfinished: [{ deck_id: '2026-09-29', kind: 'ranked', total: 20, decided: 12, finished: false }], notice: 'cap_hit' }, 'ranked', 2),
    )
    server.decideElsewhere('arxiv:2609.10001', 'like')
    server.decideElsewhere('arxiv:2609.10002', 'dislike')
    server.send = sendStatus({ state: 'created', tasks_created: 2 })
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
    server.interceptors.push((call) => (call.path === '/api/today' ? new Response('<html>', { status: 502 }) : null))
    server.install()
    renderApp('/')
    expect(await screen.findByRole('alert')).toHaveTextContent('服务返回了无法识别的响应（HTTP 502）')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

describe('navigation', () => {
  it('marks the current view and navigates without a reload', async () => {
    const server = new FakeServer(cards(2))
    server.interceptors.push((call) => (call.path.startsWith('/api/liked') ? json({ papers: [], next_cursor: null }) : null))
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
  const liked = (n: number): LikedPaper => ({ ...paper(n), liked_at: '2026-09-30T01:00:00Z', deck_id: '2026-09-30', brief: `第 ${n} 篇的简介。第二句。` })

  it('searches by title, pages, and unlikes with a way back', async () => {
    const server = new FakeServer(cards(1))
    const feedback: unknown[] = []
    server.interceptors.push((call) => {
      if (call.path.startsWith('/api/liked')) {
        const url = new URL(call.path, 'http://x')
        if (url.searchParams.get('q')) return json({ papers: [liked(7)], next_cursor: null })
        if (url.searchParams.get('cursor') === 'c2') return json({ papers: [liked(3)], next_cursor: null })
        return json({ papers: [liked(1), liked(2)], next_cursor: 'c2' })
      }
      if (call.path === '/api/feedback') {
        feedback.push(call.body)
        return json({ paper_id: call.body?.paper_id, label: call.body?.label })
      }
      return null
    })
    server.install()
    renderApp('/liked')
    expect(await screen.findByText('第 1 篇的简介。')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByText('第 3 篇的简介。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^取消喜欢：Synthetic Paper 1:/ }))
    await waitFor(() => expect(feedback).toHaveLength(1))
    expect(feedback[0]).toMatchObject({ paper_id: 'arxiv:2609.10001', label: null })
    await user.click(screen.getByRole('button', { name: /^恢复喜欢：Synthetic Paper 1:/ }))
    await waitFor(() => expect(feedback[1]).toMatchObject({ label: 'like' }))
    await user.type(screen.getByRole('searchbox', { name: '按标题搜索' }), 'seven')
    expect(await screen.findByText('第 7 篇的简介。')).toBeInTheDocument()
  })
})

describe('种子', () => {
  it('parses pasted IDs and links, adds them and shows each state', async () => {
    const server = new FakeServer(cards(1), today({ cold_start: true }))
    let seeds: Seed[] = [{ paper_id: 'arxiv:2401.00001', title: 'An Existing Seed', state: 'resolved', added_at: '2026-09-29T00:00:00Z' }]
    server.interceptors.push((call) => {
      if (call.path !== '/api/seeds') return null
      if (call.method === 'POST') {
        const ids = (call.body?.ids ?? []) as string[]
        seeds = [...seeds, ...ids.map((id): Seed => ({ paper_id: `arxiv:${id}`, title: null, state: 'pending', added_at: '2026-09-30T00:00:00Z' }))]
      }
      if (call.method === 'DELETE') seeds = seeds.filter((seed) => seed.paper_id !== call.body?.paper_id)
      return json({ seeds })
    })
    server.install()
    renderApp('/seeds')
    expect(await screen.findByTestId('seed-counter')).toHaveTextContent('有 1 篇种子，再添加 2 篇效果更好')
    const user = userEvent.setup()
    const box = screen.getByRole('textbox', { name: '粘贴 arXiv ID 或链接，每行一个' })
    await user.type(box, '2409.01234{Enter}arxiv.org/abs/2310.06825v2{Enter}not an id')
    expect(screen.getByText(/识别到 2 篇 · 1 行无法识别：not an id/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '添加 2 篇' }))
    expect(await screen.findAllByText('解析中')).toHaveLength(2)
    const posted = server.mutations().find((call) => call.method === 'POST')
    expect(posted?.body).toMatchObject({ ids: ['2409.01234', '2310.06825'] })
    await user.click(screen.getByRole('button', { name: '移除种子：An Existing Seed' }))
    await waitFor(() => expect(screen.queryByText('An Existing Seed')).not.toBeInTheDocument())
  })
})

describe('设置', () => {
  const settings: SettingsResponse = {
    categories: ['cs.IR', 'cs.CL', 'cs.LG'],
    lambda: 0.3,
    neuron_cap: 2000,
    tldr_model: '@cf/ibm-granite/granite-4.0-h-micro',
    ingest_paused: false,
    send_mode: 'subtasks',
    ceiling: 5000,
    tldr_models: ['@cf/ibm-granite/granite-4.0-h-micro', '@cf/meta/llama-3.2-1b-instruct', '@cf/qwen/qwen3-30b-a3b-fp8'],
  }

  it('validates, saves with an op_id and links to seeds', async () => {
    const server = new FakeServer(cards(1))
    server.interceptors.push((call) => {
      if (call.path !== '/api/settings') return null
      if (call.method === 'PUT') {
        const rest: Record<string, unknown> = { ...call.body }
        delete rest.op_id
        return json({ ...settings, ...rest })
      }
      return json(settings)
    })
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
    const put = server.mutations().find((call) => call.method === 'PUT')
    expect(put?.body).toMatchObject({ neuron_cap: 1500, send_mode: 'separate', categories: ['cs.IR', 'cs.CL', 'cs.LG'] })
    expect(typeof put?.body?.op_id).toBe('string')
  })
})
