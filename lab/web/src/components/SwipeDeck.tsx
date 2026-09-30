/**
 * The card stack with the swipe gesture (docs/ux.md §3), on pointer events and CSS transforms only.
 *
 * - The top card follows the pointer after an 8 px, clearly horizontal movement (vertical movement scrolls
 *   the card: touch-action pan-y), tilts up to 12° and fades in the 喜欢 / 不喜欢 stamp.
 * - Release commits past the distance threshold or on a flick, else springs back.
 * - A committed card is decided at once (the next card is interactive immediately) while a non-interactive
 *   copy flies out on top; buttons and keys use the same exit through `fling`.
 * - An undone card flies back in from the side it left.
 * - Under prefers-reduced-motion: no tilt, fly-out or spring; a static stamp and a short cross-fade.
 */
import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type Ref } from 'react'
import type { Decision, DeckCard, DeckKind } from '../../../worker/src/api-types.ts'
import {
  SPRING_BACK_MS,
  directionOf,
  dragPose,
  exitDuration,
  exitPose,
  lockAxis,
  poseTransform,
  releaseDecision,
  releaseVelocity,
  stampOpacity,
  type CardPose,
  type Sample,
} from '../lib/swipe'
import { PaperCardBody } from './PaperCard'

export interface SwipeDeckHandle {
  /** Decides the top card with the same exit animation as a swipe (buttons, keys). */
  fling: (decision: Decision) => void
}

export interface EnterFrom {
  readonly paper_id: string
  readonly from: Decision | 'fade'
  /** Changes on every undo so the same card can enter twice. */
  readonly nonce: number
}

interface SwipeDeckProps {
  /** Undecided cards in deck order: the first is the top card. */
  readonly cards: readonly DeckCard[]
  readonly kind: DeckKind
  readonly reducedMotion: boolean
  readonly expandedId: string | null
  readonly onToggle: (paperId: string) => void
  readonly onDecide: (card: DeckCard, decision: Decision) => void
  /** The direction the top card leans while dragging (the matching button lights up). */
  readonly onLean: (decision: Decision | null) => void
  readonly enter: EnterFrom | null
  readonly ref?: Ref<SwipeDeckHandle>
}

interface Ghost {
  readonly key: number
  readonly card: DeckCard
  readonly decision: Decision
  readonly from: CardPose
  readonly velocity: number
}

const REST: CardPose = { x: 0, y: 0, rotate: 0 }
/** Peeking cards behind the top one. */
const VISIBLE = 3

