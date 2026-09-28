import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { AlertCircle, ArrowRight, Check, ChevronRight, Copy, Inbox, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { ApiError } from '../api/client'
import type { DeliveryState, ParseState } from '../api/types'

export function Button({ children, variant = 'primary', loading, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; loading?: boolean }) {
  return <button className={`button button-${variant}`} {...props} disabled={props.disabled || loading}>
    {loading ? <LoaderCircle className="spin" size={16} aria-hidden /> : null}{children}
  </button>
}

export function PageHead({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="page-head-action">{action}</div>}</div>
}

const deliveryLabels: Record<string, string> = {
  none: '未安排', unarranged: '未安排', pending: '等待交付', sending: '正在交付', retry_wait: '等待重试', delivered: '已交付', failed: '已停止', cancelled: '已取消', paused: '已暂停',
}
const parseLabels: Record<string, string> = { pending: '待解析', parsing: '解析中', ready: '可阅读', failed: '需处理' }

export function Status({ state, kind = 'delivery' }: { state?: DeliveryState | ParseState | string | null; kind?: 'delivery' | 'parse' }) {
  const value = state || (kind === 'parse' ? 'pending' : 'none')
  const label = kind === 'parse' ? parseLabels[value] : deliveryLabels[value]
  const tone = ['delivered', 'ready'].includes(value) ? 'ok' : ['failed', 'cancelled'].includes(value) ? 'bad' : ['retry_wait', 'paused'].includes(value) ? 'warn' : 'neutral'
  return <span className={`status status-${tone}`}><span className="status-dot" aria-hidden />{label || value}</span>
}

export function Empty({ title, detail, icon, action }: { title: string; detail?: string; icon?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon || <Inbox size={25} />}</div><h2>{title}</h2>{detail && <p>{detail}</p>}{action && <div className="empty-action">{action}</div>}</div>
}

export function Loading({ label = '正在加载…' }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" size={19} />{label}</div>
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const apiError = error instanceof ApiError ? error : null
  const message = apiError?.status === 401 ? '登录已过期，请重新通过访问入口登录。' : apiError?.message || '发生了意外错误。'
  return <div className="error-state" role="alert"><AlertCircle size={20} /><div><strong>{apiError?.status === 401 ? '需要重新登录' : '无法加载内容'}</strong><p>{message}</p>{apiError?.requestId && <small>请求编号：{apiError.requestId}</small>}</div>{retry && <Button variant="secondary" onClick={retry}><RefreshCw size={15} />重试</Button>}</div>
}

export function Modal({ title, children, onClose, footer, danger = false }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; danger?: boolean }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onCloseRef.current(); return }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') || [])]
      if (!focusable.length) return
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-heading"><div className={`modal-mark ${danger ? 'modal-mark-danger' : ''}`}>{danger ? <AlertCircle size={20} /> : <ChevronRight size={20} />}</div><h2>{title}</h2><button ref={closeRef} className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={18} /></button></div>
    <div className="modal-body">{children}</div>{footer && <div className="modal-footer">{footer}</div>}
  </div></div>
}

export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  return <button className="copy-button" onClick={async () => { try { await navigator.clipboard.writeText(value); const button = document.activeElement as HTMLButtonElement; if (button) { button.dataset.copied = 'true'; setTimeout(() => { button.dataset.copied = 'false' }, 1600) } } catch { /* Browser may deny clipboard. */ } }} title={label} aria-label={label}>
    <Copy size={15} className="copy-icon" /><Check size={15} className="check-icon"/><span>{label}</span>
  </button>
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) { return <div className="info-row"><dt>{label}</dt><dd>{children}</dd></div> }
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`card ${className}`}>{children}</section> }
export function SectionTitle({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) { return <div className="section-title"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{action}</div> }
export function MoreLink({ to, children }: { to: string; children: ReactNode }) { return <a className="text-link" href={to}>{children}<ArrowRight size={15} /></a> }

export function formatDate(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  if (date.getUTCFullYear() < 1970) return '—'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
// A zone's short name at `date` (the browser zone unless timeZone is given):
// PDT/PST for US zones, GMT+8 style elsewhere.
export function zoneAbbreviation(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value ?? ''
}
// An exact instant in the browser's zone (or timeZone), with the abbreviation that applied then.
export function formatInstant(value: string, timeZone?: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const zone = zoneAbbreviation(date, timeZone)
  return `${new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)}${zone ? ` ${zone}` : ''}`
}
export function formatBytes(value?: number | null): string {
  if (value === undefined || value === null) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}
