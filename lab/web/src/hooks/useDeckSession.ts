/**
 * One deck's live session: the frozen cards from GET /api/decks/:day, the optimistic model
 * (lib/deckModel.ts) and the queue runner that sends one operation at a time (docs/ux.md §4).
 *
 * - Success: the response's state becomes the confirmed state.
 * - Transient failure: the same op_id is sent once more; if that fails too the operation and everything
 *   queued after it are rolled back ("网络异常，已恢复这张卡片") and the deck is re-read.
 * - 409 deck_changed (another tab or device): the server's state is adopted and the queue dropped
 *   ("已同步其他设备上的选择"). Any other refusal re-reads the deck and adopts it.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { Day, Deck, DeckMutationResponse } from '../../../worker/src/api-types.ts'
import { ApiError, api, withRetry } from '../api/client'
import { useFeedback } from '../components/Feedback'
import { reduceModel, simulate, type Effective, type LocalOp, type ModelAction, type SessionModel } from '../lib/deckModel'

function reducer(model: SessionModel | null, action: ModelAction): SessionModel | null {
  if (model === null) return action.type === 'adopt' ? { server: action.state, pending: [] } : null
  return reduceModel(model, action)
}

const ROLLBACK_MESSAGE: Readonly<Record<LocalOp['kind'], string>> = {
  decide: '网络异常，已恢复这张卡片',
  undo: '网络异常，这次撤销没有保存',
  restart: '网络异常，重来没有保存',
}

export interface DeckSession {
  readonly deck: Deck | undefined
  readonly loading: boolean
  readonly error: unknown
  readonly model: SessionModel | null
  readonly effective: Effective | null
  /** Operations not yet confirmed by the server. */
  readonly saving: boolean
  readonly enqueue: (op: LocalOp) => void
  readonly refetch: () => void
}

export function useDeckSession(day: Day): DeckSession {
  const client = useQueryClient()
  const { announce, snack } = useFeedback()
  const deckQuery = useQuery({ queryKey: ['deck', day], queryFn: () => api.deck(day) })
  const [model, dispatch] = useReducer(reducer, null)
  const inflight = useRef<string | null>(null)

  const deckData = deckQuery.data
  useEffect(() => {
    if (deckData) dispatch({ type: 'adopt', state: deckData.state, force: false })
  }, [deckData])

  const notify = useCallback(
    (text: string) => {
      snack({ text, tone: 'warn', duration: 5000 })
      announce(text)
    },
    [announce, snack],
  )

  const resync = useCallback(async () => {
    try {
      const fresh = await client.fetchQuery({ queryKey: ['deck', day], queryFn: () => api.deck(day), staleTime: 0 })
      // Not forced: operations queued since then are kept (a stale one is answered with deck_changed).
      dispatch({ type: 'adopt', state: fresh.state, force: false })
    } catch {
      // The next deck read (focus, reload) catches up.
    }
  }, [client, day])

  const pending = model?.pending
  const baseVersion = model?.server.version
  useEffect(() => {
    const op = pending?.[0]
    if (!op || baseVersion === undefined || inflight.current === op.op_id) return
    inflight.current = op.op_id
    const body = { op_id: op.op_id, base_version: baseVersion }
    const run = (): Promise<DeckMutationResponse> => {
      if (op.kind === 'decide') return api.decide(day, { ...body, paper_id: op.paper_id, decision: op.decision })
      if (op.kind === 'undo') return api.undo(day, body)
      return api.restart(day, body)
    }
    withRetry(run)
      .then((response) => {
        inflight.current = null
        dispatch({ type: 'confirmed', op_id: op.op_id, state: response.state })
        void client.invalidateQueries({ queryKey: ['summary', day] })
        void client.invalidateQueries({ queryKey: ['today'], refetchType: 'none' })
      })
      .catch((error: unknown) => {
        inflight.current = null
        if (error instanceof ApiError && error.code === 'deck_changed' && error.state) {
          dispatch({ type: 'adopt', state: error.state, force: true })
          notify('已同步其他设备上的选择')
        } else if (error instanceof ApiError && !error.transient) {
          dispatch({ type: 'rollback', op_id: op.op_id })
          // An undo pressed ahead of the server's answer found nothing left to take back.
          notify(op.kind === 'undo' && error.code === 'nothing_to_undo' ? '没有更多可以撤销的了' : error.message)
          void resync()
        } else {
          dispatch({ type: 'rollback', op_id: op.op_id })
          notify(ROLLBACK_MESSAGE[op.kind])
          void resync()
        }
        void client.invalidateQueries({ queryKey: ['summary', day] })
      })
  }, [pending, baseVersion, day, client, notify, resync])

  const enqueue = useCallback((op: LocalOp) => dispatch({ type: 'enqueue', op }), [])
  const effective = useMemo(() => (model ? simulate(model) : null), [model])

  return {
    deck: deckData,
    loading: deckQuery.isPending,
    error: deckQuery.error,
    model,
    effective,
    saving: (model?.pending.length ?? 0) > 0,
    enqueue,
    refetch: () => void deckQuery.refetch(),
  }
}
