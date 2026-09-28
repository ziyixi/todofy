// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api, ApiError } from '../api/client'
import type { ActiveAlert, Endpoint } from '../api/types'
import { formatDate } from '../components/UI'
import EndpointsPage from './EndpointsPage'

vi.mock('../api/client', async importOriginal => ({
  ApiError: (await importOriginal<typeof import('../api/client')>()).ApiError,
  api: { endpoints: vi.fn(), settings: vi.fn(), overview: vi.fn(), unblockEndpoint: vi.fn(), updateEndpoint: vi.fn() },
  actionId: () => 'action-test',
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const base: Endpoint = { id: 'endpoint-1', label: 'Synthetic consumer', url: 'https://consumer.example.test/hooks/mail', auth_type: 'bearer', credential_configured: true, version: 4, current_revision_id: 'revision-2' }

const hours = (count: number) => new Date(Date.now() + count * 3_600_000).toISOString()
const olderBlock = (lastSeen: string): ActiveAlert => ({ code: 'endpoint_blocked', severity: 'critical', metrics: { waiting_deliveries: 3, current_blocked: 0, auto_recheck: 0 }, last_seen_at: lastSeen })

function open(endpoint: Partial<Endpoint>, active: ActiveAlert[] = []) {
  vi.mocked(api.endpoints).mockResolvedValue({ items: [{ ...base, ...endpoint }] })
  vi.mocked(api.settings).mockResolvedValue({ version: 1, mode: 'forward', receive_address: 'hero@example.test', send_paused: false, current_endpoint_id: 'endpoint-1' })
  vi.mocked(api.overview).mockResolvedValue({ alerts: { configured: false, configuration_error: false, active, pending_notifications: 0, failed_notifications: 0 } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><MemoryRouter><EndpointsPage /></MemoryRouter></QueryClientProvider>)
}

it('explains a route block with its automatic recheck and unblocks every revision with the endpoint version', async () => {
  const until = hours(6)
  open({ blocked_reason: 'http_404', blocked_until: until, blocked_rechecks: 3 })
  const line = await screen.findByText(/目标返回 404（路径不存在）/)
  expect(screen.getByText(`将于 ${formatDate(until)} 自动重试`, { exact: false })).toBeTruthy()
  // Three armed rechecks: two performed, the third is the scheduled one.
  expect(line.textContent).toContain('自动复查已用 2/8 次，下一次是第 3 次。')
  expect(line.textContent).not.toContain('最后一次')
  expect(screen.getByText('已阻断')).toBeTruthy()
  vi.mocked(api.unblockEndpoint).mockResolvedValue({ affected_revisions: 2, version: 5 })
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  await waitFor(() => expect(api.unblockEndpoint).toHaveBeenCalledWith('endpoint-1', { version: 4 }))
  const notice = await screen.findByText(/已解除此目标 2 个版本的阻断/)
  expect(notice.getAttribute('role')).toBe('status')
  expect(notice.textContent).toContain('现在会重试')
  expect(notice.textContent).toContain('超过 7 天')
  expect(notice.textContent).toContain('手动重试')
  expect(notice.textContent).toContain('约 10 分钟')
  expect(notice.textContent).toContain('自动复查次数已重新计数')
})

it('does not count the first scheduled recheck as used', async () => {
  open({ blocked_reason: 'http_404', blocked_until: hours(6), blocked_rechecks: 1 })
  const line = await screen.findByText(/当前目标版本已阻断/)
  expect(line.textContent).toContain('自动复查已用 0/8 次，下一次是第 1 次。')
})

it('names the eighth recheck as the last automatic one', async () => {
  open({ blocked_reason: 'http_302', blocked_until: hours(6), blocked_rechecks: 8 })
  const line = await screen.findByText(/当前目标版本已阻断/)
  expect(line.textContent).toContain('自动复查已用 7/8 次，下一次是最后一次；仍返回同类错误时将保持阻断，直到你手动解除。')
  expect(line.textContent).not.toContain('8/8')
  expect(line.textContent).not.toContain('已用完')
})

it('counts the recheck on a cooled block too', async () => {
  open({ blocked_reason: 'http_405', blocked_until: hours(-1), blocked_rechecks: 2 })
  const line = await screen.findByText(/冷却已结束/)
  expect(line.textContent).toContain('自动复查已用 1/8 次，下一次是第 2 次。')
})

it('says an uncounted cooldown from an older block does not use up a recheck', async () => {
  open({ blocked_reason: 'http_404', blocked_until: hours(-1), blocked_rechecks: 0 })
  const line = await screen.findByText(/冷却已结束/)
  expect(line.textContent).toContain('自动复查已用 0/8 次；这次复查不计入上限。')
  expect(line.textContent).not.toContain('下一次是第')
})

it.each(['http_404', 'http_405', 'http_308'])('says automatic rechecks are exhausted for a permanent %s block after 8 rechecks', async code => {
  open({ blocked_reason: code, blocked_until: null, blocked_rechecks: 8 })
  const line = await screen.findByText(/当前目标版本已阻断/)
  expect(line.textContent).toContain('自动投递已停止')
  expect(line.textContent).toContain('自动复查已用完（8 次，约 2 天），请核查目标后手动解除阻断')
  expect(line.textContent).not.toContain('自动复查已用 ')
  expect(line.textContent).not.toContain('自动重试')
  expect(screen.getByText('已阻断')).toBeTruthy()
  expect(screen.getByRole('button', { name: '解除阻断' })).toBeTruthy()
})

it.each([
  ['a route block awaiting its first recheck', { blocked_reason: 'http_404', blocked_until: null, blocked_rechecks: 0 }],
  ['an auth block', { blocked_reason: 'http_401', blocked_until: null, blocked_rechecks: 8 }],
  ['a Worker without the counter', { blocked_reason: 'http_404', blocked_until: hours(6) }],
])('shows no recheck count for %s', async (_name, endpoint) => {
  open(endpoint)
  const line = await screen.findByText(/当前目标版本已阻断/)
  expect(line.textContent).not.toContain('自动复查已用')
})

it('says the cooldown has ended instead of blocked once blocked_until has passed', async () => {
  open({ blocked_reason: 'http_404', blocked_until: hours(-24) })
  const line = await screen.findByText(/冷却已结束/)
  expect(line.textContent).toContain('目标返回 404（路径不存在）')
  expect(line.textContent).toContain('下一次投递时会自动复查')
  expect(line.textContent).not.toContain('将于')
  expect(screen.getByText('待复查')).toBeTruthy()
  expect(screen.queryByText('已阻断')).toBeNull()
  expect(screen.getByRole('button', { name: '解除阻断' })).toBeTruthy()
})

it.each([
  ['http_405', '目标返回 405（方法不被允许）'],
  ['http_302', '目标返回重定向'],
  ['http_401', '认证被拒绝，请轮换凭据后解除'],
  ['http_403', '认证被拒绝，请轮换凭据后解除'],
  ['credential_or_target_invalid', '凭据或目标地址无效'],
  ['target_policy_invalid', 'target_policy_invalid'],
])('shows %s readably without an automatic recheck time', async (code, text) => {
  open({ blocked_reason: code, blocked_until: null })
  const line = await screen.findByText(/当前目标版本已阻断/)
  expect(line.textContent).toContain(text)
  expect(line.textContent).toContain('自动投递已停止')
  expect(line.textContent).not.toContain('自动重试')
})

it.each(['retry_after_over_24h', 'retry_after_too_long'])('explains the %s pause written by the Worker', async reason => {
  open({ paused: true, paused_reason: reason })
  expect((await screen.findByText(/此目标已暂停/)).textContent).toContain('接收方要求等待超过 24 小时')
  expect(screen.queryByText(reason, { exact: false })).toBeNull()
})

it('offers unblock for a block reported only by the alert and hides it until a later check', async () => {
  open({}, [olderBlock(hours(-0.1))])
  const older = await screen.findByText(/无法从这里确定它们属于此目标的旧版本、其他目标还是已归档目标/)
  expect(older.textContent).toContain('实际解除的版本数')
  expect(screen.getByText('可用')).toBeTruthy()
  vi.mocked(api.unblockEndpoint).mockResolvedValue({ affected_revisions: 1, version: 5 })
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  await waitFor(() => expect(api.unblockEndpoint).toHaveBeenCalledWith('endpoint-1', { version: 4 }))
  await screen.findByText(/已解除此目标 1 个版本的阻断/)
  // The refetched overview still carries the alert stored before the unblock.
  await waitFor(() => expect(vi.mocked(api.overview).mock.calls.length).toBeGreaterThan(1))
  expect(screen.queryByText(/无法从这里确定/)).toBeNull()
  expect(screen.queryByRole('button', { name: '解除阻断' })).toBeNull()
})

it('shows the alert-only block again once a check after the unblock still reports it', async () => {
  open({}, [olderBlock(hours(-0.1))])
  await screen.findByText(/无法从这里确定/)
  vi.mocked(api.overview).mockResolvedValue({ alerts: { configured: false, configuration_error: false, active: [olderBlock(hours(1))], pending_notifications: 0, failed_notifications: 0 } })
  vi.mocked(api.unblockEndpoint).mockResolvedValue({ affected_revisions: 1, version: 5 })
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  await screen.findByText(/已解除此目标 1 个版本的阻断/)
  expect(await screen.findByText(/无法从这里确定/)).toBeTruthy()
})

it('does not claim success when this endpoint had no blocked revision', async () => {
  open({}, [olderBlock(hours(-0.1))])
  await screen.findByText(/无法从这里确定/)
  vi.mocked(api.unblockEndpoint).mockResolvedValue({ affected_revisions: 0, version: 5 })
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  const notice = await screen.findByText(/此目标没有被阻断的版本/)
  expect(notice.getAttribute('role')).toBe('status')
  expect(notice.textContent).toContain('其他或已归档的目标')
  expect(notice.textContent).toContain('投递记录')
  expect(screen.queryByText(/已解除/)).toBeNull()
  expect(screen.queryByText(/现在会重试/)).toBeNull()
})

it('reports a rejected unblock and reloads the endpoint so the next try uses the fresh version', async () => {
  open({ blocked_reason: 'http_401', blocked_until: null })
  await screen.findByText(/当前目标版本已阻断/)
  vi.mocked(api.unblockEndpoint).mockRejectedValueOnce(new ApiError(409, 'conflict', '状态已改变，请刷新后重试'))
  vi.mocked(api.endpoints).mockResolvedValue({ items: [{ ...base, blocked_reason: 'http_401', blocked_until: null, version: 6 }] })
  const loads = vi.mocked(api.endpoints).mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  expect((await screen.findByRole('alert')).textContent).toContain('状态已改变，请刷新后重试')
  expect(screen.queryByText(/已解除/)).toBeNull()
  await waitFor(() => expect(vi.mocked(api.endpoints).mock.calls.length).toBeGreaterThan(loads))
  vi.mocked(api.unblockEndpoint).mockResolvedValueOnce({ affected_revisions: 1, version: 7 })
  await waitFor(() => expect((screen.getByRole('button', { name: '解除阻断' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  await waitFor(() => expect(api.unblockEndpoint).toHaveBeenLastCalledWith('endpoint-1', { version: 6 }))
})

it('shows no unblock action for a healthy target', async () => {
  open({})
  await screen.findByText('可用')
  expect(screen.queryByRole('button', { name: '解除阻断' })).toBeNull()
})
