/** CSS contracts supplement DOM tests at phone widths; jsdom cannot measure actual layout. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountApp, type Host } from './app.ts'
import { FakeServer, NOW, settle } from './test/fakeServer.ts'

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

describe('fixed priority rows', () => {
  it('gives the priority a fixed name column and a shrinking policy column', () => {
    expect(rule('.priority-row .leaf-main').get('grid-template-columns')).toBe('2.5rem minmax(0, 1fr)')
    expect(rule('.priority-policy').get('overflow-wrap')).toBe('anywhere')
    expect(rule('.priority-row .leaf-count,\n.priority-row .meta').get('grid-column')).toBe('2')
  })

  it('keeps four readable policies visible and has no switches in a row or its details', async () => {
    const root = await open(new FakeServer(), '/labels')
    for (const node of root.querySelectorAll<HTMLButtonElement>('.leaf-main')) node.click()
    expect(root.querySelectorAll('.priority-row')).toHaveLength(4)
    expect(root.querySelectorAll('.priority-policy')).toHaveLength(4)
    expect(root.querySelectorAll('.label-list input, .label-list textarea')).toHaveLength(0)
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

  it('keeps hairlines between priority rows only', () => {
    expect(rule('.label-list > li + li').get('border-top')).toBe('1px solid var(--line)')
    // Not between example lines of an open priority.
    expect(() => rule('.tree li + li')).toThrow()
  })
})
