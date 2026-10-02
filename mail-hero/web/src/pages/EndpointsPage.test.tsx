// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { create, type MessageInitShape } from '@ziyixi/proto/protobuf'
import { Code } from '@ziyixi/proto/rpc-status'
import { Endpoint_AuthType, type EndpointSchema } from '@ziyixi/proto/mailhero/ui/v2/endpoint_pb'
import { UnblockEndpointResponseSchema } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { ActiveAlert_Severity, ActiveAlertSchema, type ActiveAlert } from '@ziyixi/proto/mailhero/ui/v2/settings_pb'
import { timestamp } from '../api/client'
import { formatDate } from '../components/UI'
import { installFakeServer, rpcError, type FakeServer } from '../test/fakeServer'
import { endpoint, ENDPOINT_ID, overview, renderAt, settings } from '../test/fixtures'
import EndpointsPage from './EndpointsPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const NAME = `endpoints/${ENDPOINT_ID}`
const hours = (count: number) => new Date(Date.now() + count * 3_600_000).toISOString()
const olderBlock = (lastSeen: string): ActiveAlert => create(ActiveAlertSchema, { code: 'endpoint_blocked', severity: ActiveAlert_Severity.CRITICAL,
  metrics: { waiting_deliveries: 3, current_blocked: 0, auto_recheck: 0 }, lastSeenTime: timestamp(lastSeen) })

function open(fields: MessageInitShape<typeof EndpointSchema>, active: ActiveAlert[] = []): FakeServer {
  const fake = installFakeServer({ endpoints: [endpoint(fields)], settings: settings({ currentEndpoint: NAME }), overview: overview({ activeAlerts: active }) })
  renderAt(<EndpointsPage/>, '/endpoints')
  return fake
}
/** Answers UnblockEndpoint with this many unblocked revisions (and the next etag). */
function unblocks(fake: FakeServer, count: number, etag = '5') {
  fake.answer.unblockEndpoint = async () => create(UnblockEndpointResponseSchema, { endpoint: endpoint({ etag }), affectedRevisionCount: count })
}

it('sends a connection test after the warning and names the delivery it made', async () => {
  const fake = open({})
  fireEvent.click(await screen.findByRole('button', { name: /发送测试事件/ }))
  fireEvent.click(await screen.findByRole('button', { name: '确认发送' }))
  await waitFor(() => expect(fake.callsOf('testEndpoint')).toHaveLength(1))
  expect(fake.callsOf('testEndpoint')[0]).toMatchObject({ name: NAME })
  expect(fake.callsOf('testEndpoint')[0]['requestId']).toMatch(/^[0-9a-f-]{36}$/)
  expect((await screen.findByText(/测试事件已创建/)).textContent).toContain('test-event')
})

it('explains a route block with its automatic recheck and unblocks every revision with the endpoint etag', async () => {
  const until = hours(6)
  const fake = open({ blockedReason: 'http_404', blockExpireTime: timestamp(until), blockedRecheckCount: 3 })
  const line = await screen.findByText(/目标返回 404（路径不存在）/)
  expect(screen.getByText(`将于 ${formatDate(until)} 自动重试`, { exact: false })).toBeTruthy()
  // Three armed rechecks: two performed, the third is the scheduled one.
  expect(line.textContent).toContain('自动复查已用 2/8 次，下一次是第 3 次。')
  expect(line.textContent).not.toContain('最后一次')
  expect(screen.getByText('已阻断')).toBeTruthy()
  unblocks(fake, 2)
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  await waitFor(() => expect(fake.callsOf('unblockEndpoint')).toHaveLength(1))
  expect(fake.callsOf('unblockEndpoint')[0]).toMatchObject({ name: NAME, etag: '4' })
  const notice = await screen.findByText(/已解除此目标 2 个版本的阻断/)
  expect(notice.getAttribute('role')).toBe('status')
  for (const text of ['现在会重试', '超过 7 天', '手动重试', '约 10 分钟', '自动复查次数已重新计数']) expect(notice.textContent).toContain(text)
})

