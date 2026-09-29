// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api } from '../api/client'
import type { ActiveAlert, RetentionPreview } from '../api/types'
import SettingsPage from './SettingsPage'
vi.mock('../api/client', () => ({ api: { settings: vi.fn(), endpoints: vi.fn(), overview: vi.fn(), retentionPreview: vi.fn(), updateSettings: vi.fn() } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
function open(active: ActiveAlert[] = [], resolved: number | null = 60) {
  vi.mocked(api.settings).mockResolvedValue({version:1, mode:'archive', receive_address:'hero@example.test',send_paused:false,raw_retention_days:7,content_retention_days:30,ledger_retention_days:180,resolved_retention_days:resolved})
  vi.mocked(api.endpoints).mockResolvedValue({items:[]})
  vi.mocked(api.overview).mockResolvedValue({pending_count:0,storage_bytes:100,capacity_bytes:1000,pending_physical_delete_bytes:50,bucket_actual_bytes:null,account_r2_bytes:null,alerts:{configured:false,configuration_error:false,active,pending_notifications:0,failed_notifications:0}})
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
  vi.mocked(api.retentionPreview).mockResolvedValue({version:1,raw_retention_days:7,content_retention_days:30,ledger_retention_days:180,resolved_retention_days:60,resolved_messages:0,apply_existing:true,historical_messages:3,safe_terminal_messages:2,candidates:3,bytes_to_clear:0,preview_token:'signed-preview',expires_at:'2026-09-26T20:00:00Z'})
  vi.mocked(api.updateSettings).mockResolvedValue({version:2,mode:'archive',receive_address:'hero@example.test',send_paused:false,raw_retention_days:7,content_retention_days:30,ledger_retention_days:180})
  fireEvent.click(screen.getByRole('checkbox',{name:/将尚无保留策略的历史邮件纳入/}))
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  await screen.findByText('确认分阶段保留策略？')
  expect(api.retentionPreview).toHaveBeenCalledWith({raw_retention_days:7,content_retention_days:30,ledger_retention_days:180,resolved_retention_days:60,apply_existing:true})
  expect(api.updateSettings).not.toHaveBeenCalled()
  const history = screen.getByText('0 字节').closest('p')!
  // Enrollment also puts historical owner-resolved exceptions on the resolved clock.
  expect(history.textContent).toContain('投递失败后已由你处理（重发已送达或已取消）的历史邮件也会纳入已处理异常邮件保留期：从确认后首次后台检查起计时，60 天后清理全部内容')
  expect(history.textContent).toContain('上面的已处理数量可能未包含它们')
  fireEvent.click(screen.getByRole('button',{name:'确认并保存'}))
  await waitFor(()=>expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({version:1,apply_existing:true,retention_confirmation:'signed-preview'})))
})
it('names the delivery-stop alerts and links endpoint alerts to the targets page', async () => {
  open([
    {code:'endpoint_blocked',severity:'critical',metrics:{waiting_deliveries:2,current_blocked:1,auto_recheck:1}},
    {code:'delivery_failed',severity:'warning',metrics:{count:1}},
    {code:'endpoint_paused',severity:'warning',metrics:{waiting_deliveries:2}},
    {code:'policy_error',severity:'warning',metrics:{count:1}},
  ])
  const blocked = await screen.findByText('投递目标被阻断，自动投递已停止')
  expect(blocked.closest('p')?.querySelector('a')?.getAttribute('href')).toBe('/endpoints')
  expect(screen.getByText('投递目标已暂停')).toBeTruthy()
  expect(screen.getByText('有投递已停止，需要处理').closest('p')?.querySelector('a')).toBeNull()
  expect(screen.getByText('有邮件因策略读取失败只归档、未转发')).toBeTruthy()
  expect(screen.getByText(/投递目标被阻断或暂停、投递已停止，以及策略读取失败只归档未转发/)).toBeTruthy()
})
const preview = (resolved: number | null, count = 5) => ({version:1,raw_retention_days:7,content_retention_days:30,ledger_retention_days:180,resolved_retention_days:resolved,resolved_messages:count,apply_existing:false,historical_messages:0,safe_terminal_messages:0,candidates:0,bytes_to_clear:0,preview_token:'signed-resolved',expires_at:'2026-09-28T20:00:00Z'})
const resolvedField = () => screen.getByRole('spinbutton',{name:/^已处理异常邮件保留天数/}) as HTMLInputElement
it('shows the resolved-exception period and says unresolved failures are never cleaned', async () => {
  open(); await screen.findByText('分阶段保留')
  expect(resolvedField().value).toBe('60')
  expect(screen.getByText(/经重发成功或被你取消的邮件不会进入普通保留期；最后一次处理后保留这么多天再清理全部内容。默认 60 天，不得短于正文保留期；留空表示不自动清理，正文不自动清理时也须留空。仍失败或待处理的邮件不会被清理：最后一次送达之后新建的交付（如之后的重发）若失败且未被你取消，邮件仍算失败。/)).toBeTruthy()
  const summary = screen.getByText(/正文到期后清理正文、附件与事件内容/)
  expect(summary.textContent).toContain('经重发成功或被你取消的邮件，按已处理异常邮件保留期在最后一次处理后清理全部内容')
  // Like the Worker: a failure created after the last delivered event, not cancelled by the owner, keeps the message.
  expect(summary.textContent).toContain('最后一次送达之前的失败不会阻止清理，但之后新建的交付（如之后的重发）若失败且未被你取消，邮件不会被清理')
  expect(summary.textContent).not.toContain('只要曾有一次送达')
  expect(summary.textContent).toContain('已开始普通保留计时的邮件不改用此期限')
  expect(summary.textContent).toContain('仍未处理的投递失败（之后没有新建并送达的交付，也未被你取消）、待处理、解析失败或正在处理的邮件')
  expect(summary.textContent).toContain('不会自动清理')
  expect(summary.textContent).not.toContain('仍投递失败')
  // The old sentence claimed every failed message is kept forever.
  expect(summary.textContent).not.toContain('待处理、失败、需人工检查或正在处理的邮件不会自动清理')
  expect(screen.getByRole('button',{name:'保存设置'}).hasAttribute('disabled')).toBe(true)
})
it('rejects a resolved period shorter than the content period before any preview', async () => {
  open(); await screen.findByText('分阶段保留')
  fireEvent.change(resolvedField(),{target:{value:'20'}})
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  expect((await screen.findByRole('alert')).textContent).toBe('已处理异常邮件的保留期不能短于正文保留期。')
  expect(api.retentionPreview).not.toHaveBeenCalled()
  // Content kept forever: like the Worker, a resolved period is rejected; only an empty one is allowed.
  fireEvent.change(screen.getByRole('spinbutton',{name:/^正文与附件保留天数/}),{target:{value:''}})
  fireEvent.change(resolvedField(),{target:{value:'10'}})
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('正文不自动清理时，已处理异常邮件保留天数也须留空。'))
  expect(api.retentionPreview).not.toHaveBeenCalled()
  fireEvent.change(resolvedField(),{target:{value:''}})
  vi.mocked(api.retentionPreview).mockResolvedValue({...preview(null),raw_retention_days:7,content_retention_days:null})
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  await screen.findByText('确认分阶段保留策略？')
  expect(api.retentionPreview).toHaveBeenCalledTimes(1)
  expect(api.retentionPreview).toHaveBeenCalledWith({raw_retention_days:7,content_retention_days:null,ledger_retention_days:180,resolved_retention_days:null,apply_existing:false})
  expect(api.updateSettings).not.toHaveBeenCalled()
})
it('enabling the resolved period previews its effect on stored resolved mail and saves with the token', async () => {
  open([], null); await screen.findByText('分阶段保留')
  expect(resolvedField().value).toBe('')
  fireEvent.change(resolvedField(),{target:{value:'90'}})
  vi.mocked(api.retentionPreview).mockResolvedValue(preview(90, 12))
  vi.mocked(api.updateSettings).mockResolvedValue({version:2,mode:'archive',receive_address:'hero@example.test',send_paused:false,raw_retention_days:7,content_retention_days:30,ledger_retention_days:180,resolved_retention_days:90})
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  await screen.findByText('确认分阶段保留策略？')
  expect(api.retentionPreview).toHaveBeenCalledWith({raw_retention_days:7,content_retention_days:30,ledger_retention_days:180,resolved_retention_days:90,apply_existing:false})
  const line = screen.getByText(/已处理异常邮件：最后一次处理后 90 天清理全部内容/)
  expect(line.querySelector('strong')?.textContent).toBe('12')
  expect(line.textContent).toContain('不按邮件冻结')
  expect(line.textContent).toContain('已超过 90 天（邮件自身冻结的正文期限更长时按更长者）的会在之后的后台清理中逐批删除')
  expect(line.textContent).toContain('仍有未处理的失败交付（之后没有新建并送达的交付，也未被你取消）的邮件和待处理的邮件不会被清理')
  expect(line.textContent).not.toContain('此项未改变')
  expect(api.updateSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'确认并保存'}))
  await waitFor(()=>expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({version:1,resolved_retention_days:90,content_retention_days:30,apply_existing:false,retention_confirmation:'signed-resolved'})))
})
it('disabling the resolved period says stored resolved mail is no longer cleaned', async () => {
  open(); await screen.findByText('分阶段保留')
  fireEvent.change(resolvedField(),{target:{value:''}})
  vi.mocked(api.retentionPreview).mockResolvedValue(preview(null, 3))
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  await screen.findByText('确认分阶段保留策略？')
  expect(api.retentionPreview).toHaveBeenCalledWith(expect.objectContaining({resolved_retention_days:null}))
  const line = screen.getByText(/已处理异常邮件：不自动清理/)
  expect(line.textContent).toContain('保存后它们不再自动清理')
  expect(line.textContent).not.toContain('删除')
})
it('historical enrollment with the resolved period disabled does not promise resolved cleanup', async () => {
  open([], null); await screen.findByText('分阶段保留')
  vi.mocked(api.retentionPreview).mockResolvedValue({...preview(null, 0),apply_existing:true,historical_messages:3,safe_terminal_messages:2,candidates:3})
  fireEvent.click(screen.getByRole('checkbox',{name:/将尚无保留策略的历史邮件纳入/}))
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  await screen.findByText('确认分阶段保留策略？')
  const history = screen.getByText('0 字节').closest('p')!
  expect(history.textContent).toContain('将为 3 封尚无策略的历史邮件设置此策略')
  expect(history.textContent).not.toContain('已处理异常邮件保留期')
  expect(screen.getByText(/已处理异常邮件：不自动清理/).textContent).toContain('此项未改变')
})
it('says the resolved period is unchanged when only the content period changes', async () => {
  open(); await screen.findByText('分阶段保留')
  fireEvent.change(screen.getByRole('spinbutton',{name:/^正文与附件保留天数/}),{target:{value:'40'}})
  vi.mocked(api.retentionPreview).mockResolvedValue({...preview(60, 7),content_retention_days:40})
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  await screen.findByText('确认分阶段保留策略？')
  expect(api.retentionPreview).toHaveBeenCalledWith({raw_retention_days:7,content_retention_days:40,ledger_retention_days:180,resolved_retention_days:60,apply_existing:false})
  const line = screen.getByText(/已处理异常邮件：最后一次处理后 60 天清理全部内容/)
  expect(line.querySelector('strong')?.textContent).toBe('7')
  expect(line.textContent).toContain('此项未改变。')
  expect(line.textContent).not.toContain('重新计算')
  expect(line.textContent).not.toContain('不再自动清理')
  expect(screen.getByText(/新邮件：原件 7 天；正文与附件 40 天/)).toBeTruthy()
})
it('lengthening the resolved period explains the re-timing even when the resolved count is unavailable', async () => {
  open(); await screen.findByText('分阶段保留')
  fireEvent.change(resolvedField(),{target:{value:'120'}})
  const withoutCount: Partial<ReturnType<typeof preview>> = preview(120)
  delete withoutCount.resolved_messages
  vi.mocked(api.retentionPreview).mockResolvedValue(withoutCount as RetentionPreview)
  vi.mocked(api.updateSettings).mockResolvedValue({version:2,mode:'archive',receive_address:'hero@example.test',send_paused:false,raw_retention_days:7,content_retention_days:30,ledger_retention_days:180,resolved_retention_days:120})
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  await screen.findByText('确认分阶段保留策略？')
  const line = screen.getByText(/已处理异常邮件：最后一次处理后 120 天清理全部内容/)
  expect(line.textContent).toContain('暂时无法统计已处理的异常邮件。')
  expect(line.querySelector('strong')).toBeNull()
  expect(line.textContent).toContain('保存后按最后一次处理时间重新计算（不早于系统首次确认其已处理的时间），已超过 120 天（邮件自身冻结的正文期限更长时按更长者）的会在之后的后台清理中逐批删除原件、正文、附件与事件内容。')
  expect(line.textContent).not.toContain('此项未改变')
  fireEvent.click(screen.getByRole('button',{name:'确认并保存'}))
  await waitFor(()=>expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({version:1,resolved_retention_days:120,retention_confirmation:'signed-resolved'})))
})
