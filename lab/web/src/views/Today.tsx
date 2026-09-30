/**
 * 今日: the newest ready deck, or the empty / building state (docs/ux.md §2, §6). A deck route (/deck/<day>)
 * opens an older deck the same way.
 */
import { useQuery } from '@tanstack/react-query'
import type { Day } from '../../../worker/src/api-types.ts'
import { api, errorMessage } from '../api/client'
import { DeckView } from './DeckView'
import { BuildingState, EmptyState, NoticeBanner } from './States'

/** While a deck is being prepared the page re-reads /api/today every 30 s (only while visible). */
const BUILDING_REFETCH_MS = 30_000

export function useToday() {
  return useQuery({
    queryKey: ['today'],
    queryFn: api.today,
    refetchInterval: (query) => (query.state.data?.building ? BUILDING_REFETCH_MS : false),
  })
}

export function TodayView({ day }: { day?: Day }) {
  const today = useToday()
  if (day) {
    return (
      <>
        {today.data ? <NoticeBanner notice={today.data.notice} /> : null}
        <DeckView key={day} day={day} today={today.data ?? null} />
      </>
    )
  }
  if (today.isPending) {
    return (
      <section className="panel state-panel" aria-busy="true">
        <p className="muted">正在加载…</p>
      </section>
    )
  }
  if (today.isError) {
    return (
      <section className="panel state-panel">
        <h2>没有连上论文雷达</h2>
        <p role="alert">{errorMessage(today.error)}</p>
        <button type="button" className="btn" onClick={() => void today.refetch()}>
          重试
        </button>
      </section>
    )
  }
  const data = today.data
  return (
    <>
      <NoticeBanner notice={data.notice} />
      {data.deck ? (
        <DeckView key={data.deck.deck_id} day={data.deck.deck_id} today={data} />
      ) : data.building ? (
        <BuildingState today={data} />
      ) : (
        <EmptyState today={data} />
      )}
    </>
  )
}