export function titleIdOf(card: DeckCard): string {
  return `card-title-${card.paper.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function buzz(reducedMotion: boolean) {
  if (reducedMotion) return
  try {
    navigator.vibrate?.(8)
  } catch {
    // Vibration is a nicety; some browsers throw without a user gesture.
  }
}

export function SwipeDeck({ cards, kind, reducedMotion, expandedId, onToggle, onDecide, onLean, enter, ref }: SwipeDeckProps) {
  const [ghosts, setGhosts] = useState<readonly Ghost[]>([])
  const counter = useRef(0)

  const commit = useCallback(
    (card: DeckCard, decision: Decision, from: CardPose, velocity: number) => {
      counter.current += 1
      const ghost: Ghost = { key: counter.current, card, decision, from, velocity }
      setGhosts((current) => [...current.slice(-3), ghost])
      onLean(null)
      buzz(reducedMotion)
      onDecide(card, decision)
    },
    [onDecide, onLean, reducedMotion],
  )

  const top = cards[0]
  useImperativeHandle(
    ref,
    () => ({
      fling: (decision: Decision) => {
        if (top) commit(top, decision, REST, 0)
      },
    }),
    [commit, top],
  )

  const removeGhost = useCallback((key: number) => setGhosts((current) => current.filter((ghost) => ghost.key !== key)), [])

  return (
    <div className="deck-stack">
      {cards.slice(0, VISIBLE).map((card, depth) => (
        <StackCard
          key={card.paper.id}
          card={card}
          depth={depth}
          kind={kind}
          reducedMotion={reducedMotion}
          expanded={depth === 0 && expandedId === card.paper.id}
          onToggle={onToggle}
          onCommit={commit}
          onLean={onLean}
          enter={enter && enter.paper_id === card.paper.id && depth === 0 ? enter : null}
        />
      ))}
      {ghosts.map((ghost) => (
        <GhostCard key={ghost.key} ghost={ghost} kind={kind} reducedMotion={reducedMotion} onDone={removeGhost} />
      ))}
    </div>
  )
}

interface DragState {
  readonly id: number
  readonly x0: number
  readonly y0: number
  readonly width: number
  axis: 'x' | 'y' | null
  dx: number
  dy: number
  samples: Sample[]
}

interface StackCardProps {
  readonly card: DeckCard
  readonly depth: number
  readonly kind: DeckKind
  readonly reducedMotion: boolean
  readonly expanded: boolean
  readonly onToggle: (paperId: string) => void
  readonly onCommit: (card: DeckCard, decision: Decision, from: CardPose, velocity: number) => void
  readonly onLean: (decision: Decision | null) => void
  readonly enter: EnterFrom | null
}

function setStamps(el: HTMLElement, like: number, nope: number) {
  el.style.setProperty('--like-o', like.toFixed(3))
  el.style.setProperty('--nope-o', nope.toFixed(3))
}

function StackCard({ card, depth, kind, reducedMotion, expanded, onToggle, onCommit, onLean, enter }: StackCardProps) {
  const element = useRef<HTMLElement>(null)
  const drag = useRef<DragState | null>(null)
  const frame = useRef(0)
  const leaning = useRef<Decision | null>(null)
  const isTop = depth === 0

  // Undo: the card comes back from the side it left (or fades in).
  const enterNonce = enter?.nonce
  const enterFrom = enter?.from
  useLayoutEffect(() => {
    const el = element.current
    if (!el || enterNonce === undefined || !enterFrom) return
    const fade = reducedMotion || enterFrom === 'fade'
    if (fade) {
      el.style.transition = 'none'
      el.style.opacity = '0'
    } else {
      const start = exitPose(enterFrom, REST, window.innerWidth || 400)
      el.style.transition = 'none'
      el.style.transform = poseTransform(start)
    }
    void el.offsetWidth
    el.style.transition = fade ? 'opacity 120ms linear' : `transform ${SPRING_BACK_MS + 40}ms cubic-bezier(.2,.8,.2,1)`
    el.style.opacity = ''
    el.style.transform = ''
    const timer = window.setTimeout(() => {
      el.style.transition = ''
    }, SPRING_BACK_MS + 80)
    return () => window.clearTimeout(timer)
  }, [enterNonce, enterFrom, reducedMotion])

  const lean = useCallback(
    (next: Decision | null) => {
      if (leaning.current === next) return
      leaning.current = next
      onLean(next)
    },
    [onLean],
  )

  function paint() {
    frame.current = 0
    const el = element.current
    const d = drag.current
    if (!el || !d) return
    el.style.transform = poseTransform(dragPose(d.dx, d.dy, d.width, reducedMotion))
    const opacity = stampOpacity(d.dx, d.width)
    setStamps(el, d.dx > 0 ? opacity : 0, d.dx < 0 ? opacity : 0)
    lean(Math.abs(d.dx) >= 24 ? directionOf(d.dx) : null)
  }

  function springBack() {
    const el = element.current
    lean(null)
    if (!el) return
    cancelAnimationFrame(frame.current)
    frame.current = 0
    el.classList.remove('is-dragging')
    el.style.transition = reducedMotion ? 'none' : `transform ${SPRING_BACK_MS}ms cubic-bezier(.2,.8,.2,1)`
    el.style.transform = ''
    setStamps(el, 0, 0)
    window.setTimeout(() => {
      if (!drag.current) el.style.transition = ''
    }, SPRING_BACK_MS + 20)
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!isTop || drag.current) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('a, button, input, textarea, select, summary')) return
    const width = element.current?.getBoundingClientRect().width ?? 0
    drag.current = {
      id: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      width,
      axis: null,
      dx: 0,
      dy: 0,
      samples: [{ x: event.clientX, t: event.timeStamp }],
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const d = drag.current
    const el = element.current
    if (!d || !el || event.pointerId !== d.id) return
    const dx = event.clientX - d.x0
    const dy = event.clientY - d.y0
    if (d.axis === null) {
      d.axis = lockAxis(dx, dy)
      if (d.axis === 'y') {
        // A vertical scroll of the card: not a swipe.
        drag.current = null
        return
      }
      if (d.axis === null) return
      try {
        el.setPointerCapture(event.pointerId)
      } catch {
        // jsdom and some browsers refuse capture for synthetic pointers; the drag still works.
      }
      el.classList.add('is-dragging')
      el.style.transition = 'none'
    }
    event.preventDefault()
    d.dx = dx
    d.dy = dy
    d.samples.push({ x: event.clientX, t: event.timeStamp })
    if (d.samples.length > 10) d.samples.shift()
    if (!frame.current) frame.current = requestAnimationFrame(paint)
  }

  function onPointerUp(event: ReactPointerEvent<HTMLElement>) {
    const d = drag.current
    if (!d || event.pointerId !== d.id) return
    drag.current = null
    if (d.axis !== 'x') return
    cancelAnimationFrame(frame.current)
    frame.current = 0
    element.current?.classList.remove('is-dragging')
    const velocity = releaseVelocity(d.samples)
    const decision = releaseDecision(d.dx, velocity, d.width)
    if (decision) onCommit(card, decision, dragPose(d.dx, d.dy, d.width, reducedMotion), velocity)
    else springBack()
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLElement>) {
    const d = drag.current
    if (!d || event.pointerId !== d.id) return
    drag.current = null
    springBack()
  }

  const titleId = titleIdOf(card)
  return (
    <article
      ref={element}
      className={`paper-card depth-${depth}`}
      style={{ zIndex: 10 - depth }}
      aria-roledescription={isTop ? '论文卡片' : undefined}
      aria-labelledby={isTop ? titleId : undefined}
      aria-hidden={isTop ? undefined : true}
      inert={!isTop}
      data-testid={isTop ? 'top-card' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    >
      <span className="stamp stamp-like" aria-hidden="true">
        喜欢
      </span>
      <span className="stamp stamp-nope" aria-hidden="true">
        不喜欢
      </span>
      <PaperCardBody
        card={card}
        kind={kind}
        expanded={expanded}
        onToggle={() => onToggle(card.paper.id)}
        titleId={isTop ? titleId : `${titleId}-peek`}
        interactive={isTop}
      />
    </article>
  )
}

function GhostCard({ ghost, kind, reducedMotion, onDone }: { ghost: Ghost; kind: DeckKind; reducedMotion: boolean; onDone: (key: number) => void }) {
  const element = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = element.current
    if (!el) return
    el.style.transform = poseTransform(ghost.from)
    setStamps(el, ghost.decision === 'like' ? 1 : 0, ghost.decision === 'dislike' ? 1 : 0)
    void el.offsetWidth
    let duration: number
    if (reducedMotion) {
      // A static stamp for 300 ms, the last 120 ms of it a cross-fade.
      duration = 300
      el.style.transition = 'opacity 120ms linear 180ms'
      el.style.opacity = '0'
    } else {
      const to = exitPose(ghost.decision, ghost.from, window.innerWidth || 400)
      duration = exitDuration(to.x - ghost.from.x, ghost.velocity)
      el.style.transition = `transform ${duration}ms cubic-bezier(.35,.4,.6,1), opacity ${duration}ms ease-in`
      el.style.transform = poseTransform(to)
      el.style.opacity = '0.4'
    }
    const timer = window.setTimeout(() => onDone(ghost.key), duration + 40)
    return () => window.clearTimeout(timer)
  }, [ghost, reducedMotion, onDone])

  return (
    <article ref={element} className="paper-card paper-card-ghost" style={{ zIndex: 20 }} aria-hidden="true" inert data-testid="leaving-card">
      <span className="stamp stamp-like" aria-hidden="true">
        喜欢
      </span>
      <span className="stamp stamp-nope" aria-hidden="true">
        不喜欢
      </span>
      <PaperCardBody card={ghost.card} kind={kind} expanded={false} titleId={`${titleIdOf(ghost.card)}-leaving`} interactive={false} />
    </article>
  )
}
