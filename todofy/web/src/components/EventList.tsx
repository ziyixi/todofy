import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { eventErrors, eventStates, idOf, iso, type MailEvent } from '../api/types'
import { shortId } from '../lib/format'
import { EVENT_ERRORS, EVENT_STATES } from '../lib/labels'
import { Badge, Button, Time } from './ui'

/** A state's badge; a state this build does not know shows as unknown. */
export function StateBadge({ state }: { state: MailEvent['state'] }) {
  const name = eventStates.name(state)
  const { label, tone } = name === null ? { label: '未知状态', tone: 'neutral' as const } : EVENT_STATES[name]
  return <Badge tone={tone}>{label}</Badge>
}

/** The copy of an event's error code, or null when it has none (or one this build does not know). */
export function eventError(code: MailEvent['errorCode']) {
  const name = eventErrors.name(code)
  return name === null ? null : { name, ...EVENT_ERRORS[name] }
}

function EventItem({ event }: { event: MailEvent }) {
  const error = eventError(event.errorCode)
  const id = idOf(event.name)
  const next = iso(event.nextAttemptTime)
  return (
    <li>
      <Link to={`/events/${id}`} className="event-card">
        <div className="event-card-top">
          <code className="event-id">{shortId(id)}</code>
          <StateBadge state={event.state} />
          {event.imported ? <Badge tone="neutral">旧版导入</Badge> : null}
          <ChevronRight className="event-card-chevron" size={18} aria-hidden="true" />
        </div>
        {error ? (
          <p className="event-card-error">
            <strong>{error.title}</strong>
            <span className="muted">{error.detail}</span>
          </p>
        ) : null}
        <p className="event-card-meta muted">
          <span>
            收到 <Time value={iso(event.receiveTime)} />
          </span>
          <span>尝试 {event.attemptCount} 次</span>
          {next ? (
            <span>
              下次 <Time value={next} relative />
            </span>
          ) : null}
        </p>
      </Link>
    </li>
  )
}

interface EventListProps {
  events: MailEvent[]
  hasMore: boolean
  loadingMore: boolean
  onMore: () => void
}

export function EventList({ events, hasMore, loadingMore, onMore }: EventListProps) {
  return (
    <>
      <ul className="event-list">
        {events.map((event) => (
          <EventItem key={event.name} event={event} />
        ))}
      </ul>
      {hasMore ? (
        <div className="list-more">
          <Button onClick={onMore} disabled={loadingMore}>
            {loadingMore ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}
    </>
  )
}
