/** Overview shows classification counts, model batches and the actual reported Claude usage. */
import { MailFlow_Outcome, MailFlow_Stage, type MailFlow_Count } from '@ziyixi/proto/mailsort/ui/v2/flow_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { Mode, ServiceStatus_AuthState, type LabelReport, type ServiceStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { api } from '../api.ts'
import { card, emptyState, kpi, meter } from '../components.ts'
import { el, fill } from '../dom.ts'
import { flowGraph, sankeyChart } from '../flowchart.ts'
import { claudeErrorMessage, labelText, MODE_HINTS, MODE_NAMES, relative, when } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { allLabels, frame } from './common.ts'

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
      ? '历史 P1 保底拆分未提供，请刷新或等待服务更新。'
      : `明确 P1 ${String(p1.autoCount - p1.fallbackCount)} 封 · 历史保底 P1 ${String(p1.fallbackCount)} 封`,
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

/** Monthly usage comes only from the returned budget record; an older response is not zero spend. */
function budget(status: ServiceStatus, now: number): HTMLElement {
  const usage = status.claudeBudget
  if (usage === undefined) return card('Claude 模型与用量', '', el('p', { class: 'hint warn' }, 'Claude 用量未提供，请刷新或等待服务更新。'))
  const dollars = (value: number) => `US$ ${value.toFixed(2)}`
  const exhausted = usage.limitUsd > 0 && usage.spentUsd >= usage.limitUsd
  const model = usage.model === 'claude-opus-5-5' ? 'Claude Opus 5.5' : usage.model || '模型未提供'
  const note = usage.providerLimitReached
    ? 'Anthropic 工作区已达到消费上限，剩余邮件等待额度恢复。'
    : exhausted
      ? '本月模型预算已用完，剩余邮件待下个月继续。'
      : ''
  const waiting = status.deferredCount > 0 ? `${String(status.deferredCount)} 封暂缓，后台按额度或重试时间继续` : ''
  return card(
    'Claude 模型与用量',
    usage.month || '月份未提供',
    el('p', { class: 'hint' }, `${model} · ${usage.effort || 'effort 未提供'} · 提示词可在设置中编辑`),
    el('p', {}, `本月费用 ${dollars(usage.spentUsd)} / 配置月上限 ${dollars(usage.limitUsd)}`),
    meter(usage.spentUsd, usage.limitUsd, '本月 Claude 费用', usage.providerLimitReached || exhausted ? 'danger' : ''),
    el('p', { class: 'hint' }, `本应用记录的 API 用量：输入总计（含缓存）${String(usage.inputTokens)} token · 输出（含思考）${String(usage.outputTokens)} token · 思考明细${usage.thinkingTokens === undefined ? '未提供' : ` ${String(usage.thinkingTokens)} token`}`),
    el('p', { class: 'hint' }, `缓存读取 ${String(usage.cacheReadTokens)} token · 缓存写入 ${String(usage.cacheWriteTokens)} token，均已计入输入总计。`),
    el('p', { class: 'hint' }, '缓存有效期为 5 分钟，连续批次可能命中；相隔约一小时的单批通常不会命中。用量以 API 实际返回为准。'),
    el('p', { class: 'hint' }, '费用按这些用量及标价估算，不含赠金、折扣或本应用以外的调用；工作区消费以 Anthropic 账单为准。'),
    el('p', { class: 'hint' }, usage.nextBatchTime === undefined ? '下批判断时间尚未提供' : `下批判断最早在 ${relative(usage.nextBatchTime, now)}（${when(usage.nextBatchTime)}）。日常新邮件自动分类通常约每小时一批。`),
    el('p', { class: 'meta' }, usage.lastRequestTime === undefined ? '尚无已记录用量的 Claude 响应' : `最近用量记录 ${when(usage.lastRequestTime)}`),
    usage.lastErrorCode === '' ? null : el('p', { class: 'hint warn' }, `最近一次请求：${claudeErrorMessage(usage.lastErrorCode)}`),
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
      el('p', { class: 'hint' }, '大字与流程图为今日累计处理记录；7 天小字及下表按最新判断计数。重判保留历史处理记录。'),
      card('今天的流程', graph.total === 0 ? '' : `共 ${String(graph.total)} 封`, sankeyChart(graph), graph.total === 0 ? el('p', { class: 'hint' }, '今天还没有邮件') : null),
      el('div', { class: 'two' }, labelTable(week, labels), budget(status, ctx.host.now())),
    )
    // Where the diagram is wider than its box (a phone), it starts at its right end: the labels, 都不是, 拿不准.
    const scroll = body.querySelector('.flow-scroll')
    if (scroll !== null && scroll.scrollWidth > scroll.clientWidth) scroll.scrollLeft = scroll.scrollWidth
  })
}
