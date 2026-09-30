import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Layout rules jsdom cannot exercise (no touch-action, no layout), checked on the stylesheet itself.
const css = readFileSync(join(import.meta.dirname, 'app.css'), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n|,)\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`).exec(css)
  if (!match?.[1]) throw new Error(`no rule for ${selector}`)
  return match[1]
}

describe('stylesheet guards', () => {
  it('lets a horizontal touch pan reach the card: the scroller inside it pans only vertically', () => {
    // An overflow-y: auto child computes overflow-x: auto and would take horizontal pans for itself
    // (pointercancel on Chromium mobile, so a swipe never commits).
    const scroller = rule('.card-scroll')
    expect(scroller).toMatch(/touch-action:\s*pan-y/)
    expect(scroller).toMatch(/overflow-x:\s*hidden/)
    expect(rule('.paper-card')).toMatch(/touch-action:\s*pan-y/)
  })

  it('shows peeking cards as plain edges, never their clipped content', () => {
    expect(rule('.paper-card.depth-1 .card-scroll')).toMatch(/visibility:\s*hidden/)
    expect(css).toMatch(/\.paper-card\.depth-2 \.card-scroll[^{]*\{[^}]*visibility:\s*hidden/)
  })

  it('never pins the summary actions to the bottom of the screen (the last card’s buttons were there)', () => {
    expect(rule('.summary-actions')).not.toMatch(/position:\s*(?:sticky|fixed)/)
    expect(css).not.toMatch(/\.send-actions[^{]*\{[^}]*position:\s*(?:sticky|fixed)/)
  })
})
