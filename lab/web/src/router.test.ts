import { parsePath, routePath } from './router'

describe('routes', () => {
  it('parses every view and falls back to 今日', () => {
    expect(parsePath('/')).toEqual({ view: 'today' })
    expect(parsePath('/deck/2026-09-29')).toEqual({ view: 'deck', day: '2026-09-29' })
    expect(parsePath('/deck/yesterday')).toEqual({ view: 'today' })
    expect(parsePath('/liked')).toEqual({ view: 'liked' })
    expect(parsePath('/seeds/')).toEqual({ view: 'seeds' })
    expect(parsePath('/settings')).toEqual({ view: 'settings' })
    expect(parsePath('/nope')).toEqual({ view: 'today' })
  })

  it('round-trips', () => {
    for (const path of ['/', '/deck/2026-09-29', '/liked', '/seeds', '/settings']) expect(routePath(parsePath(path))).toBe(path)
  })
})
