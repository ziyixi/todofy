/**
 * The deck session's optimistic model (docs/ux.md §4, docs/design.md §7). The UI moves on at once: every
 * swipe, undo and 重来 becomes a queued operation with its own op_id, and the screen shows the server's last
 * confirmed DeckState with the queued operations replayed on top. The queue is sent one operation at a
 * time (each with the version the previous response returned), so the server sees exactly the order the
 * owner acted in; a response replaces the confirmed state, and a conflict adopts the server's state.
 */
import type { Decision, DeckCard, DeckState, PaperId, UndoTarget } from '../../../worker/src/api-types.ts'

export type Decisions = Readonly<Record<PaperId, Decision>>

/** What one undo takes back. A restart's snapshot is known when this tab made it, else null (the server restores it). */
export type UndoEntry =
  | { readonly kind: 'decide'; readonly paper_id: PaperId; readonly decision: Decision }
  | { readonly kind: 'restart'; readonly cleared: number; readonly snapshot: Decisions | null }

export type LocalOp =
  | { readonly kind: 'decide'; readonly op_id: string; readonly paper_id: PaperId; readonly decision: Decision }
  | { readonly kind: 'undo'; readonly op_id: string; readonly target: UndoEntry }
  | { readonly kind: 'restart'; readonly op_id: string; readonly snapshot: Decisions }

export interface SessionModel {
  /** The last state the server confirmed. */
  readonly server: DeckState
  /** Operations not yet confirmed, oldest first; pending[0] is the one in flight. */
  readonly pending: readonly LocalOp[]
}

export interface Effective {
  readonly decisions: Decisions
  /** What 撤销 would take back now; null when nothing (or nothing known yet, see undoWaiting). */
  readonly undoTop: UndoEntry | null
  /** The queue took back the server's last known entry; the next one is known once the queue drains. */
  readonly undoWaiting: boolean
  /** An undo of a restart this tab did not make is queued: its cards come back with the server's answer. */
  readonly restoring: boolean
}

export function fromServerUndo(undo: UndoTarget): UndoEntry | null {
  if (!undo) return null
  if (undo.kind === 'decide') return { kind: 'decide', paper_id: undo.paper_id, decision: undo.decision }
  return { kind: 'restart', cleared: undo.cleared, snapshot: null }
}

/** Replays the queue on the confirmed state. */
export function simulate(model: SessionModel): Effective {
  let decisions: Record<PaperId, Decision> = { ...model.server.decisions }
  const serverTop = fromServerUndo(model.server.undo)
  const stack: UndoEntry[] = serverTop ? [serverTop] : []
  let poppedServerEntry = false
  let restoring = false
  for (const op of model.pending) {
    if (op.kind === 'decide') {
      decisions[op.paper_id] = op.decision
      stack.push({ kind: 'decide', paper_id: op.paper_id, decision: op.decision })
    } else if (op.kind === 'restart') {
      decisions = {}
      stack.push({ kind: 'restart', cleared: Object.keys(op.snapshot).length, snapshot: op.snapshot })
    } else {
      stack.pop()
      if (stack.length === 0 && serverTop) poppedServerEntry = true
      const target = op.target
      if (target.kind === 'decide') {
        const rest = { ...decisions }
        delete rest[target.paper_id]
        decisions = rest
      } else if (target.snapshot) {
        decisions = { ...target.snapshot }
      } else {
        restoring = true
      }
    }
  }
  const undoTop = stack[stack.length - 1] ?? null
  return { decisions, undoTop, undoWaiting: undoTop === null && poppedServerEntry, restoring }
}

export type ModelAction =
  /** A deck GET or a conflict: take the server's state; `force` also drops the queue (conflict). */
  | { readonly type: 'adopt'; readonly state: DeckState; readonly force: boolean }
  | { readonly type: 'enqueue'; readonly op: LocalOp }
  /** The in-flight operation's response. */
  | { readonly type: 'confirmed'; readonly op_id: string; readonly state: DeckState }
  /** The operation failed for good: drop it and everything queued after it (they were built on it). */
  | { readonly type: 'rollback'; readonly op_id: string }

export function reduceModel(model: SessionModel, action: ModelAction): SessionModel {
  switch (action.type) {
    case 'adopt':
      if (action.force) return { server: action.state, pending: [] }
      // A refetch never overrides queued work or a newer confirmed state.
      if (model.pending.length > 0 || action.state.version < model.server.version) return model
      return { server: action.state, pending: [] }
    case 'enqueue':
      return { ...model, pending: [...model.pending, action.op] }
    case 'confirmed': {
      if (model.pending[0]?.op_id !== action.op_id) return model
      const server = action.state.version >= model.server.version ? action.state : model.server
      return { server, pending: model.pending.slice(1) }
    }
    case 'rollback': {
      const index = model.pending.findIndex((op) => op.op_id === action.op_id)
      if (index < 0) return model
      return { ...model, pending: model.pending.slice(0, index) }
    }
  }
}

/** The card to show: the first undecided one in deck order, or null when the deck is done. */
export function currentCard(cards: readonly DeckCard[], decisions: Decisions): DeckCard | null {
  return cards.find((card) => decisions[card.paper.id] === undefined) ?? null
}

/** The undecided cards in deck order: the stack (top first). */
export function undecidedCards(cards: readonly DeckCard[], decisions: Decisions): DeckCard[] {
  return cards.filter((card) => decisions[card.paper.id] === undefined)
}

export function countDecisions(cards: readonly DeckCard[], decisions: Decisions) {
  let liked = 0
  let disliked = 0
  for (const card of cards) {
    const decision = decisions[card.paper.id]
    if (decision === 'like') liked += 1
    else if (decision === 'dislike') disliked += 1
  }
  return { total: cards.length, decided: liked + disliked, liked, disliked }
}

/** Builds the next operation for a user action on the current effective state (null when not possible now). */
export function planDecide(effective: Effective, card: DeckCard | null, decision: Decision, opId: string): LocalOp | null {
  if (!card || effective.decisions[card.paper.id] !== undefined) return null
  return { kind: 'decide', op_id: opId, paper_id: card.paper.id, decision }
}

export function planUndo(effective: Effective, opId: string): LocalOp | null {
  return effective.undoTop ? { kind: 'undo', op_id: opId, target: effective.undoTop } : null
}

export function planRestart(effective: Effective, opId: string): LocalOp | null {
  if (Object.keys(effective.decisions).length === 0) return null
  return { kind: 'restart', op_id: opId, snapshot: effective.decisions }
}
