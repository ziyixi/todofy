/**
 * What several views share (as in recall's UI): a page's frame (its title for assistive technology, skeleton rows
 * while it first loads, one error line with 重试 where the content would be) and running a mutation with its toast.
 */
import { errorMessage, newRequestId, withRetry } from '../api.ts'
import { errorLine, skeleton } from '../components.ts'
import { el, toast } from '../dom.ts'

/**
 * Renders the page's title (for assistive technology: the tab already names the page) and a body that `load` fills,
 * `rows` skeleton rows until it first does; a failure shows its message there with 重试. Answers the reload, which
 * keeps the content in place until the new one replaces it.
 */
export async function frame(main: HTMLElement, title: string, load: (body: HTMLElement) => Promise<void>, rows = 4): Promise<() => Promise<void>> {
  const body = el('div', { class: 'body' }, skeleton(rows))
  main.replaceChildren(el('h1', { class: 'visually-hidden' }, title), body)
  const run = async () => {
    try {
      await load(body)
    } catch (error) {
      body.replaceChildren(
        errorLine(errorMessage(error), () => {
          body.replaceChildren(skeleton(rows))
          void run()
        }),
      )
    }
  }
  await run()
  return run
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
