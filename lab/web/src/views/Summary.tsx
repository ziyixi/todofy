/**
 * End of deck (docs/ux.md §5): the liked papers (each can be taken out of this send), the send mode with a
 * live preview, and the only confirmation in the app, "发送到 Todofy？". Sending is explicit and idempotent:
 * the Worker freezes the content before calling Todofy, a retry resends the same intent, and the status line
 * follows every task-intent-v1 state. Papers liked after a delivered send go out as a separate 补发.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, RotateCcw, Send, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { timestampNow } from '@ziyixi/proto/protobuf/wkt'
import { SendMode, Send_State, type Card, type Deck, type DeckSummary, type Send as SendMessage, type SummaryItem } from '@ziyixi/proto/lab/ui/v1/deck_pb'
import { SEND_POLL_MIN_SECONDS } from '../../../worker/src/limits.ts'
import { ApiError, deckName, errorMessage, lab, withRetry } from '../api/client'
import { useFeedback } from '../components/Feedback'
import { Modal } from '../components/Modal'
import { PaperCardBody } from '../components/PaperCard'
import { formatDay, newOpId, sendPreview } from '../lib/format'
import { idOf, msOf } from '../lib/messages'
import { isDelivered, isLocked, sendCopy, type SendAction } from '../lib/sendCopy'

/** The newer of two views of the deck's send (a higher generation, else the later update). */
export function newerSend(a: SendMessage | null, b: SendMessage | null): SendMessage | null {
  if (!a) return b
  if (!b) return a
  if (a.generation !== b.generation) return a.generation > b.generation ? a : b
  return (msOf(b.updateTime) ?? 0) >= (msOf(a.updateTime) ?? 0) ? b : a
}

/** Follows a send while it settles: GetSend when next_poll_time is due (≥ 3 s), only while the page is visible. */
function useSendStatus(day: string, initial: SendMessage | null) {
  const client = useQueryClient()
  const [status, setStatus] = useState<SendMessage | null>(initial)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')

  useEffect(() => {
    setStatus((current) => newerSend(current, initial))
  }, [initial])

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const pollAfter = msOf(status?.nextPollTime)
  const updatedAt = msOf(status?.updateTime)
  useEffect(() => {
    if (pollAfter === null || !visible) return
    const wait = Math.max(SEND_POLL_MIN_SECONDS * 1000, pollAfter - Date.now())
    let live = true
    const timer = window.setTimeout(() => {
      lab
        .getSend({ name: `${deckName(day)}/send` })
        .then((next) => {
          if (live) setStatus((current) => newerSend(current, next))
        })
        .catch(() => {
          // Keep the last status; the next poll or a reload tries again.
          if (live) setStatus((current) => (current ? { ...current, updateTime: timestampNow() } : current))
        })
    }, wait)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [day, pollAfter, updatedAt, visible])

  // Delivered: refresh the list (已发送 badges, what is still sendable) and the deck's send pointer.
  const delivered = isDelivered(status)
  const generation = status?.generation
  useEffect(() => {
    if (!delivered) return
    void client.invalidateQueries({ queryKey: ['summary', day] })
    void client.invalidateQueries({ queryKey: ['deck', day], refetchType: 'none' })
  }, [client, day, delivered, generation])

  const adopt = useCallback((next: SendMessage) => setStatus((current) => newerSend(current, next)), [])
  return { status, adopt }
}

interface SummaryViewProps {
  readonly day: string
  readonly deck: Deck
  readonly isToday: boolean
  /** The deck's counts from this session's decisions (the server's summary may still be catching up). */
  readonly counts: { readonly total: number; readonly liked: number; readonly disliked: number }
  /** Decisions of this session not yet confirmed by the server. */
  readonly saving: boolean
  readonly canUndo: boolean
  /** 撤销上一张: reopens the last decided card; the rest of the deck stays as it is. */
  readonly onUndo: () => void
  readonly onDone: () => void
  readonly onRestart: () => void
}

/**
 * The summary's buttons ignore activation for this long after it appears, also under reduced motion: the
 * last card's 不喜欢 / 喜欢 sit where 发送 now is, and a double tap must never send (docs/ux.md §5).
 */
export const SUMMARY_ARM_MS = 800

export function SummaryView(props: SummaryViewProps) {
  const { day } = props
  const summaryQuery = useQuery({ queryKey: ['summary', day], queryFn: () => lab.getDeckSummary({ name: `${deckName(day)}/summary` }) })
  if (summaryQuery.isPending) {
    return (
      <section className="panel summary" aria-busy="true">
        <p className="muted">正在整理你喜欢的论文…</p>
      </section>
    )
  }
  if (summaryQuery.isError) {
    return (
      <section className="panel summary">
        <p role="alert">总结没有加载出来：{errorMessage(summaryQuery.error)}</p>
        <button type="button" className="btn" onClick={() => void summaryQuery.refetch()}>
          重试
        </button>
      </section>
    )
  }
  return <SummaryBody {...props} summary={summaryQuery.data} refreshing={summaryQuery.isFetching} />
}

function useArmed(ms: number): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), ms)
    return () => window.clearTimeout(timer)
  }, [ms])
  return armed
}

