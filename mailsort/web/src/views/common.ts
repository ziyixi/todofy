/**
 * What several views share: every label (for names and selects), a label select, a loading/error frame, and running a
 * mutation with its toast.
 */
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { api, errorMessage, listAll, newRequestId, withRetry } from '../api.ts'
import { emptyState } from '../components.ts'
import { el, toast } from '../dom.ts'

export async function allLabels(): Promise<Label[]> {
  return listAll(async (pageToken) => {
    const page = await api.listLabels({ pageSize: 50, pageToken })
    return { items: page.labels, next: page.nextPageToken }
  })
}

/** A select of the labels (value: the label's name), with `first` (value '': 都不是, 全部标签) on top when given. */
export function labelSelect(labels: readonly Label[], selected: string, first: string | null, attributes: Readonly<Record<string, string>> = {}): HTMLSelectElement {
  const select = el(
    'select',
    attributes,
    ...(first === null ? [] : [el('option', { value: '' }, first)]),
    ...labels.map((label) => el('option', { value: label.name, ...(label.name === selected ? { selected: true } : {}) }, label.displayName)),
  )
  if (selected === '' && first !== null) select.value = ''
  return select
}

/**
 * Renders the page's title (for assistive technology: the tab already names the page) and a body that `load` fills;
 * a failure shows its message there.
 */
export async function frame(main: HTMLElement, title: string, load: (body: HTMLElement) => Promise<void>): Promise<() => Promise<void>> {
  const body = el('div', { class: 'body' }, el('p', { class: 'hint' }, '加载中…'))
  main.replaceChildren(el('h1', { class: 'visually-hidden' }, title), body)
  const run = async () => {
    try {
      await load(body)
    } catch (error) {
      body.replaceChildren(emptyState(errorMessage(error)))
    }
  }
  await run()
  return run
}

/**
 * Runs one user action with a fresh request ID (repeated once on a transient failure), then toasts and runs `after`
 * (a reload, or a row leaving); a failure only toasts its message, and answers null. The toast is `done`, or what
 * `done` makes of the answer (the counts a sync or an export reports).
 */
export async function act<T>(run: (requestId: string) => Promise<T>, done: string | ((answer: T) => string), after: () => Promise<void> | void): Promise<T | null> {
  const requestId = newRequestId()
  try {
    const answer = await withRetry(() => run(requestId))
    toast(typeof done === 'string' ? done : done(answer))
    await after()
    return answer
  } catch (error) {
    toast(errorMessage(error))
    return null
  }
}
