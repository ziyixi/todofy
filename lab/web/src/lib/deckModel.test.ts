import { create, type MessageInitShape } from '@ziyixi/proto/protobuf'
import { DeckStateSchema, UndoKind, type DeckState } from '@ziyixi/proto/lab/ui/v1/deck_pb'
import { Decision } from '@ziyixi/proto/lab/ui/v1/paper_pb'
import { cards } from '../test/fixtures'
import { idOf } from './messages'
import {
  UNDO_QUEUE_MAX,
  canUndo,
  countDecisions,
  currentCard,
  planDecide,
  planRestart,
  planUndo,
  reduceModel,
  simulate,
  type LocalOp,
  type SessionModel,
} from './deckModel'

const deck = cards(4)
const [a, b, c] = deck.map(idOf) as [string, string, string, string]

function state(overrides: Omit<MessageInitShape<typeof DeckStateSchema>, '$typeName'> = {}): DeckState {
  return create(DeckStateSchema, { deck: 'decks/2026-09-30', version: 1, etag: '1', counts: { cardCount: 4 }, nextPosition: 1, ...overrides })
}

let n = 0
const id = () => `op-${++n}`

/** Plans and enqueues like the UI does. */
function act(model: SessionModel, plan: (eff: ReturnType<typeof simulate>) => LocalOp | null): SessionModel {
  const op = plan(simulate(model))
  if (!op) throw new Error('nothing planned')
  return reduceModel(model, { type: 'enqueue', op })
}