it('does not count the first scheduled recheck as used', async () => {
  open({ blockedReason: 'http_404', blockExpireTime: timestamp(hours(6)), blockedRecheckCount: 1 })
  expect((await screen.findByText(/当前目标版本已阻断/)).textContent).toContain('自动复查已用 0/8 次，下一次是第 1 次。')
})

it('names the eighth recheck as the last automatic one', async () => {
  open({ blockedReason: 'http_302', blockExpireTime: timestamp(hours(6)), blockedRecheckCount: 8 })
  const line = await screen.findByText(/当前目标版本已阻断/)
  expect(line.textContent).toContain('自动复查已用 7/8 次，下一次是最后一次；仍返回同类错误时将保持阻断，直到你手动解除。')
  expect(line.textContent).not.toContain('8/8')
  expect(line.textContent).not.toContain('已用完')
})

it('counts the recheck on a cooled block too', async () => {
  open({ blockedReason: 'http_405', blockExpireTime: timestamp(hours(-1)), blockedRecheckCount: 2 })
  expect((await screen.findByText(/冷却已结束/)).textContent).toContain('自动复查已用 1/8 次，下一次是第 2 次。')
})

it('says an uncounted cooldown from an older block does not use up a recheck', async () => {
  open({ blockedReason: 'http_404', blockExpireTime: timestamp(hours(-1)) })
  const line = await screen.findByText(/冷却已结束/)
  expect(line.textContent).toContain('自动复查已用 0/8 次；这次复查不计入上限。')
  expect(line.textContent).not.toContain('下一次是第')
})

it.each(['http_404', 'http_405', 'http_308'])('says automatic rechecks are exhausted for a permanent %s block after 8 rechecks', async code => {
  open({ blockedReason: code, blockedRecheckCount: 8 })
  const line = await screen.findByText(/当前目标版本已阻断/)
  expect(line.textContent).toContain('自动投递已停止')
  expect(line.textContent).toContain('自动复查已用完（8 次，约 2 天），请核查目标后手动解除阻断')
  expect(line.textContent).not.toContain('自动复查已用 ')
  expect(line.textContent).not.toContain('自动重试')
  expect(screen.getByText('已阻断')).toBeTruthy()
  expect(screen.getByRole('button', { name: '解除阻断' })).toBeTruthy()
})

it.each([
  ['a route block awaiting its first recheck', { blockedReason: 'http_404' }],
  ['an auth block', { blockedReason: 'http_401', blockedRecheckCount: 8 }],
])('shows no recheck count for %s', async (_name, fields) => {
  open(fields)
  expect((await screen.findByText(/当前目标版本已阻断/)).textContent).not.toContain('自动复查已用')
})

it('says the cooldown has ended instead of blocked once the block has expired', async () => {
  open({ blockedReason: 'http_404', blockExpireTime: timestamp(hours(-24)) })
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
  open({ blockedReason: code })
  const line = await screen.findByText(/当前目标版本已阻断/)
  expect(line.textContent).toContain(text)
  expect(line.textContent).toContain('自动投递已停止')
  expect(line.textContent).not.toContain('自动重试')
})

it.each(['retry_after_over_24h', 'retry_after_too_long'])('explains the %s pause written by the Worker', async reason => {
  open({ paused: true, pausedReason: reason })
  expect((await screen.findByText(/此目标已暂停/)).textContent).toContain('接收方要求等待超过 24 小时')
  expect(screen.queryByText(reason, { exact: false })).toBeNull()
})

