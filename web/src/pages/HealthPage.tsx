import { ExternalLink } from 'lucide-react'
import { useOverview } from '../api/queries'
import type { Overview } from '../api/types'
import { Badge, ErrorPanel, Facts, Loading, PageHeader, Section, Time } from '../components/ui'
import { EVENT_STATES } from '../lib/labels'
import { RefreshOverview, UpdatedAt } from './BudgetPage'

const REPOSITORY = 'https://github.com/ziyixi/todofy'

function Build({ sha }: { sha: string }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return <code>{sha || '未设置'}</code>
  return (
    <a href={`${REPOSITORY}/commit/${sha}`} target="_blank" rel="noopener noreferrer" className="link">
      <code>{sha.slice(0, 12)}</code>
      <ExternalLink size={14} aria-hidden="true" />
      <span className="visually-hidden">（在新窗口打开 GitHub 提交）</span>
    </a>
  )
}

function Flag({ on, label }: { on: boolean; label: string }) {
  return <Badge tone={on ? 'warn' : 'neutral'}>{on ? `${label}：开` : `${label}：关`}</Badge>
}

function Flags({ flags }: { flags: Overview['flags'] }) {
  return (
    <div className="badge-row">
      <Flag on={flags.maintenance_mode} label="维护模式" />
      <Flag on={flags.processing_paused} label="暂停处理" />
      <Flag on={flags.force_pause_todoist} label="暂停 Todoist" />
      <Badge tone={flags.reminder_enabled ? 'ok' : 'neutral'}>{flags.reminder_enabled ? '每日提醒：开' : '每日提醒：关'}</Badge>
    </div>
  )
}

export function HealthPage() {
  const overview = useOverview()

  return (
    <>
      <PageHeader title="健康" description={<UpdatedAt />} actions={<RefreshOverview />} />
      {overview.isPending ? (
        <Loading />
      ) : overview.isError ? (
        <>
          <p className="notice tone-danger">D1 或后台协调器当前无法读取运行状态。</p>
          <ErrorPanel error={overview.error} onRetry={() => overview.refetch()} />
        </>
      ) : (
        <div className="stack">
          <Section title="Worker" aside={<Badge tone="ok">D1 可读</Badge>}>
            <Facts
              items={[
                ['部署版本', <Build key="b" sha={overview.data.build} />],
                ['服务器时间', <Time key="n" value={overview.data.now} />],
                ['下次唤醒', <Time key="a" value={overview.data.next_alarm_at} empty="未排期" />],
                ['最久等待的到期事件', <Time key="d" value={overview.data.oldest_due_at} relative empty="没有到期事件" />],
                ['近 24 小时收到', `${overview.data.received_24h} 封`],
              ]}
            />
          </Section>
          <Section title="运行开关">
            <Flags flags={overview.data.flags} />
          </Section>
          <Section title="进行中的事件" aside={<span className="muted small">需关注 {overview.data.attention_count} 个</span>}>
            <ul className="count-grid">
              {Object.entries(overview.data.counts).map(([state, count]) => (
                <li key={state}>
                  <span className="count-value">{count}</span>
                  <span className="muted small">{EVENT_STATES[state as keyof typeof EVENT_STATES].label}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      )}
    </>
  )
}