describe('deck model', () => {
  it('applies decisions optimistically and shows the first undecided card', () => {
    let model: SessionModel = { server: state(), pending: [] }
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), Decision.LIKE, id()))
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), Decision.DISLIKE, id()))
    const eff = simulate(model)
    expect(eff.decisions).toEqual({ [a]: Decision.LIKE, [b]: Decision.DISLIKE })
    expect(currentCard(deck, eff.decisions)?.paper?.id).toBe(c)
    expect(countDecisions(deck, eff.decisions)).toEqual({ total: 4, decided: 2, liked: 1, disliked: 1 })
    expect(eff.undoTop).toEqual({ kind: 'decide', paper_id: b, decision: Decision.DISLIKE })
  })

  it('undoes any number of steps back to the first card', () => {
    let model: SessionModel = { server: state(), pending: [] }
    for (const decision of [Decision.LIKE, Decision.DISLIKE, Decision.LIKE] as const) {
      model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), decision, id()))
    }
    model = act(model, (eff) => planUndo(eff, id()))
    model = act(model, (eff) => planUndo(eff, id()))
    expect(simulate(model).decisions).toEqual({ [a]: Decision.LIKE })
    model = act(model, (eff) => planUndo(eff, id()))
    const eff = simulate(model)
    expect(eff.decisions).toEqual({})
    expect(eff.undoTop).toBeNull()
    expect(eff.undoWaiting).toBe(false)
    expect(planUndo(eff, id())).toBeNull()
  })

  it('makes 重来 one undoable step that restores every cleared decision', () => {
    let model: SessionModel = { server: state(), pending: [] }
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), Decision.LIKE, id()))
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), Decision.DISLIKE, id()))
    model = act(model, (eff) => planRestart(eff, id()))
    expect(simulate(model).decisions).toEqual({})
    expect(simulate(model).undoTop).toMatchObject({ kind: 'restart', cleared: 2 })
    model = act(model, (eff) => planUndo(eff, id()))
    expect(simulate(model).decisions).toEqual({ [a]: Decision.LIKE, [b]: Decision.DISLIKE })
    // …and the decide before it is next.
    expect(simulate(model).undoTop).toEqual({ kind: 'decide', paper_id: b, decision: Decision.DISLIKE })
  })

  it('refuses 重来 on an untouched deck', () => {
    expect(planRestart(simulate({ server: state(), pending: [] }), id())).toBeNull()
  })

  it('knows only the top of the server undo stack and waits for the next one', () => {
    const server = state({ version: 5, decisions: { [a]: Decision.LIKE, [b]: Decision.LIKE }, undo: { kind: UndoKind.DECIDE, paperId: b, decision: Decision.LIKE } })
    let model: SessionModel = { server, pending: [] }
    model = act(model, (eff) => planUndo(eff, id()))
    const eff = simulate(model)
    expect(eff.decisions).toEqual({ [a]: Decision.LIKE })
    expect(eff.undoTop).toBeNull()
    expect(eff.undoWaiting).toBe(true)
  })

  it('queues an undo pressed before the server named the next target, and resolves it with the answer', () => {
    const server = state({ version: 5, decisions: { [a]: Decision.LIKE, [b]: Decision.LIKE }, undo: { kind: UndoKind.DECIDE, paperId: b, decision: Decision.LIKE } })
    let model: SessionModel = { server, pending: [] }
    model = act(model, (eff) => planUndo(eff, 'u1'))
    // Pressed again while u1 is in flight: never dropped.
    expect(canUndo(simulate(model))).toBe(true)
    model = act(model, (eff) => planUndo(eff, 'u2'))
    expect(model.pending[1]).toMatchObject({ kind: 'undo', target: null })
    let eff = simulate(model)
    expect(eff.decisions).toEqual({ [a]: Decision.LIKE })
    expect(eff.undosUnresolved).toBe(1)
    // u1's answer names the next entry (a); u2 takes it back at once.
    model = reduceModel(model, {
      type: 'confirmed',
      op_id: 'u1',
      state: state({ version: 6, decisions: { [a]: Decision.LIKE }, undo: { kind: UndoKind.DECIDE, paperId: a, decision: Decision.LIKE } }),
    })
    eff = simulate(model)
    expect(eff.decisions).toEqual({})
    expect(eff.undosUnresolved).toBe(0)
    expect(eff.undoTop).toBeNull()
    expect(eff.undoWaiting).toBe(true)
  })

  it('bounds the undos queued ahead of the server', () => {
    const server = state({ version: 5, decisions: { [a]: Decision.LIKE }, undo: { kind: UndoKind.DECIDE, paperId: a, decision: Decision.LIKE } })
    let model: SessionModel = { server, pending: [] }
    for (let i = 0; i <= UNDO_QUEUE_MAX; i += 1) model = act(model, (eff) => planUndo(eff, id()))
    expect(simulate(model).undosUnresolved).toBe(UNDO_QUEUE_MAX)
    expect(planUndo(simulate(model), id())).toBeNull()
    expect(canUndo(simulate(model))).toBe(false)
  })

  it('waits for the server to restore a restart made elsewhere', () => {
    const server = state({ version: 3, undo: { kind: UndoKind.RESTART, clearedCount: 3 } })
    const model = act({ server, pending: [] }, (eff) => planUndo(eff, id()))
    expect(simulate(model).restoring).toBe(true)
  })

  it('confirms in order, keeps queued work over a refetch, adopts on a forced conflict', () => {
    let model: SessionModel = { server: state(), pending: [] }
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), Decision.LIKE, 'x1'))
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), Decision.LIKE, 'x2'))
    // A confirmation for anything but the head is ignored.
    expect(reduceModel(model, { type: 'confirmed', op_id: 'x2', state: state({ version: 9 }) })).toBe(model)
    model = reduceModel(model, { type: 'confirmed', op_id: 'x1', state: state({ version: 2, decisions: { [a]: Decision.LIKE } }) })
    expect(model.pending.map((op) => op.op_id)).toEqual(['x2'])
    expect(simulate(model).decisions).toEqual({ [a]: Decision.LIKE, [b]: Decision.LIKE })
    // A refetch while work is queued changes nothing.
    expect(reduceModel(model, { type: 'adopt', state: state({ version: 7 }), force: false })).toBe(model)
    const other = state({ version: 7, decisions: { [a]: Decision.DISLIKE } })
    const adopted = reduceModel(model, { type: 'adopt', state: other, force: true })
    expect(adopted).toEqual({ server: other, pending: [] })
  })

  it('never adopts an older state from a slow refetch', () => {
    const model: SessionModel = { server: state({ version: 4 }), pending: [] }
    expect(reduceModel(model, { type: 'adopt', state: state({ version: 3 }), force: false })).toBe(model)
    expect(reduceModel(model, { type: 'adopt', state: state({ version: 5 }), force: false }).server.version).toBe(5)
  })

  it('rolls back a failed operation and everything queued after it', () => {
    let model: SessionModel = { server: state(), pending: [] }
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), Decision.LIKE, 'y1'))
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), Decision.LIKE, 'y2'))
    model = act(model, (eff) => planUndo(eff, 'y3'))
    model = reduceModel(model, { type: 'rollback', op_id: 'y2' })
    expect(model.pending.map((op) => op.op_id)).toEqual(['y1'])
    expect(simulate(model).decisions).toEqual({ [a]: Decision.LIKE })
  })

  it('matches a straightforward replay for random operation sequences', () => {
    // Reference: the server's event semantics (docs/design.md §7) replayed from scratch.
    let seed = 7
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (let round = 0; round < 50; round += 1) {
      let model: SessionModel = { server: state(), pending: [] }
      const events: { kind: 'decide' | 'restart'; paper?: string; decision?: Decision; cancelled: boolean }[] = []
      for (let step = 0; step < 12; step += 1) {
        const eff = simulate(model)
        const roll = random()
        if (roll < 0.55) {
          const op = planDecide(eff, currentCard(deck, eff.decisions), roll < 0.3 ? Decision.LIKE : Decision.DISLIKE, id())
          if (op && op.kind === 'decide') {
            model = reduceModel(model, { type: 'enqueue', op })
            events.push({ kind: 'decide', paper: op.paper_id, decision: op.decision, cancelled: false })
          }
        } else if (roll < 0.85) {
          const op = planUndo(eff, id())
          if (op) {
            model = reduceModel(model, { type: 'enqueue', op })
            const last = [...events].reverse().find((event) => !event.cancelled)
            if (last) last.cancelled = true
          }
        } else {
          const op = planRestart(eff, id())
          if (op) {
            model = reduceModel(model, { type: 'enqueue', op })
            events.push({ kind: 'restart', cancelled: false })
          }
        }
        let expected: Record<string, Decision> = {}
        for (const event of events) {
          if (event.cancelled) continue
          if (event.kind === 'decide' && event.paper && event.decision) expected[event.paper] = event.decision
          else if (event.kind === 'restart') expected = {}
        }
        expect(simulate(model).decisions).toEqual(expected)
      }
    }
  })
})
