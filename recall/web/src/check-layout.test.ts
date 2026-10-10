/**
 * The layout at a phone's width, which jsdom cannot measure, so this pins the rules of styles.css it depends on (each
 * checked at 360 px in a browser against the real Worker with synthetic data, light and dark, 2026-10-10):
 *
 * - A page never scrolls sideways: its one column, and every grid that holds page text (a session's pages, an hour's
 *   block, a page's visits, the picker, the popover), is `minmax(0, 1fr)`; without it a long title widened a session's
 *   page list to 560 px. Titles, hosts and URLs on one line are cut with ….
 * - The hour grid: two rows of 12 on a phone, one row of 24 once its box has room for 24 cells of 24 px; every cell at
 *   least 24 × 32 px; an empty hour only outlined, five fills from a fifth of the accent to the accent (each numeral
 *   at least 4.5:1 on its fill, light and dark).
 * - A session's row on a narrow list (a phone) is two lines: the host whole, then the time and figures under it.
 * - A page's match bar sticks under the header.
 * - The popover is a full-width panel under the chips on a phone, under its chip on a wide screen.
 * - A page's ⋯ stays beside its title, and its open actions take a line of their own (inline beside the title, they
 *   squeezed it to three characters a line).
 * - The reader: 17 px, line height 1.75, lines of at most 40 em. Touch targets of 44 px.
 * - recall's accent is the violet of its Home tile, light and dark.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FakeServer, page, pageId, visit } from './test/fakeServer.ts'
import { buttonNamed, open } from './test/helpers.ts'

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of one exact top-level selector in styles.css, as a property -> value map. */
function rule(selector: string, within: string = css): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // After a block's start or end only (a selector that ends a list, `textarea,\nbutton`, is not the rule of `button`).
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

/** The body of an at-rule block (`@media (max-width: 520px)`), up to its closing brace. */
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

const cut = (selector: string) => {
  const found = rule(selector)
  return [found.get('min-width') ?? '0', found.get('overflow'), found.get('text-overflow'), found.get('white-space')]
}

describe('nothing is wider than a phone', () => {
  it('keeps each page and every grid of page text to one column that never grows past it', () => {
    expect(rule('#view > .body,\n.stack').get('grid-template-columns')).toBe('minmax(0, 1fr)')
    for (const selector of ['.day-list', '.hour-block', '.session-pages', '.visits', '.patterns', '.picker', '.picker ul', '.popover', '.gauge', '.empty', '.page-head', 'a.result-link']) {
      expect([selector, rule(selector).get('grid-template-columns')]).toEqual([selector, 'minmax(0, 1fr)'])
    }
  })

  it('cuts one-line titles, hosts and URLs with … instead of widening their rows', () => {
    for (const selector of ['.session-site', 'a.session-page', '.result-title', '.result-meta', '.result-url', '.row-title']) {
      expect([selector, ...cut(selector)]).toEqual([selector, '0', 'hidden', 'ellipsis', 'nowrap'])
    }
    // The figures beside a cut host never shrink.
    expect(rule('.session-time,\n.session-figures').get('flex')).toBe('none')
    expect(rule('.session-time,\n.session-figures').get('white-space')).toBe('nowrap')
    // Text that may hold a long unbroken URL breaks anywhere.
    for (const selector of ['.reader', 'h2.page-title', '.page-url', '.snippet', '.mono']) expect([selector, rule(selector).get('overflow-wrap')]).toEqual([selector, 'anywhere'])
  })

  it('renders a session row as one button of badge, host, time and figures, its pages a list under it', async () => {
    const fake = new FakeServer()
    fake.visits = [visit('a', [['09:00', '09:10']], { site: 'a-very-long-subdomain.of-a-long-host.example.com', title: 'x'.repeat(300) })]
    const root = await open(fake, '/day/2026-10-09')
    const row = root.querySelector('.session')
    expect([...(row?.children ?? [])].map((child) => child.className)).toEqual(['session-main', 'session-pages'])
    expect([...(row?.querySelector('.session-line')?.children ?? [])].map((child) => child.classList[0])).toEqual(['badge', 'session-site', 'meta', 'session-figures'])
  })
})

