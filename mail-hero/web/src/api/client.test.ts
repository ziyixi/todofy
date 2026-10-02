import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Endpoint_AuthType } from '@ziyixi/proto/mailhero/ui/v2/endpoint_pb'
import { SummarizeDeliveryAttemptsRequest_Granularity } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { Code, RpcError, statusBody } from '@ziyixi/proto/rpc-status'
import { api, ApiError, filterOf, loadMessage, NETWORK_MESSAGE, resetClientForTests, timestamp } from './client'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const failure = (status: number, code: Code, reason: string, metadata: Record<string, string> = {}, localized = '服务端文案') => json(statusBody(new RpcError(code, reason, reason, { metadata, httpStatus: status }),
  { domain: 'mail-hero.ziyixi.science', requestId: '0123456789abcdef', localized: { locale: 'zh-CN', message: localized } }), status)

beforeEach(() => resetClientForTests())
afterEach(() => vi.unstubAllGlobals())

/** The URL and init of every fetch, in order. */
function stub(...responses: Response[]) {
  const fetcher = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(responses.shift() ?? json({})))
  vi.stubGlobal('fetch', fetcher)
  return () => fetcher.mock.calls.map(([url, init]) => ({ url, method: init?.method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body === undefined ? undefined : JSON.parse(init.body as string), init }))
}

