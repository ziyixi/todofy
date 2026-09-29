import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { EventDetail, EventState, EventView } from './types'

/** The overview is an aggregate: every screen shares one cached copy refreshed every five minutes. */
export const OVERVIEW_INTERVAL_MS = 5 * 60 * 1000
const PAGE_SIZE = 50

export const keys = {
  overview: ['overview'] as const,
  events: ['events'] as const,
  eventList: (view: EventView, state: EventState | null) => ['events', view, state] as const,
  event: (id: string) => ['event', id] as const,
  legacyText: (id: string) => ['legacy-text', id] as const,
  reminders: ['reminders'] as const,
  reports: ['reports'] as const,
  setup: ['setup'] as const,
}

export function useOverview() {
  return useQuery({
    queryKey: keys.overview,
    queryFn: api.overview,
    staleTime: OVERVIEW_INTERVAL_MS,
    refetchInterval: OVERVIEW_INTERVAL_MS,
    refetchOnWindowFocus: false,
  })
}

export function useEventList(view: EventView, state: EventState | null = null) {
  return useInfiniteQuery({
    queryKey: keys.eventList(view, state),
    queryFn: ({ pageParam }) => api.events({ view, state, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  })
}

/** Poll an event only while the Worker is about to move it, so a page left open costs no reads. */
export const EVENT_POLL_MS = 3000
const EVENT_POLL_HORIZON_MS = 60_000
const IN_FLIGHT: ReadonlySet<EventState> = new Set(['summarizing', 'todo_sending'])

export function eventPollInterval(event: EventDetail | undefined, now: number = Date.now()): number | false {
  if (!event) return false
  if (IN_FLIGHT.has(event.state)) return EVENT_POLL_MS
  if (event.next_attempt_at === null) return false
  return Date.parse(event.next_attempt_at) - now <= EVENT_POLL_HORIZON_MS ? EVENT_POLL_MS : false
}

export function useEvent(id: string) {
  return useQuery({
    queryKey: keys.event(id),
    queryFn: () => api.event(id),
    refetchInterval: (query) => eventPollInterval(query.state.data),
  })
}

export function useLegacyText(id: string, enabled: boolean) {
  return useQuery({ queryKey: keys.legacyText(id), queryFn: () => api.legacyText(id), enabled, staleTime: Infinity })
}

export function useReminders() {
  return useInfiniteQuery({
    queryKey: keys.reminders,
    queryFn: ({ pageParam }) => api.reminders(pageParam, PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  })
}

export function useReports() {
  return useQuery({ queryKey: keys.reports, queryFn: api.reportsLatest })
}

export function useSetup() {
  return useQuery({ queryKey: keys.setup, queryFn: api.setup, staleTime: Infinity })
}