describe('the hour grid', () => {
  it('is two rows of 12 on a phone and one row of 24 when its box has room, each cell at least 24 × 32 px', () => {
    expect(rule('.hours-box').get('container-type')).toBe('inline-size')
    expect(rule('.hours').get('grid-template-columns')).toBe('repeat(12, minmax(24px, 1fr))')
    // 24 cells of 24 px and 23 gaps of 2 px: 622 px.
    expect(rule('.hours', block('@container (min-width: 624px)')).get('grid-template-columns')).toBe('repeat(24, minmax(24px, 1fr))')
    expect(rule('.hours').get('gap')).toBe('2px')
    const cell = rule('button.hour')
    expect([cell.get('min-width'), cell.get('min-height')]).toEqual(['24px', '32px'])
  })

  it('outlines an empty hour and fills five steps from a fifth of the accent to the accent', () => {
    expect(rule('button.hour').get('background')).toBe('transparent')
    expect(rule('button.hour.l0').get('box-shadow')).toBe('inset 0 0 0 1px var(--line)')
    expect(rule('button.hour.l1').get('background')).toBe('color-mix(in srgb, var(--accent) 20%, var(--surface))')
    expect(rule('button.hour.l3').get('background')).toBe('color-mix(in srgb, var(--accent) 50%, var(--surface))')
    expect(rule('button.hour.l3').get('color')).toBe('var(--ink)')
    expect(rule('button.hour.l4').get('color')).toBe('var(--accent-ink)')
    expect(rule('button.hour.l5').get('background')).toBe('var(--accent)')
    expect(rule('button.hour.l5').get('color')).toBe('var(--accent-ink)')
  })
})

describe('a session row on a phone', () => {
  it('gives the host the first line whole and puts the time and figures under it on a narrow list', () => {
    expect(rule('.day-list').get('container-type')).toBe('inline-size')
    const narrow = block('@container (max-width: 480px)')
    expect(rule('.session-line', narrow).get('flex-wrap')).toBe('wrap')
    expect(rule('.session-site', narrow).get('flex-basis')).toBe('calc(100% - 36px)')
    expect(rule('.session-time', narrow).get('margin-left')).toBe('36px')
  })
})

describe('the match bar', () => {
  it('sticks under the header', () => {
    const find = rule('.find')
    expect([find.get('position'), find.get('top')]).toEqual(['sticky', 'var(--top-height, 0)'])
  })
})

describe('popovers and menus', () => {
  it('drops the popover under its chip on a wide screen and makes it a full-width panel on a phone', () => {
    expect(rule('.filters-wrap').get('position')).toBe('relative')
    expect(rule('.popover').get('position')).toBe('absolute')
    const phone = rule('.popover', block('@media (max-width: 520px)'))
    expect([phone.get('position'), phone.get('width')]).toEqual(['static', 'auto'])
  })

  it('keeps a page’s ⋯ beside its title and its open actions on a line of their own', async () => {
    expect(rule('.page-title-row').get('flex-wrap')).toBe('wrap')
    expect(rule('h2.page-title').get('flex')).toBe('1 1 0')
    expect(rule('.page-title-row .menu').get('display')).toBe('contents')
    expect(rule('.page-title-row .menu-items').get('flex-basis')).toBe('100%')
    const fake = new FakeServer()
    fake.pages = [page('a')]
    const root = await open(fake, `/pages/${pageId('a')}`)
    const titleRow = root.querySelector('.page-title-row')
    expect([...(titleRow?.children ?? [])].map((child) => child.className)).toEqual(['page-title', 'menu'])
    buttonNamed(root, '页面操作').click()
    expect(titleRow?.querySelector('.menu-items')?.hasAttribute('hidden')).toBe(false)
  })
})

describe('reading and touching', () => {
  it('sets the captured text at 17 px, line height 1.75, at most 40 em a line', () => {
    const reader = rule('.reader')
    expect([reader.get('font-size'), reader.get('line-height'), reader.get('max-width')]).toEqual(['17px', '1.75', '40em'])
    expect(rule('h2.page-title').get('font-size')).toBe('22px')
  })

  it('gives tabs, buttons, chips and rows touch targets of 44 px', () => {
    for (const selector of ['.tabs a', 'button', 'button.filter', 'input,\nselect', '.session-pages li', '.visits li', 'details.more > summary']) {
      expect([selector, rule(selector).get('min-height')]).toEqual([selector, '44px'])
    }
    expect(rule('button.icon').get('min-width')).toBe('44px')
    expect(rule('.filter.set .filter-clear').get('min-width')).toBe('44px')
  })
})

describe('the accent', () => {
  it('is the violet of recall’s Home tile, light and dark', () => {
    const light = rule(':root')
    expect([light.get('--accent'), light.get('--accent-soft'), light.get('--accent-ink')]).toEqual(['#56419a', '#eae5f5', '#ffffff'])
    const dark = rule(':root', block('@media (prefers-color-scheme: dark)'))
    expect([dark.get('--accent'), dark.get('--accent-soft'), dark.get('--accent-ink')]).toEqual(['#b9a8ea', '#2e2842', '#1b1433'])
  })
})
