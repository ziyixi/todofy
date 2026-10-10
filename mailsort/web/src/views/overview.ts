/**
 * 概览 (`/overview`): what the model did, at a glance. One status line (what the mode in force does, the last sync, the
 * mail still waiting); four numbers for today, each with its last 7 days under it (处理, 有把握, 都不是, 拿不准); the
 * flow of today's mail, always drawn (with no mail, the skeleton at 0; on a phone it starts at its right end, where
 * the mail went); the table of the last 7 days per label (自动, 改正, 拿不准); and the model budget as a thin meter.
 * Days are UTC days, as the Worker counts them.
 */
import { MailFlow_Outcome, MailFlow_Stage, type MailFlow_Count } from '@ziyixi/proto/mailsort/ui/v2/flow_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { Mode, ServiceStatus_AuthState, type LabelReport, type ServiceStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { api } from '../api.ts'
import { card, emptyState, kpi, meter } from '../components.ts'
import { el, fill } from '../dom.ts'
import { flowGraph, sankeyChart } from '../flowchart.ts'
import { labelText, MODE_HINTS, MODE_NAMES, relative } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { allLabels, frame } from './common.ts'

/** Past this share of the budget the rest of the UTC day uses Clef-flash (../../docs/design.md §4.1). */
const FLASH_SHARE = 0.7

/** One period's decided mail by what became of it. */
export interface Tally {
  readonly decided: number
  readonly confident: number
  readonly none: number
  readonly unsure: number
}

const LABELLED: ReadonlySet<MailFlow_Outcome> = new Set([MailFlow_Outcome.ARCHIVED, MailFlow_Outcome.KEPT_IN_INBOX, MailFlow_Outcome.SUGGESTED])
const UNSURE: ReadonlySet<MailFlow_Outcome> = new Set([MailFlow_Outcome.UNSURE, MailFlow_Outcome.UNSURE_SHOWN])

/** Today's tally from the flow's counters (the diagram's own numbers: skips, deferrals and corrections are not decisions). */
export function tallyOf(counts: readonly MailFlow_Count[]): Tally {
  let confident = 0
  let none = 0
  let unsure = 0
  for (const count of counts) {
    if (count.stage === MailFlow_Stage.SKIPPED || count.stage === MailFlow_Stage.DEFERRED) continue
    if (LABELLED.has(count.outcome)) confident += count.mailCount
    else if (count.outcome === MailFlow_Outcome.NO_LABEL) none += count.mailCount
    else if (UNSURE.has(count.outcome)) unsure += count.mailCount
  }
  return { decided: confident + none + unsure, confident, none, unsure }
}

/** The status line: what the mode in force does, the last sync, and mail still waiting. */
function statusLine(status: ServiceStatus, now: number): HTMLElement {
  const mode = status.effectiveMode
  // Live with a read-only grant writes nothing: said instead of what live would do.
  const does = mode === Mode.LIVE && status.authState === ServiceStatus_AuthState.OK && !status.writeScope ? 'Gmail 只读授权，还不会写入' : (MODE_HINTS[mode] ?? '')
  const parts = [
    `${MODE_NAMES[mode] ?? '—'}：${does}`,
    status.lastSyncTime === undefined ? '' : `上次同步 ${relative(status.lastSyncTime, now)}`,
    status.pendingCount > 0 ? `${String(status.pendingCount)} 封待判断` : '',
  ]
  return el('p', { class: 'hint lead' }, parts.filter((part) => part !== '').join(' · '))
}

/**
 * Each label with mail in the last 7 days: its automatic labels, the owner's corrections, and uncertain mail. Mail that
 * got no label (都不是, or uncertain with 都不是 most likely) is in the numbers above, not here, so the empty line says
 * which is empty: no mail at all, or none on a label.
 */
function labelTable(answer: LabelReport, labels: readonly Label[]): HTMLElement {
  const rows = answer.labels
    .map((row) => ({ name: labelText(row.label, labels), auto: row.autoCount, corrected: row.gmailCorrectionCount + row.reviewCorrectionCount, unsure: row.unsureCount }))
    .filter((row) => row.auto + row.corrected + row.unsure > 0)
  const cell = (n: number) => el('td', {}, String(n))
  return card(
    '各标签 · 最近 7 天',
    '',
    rows.length === 0
      ? emptyState(answer.decidedCount === 0 ? '最近 7 天还没有邮件' : '最近 7 天还没有邮件归到标签')
      : el(
          'table',
          { class: 'report' },
          el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '标签'), el('th', { scope: 'col' }, '自动'), el('th', { scope: 'col' }, '改正'), el('th', { scope: 'col' }, '拿不准'))),
          el('tbody', {}, ...rows.map((row) => el('tr', {}, el('th', { scope: 'row' }, row.name), cell(row.auto), cell(row.corrected), cell(row.unsure)))),
        ),
  )
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
    const today = tallyOf(flow.counts)
    const sevenDays = (n: number) => `7 天 ${String(n)}`
    fill(
      body,
      statusLine(status, ctx.host.now()),
      el(
        'div',
        { class: 'kpis' },
        kpi('处理', today.decided, sevenDays(week.decidedCount)),
        kpi('有把握', today.confident, sevenDays(week.autoCount)),
        kpi('都不是', today.none, sevenDays(week.noLabelCount)),
        kpi('拿不准', today.unsure, sevenDays(week.unsureCount)),
      ),
      card('今天的流程', graph.total === 0 ? '' : `共 ${String(graph.total)} 封`, sankeyChart(graph), graph.total === 0 ? el('p', { class: 'hint' }, '今天还没有邮件') : null),
      el('div', { class: 'two' }, labelTable(week, labels), budget(status)),
    )
    // Where the diagram is wider than its box (a phone), it starts at its right end: the labels, 都不是, 拿不准.
    const scroll = body.querySelector('.flow-scroll')
    if (scroll !== null && scroll.scrollWidth > scroll.clientWidth) scroll.scrollLeft = scroll.scrollWidth
  })
}
