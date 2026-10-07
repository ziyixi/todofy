/**
 * 概览 (`/overview`): today at a glance (UTC day). Four numbers (处理, 已打标签, 待审, 拿不准); the flow of today's mail,
 * always drawn (with no mail, the skeleton at 0); the precision bound of each label that has verdicts against the
 * target; the model budget as a thin meter; and the latest error code, only when there is one.
 */
import type { AccuracyReport, ServiceStatus } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { api } from '../api.ts'
import { bar, card, emptyState, kpi, meter } from '../components.ts'
import { el, fill } from '../dom.ts'
import { flowGraph, sankeyChart } from '../flowchart.ts'
import { labelText, percent } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { allLabels, frame } from './common.ts'

/** Past this share of the budget the rest of the UTC day uses Clef-flash (../../docs/design.md §4.1). */
const FLASH_SHARE = 0.7

/** Each label with verdicts: its name, its precision bound as a bar (warn below the target), the bound and the count. */
function accuracy(report: AccuracyReport, labels: readonly Label[]): HTMLElement {
  const rows = report.labels.filter((row) => row.confirmedCount + row.correctedCount > 0)
  const body =
    rows.length === 0
      ? emptyState('还没有确认或纠正过的邮件')
      : el(
          'ul',
          { class: 'bars' },
          ...rows.map((row) => {
            const n = row.confirmedCount + row.correctedCount
            const below = row.precisionLowerBound < report.precisionTarget
            return el(
              'li',
              { 'aria-label': `${labelText(row.label, labels)}：精确率下界 ${percent(row.precisionLowerBound)}，${String(n)} 封` },
              el('span', { class: 'name' }, labelText(row.label, labels)),
              bar(row.precisionLowerBound, below ? 'warn' : ''),
              el('span', { class: 'figures' }, `${percent(row.precisionLowerBound)} · ${String(n)}`),
            )
          }),
        )
  return card('准确率', `目标 ${percent(report.precisionTarget)}`, body)
}

/** Today's estimated neurons against the budget, with what it means when it is high. */
function budget(status: ServiceStatus): HTMLElement {
  const used = status.neuronsToday
  const max = status.dailyNeuronBudget
  const share = max <= 0 ? 0 : used / max
  const tone = status.aiQuotaExhausted || share >= 1 ? 'danger' : share >= FLASH_SHARE ? 'warn' : ''
  const note = status.aiQuotaExhausted
    ? '今天的额度用完了，剩下的明天处理'
    : status.decisionModel === 'clef-flash'
      ? '已过 70%，今天改用 Clef-flash'
      : ''
  const waiting = status.deferredCount > 0 ? `${String(status.deferredCount)} 封等明天的额度` : ''
  return card(
    '模型额度',
    `${String(Math.round(used))} / ${String(max)}`,
    meter(used, max, '今天的模型额度', tone),
    note === '' && waiting === '' ? null : el('p', { class: 'hint' }, [note, waiting].filter((text) => text !== '').join('；')),
  )
}

export async function renderOverview(ctx: ViewContext): Promise<void> {
  await frame(ctx.main, '概览', async (body) => {
    const [status, flow, labels, report] = await Promise.all([ctx.status(), api.getMailFlow({ name: 'mailFlows/today' }), allLabels(), api.getAccuracyReport({ name: 'accuracyReport' })])
    const graph = flowGraph(flow.counts, labels)
    const latest = status.recentErrorCodes[0]
    fill(
      body,
      el(
        'div',
        { class: 'kpis' },
        kpi('处理', status.decidedTodayCount),
        kpi('已打标签', status.appliedTodayCount),
        kpi('待审', status.reviewCount, status.reviewCount > 0),
        kpi('拿不准', status.unsureTodayCount),
      ),
      card('今天的流程', graph.total === 0 ? '' : `共 ${String(graph.total)} 封`, sankeyChart(graph), graph.total === 0 ? el('p', { class: 'hint' }, '今天还没有邮件') : null),
      el('div', { class: 'two' }, accuracy(report, labels), budget(status)),
      latest === undefined ? null : el('p', { class: 'notice', role: 'note' }, `最近错误：${latest}`),
    )
  })
}