function SummaryBody({
  day,
  deck,
  summary,
  refreshing,
  isToday,
  counts,
  saving,
  canUndo,
  onUndo,
  onDone,
  onRestart,
}: SummaryViewProps & { summary: DeckSummary; refreshing: boolean }) {
  const client = useQueryClient()
  const { announce, snack, dismissSnack } = useFeedback()
  const { status, adopt } = useSendStatus(day, summary.latestSend ?? null)
  const [mode, setMode] = useState<SendMode>(summary.latestSend && isLocked(summary.latestSend) ? summary.latestSend.mode : summary.defaultMode)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Card | null>(null)
  const modeName = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const armed = useArmed(SUMMARY_ARM_MS)
  // The list and the counts wait for every decision of this session: a send never freezes half of them.
  const catchingUp = saving || refreshing

  const liked = summary.likedItems
  const statusKey = status ? `${status.generation}:${String(msOf(status.updateTime))}` : null
  // A rejected send the owner dismissed with 返回: back to the editable confirm step.
  const shown = status && statusKey !== dismissed ? status : null
  const locked = isLocked(shown)
  const delivered = isDelivered(shown)
  const nextGeneration = delivered && shown ? shown.generation + 1 : (shown?.generation ?? 1)

  const exclude = useMutation({
    mutationFn: (item: SummaryItem) => {
      const request = { name: `${deckName(day)}/summary`, requestId: newOpId(), paperId: item.paperId, excluded: !item.excluded }
      return withRetry(() => lab.excludePaper(request))
    },
    onMutate: (item) => {
      const before = client.getQueryData<DeckSummary>(['summary', day])
      if (before) {
        const listed = before.likedItems.map((row) => (row.paperId === item.paperId ? { ...row, excluded: !item.excluded } : row))
        const sendableCount = listed.filter((row) => !row.excluded && row.sentGeneration === undefined).length
        client.setQueryData<DeckSummary>(['summary', day], { ...before, likedItems: listed, sendableCount })
      }
      announce(item.excluded ? `已恢复：${item.title}` : `已移出这次发送：${item.title}`)
      return { before }
    },
    onError: (error, _item, context) => {
      if (context?.before) client.setQueryData(['summary', day], context.before)
      snack({ text: `没有保存：${errorMessage(error)}`, tone: 'warn' })
    },
    onSuccess: (next) => client.setQueryData(['summary', day], next),
  })

  const send = useMutation({
    mutationFn: async (chosen: SendMode) => {
      const request = { name: deckName(day), requestId: newOpId(), mode: chosen }
      const answer = await withRetry(() => lab.sendDeck(request))
      if (answer.send === undefined) throw new ApiError(200, 'BAD_RESPONSE', '服务返回了无法识别的响应（HTTP 200）')
      return answer.send
    },
    onMutate: () => setSendError(null),
    onSuccess: (next) => {
      adopt(next)
      announce(sendCopy(next).text)
      void client.invalidateQueries({ queryKey: ['summary', day] })
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.reason === 'SEND_IN_PROGRESS') {
        try {
          adopt(await lab.getSend({ name: `${deckName(day)}/send` }))
          return
        } catch {
          // Fall through to the error line.
        }
      }
      const text = `发送请求没有完成：${errorMessage(error)}。重试不会重复创建。`
      setSendError(text)
      announce(text)
    },
  })

  const later = useMutation({
    mutationFn: () => {
      const request = { name: deckName(day), requestId: newOpId() }
      return withRetry(() => lab.snoozeDeck(request))
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['deck', day], refetchType: 'none' })
      onDone()
    },
  })

  const sendable = summary.sendableCount
  const copy = shown ? sendCopy(shown) : null
  const title = isToday ? '今天' : formatDay(day)

  const confirmOpen = !shown || (!locked && !delivered && (shown.state === Send_State.PAUSED || shown.state === Send_State.REJECTED) && !shown.recorded)
  // After a delivered send the list is re-read before 补发 is offered (it would flash with the old count).
  const showConfirm = sendable > 0 && (confirmOpen || (delivered && !send.isPending && !refreshing))
  // While Todofy is still creating, the only thing to do is wait (docs/ux.md §5: no actions).
  const settlingNow = shown !== null && (shown.state === Send_State.SENDING || shown.state === Send_State.PENDING)
  const cardFor = (paperId: string) => deck.cards.find((card) => idOf(card) === paperId) ?? null

  // Focus lands on the heading (never on a button) and the confirm step is announced. The last swipe's
  // snackbar goes: it would cover the send preview, and 撤销上一张 is on this screen.
  const firstAnnouncement = useRef(true)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    dismissSnack()
  }, [dismissSnack])
  useEffect(() => {
    if (!firstAnnouncement.current || catchingUp) return
    firstAnnouncement.current = false
    if (liked.length === 0) announce(`看完了，${title}没有喜欢的论文`)
    else if (showConfirm) announce(`看完了，喜欢 ${String(counts.liked)} 篇。${delivered ? `补发新增的 ${String(sendable)} 篇？` : '是否发送到 Todofy？'}`)
    else announce(`看完了，喜欢 ${String(counts.liked)} 篇`)
  }, [announce, catchingUp, counts.liked, delivered, liked.length, sendable, showConfirm, title])

  /** Every button of this screen: ignored during the arming window. */
  const guard = (run: () => void) => () => {
    if (armed) run()
  }

  function runAction(action: SendAction) {
    if (action === 'done' || action === 'later') onDone()
    else if (action === 'back') setDismissed(statusKey)
    else if (action === 'retry' && shown) send.mutate(shown.mode)
    else send.mutate(mode)
  }

  const ACTION_LABEL: Readonly<Record<SendAction, string>> = {
    done: '完成',
    retry: '重试（不会重复创建）',
    resend: '再试一次',
    back: '返回',
    later: '稍后再说',
  }

  const undoButton =
    canUndo && !send.isPending && !settlingNow && !locked ? (
      <button type="button" className="btn btn-quiet" aria-disabled={!armed} onClick={guard(onUndo)}>
        <Undo2 size={18} aria-hidden="true" /> 撤销上一张
      </button>
    ) : null
  const restartButton = (
    <button type="button" className="btn btn-ghost" aria-disabled={!armed} onClick={guard(onRestart)}>
      <RotateCcw size={18} aria-hidden="true" /> 回到卡片重来
    </button>
  )
  const laterButton = (
    <button type="button" className="btn btn-quiet" disabled={later.isPending || catchingUp} aria-disabled={!armed} onClick={guard(() => later.mutate())}>
      暂不发送
    </button>
  )

  return (
    <section className="panel summary" aria-labelledby="summary-title">
      <header className="summary-head">
        <h2 id="summary-title" tabIndex={-1} ref={heading}>
          {counts.total} 篇看完了 · 喜欢 {counts.liked} · 不喜欢 {counts.disliked}
        </h2>
        <p className="muted">喜欢和不喜欢都已记下，明天的排序会参考它们。</p>
      </header>

      {catchingUp ? (
        <p className="status-line tone-busy" role="status">
          正在保存你的选择…
        </p>
      ) : null}

      {liked.length === 0 && !catchingUp ? (
        <div className="summary-empty">
          <p>{title}没有喜欢的论文。</p>
          <div className="button-row">
            <button type="button" className="btn btn-primary" aria-disabled={!armed} onClick={guard(onDone)}>
              <Check size={18} aria-hidden="true" /> 完成
            </button>
            {undoButton}
            {restartButton}
          </div>
        </div>
      ) : liked.length === 0 ? null : (
        <>
          <h3 className="list-title">喜欢的论文</h3>
          <ul className="liked-list" aria-label="喜欢的论文">
            {liked.map((item) => {
              const sent = item.sentGeneration !== undefined
              const inFlight = locked && !sent && !item.excluded
              return (
                <li key={item.paperId} className={`liked-row${item.excluded ? ' is-excluded' : ''}`}>
                  <div className="liked-text">
                    <button type="button" className="liked-title" lang="en" onClick={() => setPreview(cardFor(item.paperId))}>
                      {item.title}
                    </button>
                    {item.briefLine ? <p className="liked-brief">{item.briefLine}</p> : null}
                    {sent ? <span className="badge badge-ok">已发送</span> : null}
                    {inFlight ? <span className="badge badge-info">发送中</span> : null}
                    {item.excluded ? <span className="badge">不发送</span> : null}
                  </div>
                  {!sent ? (
                    <button
                      type="button"
                      className="btn btn-quiet btn-small"
                      disabled={locked || exclude.isPending || catchingUp}
                      aria-label={`${item.excluded ? '恢复' : '移出'}：${item.title}`}
                      onClick={() => exclude.mutate(item)}
                    >
                      {item.excluded ? '恢复' : '移出'}
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>

          {showConfirm ? (
            <div className="send-box" role="group" aria-labelledby="send-title">
              <h3 id="send-title">{delivered ? `补发新增的 ${sendable} 篇？` : '发送到 Todofy？'}</h3>
              <fieldset className="segmented">
                <legend className="sr-only">发送方式</legend>
                <label className={mode === SendMode.SUBTASKS ? 'is-on' : ''}>
                  <input type="radio" name={modeName} value="subtasks" checked={mode === SendMode.SUBTASKS} onChange={() => setMode(SendMode.SUBTASKS)} />
                  一个父任务 + 子任务
                </label>
                <label className={mode === SendMode.SEPARATE ? 'is-on' : ''}>
                  <input type="radio" name={modeName} value="separate" checked={mode === SendMode.SEPARATE} onChange={() => setMode(SendMode.SEPARATE)} />
                  每篇单独一条
                </label>
              </fieldset>
              <p className="send-preview" data-testid="send-preview">
                {catchingUp ? '正在保存你的选择…' : sendPreview(mode, day, sendable, nextGeneration)}
              </p>
              <div className="button-row send-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={send.isPending || sendable === 0 || catchingUp}
                  aria-disabled={!armed}
                  onClick={guard(() => send.mutate(mode))}
                >
                  <Send size={18} aria-hidden="true" /> {delivered ? `补发新增的 ${sendable} 篇` : '发送到 Todofy'}
                </button>
                {confirmOpen && !send.isPending ? laterButton : null}
              </div>
            </div>
          ) : sendable === 0 && !shown ? (
            <p className="muted">全部移出了，这次没有要发送的论文。</p>
          ) : null}

          {locked && shown ? <p className="muted small">内容已固定：重试会原样重发，Todofy 不会重复创建。</p> : null}

          <div className="send-status" aria-live="polite" data-testid="send-status">
            {send.isPending ? <p className="status-line tone-busy">正在发送…</p> : null}
            {!send.isPending && sendError ? <p className="status-line tone-danger">{sendError}</p> : null}
            {!send.isPending && !sendError && copy ? <p className={`status-line tone-${copy.tone}`}>{copy.text}</p> : null}
          </div>

          <div className="button-row summary-actions">
            {!send.isPending && sendError && !showConfirm ? (
              <button type="button" className="btn btn-primary" aria-disabled={!armed} onClick={guard(() => send.mutate(shown?.frozen ? shown.mode : mode))}>
                重试（不会重复创建）
              </button>
            ) : null}
            {!send.isPending && !sendError && copy
              ? copy.actions
                  .filter((action) => !(showConfirm && (action === 'resend' || action === 'back')))
                  .map((action) => (
                    <button
                      key={action}
                      type="button"
                      className={action === 'later' ? 'btn btn-quiet' : 'btn btn-primary'}
                      aria-disabled={!armed}
                      onClick={guard(() => runAction(action))}
                    >
                      {ACTION_LABEL[action]}
                    </button>
                  ))
              : null}
            {confirmOpen && !send.isPending && !showConfirm ? laterButton : null}
            {undoButton}
            {!send.isPending && !settlingNow ? restartButton : null}
          </div>
        </>
      )}

      {preview ? (
        <Modal title="论文卡片" onClose={() => setPreview(null)} variant="sheet">
          <ReadOnlyCard card={preview} deck={deck} />
        </Modal>
      ) : null}
    </section>
  )
}

function ReadOnlyCard({ card, deck }: { card: Card; deck: Deck }) {
  const [expanded, setExpanded] = useState(false)
  const titleId = useId()
  return (
    <article className="paper-card paper-card-static" aria-labelledby={titleId}>
      <PaperCardBody card={card} kind={deck.kind} expanded={expanded} onToggle={() => setExpanded((value) => !value)} titleId={titleId} interactive />
    </article>
  )
}
