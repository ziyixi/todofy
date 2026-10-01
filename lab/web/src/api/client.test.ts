import { vi } from 'vitest'
import { Decision } from '@ziyixi/proto/lab/ui/v1/paper_pb'
import { ApiError, lab, resetClientForTests, withRetry } from './client'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function status(httpStatus: number, reason: string, extra: Record<string, unknown>[] = []) {
  const details = [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'lab.ziyixi.science' }, ...extra]
  return json({ error: { code: httpStatus, message: reason, status: 'ABORTED', details } }, httpStatus)
}

describe('api client', () => {
  it('sends the CSRF token on mutations and renews it once after CSRF_FAILED', async () => {
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
          return Promise.resolve(status(403, 'CSRF_FAILED'))
        }
        return Promise.resolve(json({ state: { etag: '2', version: 2 }, cleared_count: 0 }))
      }),
    )
    const answer = await lab.restartDeck({ name: 'decks/2026-09-30', requestId: '0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0a', etag: '1' })
    expect(answer.state?.version).toBe(2)
    const posts = seen.filter((call) => call.path !== '/api/csrf')
    expect(posts.map((call) => call.path)).toEqual(['/api/v1/decks/2026-09-30:restart', '/api/v1/decks/2026-09-30:restart'])
    expect(posts.map((call) => call.token)).toEqual(['t1', 't2'])
    // The same body (same request_id) both times, in the wire profile.
    expect(posts[0]?.body).toBe(posts[1]?.body)
    expect(JSON.parse(posts[0]?.body ?? '')).toEqual({ etag: '1', request_id: '0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0a' })
  })

  it('keeps the conflict state of DECK_CHANGED and shows the UI copy', async () => {
    resetClientForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        Promise.resolve(
          path === '/api/csrf'
            ? json({ token: 't' })
            : status(409, 'DECK_CHANGED', [{ '@type': 'type.googleapis.com/lab.ui.v1.DeckState', version: 9, decisions: { 'arxiv:2609.10001': 'like' } }]),
        ),
      ),
    )
    const error = await lab
      .decideDeck({ name: 'decks/2026-09-30', requestId: '0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0a', etag: '1', paperId: 'arxiv:2609.10002', decision: Decision.LIKE })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).reason).toBe('DECK_CHANGED')
    expect((error as ApiError).state?.version).toBe(9)
    expect((error as ApiError).state?.decisions).toEqual({ 'arxiv:2609.10001': Decision.LIKE })
    expect((error as ApiError).message).toBe('已同步其他设备上的选择')
  })

  it('shows the server copy for a reason it has none for, and treats HTML as an unreadable answer', async () => {
    resetClientForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        Promise.resolve(
          path === '/api/v1/settings'
            ? status(503, 'SOMETHING_NEW', [{ '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'zh-CN', message: '服务器的说明' }])
            : new Response('<html>', { status: 502 }),
        ),
      ),
    )
    const fresh = await lab.getSettings({ name: 'settings' }).catch((e: unknown) => e)
    expect(fresh).toMatchObject({ reason: 'SOMETHING_NEW', message: '服务器的说明', status: 503, transient: true })
    const html = await lab.getToday({ name: 'today' }).catch((e: unknown) => e)
    expect(html).toMatchObject({ reason: 'BAD_RESPONSE', message: '服务返回了无法识别的响应（HTTP 502）' })
  })

  it('turns a failed fetch into a network error and retries it once', async () => {
    let attempts = 0
    const run = () => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new ApiError(0, 'NETWORK_ERROR', 'x')) : Promise.resolve('ok')
    }
    await expect(withRetry(run, 1)).resolves.toBe('ok')
    expect(attempts).toBe(2)
    const refused = () => Promise.reject(new ApiError(400, 'NOTHING_TO_UNDO', 'x'))
    await expect(withRetry(refused, 1)).rejects.toMatchObject({ reason: 'NOTHING_TO_UNDO' })
  })

  it('never repeats a request it could not encode: nothing was sent, and the same input fails the same way', async () => {
    resetClientForTests()
    const fetch = vi.fn(() => Promise.resolve(json({ token: 't' })))
    vi.stubGlobal('fetch', fetch)
    let attempts = 0
    // An UpdateSettings without settings.name has no path to go to (http-path.ts), so the client throws first.
    const run = () => {
      attempts += 1
      return lab.updateSettings({ settings: {}, requestId: '0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0a' })
    }
    const error = await withRetry(run, 1).catch((e: unknown) => e)
    expect(error).toMatchObject({ reason: 'BAD_REQUEST', status: 400, transient: false })
    expect(attempts).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never repeats a bug (INTERNAL), but repeats a failed dependency (UNAVAILABLE)', async () => {
    for (const [httpStatus, reason, transient] of [
      [500, 'INTERNAL', false],
      [503, 'UNAVAILABLE', true],
    ] as const) {
      resetClientForTests()
      const fetch = vi.fn((path: string) => Promise.resolve(path === '/api/csrf' ? json({ token: 't' }) : status(httpStatus, reason)))
      vi.stubGlobal('fetch', fetch)
      const error = await withRetry(() => lab.snoozeDeck({ name: 'decks/2026-09-30', requestId: '0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0a' }), 1).catch((e: unknown) => e)
      expect(error).toMatchObject({ reason, status: httpStatus, transient })
      expect(fetch.mock.calls.filter(([path]) => path !== '/api/csrf')).toHaveLength(transient ? 2 : 1)
    }
  })
})
