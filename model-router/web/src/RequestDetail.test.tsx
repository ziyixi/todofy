import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import type { RequestRecord } from '@ziyixi/proto/modelrouter/inference/v1/console_wire'
import { RequestDetail } from './RequestDetail'
import { generation, mockApi, record } from './test/fixtures'
import { deferred, renderApp } from './test/harness'

test('keeps the detail pane while loading another request and removes the previous body', async () => {
  const pending = deferred<RequestRecord>()
  const api = mockApi({
    getRequest: vi.fn().mockResolvedValueOnce(record).mockReturnValueOnce(pending.promise),
  })
  const view = renderApp(
    <RequestDetail name={generation.name!} api={api} onClose={vi.fn()} onCopy={vi.fn()} />,
  )
  expect(await screen.findByText('Synthetic input')).toBeInTheDocument()
  view.rerender(
    <RequestDetail name="requests/second-synthetic-id" api={api} onClose={vi.fn()} onCopy={vi.fn()} />,
  )
  expect(screen.getByRole('complementary', { name: '请求详情' })).toHaveClass('request-detail')
  expect(screen.getByText('正在读取此请求…')).toBeInTheDocument()
  expect(screen.queryByText('Synthetic input')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '复制到 Playground' })).toBeDisabled()
  pending.resolve({ ...record, request: { ...record.request, input: 'Second synthetic input' } })
  expect(await screen.findByText('Second synthetic input')).toBeInTheDocument()
})

test('expired content is hidden even if an inconsistent response still contains bodies', async () => {
  const api = mockApi({
    getRequest: vi.fn().mockResolvedValue({
      ...record,
      content_available: false,
      request: { ...record.request, input: 'Hidden expired input' },
      generation: { ...generation, output: 'Hidden expired output' },
    }),
  })
  renderApp(<RequestDetail name={generation.name!} api={api} onClose={vi.fn()} onCopy={vi.fn()} />)
  expect(await screen.findByText(/内容已到期或暂不可用/)).toBeInTheDocument()
  expect(screen.queryByText('Hidden expired input')).not.toBeInTheDocument()
  expect(screen.queryByText('Hidden expired output')).not.toBeInTheDocument()
  expect(screen.queryByText('Synthetic instructions')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '复制到 Playground' })).toBeDisabled()
  expect(screen.getByText('服务报告模型').nextElementSibling).toHaveTextContent('未提供')
})

test('copy uses private retained inputs and preserves generic configuration', async () => {
  const user = userEvent.setup()
  const onCopy = vi.fn()
  const api = mockApi()
  renderApp(<RequestDetail name={generation.name!} api={api} onClose={vi.fn()} onCopy={onCopy} />)
  const copy = screen.getByRole('button', { name: '复制到 Playground' })
  await waitFor(() => expect(copy).toBeEnabled())
  await user.click(copy)
  expect(onCopy).toHaveBeenCalledWith({
    request: record.request,
    sourceRequest: '00000000-0000-4000-8000-000000000001',
  })
  const detail = screen.getByRole('complementary', { name: '请求详情' })
  expect(within(detail).getByText('synthetic-app')).toBeInTheDocument()
  expect(within(detail).getByText('由身份认证确定')).toBeInTheDocument()
})

test('a detail fetch failure can be retried without losing the selected request identity', async () => {
  const user = userEvent.setup()
  const api = mockApi({
    getRequest: vi
      .fn()
      .mockRejectedValueOnce(new Error('Synthetic read failure'))
      .mockResolvedValueOnce(record),
  })
  renderApp(<RequestDetail name={generation.name!} api={api} onClose={vi.fn()} onCopy={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic read failure')
  expect(screen.getByText('00000000-0000-4000-8000-000000000001')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重新读取' }))
  expect(await screen.findByText('Synthetic input')).toBeInTheDocument()
})
