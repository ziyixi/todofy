import { ArrowLeft, CircleCheck, ExternalLink, FileText } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { keys, useEvent, useLegacyText } from '../api/queries'
import type { EventDetail, ReconcileAction, Transition } from '../api/types'
import { StateBadge } from '../components/EventList'
import { Badge, Button, CopyButton, ErrorPanel, Facts, Loading, PageHeader, Section, Time } from '../components/ui'
import { shortId, todoistTaskUrl } from '../lib/format'
import { EVENT_ERRORS, EVENT_STATES, RECONCILE_ACTIONS } from '../lib/labels'
import { ReconcileDialog } from './ReconcileDialog'

function footerText(eventId: string): string {
  return `Mail Hero event: ${eventId}`
}

function BackButton() {
  const navigate = useNavigate()
  const canGoBack = typeof window.history.state?.idx === 'number' && window.history.state.idx > 0
  return (
    <Button variant="ghost" className="back" onClick={() => (canGoBack ? navigate(-1) : navigate('/events'))}>
      <ArrowLeft size={16} aria-hidden="true" />
      返回
    </Button>
  )
}

function StatusSection({ event }: { event: EventDetail }) {
  const error = event.error_code ? EVENT_ERRORS[event.error_code] : null
  return (
    <Section title="状态" aside={<StateBadge state={event.state} />}>
      {error ? (
        <div className="code-explain">
          <p>
            <strong>{error.title}</strong> <code className="muted">{event.error_code}</code>
          </p>
          <p className="muted">{error.detail}</p>
        </div>
      ) : null}
      <Facts
        items={[
          [
            '事件 ID',
            <span className="inline-copy" key="id">
              <code className="wrap">{event.event_id}</code>
              <CopyButton value={event.event_id} label="事件 ID" />
            </span>,
          ],
          ['收到', <Time key="r" value={event.received_at} />],
          ['更新', <Time key="u" value={event.updated_at} />],
          ['下次处理', <Time key="n" value={event.next_attempt_at} empty="未排期" />],
          ['尝试次数', event.attempt_count],
          ['摘要中断', `${event.crashes} / 3`],
          ['版本', event.version],
          ['来源', event.imported ? '从旧 Go 服务导入' : 'Mail Hero webhook'],
        ]}
      />
    </Section>
  )
}

function ActionsSection({ event, onPick }: { event: EventDetail; onPick: (action: ReconcileAction) => void }) {
  if (event.allowed_actions.length === 0) return null
  const lookup = event.allowed_actions.includes('task_created')
  return (
    <Section title="需要你处理">
      {lookup ? (
        <div className="hint-box">
          <p>先在 Todoist 默认项目里搜索这段页脚，确认任务是否已经建成：</p>
          <p className="inline-copy">
            <code className="wrap">{footerText(event.event_id)}</code>
            <CopyButton value={footerText(event.event_id)} label="页脚" />
          </p>
        </div>
      ) : null}
      <div className="action-row">
        {/* Only the first (most likely) action is filled; the dialogs carry the warnings. */}
        {event.allowed_actions.map((action, index) => (
          <Button key={action} variant={index === 0 ? 'primary' : 'secondary'} onClick={() => onPick(action)}>
            {RECONCILE_ACTIONS[action].trigger}
          </Button>
        ))}
      </div>
    </Section>
  )
}

function TodoistSection({ event }: { event: EventDetail }) {
  if (!event.task_id && !event.todoist_request_id) return null
  return (
    <Section title="Todoist">
      <Facts
        items={[
          [
            '任务',
            event.task_id ? (
              <a key="t" href={todoistTaskUrl(event.task_id)} target="_blank" rel="noopener noreferrer" className="link">
                {event.task_id}
                <ExternalLink size={14} aria-hidden="true" />
                <span className="visually-hidden">（在新窗口打开 Todoist）</span>
              </a>
            ) : (
              <span key="t" className="muted">
                尚未确认
              </span>
            ),
          ],
          ['X-Request-Id', event.todoist_request_id ? <code key="x">{event.todoist_request_id}</code> : '—'],
        ]}
      />
    </Section>
  )
}

function ContentSection({ event }: { event: EventDetail }) {
  const empty = !event.summary && !event.todo_body
  return (
    <Section title="内容" aside={<span className="muted small">纯文本预览</span>}>
      {empty ? (
        <p className="muted">
          {event.state === 'complete' || event.state === 'ignored'
            ? '完成或忽略后邮件正文已清除，账本只保留去重记录。'
            : '摘要尚未生成。'}
        </p>
      ) : null}
      {event.summary ? (
        <div className="content-block">
          <h3>
            摘要 {event.summary_model ? <span className="muted small">· {event.summary_model}</span> : null}
          </h3>
          <p className="pre">{event.summary}</p>
        </div>
      ) : null}
      {event.todo_body ? (
        <div className="content-block">
          <h3>Todoist 描述（已冻结）</h3>
          <pre className="pre">{event.todo_body}</pre>
        </div>
      ) : null}
    </Section>
  )
}

