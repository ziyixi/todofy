import { ApiError, NETWORK_MESSAGE, api, apiV2 } from './client'
import { apiError, installFetch, json } from '../test/harness'

describe('api client', () => {
  it('reads the overview same-origin, without cache and without following redirects', async () => {
    const calls = installFetch(() => json({ version: 'home-v1' }))
    await api.overview()
    await api.overview(true)
    expect(calls.map((call) => call.path)).toEqual(['/api/v1/overview', '/api/v1/overview?refresh=1'])
    for (const call of calls) {
      expect(call.init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      expect(call.headers['x-csrf-token']).toBeUndefined()
    }
  })

  it('fetches the CSRF token once and sends it on every mutation', async () => {
    const calls = installFetch((call) => (call.path === '/api/v1/csrf' ? json({ token: 'tok' }) : json({ guard: {} })))
    await api.setGuard('shed')
    await api.setGuard('normal')
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/v1/csrf',
      'POST /api/v1/guard',
      'POST /api/v1/guard',
    ])
    expect(calls.slice(1).map((call) => [call.headers['x-csrf-token'], call.body])).toEqual([
      ['tok', '{"level":"shed"}'],
      ['tok', '{"level":"normal"}'],
    ])
  })

  it('retries exactly once after csrf_failed, with a new token', async () => {
    let token = 0
    let posts = 0
    const calls = installFetch((call) => {
      if (call.path === '/api/v1/csrf') return json({ token: `t${++token}` })
      posts += 1
      return posts === 1 ? apiError(403, 'csrf_failed') : json({ run: { run_id: 'x' } }, 202)
    })
    await expect(api.startCanary()).resolves.toEqual({ run: { run_id: 'x' } })
    expect(calls.map((call) => call.headers['x-csrf-token'] ?? '-')).toEqual(['-', 't1', '-', 't2'])
  })

  it('does not retry other 403s, but forgets the token for the next mutation', async () => {
    let token = 0
    const calls = installFetch((call) => {
      if (call.path === '/api/v1/csrf') return json({ token: `t${++token}` })
      return apiError(403, 'unauthorized', '登录已过期')
    })
    await expect(api.startCanary()).rejects.toMatchObject({ status: 403, code: 'unauthorized', message: '登录已过期' })
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    await expect(api.startCanary()).rejects.toBeInstanceOf(ApiError)
    expect(calls.filter((call) => call.path === '/api/v1/csrf')).toHaveLength(2)
  })

  it('keeps the error envelope: code, message and request ID', async () => {
    installFetch(() => apiError(429, 'canary_limit', '今天的手动运行次数已用完', 'cccccccccccccccc'))
    await expect(api.startCanary()).rejects.toMatchObject({
      status: 429,
      code: 'canary_limit',
      message: '今天的手动运行次数已用完',
      requestId: 'cccccccccccccccc',
    })
  })

  it('turns a failed fetch (network, or an Access redirect) into a login hint', async () => {
    installFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(api.overview()).rejects.toMatchObject({ status: 0, code: 'network_error', message: NETWORK_MESSAGE })
    expect(NETWORK_MESSAGE).toContain('登录已过期，请刷新页面')
  })

  it('does not trust non-JSON or unknown error bodies', async () => {
    installFetch(() => new Response('<html>login</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    await expect(api.overview()).rejects.toMatchObject({ status: 502, code: 'bad_response' })
    installFetch(() => json({ error: { code: 'something_else', message: 'x' } }, 500))
    await expect(api.overview()).rejects.toMatchObject({ status: 500, code: 'bad_response' })
    installFetch(() => new Response('not json', { status: 200 }))
    await expect(api.overview()).rejects.toMatchObject({ status: 200, code: 'bad_response' })
  })

  it('revalidates v2 views with If-None-Match and reuses the kept body on 304', async () => {
    const calls = installFetch((call) =>
      call.headers['if-none-match'] === '"4"'
        ? new Response(null, { status: 304, headers: { ETag: '"4"' } })
        : new Response(JSON.stringify({ rev: 4 }), { status: 200, headers: { ETag: '"4"', 'content-type': 'application/json' } }),
    )
    expect(await apiV2.home()).toEqual({ rev: 4 })
    expect(await apiV2.home()).toEqual({ rev: 4 })
    expect(await apiV2.home(true)).toEqual({ rev: 4 })
    expect(calls.map((call) => [call.path, call.headers['if-none-match'] ?? null])).toEqual([
      ['/api/v2/home', null],
      ['/api/v2/home', '"4"'],
      ['/api/v2/home?refresh=1', null],
    ])
  })

  it('sends v2 mutations with the CSRF token and the canary id', async () => {
    const calls = installFetch((call) => (call.path === '/api/v1/csrf' ? json({ token: 'tok' }) : json({ run: {} }, 202)))
    await apiV2.startCanary('mail-todofy')
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/v2/canary', body: '{"canary_id":"mail-todofy"}' })
    expect(calls[1]?.headers['x-csrf-token']).toBe('tok')
  })
})
