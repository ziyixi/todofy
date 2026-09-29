// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { api } from '../api/client'
import DeliveryPage from './DeliveryPage'

vi.mock('../api/client', () => ({ api: { delivery: vi.fn(), endpoints: vi.fn(), message: vi.fn(), cancelDelivery: vi.fn() }, actionId: () => 'action-test' }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('warns before cancelling that an owner-resolved exception is later cleaned by the resolved retention period', async () => {
  vi.mocked(api.delivery).mockResolvedValue({ delivery: { event_id: 'event-1', message_id: 'message-1', state: 'failed', attempt_count: 2, created_at: '2026-09-25T10:00:00Z', last_error: 'retry_window_expired' }, attempts: [] })
  vi.mocked(api.endpoints).mockResolvedValue({ items: [] })
  vi.mocked(api.message).mockResolvedValue({ message: { id: 'message-1', version: 3, subject: 'Synthetic', from: 'sender@example.test', received_at: '2026-09-25T09:59:00Z', parse_state: 'ready' }, deliveries: [] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/deliveries/event-1']}><Routes><Route path="/deliveries/:id" element={<DeliveryPage/>}/></Routes></MemoryRouter></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '取消交付' }))
  const note = await screen.findByText(/已处理异常邮件保留天数/)
  // Like the Worker: only undelivered events created after the last delivered one must be owner-cancelled.
  expect(note.textContent).toContain('最后一次送达之后新建的其余未送达交付（从未送达时为全部其余交付）也都由你取消')
  expect(note.textContent).toContain('清理全部内容')
  // Mail already on a normal retention clock never switches to the resolved period.
  expect(note.textContent).toContain('若这封邮件尚未开始普通保留计时')
  expect(note.textContent).toContain('已开始普通保留计时的邮件（此前已达到安全终态）不适用此规则')
  expect(api.cancelDelivery).not.toHaveBeenCalled()
})

it('marks a canary delivery as a synthetic ops event', async () => {
  vi.mocked(api.delivery).mockResolvedValue({ delivery: { event_id: 'event-2', message_id: 'message-2', state: 'delivered', attempt_count: 1, created_at: '2026-09-29T00:00:00Z', canary: true }, attempts: [] })
  vi.mocked(api.endpoints).mockResolvedValue({ items: [] })
  vi.mocked(api.message).mockRejectedValue(new Error('not found'))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/deliveries/event-2']}><Routes><Route path="/deliveries/:id" element={<DeliveryPage/>}/></Routes></MemoryRouter></QueryClientProvider>)
  expect((await screen.findByText('金丝雀')).className).toBe('canary-tag')
  expect(screen.getByText(/运维合成事件/)).toBeTruthy()
})
