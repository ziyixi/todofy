import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// jsdom has no layout, so the two breakpoints are pinned as CSS invariants: at 860 px the side-by-side cards stack and
// the tiles take two columns; at 600 px (phones) the day strip wraps into two weeks, the flow becomes a vertical list,
// the model calls become cards, and nothing needs a horizontal page scroll. Screenshots at 1280 and 390 px were
// checked by eye when the pages were built.
const css = readFileSync(join(import.meta.dirname, '..', 'style.css'), 'utf8')

/** The declarations of every `selector { ... }` block inside the media blocks whose query contains `query`. */
function rulesIn(query: string, selector: string): string {
  const out: string[] = []
  const media = /@media\s*([^{]+)\{/g
  let match: RegExpExecArray | null
  while ((match = media.exec(css)) !== null) {
    if (!match[1]!.includes(query)) continue
    let depth = 1
    let i = media.lastIndex
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0
    const body = css.slice(media.lastIndex, i - 1)
    const rule = new RegExp(`(?:^|[}\\s,])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,{]([^}]*)\\}`, 'g')
    let found: RegExpExecArray | null
    while ((found = rule.exec(body)) !== null) out.push(found[1]!)
  }
  return out.join('\n')
}

describe('at 860 px', () => {
  it('stacks the side-by-side cards and gives the tiles two columns', () => {
    expect(rulesIn('max-width: 860px', '.pair')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/)
    expect(rulesIn('max-width: 860px', '.tiles')).toMatch(/repeat\(2,/)
  })
})

describe('at 600 px', () => {
  it('wraps the strip into weeks and turns the flow into a vertical list', () => {
    expect(rulesIn('max-width: 600px', '.strip')).toMatch(/repeat\(7,/)
    expect(rulesIn('max-width: 600px', '.chain')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/)
    expect(rulesIn('max-width: 600px', '.side-note')).toMatch(/position:\s*static/)
  })

  it('shows each model call as a card instead of a wide table', () => {
    expect(rulesIn('max-width: 600px', '.call-table thead')).toMatch(/display:\s*none/)
    expect(css).toMatch(/\.call-table td::before\s*\{[^}]*content:\s*attr\(data-label\)/)
  })

  it('keeps every wide block inside the page: tables scroll in their own box, tabs never wrap a word', () => {
    expect(css).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/)
    expect(css).toMatch(/\.tabs a\s*\{[^}]*white-space:\s*nowrap/)
    expect(css).toMatch(/\.card\s*\{[^}]*min-width:\s*0/)
  })
})
