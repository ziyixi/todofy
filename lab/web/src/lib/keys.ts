/**
 * The deck's keyboard map (docs/ux.md §3): → / L 喜欢, ← / H 不喜欢, Space / Enter 展开摘要, Z / ⌘Z / Ctrl+Z
 * 撤销, O open arXiv, ? shortcuts, Esc close. Keys typed into a text field are never shortcuts, and Space /
 * Enter on a focused button or link keep their native meaning.
 */
export type DeckKeyAction = 'like' | 'dislike' | 'toggle' | 'undo' | 'open' | 'help' | 'close'

export interface KeyLike {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey?: boolean
  readonly target: EventTarget | null
  readonly isComposing?: boolean
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range'].includes(target.type)
  }
  return false
}

function isNativelyActivated(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest('button, a[href], summary, input, [role="button"], [role="radio"], [role="tab"]') !== null
}

export function deckKeyAction(event: KeyLike): DeckKeyAction | null {
  if (event.isComposing || event.altKey || isTextField(event.target)) return null
  const key = event.key
  const modified = event.metaKey || event.ctrlKey
  if (modified) {
    // ⌘Z / Ctrl+Z is undo; ⌘⇧Z (redo in other apps) and every other browser shortcut stay untouched.
    return (key === 'z' || key === 'Z') && !event.shiftKey ? 'undo' : null
  }
  switch (key) {
    case 'ArrowRight':
    case 'l':
    case 'L':
      return 'like'
    case 'ArrowLeft':
    case 'h':
    case 'H':
      return 'dislike'
    case 'z':
    case 'Z':
      return 'undo'
    case 'o':
    case 'O':
      return 'open'
    case '?':
      return 'help'
    case 'Escape':
      return 'close'
    case ' ':
    case 'Enter':
      return isNativelyActivated(event.target) ? null : 'toggle'
    default:
      return null
  }
}

/** The shortcuts sheet (the same table the keys above implement). */
export const SHORTCUTS: readonly { readonly keys: readonly string[]; readonly label: string }[] = [
  { keys: ['→', 'L'], label: '喜欢' },
  { keys: ['←', 'H'], label: '不喜欢' },
  { keys: ['Z', '⌘Z', 'Ctrl+Z'], label: '撤销上一步' },
  { keys: ['空格', 'Enter'], label: '展开 / 收起原文摘要' },
  { keys: ['O'], label: '在 arXiv 打开' },
  { keys: ['?'], label: '显示快捷键' },
  { keys: ['Esc'], label: '关闭' },
]
