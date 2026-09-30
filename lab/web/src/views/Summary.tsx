/**
 * End of deck (docs/ux.md §5): the liked papers (each can be taken out of this send), the send mode with a
 * live preview, and the only confirmation in the app, "发送到 Todofy？". Sending is explicit and idempotent:
 * the Worker freezes the content before calling Todofy, a retry resends the same intent, and the status line
 * follows every task-intent-v1 state. Papers liked after a delivered send go out as a separate 补发.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, RotateCcw, Send } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import type { Day, Deck, DeckCard, DeckSummary, SendMode, SendStatus, SummaryItem } from '../../../worker/src/api-types.ts'
import { SEND_POLL_MIN_SECONDS } from '../../../worker/src/api-types.ts'
import { ApiError, api, errorMessage, withRetry } from '../api/client'
import { useFeedback } from '../components/Feedback'
import { Modal } from '../components/Modal'
import { PaperCardBody } from '../components/PaperCard'
import { formatDay, newOpId, sendPreview } from '../lib/format'
import { isDelivered, isLocked, sendCopy, type SendAction } from '../lib/sendCopy'

/** The newer of two views of the deck's send (a higher generation, else the later update). */
export function newerSend(a: SendStatus | null, b: SendStatus | null): SendStatus | null {
  if (!a) return b
  if (!b) return a
  if (a.generation !== b.generation) return a.generation > b.generation ? a : b
  return Date.parse(b.updated_at) >= Date.parse(a.updated_at) ? b : a
}

