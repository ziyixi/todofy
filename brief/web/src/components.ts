/**
 * The UI's components (styles.css draws them), copied from recall's and mailsort's UIs with the same names: a card, a
 * chip, a meter, a toggle switch, a disclosure, an empty state, skeleton rows and the error line with 重试. Plain DOM,
 * text only ever as text.
 */
import { button, el, type Child } from './dom.ts'

export type Tone = 'accent' | 'warn' | 'muted' | ''

/** A card: one section of a page, its title and an optional figure or note on the right. */
export function card(title: string, meta: string, ...children: Child[]): HTMLElement {
  return el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, title), meta === '' ? null : el('span', { class: 'meta' }, meta)), ...children)
}

/** A chip: a state or a kind beside a row, never a control. */
export function chip(text: string, tone: Tone = ''): HTMLElement {
  return el('span', { class: tone === '' ? 'chip' : `chip ${tone}` }, text)
}

/** The share of `value` in `max` as a CSS width, within 0-100 %. */
function width(value: number, max: number): string {
  return `${String(max <= 0 ? 0 : Math.round(Math.min(1, Math.max(0, value / max)) * 100))}%`
}

/** A thin meter of `value` out of `max` (the month's spend), named for assistive technology. */
export function meter(value: number, max: number, label: string, tone: '' | 'warn' = ''): HTMLElement {
  const fill = el('span')
  fill.style.width = width(value, max)
  return el('span', { class: tone === '' ? 'meter' : `meter ${tone}`, role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(Math.round(value * 100) / 100) }, fill)
}

/** A toggle switch with its name and a one-line hint; the input is returned to read `checked`. */
export function toggle(name: string, checked: boolean, hint: string): [HTMLLabelElement, HTMLInputElement] {
  const input = el('input', { type: 'checkbox', role: 'switch', class: 'switch', 'aria-label': name, ...(checked ? { checked: true } : {}) })
  return [el('label', { class: 'check' }, input, el('span', {}, name, el('span', { class: 'hint' }, hint))), input]
}

/** A disclosure: `summary` opens the rest. */
export function disclosure(summary: string, ...children: Child[]): HTMLDetailsElement {
  return el('details', { class: 'more' }, el('summary', {}, summary), ...children)
}

/** The empty state: one line, an optional hint under it. */
export function emptyState(title: string, hint = ''): HTMLElement {
  return el('div', { class: 'empty' }, el('strong', {}, title), hint === '' ? null : el('span', {}, hint))
}

/** Loading: `count` grey rows in the list's shape (never a spinner over the page). */
export function skeleton(count: number): HTMLElement {
  return el('ul', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': '加载中' }, ...Array.from({ length: count }, () => el('li', {}, el('span'), el('span'))))
}

/** A failure where the content would be: its message and 重试. */
export function errorLine(message: string, retry: () => void): HTMLElement {
  return el('p', { class: 'error-line', role: 'alert' }, el('span', {}, message), button('重试', retry, { class: 'small' }))
}
