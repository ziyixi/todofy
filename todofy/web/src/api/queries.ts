import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
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
  dailyMetrics: (days: number) => ['metrics', 'daily', days] as const,
  gtdDaily: (days: number) => ['gtd', 'daily', days] as const,
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

/**
 * Poll an event only while the Worker is about to move it: a call in flight, or a next step
 * due within a minute or overdue by at most EVENT_POLL_GRACE_MS (a healthy Worker takes a due row
 * within seconds). A row that stays overdue is held by a switch, a Todoist block or a backlog,
 * and polling it every 3 s would only spend the Free plan's shared request quota; the same goes
 * for any row that has not changed for EVENT_POLL_MAX_MS. Focus or a manual refresh picks it up.
 */
export const EVENT_POLL_MS = 3000
const EVENT_POLL_HORIZON_MS = 60_000
export const EVENT_POLL_GRACE_MS = 2 * 60_000
export const EVENT_POLL_MAX_MS = 5 * 60_000
const IN_FLIGHT: ReadonlySet<EventState> = new Set(['summarizing', 'todo_sending'])

export function eventPollInterval(
  event: EventDetail | undefined,
  now: number = Date.now(),
  unchangedSince: number = now,
): number | false {
  if (!event || now - unchangedSince > EVENT_POLL_MAX_MS) return false
  if (IN_FLIGHT.has(event.state)) return EVENT_POLL_MS
  if (event.next_attempt_at === null) return false
  const untilDue = Date.parse(event.next_attempt_at) - now
  return untilDue <= EVENT_POLL_HORIZON_MS && untilDue >= -EVENT_POLL_GRACE_MS ? EVENT_POLL_MS : false
}

export function useEvent(id: string) {
  // When the shown version first appeared; polling stops once it has not changed for a while.
  const seen = useRef<{ id: string; version: number; since: number } | null>(null)
  return useQuery({
    queryKey: keys.event(id),
    queryFn: () => api.event(id),
    refetchInterval: (query) => {
      const event = query.state.data
      const now = Date.now()
      if (event && (seen.current?.id !== id || seen.current.version !== event.version)) {
        seen.current = { id, version: event.version, since: now }
      }
      return eventPollInterval(event, now, seen.current?.since ?? now)
    },
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

/** Daily metrics change once a day (written a few minutes after UTC midnight). */
export const METRICS_DAYS = 30
const DAILY_METRICS_STALE_MS = 60 * 60 * 1000

export function useDailyMetrics(days: number = METRICS_DAYS) {
  return useQuery({
    queryKey: keys.dailyMetrics(days),
    queryFn: () => api.dailyMetrics(days),
    staleTime: DAILY_METRICS_STALE_MS,
    refetchOnWindowFocus: false,
  })
}

/** The GTD ledger's daily aggregates change once a day (the 13:00 UTC Todoist snapshot). */
export const GTD_DAYS = 30

export function useGtdDaily(days: number = GTD_DAYS) {
  return useQuery({
    queryKey: keys.gtdDaily(days),
    queryFn: () => api.gtdDaily(days),
    staleTime: DAILY_METRICS_STALE_MS,
    refetchOnWindowFocus: false,
  })
}

export function useSetup() {
  return useQuery({ queryKey: keys.setup, queryFn: api.setup, staleTime: Infinity })
}