describe('the mailhero.ui.v2 client', () => {
  it('reads with GET, same-origin, no-store and no redirect, and needs no CSRF token', async () => {
    const calls = stub(json({ name: 'overview', message_count: 9, logical_bytes: 1234 }))
    const overview = await api.getOverview({ name: 'overview' })
    expect([overview.messageCount, overview.logicalBytes]).toEqual([9, 1234])
    expect(calls()).toEqual([expect.objectContaining({ url: '/api/v2/overview', method: 'GET', init: expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' }) })])
    expect(calls()[0].headers).not.toHaveProperty('X-CSRF-Token')
  })

  it('lays the delivery dashboard query out as SummarizeDeliveryAttempts', async () => {
    const calls = stub(json({ time_zone: 'America/Los_Angeles' }))
    await api.summarizeDeliveryAttempts({ parent: 'deliveries/-', startTime: timestamp('2026-09-01T07:00:00.000Z'), endTime: timestamp('2026-09-02T07:00:00.000Z'),
      granularity: SummarizeDeliveryAttemptsRequest_Granularity.DAY, timeZone: 'America/Los_Angeles' })
    const url = new URL(calls()[0].url, 'https://mail-hero.example.test')
    expect(url.pathname).toBe('/api/v2/deliveries/-/attempts:summarize')
    expect(Object.fromEntries(url.searchParams)).toEqual({ start_time: '2026-09-01T07:00:00Z', end_time: '2026-09-02T07:00:00Z', granularity: 'day', time_zone: 'America/Los_Angeles' })
  })

  it('gets the CSRF token once from /api/csrf, then sends it with every mutation', async () => {
    const created = { name: 'endpoints/created', display_name: 'Personal', uri: 'https://example.test/hook' }
    const calls = stub(json({ token: 'signed-token' }), json(created), json({ endpoint: created, affected_revision_count: 2 }))
    await api.createEndpoint({ endpoint: { displayName: 'Personal', uri: 'https://example.test/hook', authType: Endpoint_AuthType.BEARER, credential: 'secret' }, requestId: '9b2f0c1e-0000-4000-8000-000000000001' })
    await api.unblockEndpoint({ name: 'endpoints/endpoint-1', etag: '7' })
    const [token, create, unblock] = calls()
    expect(token).toMatchObject({ url: '/api/csrf' })
    expect(create).toMatchObject({ url: '/api/v2/endpoints?request_id=9b2f0c1e-0000-4000-8000-000000000001', method: 'POST',
      headers: { 'X-CSRF-Token': 'signed-token', 'Content-Type': 'application/json' }, body: { display_name: 'Personal', uri: 'https://example.test/hook', auth_type: 'bearer', credential: 'secret' } })
    expect(unblock).toMatchObject({ url: '/api/v2/endpoints/endpoint-1:unblock', method: 'POST', headers: { 'X-CSRF-Token': 'signed-token' }, body: { etag: '7' } })
    expect(calls()).toHaveLength(3)
  })

  it('sends only the masked fields of an update, the etag among them', async () => {
    const calls = stub(json({ token: 'signed-token' }), json({ name: 'settings', etag: '4' }))
    await api.updateSettings({ settings: { name: 'settings', etag: '3', sendPaused: true, rawRetentionDays: 9 }, updateMask: { paths: ['send_paused', 'etag'] } })
    expect(calls()[1]).toMatchObject({ url: '/api/v2/settings?update_mask=send_paused%2Cetag', method: 'PATCH', body: { etag: '3', send_paused: true } })
  })

  it('renews a refused CSRF token once and repeats the same request', async () => {
    const calls = stub(json({ token: 'old' }), failure(403, Code.PERMISSION_DENIED, 'CSRF_FAILED'), json({ token: 'new' }), json({ name: 'messages/m' }))
    await api.reparseMessage({ name: 'messages/m', requestId: '9b2f0c1e-0000-4000-8000-000000000002' })
    expect(calls().map(call => [call.url, call.headers['X-CSRF-Token']])).toEqual([['/api/csrf', undefined], ['/api/v2/messages/m:reparse', 'old'], ['/api/csrf', undefined], ['/api/v2/messages/m:reparse', 'new']])
    expect(calls()[1].body).toEqual(calls()[3].body)
  })

  it('turns every failure into an ApiError with the reason, the copy and the request ID', async () => {
    stub(failure(409, Code.ABORTED, 'ETAG_MISMATCH', {}, '状态已改变，请刷新后重试'))
    await expect(api.getMessage({ name: 'messages/m' })).rejects.toMatchObject({ status: 409, reason: 'ETAG_MISMATCH', message: '状态已改变，请刷新后重试', requestId: '0123456789abcdef' })
    stub(failure(400, Code.INVALID_ARGUMENT, 'INVALID_RETENTION_POLICY', { rule: 'raw_after_content' }))
    await expect(api.getSettings({ name: 'settings' })).rejects.toMatchObject({ reason: 'INVALID_RETENTION_POLICY', message: '原件保留期不能长于正文保留期。' })
    stub(new Response('<html>proxy</html>', { status: 502 }))
    await expect(api.getSettings({ name: 'settings' })).rejects.toMatchObject({ status: 502, reason: 'BAD_RESPONSE' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    const offline = await api.getSettings({ name: 'settings' }).catch((error: unknown) => error)
    expect(offline).toBeInstanceOf(ApiError)
    expect(offline).toMatchObject({ status: 0, reason: 'NETWORK_ERROR', message: NETWORK_MESSAGE })
    // An input the client cannot lay out is refused before anything is sent.
    const calls = stub()
    await expect(api.getMessage({ name: 'deliveries/x' })).rejects.toMatchObject({ status: 400, reason: 'BAD_REQUEST' })
    expect(calls()).toEqual([])
  })

  it('loads a message, its content and its deliveries together', async () => {
    const calls = stub(json({ name: 'messages/m', subject: 'S' }), json({ name: 'messages/m/content', text: 'T' }), json({ deliveries: [{ name: 'deliveries/e' }] }))
    const view = await loadMessage('m', 1)
    expect([view.message.subject, view.content.text, view.deliveries.map(item => item.name)]).toEqual(['S', 'T', ['deliveries/e']])
    expect(calls().map(call => call.url)).toEqual(['/api/v2/messages/m', '/api/v2/messages/m/content', `/api/v2/deliveries?page_size=1&filter=${encodeURIComponent('message = "messages/m"')}`])
  })

  it('quotes the search box and joins the restrictions with AND', () => {
    expect(filterOf('  "独立" 服务 ', ['delivery_state = FAILED', '', null, 'has_attachments = true'])).toBe('"\\"独立\\" 服务" AND delivery_state = FAILED AND has_attachments = true')
    expect(filterOf('', [])).toBe('')
  })
})
