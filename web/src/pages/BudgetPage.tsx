import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { keys, useOverview } from '../api/queries'
import { Badge, Button, ErrorPanel, Facts, Loading, Meter, PageHeader, Section, Time } from '../components/ui'
import { formatNumber, formatTime } from '../lib/format'

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

export function BudgetPage() {
  const overview = useOverview()

  return (
    <>
      <PageHeader title="预算" description={<UpdatedAt />} actions={<RefreshOverview />} />
      {overview.isPending ? (
        <Loading />
      ) : overview.isError ? (
        <ErrorPanel error={overview.error} onRetry={() => overview.refetch()} />
      ) : (
        <div className="stack">
          <Section title="Gemini" aside={<span className="muted small">UTC {overview.data.gemini.day}</span>}>
            <Meter
              label="今日 token"
              value={overview.data.gemini.used_tokens + overview.data.gemini.reserved_tokens}
              max={overview.data.gemini.token_budget}
              detail={`${formatNumber(overview.data.gemini.used_tokens)} 已用 + ${formatNumber(overview.data.gemini.reserved_tokens)} 预留 / ${formatNumber(overview.data.gemini.token_budget)}`}
            />
            <Facts
              items={[
                ['调用次数', formatNumber(overview.data.gemini.calls)],
                [
                  '模型顺序',
                  <ol key="m" className="model-order">
                    {overview.data.gemini.models.map((model, index) => (
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
              label={`${Math.round(overview.data.todoist.window_seconds / 60)} 分钟窗口`}
              value={overview.data.todoist.window_calls}
              max={overview.data.todoist.window_limit}
              detail={`${formatNumber(overview.data.todoist.window_calls)} / ${formatNumber(overview.data.todoist.window_limit)} 次`}
            />
            <Facts
              items={[
                [
                  '认证阻断',
                  overview.data.todoist.blocked_until ? (
                    <span key="b">
                      阻断到 <Time value={overview.data.todoist.blocked_until} />
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
                ['下次唤醒', <Time key="a" value={overview.data.next_alarm_at} empty="未排期" />],
                ['最久等待的到期事件', <Time key="d" value={overview.data.oldest_due_at} relative empty="没有到期事件" />],
              ]}
            />
          </Section>
        </div>
      )}
    </>
  )
}
