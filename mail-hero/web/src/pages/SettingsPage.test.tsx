// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { create, type MessageInitShape } from '@ziyixi/proto/protobuf'
import { Code } from '@ziyixi/proto/rpc-status'
import { PreviewRetentionPolicyResponseSchema } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { ReceiveMode } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { ActiveAlert_Severity, ActiveAlertSchema } from '@ziyixi/proto/mailhero/ui/v2/settings_pb'
import { timestamp } from '../api/client'
import { installFakeServer, rpcError, type FakeServer } from '../test/fakeServer'
import { overview, renderAt, settings } from '../test/fixtures'
import SettingsPage from './SettingsPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const POLICY_PATHS = ['raw_retention_days', 'content_retention_days', 'ledger_retention_days', 'resolved_retention_days', 'etag']

async function open(alerts: MessageInitShape<typeof ActiveAlertSchema>[] = [], resolved: number | null = 60): Promise<FakeServer> {
  const fake = installFakeServer({ settings: settings({ mode: ReceiveMode.ARCHIVE, resolvedRetentionDays: resolved ?? undefined }),
    overview: overview({ logicalBytes: 100, logicalLimitBytes: 1000, pendingPhysicalDeleteBytes: 50, activeAlerts: alerts.map(alert => create(ActiveAlertSchema, alert)) }) })
  renderAt(<SettingsPage/>, '/settings')
  await screen.findByText('分阶段保留')
  return fake
}
/** Answers the preview with this policy and counts, and the confirmation token `signed-preview`. */
function previews(fake: FakeServer, fields: MessageInitShape<typeof PreviewRetentionPolicyResponseSchema>) {
  fake.answer.previewRetentionPolicy = async request => create(PreviewRetentionPolicyResponseSchema, { etag: '1', rawRetentionDays: request.rawRetentionDays,
    contentRetentionDays: request.contentRetentionDays, ledgerRetentionDays: request.ledgerRetentionDays, resolvedRetentionDays: request.resolvedRetentionDays,
    applyExisting: request.applyExisting, confirmationToken: 'signed-preview', expireTime: timestamp('2026-09-26T20:00:00Z'), ...fields })
}
const resolvedField = () => screen.getByRole('spinbutton', { name: /^已处理异常邮件保留天数/ }) as HTMLInputElement
const contentField = () => screen.getByRole('spinbutton', { name: /^正文与附件保留天数/ }) as HTMLInputElement
const save = () => fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

it('reports logical storage separately and never invents actual R2 usage', async () => {
  await open()
  expect(screen.getByText('未测量')).toBeTruthy()
  expect(screen.getByText('未测量，需在 Cloudflare 查看')).toBeTruthy()
  expect(screen.getByText(/最小去重账本至少保留 180 天；当前不会自动删除账本/)).toBeTruthy()
  expect((screen.getByRole('checkbox', { name: /将尚无保留策略的历史邮件纳入/ }) as HTMLInputElement).checked).toBe(false)
})

it('saves a change outside the policy at once, with only its field and the etag in the mask', async () => {
  const fake = await open()
  fireEvent.click(screen.getByRole('checkbox', { name: /暂停所有未开始的投递/ }))
  save()
  await screen.findByText(/设置已保存。/)
  expect(fake.callsOf('previewRetentionPolicy')).toEqual([])
  expect(fake.callsOf('updateSettings')[0]).toMatchObject({ settings: { name: 'settings', etag: '1', sendPaused: true }, updateMask: { paths: ['send_paused', 'etag'] }, retentionConfirmation: '' })
  expect(fake.state.settings.sendPaused).toBe(true)
})

it('historical enrollment requires reviewing the preview before saving', async () => {
  const fake = await open()
  previews(fake, { historicalMessageCount: 3, safeTerminalMessageCount: 2 })
  fireEvent.click(screen.getByRole('checkbox', { name: /将尚无保留策略的历史邮件纳入/ }))
  save()
  await screen.findByText('确认分阶段保留策略？')
  expect(fake.callsOf('previewRetentionPolicy')).toEqual([expect.objectContaining({ name: 'settings', rawRetentionDays: 7, contentRetentionDays: 30, ledgerRetentionDays: 180, resolvedRetentionDays: 60, applyExisting: true })])
  expect(fake.callsOf('updateSettings')).toEqual([])
  const history = screen.getByText('0 字节').closest('p')!
  // Enrollment also puts historical owner-resolved exceptions on the resolved clock.
  expect(history.textContent).toContain('投递失败后已由你处理（重发已送达或已取消）的历史邮件也会纳入已处理异常邮件保留期：从确认后首次后台检查起计时，60 天后清理全部内容')
  expect(history.textContent).toContain('上面的已处理数量可能未包含它们')
  fireEvent.click(screen.getByRole('button', { name: '确认并保存' }))
  await waitFor(() => expect(fake.callsOf('updateSettings')).toHaveLength(1))
  expect(fake.callsOf('updateSettings')[0]).toMatchObject({ settings: { etag: '1' }, updateMask: { paths: POLICY_PATHS }, applyExisting: true, retentionConfirmation: 'signed-preview' })
})

