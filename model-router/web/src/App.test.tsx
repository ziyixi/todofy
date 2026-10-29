import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { App } from './App'
import { mockApi, summary, usage } from './test/fixtures'
import { renderApp } from './test/harness'

test('overview separates reported tokens, incomplete subscription estimates and API usage estimates', async () => {
  renderApp(<App api={mockApi()} />)
  expect(await screen.findByText('1 次提供用量 · 1 次未完整提供')).toBeInTheDocument()
  expect(screen.getByText('订阅 API 等价估算').closest('article')).toHaveTextContent('估算未提供')
  expect(screen.getAllByText('API 费用估算')[0]?.closest('article')).toHaveTextContent('US$0.000220')
  expect(screen.getByRole('heading', { name: '模型与连接' })).toBeInTheDocument()
  expect(screen.getByText('连接已配置不代表模型实时可用。')).toBeInTheDocument()
  expect(screen.getAllByText('已配置')).toHaveLength(4)
  expect(screen.getByRole('heading', { name: 'Codex · Sol 6.1' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'OpenAI API · Sol 6.1' })).toBeInTheDocument()
})

test('overview keeps known API and subscription subtotals visible with request-level missing coverage', async () => {
  const apiBucket = usage.buckets![0]!
  const subscriptionBucket = usage.buckets![1]!
  const api = mockApi({
    getUsage: vi
      .fn()
      .mockResolvedValue({
        buckets: [
          apiBucket,
          {
            ...apiBucket,
            model: 'gemini-3.8-flash',
            provider: 'google',
            request_count: 2,
            cost_available_count: 0,
            estimated_cost_microusd: undefined,
          },
          { ...subscriptionBucket, request_count: 2, cost_available_count: 2, estimated_cost_microusd: 500 },
          { ...subscriptionBucket, time: '2026-10-27T00:00:00Z', request_count: 2, cost_available_count: 0 },
        ],
      }),
  })
  renderApp(<App api={api} />)
  const apiMetric = (await screen.findAllByText('API 费用估算'))[0]!.closest('article')!
  const subscriptionMetric = screen.getByText('订阅 API 等价估算').closest('article')!
  expect(apiMetric).toHaveTextContent('已知估算 US$0.000220')
  expect(apiMetric).toHaveTextContent('1 次有估算 · 2 次未计入')
  expect(subscriptionMetric).toHaveTextContent('已知估算 US$0.000500')
  expect(subscriptionMetric).toHaveTextContent('2 次有估算 · 2 次未计入')
  expect(apiMetric).not.toHaveTextContent('US$0.000720')
  const rows = within(screen.getByRole('heading', { name: '按模型汇总' }).closest('section')!)
  expect(rows.getByRole('rowheader', { name: /claude-opus-5-5/ }).closest('tr')).not.toHaveTextContent('次未计入')
  expect(rows.getByRole('rowheader', { name: /gemini-3.8-flash/ }).closest('tr')).toHaveTextContent(
    '0 次有估算 · 2 次未计入',
  )
})

test('embeddings do not make the reported text usage incomplete', async () => {
  const api = mockApi({
    getUsage: vi.fn().mockResolvedValue({
      buckets: [
        usage.buckets![0]!,
        {
          time: '2026-10-26T00:00:00Z',
          model: '@cf/baai/bge-m3',
          provider: 'cloudflare',
          billing_kind: 'platform_quota',
          request_count: 3,
          success_count: 3,
          usage_available_count: 0,
          cost_available_count: 0,
        },
      ],
    }),
  })
  renderApp(<App api={api} />)
  expect(await screen.findByText('1 次提供用量 · 0 次未完整提供')).toBeInTheDocument()
  const rows = within(screen.getByRole('heading', { name: '按模型汇总' }).closest('section')!)
  expect(rows.getByRole('rowheader', { name: /bge-m3/ }).closest('tr')).not.toHaveTextContent('次未计入')
})

test('request pagination and filters use bounded API calls and reset to the first page', async () => {
  const user = userEvent.setup()
  const listRequests = vi
    .fn()
    .mockResolvedValue({ requests: [summary], next_page_token: 'next-synthetic-token' })
  const api = mockApi({ listRequests })
  window.history.replaceState(null, '', '/#/requests')
  renderApp(<App api={api} />)
  await screen.findByRole('button', { name: /synthetic-app/ })
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() =>
    expect(listRequests).toHaveBeenLastCalledWith(expect.any(Object), 'next-synthetic-token'),
  )
  expect(screen.getByText('第 2 页')).toBeInTheDocument()
  await user.type(screen.getByLabelText('应用'), 'other-synthetic-app')
  await user.selectOptions(screen.getByLabelText('状态'), 'failed')
  await user.click(screen.getByRole('button', { name: '应用筛选' }))
  await waitFor(() =>
    expect(listRequests).toHaveBeenLastCalledWith(
      expect.objectContaining({ app: 'other-synthetic-app', state: 'failed' }),
      '',
    ),
  )
  expect(screen.getByText('第 1 页')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
})

test('opens a private request then copies it into Playground without submitting it', async () => {
  const user = userEvent.setup()
  const api = mockApi()
  window.history.replaceState(null, '', '/#/requests')
  renderApp(<App api={api} />)
  await user.click(await screen.findByRole('button', { name: /synthetic-app/ }))
  const detail = await screen.findByRole('complementary', { name: '请求详情' })
  await waitFor(() => expect(within(detail).getByRole('button', { name: '复制到 Playground' })).toBeEnabled())
  await user.click(within(detail).getByRole('button', { name: '复制到 Playground' }))
  expect(await screen.findByLabelText('输入')).toHaveValue('Synthetic input')
  expect(screen.getByLabelText('Instructions 1')).toHaveValue('Synthetic instructions')
  expect(api.generate).not.toHaveBeenCalled()
  expect(screen.getByRole('link', { name: 'Playground' })).toHaveAttribute('aria-current', 'page')
})

test('skip link focuses the current main content and keeps the selected tab', async () => {
  const user = userEvent.setup()
  window.history.replaceState(null, '', '/#/playground')
  renderApp(<App api={mockApi()} />)
  await user.tab()
  expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('main')).toHaveFocus()
  expect(window.location.hash).toBe('#/playground')
})
