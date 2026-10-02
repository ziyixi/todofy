import { Inbox } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useEventList } from '../api/queries'
import type { EventState } from '../api/types'
import { EventList } from '../components/EventList'
import { EmptyState, ErrorPanel, Loading, PageHeader } from '../components/ui'
import { EVENT_STATE_ORDER, EVENT_STATES } from '../lib/labels'

function parseState(value: string | null): EventState | null {
  return EVENT_STATE_ORDER.find((state) => state === value) ?? null
}

export function EventsPage() {
  const [params, setParams] = useSearchParams()
  const state = parseState(params.get('state'))
  const list = useEventList('recent', state)
  const events = list.data?.pages.flatMap((page) => page.mailEvents) ?? []

  function choose(next: EventState | null) {
    setParams(next ? { state: next } : {}, { replace: true })
  }

  return (
    <>
      <PageHeader title="事件" description="Mail Hero 投递来的邮件事件，最新的在前。列表不含邮件内容。" />
      <div className="filter-row" role="group" aria-label="按状态筛选">
        <button type="button" className="chip" aria-pressed={state === null} onClick={() => choose(null)}>
          全部
        </button>
        {EVENT_STATE_ORDER.map((value) => (
          <button key={value} type="button" className="chip" aria-pressed={state === value} onClick={() => choose(value)}>
            {EVENT_STATES[value].label}
          </button>
        ))}
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorPanel error={list.error} onRetry={() => list.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState icon={<Inbox size={28} />} title={state ? `没有“${EVENT_STATES[state].label}”的事件` : '还没有事件'} />
      ) : (
        <EventList
          events={events}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onMore={() => list.fetchNextPage()}
        />
      )}
    </>
  )
}
