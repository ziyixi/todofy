import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The page may talk only to its own origin (/_/api/*): no remote fonts, scripts, images or APIs.
const root = join(import.meta.dirname, '..', '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

const shipped = () => files(join(root, 'src')).filter((path) => !/\.test\.ts$|[/\\]test[/\\]/.test(path))

describe('no external requests', () => {
  it('has no absolute URL in the shipped sources or index.html', () => {
    // The inline favicon's SVG namespace (http://www.w3.org/2000/svg) is an identifier, never fetched.
    const text = (path: string) => readFileSync(path, 'utf8').replace(/xmlns='http:\/\/www\.w3\.org\/2000\/svg'/g, '')
    const offenders = [join(root, 'index.html'), ...shipped()].filter((path) => /\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(text(path)))
    expect(offenders.map((path) => relative(root, path))).toEqual([])
  })

  it('calls fetch only through the same-origin API client', () => {
    const users = shipped().filter((path) => /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(readFileSync(path, 'utf8')))
    expect(users.map((path) => relative(root, path))).toEqual(['src/api.ts'])
  })

  it('never writes HTML from strings', () => {
    const users = shipped().filter((path) => /innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(readFileSync(path, 'utf8')))
    expect(users).toEqual([])
  })
})
