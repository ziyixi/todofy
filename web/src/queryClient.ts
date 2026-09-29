import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api/client'

/** Retry only failures that can heal by themselves; a 4xx will not change on a second try. */
function shouldRetry(failures: number, error: unknown): boolean {
  if (failures >= 2) return false
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000 },
      mutations: { retry: false },
    },
  })
}
