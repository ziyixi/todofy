import { ListChecks } from 'lucide-react'
import { GTD_DAYS, useGtdDays, useLatestReview } from '../api/queries'
import { idOf, iso, reviewStates, type GtdDay, type GtdScope, type ReminderStateName } from '../api/types'
import { TrendChart } from '../components/TrendChart'
import { EmptyState, ErrorPanel, Facts, Loading, PageHeader, Section } from '../components/ui'
import { formatNumber } from '../lib/format'

const REVIEW_STATE: Record<ReminderStateName, string> = {
  created: '已创建',
  sending: '发送中',
  unknown: '结果未知（不会重发）',
  failed: '创建失败',
}

function values(
  days: readonly GtdDay[],
  scope: 'allProjects' | 'inbox',
  pick: (value: GtdScope) => number | undefined,
): (number | null)[] {
  return days.map((day) => {
    const value = day[scope]
    return value ? (pick(value) ?? null) : null
  })
}

function orUnknown(value: number | null | undefined): string {
  return value === null || value === undefined ? '不可用' : formatNumber(value)
}

/**
 * The GTD ledger (docs/gtd-features.md): counts from the daily read-only Todoist snapshot, never a
 * task title. The Sunday review task in Todoist is where the owner acts; this page shows the trend.
 */
export function GtdPage() {
  const daily = useGtdDays()
  const latestReview = useLatestReview()
  const header = (
    <PageHeader
      title="GTD"
      description="每天 13:00 UTC 只读 Todoist 一次，只记录计数；每周日 17:00 UTC 创建一个回顾任务。"
    />
  )
  if (daily.isPending) {
    return (
      <>
        {header}
        <Loading />
      </>
    )
  }
  if (daily.isError) {
    return (
      <>
        {header}
        <ErrorPanel error={daily.error} onRetry={() => daily.refetch()} />
      </>
    )
  }
  const days = daily.data
  const review = latestReview.data ?? null
  const latest = [...days].reverse().find((day) => day.recorded)
  const state = review === null ? null : reviewStates.name(review.state)
  const completed = review === null ? null : iso(review.completeTime)
  const reviewFacts: [string, string][] = review
    ? [
        ['最近一次回顾', `${idOf(review.name)} · ${state === null ? '未知' : REVIEW_STATE[state]}`],
        ['完成', completed ? completed.slice(0, 10) : '尚未完成'],
      ]
    : [['最近一次回顾', latestReview.isPending ? '正在加载…' : '还没有回顾任务']]
  if (!latest || !latest.allProjects) {
    return (
      <>
        {header}
        <div className="stack">
          <Section title="每周回顾">
            <Facts items={reviewFacts} />
          </Section>
          <EmptyState icon={<ListChecks size={24} />} title="还没有 Todoist 快照">
            快照每天 13:00 UTC 采集；未设置、暂停 Todoist 或采集失败时这里为空。
          </EmptyState>
        </div>
      </>
    )
  }
  const all = latest.allProjects
  const inbox = latest.inbox
  const chart = { days: days.map((day) => idOf(day.name)), recorded: days.map((day) => day.recorded) }
  return (
    <>
      {header}
      <div className="stack">
        <Section title={`快照 ${idOf(latest.name)}`} aside={all.complete ? null : <span className="muted small">任务过多，快照不完整</span>}>
          <Facts
            items={[
              ['收件箱开放', inbox ? formatNumber(inbox.openCount) : '未设置收件箱项目'],
              ['收件箱最老', inbox ? `${formatNumber(inbox.oldestAgeDays)} 天` : '—'],
              ['全部开放', formatNumber(all.openCount)],
              ['逾期', formatNumber(all.overdueCount)],
              ['无日期', formatNumber(all.undatedCount)],
              ['近 7 天新建 / 完成', `${orUnknown(all.createdLastWeekCount)} / ${orUnknown(all.completedLastWeekCount)}`],
              ['1–14 天前收到、仍开着的邮件任务', orUnknown(all.openMailCount)],
            ]}
          />
        </Section>
        <Section title="每周回顾">
          <Facts items={reviewFacts} />
        </Section>
        <Section title={`近 ${GTD_DAYS} 天趋势`} aside={<span className="muted small">UTC 日</span>}>
          <div className="trend-grid-layout">
            <TrendChart
              {...chart}
              title="开放与逾期"
              variant="line"
              format={formatNumber}
              series={[
                { label: '收件箱开放', color: 1, values: values(days, 'inbox', (value) => value.openCount) },
                { label: '全部开放', color: 2, values: values(days, 'allProjects', (value) => value.openCount) },
                { label: '逾期', color: 'danger', values: values(days, 'allProjects', (value) => value.overdueCount) },
              ]}
            />
            <TrendChart
              {...chart}
              title="近 7 天新建与完成"
              variant="line"
              format={formatNumber}
              series={[
                { label: '新建', color: 1, values: values(days, 'allProjects', (value) => value.createdLastWeekCount) },
                { label: '完成', color: 2, values: values(days, 'allProjects', (value) => value.completedLastWeekCount) },
              ]}
            />
            <TrendChart
              {...chart}
              title="收件箱任务年龄"
              variant="bar"
              format={formatNumber}
              series={[
                { label: '0–7 天', color: 1, values: values(days, 'inbox', (value) => value.freshCount) },
                { label: '8–14 天', color: 2, values: values(days, 'inbox', (value) => value.recentCount) },
                { label: '15–30 天', color: 3, values: values(days, 'inbox', (value) => value.staleCount) },
                { label: '>30 天', color: 4, values: values(days, 'inbox', (value) => value.oldCount) },
              ]}
            />
          </div>
        </Section>
      </div>
    </>
  )
}
