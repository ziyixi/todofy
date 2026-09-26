// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api } from '../api/client'
import DeliveriesPage from './DeliveriesPage'

vi.mock('../api/client', () => ({ api: { deliveries: vi.fn() } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('keeps the selected attempt result and UTC interval while paging through distinct events', async () => {
  vi.mocked(api.deliveries)
    .mockResolvedValueOnce({ items: [{ event_id: 'event-1', message_id: 'message-1', state: 'delivered', attempt_count: 3, created_at: '2026-09-25T10:00:00Z' }], next_cursor: 'next-cursor' })
    .mockResolvedValueOnce({ items: [], next_cursor: null })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const route = '/deliveries?attempt_outcome=retried&from=2026-09-25T00%3A00%3A00.000Z&to=2026-09-26T00%3A00%3A00.000Z'
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><DeliveriesPage /></MemoryRouter></QueryClientProvider>)
  await screen.findByText('event-1'.slice(0, 8) + '…')
  expect(screen.getByRole('link', { name: 'event-1…' }).getAttribute('href')).toContain('attempt_outcome=retried')
  expect(screen.getByText(/按事件创建时间排序/)).toBeTruthy()
  expect(screen.getByRole('link', { name: '清除筛选' }).getAttribute('href')).toBe('/deliveries')
  expect(screen.queryByRole('combobox', { name: '筛选投递状态' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /下一页/ }))
  await waitFor(() => expect(api.deliveries).toHaveBeenLastCalledWith(expect.objectContaining({
    attempt_outcome: 'retried', from: '2026-09-25T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z', cursor: 'next-cursor',
  })))
})
