/** How flows are phrased in one line (首页 rows, 业务流程 cards). */
import type { Freshness, FlowSummary } from '../../../worker/src/api-v2-types.ts'
import { formatDayHour, formatDayTime } from './format'
import { LEVEL, reasonLabel } from './labels'
import { flowOf, stageOf, type Reg } from './registry'

/** The freshness of a flow in one phrase: "端到端成功 今天 09:06", "上次摘要 今天 07:00 · Todofy 已接收". */
export function freshnessText(freshness: Freshness, now: Date): string | null {
  switch (freshness.kind) {
    case 'canary':
      return freshness.at ? `端到端成功 ${formatDayTime(freshness.at, now)}` : '金丝雀还没有成功记录'
    case 'activity':
      return freshness.at ? `最近有请求 ${formatDayHour(freshness.at, now)}` : '还没有观察到活动'
    case 'digest':
      if (!freshness.at) return '还没有发送过摘要'
      return `上次摘要 ${formatDayTime(freshness.at, now)}${freshness.accepted === true ? ' · Todofy 已接收' : freshness.accepted === false ? ' · Todofy 未接收' : ''}`
    case 'none':
      return null
  }
}

/** One line per flow: its first problem, else its freshness; coverage when some stages are unseen. */
export function flowLine(reg: Reg, summary: FlowSummary, now: Date): { word: string; detail: string; aside: string } {
  const flow = flowOf(reg, summary.id)
  const stage = stageOf(flow, summary.first_issue?.stage)
  const issue = summary.first_issue
    ? `${stage?.name ?? summary.first_issue.stage}：${summary.first_issue.code ? reasonLabel(summary.first_issue.code) : LEVEL[summary.level].word}`
    : null
  const fresh = freshnessText(summary.freshness, now)
  const word = summary.partial ? '部分接入' : LEVEL[summary.level].word
  const coverage =
    summary.coverage.monitored < summary.coverage.total ? `已监测 ${summary.coverage.monitored}/${summary.coverage.total}` : ''
  const detail = issue ?? fresh ?? (summary.partial ? '部分阶段尚未接入' : '—')
  // With a problem, the freshness is the useful aside ("端到端成功 …"); otherwise how much is seen.
  const aside = issue && fresh ? fresh : coverage
  return { word, detail, aside }
}

