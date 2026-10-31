import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The page may talk only to its own origin (/api/*): no remote fonts, scripts, images or APIs. The navigation links
// (Home, Fleet, Model Router) come from ../wrangler.toml at build time, never from source.
const root = join(import.meta.dirname, '..', '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

const shipped = () => files(join(root, 'src')).filter((path) => !/\.test\.tsx?$|[/\\]test[/\\]/.test(relative(root, path)))

describe('no external requests', () => {
  it('has no absolute URL in the shipped sources or index.html', () => {
    const offenders = [join(root, 'index.html'), ...shipped()].filter((path) => /\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(readFileSync(path, 'utf8')))
    expect(offenders.map((path) => relative(root, path))).toEqual([])
  })

  it('calls fetch only through the same-origin API client', () => {
    const users = shipped().filter((path) => /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(readFileSync(path, 'utf8')))
    expect(users.map((path) => relative(root, path))).toEqual(['src/api.ts'])
  })

  it('never writes HTML from strings', () => {
    const users = shipped().filter((path) => /innerHTML|outerHTML|insertAdjacentHTML|document\.write|dangerouslySetInnerHTML/.test(readFileSync(path, 'utf8')))
    expect(users).toEqual([])
  })
})
