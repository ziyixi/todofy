import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './ui'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  /** Blocks Escape, the backdrop and the close button while a request is in flight. */
  busy?: boolean
}

/**
 * An accessible confirmation dialog (Todofy's pattern): focus moves in, Tab stays inside, Escape
 * closes, focus returns to the opener. A div dialog rather than <dialog> so jsdom tests exercise the
 * same focus code the browser runs.
 */
export function Modal({ title, onClose, children, footer, busy = false }: ModalProps) {
  const titleId = useId()
  const bodyId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  const blocked = useRef(busy)
  useEffect(() => {
    close.current = onClose
    blocked.current = busy
  })

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = panel.current
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !blocked.current) {
        event.preventDefault()
        close.current()
        return
      }
      if (event.key !== 'Tab' || !node) return
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const head = items[0] as HTMLElement
      const tail = items[items.length - 1] as HTMLElement
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault()
        tail.focus()
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault()
        head.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      // The opener can be gone or disabled by the new state; then focus the page's main landmark.
      const usable = opener?.isConnected && !(opener instanceof HTMLButtonElement && opener.disabled)
      if (usable) opener.focus()
      else document.getElementById('main')?.focus()
    }
  }, [])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} ref={panel}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" className="btn-icon" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={18} aria-hidden="true" />
          </Button>
        </div>
        <div className="modal-body" id={bodyId}>
          {children}
        </div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>,
    document.body,
  )
}
