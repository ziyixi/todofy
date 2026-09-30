/**
 * One deck: cards one at a time → "看完了" → summary + send → done (docs/ux.md §2–§5).
 *
 * Decisions, undo and 重来 are optimistic (hooks/useDeckSession.ts). 撤销 pops the latest action any number
 * of times, 重来 is itself undoable, and neither asks for confirmation; the only confirmation is sending to
 * Todofy on the summary.
 */
import { Sprout } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Decision, Day, DeckCard, TodayResponse } from '../../../worker/src/api-types.ts'
import { errorMessage } from '../api/client'
import { ActionBar, DeckMenu, DeckProgress, ShortcutsSheet } from '../components/DeckChrome'
import { useFeedback } from '../components/Feedback'
import { Link } from '../components/Link'
import { SwipeDeck, titleIdOf, type EnterFrom, type SwipeDeckHandle } from '../components/SwipeDeck'
import { useDeckSession } from '../hooks/useDeckSession'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { countDecisions, planDecide, planRestart, planUndo, undecidedCards } from '../lib/deckModel'
import { formatDay, newOpId, safeArxivUrl, shortTitle } from '../lib/format'
import { deckKeyAction } from '../lib/keys'
import { DoneState } from './States'
import { SummaryView } from './Summary'

type Screen = 'auto' | 'summary' | 'done'

const FINISH_MOMENT_MS = 600

interface DeckViewProps {
  readonly day: Day
  readonly today: TodayResponse | null
}

