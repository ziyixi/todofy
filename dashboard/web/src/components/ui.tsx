import { CircleAlert, CircleCheck, CircleDashed, Info, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { formatFullTime, formatRelative, formatTime } from '../lib/format'
import { counterInfo, type Tone } from '../lib/labels'
import { Mark, toneShape } from './status'

const NOTICE_ICON = {
  ok: CircleCheck,
  warn: TriangleAlert,
  danger: CircleAlert,
  info: Info,
  neutral: CircleDashed,
} as const

/** A status label: shape + text, coloured by tone. The text carries the meaning, never the colour alone. */
export function Pill({ tone, children, strong = false }: { tone: Tone; children: ReactNode; strong?: boolean }) {
  return (
    <span className={`pill pill-${tone}${strong ? ' pill-strong' : ''}`}>
      <Mark shape={toneShape(tone)} tone={tone} size={10} />
      <span>{children}</span>
    </span>
  )
}

export function Card({
  title,
  id,
  actions,
  children,
  className = '',
  level = 3,
}: {
  title: ReactNode
  id?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** Heading level of the title (views have an h2, their cards h3). */
  level?: 2 | 3
}) {
  const headingId = id ? `${id}-title` : undefined
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <section className={`card ${className}`} id={id} aria-labelledby={headingId}>
      <div className="card-head">
        <Heading id={headingId}>{title}</Heading>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }

export function Button({ variant = 'secondary', className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`btn btn-${variant} ${className}`} {...rest} />
}

/** A time in the browser's time zone with its relative form; the full timestamp on hover. */
export function Time({ iso, now, relative = true }: { iso: string; now: Date; relative?: boolean }) {
  return (
    <time dateTime={iso} title={formatFullTime(iso)}>
      {formatTime(iso, now)}
      {relative ? <span className="muted">（{formatRelative(iso, now)}）</span> : null}
    </time>
  )
}

/** Plain-text inline notice; `role="alert"` only for errors the owner must see now. */
export function Notice({ tone, children, alert = false }: { tone: Tone; children: ReactNode; alert?: boolean }) {
  const Icon = NOTICE_ICON[tone]
  return (
    <div className={`notice notice-${tone}`} role={alert ? 'alert' : undefined}>
      <Icon size={16} aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}

/** Key/value rows. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="facts">{children}</dl>
}

export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** The current time, re-read every `intervalMs` so relative times and the refresh gate stay current. */
export function useNow(intervalMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

const metricNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

/** Numeric metrics of a signal or digest item, e.g. "waiting_deliveries 3 · current_blocked 1". */
export function Metrics({ metrics }: { metrics: Readonly<Record<string, number>> }) {
  const entries = Object.entries(metrics)
  if (entries.length === 0) return null
  return (
    <ul className="metrics" aria-label="指标">
      {entries.map(([key, value]) => (
        <li key={key}>
          <span title={key}>{counterInfo(key).label}</span> {metricNumber.format(value)}
        </li>
      ))}
    </ul>
  )
}
