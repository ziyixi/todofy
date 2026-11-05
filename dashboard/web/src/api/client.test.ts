/**
 * The owner API client (src/api/client.ts) on a recorded fetch: the routes of DashboardUiService as the generated
 * client lays them out, the CSRF transport, the views' ETags, the google.rpc.Status errors and the wire JSON the
 * pages read.
 */
import { HttpEncodeError } from '@ziyixi/proto/http-client'
import { WireJsonError } from '@ziyixi/proto/wire-json'
import { ApiError, NETWORK_MESSAGE, api, toApiError } from './client'
import { apiError, installFetch, json, PATHS } from '../test/harness'
import { GEMINI_ITEM, healthy } from '../test/fixtures'

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

  it('sends same-origin JSON mutations directly with the request_id', async () => {
    const calls = installFetch(() => json({ guard: scenario.ops.guard }))
    expect(await api.setGuard('shed', 'mail-hero', REQUEST_ID)).toEqual({ guard: scenario.ops.guard })
    await api.setGuard('normal', 'mail-hero', REQUEST_ID)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${PATHS.guard}`, `POST ${PATHS.guard}`])
    expect(calls.map((call) => [call.headers['x-csrf-token'], call.headers['content-type'], call.body])).toEqual([
      ['1', 'application/json', `{"level":"shed","request_id":"${REQUEST_ID}","app":"mail-hero"}`],
      ['1', 'application/json', `{"level":"normal","request_id":"${REQUEST_ID}","app":"mail-hero"}`],
    ])
  })

  it('makes a request_id per action unless the caller passes one', async () => {
    const calls = installFetch(() => json({ guard: scenario.ops.guard }))
    await api.setGuard('shed', 'mail-hero')
    await api.setGuard('shed', 'mail-hero')
    const ids = calls.filter((call) => call.method === 'POST').map((call) => (JSON.parse(call.body ?? '{}') as { request_id: string }).request_id)
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('reports CSRF refusals without fetching a token or repeating the mutation', async () => {
    const calls = installFetch(() => apiError(403, 'csrf_failed'))
    await expect(api.startCanary('mail-todofy', REQUEST_ID)).rejects.toMatchObject({ status: 403, code: 'csrf_failed' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', path: PATHS.canary })
    expect(calls[0]?.headers['x-csrf-token']).toBe('1')
  })

  it('does not retry unauthorized requests', async () => {
    const calls = installFetch(() => apiError(403, 'unauthorized', '登录已过期'))
    await expect(api.startCanary('mail-todofy')).rejects.toMatchObject({ status: 403, code: 'unauthorized', message: '登录已过期' })
    await expect(api.startCanary('mail-todofy')).rejects.toBeInstanceOf(ApiError)
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.method === 'POST')).toBe(true)
  })

  it('reads the google.rpc.Status: its reason, localized message and request ID', async () => {
    installFetch(() => apiError(429, 'canary_limit', '今天的手动运行次数已用完', 'cccccccccccccccc'))
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
      if (call.path === PATHS.refreshCloudflare) return json(scenario.cloudflare)
      if (call.headers['if-none-match'] === '"4"') return new Response(null, { status: 304, headers: { ETag: '"4"' } })
      return new Response(body, { status: 200, headers: { ETag: '"4"', 'content-type': 'application/json' } })
    })
    expect(await api.home()).toEqual(scenario.home)
    expect(await api.home()).toEqual(scenario.home)
    expect(await api.refreshHome()).toEqual(scenario.home)
    expect(await api.refreshCloudflare()).toEqual(scenario.cloudflare)
    expect(calls.map((call) => [call.method, call.path, call.headers['if-none-match'] ?? null])).toEqual([
      ['GET', PATHS.home, null],
      ['GET', PATHS.home, '"4"'],
      ['POST', PATHS.refreshHome, null],
      ['POST', PATHS.refreshCloudflare, null],
    ])
  })

  it('starts the canary, requests website sync, and mutates attention items by resource name', async () => {
    const run = scenario.ops.canary.recent[0]
    const syncReply = { request: { request_id: REQUEST_ID, state: 'accepted' as const, run_id: '99', run_url: 'https://github.com/ziyixi/website/actions/runs/99' } }
    const attentionItem = { ...GEMINI_ITEM, name: 'attentionItems/item-1', etag: 'a1-00000000-0000-4000-8000-000000000001' }
    const calls = installFetch((call) => {
      if (call.path === PATHS.canary) return json({ run })
      if (call.path === '/api/v1/websiteSync:request') return json(syncReply)
      return json(attentionItem)
    })
    await api.startCanary('mail-todofy', REQUEST_ID)
    expect(await api.requestWebsiteSync(REQUEST_ID)).toEqual(syncReply)
    expect(await api.dismissAttention(attentionItem.name, attentionItem.etag, REQUEST_ID)).toEqual(attentionItem)
    expect(await api.restoreAttention(attentionItem.name, attentionItem.etag, REQUEST_ID)).toEqual(attentionItem)
    expect(calls.map((call) => [call.method, call.path, call.headers['x-csrf-token'], call.body])).toEqual([
      ['POST', PATHS.canary, '1', `{"request_id":"${REQUEST_ID}"}`],
      ['POST', '/api/v1/websiteSync:request', '1', `{"request_id":"${REQUEST_ID}"}`],
      ['POST', '/api/v1/attentionItems/item-1:dismiss', '1', `{"etag":"${attentionItem.etag}","request_id":"${REQUEST_ID}"}`],
      ['POST', '/api/v1/attentionItems/item-1:restore', '1', `{"etag":"${attentionItem.etag}","request_id":"${REQUEST_ID}"}`],
    ])
  })

  it('maps HttpEncodeError and WireJsonError to client-side ApiError instances without network calls', async () => {
    const calls = installFetch(() => json({}))
    // Empty canaryId produces an invalid resource path ('canaries/') rejected by HttpEncodeError before fetch.
    await expect(api.startCanary('', REQUEST_ID)).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
      message: '请求格式不正确',
    })
    expect(calls).toHaveLength(0)

    expect(toApiError(new HttpEncodeError('bad path'))).toMatchObject({
      status: 400,
      code: 'bad_request',
      message: '请求格式不正确',
    })
    expect(toApiError(new WireJsonError('unrecognized enum'))).toMatchObject({
      status: 200,
      code: 'bad_response',
      message: '个人控制台已更新，请刷新页面',
    })
  })
})

