/**
 * The UI's components (styles.css draws them), copied from mailsort's UI with the same names (../../docs/design.md
 * §8.2): a card, a KPI number, a meter, a segmented control, a disclosure, a small ⋯ menu, an empty state, the
 * keys hint, skeleton rows, the error line with 重试 and the searchable picker. New in recall: the site badge. Plain
 * DOM, text only ever as text.
 */
import { button, el, type Child } from './dom.ts'

/** A card: one section of a page, its title and an optional figure or note on the right. */
export function card(title: string, meta: string, ...children: Child[]): HTMLElement {
  return el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, title), meta === '' ? null : el('span', { class: 'meta' }, meta)), ...children)
}

/** One KPI: a short label over its number. */
export function kpi(label: string, value: string): HTMLElement {
  return el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, label), el('span', { class: 'kpi-value' }, value))
}

/** The share of `value` in `max` as a CSS width, within 0-100 %. */
function width(value: number, max: number): string {
  return `${String(max <= 0 ? 0 : Math.round(Math.min(1, Math.max(0, value / max)) * 100))}%`
}

/** A thin meter of `value` out of `max`, named for assistive technology. */
export function meter(value: number, max: number, label: string, tone: '' | 'warn' | 'danger' = ''): HTMLElement {
  const fill = el('span')
  fill.style.width = width(value, max)
  return el('span', { class: tone === '' ? 'meter' : `meter ${tone}`, role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(Math.round(value)) }, fill)
}

/** One choice of a few: buttons in a group, the current one pressed. */
export function segmented<T>(label: string, options: readonly (readonly [T, string])[], current: T | null, choose: (value: T) => void): HTMLElement {
  return el(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': label },
    ...options.map(([value, text]) => button(text, () => choose(value), { 'aria-pressed': value === current ? 'true' : 'false' })),
  )
}

/** A disclosure: `summary` opens the rest. */
export function disclosure(summary: string, ...children: Child[]): HTMLDetailsElement {
  return el('details', { class: 'more' }, el('summary', {}, summary), ...children)
}

/** One action of a menu: its text, what it does, and `danger` for one that deletes. */
export type MenuAction = readonly [text: string, run: () => void, tone?: 'danger']

let menus = 0

/** The open menu's close: one menu is open at a time. */
let closeOpenMenu: (() => void) | null = null

/**
 * A small menu behind ⋯ (`name` is its name for assistive technology): it shows its actions inline beside it; a
 * choice, Escape, a click outside it, a key that takes the focus out of it (Tab) or another menu opening closes it.
 */
export function menu(name: string, actions: readonly MenuAction[]): HTMLElement {
  menus += 1
  const id = `menu-${String(menus)}`
  const items = el('span', { id, class: 'menu-items', hidden: true })
  const opener = button('⋯', () => {
    if (items.hidden) open()
    else close()
  }, { class: 'quiet icon', 'aria-label': name, 'aria-expanded': 'false', 'aria-controls': id })
  const box = el('span', { class: 'menu' }, items, opener)
  // Once a click or a key is done, not on a focus change: an open menu widens its line, and closing it as a press
  // moves the focus would move what that very click lands on.
  const outside = (event: Event) => {
    const node = event.type === 'click' ? event.target : document.activeElement
    if (!(node instanceof Node && box.contains(node))) close()
  }
  const close = () => {
    items.hidden = true
    opener.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', outside)
    document.removeEventListener('keyup', outside)
    if (closeOpenMenu === close) closeOpenMenu = null
  }
  const open = () => {
    closeOpenMenu?.()
    closeOpenMenu = close
    items.hidden = false
    opener.setAttribute('aria-expanded', 'true')
    document.addEventListener('click', outside)
    document.addEventListener('keyup', outside)
    items.querySelector('button')?.focus()
  }
  items.append(
    ...actions.map(([text, run, tone]) =>
      button(text, () => {
        close()
        run()
      }, { class: tone === undefined ? 'quiet small' : `quiet small ${tone}` }),
    ),
  )
  items.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
    opener.focus()
  })
  return box
}

