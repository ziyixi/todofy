import { Check, Copy, RefreshCw } from 'lucide-react'
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { ApiError } from '../api/client'
import { formatFullTime, formatRelative, formatTime } from '../lib/format'
import { errorHint, type Tone } from '../lib/labels'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export function Button({
  variant = 'secondary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type="button" className={['btn', `btn-${variant}`, className].filter(Boolean).join(' ')} {...props} />
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge tone-${tone}`}>{children}</span>
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card" aria-label={title}>
      <div className="card-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

export function Loading({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <p className="empty-title">{title}</p>
      {children ? <p className="muted">{children}</p> : null}
    </div>
  )
}

/** Every failure shows the error's reason and request ID so the owner can find it in the Worker logs. */
export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const failure =
    error instanceof ApiError ? error : new ApiError(0, 'BAD_RESPONSE', error instanceof Error ? error.message : String(error))
  return (
    <div className="error-panel" role="alert">
      <p className="error-message">{failure.message}</p>
      <p className="muted">{errorHint(failure.reason)}</p>
      <dl className="error-meta">
        <div>
          <dt>错误码</dt>
          <dd>
            <code>{failure.reason}</code>
            {failure.status ? <span className="muted"> · HTTP {failure.status}</span> : null}
          </dd>
        </div>
        <div>
          <dt>请求 ID</dt>
          <dd>{failure.requestId ? <code>{failure.requestId}</code> : <span className="muted">无</span>}</dd>
        </div>
      </dl>
      {onRetry ? (
        <Button onClick={onRetry}>
          <RefreshCw size={16} aria-hidden="true" />
          重试
        </Button>
      ) : null}
    </div>
  )
}

export function Time({ value, relative = false, empty = '—' }: { value: string | null | undefined; relative?: boolean; empty?: string }) {
  if (!value) return <span className="muted">{empty}</span>
  return (
    <time dateTime={value} title={formatFullTime(value)}>
      {relative ? formatRelative(value) : formatTime(value)}
    </time>
  )
}

export function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([term, value], index) => (
        <div key={index}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Meter({ label, value, max, detail }: { label: string; value: number; max: number; detail: ReactNode }) {
  const ratio = max > 0 ? Math.min(value / max, 1) : 0
  const tone: Tone = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok'
  return (
    <div className="meter">
      <div className="meter-label">
        <span>{label}</span>
        <span className="muted">{detail}</span>
      </div>
      <div
        className={`meter-track tone-${tone}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
      >
        <div className="meter-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  )
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <Button variant="ghost" className="btn-icon" onClick={copy} aria-label={copied ? `已复制${label}` : `复制${label}`}>
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
    </Button>
  )
}
