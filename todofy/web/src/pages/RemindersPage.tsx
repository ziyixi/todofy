import { AlarmClock, ExternalLink } from 'lucide-react'
import { useOverview, useReminders } from '../api/queries'
import { idOf, iso, reminderErrors, reminderStates, type DailyReminder } from '../api/types'
import { Badge, EmptyState, ErrorPanel, Facts, Loading, PageHeader, Section, Time, Button } from '../components/ui'
import { todoistTaskUrl, utcDay } from '../lib/format'
import { REMINDER_ERRORS, REMINDER_STATES } from '../lib/labels'

function TaskLink({ taskId }: { taskId: string }) {
  if (!taskId) return <span className="muted">—</span>
  return (
    <a href={todoistTaskUrl(taskId)} target="_blank" rel="noopener noreferrer" className="link">
      {taskId}
      <ExternalLink size={14} aria-hidden="true" />
      <span className="visually-hidden">（在新窗口打开 Todoist）</span>
    </a>
  )
}

const UNKNOWN_STATE = { label: '未知', tone: 'neutral' } as const

function stateOf(reminder: DailyReminder) {
  const name = reminderStates.name(reminder.state)
  return name === null ? UNKNOWN_STATE : REMINDER_STATES[name]
}

function ReminderRow({ reminder }: { reminder: DailyReminder }) {
  const state = stateOf(reminder)
  const code = reminderErrors.name(reminder.errorCode)
  const error = code === null ? null : REMINDER_ERRORS[code]
  const next = iso(reminder.nextAttemptTime)
  return (
    <li className="row-card">
      <div className="row-card-top">
        <strong>{idOf(reminder.name)}</strong>
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
        <span>需关注 {reminder.attentionCount} 个</span>
        <span>尝试 {reminder.attemptCount} 次</span>
        <span>
          任务 <TaskLink taskId={reminder.taskId} />
        </span>
        {next ? (
          <span>
            下次 <Time value={next} relative />
          </span>
        ) : null}
      </p>
    </li>
  )
}

function Today({ reminder, enabled }: { reminder: DailyReminder | undefined; enabled: boolean | undefined }) {
  return (
    <Section title={`今日（UTC ${utcDay()}）`} aside={enabled === false ? <Badge tone="neutral">提醒已关闭</Badge> : null}>
      {reminder ? (
        <Facts
          items={[
            ['状态', <Badge key="s" tone={stateOf(reminder).tone}>{stateOf(reminder).label}</Badge>],
            ['需关注', `${reminder.attentionCount} 个事件`],
            ['任务', <TaskLink key="t" taskId={reminder.taskId} />],
            ['创建于', <Time key="c" value={iso(reminder.createTime)} />],
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
  const reminders = list.data?.pages.flatMap((page) => page.dailyReminders) ?? []
  const today = reminders.find((reminder) => idOf(reminder.name) === utcDay())

  return (
    <>
      <PageHeader title="每日提醒" description="有需关注的事件时，每个 UTC 日在 Todoist 建一条提醒；结果不明的当天不会重发。" />
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorPanel error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="stack">
          <Today reminder={today} enabled={overview.data === undefined ? undefined : (overview.data.switches?.reminderEnabled ?? false)} />
          {reminders.length === 0 ? (
            <EmptyState icon={<AlarmClock size={28} />} title="还没有提醒记录" />
          ) : (
            <ul className="row-list" aria-label="提醒记录">
              {reminders.map((reminder) => (
                <ReminderRow key={reminder.name} reminder={reminder} />
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
