import { describe, expect, it } from 'vitest'
import { apiError, mockApi } from '../test/harness'
import { EVENT_ID, eventDetail } from '../test/fixtures'
import { api, ApiError } from './client'

const body = { action: 'dismiss', version: 5, action_request_id: '0e8f7a55-1c2d-4e5f-8a9b-0c1d2e3f4a5b' } as const

describe('api client', () => {
  it('fetches a CSRF token once and sends it with every POST', async () => {
    const { calls } = mockApi({ [`POST /api/v1/events/${EVENT_ID}/reconcile`]: eventDetail() })
    await api.reconcile(EVENT_ID, body)
    await api.reconcile(EVENT_ID, body)
    expect(calls.filter((call) => call.path === '/api/v1/csrf')).toHaveLength(1)
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(2)
    for (const post of posts) {
      expect(post.headers['x-csrf-token']).toBe('csrf-token-1')
      expect(post.headers['content-type']).toBe('application/json')
      expect(post.body).toEqual(body)
    }
  })

  it('drops the token after a 403 so the next POST fetches a new one', async () => {
    let first = true
    const { calls } = mockApi({
      [`POST /api/v1/events/${EVENT_ID}/reconcile`]: () => {
        if (!first) return eventDetail()
        first = false
        return apiError(403, 'csrf_failed')
      },
    })
    await expect(api.reconcile(EVENT_ID, body)).rejects.toMatchObject({ status: 403, code: 'csrf_failed' })
    await api.reconcile(EVENT_ID, body)
    expect(calls.filter((call) => call.path === '/api/v1/csrf')).toHaveLength(2)
  })

  it('keeps the API code and request ID of an error envelope', async () => {
    mockApi({ [`GET /api/v1/events/${EVENT_ID}`]: apiError(404, 'not_found', 'req-42') })
    const error = await api.event(EVENT_ID).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 404, code: 'not_found', requestId: 'req-42', message: '测试错误' })
  })

  it('reports a non-JSON answer (an Access login page, say) as bad_response', async () => {
    mockApi({ 'GET /api/v1/setup': { status: 502, body: undefined } })
    await expect(api.setup()).rejects.toMatchObject({ status: 502, code: 'bad_response', requestId: null })
  })

  it('reports a failed fetch as network_error', async () => {
    mockApi({ 'GET /api/v1/setup': new TypeError('Failed to fetch') })
    await expect(api.setup()).rejects.toMatchObject({ status: 0, code: 'network_error' })
  })

  it('sends the state filter only with the recent view', async () => {
    const { calls } = mockApi({ 'GET /api/v1/events': { items: [], next_cursor: null } })
    await api.events({ view: 'recent', state: 'failed_summary', cursor: 'abc', limit: 50 })
    await api.events({ view: 'attention', state: 'failed_summary' })
    expect(calls.map((call) => call.search)).toEqual(['?view=recent&state=failed_summary&cursor=abc&limit=50', '?view=attention'])
  })
})