/** Follows a send while it settles: GET …/send when poll_after is due (≥ 3 s), only while the page is visible. */
function useSendStatus(day: Day, initial: SendStatus | null) {
  const client = useQueryClient()
  const [status, setStatus] = useState<SendStatus | null>(initial)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')

  useEffect(() => {
    setStatus((current) => newerSend(current, initial))
  }, [initial])

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const pollAfter = status?.poll_after ?? null
  const updatedAt = status?.updated_at
  useEffect(() => {
    if (!pollAfter || !visible) return
    const wait = Math.max(SEND_POLL_MIN_SECONDS * 1000, Date.parse(pollAfter) - Date.now())
    let live = true
    const timer = window.setTimeout(() => {
      api
        .sendStatus(day)
        .then((next) => {
          if (live) setStatus((current) => newerSend(current, next))
        })
        .catch(() => {
          // Keep the last status; the next poll or a reload tries again.
          if (live) setStatus((current) => (current ? { ...current, updated_at: new Date().toISOString() } : current))
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

  const adopt = useCallback((next: SendStatus) => setStatus((current) => newerSend(current, next)), [])
  return { status, adopt }
}

interface SummaryViewProps {
  readonly day: Day
  readonly deck: Deck
  readonly isToday: boolean
  readonly onDone: () => void
  readonly onRestart: () => void
}

export function SummaryView({ day, deck, isToday, onDone, onRestart }: SummaryViewProps) {
  const summaryQuery = useQuery({ queryKey: ['summary', day], queryFn: () => api.summary(day) })
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
  return <SummaryBody day={day} deck={deck} isToday={isToday} summary={summaryQuery.data} onDone={onDone} onRestart={onRestart} />
}

function SummaryBody({ day, deck, summary, isToday, onDone, onRestart }: SummaryViewProps & { summary: DeckSummary }) {
  const client = useQueryClient()
  const { announce, snack } = useFeedback()
  const { status, adopt } = useSendStatus(day, summary.send)
  const [mode, setMode] = useState<SendMode>(summary.send && isLocked(summary.send) ? summary.send.mode : summary.default_mode)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [preview, setPreview] = useState<DeckCard | null>(null)
  const modeName = useId()

  const counts = summary.state.counts
  const liked = summary.liked
  const statusKey = status ? `${status.generation}:${status.updated_at}` : null
  // A rejected send the owner dismissed with 返回: back to the editable confirm step.
  const shown = status && statusKey !== dismissed ? status : null
  const locked = isLocked(shown)
  const delivered = isDelivered(shown)
  const nextGeneration = delivered && shown ? shown.generation + 1 : (shown?.generation ?? 1)

  const exclude = useMutation({
    mutationFn: (item: SummaryItem) =>
      withRetry(() => api.exclude(day, { op_id: newOpId(), paper_id: item.paper_id, excluded: !item.excluded })),
    onMutate: (item) => {
      const before = client.getQueryData<DeckSummary>(['summary', day])
      if (before) {
        const listed = before.liked.map((row) => (row.paper_id === item.paper_id ? { ...row, excluded: !item.excluded } : row))
        const sendable = listed.filter((row) => !row.excluded && row.sent_generation === null).length
        client.setQueryData<DeckSummary>(['summary', day], { ...before, liked: listed, sendable })
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
    mutationFn: (chosen: SendMode) => {
      const body = { op_id: newOpId(), mode: chosen }
      return withRetry(() => api.send(day, body))
    },
    onMutate: () => setSendError(null),
    onSuccess: (next) => {
      adopt(next)
      announce(sendCopy(next).text)
      void client.invalidateQueries({ queryKey: ['summary', day] })
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === 'send_in_progress') {
        try {
          adopt(await api.sendStatus(day))
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
    mutationFn: () => withRetry(() => api.later(day, { op_id: newOpId() })),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['deck', day], refetchType: 'none' })
      onDone()
    },
  })

  const sendable = summary.sendable
  const copy = shown ? sendCopy(shown) : null
  const title = isToday ? '今天' : formatDay(day)

  function runAction(action: SendAction) {
    if (action === 'done') onDone()
    else if (action === 'back') setDismissed(statusKey)
    else if (action === 'retry' && shown) send.mutate(shown.mode)
    else send.mutate(mode)
  }

  const ACTION_LABEL: Readonly<Record<SendAction, string>> = {
    done: '完成',
    retry: '重试（不会重复创建）',
    resend: '再试一次',
    back: '返回',
  }

  const confirmOpen = !shown || (!locked && !delivered && (shown.state === 'paused' || shown.state === 'rejected') && !shown.recorded)
  const showConfirm = sendable > 0 && (confirmOpen || (delivered && !send.isPending))
  // While Todofy is still creating, the only thing to do is wait (docs/ux.md §5: no actions).
  const settlingNow = shown !== null && (shown.state === 'sending' || shown.state === 'pending')
  const cardFor = (paperId: string) => deck.cards.find((card) => card.paper.id === paperId) ?? null

  return (
    <section className="panel summary" aria-labelledby="summary-title">
      <header className="summary-head">
        <h2 id="summary-title" tabIndex={-1}>
          {counts.total} 篇看完了 · 喜欢 {counts.liked} · 不喜欢 {counts.disliked}
        </h2>
        <p className="muted">喜欢和不喜欢都已记下，明天的排序会参考它们。</p>
      </header>

      {liked.length === 0 ? (
        <div className="summary-empty">
          <p>{title}没有喜欢的论文。</p>
          <div className="button-row">
            <button type="button" className="btn btn-primary" onClick={onDone}>
              <Check size={18} aria-hidden="true" /> 完成
            </button>
            <button type="button" className="btn btn-quiet" onClick={onRestart}>
              <RotateCcw size={18} aria-hidden="true" /> 回到卡片重来
            </button>
          </div>
        </div>
      ) : (
        <>
          <h3 className="list-title">喜欢的论文</h3>
          <ul className="liked-list" aria-label="喜欢的论文">
            {liked.map((item) => {
              const sent = item.sent_generation !== null
              const inFlight = locked && !sent && !item.excluded
              return (
                <li key={item.paper_id} className={`liked-row${item.excluded ? ' is-excluded' : ''}`}>
                  <div className="liked-text">
                    <button type="button" className="liked-title" lang="en" onClick={() => setPreview(cardFor(item.paper_id))}>
                      {item.title}
                    </button>
                    {item.brief_line ? <p className="liked-brief">{item.brief_line}</p> : null}
                    {sent ? <span className="badge badge-ok">已发送</span> : null}
                    {inFlight ? <span className="badge badge-info">发送中</span> : null}
                    {item.excluded ? <span className="badge">不发送</span> : null}
                  </div>
                  {!sent ? (
                    <button
                      type="button"
                      className="btn btn-quiet btn-small"
                      disabled={locked || exclude.isPending}
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
            <div className="send-box">
              <h3>{delivered ? `补发新增的 ${sendable} 篇？` : '发送到 Todofy？'}</h3>
              <fieldset className="segmented">
                <legend className="sr-only">发送方式</legend>
                <label className={mode === 'subtasks' ? 'is-on' : ''}>
                  <input type="radio" name={modeName} value="subtasks" checked={mode === 'subtasks'} onChange={() => setMode('subtasks')} />
                  一个父任务 + 子任务
                </label>
                <label className={mode === 'separate' ? 'is-on' : ''}>
                  <input type="radio" name={modeName} value="separate" checked={mode === 'separate'} onChange={() => setMode('separate')} />
                  每篇单独一条
                </label>
              </fieldset>
              <p className="send-preview" data-testid="send-preview">
                {sendPreview(mode, day, sendable, nextGeneration)}
              </p>
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
            {showConfirm ? (
              <button type="button" className="btn btn-primary" disabled={send.isPending || sendable === 0} onClick={() => send.mutate(mode)}>
                <Send size={18} aria-hidden="true" /> {delivered ? `补发新增的 ${sendable} 篇` : '发送到 Todofy'}
              </button>
            ) : null}
            {!send.isPending && sendError && !showConfirm ? (
              <button type="button" className="btn btn-primary" onClick={() => send.mutate(shown?.frozen ? shown.mode : mode)}>
                重试（不会重复创建）
              </button>
            ) : null}
            {!send.isPending && !sendError && copy
              ? copy.actions
                  .filter((action) => !(showConfirm && (action === 'resend' || action === 'back')))
                  .map((action) => (
                    <button key={action} type="button" className="btn btn-primary" onClick={() => runAction(action)}>
                      {ACTION_LABEL[action]}
                    </button>
                  ))
              : null}
            {confirmOpen && !send.isPending ? (
              <button type="button" className="btn btn-quiet" disabled={later.isPending} onClick={() => later.mutate()}>
                暂不发送
              </button>
            ) : null}
            {!send.isPending && !settlingNow ? (
              <button type="button" className="btn btn-ghost" onClick={onRestart}>
                <RotateCcw size={18} aria-hidden="true" /> 回到卡片重来
              </button>
            ) : null}
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

function ReadOnlyCard({ card, deck }: { card: DeckCard; deck: Deck }) {
  const [expanded, setExpanded] = useState(false)
  const titleId = useId()
  return (
    <article className="paper-card paper-card-static" aria-labelledby={titleId}>
      <PaperCardBody card={card} kind={deck.kind} expanded={expanded} onToggle={() => setExpanded((value) => !value)} titleId={titleId} interactive />
    </article>
  )
}
