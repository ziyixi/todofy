/**
 * The reads several pages share, as TanStack Query options with one key each, so that a page reuses what another loaded
 * (and an invalidation reaches every page): the settings, the overview (its one poll is the shell's, every five
 * minutes: a few indexed D1 reads) and the live webhook targets (one page of at most 100: a personal service has a few).
 */
import { api } from './client'

export const settingsQuery = { queryKey: ['settings'], queryFn: () => api.getSettings({ name: 'settings' }) } as const
export const overviewQuery = { queryKey: ['overview'], queryFn: () => api.getOverview({ name: 'overview' }), staleTime: 300_000 } as const
export const endpointsQuery = { queryKey: ['endpoints'], queryFn: async () => (await api.listEndpoints({ pageSize: 100 })).endpoints } as const