/** The empty state: one line, an optional hint under it, and what follows (its actions). */
export function emptyState(title: string, hint = '', ...children: Child[]): HTMLElement {
  return el('div', { class: 'empty' }, el('strong', {}, title), hint === '' ? null : el('span', {}, hint), ...children)
}

/** The keyboard hint, shown where there is a keyboard (styles.css .keys): pairs of keys and what they do. */
export function keys(...pairs: readonly (readonly [readonly string[], string])[]): HTMLElement {
  const parts: Child[] = []
  pairs.forEach(([names, what], index) => {
    if (index > 0) parts.push(' · ')
    names.forEach((name, i) => {
      if (i > 0) parts.push(' ')
      parts.push(el('kbd', {}, name))
    })
    parts.push(` ${what}`)
  })
  return el('p', { class: 'hint keys' }, ...parts)
}

/** Loading: `count` grey rows in the list's shape (never a spinner over the page). */
export function skeleton(count: number): HTMLElement {
  return el('ul', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': '加载中' }, ...Array.from({ length: count }, () => el('li', {}, el('span'), el('span'))))
}

/** A failure where the content would be: its message and 重试. */
export function errorLine(message: string, retry: () => void): HTMLElement {
  return el('p', { class: 'error-line', role: 'alert' }, el('span', {}, message), button('重试', retry, { class: 'small' }))
}

/** A site's badge: its initial on a circle of its color slot (sessions.ts siteSlots; 0 is muted). Decorative. */
export function siteBadge(site: string, slot: number): HTMLElement {
  const initial = Array.from(site.replace(/^www\./, ''))[0]?.toUpperCase() ?? '·'
  return el('span', { class: `badge s${String(slot)}`, 'aria-hidden': 'true' }, initial)
}

export interface PickerOption {
  readonly value: string
  readonly text: string
}

let pickers = 0

/**
 * The searchable picker: a search box over a list of options. Typing filters (`options` answers the options of what
 * was typed, at once or when the server's prefix filter answers); ↑ ↓ move, Enter or a click chooses (Enter with
 * nothing to choose takes what was typed, when `typed` accepts it), Escape cancels.
 */
export function picker(
  name: string,
  placeholder: string,
  options: (typed: string) => Promise<readonly PickerOption[]>,
  pick: (value: string) => void,
  cancel: () => void,
  typed: (text: string) => string | null,
): HTMLElement {
  pickers += 1
  const id = `picker-${String(pickers)}`
  const input = el('input', { type: 'search', placeholder, 'aria-label': name, role: 'combobox', 'aria-expanded': 'true', 'aria-controls': id, 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none' })
  const list = el('ul', { id, role: 'listbox', 'aria-label': name })
  let shown: readonly PickerOption[] = []
  let active = 0
  let asked = 0
  const paint = () => {
    active = Math.min(active, Math.max(0, shown.length - 1))
    list.replaceChildren(
      ...shown.map((option, index) => {
        const item = el('li', { id: `${id}-${String(index)}`, role: 'option', 'aria-selected': index === active ? 'true' : 'false' }, option.text)
        item.addEventListener('click', () => {
          pick(option.value)
        })
        return item
      }),
    )
    if (shown.length === 0) {
      list.append(el('li', { class: 'none' }, input.value.trim() === '' ? '还没有网站' : typed(input.value) === null ? '没有这个网站' : '按 Enter 用这个网站'))
      input.removeAttribute('aria-activedescendant')
    } else {
      input.setAttribute('aria-activedescendant', `${id}-${String(active)}`)
    }
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }
  const refresh = async () => {
    asked += 1
    const mine = asked
    const answer = await options(input.value.trim())
    // A slower answer to an older text never replaces a newer one.
    if (mine !== asked) return
    shown = answer
    paint()
  }
  input.addEventListener('input', () => {
    active = 0
    void refresh()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (shown.length > 0) active = (active + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length
      paint()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const chosen = shown[active]
      const own = typed(input.value)
      if (chosen !== undefined) pick(chosen.value)
      else if (own !== null) pick(own)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  })
  void refresh()
  return el('div', { class: 'picker' }, input, list)
}
