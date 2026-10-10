/**
 * The layout at a phone's width, which jsdom cannot measure, so this pins the rules of styles.css it depends on (each
 * was found broken at 360 or 375 px in a browser, then checked fixed there by hand):
 *
 * - The switches of a label's detail in 标签 (归档; 高级's 可信, 敏感) keep the switch and its own text on
 *   one row: the markup (the switch and one text column, the hint inside that column) and the rules (no wrapping, a
 *   shrinkable text column, the hint a block, a switch that never shrinks). The old `flex-wrap: wrap` moved the box
 *   onto the line of the setting above it (QA D2). An off switch's track is a token of its own, at least 3:1.
 * - A page never scrolls sideways: its one column is `minmax(0, 1fr)`, so the flow diagram's 600 px scrolls inside its
 *   own box instead of widening 概览 to 650 px; 待审's row is one such column too, so a long subject is cut with …
 *   and the answers wrap under it, with the time on one line; 概览's table cuts a long label name the same way.
 * - 设置's rows keep the text on the left and the button on the right; the tree's hairlines are between its rows only.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountApp, type Host } from './app.ts'
import { FakeServer, label, NOW, settle } from './test/fakeServer.ts'

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8')

/** The declarations of one exact selector in styles.css, as a property -> value map. */
function rule(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))
  if (match === null) throw new Error(`no rule ${selector}`)
  return new Map(
    (match[1] ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => {
        const colon = part.indexOf(':')
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()] as [string, string]
      }),
  )
}

const host: Host = { now: () => NOW, confirm: () => true }

async function open(server: FakeServer, path: string): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', path)
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, host)
  await settle()
  return root
}

describe('switches share a row with their own text', () => {
  it('never wraps the switch away from its text', () => {
    const check = rule('.check')
    expect(check.get('display')).toBe('flex')
    expect(check.get('flex-wrap')).toBe('nowrap')
    expect(check.get('align-items')).toBe('flex-start')
    const text = rule('.check > span')
    expect(text.get('flex')).toBe('1 1 auto')
    expect(text.get('min-width')).toBe('0')
    expect(rule('.check .hint').get('display')).toBe('block')
    // The switch itself never shrinks or grows.
    expect(rule('input.switch').get('flex')).toBe('none')
  })

  it('renders each switch as the switch and one text column holding its name and hint', async () => {
    const server = new FakeServer()
    server.labels = [label('travel', '出行')]
    const root = await open(server, '/labels')
    root.querySelector<HTMLButtonElement>('.leaf-main')?.click()
    const checks = [...root.querySelectorAll('.detail label.check')]
    const names = checks.map((node) => node.querySelector(':scope > span')?.firstChild?.textContent)
    expect(names).toEqual(['归档', '可信', '敏感'])
    for (const node of checks) {
      expect([...node.children].map((child) => child.tagName)).toEqual(['INPUT', 'SPAN'])
      expect(node.children[0]?.classList.contains('switch')).toBe(true)
      expect(node.children[1]?.querySelector('.hint')).not.toBeNull()
    }
  })
})

describe('nothing is wider than a phone', () => {
  it('keeps each page to one column that never grows past it; the diagram scrolls in its own box', () => {
    expect(rule('#view > .body').get('grid-template-columns')).toBe('minmax(0, 1fr)')
    expect(rule('.flow-scroll').get('overflow-x')).toBe('auto')
    expect(rule('.flow-svg').get('min-width')).toBe('600px')
  })

  it('cuts a long subject in 待审 and keeps the time and the actions in sight', () => {
    expect(rule('.rows > li').get('grid-template-columns')).toBe('minmax(0, 1fr)')
    const title = rule('.row-title')
    expect([title.get('min-width'), title.get('overflow'), title.get('text-overflow'), title.get('white-space')]).toEqual(['0', 'hidden', 'ellipsis', 'nowrap'])
    const time = rule('.row-head .meta')
    expect([time.get('flex'), time.get('white-space')]).toEqual(['none', 'nowrap'])
  })

  it('keeps a setting’s text beside its button, and the tree’s hairlines between its rows only', () => {
    const text = rule('.setting > div')
    expect([text.get('flex'), text.get('min-width')]).toEqual(['1 1 0', '0'])
    expect(rule('.tree > li + li,\n.branch > ul > li + li').get('border-top')).toBe('1px solid var(--line)')
    // Not between the trusted-domain and example lines of an open label.
    expect(() => rule('.tree li + li')).toThrow()
  })

  it('draws an off switch on its own track color, light and dark', () => {
    expect(rule('input.switch').get('background')).toBe('var(--track)')
    expect(rule(':root').get('--track')).toBe('#8e8e93')
    const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(dark).toContain('--track: #6e6e73;')
  })
})
