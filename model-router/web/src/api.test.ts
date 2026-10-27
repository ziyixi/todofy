import { afterEach, vi } from 'vitest'
import { api, ApiError, resetCsrfForTests } from './api'
import { generation } from './test/fixtures'

afterEach(() => {
  resetCsrfForTests()
  vi.unstubAllGlobals()
})

test('generation uses the shared wire contract and a same-origin CSRF session without browser secrets', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ csrf_token: 'synthetic-csrf-token' }))
    .mockResolvedValueOnce(Response.json(generation))
  vi.stubGlobal('fetch', fetcher)
  const result = await api.generate({
    request_id: '00000000-0000-4000-8000-000000000002',
    config: { model: 'models/structured' },
    input: 'Synthetic input',
  })
  expect(result.name).toBe(generation.name)
  expect(fetcher).toHaveBeenNthCalledWith(
    1,
    '/api/session',
    expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' }),
  )
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    '/api/model/v1/generations:generate',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'synthetic-csrf-token',
      },
    }),
  )
  const sent = JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string) as Record<string, unknown>
  expect(sent).toEqual({
    request_id: '00000000-0000-4000-8000-000000000002',
    config: { model: 'models/structured' },
    input: 'Synthetic input',
  })
})

test('pagination keeps a fixed time window and uses descriptor-generated query parameters', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(Response.json({ requests: [generation] })))
  vi.stubGlobal('fetch', fetcher)
  const filters = {
    days: 7 as const,
    app: 'synthetic app',
    model: 'models/structured',
    state: 'failed',
    toTime: '2026-10-26T10:00:00.000Z',
  }
  await api.listRequests(filters)
  await api.listRequests(filters, 'synthetic-next')
  const first = new URL(fetcher.mock.calls[0]?.[0] as string, 'https://example.test')
  const second = new URL(fetcher.mock.calls[1]?.[0] as string, 'https://example.test')
  expect(first.searchParams.get('page_size')).toBe('25')
  expect(second.searchParams.get('page_token')).toBe('synthetic-next')
  expect(second.searchParams.get('app')).toBe('synthetic app')
  expect(first.searchParams.get('from_time')).toBe(second.searchParams.get('from_time'))
  expect(first.searchParams.get('to_time')).toBe(second.searchParams.get('to_time'))
  expect(first.searchParams.get('from_time')).toBe('2026-10-19T10:00:00Z')
})

test('an Access redirect or network failure has an actionable error and is never retried', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Synthetic network failure'))
  vi.stubGlobal('fetch', fetcher)
  const outcome = await api.listModels().catch((error: unknown) => error)
  expect(outcome).toBeInstanceOf(ApiError)
  if (!(outcome instanceof ApiError)) throw new Error('Expected a typed API error')
  expect(outcome.message).toContain('无法连接 ModelRouter，或登录已过期')
  expect(outcome).toMatchObject({ reason: 'NETWORK_ERROR', status: 0 })
  expect(fetcher).toHaveBeenCalledOnce()
})
