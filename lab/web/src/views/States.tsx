/** The non-deck states of 今日 (docs/ux.md §6): empty, building, done for today, plus the shared banners. */
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Heart, Settings, Sprout } from 'lucide-react'
import type { Day, DeckPointer, DeckSummary, TodayResponse } from '../../../worker/src/api-types.ts'
import { api } from '../api/client'
import { Link } from '../components/Link'
import { NOTICES, PHASES, formatDay, formatWhen, isWeekend } from '../lib/format'
import { sendCopy } from '../lib/sendCopy'

export function NoticeBanner({ notice }: { notice: TodayResponse['notice'] }) {
  if (!notice) return null
  return (
    <p className="banner banner-warn" role="note">
      {NOTICES[notice]}
    </p>
  )
}

export function OlderDecks({ decks }: { decks: readonly DeckPointer[] }) {
  if (decks.length === 0) return null
  return (
    <div className="older-decks">
      {decks.map((deck) => (
        <Link key={deck.deck_id} to={{ view: 'deck', day: deck.deck_id }} className="chip-link">
          {formatDay(deck.deck_id)} 还剩 {deck.total - deck.decided} 篇 <ChevronRight size={16} aria-hidden="true" />
        </Link>
      ))}
    </div>
  )
}

function NextRun({ today }: { today: TodayResponse | null }) {
  if (!today) return null
  if (today.building) {
    return <p className="muted">下一批正在准备：{PHASES[today.building.phase]}…</p>
  }
  return (
    <>
      {today.next_run_at ? <p className="muted">下一批：{formatWhen(today.next_run_at)}左右</p> : null}
      {isWeekend() ? <p className="muted">arXiv 周末不发布，周一见。</p> : null}
    </>
  )
}

function QuickLinks() {
  return (
    <nav className="quick-links" aria-label="更多">
      <Link to={{ view: 'liked' }} className="btn btn-quiet">
        <Heart size={18} aria-hidden="true" /> 已喜欢
      </Link>
      <Link to={{ view: 'seeds' }} className="btn btn-quiet">
        <Sprout size={18} aria-hidden="true" /> 种子
      </Link>
      <Link to={{ view: 'settings' }} className="btn btn-quiet">
        <Settings size={18} aria-hidden="true" /> 设置
      </Link>
    </nav>
  )
}

export function EmptyState({ today }: { today: TodayResponse }) {
  return (
    <section className="panel state-panel" aria-labelledby="empty-title">
      <h2 id="empty-title">第一批论文还在路上</h2>
      {today.next_run_at ? <p>下次抓取：{formatWhen(today.next_run_at)}</p> : null}
      <p>
        先 <Link to={{ view: 'seeds' }}>添加几篇你喜欢的论文作为种子</Link>，第一组卡片就会按你的口味排序。
      </p>
      <OlderDecks decks={today.older_unfinished} />
    </section>
  )
}

export function BuildingState({ today }: { today: TodayResponse }) {
  const phase = today.building?.phase ?? 'waiting'
  return (
    <section className="panel state-panel" aria-labelledby="building-title" aria-busy="true">
      <h2 id="building-title">今天的论文正在准备</h2>
      <p>
        当前阶段：{PHASES[phase]}
        {phase === 'ranking' || phase === 'summarizing' || phase === 'embedding' || phase === 'fetching' ? '…' : ''}
      </p>
      <p className="muted">准备好后这里会自动出现卡片。</p>
      <OlderDecks decks={today.older_unfinished} />
    </section>
  )
}

interface DoneStateProps {
  readonly day: Day
  readonly isToday: boolean
  readonly today: TodayResponse | null
  readonly counts: { readonly total: number; readonly liked: number; readonly disliked: number }
  readonly onOpenSummary: () => void
  readonly onRestart: () => void
}

export function DoneState({ day, isToday, today, counts, onOpenSummary, onRestart }: DoneStateProps) {
  const summary = useQuery({ queryKey: ['summary', day], queryFn: () => api.summary(day) })
  const data: DeckSummary | undefined = summary.data
  const copy = data?.send ? sendCopy(data.send) : null
  const others = (today?.older_unfinished ?? []).filter((deck) => deck.deck_id !== day)
  return (
    <section className="panel state-panel done" aria-labelledby="done-title">
      <h2 id="done-title" tabIndex={-1}>
        {isToday ? '今天' : formatDay(day)}的 {counts.total} 篇都看完了
      </h2>
      <p>
        喜欢 {counts.liked} · 不喜欢 {counts.disliked}
      </p>
      {copy ? <p className={`status-line tone-${copy.tone}`}>{copy.text}</p> : null}
      {data && data.sendable > 0 ? (
        <p>
          还有 {data.sendable} 篇喜欢的论文没有发送。{' '}
          <button type="button" className="btn btn-primary btn-small" onClick={onOpenSummary}>
            去发送
          </button>
        </p>
      ) : counts.liked > 0 ? (
        <button type="button" className="btn btn-quiet btn-small" onClick={onOpenSummary}>
          查看这组的总结
        </button>
      ) : null}
      <NextRun today={isToday ? today : null} />
      <OlderDecks decks={others} />
      <QuickLinks />
      <button type="button" className="btn btn-ghost btn-small" onClick={onRestart}>
        回到卡片重来
      </button>
    </section>
  )
}
