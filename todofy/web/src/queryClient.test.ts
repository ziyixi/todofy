import { describe, expect, it } from 'vitest'
import { ApiError } from './api/client'
import { shouldRetry } from './queryClient'

describe('shouldRetry', () => {
  it('retries what can heal by itself: no answer, UNAVAILABLE and edge error pages', () => {
    expect(shouldRetry(0, new ApiError(0, 'NETWORK_ERROR', 'offline'))).toBe(true)
    expect(shouldRetry(1, new ApiError(503, 'UNAVAILABLE', 'later'))).toBe(true)
    expect(shouldRetry(0, new ApiError(502, 'BAD_RESPONSE', 'edge'))).toBe(true)
    expect(shouldRetry(2, new ApiError(503, 'UNAVAILABLE', 'later'))).toBe(false)
  })

  it('never retries a bug or an answer that will not change', () => {
    expect(shouldRetry(0, new ApiError(500, 'INTERNAL', 'bug'))).toBe(false)
    expect(shouldRetry(0, new ApiError(500, 'BAD_RESPONSE', 'unreadable'))).toBe(false)
    expect(shouldRetry(0, new ApiError(503, 'MAINTENANCE', 'writes wait'))).toBe(false)
    expect(shouldRetry(0, new ApiError(400, 'BAD_REQUEST', 'no'))).toBe(false)
    expect(shouldRetry(0, new Error('a bug in the page'))).toBe(false)
  })
})
