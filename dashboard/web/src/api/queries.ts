import { QueryClient, useMutation, useQuery, useQueryClient, type Query } from '@tanstack/react-query'
import type { GuardLevel } from '../../../worker/src/api-types.ts'
import type {
  CanaryStartRequestV2,
  CloudflareResponse,
  FlowsResponse,
  HomeResponse,
  OpsResponse,
  ViewId,
} from '../../../worker/src/api-v2-types.ts'
import { ApiError, apiV2 } from './client'

/**
 * Only the visible view is read, every 5 minutes while the page is visible (the cron updates the data
 * every 30); a view's query is disabled while another tab is shown, so hidden views never poll.
 */
export const VIEW_INTERVAL_MS = 5 * 60_000
export const REGISTRY_KEY = ['v2', 'registry'] as const
export const viewKey = (view: ViewId) => ['v2', view] as const

export interface ViewData {
  home: HomeResponse
  flows: FlowsResponse
  cloudflare: CloudflareResponse
  ops: OpsResponse
}

const FETCH: { readonly [V in ViewId]: () => Promise<ViewData[V]> } = {
  home: () => apiV2.home(),
  flows: () => apiV2.flows(),
  cloudflare: () => apiV2.cloudflare(),
  ops: () => apiV2.ops(),
}

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

/** The registry is static per build: fetched once per page load. */
export function useRegistry() {
  return useQuery({ queryKey: REGISTRY_KEY, queryFn: () => apiV2.registry(), staleTime: Infinity, gcTime: Infinity })
}

export function useView<V extends ViewId>(view: V, enabled: boolean) {
  return useQuery({
    queryKey: viewKey(view),
    queryFn: FETCH[view],
    enabled,
    refetchInterval: VIEW_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })
}

/** Every dynamic view but `except` (the registry never changes within a build). */
function otherViews(except: ViewId | null) {
  return (query: Query) => query.queryKey[0] === 'v2' && query.queryKey[1] !== 'registry' && query.queryKey[1] !== except
}

/**
 * Owner refresh of the app statuses and probes (`/home?refresh=1`; the Worker polls each app at most
 * every 10 minutes and answers at most once a minute with fresh data). Afterwards the visible view is
 * read again, so 业务流程 and 操作与记录 show the new statuses too.
 */
export function useRefreshHome() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => apiV2.home(true),
    onSuccess: (home) => {
      client.setQueryData(viewKey('home'), home)
      void client.invalidateQueries({ predicate: otherViews('home') })
    },
  })
}

/** Owner refresh of the Cloudflare usage (`/cloudflare?refresh=1`, GraphQL at most once a minute). */
export function useRefreshCloudflare() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => apiV2.cloudflare(true),
    onSuccess: (cloudflare) => {
      client.setQueryData(viewKey('cloudflare'), cloudflare)
      void client.invalidateQueries({ predicate: otherViews('cloudflare') })
    },
  })
}

export function useStartCanary() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (canaryId: CanaryStartRequestV2['canary_id']) => apiV2.startCanary(canaryId),
    onSettled: () => client.invalidateQueries({ predicate: otherViews(null) }),
  })
}

export function useSetGuard() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (level: GuardLevel) => apiV2.setGuard(level),
    onSuccess: ({ guard }) => {
      client.setQueryData<OpsResponse>(viewKey('ops'), (old) => (old ? { ...old, guard } : old))
      client.setQueryData<CloudflareResponse>(viewKey('cloudflare'), (old) => (old ? { ...old, guard } : old))
    },
    onSettled: () => client.invalidateQueries({ predicate: otherViews(null) }),
  })
}
