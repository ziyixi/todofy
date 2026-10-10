/** What the UI tests share: mounting the app on a path against a fake server, and finding and pressing things. */
import { mountApp, type Host } from '../app.ts'
import { NOW, settle, type FakeServer } from './fakeServer.ts'

export interface TestHost extends Host {
  /** The URLs `open` was asked for, and the questions `confirm` was asked. */
  readonly opened: string[]
  readonly asked: string[]
}

/** A host at NOW that answers every confirmation with `yes`. */
export function testHost(yes = true, desktop = false): TestHost {
  const opened: string[] = []
  const asked: string[] = []
  return {
    now: () => NOW,
    confirm: (message) => {
      asked.push(message)
      return yes
    },
    open: (url) => {
      opened.push(url)
    },
    desktop: () => desktop,
    opened,
    asked,
  }
}

/** The app mounted on `path` against `server`, once its first view has rendered. */
export async function open(server: FakeServer, path: string, host: Host = testHost()): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', path)
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, host)
  await settle()
  return root
}

export const toastText = (root: HTMLElement) => root.querySelector('#toast')?.textContent ?? ''

export function buttonNamed(root: ParentNode, text: string, index = 0): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].filter((node) => node.textContent === text || node.getAttribute('aria-label') === text)
  const button = found[index]
  if (button === undefined) throw new Error(`no button ${text}`)
  return button
}

/** A key pressed where the focus is (or on the page when nothing has it). */
export function press(key: string): void {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** Types `text` into a field (an input event, as the browser fires). */
export function type(input: HTMLInputElement, text: string): void {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** The query parameters of the page's current URL. */
export function urlParams(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}