it('offers unblock for a block reported only by the alert and hides it until a later check', async () => {
  const fake = open({}, [olderBlock(hours(-0.1))])
  const older = await screen.findByText(/无法从这里确定它们属于此目标的旧版本、其他目标还是已归档目标/)
  expect(older.textContent).toContain('实际解除的版本数')
  expect(screen.getByText('可用')).toBeTruthy()
  unblocks(fake, 1)
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  await screen.findByText(/已解除此目标 1 个版本的阻断/)
  // The refetched overview still carries the alert stored before the unblock.
  await waitFor(() => expect(fake.callsOf('getOverview').length).toBeGreaterThan(1))
  expect(screen.queryByText(/无法从这里确定/)).toBeNull()
  expect(screen.queryByRole('button', { name: '解除阻断' })).toBeNull()
})

it('shows the alert-only block again once a check after the unblock still reports it', async () => {
  const fake = open({}, [olderBlock(hours(-0.1))])
  await screen.findByText(/无法从这里确定/)
  fake.state.overview = overview({ activeAlerts: [olderBlock(hours(1))] })
  unblocks(fake, 1)
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  await screen.findByText(/已解除此目标 1 个版本的阻断/)
  expect(await screen.findByText(/无法从这里确定/)).toBeTruthy()
})

it('does not claim success when this endpoint had no blocked revision', async () => {
  const fake = open({}, [olderBlock(hours(-0.1))])
  await screen.findByText(/无法从这里确定/)
  unblocks(fake, 0)
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  const notice = await screen.findByText(/此目标没有被阻断的版本/)
  expect(notice.getAttribute('role')).toBe('status')
  expect(notice.textContent).toContain('其他或已归档的目标')
  expect(notice.textContent).toContain('投递记录')
  expect(screen.queryByText(/已解除/)).toBeNull()
  expect(screen.queryByText(/现在会重试/)).toBeNull()
})

it('reports a rejected unblock and reloads the endpoint so the next try uses the fresh etag', async () => {
  const fake = open({ blockedReason: 'http_401' })
  await screen.findByText(/当前目标版本已阻断/)
  fake.fail.unblockEndpoint = rpcError(Code.ABORTED, 'ETAG_MISMATCH')
  fake.state.endpoints = [endpoint({ blockedReason: 'http_401', etag: '6' })]
  const loads = fake.callsOf('listEndpoints').length
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  expect((await screen.findByRole('alert')).textContent).toContain('ETAG_MISMATCH')
  expect(screen.queryByText(/已解除/)).toBeNull()
  await waitFor(() => expect(fake.callsOf('listEndpoints').length).toBeGreaterThan(loads))
  delete fake.fail.unblockEndpoint
  unblocks(fake, 1, '7')
  await waitFor(() => expect((screen.getByRole('button', { name: '解除阻断' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '解除阻断' }))
  await waitFor(() => expect(fake.callsOf('unblockEndpoint').at(-1)).toMatchObject({ name: NAME, etag: '6' }))
})

it('creates with a request ID and edits with the masked fields and the etag', async () => {
  const fake = open({})
  await screen.findByText('可用')
  fireEvent.click(screen.getByRole('button', { name: '编辑目标' }))
  const label = await screen.findByDisplayValue('Synthetic consumer')
  fireEvent.change(label, { target: { value: 'Renamed consumer' } })
  fireEvent.submit(label.closest('form')!)
  await waitFor(() => expect(fake.callsOf('updateEndpoint')).toHaveLength(1))
  expect(fake.callsOf('updateEndpoint')[0]).toMatchObject({ endpoint: { name: NAME, etag: '4', displayName: 'Renamed consumer', authType: Endpoint_AuthType.BEARER },
    updateMask: { paths: ['display_name', 'uri', 'auth_type', 'rate_per_minute', 'timeout_seconds', 'etag'] } })
  // The credential is never echoed back into the form.
  expect((fake.callsOf('updateEndpoint')[0]['endpoint'] as { credential: string }).credential).toBe('')
})

it('shows no unblock action for a healthy target', async () => {
  open({})
  await screen.findByText('可用')
  expect(screen.queryByRole('button', { name: '解除阻断' })).toBeNull()
})
