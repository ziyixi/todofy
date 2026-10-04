/**
 * The owner API client (src/api/client.ts) on a recorded fetch: the routes of DashboardUiService as the generated
 * client lays them out, the CSRF transport, the views' ETags, the google.rpc.Status errors and the wire JSON the
 * pages read.
 */
import { ApiError, NETWORK_MESSAGE, api } from './client'
import { apiError, installFetch, json, PATHS } from '../test/harness'
import { healthy } from '../test/fixtures'

const REQUEST_ID = '0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0a'
const scenario = healthy()

describe('api client', () => {
  it('reads the views same-origin, without cache and without following redirects', async () => {
    const calls = installFetch((call) => {
      const path = call.path
      if (path === PATHS.registry) return json(scenario.registry)
      if (path === PATHS.home) return json(scenario.home)
      if (path === PATHS.flows) return json(scenario.flows)
      if (path === PATHS.cloudflare) return json(scenario.cloudflare)
      return json(scenario.ops)
    })
    expect(await api.registry()).toEqual(scenario.registry)
    expect(await api.home()).toEqual(scenario.home)
    expect(await api.flows()).toEqual(scenario.flows)
    expect(await api.cloudflare()).toEqual(scenario.cloudflare)
    expect(await api.ops()).toEqual(scenario.ops)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${PATHS.registry}`,
      `GET ${PATHS.home}`,
      `GET ${PATHS.flows}`,
      `GET ${PATHS.cloudflare}`,
      `GET ${PATHS.ops}`,
    ])
    for (const call of calls) {
      expect(call.init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      expect(call.headers['x-csrf-token']).toBeUndefined()
    }
  })

  it('fetches the CSRF token once and sends it on every mutation, with the request_id', async () => {
    const calls = installFetch((call) => (call.path === PATHS.csrf ? json({ token: 'tok' }) : json({ guard: scenario.ops.guard })))
    expect(await api.setGuard('shed', 'mail-hero', REQUEST_ID)).toEqual({ guard: scenario.ops.guard })
    await api.setGuard('normal', 'mail-hero', REQUEST_ID)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET ${PATHS.csrf}`, `POST ${PATHS.guard}`, `POST ${PATHS.guard}`])
    expect(calls.slice(1).map((call) => [call.headers['x-csrf-token'], call.headers['content-type'], call.body])).toEqual([
      ['tok', 'application/json', `{"level":"shed","request_id":"${REQUEST_ID}","app":"mail-hero"}`],
      ['tok', 'application/json', `{"level":"normal","request_id":"${REQUEST_ID}","app":"mail-hero"}`],
    ])
  })

  it('makes a request_id per action unless the caller passes one', async () => {
    const calls = installFetch((call) => (call.path === PATHS.csrf ? json({ token: 'tok' }) : json({ guard: scenario.ops.guard })))
    await api.setGuard('shed', 'mail-hero')
    await api.setGuard('shed', 'mail-hero')
    const ids = calls.filter((call) => call.method === 'POST').map((call) => (JSON.parse(call.body ?? '{}') as { request_id: string }).request_id)
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('retries exactly once after CSRF_FAILED, with a new token and the same request', async () => {
    let token = 0
    let posts = 0
    const run = scenario.ops.canary.recent[0]
    const calls = installFetch((call) => {
      if (call.path === PATHS.csrf) return json({ token: `t${++token}` })
      posts += 1
      return posts === 1 ? apiError(403, 'csrf_failed') : json({ run })
    })
    await expect(api.startCanary('mail-todofy', REQUEST_ID)).resolves.toEqual({ run })
    expect(calls.map((call) => call.headers['x-csrf-token'] ?? '-')).toEqual(['-', 't1', '-', 't2'])
    const posted = calls.filter((call) => call.method === 'POST')
    expect(posted.map((call) => call.path)).toEqual([PATHS.canary, PATHS.canary])
    expect(posted[0]?.body).toBe(posted[1]?.body)
  })

  it('does not retry other 403s, but forgets the token for the next mutation', async () => {
    let token = 0
    const calls = installFetch((call) => {
      if (call.path === PATHS.csrf) return json({ token: `t${++token}` })
      return apiError(403, 'unauthorized', '登录已过期')
    })
    await expect(api.startCanary('mail-todofy')).rejects.toMatchObject({ status: 403, code: 'unauthorized', message: '登录已过期' })
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    await expect(api.startCanary('mail-todofy')).rejects.toBeInstanceOf(ApiError)
    expect(calls.filter((call) => call.path === PATHS.csrf)).toHaveLength(2)
  })

  it('reads the google.rpc.Status: its reason, localized message and request ID', async () => {
    installFetch((call) => (call.path === PATHS.csrf ? json({ token: 'tok' }) : apiError(429, 'canary_limit', '今天的手动运行次数已用完', 'cccccccccccccccc')))
    await expect(api.startCanary('mail-todofy')).rejects.toMatchObject({
      status: 429,
      code: 'canary_limit',
      message: '今天的手动运行次数已用完',
      requestId: 'cccccccccccccccc',
    })
  })

  it('names the token failure with the Worker’s reason', async () => {
    installFetch(() => apiError(401, 'unauthorized', '未登录或凭据无效'))
    await expect(api.setGuard('shed', 'mail-hero')).rejects.toMatchObject({ status: 401, code: 'unauthorized', message: '未登录或凭据无效' })
  })

  it('turns a failed fetch (network, or an Access redirect) into a login hint', async () => {
    installFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(api.home()).rejects.toMatchObject({ status: 0, code: 'network_error', message: NETWORK_MESSAGE })
    expect(NETWORK_MESSAGE).toContain('登录已过期，请刷新页面')
  })

  it('does not trust non-JSON, non-Status or non-conforming bodies', async () => {
    installFetch(() => new Response('<html>login</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    await expect(api.home()).rejects.toMatchObject({ status: 502, code: 'bad_response' })
    installFetch(() => json({ error: { code: 'something_else', message: 'x' } }, 500))
    await expect(api.home()).rejects.toMatchObject({ status: 500, code: 'bad_response' })
    installFetch(() => new Response('not json', { status: 200 }))
    await expect(api.home()).rejects.toMatchObject({ status: 200, code: 'bad_response' })
    // A body that is not a HomeView (a wrong type): refused, never rendered.
    installFetch(() => json({ ...scenario.home, rev: 'seven' }))
    await expect(api.home()).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('revalidates views with If-None-Match, reuses the kept body on 304, and keeps a refresh’s answer', async () => {
    const body = JSON.stringify(scenario.home)
    const calls = installFetch((call) => {
      if (call.path === PATHS.csrf) return json({ token: 'tok' })
      if (call.headers['if-none-match'] === '"4"') return new Response(null, { status: 304, headers: { ETag: '"4"' } })
      return new Response(body, { status: 200, headers: { ETag: '"4"', 'content-type': 'application/json' } })
    })
    expect(await api.home()).toEqual(scenario.home)
    expect(await api.home()).toEqual(scenario.home)
    expect(await api.refreshHome()).toEqual(scenario.home)
    expect(calls.map((call) => [call.method, call.path, call.headers['if-none-match'] ?? null])).toEqual([
      ['GET', PATHS.home, null],
      ['GET', PATHS.home, '"4"'],
      ['GET', PATHS.csrf, null],
      ['POST', PATHS.refreshHome, null],
    ])
  })

  it('starts the canary by its resource name', async () => {
    const run = scenario.ops.canary.recent[0]
    const calls = installFetch((call) => (call.path === PATHS.csrf ? json({ token: 'tok' }) : json({ run })))
    await api.startCanary('mail-todofy', REQUEST_ID)
    expect(calls[1]).toMatchObject({ method: 'POST', path: PATHS.canary, body: `{"request_id":"${REQUEST_ID}"}` })
    expect(calls[1]?.headers['x-csrf-token']).toBe('tok')
  })
})
