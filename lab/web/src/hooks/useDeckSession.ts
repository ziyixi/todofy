/**
 * One deck's live session: the frozen cards from GetDeck, the optimistic model
 * (lib/deckModel.ts) and the queue runner that sends one operation at a time (docs/ux.md §4).
 *
 * - Success: the response's state becomes the confirmed state.
 * - Transient failure: the same request_id is sent once more; if that fails too the operation and everything
 *   queued after it are rolled back ("网络异常，已恢复这张卡片") and the deck is re-read.
 * - DECK_CHANGED (another tab or device): the server's state is adopted and the queue dropped
 *   ("已同步其他设备上的选择"). Any other refusal re-reads the deck and adopts it.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { Deck, DeckState } from '@ziyixi/proto/lab/ui/v1/deck_pb'
import { ApiError, deckName, lab, withRetry } from '../api/client'
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

/** GetDeck for `day`; a deck without its state is not a deck this UI can show. */
async function readDeck(day: string): Promise<Deck> {
  const deck = await lab.getDeck({ name: deckName(day) })
  if (deck.state === undefined) throw new ApiError(200, 'BAD_RESPONSE', '服务返回了无法识别的响应（HTTP 200）')
  return deck
}

export function useDeckSession(day: string): DeckSession {
  const client = useQueryClient()
  const { announce, snack } = useFeedback()
  const deckQuery = useQuery({ queryKey: ['deck', day], queryFn: () => readDeck(day) })
  const [model, dispatch] = useReducer(reducer, null)
  const inflight = useRef<string | null>(null)

  const deckData = deckQuery.data
  useEffect(() => {
    if (deckData?.state) dispatch({ type: 'adopt', state: deckData.state, force: false })
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
      const fresh = await client.fetchQuery({ queryKey: ['deck', day], queryFn: () => readDeck(day), staleTime: 0 })
      // Not forced: operations queued since then are kept (a stale one is answered with DECK_CHANGED).
      if (fresh.state) dispatch({ type: 'adopt', state: fresh.state, force: false })
    } catch {
      // The next deck read (focus, reload) catches up.
    }
  }, [client, day])

  const pending = model?.pending
  // AIP-154: each operation is sent on the etag of the state the previous answer returned.
  const etag = model?.server.etag
  useEffect(() => {
    const op = pending?.[0]
    if (!op || etag === undefined || inflight.current === op.op_id) return
    inflight.current = op.op_id
    const request = { name: deckName(day), requestId: op.op_id, etag }
    const run = async (): Promise<DeckState> => {
      const response =
        op.kind === 'decide'
          ? await lab.decideDeck({ ...request, paperId: op.paper_id, decision: op.decision })
          : op.kind === 'undo'
            ? await lab.undoDeck(request)
            : await lab.restartDeck(request)
      if (response.state === undefined) throw new ApiError(200, 'BAD_RESPONSE', '服务返回了无法识别的响应（HTTP 200）')
      return response.state
    }
    withRetry(run)
      .then((state) => {
        inflight.current = null
        dispatch({ type: 'confirmed', op_id: op.op_id, state })
        void client.invalidateQueries({ queryKey: ['summary', day] })
        void client.invalidateQueries({ queryKey: ['today'], refetchType: 'none' })
      })
      .catch((error: unknown) => {
        inflight.current = null
        if (error instanceof ApiError && error.reason === 'DECK_CHANGED' && error.state) {
          dispatch({ type: 'adopt', state: error.state, force: true })
          notify('已同步其他设备上的选择')
        } else if (error instanceof ApiError && !error.transient) {
          dispatch({ type: 'rollback', op_id: op.op_id })
          // An undo pressed ahead of the server's answer found nothing left to take back.
          notify(op.kind === 'undo' && error.reason === 'NOTHING_TO_UNDO' ? '没有更多可以撤销的了' : error.message)
          void resync()
        } else {
          dispatch({ type: 'rollback', op_id: op.op_id })
          notify(ROLLBACK_MESSAGE[op.kind])
          void resync()
        }
        void client.invalidateQueries({ queryKey: ['summary', day] })
      })
  }, [pending, etag, day, client, notify, resync])

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
