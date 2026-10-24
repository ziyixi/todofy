/**
 * The UI's components (styles.css draws them): a card, a chip, a KPI number, a meter, a segmented control,
 * an empty state and the searchable priority picker. Plain
 * DOM, text only ever as text.
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

/** One KPI: a short label over its number, and an optional quiet line under it (the last 7 days). */
export function kpi(label: string, value: number, sub = ''): HTMLElement {
  return el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, label), el('span', { class: 'kpi-value' }, String(value)), sub === '' ? null : el('span', { class: 'kpi-sub' }, sub))
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

/** One choice of a few: buttons in a group, the current one pressed. */
export function segmented<T>(label: string, options: readonly (readonly [T, string])[], current: T, choose: (value: T) => void): HTMLElement {
  return el(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': label },
    ...options.map(([value, text]) => button(text, () => choose(value), { 'aria-pressed': value === current ? 'true' : 'false' })),
  )
}

/** The empty state: one line, an optional hint under it, and what follows (its actions). */
export function emptyState(title: string, hint = '', ...children: Child[]): HTMLElement {
  return el('div', { class: 'empty' }, el('strong', {}, title), hint === '' ? null : el('span', {}, hint), ...children)
}

export interface PickerOption {
  /** The value chosen (a label's resource name). */
  readonly value: string
  readonly text: string
}

let pickers = 0

/**
 * The searchable picker: a search box over a list of options. Typing filters by name; ↑ ↓ move, Enter or a click
 * chooses, Escape cancels. `initial` is highlighted first (待审's 其他…: the first label its buttons do not offer).
 */
export function picker(options: readonly PickerOption[], initial: string, pick: (value: string) => void, cancel: () => void): HTMLElement {
  pickers += 1
  const id = `picker-${String(pickers)}`
  const input = el('input', { type: 'search', placeholder: '搜索分级', 'aria-label': '搜索分级', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': id, 'aria-autocomplete': 'list', autocomplete: 'off' })
  const list = el('ul', { id, role: 'listbox', 'aria-label': '分级' })
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
      list.append(el('li', { class: 'none' }, '没有这个分级'))
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
