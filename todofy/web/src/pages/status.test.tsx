import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { CopyButton, Meter } from '../components/ui'
import { RouteError } from './RouteError'
import { overview, recommendationReport, setup, summaryReport } from '../test/fixtures'
import { apiError, mockApi, renderApp } from '../test/harness'

describe('digest page', () => {
  it('shows the stored reports and their raw JSON', async () => {
    mockApi({ 'GET /api/v1/latestReports': { name: 'latestReports', summary: summaryReport(), recommendations: [recommendationReport()] } })
    renderApp('/digest')
    const summary = await screen.findByRole('region', { name: '每日摘要' })
    expect(summary).toHaveTextContent('今天有 3 封账单提醒。')
    expect(summary).toHaveTextContent('正常')
    const recommendation = screen.getByRole('region', { name: '推荐任务 · 前 10 项' })
    expect(within(recommendation).getAllByRole('listitem')).toHaveLength(2)
    expect(within(recommendation).getByText('newsletter 收到的原始 JSON')).toBeInTheDocument()
    // The raw JSON is the wire JSON the newsletter gets, not the client's message.
    expect(JSON.parse(within(summary).getByText(/"computed_at"/).textContent ?? '')).toEqual(summaryReport())
  })

  it('recomputes a recommendation with the chosen top and shows a rate limit', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({
      'GET /api/v1/latestReports': { name: 'latestReports' },
      'POST /api/v1/latestReports:recompute': apiError(429, 'RATE_LIMITED', 'req-429'),
    })
    renderApp('/digest')
    expect(await screen.findByText('还没有日报')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新生成推荐' }))
    const dialog = screen.getByRole('dialog', { name: '重新生成推荐任务' })
    await user.selectOptions(within(dialog).getByLabelText('推荐数量'), '3')
    await user.click(within(dialog).getByRole('button', { name: '重新生成' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('RATE_LIMITED')
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.body).toMatchObject({ kind: 'recommendation', top_n: 3 })
  })

  it('repeats the same recompute with the same action id after a network failure, UNAVAILABLE or RATE_LIMITED', async () => {
    const user = userEvent.setup()
    const replies: object[] = [new Error('offline'), apiError(503, 'UNAVAILABLE'), apiError(429, 'RATE_LIMITED'), { summary: summaryReport() }]
    const { calls } = mockApi({
      'GET /api/v1/latestReports': { name: 'latestReports' },
      'POST /api/v1/latestReports:recompute': () => replies.shift()!,
    })
    renderApp('/digest')
    await user.click(await screen.findByRole('button', { name: '重新生成摘要' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('newsletter 下次读取的就是新结果')
    for (const code of ['NETWORK_ERROR', 'UNAVAILABLE', 'RATE_LIMITED']) {
      await user.click(within(dialog).getByRole('button', { name: '重新生成' }))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(code)
    }
    await user.click(within(dialog).getByRole('button', { name: '重新生成' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // TodofyCore stores only a computed report (RecomputeReportRequest.request_id): every retry is the same request.
    const ids = calls.filter((call) => call.method === 'POST').map((call) => (call.body as { request_id: string }).request_id)
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(1)
  })

  it('says when a recompute does not change what the newsletter reads', async () => {
    const user = userEvent.setup()
    mockApi({ 'GET /api/v1/latestReports': { name: 'latestReports' } })
    renderApp('/digest')
    await user.click(await screen.findByRole('button', { name: '重新生成推荐' }))
    const dialog = screen.getByRole('dialog', { name: '重新生成推荐任务' })
    await user.selectOptions(within(dialog).getByLabelText('推荐数量'), '3')
    expect(dialog).toHaveTextContent('不会读到这一份')
    await user.selectOptions(within(dialog).getByLabelText('推荐数量'), '10')
    expect(dialog).toHaveTextContent('就是这一份')
  })

  it('recomputes the summary without a top', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({
      'GET /api/v1/latestReports': { name: 'latestReports' },
      'POST /api/v1/latestReports:recompute': { summary: summaryReport() },
    })
    renderApp('/digest')
    await user.click(await screen.findByRole('button', { name: '重新生成摘要' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '重新生成' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.path).toBe('/api/v1/latestReports:recompute')
    expect(Object.keys(post?.body as object)).toEqual(['kind', 'request_id'])
    expect(post?.body).toMatchObject({ kind: 'summary' })
  })
})

describe('budget and health pages', () => {
  it('shows Gemini usage and no Todoist window', async () => {
    mockApi({})
    renderApp('/budget')
    const gemini = await screen.findByRole('region', { name: '模型用量' })
    expect(within(gemini).getByRole('meter', { name: '今日 token' })).toHaveAttribute('aria-valuenow', String(181_233 + 4096))
    expect(gemini).toHaveTextContent('gemini-3.8-flash')
    expect(screen.queryByRole('region', { name: 'Todoist' })).not.toBeInTheDocument()
  })

  it('shows the email and report fallback orders independently', async () => {
    const emailModels = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.7-flash']
    const reportsModels = overview().gemini!.models!
    mockApi({ 'GET /api/v1/serviceStatus': overview({ gemini: { ...overview().gemini, email_models: emailModels } }) })
    renderApp('/budget')
    const gemini = await screen.findByRole('region', { name: '模型用量' })
    const orders = within(gemini).getAllByRole('list')
    expect(within(gemini).getByText('逐封邮件摘要模型顺序')).toBeInTheDocument()
    expect(within(gemini).getByText('日报与推荐模型顺序')).toBeInTheDocument()
    for (const [index, models] of [emailModels, reportsModels].entries()) {
      const items = within(orders[index]!).getAllByRole('listitem')
      expect(items.map((item) => within(item).getByText(/gemini-/).textContent)).toEqual(models)
      expect(items[0]).toHaveTextContent('首选')
      expect(within(orders[index]!).getAllByText('首选')).toHaveLength(1)
    }
  })

  it('shows an old response without an email chain as unavailable', async () => {
    mockApi({})
    renderApp('/budget')
    const gemini = await screen.findByRole('region', { name: '模型用量' })
    const emailFact = within(gemini).getByText('逐封邮件摘要模型顺序').parentElement!
    expect(emailFact).toHaveTextContent('未提供')
    expect(within(emailFact).queryByRole('list')).not.toBeInTheDocument()
    expect(within(gemini).getAllByRole('list')).toHaveLength(1)
    expect(within(gemini).getByText('gemini-3.8-flash')).toBeInTheDocument()
  })

  it('shows the build, flags and active counts', async () => {
    mockApi({ 'GET /api/v1/serviceStatus': overview({ switches: { ...overview().switches, processing_paused: true } }) })
    renderApp('/health')
    const worker = await screen.findByRole('region', { name: 'Worker' })
    expect(within(worker).getByRole('link')).toHaveAttribute('href', 'https://github.com/ziyixi/todofy/commit/0123456789abcdef0123456789abcdef01234567')
    expect(screen.getByText('暂停处理：开')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '运行异常' })).toHaveTextContent('处理已暂停')
  })

  it('shows the reason when the status cannot be read', async () => {
    mockApi({ 'GET /api/v1/serviceStatus': apiError(503, 'UNAVAILABLE', 'req-ov') })
    renderApp('/health')
    expect(await screen.findByRole('alert')).toHaveTextContent('req-ov')
  })
})

describe('setup page', () => {
  it('shows webhook addresses and which secrets are configured, never their values', async () => {
    const configured = { mail_webhook_token: true, report_basic_auth: true, model_router: true }
    mockApi({ 'GET /api/v1/integration': setup({ configured }) })
    renderApp('/setup')
    expect(await screen.findByText('https://todofy-hooks.example.test/hooks/mail')).toBeInTheDocument()
    const secrets = screen.getByRole('region', { name: '密钥与配置' })
    expect(within(secrets).queryByText('TODOIST_API_KEY')).not.toBeInTheDocument()
    expect(within(secrets).queryByText('TODOIST_DEFAULT_PROJECT_ID')).not.toBeInTheDocument()
    expect(within(secrets).getByText('MODEL_ROUTER').closest('li')).toHaveTextContent('已配置')
  })
})

describe('more page', () => {
  it('links the secondary pages', async () => {
    mockApi({})
    renderApp('/more')
    const main = await screen.findByRole('main')
    expect(within(main).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/budget', '/health', '/setup'])
  })
})

describe('not found, route error and shared UI primitives', () => {
  it('renders NotFoundPage for unknown paths with a link back to attention', async () => {
    mockApi({})
    renderApp('/unknown/route')
    expect(await screen.findByText('没有这个页面')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '回到需要关注' })).toHaveAttribute('href', '/attention')
  })

  it('renders RouteError when a route component throws', () => {
    function Broken(): never {
      throw new Error('渲染崩溃')
    }
    const router = createMemoryRouter(
      [{ path: '/', element: <Broken />, errorElement: <RouteError /> }],
      { initialEntries: ['/'] },
    )
    render(<RouterProvider router={router} />)
    expect(screen.getByRole('heading', { name: '页面出错了' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('渲染崩溃')
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
  })

  it('applies ok, warn and danger tones on Meter thresholds', () => {
    render(
      <>
        <Meter label="正常用量" value={50} max={100} detail="50%" />
        <Meter label="预警用量" value={80} max={100} detail="80%" />
        <Meter label="超额用量" value={120} max={100} detail="120%" />
        <Meter label="零上限" value={10} max={0} detail="0%" />
      </>,
    )
    expect(screen.getByRole('meter', { name: '正常用量' })).toHaveClass('tone-ok')
    expect(screen.getByRole('meter', { name: '预警用量' })).toHaveClass('tone-warn')
    const danger = screen.getByRole('meter', { name: '超额用量' })
    expect(danger).toHaveClass('tone-danger')
    expect(danger).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByRole('meter', { name: '零上限' })).toHaveClass('tone-ok')
  })

  it('updates CopyButton label on clipboard success and handles clipboard failure', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<CopyButton value="evt-id-1" label="事件 ID" />)
    const button = screen.getByRole('button', { name: '复制事件 ID' })
    await user.click(button)
    expect(writeText).toHaveBeenCalledWith('evt-id-1')
    expect(screen.getByRole('button', { name: '已复制事件 ID' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '已复制事件 ID' }))
    expect(screen.getByRole('button', { name: '复制事件 ID' })).toBeInTheDocument()
  })
})

