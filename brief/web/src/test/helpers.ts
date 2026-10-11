/** What the UI tests share: mounting the app on a path against a fake server, and finding and pressing things. */
import { mountApp, type Host } from '../app.ts'
import { NOW, settle, type FakeServer } from './fakeServer.ts'

export interface TestHost extends Host {
  /** The questions `confirm` was asked. */
  readonly asked: string[]
}

/** A host at NOW that answers every confirmation with `yes`. */
export function testHost(yes = true): TestHost {
  const asked: string[] = []
  return {
    now: () => NOW,
    confirm: (message) => {
      asked.push(message)
      return yes
    },
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

/** The status line's parts as [text, class]. */
export const statusLine = (root: HTMLElement) => [...root.querySelectorAll('.status-line > span')].map((node) => [node.textContent, node.className])
