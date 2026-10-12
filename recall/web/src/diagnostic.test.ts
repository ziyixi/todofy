import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { CaptureDiagnosticSchema } from '@ziyixi/proto/recall/ingest/v1/diagnostic_pb'
import { CaptureDiagnosticReportSchema, DeviceStatusSchema } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { captureDiagnosticCard } from './views/diagnostic.ts'

it('shows a received pending-stage report without treating it as capture success', () => {
  const now = Date.UTC(2026, 9, 12)
  const diagnostic = create(CaptureDiagnosticSchema, {
    runId: '00000000-0000-4000-8000-0000000000dd',
    startTime: timestampFromMs(now - 60_000), reportTime: timestampFromMs(now),
    steps: [{ stage: 'active_tabs', state: 'pending', initiallyPending: true }, {
      stage: 'probe_context', state: 'returned', visibility: 'visible', storedVisibility: 'hidden', senderIdentity: 'missing',
    }], tabEventCount: 2, alarmEventCount: 1,
  })
  const report = create(CaptureDiagnosticReportSchema, { deviceId: 'phone', receiveTime: timestampFromMs(now), diagnostic })
  const device = create(DeviceStatusSchema, { deviceId: 'phone', label: 'Synthetic phone' })
  const card = captureDiagnosticCard(report, [device], now)
  expect(card?.textContent).toContain('Synthetic phone')
  expect(card?.textContent).toContain('不代表采集成功')
  expect(card?.textContent).toContain('读取活动标签 · 诊断开始时已有调用尚未返回')
  expect(card?.textContent).not.toContain('匹配 0 个')
  expect(card?.textContent).toContain('页面 可见 · 记忆状态 不可见 · 消息身份 未提供')
  expect(card?.querySelector('details')?.open).toBe(false)
  expect(captureDiagnosticCard(undefined, [], now)).toBeNull()
})