it('names the delivery-stop alerts and links endpoint alerts to the targets page', async () => {
  await open([
    { code: 'endpoint_blocked', severity: ActiveAlert_Severity.CRITICAL, metrics: { waiting_deliveries: 2, current_blocked: 1, auto_recheck: 1 } },
    { code: 'delivery_failed', severity: ActiveAlert_Severity.WARNING, metrics: { count: 1 } },
    { code: 'endpoint_paused', severity: ActiveAlert_Severity.WARNING, metrics: { waiting_deliveries: 2 } },
    { code: 'policy_error', severity: ActiveAlert_Severity.WARNING, metrics: { count: 1 } },
  ])
  const blocked = await screen.findByText('投递目标被阻断，自动投递已停止')
  expect(blocked.closest('p')?.querySelector('a')?.getAttribute('href')).toBe('/endpoints')
  expect(screen.getByText('投递目标已暂停')).toBeTruthy()
  expect(screen.getByText('有投递已停止，需要处理').closest('p')?.querySelector('a')).toBeNull()
  expect(screen.getByText('有邮件因策略读取失败只归档、未转发')).toBeTruthy()
  expect(screen.getByText(/投递目标被阻断或暂停、投递已停止，以及策略读取失败只归档未转发/)).toBeTruthy()
})

it('shows the resolved-exception period and says unresolved failures are never cleaned', async () => {
  await open()
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
  expect(summary.textContent).not.toContain('待处理、失败、需人工检查或正在处理的邮件不会自动清理')
  expect(screen.getByRole('button', { name: '保存设置' }).hasAttribute('disabled')).toBe(true)
})

it('rejects a resolved period shorter than the content period before any preview', async () => {
  const fake = await open()
  fireEvent.change(resolvedField(), { target: { value: '20' } })
  save()
  expect((await screen.findByRole('alert')).textContent).toBe('已处理异常邮件的保留期不能短于正文保留期。')
  expect(fake.callsOf('previewRetentionPolicy')).toEqual([])
  // Content kept forever: like the Worker, a resolved period is rejected; only an empty one is allowed.
  fireEvent.change(contentField(), { target: { value: '' } })
  fireEvent.change(resolvedField(), { target: { value: '10' } })
  save()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('正文不自动清理时，已处理异常邮件保留天数也须留空。'))
  expect(fake.callsOf('previewRetentionPolicy')).toEqual([])
  fireEvent.change(resolvedField(), { target: { value: '' } })
  previews(fake, {})
  save()
  await screen.findByText('确认分阶段保留策略？')
  expect(fake.callsOf('previewRetentionPolicy')).toHaveLength(1)
  // A period kept forever is unset (proto3 optional), never zero.
  const [request] = fake.callsOf('previewRetentionPolicy')
  expect(request).toMatchObject({ rawRetentionDays: 7, ledgerRetentionDays: 180, applyExisting: false })
  expect([request['contentRetentionDays'], request['resolvedRetentionDays']]).toEqual([undefined, undefined])
  expect(fake.callsOf('updateSettings')).toEqual([])
})

it('enabling the resolved period previews its effect on stored resolved mail and saves with the token', async () => {
  const fake = await open([], null)
  expect(resolvedField().value).toBe('')
  fireEvent.change(resolvedField(), { target: { value: '90' } })
  previews(fake, { resolvedMessageCount: 12 })
  save()
  await screen.findByText('确认分阶段保留策略？')
  expect(fake.callsOf('previewRetentionPolicy')[0]).toMatchObject({ rawRetentionDays: 7, contentRetentionDays: 30, ledgerRetentionDays: 180, resolvedRetentionDays: 90, applyExisting: false })
  const line = screen.getByText(/已处理异常邮件：最后一次处理后 90 天清理全部内容/)
  expect(line.querySelector('strong')?.textContent).toBe('12')
  expect(line.textContent).toContain('不按邮件冻结')
  expect(line.textContent).toContain('已超过 90 天（邮件自身冻结的正文期限更长时按更长者）的会在之后的后台清理中逐批删除')
  expect(line.textContent).toContain('仍有未处理的失败交付（之后没有新建并送达的交付，也未被你取消）的邮件和待处理的邮件不会被清理')
  expect(line.textContent).not.toContain('此项未改变')
  expect(fake.callsOf('updateSettings')).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: '确认并保存' }))
  await waitFor(() => expect(fake.callsOf('updateSettings')).toHaveLength(1))
  expect(fake.callsOf('updateSettings')[0]).toMatchObject({ settings: { etag: '1', resolvedRetentionDays: 90, contentRetentionDays: 30 }, updateMask: { paths: POLICY_PATHS },
    applyExisting: false, retentionConfirmation: 'signed-preview' })
  expect(fake.state.settings.resolvedRetentionDays).toBe(90)
})

