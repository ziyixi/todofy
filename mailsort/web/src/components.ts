/**
 * The UI's components (styles.css draws them): a card, a chip, a KPI number, a meter and a small bar, a segmented
 * control, a toggle switch, a disclosure, a small ⋯ menu, a textarea that grows with its text, an empty state and the
 * searchable label picker. Plain DOM, text only ever as text.
 */
import { button, el, type Child } from './dom.ts'

export type Tone = 'accent' | 'warn' | 'muted' | ''

/** A card: one section of a page, its title and an optional figure or note on the right. */
export function card(title: string, meta: string, ...children: Child[]): HTMLElement {
  return el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, title), meta === '' ? null : el('span', { class: 'meta' }, meta)), ...children)
}

/** A chip: a label, a kind or a mode. */
export function chip(text: string, tone: Tone = ''): HTMLElement {
  return el('span', { class: tone === '' ? 'chip' : `chip ${tone}` }, text)
}

/** One KPI: a short label over its number. */
export function kpi(label: string, value: number, attention = false): HTMLElement {
  return el('div', { class: attention ? 'kpi attention' : 'kpi' }, el('span', { class: 'kpi-label' }, label), el('span', { class: 'kpi-value' }, String(value)))
}

/** The share of `value` in `max` as a CSS width, within 0-100 %. */
function width(value: number, max: number): string {
  return `${String(max <= 0 ? 0 : Math.round(Math.min(1, Math.max(0, value / max)) * 100))}%`
}

/** A thin meter of `value` out of `max` (the model budget), named for assistive technology. */
export function meter(value: number, max: number, label: string, tone: '' | 'warn' | 'danger' = ''): HTMLElement {
  const fill = el('span')
  fill.style.width = width(value, max)
  return el('span', { class: tone === '' ? 'meter' : `meter ${tone}`, role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(Math.round(value)) }, fill)
}

/** A small bar of a share, 0 to 1 (a precision bound, a confidence); decorative, its number is shown beside it. */
export function bar(share: number, tone: '' | 'warn' = ''): HTMLElement {
  const fill = el('span')
  fill.style.width = width(share, 1)
  return el('span', { class: tone === '' ? 'bar' : `bar ${tone}`, 'aria-hidden': 'true' }, fill)
}

/** One choice of a few: buttons in a group, the current one pressed. */
export function segmented<T>(label: string, options: readonly (readonly [T, string])[], current: T, choose: (value: T) => void): HTMLElement {
  return el(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': label },
    ...options.map(([value, text]) => button(text, () => choose(value), { 'aria-pressed': value === current ? 'true' : 'false' })),
  )
}

/** A toggle switch with its name and an optional one-line hint; the input is returned to read `checked`. */
export function toggle(name: string, checked: boolean, hint = ''): [HTMLLabelElement, HTMLInputElement] {
  const input = el('input', { type: 'checkbox', class: 'switch', ...(checked ? { checked: true } : {}) })
  return [el('label', { class: 'check' }, input, el('span', {}, name, hint === '' ? null : el('span', { class: 'hint' }, hint))), input]
}

/** A disclosure: `summary` opens the rest. */
export function disclosure(summary: string, ...children: Child[]): HTMLDetailsElement {
  return el('details', { class: 'more' }, el('summary', {}, summary), ...children)
}

/** One action of a menu: its text, what it does, and `danger` for one that deletes. */
export type MenuAction = readonly [text: string, run: () => void, tone?: 'danger']

let menus = 0

/**
 * A small menu behind ⋯ (`name` is its name for assistive technology): it shows its actions inline beside it; a
 * choice or Escape closes it. `focusKey` marks the ⋯ button for a view that puts the focus back after repainting.
 */
export function menu(name: string, actions: readonly MenuAction[], focusKey = ''): HTMLElement {
  menus += 1
  const id = `menu-${String(menus)}`
  const items = el('span', { id, class: 'menu-items', hidden: true })
  const opener = button('⋯', () => {
    if (items.hidden) open()
    else close()
  }, { class: 'quiet icon', 'aria-label': name, 'aria-expanded': 'false', 'aria-controls': id, ...(focusKey === '' ? {} : { 'data-focus': focusKey }) })
  const close = () => {
    items.hidden = true
    opener.setAttribute('aria-expanded', 'false')
  }
  const open = () => {
    items.hidden = false
    opener.setAttribute('aria-expanded', 'true')
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
  return el('span', { class: 'menu' }, items, opener)
}

/** Lets a textarea grow with its text, from its own rows up: on every input, and once it is in the page. */
export function growing(area: HTMLTextAreaElement): HTMLTextAreaElement {
  const fit = () => {
    if (!area.isConnected) return
    area.style.height = 'auto'
    // scrollHeight leaves out the 1 px borders the box's height includes.
    if (area.scrollHeight > 0) area.style.height = `${String(area.scrollHeight + 2)}px`
  }
  area.addEventListener('input', fit)
  setTimeout(fit, 0)
  return area
}

/** The empty state: one line, and an optional hint under it. */
export function emptyState(title: string, hint = ''): HTMLElement {
  return el('div', { class: 'empty' }, el('strong', {}, title), hint === '' ? null : el('span', {}, hint))
}

export interface PickerOption {
  /** The value chosen (a label's resource name, '' for 都不是). */
  readonly value: string
  readonly text: string
}

let pickers = 0

/**
 * The searchable picker: a search box over a list of options. Typing filters by name; ↑ ↓ move, Enter or a click
 * chooses, Escape cancels. `initial` is highlighted first (都不是 for a suspected phishing mail).
 */
export function picker(options: readonly PickerOption[], initial: string, pick: (value: string) => void, cancel: () => void): HTMLElement {
  pickers += 1
  const id = `picker-${String(pickers)}`
  const input = el('input', { type: 'search', placeholder: '搜索标签', 'aria-label': '搜索标签', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': id, 'aria-autocomplete': 'list', autocomplete: 'off' })
  const list = el('ul', { id, role: 'listbox', 'aria-label': '标签' })
  let shown: readonly PickerOption[] = options
  let active = Math.max(0, options.findIndex((option) => option.value === initial))
  const render = () => {
    const query = input.value.trim().toLowerCase()
    shown = options.filter((option) => option.text.toLowerCase().includes(query))
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
      list.append(el('li', { class: 'none' }, '没有这个标签'))
      input.removeAttribute('aria-activedescendant')
    } else {
      input.setAttribute('aria-activedescendant', `${id}-${String(active)}`)
    }
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }
  input.addEventListener('input', () => {
    active = 0
    render()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (shown.length > 0) active = (active + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length
      render()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const chosen = shown[active]
      if (chosen !== undefined) pick(chosen.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  })
  render()
  return el('div', { class: 'picker' }, input, list)
}
