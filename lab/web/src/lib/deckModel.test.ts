import type { DeckState } from '../../../worker/src/api-types.ts'
import { cards } from '../test/fixtures'
import {
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
const [a, b, c] = deck.map((item) => item.paper.id) as [string, string, string, string]

function state(overrides: Partial<DeckState> = {}): DeckState {
  return {
    deck_id: '2026-09-30',
    version: 1,
    decisions: {},
    counts: { total: 4, decided: 0, liked: 0, disliked: 0 },
    next_position: 1,
    finished_at: null,
    undo: null,
    ...overrides,
  }
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
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), 'like', id()))
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), 'dislike', id()))
    const eff = simulate(model)
    expect(eff.decisions).toEqual({ [a]: 'like', [b]: 'dislike' })
    expect(currentCard(deck, eff.decisions)?.paper.id).toBe(c)
    expect(countDecisions(deck, eff.decisions)).toEqual({ total: 4, decided: 2, liked: 1, disliked: 1 })
    expect(eff.undoTop).toEqual({ kind: 'decide', paper_id: b, decision: 'dislike' })
  })

  it('undoes any number of steps back to the first card', () => {
    let model: SessionModel = { server: state(), pending: [] }
    for (const decision of ['like', 'dislike', 'like'] as const) {
      model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), decision, id()))
    }
    model = act(model, (eff) => planUndo(eff, id()))
    model = act(model, (eff) => planUndo(eff, id()))
    expect(simulate(model).decisions).toEqual({ [a]: 'like' })
    model = act(model, (eff) => planUndo(eff, id()))
    const eff = simulate(model)
    expect(eff.decisions).toEqual({})
    expect(eff.undoTop).toBeNull()
    expect(eff.undoWaiting).toBe(false)
    expect(planUndo(eff, id())).toBeNull()
  })

  it('makes 重来 one undoable step that restores every cleared decision', () => {
    let model: SessionModel = { server: state(), pending: [] }
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), 'like', id()))
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), 'dislike', id()))
    model = act(model, (eff) => planRestart(eff, id()))
    expect(simulate(model).decisions).toEqual({})
    expect(simulate(model).undoTop).toMatchObject({ kind: 'restart', cleared: 2 })
    model = act(model, (eff) => planUndo(eff, id()))
    expect(simulate(model).decisions).toEqual({ [a]: 'like', [b]: 'dislike' })
    // …and the decide before it is next.
    expect(simulate(model).undoTop).toEqual({ kind: 'decide', paper_id: b, decision: 'dislike' })
  })

  it('refuses 重来 on an untouched deck', () => {
    expect(planRestart(simulate({ server: state(), pending: [] }), id())).toBeNull()
  })

  it('knows only the top of the server undo stack and waits for the next one', () => {
    const server = state({ version: 5, decisions: { [a]: 'like', [b]: 'like' }, undo: { kind: 'decide', paper_id: b, decision: 'like' } })
    let model: SessionModel = { server, pending: [] }
    model = act(model, (eff) => planUndo(eff, id()))
    const eff = simulate(model)
    expect(eff.decisions).toEqual({ [a]: 'like' })
    expect(eff.undoTop).toBeNull()
    expect(eff.undoWaiting).toBe(true)
  })

  it('waits for the server to restore a restart made elsewhere', () => {
    const server = state({ version: 3, undo: { kind: 'restart', cleared: 3 } })
    const model = act({ server, pending: [] }, (eff) => planUndo(eff, id()))
    expect(simulate(model).restoring).toBe(true)
  })

  it('confirms in order, keeps queued work over a refetch, adopts on a forced conflict', () => {
    let model: SessionModel = { server: state(), pending: [] }
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), 'like', 'x1'))
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), 'like', 'x2'))
    // A confirmation for anything but the head is ignored.
    expect(reduceModel(model, { type: 'confirmed', op_id: 'x2', state: state({ version: 9 }) })).toBe(model)
    model = reduceModel(model, { type: 'confirmed', op_id: 'x1', state: state({ version: 2, decisions: { [a]: 'like' } }) })
    expect(model.pending.map((op) => op.op_id)).toEqual(['x2'])
    expect(simulate(model).decisions).toEqual({ [a]: 'like', [b]: 'like' })
    // A refetch while work is queued changes nothing.
    expect(reduceModel(model, { type: 'adopt', state: state({ version: 7 }), force: false })).toBe(model)
    const other = state({ version: 7, decisions: { [a]: 'dislike' } })
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
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), 'like', 'y1'))
    model = act(model, (eff) => planDecide(eff, currentCard(deck, eff.decisions), 'like', 'y2'))
    model = act(model, (eff) => planUndo(eff, 'y3'))
    model = reduceModel(model, { type: 'rollback', op_id: 'y2' })
    expect(model.pending.map((op) => op.op_id)).toEqual(['y1'])
    expect(simulate(model).decisions).toEqual({ [a]: 'like' })
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
      const events: { kind: 'decide' | 'restart'; paper?: string; decision?: 'like' | 'dislike'; cancelled: boolean }[] = []
      for (let step = 0; step < 12; step += 1) {
        const eff = simulate(model)
        const roll = random()
        if (roll < 0.55) {
          const op = planDecide(eff, currentCard(deck, eff.decisions), roll < 0.3 ? 'like' : 'dislike', id())
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
        let expected: Record<string, string> = {}
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
