import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import type { EventSummary } from '../api/types'
import { shortId } from '../lib/format'
import { EVENT_ERRORS, EVENT_STATES } from '../lib/labels'
import { Badge, Button, Time } from './ui'

export function StateBadge({ state }: { state: EventSummary['state'] }) {
  const { label, tone } = EVENT_STATES[state]
  return <Badge tone={tone}>{label}</Badge>
}

function EventItem({ event }: { event: EventSummary }) {
  const error = event.error_code ? EVENT_ERRORS[event.error_code] : null
  return (
    <li>
      <Link to={`/events/${event.event_id}`} className="event-card">
        <div className="event-card-top">
          <code className="event-id">{shortId(event.event_id)}</code>
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
            收到 <Time value={event.received_at} />
          </span>
          <span>尝试 {event.attempt_count} 次</span>
          {event.next_attempt_at ? (
            <span>
              下次 <Time value={event.next_attempt_at} relative />
            </span>
          ) : null}
        </p>
      </Link>
    </li>
  )
}

interface EventListProps {
  events: EventSummary[]
  hasMore: boolean
  loadingMore: boolean
  onMore: () => void
}

export function EventList({ events, hasMore, loadingMore, onMore }: EventListProps) {
  return (
    <>
      <ul className="event-list">
        {events.map((event) => (
          <EventItem key={event.event_id} event={event} />
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
