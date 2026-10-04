import { QueryClient, useMutation, useQuery, useQueryClient, type Query } from '@tanstack/react-query'
import type { AttentionItem, CloudflareView, FlowsView, GuardLevel, HomeView, OpsView, ShellFields, ViewId } from '../../../worker/src/api-types.ts'
import { ApiError, api } from './client'
import { applyAttentionResult } from './attention-cache'

/**
 * Only the visible view is read, every 5 minutes while the page is visible (the cron updates the data
 * every 30); a view's query is disabled while another tab is shown, so hidden views never poll.
 */
export const VIEW_INTERVAL_MS = 5 * 60_000
export const REGISTRY_KEY = ['v2', 'registry'] as const
export const viewKey = (view: ViewId) => ['v2', view] as const

export interface ViewData {
  home: HomeView
  flows: FlowsView
  cloudflare: CloudflareView
  ops: OpsView
}

const FETCH: { readonly [V in ViewId]: () => Promise<ViewData[V]> } = {
  home: () => api.home(),
  flows: () => api.flows(),
  cloudflare: () => api.cloudflare(),
  ops: () => api.ops(),
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
  return useQuery({ queryKey: REGISTRY_KEY, queryFn: () => api.registry(), staleTime: Infinity, gcTime: Infinity })
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
 * Owner refresh of the app statuses and probes (RefreshHomeView; the Worker polls each app at most every
 * 10 minutes and answers at most once a minute with fresh data). Afterwards the visible view is
 * read again, so 业务流程 and 操作与记录 show the new statuses too.
 */
export function useRefreshHome() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.refreshHome(),
    onSuccess: (home) => {
      client.setQueryData(viewKey('home'), home)
      void client.invalidateQueries({ predicate: otherViews('home') })
    },
  })
}

/** Owner refresh of the Cloudflare usage (RefreshCloudflareView, GraphQL at most once a minute). */
export function useRefreshCloudflare() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.refreshCloudflare(),
    onSuccess: (cloudflare) => {
      client.setQueryData(viewKey('cloudflare'), cloudflare)
      void client.invalidateQueries({ predicate: otherViews('cloudflare') })
    },
  })
}

export function useStartCanary() {
  const client = useQueryClient()
  return useMutation({
    // One request_id per owner action (made in the client): the CSRF retry repeats the same request.
    mutationFn: (canaryId: string) => api.startCanary(canaryId),
    onSettled: () => client.invalidateQueries({ predicate: otherViews(null) }),
  })
}

export function useRequestWebsiteSync() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (requestId: string) => api.requestWebsiteSync(requestId),
    onSettled: () => client.invalidateQueries({ predicate: otherViews(null) }),
  })
}

export function useSetGuard() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ level, app }: { level: GuardLevel; app: string }) => api.setGuard(level, app),
    onSuccess: ({ guard }) => {
      client.setQueryData<OpsView>(viewKey('ops'), (old) => (old ? { ...old, guard } : old))
      client.setQueryData<CloudflareView>(viewKey('cloudflare'), (old) => (old ? { ...old, guard } : old))
    },
    onSettled: () => client.invalidateQueries({ predicate: otherViews(null) }),
  })
}

/** One owner action keeps its UUID across transport retries; every view reads the durable result. */
export function useAttentionAction(onSaved: (item: AttentionItem) => void) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (action: { name: string; etag: string; requestId: string; restore: boolean }) =>
      action.restore ? api.restoreAttention(action.name, action.etag, action.requestId)
        : api.dismissAttention(action.name, action.etag, action.requestId),
    onSuccess: (item, action) => {
      onSaved(item)
      client.setQueriesData<ShellFields>({ predicate: otherViews(null) }, old =>
        old ? applyAttentionResult(old, action.etag, item) : old)
    },
    onSettled: () => client.invalidateQueries({ predicate: otherViews(null) }),
  })
}
