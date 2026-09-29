import { CircleCheck, RefreshCw } from 'lucide-react'
import { useEventList } from '../api/queries'
import { EventList } from '../components/EventList'
import { Button, EmptyState, ErrorPanel, Loading, PageHeader } from '../components/ui'

export function AttentionPage() {
  const list = useEventList('attention')
  const events = list.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <>
      <PageHeader
        title="需要关注"
        description="摘要失败、建任务结果不明，或收到 6 小时后仍未完成的事件；最早的在前。"
        actions={
          <Button variant="ghost" onClick={() => list.refetch()} disabled={list.isFetching} aria-label="刷新">
            <RefreshCw size={16} aria-hidden="true" className={list.isFetching ? 'spin' : undefined} />
            <span className="hide-narrow">刷新</span>
          </Button>
        }
      />
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorPanel error={list.error} onRetry={() => list.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState icon={<CircleCheck size={28} />} title="一切正常">
          没有需要你处理的事件。
        </EmptyState>
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
