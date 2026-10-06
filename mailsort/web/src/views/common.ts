/**
 * What several views share: every label (for names and selects), a label select, a loading/error frame, and running a
 * mutation with its toast.
 */
import type { Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { api, errorMessage, listAll, newRequestId, withRetry } from '../api.ts'
import { el, toast } from '../dom.ts'

export async function allLabels(): Promise<Label[]> {
  return listAll(async (pageToken) => {
    const page = await api.listLabels({ pageSize: 50, pageToken })
    return { items: page.labels, next: page.nextPageToken }
  })
}

/** A select of the labels (value: the label's name), with "都不是" (value '') first when `none`. */
export function labelSelect(labels: readonly Label[], selected: string, none: boolean, attributes: Readonly<Record<string, string>> = {}): HTMLSelectElement {
  const select = el(
    'select',
    attributes,
    ...(none ? [el('option', { value: '' }, '都不是')] : []),
    ...labels.map((label) => el('option', { value: label.name, ...(label.name === selected ? { selected: true } : {}) }, label.displayName)),
  )
  if (selected === '' && none) select.value = ''
  return select
}

/** Renders `title` and a body that `load` fills; a failure shows its message there. */
export async function frame(main: HTMLElement, title: string, load: (body: HTMLElement) => Promise<void>): Promise<() => Promise<void>> {
  const body = el('div', {}, el('p', { class: 'status' }, '加载中…'))
  main.replaceChildren(el('h1', {}, title), body)
  const run = async () => {
    try {
      await load(body)
    } catch (error) {
      body.replaceChildren(el('p', { class: 'status' }, errorMessage(error)))
    }
  }
  await run()
  return run
}

/**
 * Runs one user action with a fresh request ID (repeated once on a transient failure), then toasts and reloads. The
 * toast is `done`, or what `done` makes of the answer (the counts a sync or an export reports).
 */
export async function act<T>(run: (requestId: string) => Promise<T>, done: string | ((answer: T) => string), reload: () => Promise<void>): Promise<T | null> {
  const requestId = newRequestId()
  try {
    const answer = await withRetry(() => run(requestId))
    toast(typeof done === 'string' ? done : done(answer))
    await reload()
    return answer
  } catch (error) {
    toast(errorMessage(error))
    return null
  }
}

/**
 * A list that shows its first page and appends the next one on 加载更多 (the page tokens of AIP-158), so every item
 * stays reachable however long the list grows.
 */
export function pagedList<T>(first: { items: T[]; next: string }, more: (pageToken: string) => Promise<{ items: T[]; next: string }>, render: (item: T) => HTMLElement): HTMLElement {
  const list = el('div', { class: 'list' }, ...first.items.map(render))
  const box = el('div', {}, list)
  let next = first.next
  const button = el('button', { type: 'button', class: 'small' }, '加载更多')
  const load = async () => {
    button.disabled = true
    try {
      const page = await more(next)
      list.append(...page.items.map(render))
      next = page.next
    } catch (error) {
      toast(errorMessage(error))
    }
    button.disabled = false
    if (next === '') button.remove()
  }
  button.addEventListener('click', () => void load())
  if (next !== '') box.append(el('div', { class: 'actions' }, button))
  return box
}
