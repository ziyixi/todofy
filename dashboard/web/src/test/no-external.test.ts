import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The page may talk only to its own origin (/api/v1/*, /api/v2/*): no remote fonts, scripts, images or APIs.
const root = join(import.meta.dirname, '..', '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

describe('no external requests', () => {
  it('has no absolute URL in the shipped sources, index.html or public files', () => {
    const shipped = [
      join(root, 'index.html'),
      ...files(join(root, 'public')),
      ...files(join(root, 'src')).filter((path) => !/\.test\.tsx?$|[/\\]test[/\\]/.test(path)),
    ]
    // XML namespace URIs (xmlns="http://www.w3.org/2000/svg") are identifiers, never fetched.
    const text = (path: string) => readFileSync(path, 'utf8').replace(/xmlns(?::\w+)?="http:\/\/www\.w3\.org\/[^"]*"/g, '')
    const offenders = shipped.filter((path) => /\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(text(path)))
    expect(offenders.map((path) => relative(root, path))).toEqual([])
  })

  it('calls fetch only through the same-origin API client', () => {
    const sources = files(join(root, 'src')).filter((path) => !/\.test\.tsx?$|[/\\]test[/\\]/.test(path))
    const users = sources.filter((path) => /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(readFileSync(path, 'utf8')))
    expect(users.map((path) => relative(root, path))).toEqual(['src/api/client.ts'])
  })
})
