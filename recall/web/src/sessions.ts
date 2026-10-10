/**
 * A day of the timeline from its visits (../../docs/design.md §8.4): the focus spans cut to the day, their union (a
 * span on two devices at once counts once), the focus of each local hour, the sessions (consecutive focus on one
 * site, gaps of up to five minutes merged) and the sites' colors (§8.2: a slot of --series-1 … --series-8 from a hash
 * of the host; on a day where two shown sites want the same slot, the more focused keeps it and the other borrows a
 * free one, and beyond eight sites the rest are muted, mailsort's groupSlots rule).
 */
import type { Visit } from '@ziyixi/proto/recall/ui/v1/page_pb'
import { hourStart } from './day.ts'
import { ms } from './format.ts'

/** One stretch of focus within the day, with the page it was on. */
export interface Span {
  readonly start: number
  readonly end: number
  /** The page's ID (`pages/<id>` without its prefix). */
  readonly page: string
  readonly site: string
  readonly title: string
  readonly url: string
}

export interface SessionPage {
  readonly page: string
  readonly title: string
  readonly url: string
  readonly seconds: number
}

export interface Session {
  readonly site: string
  readonly start: number
  readonly end: number
  /** Seconds of focus (the union of its spans). */
  readonly seconds: number
  /** Its pages in the order they were first focused. */
  readonly pages: readonly SessionPage[]
}

/** Gaps of up to this long between two spans of one site are one session. */
const SESSION_GAP_MS = 5 * 60_000
/** A session with less focus than this is folded into its hour's 还有 N 个短暂访问. */
export const SHORT_SESSION_SECONDS = 30
/** The categorical slots of styles.css (--series-1 to --series-8). */
const SERIES = 8

/** The page ID of a visit's name, `pages/<page>/visits/<visit>`. */
function pageOf(name: string): string {
  return name.split('/')[1] ?? ''
}

/** Every focus span of `visits` cut to [start, end), oldest first. */
export function daySpans(visits: readonly Visit[], start: number, end: number): Span[] {
  const spans: Span[] = []
  for (const visit of visits) {
    for (const focus of visit.focusSpans) {
      const from = Math.max(start, ms(focus.startTime) ?? 0)
      const to = Math.min(end, ms(focus.endTime) ?? 0)
      if (to > from) spans.push({ start: from, end: to, page: pageOf(visit.name), site: visit.site, title: visit.title, url: visit.url })
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

/** The union of spans as sorted, disjoint [start, end) pairs. */
function union(spans: readonly { readonly start: number; readonly end: number }[]): [number, number][] {
  const out: [number, number][] = []
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last !== undefined && span.start <= last[1]) last[1] = Math.max(last[1], span.end)
    else out.push([span.start, span.end])
  }
  return out
}

/** Seconds covered by the union of spans. */
export function unionSeconds(spans: readonly { readonly start: number; readonly end: number }[]): number {
  return union(spans).reduce((sum, [from, to]) => sum + (to - from), 0) / 1000
}

/** Seconds of focus in each local hour of the day `key` (24 entries; a repeated hour of a clock change adds up). */
export function hourSeconds(spans: readonly Span[], key: string): number[] {
  const hours = Array.from({ length: 24 }, () => 0)
  for (const [from, to] of union(spans)) {
    for (let at = from; at < to; ) {
      const hour = new Date(at).getHours()
      const next = Math.min(to, Math.max(at + 1, hourStart(key, hour + 1)))
      hours[hour] = (hours[hour] ?? 0) + (next - at) / 1000
      at = next
    }
  }
  return hours
}

/** The day's sessions, oldest first: consecutive focus on one site, gaps of up to SESSION_GAP_MS merged. */
export function sessions(spans: readonly Span[]): Session[] {
  const groups: Span[][] = []
  let end = -Infinity
  for (const span of spans) {
    const current = groups[groups.length - 1]
    if (current !== undefined && current[0]?.site === span.site && span.start - end <= SESSION_GAP_MS) {
      current.push(span)
      end = Math.max(end, span.end)
    } else {
      groups.push([span])
      end = span.end
    }
  }
  return groups.map((group) => {
    const pages = new Map<string, Span[]>()
    for (const span of group) pages.set(span.page, [...(pages.get(span.page) ?? []), span])
    return {
      site: group[0]?.site ?? '',
      start: group[0]?.start ?? 0,
      end: Math.max(...group.map((span) => span.end)),
      seconds: unionSeconds(group),
      pages: [...pages.values()].map((own) => {
        const last = own[own.length - 1]
        return { page: own[0]?.page ?? '', title: last?.title ?? '', url: last?.url ?? '', seconds: unionSeconds(own) }
      }),
    }
  })
}

/** A host's own slot, 1-8 (FNV-1a of the host), so a site keeps its color from day to day. */
export function homeSlot(site: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < site.length; i++) hash = Math.imul(hash ^ site.charCodeAt(i), 0x01000193) >>> 0
  return (hash % SERIES) + 1
}

/**
 * The slots of the sites shown on a day, by their focus: the eight most focused take their home slot, or a free
 * one when a more focused site holds it; the rest are 0 (muted).
 */
export function siteSlots(focus: ReadonlyMap<string, number>): Map<string, number> {
  const order = [...focus.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([site]) => site)
  const slots = new Map<string, number>()
  const borrowing: string[] = []
  for (const site of order.slice(0, SERIES)) {
    const home = homeSlot(site)
    if ([...slots.values()].includes(home)) borrowing.push(site)
    else slots.set(site, home)
  }
  for (const site of borrowing) {
    const taken = new Set(slots.values())
    slots.set(site, Array.from({ length: SERIES }, (_, i) => i + 1).find((slot) => !taken.has(slot)) ?? 0)
  }
  for (const site of order.slice(SERIES)) slots.set(site, 0)
  return slots
}