export function DeckView({ day, today }: DeckViewProps) {
  const session = useDeckSession(day)
  const { announce, snack } = useFeedback()
  const reducedMotion = useReducedMotion()
  const deckRef = useRef<SwipeDeckHandle>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [lean, setLean] = useState<Decision | null>(null)
  const [enter, setEnter] = useState<EnterFrom | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [screen, setScreen] = useState<Screen>('auto')
  const [celebrating, setCelebrating] = useState(false)
  const focusTitle = useRef(false)
  const enterNonce = useRef(0)

  const deck = session.deck
  const effective = session.effective
  const cards = deck?.cards ?? []
  const decisions = effective?.decisions ?? {}
  const stack = undecidedCards(cards, decisions)
  const top = stack[0] ?? null
  const counts = countDecisions(cards, decisions)
  const isToday = today?.deck?.deck_id === day

  // The deck just ran out in this session: a short "看完了" moment, then the summary.
  const previousTop = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (!deck || !effective) return
    const before = previousTop.current
    const now = top?.paper.id ?? null
    previousTop.current = now
    if (now !== null) {
      if (screen !== 'auto') setScreen('auto')
      return
    }
    if (before === undefined || before === null) return
    if (reducedMotion) {
      setScreen('summary')
      return
    }
    setCelebrating(true)
    const timer = window.setTimeout(() => {
      setCelebrating(false)
      setScreen('summary')
    }, FINISH_MOMENT_MS)
    return () => window.clearTimeout(timer)
  }, [top?.paper.id, deck, effective === null])

  // After a decision or undo, focus follows to the new top card's title (unless the owner is on a button).
  useEffect(() => {
    if (!focusTitle.current || !top) return
    focusTitle.current = false
    document.getElementById(titleIdOf(top))?.focus({ preventScroll: true })
  }, [top])

  // Keep focus on an action button the owner is pressing repeatedly; otherwise follow the card.
  const shouldMoveFocus = () => document.activeElement?.closest('.action-bar') == null

  const decide = useCallback(
    (card: DeckCard, decision: Decision) => {
      if (!effective) return
      const op = planDecide(effective, card, decision, newOpId())
      if (!op) return
      session.enqueue(op)
      setExpandedId(null)
      setEnter(null)
      focusTitle.current = shouldMoveFocus()
      const nextDecisions = { ...effective.decisions, [card.paper.id]: decision }
      const next = undecidedCards(cards, nextDecisions)[0]
      const word = decision === 'like' ? '已喜欢' : '不喜欢'
      const decided = countDecisions(cards, nextDecisions).decided
      announce(next ? `${word}。第 ${decided + 1} 篇，共 ${cards.length} 篇：${next.paper.title}` : `${word}。${cards.length} 篇都看完了`)
      snack({
        text: `${word}《${shortTitle(card.paper.title)}》`,
        action: { label: '撤销', run: () => undoRef.current() },
        duration: 5000,
      })
    },
    [announce, cards, effective, session, snack],
  )

  const undo = useCallback(() => {
    if (!effective) return
    const op = planUndo(effective, newOpId())
    if (!op || op.kind !== 'undo') return
    session.enqueue(op)
    focusTitle.current = shouldMoveFocus()
    enterNonce.current += 1
    const target = op.target
    if (target.kind === 'decide') {
      const card = cards.find((item) => item.paper.id === target.paper_id)
      setEnter({ paper_id: target.paper_id, from: target.decision, nonce: enterNonce.current })
      announce(`已撤销：${card?.paper.title ?? ''}`)
    } else {
      const first = undecidedCards(cards, target.snapshot ?? decisions)[0]
      setEnter(first ? { paper_id: first.paper.id, from: 'fade', nonce: enterNonce.current } : null)
      announce(`已撤销重来，恢复了 ${target.cleared} 个选择`)
    }
    setScreen('auto')
  }, [announce, cards, decisions, effective, session])
  const undoRef = useRef(undo)
  useEffect(() => {
    undoRef.current = undo
  })

  const restart = useCallback(() => {
    if (!effective) return
    const op = planRestart(effective, newOpId())
    if (!op || op.kind !== 'restart') return
    session.enqueue(op)
    const cleared = Object.keys(op.snapshot).length
    setExpandedId(null)
    setEnter(null)
    setScreen('auto')
    focusTitle.current = true
    const text = `已清空 ${cleared} 个选择，从第 1 篇重新开始`
    announce(text)
    snack({ text: `已清空 ${cleared} 个选择`, action: { label: '撤销', run: () => undoRef.current() }, duration: 8000 })
  }, [announce, effective, session, snack])

  const fling = useCallback((decision: Decision) => deckRef.current?.fling(decision), [])

  // Keyboard (docs/ux.md §3), only while cards are showing and no sheet is open.
  const showingCards = top !== null
  useEffect(() => {
    if (!showingCards || helpOpen) return
    function onKey(event: KeyboardEvent) {
      const action = deckKeyAction(event)
      if (!action) return
      if (event.repeat && action !== 'toggle') return
      switch (action) {
        case 'like':
        case 'dislike':
          event.preventDefault()
          fling(action)
          break
        case 'undo':
          event.preventDefault()
          undoRef.current()
          break
        case 'toggle':
          event.preventDefault()
          if (top) setExpandedId((current) => (current === top.paper.id ? null : top.paper.id))
          break
        case 'open': {
          const url = top ? safeArxivUrl(top.paper.abs_url) : null
          if (url) {
            event.preventDefault()
            window.open(url, '_blank', 'noopener,noreferrer')
          }
          break
        }
        case 'help':
          event.preventDefault()
          setHelpOpen(true)
          break
        case 'close':
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showingCards, helpOpen, top, fling])

  if (session.loading) {
    return (
      <section className="panel state-panel" aria-busy="true">
        <p className="muted">正在打开卡片…</p>
      </section>
    )
  }
  if (session.error || !deck || !effective) {
    return (
      <section className="panel state-panel">
        <h2>这组卡片没有打开</h2>
        <p role="alert">{errorMessage(session.error)}</p>
        <div className="button-row">
          <button type="button" className="btn" onClick={session.refetch}>
            重试
          </button>
          <Link to={{ view: 'today' }} className="btn btn-quiet">
            回到今日
          </Link>
        </div>
      </section>
    )
  }

  const explore = deck.kind === 'explore' || (isToday && today?.cold_start === true)
  const heading = `${isToday ? '今日论文' : `${formatDay(day)} 的论文`}`

  if (top === null) {
    if (celebrating) {
      return (
        <section className="panel finish-moment" aria-live="polite">
          <p className="finish-mark">看完了</p>
        </section>
      )
    }
    const finishedEarlier = deck.send !== null || deck.later_at !== null || counts.liked === 0
    const view = screen === 'auto' ? (finishedEarlier ? 'done' : 'summary') : screen
    if (view === 'summary') {
      return (
        <SummaryView
          day={day}
          deck={deck}
          isToday={isToday}
          onDone={() => setScreen('done')}
          onRestart={restart}
        />
      )
    }
    return (
      <DoneState
        day={day}
        isToday={isToday}
        today={today}
        counts={counts}
        onOpenSummary={() => setScreen('summary')}
        onRestart={restart}
      />
    )
  }

  return (
    <section className="deck" aria-label={heading}>
      <div className="deck-head">
        <h1 className="deck-title">{heading}</h1>
        <DeckMenu onRestart={restart} canRestart={counts.decided > 0} onShortcuts={() => setHelpOpen(true)} />
      </div>
      <DeckProgress cards={cards} decisions={decisions} currentId={top.paper.id} />
      {explore ? (
        <p className="banner banner-info">
          <Sprout size={16} aria-hidden="true" /> 还没有种子：先凭直觉划一组，你的喜欢就是推荐的起点 ·{' '}
          <Link to={{ view: 'seeds' }}>添加种子</Link>
        </p>
      ) : null}
      <SwipeDeck
        ref={deckRef}
        cards={stack}
        kind={deck.kind}
        reducedMotion={reducedMotion}
        expandedId={expandedId}
        onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
        onDecide={decide}
        onLean={setLean}
        enter={enter}
      />
      <ActionBar
        onDecide={fling}
        onUndo={undo}
        canUndo={effective.undoTop !== null}
        undoBusy={effective.undoWaiting}
        lean={lean}
        disabled={false}
      />
      <p className="deck-hint muted">右滑喜欢 · 左滑不喜欢 · 明天的排序会参考你的选择</p>
      {helpOpen ? <ShortcutsSheet onClose={() => setHelpOpen(false)} /> : null}
    </section>
  )
}
