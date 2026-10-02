import { ReconcileAction } from '@ziyixi/proto/todofy/ui/v1/mail_event_pb'
import { describe, expect, it } from 'vitest'
import { EVENT_ID, eventDetail } from '../test/fixtures'
import { apiError, mockApi } from '../test/harness'
import { ApiError, todofy } from './client'
import { mailEventName } from './types'

const RECONCILE = `POST /api/v1/mailEvents/${EVENT_ID}:reconcile`
const request = {
  name: mailEventName(EVENT_ID),
  action: ReconcileAction.DISMISS,
  etag: '5',
  requestId: '0e8f7a55-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
}

describe('todofy.ui.v1 client', () => {
  it('fetches a CSRF token once at /api/csrf and sends it with every mutation', async () => {
    const { calls } = mockApi({ [RECONCILE]: eventDetail() })
    await todofy.reconcileMailEvent(request)
    await todofy.reconcileMailEvent(request)
    expect(calls.filter((call) => call.path === '/api/csrf')).toHaveLength(1)
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(2)
    for (const post of posts) {
      expect(post.headers['x-csrf-token']).toBe('csrf-token-1')
      expect(post.headers['content-type']).toBe('application/json')
      // The name is in the path; the body is the rest of the request in the wire JSON profile.
      expect(post.body).toEqual({ action: 'dismiss', etag: '5', request_id: request.requestId })
    }
  })

  it('renews a refused CSRF token once and repeats the same request', async () => {
    let first = true
    const { calls } = mockApi({
      [RECONCILE]: () => {
        if (!first) return eventDetail()
        first = false
        return apiError(403, 'CSRF_FAILED')
      },
    })
    const event = await todofy.reconcileMailEvent(request)
    expect(event.etag).toBe('5')
    expect(calls.filter((call) => call.path === '/api/csrf')).toHaveLength(2)
    const posts = calls.filter((call) => call.method === 'POST').map((call) => call.body)
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(posts[0])
  })

  it('keeps the reason, the request ID, the copy and the current event of a Status', async () => {
    const current = { '@type': 'type.googleapis.com/todofy.ui.v1.MailEvent', ...eventDetail({ etag: '6', version: 6 }) }
    mockApi({ [RECONCILE]: apiError(409, 'ETAG_MISMATCH', 'req-42', [current]) })
    const error = await todofy.reconcileMailEvent(request).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, reason: 'ETAG_MISMATCH', requestId: 'req-42', message: '测试错误' })
    expect((error as ApiError).event?.etag).toBe('6')
  })

  it('reports a non-JSON answer (an Access login page, say) as BAD_RESPONSE', async () => {
    mockApi({ 'GET /api/v1/integration': { status: 502, body: undefined } })
    await expect(todofy.getIntegration({ name: 'integration' })).rejects.toMatchObject({ status: 502, reason: 'BAD_RESPONSE', requestId: null })
  })

  it('reports a failed fetch as NETWORK_ERROR', async () => {
    mockApi({ 'GET /api/v1/integration': new TypeError('Failed to fetch') })
    await expect(todofy.getIntegration({ name: 'integration' })).rejects.toMatchObject({ status: 0, reason: 'NETWORK_ERROR' })
  })

  it('reads an answer leniently: a field this build does not know is skipped', async () => {
    mockApi({ [`GET /api/v1/mailEvents/${EVENT_ID}`]: { ...eventDetail(), added_later: true } })
    const event = await todofy.getMailEvent({ name: mailEventName(EVENT_ID) })
    expect(event.subject).toBe('Quarterly tax reminder')
  })

  it('refuses a name that does not fit the path before sending anything', async () => {
    const { calls } = mockApi({})
    await expect(todofy.getMailEvent({ name: 'events/x' })).rejects.toMatchObject({ status: 400, reason: 'BAD_REQUEST' })
    expect(calls).toHaveLength(0)
  })
})
