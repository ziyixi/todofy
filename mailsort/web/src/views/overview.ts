/** Overview shows classification counts, the flow, corrections by priority and the unchanged model budget. */
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

/** Automatic classifications and owner corrections over the last seven days. */
function labelTable(answer: LabelReport, labels: readonly Label[]): HTMLElement {
  const rows = answer.labels
    .map((row) => ({ name: labelText(row.label, labels), auto: row.autoCount, corrected: row.gmailCorrectionCount + row.reviewCorrectionCount }))
    .filter((row) => row.auto + row.corrected > 0)
  const p1 = answer.labels.find((row) => row.label === 'labels/p1')
  const p1Breakdown = p1 === undefined || p1.autoCount === 0 ? null : el('p', { class: 'hint' },
    p1.fallbackCount === undefined
      ? 'P1 保底拆分未提供，请刷新或等待服务更新。'
      : `明确 P1 ${String(p1.autoCount - p1.fallbackCount)} 封 · 保底 P1（拿不准）${String(p1.fallbackCount)} 封`,
  )
  const cell = (n: number) => el('td', {}, String(n))
  return card(
    '各分级 · 最近 7 天',
    '',
    rows.length === 0
      ? emptyState(answer.decidedCount === 0 ? '最近 7 天还没有邮件' : '最近 7 天还没有分级记录')
      : el(
          'table',
          { class: 'report' },
          el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '分级'), el('th', { scope: 'col' }, '自动'), el('th', { scope: 'col' }, '改正'))),
          el('tbody', {}, ...rows.map((row) => el('tr', {}, el('th', { scope: 'row' }, row.name), cell(row.auto), cell(row.corrected)))),
        ),
    p1Breakdown,
  )
}

/** Today's estimated neurons against the budget, with what it means when it is high. */
function budget(status: ServiceStatus): HTMLElement {
  const used = status.neuronsToday
  const max = status.dailyNeuronBudget
  const share = max <= 0 ? 0 : used / max
  const tone = status.aiQuotaExhausted || share >= 1 ? 'danger' : share >= FLASH_SHARE ? 'warn' : ''
  const note = status.aiQuotaExhausted || share >= 1
    ? '今天的额度用完了，剩余邮件等下一个 UTC 日继续'
    : status.decisionModel === 'clef-flash'
      ? '已过 70%，今天改用 Clef-flash'
      : ''
  const waiting = status.deferredCount > 0 ? `${String(status.deferredCount)} 封暂缓，后台按额度或重试时间继续` : ''
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
    const todayRank = (inbox: boolean) => flow.counts.filter((count) => LABELLED.has(count.outcome) && (inbox ? count.label === 'labels/p1' : ['labels/p2', 'labels/p3', 'labels/p4'].includes(count.label))).reduce((sum, count) => sum + count.mailCount, 0)
    const weekRank = (inbox: boolean) => week.labels.filter((row) => inbox ? row.label === 'labels/p1' : ['labels/p2', 'labels/p3', 'labels/p4'].includes(row.label)).reduce((sum, row) => sum + row.autoCount, 0)
    fill(
      body,
      statusLine(status, ctx.host.now()),
      el(
        'div',
        { class: 'kpis' },
        kpi('处理', today.decided, sevenDays(week.decidedCount)),
        kpi('已分级', today.confident, sevenDays(week.autoCount)),
        kpi('P1', todayRank(true), sevenDays(weekRank(true))),
        kpi('P2、P3、P4', todayRank(false), sevenDays(weekRank(false))),
      ),
      card('今天的流程', graph.total === 0 ? '' : `共 ${String(graph.total)} 封`, sankeyChart(graph), graph.total === 0 ? el('p', { class: 'hint' }, '今天还没有邮件') : null),
      el('div', { class: 'two' }, labelTable(week, labels), budget(status)),
    )
    // Where the diagram is wider than its box (a phone), it starts at its right end: the labels, 都不是, 拿不准.
    const scroll = body.querySelector('.flow-scroll')
    if (scroll !== null && scroll.scrollWidth > scroll.clientWidth) scroll.scrollLeft = scroll.scrollWidth
  })
}
