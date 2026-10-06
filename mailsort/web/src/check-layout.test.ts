/**
 * The settings checkboxes (标签's 启用, 正式打, 归档, 可信类, 敏感; 规则's 留在收件箱, 需要 DMARC) keep the box and its own
 * text on one row at any width. jsdom has no layout, so this pins the two things the row depends on: the markup (the
 * box and one text column, the hint inside that column) and the rules of styles.css (no wrapping, a shrinkable text
 * column, the hint a block). At 375 px the old `flex-wrap: wrap` moved the box onto the line of the setting above it
 * (QA D2); the layout was also checked by hand in a 375 px browser.
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

describe('settings checkboxes share a row with their own text', () => {
  it('never wraps the box away from its text', () => {
    const check = rule('.check')
    expect(check.get('display')).toBe('flex')
    expect(check.get('flex-wrap')).toBe('nowrap')
    expect(check.get('align-items')).toBe('flex-start')
    const text = rule('.check > span')
    expect(text.get('flex')).toBe('1 1 auto')
    expect(text.get('min-width')).toBe('0')
    expect(rule('.check .hint').get('display')).toBe('block')
    // The box itself never shrinks or grows (input[type='checkbox'] is flex: none).
    expect(rule("input[type='checkbox']").get('flex')).toBe('none')
  })

  it('renders each switch as the box and one text column holding its name and hint', async () => {
    const server = new FakeServer()
    server.labels = [label('travel', '出行')]
    const labels = await open(server, '/labels')
    const rules = await open(server, '/rules')
    const checks = [...labels.querySelectorAll('label.check'), ...rules.querySelectorAll('label.check')]
    const names = checks.map((node) => node.querySelector(':scope > span')?.firstChild?.textContent)
    expect(names).toEqual(expect.arrayContaining(['启用', '正式打', '可信类', '归档', '敏感', '留在收件箱', '需要 DMARC']))
    for (const node of checks) {
      expect([...node.children].map((child) => child.tagName)).toEqual(['INPUT', 'SPAN'])
      expect(node.children[1]?.querySelector('.hint')).not.toBeNull()
    }
  })
})
