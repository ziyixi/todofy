import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Attention, AttentionItem, Target } from '../../../worker/src/api-types.ts'
import { ApiError, newRequestId } from '../api/client'
import { useAttentionAction } from '../api/queries'
import { alertGuidance } from '../lib/alert-guidance'
import { Button, Pill } from './ui'

const AttentionContext = createContext<Attention | undefined>(undefined)
const FeedbackContext = createContext<{ message: string | null; ref: RefObject<HTMLParagraphElement | null>; saved: (message: string) => void } | undefined>(undefined)

export function useAttention(): Attention | undefined { return useContext(AttentionContext) }

export function AttentionProvider({ attention, children }: { attention?: Attention | undefined; children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null)
  const ref = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), 8_000)
    return () => window.clearTimeout(timer)
  }, [message])
  function saved(text: string) {
    setMessage(text)
    ref.current?.focus({ preventScroll: true })
  }
  return <AttentionContext.Provider value={attention}>
    <FeedbackContext.Provider value={{ message, ref, saved }}>{children}</FeedbackContext.Provider>
  </AttentionContext.Provider>
}

export function AttentionFeedback() {
  const feedback = useContext(FeedbackContext)
  return <p ref={feedback?.ref} className={feedback?.message ? 'attention-feedback small' : 'visually-hidden'}
    role="status" aria-live="polite" aria-atomic="true" tabIndex={-1}>{feedback?.message}</p>
}

/** Partial target matches are only accepted when exactly one occurrence fits. */
export function attentionFor(attention: Attention | undefined, source: string, code: string, target: Partial<Target> = {}): AttentionItem | undefined {
  const items = [...(attention?.items ?? []), ...(attention?.dismissed_items ?? [])]
  const matches = items.filter(item => item.source === source && item.code === code &&
    Object.entries(target).every(([key, value]) => value === undefined || item.target[key as keyof Target] === value))
  return matches.length === 1 ? matches[0] : undefined
}

export function useAttentionFor(source: string, code: string, target?: Partial<Target>): AttentionItem | undefined {
  return attentionFor(useContext(AttentionContext), source, code, target)
}

export function useSignalsDismissed(source: string, signals: readonly { code: string; severity: string }[]): boolean {
  const attention = useContext(AttentionContext)
  const actionable = signals.filter(signal => signal.severity !== 'info')
  const pending = attention?.items.some(item => item.source === source || item.target.entry === source)
  return !pending && actionable.length > 0 && actionable.every(signal =>
    attentionFor(attention, source, signal.code, { entry: source })?.dismissed_at !== undefined)
}

export function targetDismissed(attention: Attention | undefined, target: Partial<Target>): boolean {
  const matches = (item: AttentionItem) => Object.entries(target).every(([key, value]) =>
    value === undefined || item.target[key as keyof Target] === value)
  const dismissed = attention?.dismissed_items?.filter(matches) ?? []
  const sources = new Set(dismissed.map(item => item.source))
  const entries = new Set(dismissed.map(item => item.target.entry))
  return dismissed.length > 0 && !attention?.items.some(item => matches(item) || sources.has(item.source) || (item.target.entry !== undefined && entries.has(item.target.entry)))
}

export function useTargetDismissed(target: Partial<Target>): boolean {
  return targetDismissed(useContext(AttentionContext), target)
}

function Controls({ item }: { item: AttentionItem & { name: string; etag: string } }) {
  const feedback = useContext(FeedbackContext)
  const [error, setError] = useState<string | null>(null)
  const dismissed = item.dismissed_at !== undefined
  const action = useAttentionAction(() => feedback?.saved(dismissed ? '已恢复这项提醒。' : '本次提醒已关闭，刷新和重启后仍有效。'))
  const count = item.code === 'newsletter_unknown' ? item.metrics.unknown_count : undefined
  const label = dismissed ? '恢复提醒' : typeof count === 'number' ? `不再提醒这批 ${count} 条记录` : '关闭本次提醒'

  function apply() {
    setError(null)
    action.mutate({ name: item.name, etag: item.etag, requestId: newRequestId(), restore: dismissed }, {
      onError: failure => setError(failure instanceof ApiError ? failure.message : '操作失败，请稍后重试。'),
    })
  }

  return (
    <div className="attention-controls">
      {dismissed ? <Pill tone="neutral">本批已忽略提醒</Pill> : null}
      <Button onClick={apply} disabled={action.isPending}>{action.isPending ? '保存中…' : label}</Button>
      {error ? <p className="small" role="alert">{error}</p> : null}
    </div>
  )
}

export function AttentionActions({ item }: { item: AttentionItem }) {
  const guidance = alertGuidance(item.code)
  return (
    <div className={`attention-help${item.dismissed_at ? ' attention-help-dismissed' : ''}`}>
      <p className="small">{guidance.explanation}</p>
      <p className="small muted">下一步：{guidance.next}</p>
      {item.name && item.etag ? <Controls key={item.etag} item={{ ...item, name: item.name, etag: item.etag }} /> : null}
    </div>
  )
}

/** The raw health signal remains visible, with its current reminder state beside it. */
export function SignalActions({ source, code, target }: { source: string; code: string; target?: Partial<Target> }) {
  const item = useAttentionFor(source, code, target)
  const guidance = alertGuidance(code)
  return item ? <AttentionActions item={item} />
    : <p className="small muted">{guidance.explanation} 下一步：{guidance.next}</p>
}
