import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { MailEvent_State } from '@ziyixi/proto/todofy/ui/v1/mail_event_pb'
import { useRef } from 'react'
import { todofy } from './client'
import { eventStates, iso, mailEventName, type EventState, type MailEvent } from './types'

/** The service status is an aggregate: every screen shares one cached copy refreshed every five minutes. */
export const OVERVIEW_INTERVAL_MS = 5 * 60 * 1000
const PAGE_SIZE = 50

export type EventView = 'recent' | 'attention'

export const keys = {
  overview: ['overview'] as const,
  events: ['events'] as const,
  eventList: (view: EventView, state: EventState | null) => ['events', view, state] as const,
  event: (id: string) => ['event', id] as const,
  legacyText: (name: string) => ['legacy-text', name] as const,
  reminders: ['reminders'] as const,
  reports: ['reports'] as const,
  setup: ['setup'] as const,
  dailyMetrics: (days: number) => ['metrics', 'daily', days] as const,
  gtdDays: (days: number) => ['gtd', 'days', days] as const,
  gtdReview: ['gtd', 'review'] as const,
}

export function useOverview() {
  return useQuery({
    queryKey: keys.overview,
    queryFn: () => todofy.getServiceStatus({ name: 'serviceStatus' }),
    staleTime: OVERVIEW_INTERVAL_MS,
    refetchInterval: OVERVIEW_INTERVAL_MS,
    refetchOnWindowFocus: false,
  })
}

/** Recent events (newest first, optionally of one state) or the attention list (oldest first), a page at a time. */
export function useEventList(view: EventView, state: EventState | null = null) {
  return useInfiniteQuery({
    queryKey: keys.eventList(view, state),
    queryFn: ({ pageParam }) =>
      todofy.listMailEvents({
        pageSize: PAGE_SIZE,
        pageToken: pageParam,
        attention: view === 'attention',
        state: view === 'recent' && state !== null ? (eventStates.value(state) ?? MailEvent_State.UNSPECIFIED) : MailEvent_State.UNSPECIFIED,
      }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextPageToken || undefined,
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
const IN_FLIGHT: ReadonlySet<MailEvent_State> = new Set([MailEvent_State.SUMMARIZING, MailEvent_State.TODO_SENDING])

export function eventPollInterval(event: MailEvent | undefined, now: number = Date.now(), unchangedSince: number = now): number | false {
  if (!event || now - unchangedSince > EVENT_POLL_MAX_MS) return false
  if (IN_FLIGHT.has(event.state)) return EVENT_POLL_MS
  const next = iso(event.nextAttemptTime)
  if (next === null) return false
  const untilDue = Date.parse(next) - now
  return untilDue <= EVENT_POLL_HORIZON_MS && untilDue >= -EVENT_POLL_GRACE_MS ? EVENT_POLL_MS : false
}

export function useEvent(id: string) {
  // When the shown etag first appeared; polling stops once it has not changed for a while.
  const seen = useRef<{ id: string; etag: string; since: number } | null>(null)
  return useQuery({
    queryKey: keys.event(id),
    queryFn: () => todofy.getMailEvent({ name: mailEventName(id) }),
    refetchInterval: (query) => {
      const event = query.state.data
      const now = Date.now()
      if (event && (seen.current?.id !== id || seen.current.etag !== event.etag)) {
        seen.current = { id, etag: event.etag, since: now }
      }
      return eventPollInterval(event, now, seen.current?.since ?? now)
    },
  })
}

/** A legacy text by its resource name (MailEvent.legacy_text), fetched only once the owner opens it. */
export function useLegacyText(name: string, enabled: boolean) {
  return useQuery({ queryKey: keys.legacyText(name), queryFn: () => todofy.getLegacyText({ name }), enabled, staleTime: Infinity })
}

export function useReminders() {
  return useInfiniteQuery({
    queryKey: keys.reminders,
    queryFn: ({ pageParam }) => todofy.listDailyReminders({ pageSize: PAGE_SIZE, pageToken: pageParam }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextPageToken || undefined,
  })
}

export function useReports() {
  return useQuery({ queryKey: keys.reports, queryFn: () => todofy.getLatestReports({ name: 'latestReports' }) })
}

/** Daily metrics change once a day (written a few minutes after UTC midnight). */
export const METRICS_DAYS = 30
const DAILY_METRICS_STALE_MS = 60 * 60 * 1000

/** The last `days` finished UTC days, oldest first (ListMetricDays answers the newest first). */
export function useDailyMetrics(days: number = METRICS_DAYS) {
  return useQuery({
    queryKey: keys.dailyMetrics(days),
    queryFn: async () => (await todofy.listMetricDays({ pageSize: days })).metricDays.toReversed(),
    staleTime: DAILY_METRICS_STALE_MS,
    refetchOnWindowFocus: false,
  })
}

/** The GTD ledger's daily aggregates change once a day (the 13:00 UTC Todoist snapshot). */
export const GTD_DAYS = 30

/** The last `days` UTC days up to today, oldest first (ListGtdDays answers the newest first). */
export function useGtdDays(days: number = GTD_DAYS) {
  return useQuery({
    queryKey: keys.gtdDays(days),
    queryFn: async () => (await todofy.listGtdDays({ pageSize: days })).gtdDays.toReversed(),
    staleTime: DAILY_METRICS_STALE_MS,
    refetchOnWindowFocus: false,
  })
}

/** The newest weekly review of the last 12 weeks, or null. */
export function useLatestReview() {
  return useQuery({
    queryKey: keys.gtdReview,
    queryFn: async () => (await todofy.listGtdReviews({ pageSize: 1 })).gtdReviews[0] ?? null,
    staleTime: DAILY_METRICS_STALE_MS,
    refetchOnWindowFocus: false,
  })
}

export function useSetup() {
  return useQuery({ queryKey: keys.setup, queryFn: () => todofy.getIntegration({ name: 'integration' }), staleTime: Infinity })
}
