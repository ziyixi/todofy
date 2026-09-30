import { vi } from 'vitest'
import { ApiError, api, resetClientForTests, withRetry } from './client'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('api client', () => {
  it('sends the CSRF token on mutations and renews it once after csrf_failed', async () => {
    resetClientForTests()
    let tokens = 0
    let refused = false
    const seen: { path: string; token: string | null; body: string | null }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init: RequestInit = {}) => {
        const token = new Headers(init.headers).get('x-csrf-token')
        seen.push({ path, token, body: typeof init.body === 'string' ? init.body : null })
        expect(init.credentials).toBe('same-origin')
        expect(init.redirect).toBe('error')
        if (path === '/api/csrf') return Promise.resolve(json({ token: `t${++tokens}` }))
        if (!refused) {
          refused = true
          return Promise.resolve(json({ error: { code: 'csrf_failed', message: 'x', request_id: 'r' } }, 403))
        }
        return Promise.resolve(json({ state: { version: 2 }, applied: { kind: 'restart', cleared: 0 } }))
      }),
    )
    await api.restart('2026-09-30', { op_id: 'op-1', base_version: 1 })
    const posts = seen.filter((call) => call.path !== '/api/csrf')
    expect(posts.map((call) => call.token)).toEqual(['t1', 't2'])
    // The same body (same op_id) both times.
    expect(posts[0]?.body).toBe(posts[1]?.body)
  })

  it('keeps the conflict state of a 409 deck_changed', async () => {
    resetClientForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        Promise.resolve(
          path === '/api/csrf'
            ? json({ token: 't' })
            : json({ error: { code: 'deck_changed', message: 'm', request_id: 'r' }, state: { version: 9, decisions: {} } }, 409),
        ),
      ),
    )
    const error = await api.decide('2026-09-30', { op_id: 'o', base_version: 1, paper_id: 'p', decision: 'like' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).state?.version).toBe(9)
    expect((error as ApiError).message).toBe('已同步其他设备上的选择')
  })

  it('turns a failed fetch into a network error and retries it once', async () => {
    let attempts = 0
    const run = () => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new ApiError(0, 'network_error', 'x')) : Promise.resolve('ok')
    }
    await expect(withRetry(run, 1)).resolves.toBe('ok')
    expect(attempts).toBe(2)
    const refused = () => Promise.reject(new ApiError(409, 'nothing_to_undo', 'x'))
    await expect(withRetry(refused, 1)).rejects.toMatchObject({ code: 'nothing_to_undo' })
  })
})
