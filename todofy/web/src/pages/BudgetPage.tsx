import { useQueryClient } from '@tanstack/react-query'
import { BarChart3, RefreshCw } from 'lucide-react'
import { keys, METRICS_DAYS, useDailyMetrics, useOverview } from '../api/queries'
import { idOf, iso, type MetricDay } from '../api/types'
import { SERIES_COLORS, type SeriesColor, TrendChart, type TrendSeries } from '../components/TrendChart'
import { Badge, Button, EmptyState, ErrorPanel, Facts, Loading, Meter, PageHeader, Section, Time } from '../components/ui'
import { formatCompact, formatDuration, formatNumber, formatTime } from '../lib/format'

export function RefreshOverview() {
  const client = useQueryClient()
  const overview = useOverview()
  return (
    <Button
      variant="ghost"
      onClick={() => client.invalidateQueries({ queryKey: keys.overview })}
      disabled={overview.isFetching}
      aria-label="刷新运行状态"
    >
      <RefreshCw size={16} aria-hidden="true" className={overview.isFetching ? 'spin' : undefined} />
      <span className="hide-narrow">刷新</span>
    </Button>
  )
}

export function UpdatedAt() {
  const { dataUpdatedAt } = useOverview()
  if (!dataUpdatedAt) return null
  return <>每 5 分钟自动刷新，上次 {formatTime(new Date(dataUpdatedAt).toISOString())}。</>
}

/** The label of the series that folds every model beyond the chart's colours. */
const OTHER_MODELS = '其他'

function counts(days: readonly MetricDay[], pick: (day: MetricDay) => number | null | undefined): (number | null)[] {
  return days.map((day) => (day.recorded ? (pick(day) ?? null) : null))
}

/**
 * One token series per model, largest 30-day total first. A changed model list can leave more
 * models than colours; the smallest are then folded into one '其他' series, so no two share a colour.
 */
function tokenSeries(days: readonly MetricDay[]): TrendSeries[] {
  const totals = new Map<string, number>()
  for (const day of days) {
    for (const [model, tokens] of Object.entries(day.geminiTokens)) totals.set(model, (totals.get(model) ?? 0) + tokens)
  }
  const models = [...totals].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([model]) => model)
  const shown = models.length > SERIES_COLORS ? models.slice(0, SERIES_COLORS - 1) : models
  const rest = models.slice(shown.length)
  const series: TrendSeries[] = shown.map((model, index) => ({
    label: model,
    color: (index + 1) as SeriesColor,
    values: counts(days, (day) => day.geminiTokens[model] ?? 0),
  }))
  if (rest.length) {
    series.push({
      label: OTHER_MODELS,
      color: SERIES_COLORS,
      values: counts(days, (day) => rest.reduce((sum, model) => sum + (day.geminiTokens[model] ?? 0), 0)),
    })
  }
  return series
}

