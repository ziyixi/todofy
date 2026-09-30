/**
 * Page-wide feedback: one polite live region (screen-reader announcements, docs/ux.md §7) and one snackbar
 * at a time with an optional action ("已喜欢《…》 · 撤销", docs/ux.md §4). The snackbar is visual; whatever
 * it says is also announced through the live region, so it has no live role of its own. Its timer pauses
 * while the pointer or focus is on it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export interface SnackOptions {
  readonly text: string
  readonly action?: { readonly label: string; readonly run: () => void }
  /** Milliseconds; default 5000. */
  readonly duration?: number
  readonly tone?: 'default' | 'warn'
}

interface FeedbackApi {
  announce: (text: string) => void
  snack: (options: SnackOptions) => void
  dismissSnack: () => void
}

const FeedbackContext = createContext<FeedbackApi | null>(null)

export function useFeedback(): FeedbackApi {
  const value = useContext(FeedbackContext)
  if (!value) throw new Error('useFeedback outside <FeedbackProvider>')
  return value
}

interface Snack extends SnackOptions {
  readonly id: number
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('')
  const [snack, setSnack] = useState<Snack | null>(null)
  const counter = useRef(0)

  const announce = useCallback((text: string) => {
    // Clear first so the same sentence twice in a row is still read out.
    setMessage('')
    window.setTimeout(() => setMessage(text), 30)
  }, [])

  const snackFn = useCallback((options: SnackOptions) => {
    counter.current += 1
    setSnack({ ...options, id: counter.current })
  }, [])

  const dismissSnack = useCallback(() => setSnack(null), [])
  const api = useMemo(() => ({ announce, snack: snackFn, dismissSnack }), [announce, snackFn, dismissSnack])

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="live-region">
        {message}
      </div>
      {snack ? <Snackbar key={snack.id} snack={snack} onClose={dismissSnack} /> : null}
    </FeedbackContext.Provider>
  )
}

function Snackbar({ snack, onClose }: { snack: Snack; onClose: () => void }) {
  const [paused, setPaused] = useState(false)
  const remaining = useRef(snack.duration ?? 5000)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  useEffect(() => {
    if (paused) return
    const started = Date.now()
    const timer = window.setTimeout(() => close.current(), remaining.current)
    return () => {
      window.clearTimeout(timer)
      remaining.current = Math.max(1000, remaining.current - (Date.now() - started))
    }
  }, [paused])

  return (
    <div
      className={`snackbar${snack.tone === 'warn' ? ' snackbar-warn' : ''}`}
      data-testid="snackbar"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="snackbar-text">{snack.text}</span>
      {snack.action ? (
        <button
          type="button"
          className="snackbar-action"
          onClick={() => {
            snack.action?.run()
            onClose()
          }}
        >
          {snack.action.label}
        </button>
      ) : null}
    </div>
  )
}
