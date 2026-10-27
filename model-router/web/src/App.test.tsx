import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { App } from './App'
import { generation, mockApi } from './test/fixtures'
import { renderApp } from './test/harness'

test('overview separates reported tokens, unknown usage, subscription counts and unavailable API estimates', async () => {
  renderApp(<App api={mockApi()} />)
  expect(await screen.findByText('1 次提供用量 · 1 次未提供')).toBeInTheDocument()
  expect(screen.getByText('订阅用量不换算为 API USD')).toBeInTheDocument()
  expect(screen.getByText('API 费用估算').closest('article')).toHaveTextContent('未提供')
  expect(screen.getByRole('heading', { name: '模型与连接' })).toBeInTheDocument()
  expect(screen.getByText('显示本控制台的连接配置，不代表实时可用性。')).toBeInTheDocument()
  expect(screen.getAllByText('已配置')).toHaveLength(3)
})

test('request pagination and filters use bounded API calls and reset to the first page', async () => {
  const user = userEvent.setup()
  const listRequests = vi.fn().mockResolvedValue({ requests: [generation], next_page_token: 'next-synthetic-token' })
  const api = mockApi({ listRequests })
  window.history.replaceState(null, '', '/#/requests')
  renderApp(<App api={api} />)
  await screen.findByRole('button', { name: /synthetic-app/ })
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => expect(listRequests).toHaveBeenLastCalledWith(expect.any(Object), 'next-synthetic-token'))
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