function Timeline({ transitions }: { transitions: Transition[] }) {
  return (
    <Section title="时间线">
      <ol className="timeline">
        {transitions.map((step, index) => (
          <li key={index} className={`timeline-item tone-${EVENT_STATES[step.to_state].tone}`}>
            <span className="timeline-dot" aria-hidden="true" />
            <div>
              <p>
                {step.from_state ? `${EVENT_STATES[step.from_state].label} → ` : '收到 → '}
                <strong>{EVENT_STATES[step.to_state].label}</strong>
                <span className="muted small"> · {step.actor === 'owner' ? '你' : '系统'}</span>
              </p>
              {step.error_code ? <p className="muted small">{EVENT_ERRORS[step.error_code].title}</p> : null}
              <p className="muted small">
                <Time value={step.at} />
              </p>
            </div>
          </li>
        ))}
      </ol>
      {transitions.length >= 100 ? <p className="muted small">只显示最早的 100 次状态变化。</p> : null}
    </Section>
  )
}

function LegacyTextSection({ eventId }: { eventId: string }) {
  const [open, setOpen] = useState(false)
  const text = useLegacyText(eventId, open)
  return (
    <Section title="旧版原文" aside={<span className="muted small">从旧 Go 缓存导入</span>}>
      {!open ? (
        <Button onClick={() => setOpen(true)}>
          <FileText size={16} aria-hidden="true" />
          显示全文
        </Button>
      ) : text.isPending ? (
        <Loading />
      ) : text.isError ? (
        <ErrorPanel error={text.error} onRetry={() => text.refetch()} />
      ) : (
        <>
          <p className="muted small">
            导入于 <Time value={text.data.created_at} />，
            {text.data.expires_at ? (
              <>
                <Time value={text.data.expires_at} /> 后清除
              </>
            ) : (
              '永久保留'
            )}
          </p>
          <pre className="pre legacy-text">{text.data.text}</pre>
        </>
      )}
    </Section>
  )
}

/** When the Worker moves the open event on, the attention badge and lists are out of date too. */
function useRefreshOnStateChange(state: string | undefined) {
  const client = useQueryClient()
  const seen = useRef(state)
  useEffect(() => {
    if (seen.current !== undefined && state !== undefined && state !== seen.current) {
      void client.invalidateQueries({ queryKey: keys.overview })
      void client.invalidateQueries({ queryKey: keys.events })
    }
    seen.current = state
  }, [client, state])
}

export function EventDetailPage() {
  const { eventId = '' } = useParams()
  const query = useEvent(eventId)
  const [action, setAction] = useState<ReconcileAction | null>(null)
  const [done, setDone] = useState<ReconcileAction | null>(null)
  useRefreshOnStateChange(query.data?.state)

  if (query.isPending) return <Loading />
  if (query.isError) {
    return (
      <>
        <BackButton />
        <ErrorPanel error={query.error} onRetry={() => query.refetch()} />
      </>
    )
  }
  const event = query.data

  return (
    <>
      <BackButton />
      <PageHeader
        title={event.subject || `事件 ${shortId(event.event_id)}`}
        description={event.from ? `来自 ${event.from}` : undefined}
        actions={event.attention ? <Badge tone="warn">需关注</Badge> : null}
      />
      {done ? (
        <p className="notice tone-ok" role="status">
          <CircleCheck size={18} aria-hidden="true" />
          <span>
            <strong>已提交：{RECONCILE_ACTIONS[done].title}</strong>
            后续的查找、摘要或建任务由后台稍后完成，本页会显示最新状态。
          </span>
        </p>
      ) : null}
      <div className="detail-grid">
        <div className="stack">
          <ActionsSection
            event={event}
            onPick={(next) => {
              setDone(null)
              setAction(next)
            }}
          />
          <StatusSection event={event} />
          <TodoistSection event={event} />
          <ContentSection event={event} />
          {event.has_legacy_text ? <LegacyTextSection eventId={event.event_id} /> : null}
        </div>
        <Timeline transitions={event.transitions} />
      </div>
      {action ? (
        <ReconcileDialog
          event={event}
          action={action}
          onClose={() => setAction(null)}
          onDone={() => {
            setDone(action)
            setAction(null)
          }}
        />
      ) : null}
    </>
  )
}
