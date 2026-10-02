import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api/client'

/** A gateway or edge answer without a Status body that a moment can heal (Cloudflare's 502/503/504 pages). */
const TRANSIENT_HTTP = new Set([502, 503, 504])

/**
 * Retry only failures that can heal by themselves (proto/README.md): no answer at all, UNAVAILABLE, or an edge
 * error page. INTERNAL (a bug) and every 4xx answer the same on a second try.
 */
export function shouldRetry(failures: number, error: unknown): boolean {
  if (failures >= 2) return false
  if (!(error instanceof ApiError)) return false
  if (error.status === 0 || error.reason === 'UNAVAILABLE') return true
  return error.reason === 'BAD_RESPONSE' && TRANSIENT_HTTP.has(error.status)
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000 },
      mutations: { retry: false },
    },
  })
}
