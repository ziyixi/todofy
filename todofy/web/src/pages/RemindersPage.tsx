import { AlarmClock, ExternalLink } from 'lucide-react'
import { useOverview, useReminders } from '../api/queries'
import type { Reminder } from '../api/types'
import { Badge, EmptyState, ErrorPanel, Facts, Loading, PageHeader, Section, Time, Button } from '../components/ui'
import { todoistTaskUrl, utcDay } from '../lib/format'
import { REMINDER_ERRORS, REMINDER_STATES } from '../lib/labels'

function TaskLink({ taskId }: { taskId: string | null }) {
  if (!taskId) return <span className="muted">—</span>
  return (
    <a href={todoistTaskUrl(taskId)} target="_blank" rel="noopener noreferrer" className="link">
      {taskId}
      <ExternalLink size={14} aria-hidden="true" />
      <span className="visually-hidden">（在新窗口打开 Todoist）</span>
    </a>
  )
}

function ReminderRow({ reminder }: { reminder: Reminder }) {
  const state = REMINDER_STATES[reminder.state]
  const error = reminder.error_code ? REMINDER_ERRORS[reminder.error_code] : null
  return (
    <li className="row-card">
      <div className="row-card-top">
        <strong>{reminder.day}</strong>
        <Badge tone={state.tone}>{state.label}</Badge>
        {reminder.imported ? <Badge tone="neutral">旧版导入</Badge> : null}
      </div>
      {error ? (
        <p className="event-card-error">
          <strong>{error.title}</strong>
          <span className="muted">{error.detail}</span>
        </p>
      ) : null}
      <p className="event-card-meta muted">
        <span>需关注 {reminder.attention_count} 个</span>
        <span>尝试 {reminder.attempts} 次</span>
        <span>
          任务 <TaskLink taskId={reminder.task_id} />
        </span>
        {reminder.next_attempt_at ? (
          <span>
            下次 <Time value={reminder.next_attempt_at} relative />
          </span>
        ) : null}
      </p>
    </li>
  )
}

function Today({ reminder, enabled }: { reminder: Reminder | undefined; enabled: boolean | undefined }) {
  return (
    <Section title={`今日（UTC ${utcDay()}）`} aside={enabled === false ? <Badge tone="neutral">提醒已关闭</Badge> : null}>
      {reminder ? (
        <Facts
          items={[
            ['状态', <Badge key="s" tone={REMINDER_STATES[reminder.state].tone}>{REMINDER_STATES[reminder.state].label}</Badge>],
            ['需关注', `${reminder.attention_count} 个事件`],
            ['任务', <TaskLink key="t" taskId={reminder.task_id} />],
            ['创建于', <Time key="c" value={reminder.created_at} />],
          ]}
        />
      ) : (
        <p className="muted">今天还没有提醒：只有存在需关注的事件时，才会在 Todoist 建一条每日提醒。</p>
      )}
    </Section>
  )
}

export function RemindersPage() {
  const list = useReminders()
  const overview = useOverview()
  const reminders = list.data?.pages.flatMap((page) => page.items) ?? []
  const today = reminders.find((reminder) => reminder.day === utcDay())

  return (
    <>
      <PageHeader title="每日提醒" description="有需关注的事件时，每个 UTC 日在 Todoist 建一条提醒；结果不明的当天不会重发。" />
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorPanel error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="stack">
          <Today reminder={today} enabled={overview.data?.flags.reminder_enabled} />
          {reminders.length === 0 ? (
            <EmptyState icon={<AlarmClock size={28} />} title="还没有提醒记录" />
          ) : (
            <ul className="row-list" aria-label="提醒记录">
              {reminders.map((reminder) => (
                <ReminderRow key={reminder.day} reminder={reminder} />
              ))}
            </ul>
          )}
          {list.hasNextPage ? (
            <div className="list-more">
              <Button onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                {list.isFetchingNextPage ? '正在加载…' : '加载更多'}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </>
  )
}
