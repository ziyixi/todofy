// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api } from '../api/client'
import SettingsPage from './SettingsPage'
vi.mock('../api/client', () => ({ api: { settings: vi.fn(), endpoints: vi.fn(), overview: vi.fn(), retentionPreview: vi.fn(), updateSettings: vi.fn() } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
function open() {
  vi.mocked(api.settings).mockResolvedValue({version:1, mode:'archive', receive_address:'hero@example.test',send_paused:false,raw_retention_days:7,content_retention_days:30,ledger_retention_days:180})
  vi.mocked(api.endpoints).mockResolvedValue({items:[]})
  vi.mocked(api.overview).mockResolvedValue({pending_count:0,storage_bytes:100,capacity_bytes:1000,pending_physical_delete_bytes:50,bucket_actual_bytes:null,account_r2_bytes:null,alerts:{configured:false,configuration_error:false,active:[],pending_notifications:0,failed_notifications:0}})
  const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
  render(<QueryClientProvider client={client}><MemoryRouter><SettingsPage/></MemoryRouter></QueryClientProvider>)
}
it('reports logical storage separately and never invents actual R2 usage', async () => {
  open(); await screen.findByText('分阶段保留')
  expect(screen.getByText('未测量')).toBeTruthy()
  expect(screen.getByText('未测量，需在 Cloudflare 查看')).toBeTruthy()
  expect(screen.getByText(/最小去重账本至少保留 180 天；当前不会自动删除账本/)).toBeTruthy()
  const history = screen.getByRole('checkbox',{name:/将尚无保留策略的历史邮件纳入/}) as HTMLInputElement
  expect(history.checked).toBe(false)
})
it('historical enrollment requires reviewing the preview before saving', async () => {
  open(); await screen.findByText('分阶段保留')
  vi.mocked(api.retentionPreview).mockResolvedValue({version:1,raw_retention_days:7,content_retention_days:30,ledger_retention_days:180,apply_existing:true,historical_messages:3,safe_terminal_messages:2,candidates:3,bytes_to_clear:0,preview_token:'signed-preview',expires_at:'2026-09-26T20:00:00Z'})
  vi.mocked(api.updateSettings).mockResolvedValue({version:2,mode:'archive',receive_address:'hero@example.test',send_paused:false,raw_retention_days:7,content_retention_days:30,ledger_retention_days:180})
  fireEvent.click(screen.getByRole('checkbox',{name:/将尚无保留策略的历史邮件纳入/}))
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  await screen.findByText('确认分阶段保留策略？')
  expect(api.retentionPreview).toHaveBeenCalledWith({raw_retention_days:7,content_retention_days:30,ledger_retention_days:180,apply_existing:true})
  expect(api.updateSettings).not.toHaveBeenCalled()
  expect(screen.getByText('0 字节')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'确认并保存'}))
  await waitFor(()=>expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({version:1,apply_existing:true,retention_confirmation:'signed-preview'})))
})
