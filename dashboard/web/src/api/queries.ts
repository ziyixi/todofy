import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GuardLevel, OverviewResponse } from '../../../worker/src/api-types.ts'
import { ApiError, api } from './client'

/** The overview is re-read every 5 minutes while the page is visible (the cron updates it every 30). */
export const OVERVIEW_INTERVAL_MS = 5 * 60_000
export const OVERVIEW_KEY = ['overview'] as const

/** Retry only failures that can heal by themselves; a 4xx will not change on a second try. */
function shouldRetry(failures: number, error: unknown): boolean {
  if (failures >= 2) return false
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 60_000 },
      mutations: { retry: false },
    },
  })
}

export function useOverview() {
  return useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => api.overview(false),
    refetchInterval: OVERVIEW_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })
}

/** Owner refresh: `?refresh=1`; the Worker fetches at most once per minute and otherwise returns the cache. */
export function useRefresh() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.overview(true),
    onSuccess: (overview) => client.setQueryData(OVERVIEW_KEY, overview),
  })
}

export function useStartCanary() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.startCanary(),
    onSettled: () => client.invalidateQueries({ queryKey: OVERVIEW_KEY }),
  })
}

export function useSetGuard() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (level: GuardLevel) => api.setGuard(level),
    onSuccess: ({ guard }) => {
      client.setQueryData<OverviewResponse>(OVERVIEW_KEY, (old) => (old ? { ...old, guard } : old))
    },
    onSettled: () => client.invalidateQueries({ queryKey: OVERVIEW_KEY }),
  })
}
