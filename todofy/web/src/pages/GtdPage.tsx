import { ListChecks } from 'lucide-react'
import { GTD_DAYS, useGtdDaily } from '../api/queries'
import type { GtdDay, GtdScope } from '../api/types'
import { TrendChart } from '../components/TrendChart'
import { EmptyState, ErrorPanel, Facts, Loading, PageHeader, Section } from '../components/ui'
import { formatNumber } from '../lib/format'

const REVIEW_STATE: Record<string, string> = {
  created: '已创建',
  sending: '发送中',
  unknown: '结果未知（不会重发）',
  failed: '创建失败',
}

function values(days: readonly GtdDay[], scope: 'all' | 'inbox', pick: (value: GtdScope) => number | null): (number | null)[] {
  return days.map((day) => {
    const value = day[scope]
    return value ? pick(value) : null
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
  const daily = useGtdDaily()
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
  const days = daily.data.days
  const review = daily.data.latest_review
  const latest = [...days].reverse().find((day) => day.recorded)
  const reviewFacts: [string, string][] = review
    ? [
        ['最近一次回顾', `${review.week} · ${REVIEW_STATE[review.state] ?? review.state}`],
        ['完成', review.completed_at ? review.completed_at.slice(0, 10) : '尚未完成'],
      ]
    : [['最近一次回顾', '还没有回顾任务']]
  if (!latest || !latest.all) {
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
  const all = latest.all
  const inbox = latest.inbox
  const chart = { days: days.map((day) => day.day), recorded: days.map((day) => day.recorded) }
  return (
    <>
      {header}
      <div className="stack">
        <Section title={`快照 ${latest.day}`} aside={all.complete ? null : <span className="muted small">任务过多，快照不完整</span>}>
          <Facts
            items={[
              ['收件箱开放', inbox ? formatNumber(inbox.open) : '未设置收件箱项目'],
              ['收件箱最老', inbox ? `${formatNumber(inbox.oldest_days)} 天` : '—'],
              ['全部开放', formatNumber(all.open)],
              ['逾期', formatNumber(all.overdue)],
              ['无日期', formatNumber(all.undated)],
              ['近 7 天新建 / 完成', `${orUnknown(all.created_7d)} / ${orUnknown(all.completed_7d)}`],
              ['14 天内仍开着的邮件任务', orUnknown(all.mail_open)],
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
                { label: '收件箱开放', color: 1, values: values(days, 'inbox', (value) => value.open) },
                { label: '全部开放', color: 2, values: values(days, 'all', (value) => value.open) },
                { label: '逾期', color: 'danger', values: values(days, 'all', (value) => value.overdue) },
              ]}
            />
            <TrendChart
              {...chart}
              title="近 7 天新建与完成"
              variant="line"
              format={formatNumber}
              series={[
                { label: '新建', color: 1, values: values(days, 'all', (value) => value.created_7d) },
                { label: '完成', color: 2, values: values(days, 'all', (value) => value.completed_7d) },
              ]}
            />
            <TrendChart
              {...chart}
              title="收件箱任务年龄"
              variant="bar"
              format={formatNumber}
              series={[
                { label: '0–7 天', color: 1, values: values(days, 'inbox', (value) => value.age_0_7) },
                { label: '8–14 天', color: 2, values: values(days, 'inbox', (value) => value.age_8_14) },
                { label: '15–30 天', color: 3, values: values(days, 'inbox', (value) => value.age_15_30) },
                { label: '>30 天', color: 4, values: values(days, 'inbox', (value) => value.age_31_plus) },
              ]}
            />
          </div>
        </Section>
      </div>
    </>
  )
}
