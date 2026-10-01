import { Code, RpcError, statusBody } from '@ziyixi/proto/rpc-status'
import { vi } from 'vitest'
import { api, ApiError, resetClientForTests, withRetry } from './api.ts'

function status(httpStatus: number, code: Code, reason: string): Response {
  return Response.json(statusBody(new RpcError(code, reason, reason, { httpStatus }), { domain: 'watch.ziyixi.science', localized: { locale: 'zh-CN', message: '服务器的说明' } }), { status: httpStatus })
}

describe('the transport', () => {
  beforeEach(() => resetClientForTests())

  it('sends same-origin requests that never follow a redirect, with the CSRF token on mutations only', async () => {
    const fetch = vi.fn((url: string, init: RequestInit) => {
      if (url === '/api/csrf') return Promise.resolve(Response.json({ token: 't1' }))
      expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      return Promise.resolve(Response.json(init.method === 'GET' ? { watches: [] } : {}))
    })
    vi.stubGlobal('fetch', fetch)
    await api.listWatches({})
    expect((fetch.mock.calls[0]?.[1].headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined()
    await api.deleteWatch({ name: 'watches/a' })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/watches', '/api/csrf', '/api/v1/watches/a'])
    expect((fetch.mock.calls[2]?.[1].headers as Record<string, string>)['X-CSRF-Token']).toBe('t1')
  })

  it('renews a refused CSRF token once and repeats the same request', async () => {
    let tokens = 0
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/api/csrf') return Promise.resolve(Response.json({ token: `t${String((tokens += 1))}` }))
        bodies.push(`${(init.headers as Record<string, string>)['X-CSRF-Token'] ?? ''} ${typeof init.body === 'string' ? init.body : ''}`)
        return Promise.resolve(bodies.length === 1 ? status(403, Code.PERMISSION_DENIED, 'CSRF_FAILED') : Response.json({ name: 'watches/a', display_name: 'a', uri: 'https://a.example/' }))
      }),
    )
    await api.pauseWatch({ name: 'watches/a', requestId: '11111111-1111-4111-8111-111111111111' })
    expect(bodies).toEqual([
      't1 {"request_id":"11111111-1111-4111-8111-111111111111"}',
      't2 {"request_id":"11111111-1111-4111-8111-111111111111"}',
    ])
  })

  it('turns failures into ApiErrors with the copy to show, and retries only transient ones', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(status(409, Code.ABORTED, 'ETAG_MISMATCH'))))
    const stale = await api.getWatch({ name: 'watches/a' }).catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(ApiError)
    expect(stale).toMatchObject({ reason: 'ETAG_MISMATCH', message: '这个监视已在别处修改，已载入最新内容', transient: false })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(status(400, Code.INVALID_ARGUMENT, 'INVALID_URI'))))
    expect(await api.getWatch({ name: 'watches/a' }).catch((error: unknown) => (error as Error).message)).toBe('服务器的说明')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    const offline = await api.getWatch({ name: 'watches/a' }).catch((error: unknown) => error)
    expect(offline).toMatchObject({ reason: 'NETWORK_ERROR', status: 0, transient: true })
    let runs = 0
    const flaky = () => {
      runs += 1
      return runs === 1 ? Promise.reject(new ApiError(503, 'UNAVAILABLE', 'x')) : Promise.resolve('ok')
    }
    expect(await withRetry(flaky, 0)).toBe('ok')
    await expect(withRetry(() => Promise.reject(new ApiError(500, 'INTERNAL', 'bug')), 0)).rejects.toMatchObject({ reason: 'INTERNAL' })
  })
})
