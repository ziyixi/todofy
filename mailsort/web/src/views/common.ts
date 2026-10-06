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

/** Runs one user action with a fresh request ID (repeated once on a transient failure), then toasts and reloads. */
export async function act<T>(run: (requestId: string) => Promise<T>, done: string, reload: () => Promise<void>): Promise<T | null> {
  const requestId = newRequestId()
  try {
    const answer = await withRetry(() => run(requestId))
    toast(done)
    await reload()
    return answer
  } catch (error) {
    toast(errorMessage(error))
    return null
  }
}
