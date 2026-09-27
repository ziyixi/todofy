import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('management API integration contract', () => {
  it('maps the native overview shape used by the workspace', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ receive_address: 'hero@example.test', counts: { messages: 9, pending: 2, failed: 1, delivered: 5 }, storage: { logical_bytes: 1234, limit_bytes: 9999 }, backup: { last_at: null } }))
    vi.stubGlobal('fetch', fetcher)
    const overview = await api.overview()
    expect(overview).toMatchObject({ message_count: 9, pending_count: 2, storage_bytes: 1234, capacity_bytes: 9999 })
  })

  it('uses native Cloudflare ingest checks as returned by the API', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({
      receive_address: 'hero@example.test',
      ingest_transport: 'cloudflare',
      last_received_at: '2026-09-23T10:00:00Z',
      checks: [{ id: 'routing', label: 'Email Routing', status: 'pending', detail: '需要在 Cloudflare 确认。' }],
    }))
    vi.stubGlobal('fetch', fetcher)
    const setup = await api.setup()
    expect(setup.ingest_transport).toBe('cloudflare')
    expect(setup.checks).toEqual([{ id: 'routing', label: 'Email Routing', status: 'pending', detail: '需要在 Cloudflare 确认。' }])
    expect(setup.checks?.some(check => check.id === 'tls' || check.id === 'external')).toBe(false)
  })

  it('requests the exact UTC half-open delivery statistics interval', async () => {
    const payload = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z', bucket: 'day', totals: { succeeded: 1, retried: 0, failed: 0, unknown: 0 }, buckets: [] }
    const fetcher = vi.fn().mockResolvedValueOnce(json(payload))
    vi.stubGlobal('fetch', fetcher)
    expect(await api.deliveryStats({ from: payload.from, to: payload.to, bucket: 'day' })).toEqual(payload)
    const [url] = fetcher.mock.calls[0] as [string]
    const requestURL = new URL(url, 'https://mail-hero.example.test')
    expect(requestURL.pathname).toBe('/api/v1/delivery-stats')
    expect(Object.fromEntries(requestURL.searchParams)).toEqual({ from: payload.from, to: payload.to, bucket: 'day' })
  })

  it('obtains CSRF first and sends the exact action request body', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ token: 'signed-token' })).mockResolvedValueOnce(json({ id: 'endpoint-1' }))
    vi.stubGlobal('fetch', fetcher)
    await api.createEndpoint({ label: 'Personal', url: 'https://example.test/hook', auth_type: 'bearer', credential: 'secret', action_request_id: 'fixed-action-id' })
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/v1/csrf', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    const [url, options] = fetcher.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('/api/v1/endpoints')
    expect(options.headers).toMatchObject({ 'X-CSRF-Token': 'signed-token' })
    expect(JSON.parse(options.body as string)).toMatchObject({ action_request_id: 'fixed-action-id', credential: 'secret' })
  })

  it('unblocks an endpoint through the CSRF mutation path with only its version', async () => {
    const fetcher = vi.fn((url: string) => Promise.resolve(url === '/api/v1/csrf' ? json({ token: 'signed-token' }) : json({ affected_revisions: 3, version: 8 })))
    vi.stubGlobal('fetch', fetcher)
    expect(await api.unblockEndpoint('endpoint 1', { version: 7 })).toEqual({ affected_revisions: 3, version: 8 })
    const [url, options] = fetcher.mock.calls.find(([called]) => called !== '/api/v1/csrf') as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/endpoints/endpoint%201/unblock')
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    expect(options.headers).toMatchObject({ 'X-CSRF-Token': 'signed-token', 'Content-Type': 'application/json' })
    expect(JSON.parse(options.body as string)).toEqual({ version: 7 })
  })
})
