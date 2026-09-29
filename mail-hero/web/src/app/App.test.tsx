// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api } from '../api/client'
import type { ActiveAlert } from '../api/types'
import App from './App'

vi.mock('../api/client', () => ({ api: { settings: vi.fn(), overview: vi.fn() }, actionId: () => 'action-test', apiDownload: (path: string) => `/api/v1${path}` }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function open(active: ActiveAlert[]) {
  vi.mocked(api.settings).mockResolvedValue({ version: 1, mode: 'forward', receive_address: 'hero@example.test', send_paused: false })
  vi.mocked(api.overview).mockResolvedValue({ storage_bytes: 100, alerts: { configured: false, configuration_error: false, active, pending_notifications: 0, failed_notifications: 0 } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  // An unknown route keeps the test on the shell without page-specific API calls.
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/synthetic-missing-page']}><App /></MemoryRouter></QueryClientProvider>)
}

it('shows active warning and critical alerts in a status banner with the matching links', async () => {
  open([
    { code: 'endpoint_blocked', severity: 'critical', metrics: { waiting_deliveries: 2, current_blocked: 1, auto_recheck: 0 } },
    { code: 'policy_error', severity: 'warning', metrics: { count: 1 } },
    { code: 'synthetic_info', severity: 'info', metrics: {} },
  ])
  const banner = await screen.findByRole('status')
  expect(banner.textContent).toContain('投递目标被阻断，自动投递已停止')
  expect(banner.textContent).toContain('有邮件因策略读取失败只归档、未转发')
  expect(banner.textContent).not.toContain('synthetic_info')
  expect(banner.className).toContain('critical')
  const links = Array.from(banner.querySelectorAll('a')).map(link => link.getAttribute('href'))
  expect(links).toEqual(['/endpoints', '/settings'])
})

it('links a warning-only banner to settings without an endpoint link', async () => {
  open([{ code: 'delivery_failed', severity: 'warning', metrics: { count: 1 } }])
  const banner = await screen.findByRole('status')
  expect(banner.textContent).toContain('有投递已停止，需要处理')
  expect(banner.className).not.toContain('critical')
  expect(Array.from(banner.querySelectorAll('a')).map(link => link.getAttribute('href'))).toEqual(['/settings'])
})

it('shows no banner when no alert needs attention', async () => {
  open([{ code: 'synthetic_info', severity: 'info', metrics: {} }])
  await screen.findByText('已用 100 B')
  expect(screen.queryByRole('status')).toBeNull()
})