it('disabling the resolved period says stored resolved mail is no longer cleaned', async () => {
  const fake = await open()
  fireEvent.change(resolvedField(), { target: { value: '' } })
  previews(fake, { resolvedMessageCount: 3 })
  save()
  await screen.findByText('确认分阶段保留策略？')
  expect(fake.callsOf('previewRetentionPolicy')[0]['resolvedRetentionDays']).toBeUndefined()
  const line = screen.getByText(/已处理异常邮件：不自动清理/)
  expect(line.textContent).toContain('保存后它们不再自动清理')
  expect(line.textContent).not.toContain('删除')
})

it('historical enrollment with the resolved period disabled does not promise resolved cleanup', async () => {
  const fake = await open([], null)
  previews(fake, { historicalMessageCount: 3, safeTerminalMessageCount: 2 })
  fireEvent.click(screen.getByRole('checkbox', { name: /将尚无保留策略的历史邮件纳入/ }))
  save()
  await screen.findByText('确认分阶段保留策略？')
  const history = screen.getByText('0 字节').closest('p')!
  expect(history.textContent).toContain('将为 3 封尚无策略的历史邮件设置此策略')
  expect(history.textContent).not.toContain('已处理异常邮件保留期')
  expect(screen.getByText(/已处理异常邮件：不自动清理/).textContent).toContain('此项未改变')
})

it('says the resolved period is unchanged when only the content period changes', async () => {
  const fake = await open()
  fireEvent.change(contentField(), { target: { value: '40' } })
  previews(fake, { resolvedMessageCount: 7 })
  save()
  await screen.findByText('确认分阶段保留策略？')
  expect(fake.callsOf('previewRetentionPolicy')[0]).toMatchObject({ rawRetentionDays: 7, contentRetentionDays: 40, ledgerRetentionDays: 180, resolvedRetentionDays: 60, applyExisting: false })
  const line = screen.getByText(/已处理异常邮件：最后一次处理后 60 天清理全部内容/)
  expect(line.querySelector('strong')?.textContent).toBe('7')
  expect(line.textContent).toContain('此项未改变。')
  expect(line.textContent).not.toContain('重新计算')
  expect(line.textContent).not.toContain('不再自动清理')
  expect(screen.getByText(/新邮件：原件 7 天；正文与附件 40 天/)).toBeTruthy()
})

it('lengthening the resolved period explains the re-timing', async () => {
  const fake = await open()
  fireEvent.change(resolvedField(), { target: { value: '120' } })
  previews(fake, {})
  save()
  await screen.findByText('确认分阶段保留策略？')
  const line = screen.getByText(/已处理异常邮件：最后一次处理后 120 天清理全部内容/)
  expect(line.textContent).toContain('保存后按最后一次处理时间重新计算（不早于系统首次确认其已处理的时间），已超过 120 天（邮件自身冻结的正文期限更长时按更长者）的会在之后的后台清理中逐批删除原件、正文、附件与事件内容。')
  expect(line.textContent).not.toContain('此项未改变')
  fireEvent.click(screen.getByRole('button', { name: '确认并保存' }))
  await waitFor(() => expect(fake.callsOf('updateSettings')[0]).toMatchObject({ settings: { etag: '1', resolvedRetentionDays: 120 }, retentionConfirmation: 'signed-preview' }))
})

it('shows the refusal of a stale confirmation in the dialog', async () => {
  const fake = await open()
  fireEvent.change(contentField(), { target: { value: '40' } })
  previews(fake, {})
  save()
  await screen.findByText('确认分阶段保留策略？')
  fake.fail.updateSettings = rpcError(Code.FAILED_PRECONDITION, 'RETENTION_CONFIRMATION_REQUIRED')
  fireEvent.click(screen.getByRole('button', { name: '确认并保存' }))
  // Shown on the page and in the still-open dialog.
  await waitFor(() => expect(screen.getAllByText('服务端拒绝：RETENTION_CONFIRMATION_REQUIRED')).toHaveLength(2))
  expect(screen.getByText('确认分阶段保留策略？')).toBeTruthy()
})
