import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { utcDay } from '../lib/format'
import { overview, recommendationReport, reminder, setup, summaryReport } from '../test/fixtures'
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

describe('reminders page', () => {
  it("highlights today's UTC reminder and lists older ones", async () => {
    mockApi({
      'GET /api/v1/dailyReminders': {
        daily_reminders: [
          reminder({ name: `dailyReminders/${utcDay()}`, state: 'unknown', error_code: 'reminder_result_unknown', task_id: undefined }),
          reminder(),
        ],
      },
    })
    renderApp('/reminders')
    const today = await screen.findByRole('region', { name: `今日（UTC ${utcDay()}）` })
    expect(today).toHaveTextContent('结果不明')
    const rows = within(screen.getByRole('list', { name: '提醒记录' })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('当天不再重发')
    expect(within(rows[1]!).getByRole('link')).toHaveAttribute('href', 'https://app.todoist.com/app/task/6X7rM8997g3RQmvh')
  })
})

describe('budget and health pages', () => {
  it('shows Gemini and Todoist usage', async () => {
    mockApi({})
    renderApp('/budget')
    const gemini = await screen.findByRole('region', { name: 'Gemini' })
    expect(within(gemini).getByRole('meter', { name: '今日 token' })).toHaveAttribute('aria-valuenow', String(181_233 + 4096))
    expect(gemini).toHaveTextContent('gemini-3.8-flash')
    expect(screen.getByRole('meter', { name: '15 分钟窗口' })).toHaveAttribute('aria-valuemax', '1000')
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
    mockApi({ 'GET /api/v1/integration': setup() })
    renderApp('/setup')
    expect(await screen.findByText('https://todofy-hooks.example.test/hooks/mail')).toBeInTheDocument()
    const secrets = screen.getByRole('region', { name: '密钥与配置' })
    expect(within(secrets).getByText('TODOIST_API_KEY').closest('li')).toHaveTextContent('未配置')
    expect(within(secrets).getByText('GEMINI_API_KEY').closest('li')).toHaveTextContent('已配置')
  })
})

describe('more page', () => {
  it('links the secondary pages', async () => {
    mockApi({})
    renderApp('/more')
    const main = await screen.findByRole('main')
    expect(within(main).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/reminders', '/gtd', '/budget', '/health', '/setup'])
  })
})
