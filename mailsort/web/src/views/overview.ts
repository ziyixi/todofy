/**
 * 概览 (`/overview`): today at a glance (UTC day). Four numbers (处理, 已打标签, 待审, 拿不准); the flow of today's mail,
 * always drawn (with no mail, the skeleton at 0; on a phone it starts at its right end, where the mail went); the label
 * report of the last 7 days (each label's automatic labels, corrections and uncertain mail); and the model budget as a
 * thin meter.
 */
import type { LabelReport, ServiceStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { api } from '../api.ts'
import { card, emptyState, kpi, meter } from '../components.ts'
import { el, fill } from '../dom.ts'
import { flowGraph, sankeyChart } from '../flowchart.ts'
import { labelText } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { allLabels, frame } from './common.ts'

/** Past this share of the budget the rest of the UTC day uses Clef-flash (../../docs/design.md §4.1). */
const FLASH_SHARE = 0.7

/** Each label with mail in the last 7 days: automatic labels, the owner's corrections, and uncertain mail. */
function report(answer: LabelReport, labels: readonly Label[]): HTMLElement {
  const rows = answer.labels.filter((row) => row.autoCount + row.unsureCount > 0)
  const body =
    rows.length === 0
      ? emptyState('最近 7 天还没有邮件')
      : el(
          'ul',
          { class: 'bars' },
          ...rows.map((row) => {
            const corrected = row.gmailCorrectionCount + row.reviewCorrectionCount
            const text = `自动 ${String(row.autoCount)} · 改 ${String(corrected)} · 拿不准 ${String(row.unsureCount)}`
            return el('li', { 'aria-label': `${labelText(row.label, labels)}：${text}` }, el('span', { class: 'name' }, labelText(row.label, labels)), el('span', { class: 'figures' }, text))
          }),
        )
  return card('最近 7 天', `共 ${String(answer.decidedCount)} 封`, body)
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
    const [status, flow, labels, week] = await Promise.all([ctx.status(), api.getMailFlow({ name: 'mailFlows/today' }), allLabels(), api.getLabelReport({ name: 'labelReport' })])
    const graph = flowGraph(flow.counts, labels)
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
      el('div', { class: 'two' }, report(week, labels), budget(status)),
    )
    // Where the diagram is wider than its box (a phone), it starts at its right end: the labels, 拿不准, 影子建议.
    const scroll = body.querySelector('.flow-scroll')
    if (scroll !== null && scroll.scrollWidth > scroll.clientWidth) scroll.scrollLeft = scroll.scrollWidth
  })
}
