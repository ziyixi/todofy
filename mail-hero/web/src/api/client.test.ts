import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('management API integration contract', () => {
  it('maps the server overview and setup shapes used by the workspace', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ receive_address: 'hero@example.test', counts: { messages: 9, pending: 2, failed: 1, delivered: 5 }, storage: { logical_bytes: 1234, limit_bytes: 9999 }, backup: { last_at: null } }))
      .mockResolvedValueOnce(json({ receive_address: 'hero@example.test', address_valid: true, mx_configured: false, smtp_external: 'not_verified', starttls_configured: true, last_received_at: null }))
    vi.stubGlobal('fetch', fetcher)
    const overview = await api.overview()
    const setup = await api.setup()
    expect(overview).toMatchObject({ message_count: 9, pending_count: 2, storage_bytes: 1234, capacity_bytes: 9999 })
    expect(setup.checks?.find(check => check.id === 'mx')?.status).toBe('warning')
    expect(setup.checks?.find(check => check.id === 'external')?.status).toBe('pending')
  })

  it('uses Cloudflare ingest checks without inventing SMTP readiness', async () => {
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
})
