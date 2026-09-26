// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api } from '../api/client'
import type { DeliveryStats } from '../api/types'
import DashboardPage from './DashboardPage'

vi.mock('../api/client', () => ({ api: { deliveryStats: vi.fn(), overview: vi.fn() } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const sample: DeliveryStats = {
  from: '2026-09-25T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z', bucket: 'day',
  totals: { succeeded: 2, retried: 1, failed: 1, unknown: 1 },
  buckets: [{ start: '2026-09-25T00:00:00.000Z', succeeded: 2, retried: 1, failed: 1, unknown: 1 }],
}

function open() {
  vi.mocked(api.deliveryStats).mockResolvedValue(sample)
  vi.mocked(api.overview).mockResolvedValue({ failed_count: 2 })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><MemoryRouter><DashboardPage /></MemoryRouter></QueryClientProvider>)
}

it('shows separate attempt outcomes and links to a matching historical event filter', async () => {
  open()
  const successful = await screen.findByRole('link', { name: '查看此区间成功的投递事件' })
  expect(successful.getAttribute('href')).toContain('attempt_outcome=succeeded')
  expect(successful.getAttribute('href')).toContain('from=2026-09-25T00%3A00%3A00.000Z')
  expect(screen.getByRole('status').textContent).toContain('另有 1 次尝试结果不明')
  expect(screen.getByRole('img', { name: /每个时段的精确值见下方明细表/ })).toBeTruthy()
  expect(screen.getByRole('link', { name: /查看当前失败事件/ }).getAttribute('href')).toBe('/deliveries?status=failed')
  fireEvent.click(screen.getByText('查看每个时段的准确数量'))
  expect(screen.getByRole('table', { name: /按 UTC 时段统计/ })).toBeTruthy()
})

it('turns inclusive UTC calendar dates into an exact exclusive end, with a 90-day limit', async () => {
  open()
  await screen.findByText('投递趋势')
  fireEvent.click(screen.getByRole('button', { name: '自选日期' }))
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-01' } })
  fireEvent.change(screen.getByLabelText('结束日期（含）'), { target: { value: '2026-09-03' } })
  fireEvent.click(screen.getByRole('button', { name: '应用日期' }))
  await waitFor(() => expect(api.deliveryStats).toHaveBeenCalledWith({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-04T00:00:00.000Z', bucket: 'day' }))
  fireEvent.change(screen.getByLabelText('结束日期（含）'), { target: { value: '2027-01-01' } })
  expect(screen.getByRole('alert').textContent).toContain('最多查看 90 个 UTC 日')
  expect((screen.getByRole('button', { name: '应用日期' }) as HTMLButtonElement).disabled).toBe(true)
})