/** 30 finished UTC days from daily_metrics, written by the Worker a few minutes after each UTC midnight. */
function DailyTrends() {
  const metrics = useDailyMetrics()
  const aside = <span className="muted small">UTC 日汇总</span>
  if (metrics.isPending) {
    return (
      <Section title={`近 ${METRICS_DAYS} 天趋势`} aside={aside}>
        <Loading />
      </Section>
    )
  }
  if (metrics.isError) {
    return (
      <Section title={`近 ${METRICS_DAYS} 天趋势`} aside={aside}>
        <ErrorPanel error={metrics.error} onRetry={() => metrics.refetch()} />
      </Section>
    )
  }
  const days = metrics.data
  if (!days.some((day) => day.recorded)) {
    return (
      <Section title={`近 ${METRICS_DAYS} 天趋势`} aside={aside}>
        <EmptyState icon={<BarChart3 size={24} />} title="还没有每日统计">
          每天 UTC 00:05 后汇总前一天；开始统计后的第一个完整 UTC 日会在次日出现。
        </EmptyState>
      </Section>
    )
  }
  const labels = days.map((day) => idOf(day.name))
  const recorded = days.map((day) => day.recorded)
  const tokens = tokenSeries(days)
  const chart = { days: labels, recorded }
  return (
    <Section title={`近 ${METRICS_DAYS} 天趋势`} aside={aside}>
      <div className="trend-grid-layout">
        <TrendChart
          {...chart}
          title="邮件（封）"
          variant="line"
          format={formatNumber}
          series={[
            { label: '收到', color: 1, values: counts(days, (day) => day.receivedCount) },
            { label: '完成', color: 2, values: counts(days, (day) => day.completedCount) },
            { label: '摘要失败', color: 'danger', values: counts(days, (day) => day.failedCount) },
          ]}
        />
        <TrendChart
          {...chart}
          title="从收到到完成"
          variant="line"
          format={formatDuration}
          series={[
            { label: '中位数', color: 1, values: counts(days, (day) => day.latencyP50Seconds) },
            { label: 'P90', color: 2, values: counts(days, (day) => day.latencyP90Seconds) },
          ]}
        />
        {tokens.length ? (
          <TrendChart
            {...chart}
            title="Gemini token（按模型）"
            variant="bar"
            format={formatNumber}
            axisFormat={formatCompact}
            series={tokens}
          />
        ) : null}
        <TrendChart
          {...chart}
          title="外部请求（次）"
          variant="line"
          format={formatNumber}
          series={[
            { label: 'Gemini', color: 1, values: counts(days, (day) => day.geminiCallCount) },
            { label: 'Todoist 创建', color: 2, values: counts(days, (day) => day.todoistCreateCount) },
            { label: 'Todoist 查找', color: 3, values: counts(days, (day) => day.todoistLookupCount) },
          ]}
        />
      </div>
    </Section>
  )
}

export function BudgetPage() {
  const overview = useOverview()
  const gemini = overview.data?.gemini
  const todoist = overview.data?.todoist
  const blocked = iso(todoist?.blockExpireTime)

  return (
    <>
      <PageHeader title="预算" description={<UpdatedAt />} actions={<RefreshOverview />} />
      <div className="stack">
        {overview.isPending ? (
          <Loading />
        ) : overview.isError ? (
          <ErrorPanel error={overview.error} onRetry={() => overview.refetch()} />
        ) : (
          <>
            <Section title="Gemini" aside={<span className="muted small">UTC {gemini?.day}</span>}>
              <Meter
                label="今日 token"
                value={(gemini?.usedTokens ?? 0) + (gemini?.reservedTokens ?? 0)}
                max={gemini?.tokenBudget ?? 0}
                detail={`${formatNumber(gemini?.usedTokens ?? 0)} 已用 + ${formatNumber(gemini?.reservedTokens ?? 0)} 预留 / ${formatNumber(gemini?.tokenBudget ?? 0)}`}
              />
              <Facts
                items={[
                  ['调用次数', formatNumber(gemini?.callCount ?? 0)],
                  [
                    '模型顺序',
                    <ol key="m" className="model-order">
                      {(gemini?.models ?? []).map((model, index) => (
                        <li key={model}>
                          <code>{model}</code>
                          {index === 0 ? <Badge tone="ok">首选</Badge> : null}
                        </li>
                      ))}
                    </ol>,
                  ],
                ]}
              />
            </Section>
            <Section title="Todoist">
              <Meter
                label={`${Math.round((todoist?.windowSeconds ?? 0) / 60)} 分钟窗口`}
                value={todoist?.windowCallCount ?? 0}
                max={todoist?.windowCallLimit ?? 0}
                detail={`${formatNumber(todoist?.windowCallCount ?? 0)} / ${formatNumber(todoist?.windowCallLimit ?? 0)} 次`}
              />
              <Facts
                items={[
                  [
                    '认证阻断',
                    blocked ? (
                      <span key="b">
                        阻断到 <Time value={blocked} />
                      </span>
                    ) : (
                      '无'
                    ),
                  ],
                ]}
              />
            </Section>
            <Section title="后台调度">
              <Facts
                items={[
                  ['下次唤醒', <Time key="a" value={iso(overview.data.nextAlarmTime)} empty="未排期" />],
                  ['最久等待的到期事件', <Time key="d" value={iso(overview.data.oldestDueTime)} relative empty="没有到期事件" />],
                ]}
              />
            </Section>
          </>
        )}
        <DailyTrends />
      </div>
    </>
  )
}
