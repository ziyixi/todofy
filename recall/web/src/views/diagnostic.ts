/** The owner's latest one-shot report; no extra request, live polling or browsing data. */
import { CaptureDiagnosticStepSchema } from '@ziyixi/proto/recall/ingest/v1/diagnostic_pb'
import type { CaptureDiagnosticReport, DeviceStatus } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { toWire } from '@ziyixi/proto/wire-json'
import { diagnosticStepSummary } from '../../../shared/diagnostic.ts'
import { card, disclosure } from '../components.ts'
import { el } from '../dom.ts'
import { ago, ms } from '../format.ts'

export function captureDiagnosticCard(report: CaptureDiagnosticReport | undefined, devices: readonly DeviceStatus[], now: number): HTMLElement | null {
  const diagnostic = report?.diagnostic
  if (report === undefined || diagnostic === undefined) return null
  const received = ms(report.receiveTime)
  const device = devices.find((item) => item.deviceId === report.deviceId)
  return card('采集诊断', received === null ? '' : `${ago(received, now)}收到`,
    el('p', {}, device?.label ?? '设备名称未提供'),
    el('p', { class: 'meta mono' }, `编号 ${diagnostic.runId}`),
    el('p', { class: 'hint' }, '这是一次性诊断的回执，不代表采集成功。只保留最近一次结果。'),
    disclosure('查看阶段结果',
      el('p', { class: 'facts' }, `页面事件 ${String(diagnostic.tabEventCount)} · 分钟检查 ${String(diagnostic.alarmEventCount)}`),
      el('ul', { class: 'rows' }, ...diagnostic.steps.map((step) =>
        el('li', {}, diagnosticStepSummary(toWire(CaptureDiagnosticStepSchema, step))),
      )),
    ),
  )
}
