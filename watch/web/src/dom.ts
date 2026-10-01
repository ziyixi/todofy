/**
 * Plain DOM helpers: elements built from tags, attributes and children (text is only ever set as text, never HTML), and
 * the toast with its optional undo.
 */

export type Attributes = Readonly<Record<string, string | boolean>>
export type Child = Node | string | null | false

/** An element with attributes and children; strings become text nodes, null and false are skipped. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false) continue
    node.setAttribute(name, value === true ? '' : value)
  }
  for (const child of children) if (child !== null && child !== false) node.append(child)
  return node
}

/** Replaces the children of `parent` (null and false are skipped). */
export function fill(parent: Element, ...children: Child[]): void {
  parent.replaceChildren(...children.filter((child): child is Node | string => child !== null && child !== false))
}

/** A button that runs `onClick` (its errors are the caller's to show). */
export function button(label: string, onClick: () => void, attributes: Attributes = {}): HTMLButtonElement {
  const node = el('button', { type: 'button', ...attributes }, label)
  node.addEventListener('click', onClick)
  return node
}

/** How long a toast stays. */
export const TOAST_MS = 8000

let toastTimer: ReturnType<typeof setTimeout> | undefined

/** Shows `message` in the page's toast (#toast), with an action button when given (撤销). */
export function toast(message: string, action?: { readonly label: string; readonly run: () => void }): void {
  const box = document.getElementById('toast')
  if (box === null) return
  clearTimeout(toastTimer)
  box.replaceChildren(el('span', {}, message))
  if (action !== undefined) {
    box.append(
      button(action.label, () => {
        box.hidden = true
        action.run()
      }, { class: 'link' }),
    )
  }
  box.hidden = false
  toastTimer = setTimeout(() => {
    box.hidden = true
  }, TOAST_MS)
}
