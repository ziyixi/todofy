/** The deck's progress map, action bar, menu and shortcuts sheet (docs/ux.md §3). */
import { MoreHorizontal, RotateCcw, ThumbsDown, ThumbsUp, Undo2, Keyboard } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Decision, DeckCard } from '../../../worker/src/api-types.ts'
import type { Decisions } from '../lib/deckModel'
import { SHORTCUTS } from '../lib/keys'
import { Modal } from './Modal'

export function DeckProgress({ cards, decisions, currentId }: { cards: readonly DeckCard[]; decisions: Decisions; currentId: string | null }) {
  const total = cards.length
  let decided = 0
  let liked = 0
  for (const card of cards) {
    const decision = decisions[card.paper.id]
    if (decision) decided += 1
    if (decision === 'like') liked += 1
  }
  const position = Math.min(decided + 1, total)
  return (
    <div className="deck-progress">
      <ol className="progress-segments" aria-hidden="true">
        {cards.map((card) => {
          const decision = decisions[card.paper.id]
          const state = decision ?? (card.paper.id === currentId ? 'current' : 'open')
          return <li key={card.paper.id} className={`segment segment-${state}`} />
        })}
      </ol>
      <p className="progress-text" data-testid="progress">
        <span className="sr-only">第 </span>
        {position} / {total}
        <span className="sr-only"> 篇</span> · 已喜欢 {liked}
      </p>
    </div>
  )
}

interface ActionBarProps {
  readonly onDecide: (decision: Decision) => void
  readonly onUndo: () => void
  readonly canUndo: boolean
  readonly undoBusy: boolean
  readonly lean: Decision | null
  readonly disabled: boolean
}

export function ActionBar({ onDecide, onUndo, canUndo, undoBusy, lean, disabled }: ActionBarProps) {
  return (
    <div className="action-bar" role="group" aria-label="操作">
      <div className="action-slot">
        <button type="button" className="btn-undo" onClick={onUndo} disabled={!canUndo} aria-label={undoBusy ? '撤销（同步中）' : '撤销'}>
          <Undo2 size={20} aria-hidden="true" />
          <span>撤销</span>
        </button>
        <kbd className="key-hint" aria-hidden="true">
          Z
        </kbd>
      </div>
      <div className="action-slot">
        <button
          type="button"
          className={`btn-round btn-dislike${lean === 'dislike' ? ' is-lean' : ''}`}
          onClick={() => onDecide('dislike')}
          disabled={disabled}
        >
          <ThumbsDown size={24} aria-hidden="true" />
          <span>不喜欢</span>
        </button>
        <kbd className="key-hint" aria-hidden="true">
          ←
        </kbd>
      </div>
      <div className="action-slot">
        <button
          type="button"
          className={`btn-round btn-like${lean === 'like' ? ' is-lean' : ''}`}
          onClick={() => onDecide('like')}
          disabled={disabled}
        >
          <ThumbsUp size={24} aria-hidden="true" />
          <span>喜欢</span>
        </button>
        <kbd className="key-hint" aria-hidden="true">
          →
        </kbd>
      </div>
    </div>
  )
}

/** The deck's "更多" menu: 重来 and the shortcuts. */
export function DeckMenu({ onRestart, canRestart, onShortcuts }: { onRestart: () => void; canRestart: boolean; onShortcuts: () => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDown(event: PointerEvent) {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div className="menu" ref={root}>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="更多" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((value) => !value)}>
        <MoreHorizontal size={20} aria-hidden="true" />
      </button>
      {open ? (
        <div className="menu-panel">
          <button
            type="button"
            className="menu-item"
            disabled={!canRestart}
            onClick={() => {
              setOpen(false)
              onRestart()
            }}
          >
            <RotateCcw size={18} aria-hidden="true" /> 重来这组
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              onShortcuts()
            }}
          >
            <Keyboard size={18} aria-hidden="true" /> 键盘快捷键
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="键盘快捷键" onClose={onClose} variant="sheet">
      <dl className="shortcuts">
        {SHORTCUTS.map((row) => (
          <div key={row.label} className="shortcut-row">
            <dt>
              {row.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </dt>
            <dd>{row.label}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">手机上左右滑动卡片即可；每一步都能撤销。</p>
    </Modal>
  )
}
