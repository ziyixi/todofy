import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// jsdom has no layout, so the narrow-desktop rules (720–767 px, where a horizontal page scroll and
// per-character tab labels once appeared) are pinned here as CSS invariants. The measured check
// (scrollWidth, tab height and tile edges at 720/740/768/960/1280 px) is in docs/verification.md.
const css = readFileSync(join(import.meta.dirname, 'app.css'), 'utf8')

/** The declarations of every `selector { ... }` block inside the media blocks whose query contains `query`. */
function rulesIn(query: string, selector: string): string[] {
  const out: string[] = []
  const media = /@media\s*([^{]+)\{/g
  let match: RegExpExecArray | null
  while ((match = media.exec(css)) !== null) {
    if (!match[1]!.includes(query)) continue
    // The media block's body: up to the brace that closes it.
    let depth = 1
    let i = media.lastIndex
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0
    const body = css.slice(media.lastIndex, i - 1)
    const rule = new RegExp(`(?:^|[}\\s,])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
    let found: RegExpExecArray | null
    while ((found = rule.exec(body)) !== null) out.push(found[1]!)
  }
  return out
}

describe('desktop layout from 720 px (F3)', () => {
  it('lets the launcher tiles wrap instead of forcing one row', () => {
    const tiles = rulesIn('min-width: 720px', '.tiles').join('\n')
    expect(tiles).toMatch(/flex-wrap:\s*wrap/)
    expect(tiles).not.toMatch(/grid-auto-flow:\s*column/)
    expect(rulesIn('min-width: 720px', '.launch-group').join('\n')).toMatch(/max-width:\s*100%/)
  })

  it('never breaks a tab label inside a word, and keeps the brand from being squeezed under the tabs', () => {
    expect(rulesIn('min-width: 720px', '.tab').join('\n')).toMatch(/white-space:\s*nowrap/)
    expect(css).toMatch(/\.brand\s*\{[^}]*flex:\s*none/)
    // Below 960 px the long tail of "Cloudflare 监控" is dropped (the accessible name keeps it).
    expect(rulesIn('max-width: 959px', '.tab-long').join('\n')).toMatch(/display:\s*none/)
  })
})

describe('tile status line (F6)', () => {
  it('never breaks the level word; the detail gives way with an ellipsis', () => {
    expect(css).toMatch(/\.tile-status \.level\s*\{[^}]*flex:\s*none;[^}]*white-space:\s*nowrap/)
    expect(css).toMatch(/\.tile-detail\s*\{[^}]*text-overflow:\s*ellipsis/)
    expect(css).toMatch(/\.tile-detail\s*\{[^}]*min-width:\s*0/)
  })
})
