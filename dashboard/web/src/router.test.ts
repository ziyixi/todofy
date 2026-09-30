import { LEGACY_ANCHORS, parseHash, routeHash } from './router'

describe('hash routes', () => {
  it('parses the four views and their details', () => {
    expect(parseHash('')).toEqual({ view: 'home' })
    expect(parseHash('#/')).toEqual({ view: 'home' })
    expect(parseHash('#/flows')).toEqual({ view: 'flows' })
    expect(parseHash('#/flows/mail-to-task')).toEqual({ view: 'flows', flow: 'mail-to-task' })
    expect(parseHash('#/cloudflare')).toEqual({ view: 'cloudflare' })
    expect(parseHash('#/cloudflare/worker/todofy-core')).toEqual({ view: 'cloudflare', script: 'todofy-core' })
    expect(parseHash('#/ops')).toEqual({ view: 'ops' })
  })

  it('falls back safely on anything else', () => {
    expect(parseHash('#/nothing')).toEqual({ view: 'home' })
    expect(parseHash('#/flows/Bad Id')).toEqual({ view: 'flows' })
    expect(parseHash('#/cloudflare/worker/<x>')).toEqual({ view: 'cloudflare' })
    expect(parseHash('#/flows/a/b')).toEqual({ view: 'flows' })
  })

  it('maps the v1 section anchors', () => {
    expect(parseHash('#apps')).toEqual({ view: 'home' })
    expect(parseHash('#quota')).toEqual({ view: 'cloudflare' })
    expect(parseHash('#canary')).toEqual({ view: 'flows', flow: 'mail-to-task' })
    expect(parseHash('#actions')).toEqual({ view: 'ops' })
    expect(parseHash('#digest')).toEqual({ view: 'ops' })
    for (const target of Object.values(LEGACY_ANCHORS)) expect(routeHash(parseHash(target))).toBe(target)
  })

  it('round-trips canonical hashes', () => {
    for (const hash of ['#/', '#/flows', '#/flows/ops-digest', '#/cloudflare', '#/cloudflare/worker/home', '#/ops']) {
      expect(routeHash(parseHash(hash))).toBe(hash)
    }
  })
})
