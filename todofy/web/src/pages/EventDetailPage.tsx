import { ArrowLeft, CircleCheck, ExternalLink, FileText } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { keys, useEvent, useLegacyText } from '../api/queries'
import { actors, eventErrors, eventStates, idOf, iso, reconcileActions, type MailEvent, type ReconcileActionName, type Transition } from '../api/types'
import { eventError, StateBadge } from '../components/EventList'
import { Badge, Button, CopyButton, ErrorPanel, Facts, Loading, PageHeader, Section, Time } from '../components/ui'
import { shortId, todoistTaskUrl } from '../lib/format'
import { EVENT_ERRORS, EVENT_STATES, RECONCILE_ACTIONS, type Label } from '../lib/labels'
import { ReconcileDialog } from './ReconcileDialog'

function footerText(eventId: string): string {
  return `Mail Hero event: ${eventId}`
}

/** The actions an event allows now, as wire names (an action this build does not know is left out). */
export function allowedActions(event: MailEvent): ReconcileActionName[] {
  return event.allowedActions.map((action) => reconcileActions.name(action)).filter((name) => name !== null)
}

/** A state's label, or a neutral word for one this build does not know. */
function stateLabel(state: MailEvent['state']): Label {
  const name = eventStates.name(state)
  return name === null ? { label: '未知状态', tone: 'neutral' } : EVENT_STATES[name]
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

function StatusSection({ event }: { event: MailEvent }) {
  const error = eventError(event.errorCode)
  const id = idOf(event.name)
  return (
    <Section title="状态" aside={<StateBadge state={event.state} />}>
      {event.canary ? (
        <div className="hint-box">
          <p>
            <strong>金丝雀事件</strong>：运维面板发出的合成端到端检查，只验证接收与摘要，不会创建 Todoist
            任务，也不计入列表、统计和提醒。
          </p>
        </div>
      ) : null}
      {error ? (
        <div className="code-explain">
          <p>
            <strong>{error.title}</strong> <code className="muted">{error.name}</code>
          </p>
          <p className="muted">{error.detail}</p>
        </div>
      ) : null}
      <Facts
        items={[
          [
            '事件 ID',
            <span className="inline-copy" key="id">
              <code className="wrap">{id}</code>
              <CopyButton value={id} label="事件 ID" />
            </span>,
          ],
          ['收到', <Time key="r" value={iso(event.receiveTime)} />],
          ['更新', <Time key="u" value={iso(event.updateTime)} />],
          ['下次处理', <Time key="n" value={iso(event.nextAttemptTime)} empty="未排期" />],
          ['尝试次数', event.attemptCount],
          ['摘要中断', `${event.crashCount} / 3`],
          ['版本', event.version],
          ['来源', event.canary ? '金丝雀（合成检查）' : event.imported ? '从旧 Go 服务导入' : 'Mail Hero webhook'],
        ]}
      />
    </Section>
  )
}

function ActionsSection({ event, onPick }: { event: MailEvent; onPick: (action: ReconcileActionName) => void }) {
  const actions = allowedActions(event)
  if (actions.length === 0) return null
  const lookup = actions.includes('task_created')
  const footer = footerText(idOf(event.name))
  return (
    <Section title="需要你处理">
      {lookup ? (
        <div className="hint-box">
          <p>先在 Todoist 默认项目里搜索这段页脚，确认任务是否已经建成：</p>
          <p className="inline-copy">
            <code className="wrap">{footer}</code>
            <CopyButton value={footer} label="页脚" />
          </p>
        </div>
      ) : null}
      <div className="action-row">
        {/* Only the first (most likely) action is filled; the dialogs carry the warnings. */}
        {actions.map((action, index) => (
          <Button key={action} variant={index === 0 ? 'primary' : 'secondary'} onClick={() => onPick(action)}>
            {RECONCILE_ACTIONS[action].trigger}
          </Button>
        ))}
      </div>
    </Section>
  )
}

function TodoistSection({ event }: { event: MailEvent }) {
  if (!event.taskId && !event.todoistRequestId) return null
  return (
    <Section title="Todoist">
      <Facts
        items={[
          [
            '任务',
            event.taskId ? (
              <a key="t" href={todoistTaskUrl(event.taskId)} target="_blank" rel="noopener noreferrer" className="link">
                {event.taskId}
                <ExternalLink size={14} aria-hidden="true" />
                <span className="visually-hidden">（在新窗口打开 Todoist）</span>
              </a>
            ) : (
              <span key="t" className="muted">
                尚未确认
              </span>
            ),
          ],
          ['X-Request-Id', event.todoistRequestId ? <code key="x">{event.todoistRequestId}</code> : '—'],
        ]}
      />
    </Section>
  )
}

function ContentSection({ event }: { event: MailEvent }) {
  const empty = !event.summary && !event.todoBody
  const state = eventStates.name(event.state)
  return (
    <Section title="内容" aside={<span className="muted small">纯文本预览</span>}>
      {empty ? (
        <p className="muted">
          {state === 'complete' || state === 'ignored' ? '完成或忽略后邮件正文已清除，账本只保留去重记录。' : '摘要尚未生成。'}
        </p>
      ) : null}
      {event.summary ? (
        <div className="content-block">
          <h3>
            摘要 {event.summaryModel ? <span className="muted small">· {event.summaryModel}</span> : null}
          </h3>
          <p className="pre">{event.summary}</p>
        </div>
      ) : null}
      {event.todoBody ? (
        <div className="content-block">
          <h3>Todoist 描述（已冻结）</h3>
          <pre className="pre">{event.todoBody}</pre>
        </div>
      ) : null}
    </Section>
  )
}

function Step({ step }: { step: Transition }) {
  const to = stateLabel(step.state)
  const code = eventErrors.name(step.errorCode)
  return (
    <li className={`timeline-item tone-${to.tone}`}>
      <span className="timeline-dot" aria-hidden="true" />
      <div>
        <p>
          {eventStates.name(step.priorState) ? `${stateLabel(step.priorState).label} → ` : '收到 → '}
          <strong>{to.label}</strong>
          <span className="muted small"> · {actors.name(step.actor) === 'owner' ? '你' : '系统'}</span>
        </p>
        {code ? <p className="muted small">{EVENT_ERRORS[code].title}</p> : null}
        <p className="muted small">
          <Time value={iso(step.transitionTime)} />
        </p>
      </div>
    </li>
  )
}

function Timeline({ transitions }: { transitions: Transition[] }) {
  return (
    <Section title="时间线">
      <ol className="timeline">
        {transitions.map((step, index) => (
          <Step key={index} step={step} />
        ))}
      </ol>
      {transitions.length >= 100 ? <p className="muted small">只显示最早的 100 次状态变化。</p> : null}
    </Section>
  )
}

function LegacyTextSection({ name }: { name: string }) {
  const [open, setOpen] = useState(false)
  const text = useLegacyText(name, open)
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
            导入于 <Time value={iso(text.data.createTime)} />，
            {text.data.expireTime ? (
              <>
                <Time value={iso(text.data.expireTime)} /> 后清除
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
function useRefreshOnStateChange(state: MailEvent['state'] | undefined) {
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
  const [action, setAction] = useState<ReconcileActionName | null>(null)
  const [done, setDone] = useState<ReconcileActionName | null>(null)
  const notice = useRef<HTMLParagraphElement>(null)
  useRefreshOnStateChange(query.data?.state)
  // The action's button may be gone once the event moves on; keep keyboard focus on the outcome.
  useEffect(() => {
    if (done) notice.current?.focus()
  }, [done])

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
        title={event.subject || `事件 ${shortId(idOf(event.name))}`}
        description={event.sender ? `来自 ${event.sender}` : undefined}
        actions={event.attention ? <Badge tone="warn">需关注</Badge> : null}
      />
      {done ? (
        <p ref={notice} tabIndex={-1} className="notice tone-ok" role="status">
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
          {event.legacyText ? <LegacyTextSection name={event.legacyText} /> : null}
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
