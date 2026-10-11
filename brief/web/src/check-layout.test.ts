/**
 * The layout at a phone's width, which jsdom cannot measure, so this pins the rules of styles.css it depends on
 * (checked at 360 px in a browser over the fake API's synthetic issue, light and dark, 2026-10-10):
 *
 * - A page never scrolls sideways: its one column, and every grid that holds page text (the lists, an issue's head,
 *   its sections, items, paragraphs and quotes, 设置's facts), is `minmax(0, 1fr)`; titles on one line are cut with …,
 *   and text that may hold a long unbroken word or URL (a title, a quote, a document's title) breaks anywhere.
 * - The reading text as the email sets it: 17 px, line height 1.75, lines of at most 40 em.
 * - Touch targets of 44 px (tabs, buttons, fields, a whole issue row, the votes); a `[n]` marker inside a line of text
 *   at WCAG's 24 px minimum.
 * - The brief's accent is the amber of its Home tile, light and dark, and its warning color is a red, so that a problem
 *   never reads as the accent.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of one exact top-level selector in styles.css, as a property -> value map. */
function rule(selector: string, within: string = css): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // After a block's start or end only (a selector that ends a list, `input,\nbutton`, is not the rule of `button`).
  const match = new RegExp(`[{}]\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(`}${within}`)
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

/** The body of an at-rule block (`@media (prefers-color-scheme: dark)`), up to its closing brace. */
function block(head: string): string {
  const start = css.indexOf(`${head} {`)
  if (start === -1) throw new Error(`no block ${head}`)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i)
  }
  throw new Error(`unclosed ${head}`)
}

describe('nothing is wider than a phone', () => {
  it('keeps each page and every grid of page text to one column that never grows past it', () => {
    for (const selector of ['#view > .body', '.rows', '.rows > li', 'a.row-link', '.issue-head', '.section', '.item', '.prose', '.quote', '.empty', '.more-items ul']) {
      expect([selector, rule(selector).get('grid-template-columns')]).toEqual([selector, 'minmax(0, 1fr)'])
    }
    // 设置's facts: a narrow column of names, the values in the rest.
    expect(rule('.kv').get('grid-template-columns')).toBe('5.5em minmax(0, 1fr)')
    expect(rule('.kv dd').get('min-width')).toBe('0')
  })

  it('cuts one-line titles with … and breaks long words anywhere else', () => {
    for (const selector of ['.row-title', '.row-sub']) {
      const found = rule(selector)
      expect([selector, found.get('min-width'), found.get('overflow'), found.get('text-overflow'), found.get('white-space')]).toEqual([selector, '0', 'hidden', 'ellipsis', 'nowrap'])
    }
    expect(rule('.row-head .meta,\n.row-head .chip').get('flex')).toBe('none')
    for (const selector of ['.prose', 'h2.issue-title', 'h3.item-title', '.quote blockquote', '.quote-source', '.refs', '.mono', '.kv dd', '.more-items li', '.why,\n.reason,\n.source-line']) {
      expect([selector, rule(selector).get('overflow-wrap')]).toEqual([selector, 'anywhere'])
    }
  })
})

describe('reading and touching', () => {
  it('sets an item’s text as the email does: 17 px, line height 1.75, at most 40 em a line', () => {
    const prose = rule('.prose')
    expect([prose.get('font-size'), prose.get('line-height'), prose.get('max-width')]).toEqual(['17px', '1.75', '40em'])
  })

  it('gives tabs, buttons, fields, rows and votes touch targets of 44 px, and a marker 24 px', () => {
    for (const selector of ['.tabs a', 'button', 'input', 'a.row-link', 'a.back', 'details.more > summary', '.check']) {
      expect([selector, rule(selector).get('min-height')]).toEqual([selector, '44px'])
    }
    const vote = rule('.votes button')
    expect([vote.get('min-width'), vote.get('min-height')]).toEqual(['44px', '44px'])
    const cite = rule('button.cite')
    expect([cite.get('min-width'), cite.get('min-height')]).toEqual(['24px', '24px'])
  })

  it('keeps a card’s 12 px between a line of text and the list under it', () => {
    expect(rule('.card > :not(.card-head) + .rows').get('margin-top')).toBe('12px')
  })

  it('marks the pressed vote and the open marker with the accent', () => {
    expect(rule(".votes button[aria-pressed='true']").get('color')).toBe('var(--accent)')
    expect(rule("button.cite[aria-expanded='true']").get('background')).toBe('var(--accent)')
  })
})

describe('the colors', () => {
  it('take the amber of the brief’s Home tile as the accent, light and dark', () => {
    const light = rule(':root')
    expect([light.get('--accent'), light.get('--accent-soft'), light.get('--accent-ink')]).toEqual(['#855509', '#f6ead3', '#ffffff'])
    const dark = rule(':root', block('@media (prefers-color-scheme: dark)'))
    expect([dark.get('--accent'), dark.get('--accent-soft'), dark.get('--accent-ink')]).toEqual(['#e3bc72', '#3b2e17', '#2a1d05'])
  })

  it('draw a problem in red, never in the accent', () => {
    expect(rule(':root').get('--warn')).toBe('#b42318')
    expect(rule(':root', block('@media (prefers-color-scheme: dark)')).get('--warn')).toBe('#f97066')
    expect(rule('.status-line .problem').get('color')).toBe('var(--warn)')
  })
})
