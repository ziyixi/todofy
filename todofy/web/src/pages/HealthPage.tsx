import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { useOverview } from '../api/queries'
import { backupErrors, backupStates, iso, type BackupStatus, type EventState, type ServiceStatus, type Switches } from '../api/types'
import { Badge, ErrorPanel, Facts, Loading, PageHeader, Section, Time } from '../components/ui'
import { formatBytes, formatNumber } from '../lib/format'
import { BACKUP_ERRORS, BACKUP_STATUS, EVENT_STATES } from '../lib/labels'
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

function Flags({ switches }: { switches: Switches | undefined }) {
  return (
    <div className="badge-row">
      <Flag on={switches?.maintenanceMode ?? false} label="维护模式" />
      <Flag on={switches?.processingPaused ?? false} label="暂停处理" />
      <Flag on={switches?.forcePauseTodoist ?? false} label="暂停 Todoist" />
      <Badge tone={switches?.reminderEnabled ? 'ok' : 'neutral'}>{switches?.reminderEnabled ? '每日提醒：开' : '每日提醒：关'}</Badge>
    </div>
  )
}

function Backup({ backup }: { backup: BackupStatus }) {
  const state = backupStates.name(backup.state)
  const status = state === null ? { label: '未知', tone: 'neutral' as const } : BACKUP_STATUS[state]
  const last = iso(backup.lastBackupTime)
  const failed = iso(backup.lastFailureTime)
  const code = backupErrors.name(backup.lastErrorCode)
  const failure = failed !== null && (last === null || failed > last)
  const items: [string, ReactNode][] = [
    ['上次备份', <Time key="l" value={last} empty="还没有完成的备份" />],
    ['大小', last ? `${formatBytes(backup.lastBackupSizeBytes)}，${formatNumber(backup.lastBackupRowCount)} 行` : '—'],
    ['下次备份', <Time key="n" value={iso(backup.nextBackupTime)} empty={state === 'running' ? '正在备份' : '未排期'} />],
  ]
  if (failure && code) {
    items.push(['上次失败', <span key="f"><Time value={failed} />：{BACKUP_ERRORS[code]}</span>])
  }
  return (
    <Section title="备份" aside={<Badge tone={status.tone}>{status.label}</Badge>}>
      <Facts items={items} />
      <p className="muted small">每周日 10:00（UTC）把 D1 备份到私有 R2 桶，保留最近 6 份；备份进行时（通常几分钟内）暂停处理和写操作。</p>
    </Section>
  )
}

/** Events per active state, in ActiveCounts' order (every state that is not finished). */
function activeCounts(status: ServiceStatus): [EventState, number][] {
  const counts = status.activeCounts
  return [
    ['pending', counts?.pendingCount ?? 0],
    ['summarizing', counts?.summarizingCount ?? 0],
    ['summarized', counts?.summarizedCount ?? 0],
    ['todo_sending', counts?.todoSendingCount ?? 0],
    ['todo_unknown', counts?.todoUnknownCount ?? 0],
    ['todo_created', counts?.todoCreatedCount ?? 0],
    ['failed_summary', counts?.failedSummaryCount ?? 0],
  ]
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
                ['服务器时间', <Time key="n" value={iso(overview.data.readTime)} />],
                ['下次唤醒', <Time key="a" value={iso(overview.data.nextAlarmTime)} empty="未排期" />],
                ['最久等待的到期事件', <Time key="d" value={iso(overview.data.oldestDueTime)} relative empty="没有到期事件" />],
                ['近 24 小时收到', `${overview.data.receivedLastDayCount} 封`],
              ]}
            />
          </Section>
          <Section title="运行开关">
            <Flags switches={overview.data.switches} />
          </Section>
          {overview.data.backup && <Backup backup={overview.data.backup} />}
          <Section title="进行中的事件" aside={<span className="muted small">需关注 {overview.data.attentionCount} 个</span>}>
            <ul className="count-grid">
              {activeCounts(overview.data).map(([state, count]) => (
                <li key={state}>
                  <span className="count-value">{count}</span>
                  <span className="muted small">{EVENT_STATES[state].label}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      )}
    </>
  )
}
