/**
 * What several views share: a page's frame (its title for assistive technology, skeleton rows while it loads, one
 * error line with 重试 where the content would be) and running a mutation with its toast.
 */
import { errorMessage, newRequestId, withRetry } from '../api.ts'
import { errorLine, skeleton } from '../components.ts'
import { el, toast } from '../dom.ts'

/**
 * Renders the page's title (for assistive technology: the tab already names the page) and a body that `load` fills,
 * `rows` skeleton rows until it does; a failure shows its message there with 重试.
 */
export async function frame(main: HTMLElement, title: string, load: (body: HTMLElement) => Promise<void>, rows = 4): Promise<void> {
  const body = el('div', { class: 'body' })
  main.replaceChildren(el('h1', { class: 'visually-hidden' }, title), body)
  await loadInto(body, rows, load)
}

/** Fills `box` with what `load` renders: skeleton rows first, and on a failure its message with 重试. */
export async function loadInto(box: HTMLElement, rows: number, load: (box: HTMLElement) => Promise<void>): Promise<void> {
  const run = async () => {
    box.replaceChildren(skeleton(rows))
    try {
      await load(box)
    } catch (error) {
      box.replaceChildren(errorLine(errorMessage(error), () => void run()))
    }
  }
  await run()
}

/**
 * Runs one user action with a fresh request ID (repeated once on a transient failure), then toasts `done` and runs
 * `after`; a failure only toasts its message, and answers null.
 */
export async function act<T>(run: (requestId: string) => Promise<T>, done: string, after: (answer: T) => Promise<void> | void): Promise<T | null> {
  const requestId = newRequestId()
  try {
    const answer = await withRetry(() => run(requestId))
    toast(done)
    await after(answer)
    return answer
  } catch (error) {
    toast(errorMessage(error))
    return null
  }
}
