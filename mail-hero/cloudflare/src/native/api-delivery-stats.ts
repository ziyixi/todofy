// The delivery dashboard's numbers (mailhero.ui.v2 SummarizeDeliveryAttempts) and the time ranges of its drill-down
// (ListDeliveries' attempt filter): attempts that ended within a range, by outcome, in hours or days of a time zone.
import type { Env } from './types.ts'
import { bad, rows, type Row } from './api-common.ts'
import { HttpError } from './security.ts'
import { RESULT_SQL } from './api-deliveries.ts'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const SAMPLE = 6 * HOUR
// The largest clock change in tzdata (Antarctica/Troll, +00 <-> +02): N local
// days across a fall-back last up to N days plus this much real time.
export const DST_SLACK = 2 * HOUR
export const MAX_ZONE_SEGMENTS = 8

export type DeliveryBucket = 'hour' | 'day'
export type DeliveryRange = { from: string; to: string; fromMS: number; toMS: number }

function instant(value: string | null): { iso: string; ms: number } {
  // Require an explicit timezone. Date.parse alone also accepts ambiguous local
  // timestamps, which would make owner-selected ranges vary by location.
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  if (!parts) return bad('时间范围必须为带时区的 ISO 时间', 'invalid_time_range')
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) bad('时间范围无效', 'invalid_time_range')
  const ms = Date.parse(value as string)
  if (!Number.isFinite(ms)) bad('时间范围无效', 'invalid_time_range')
  return { iso: new Date(ms).toISOString(), ms }
}

/** An RFC 3339 instant with an explicit zone, as ISO UTC; INVALID_TIME_RANGE otherwise. */
export function parseInstant(value: string): string {
  return instant(value).iso
}

// maxDays counts local calendar days; the slack admits a range whose local
// days include a DST fall-back.
export function deliveryRange(fromText: string | null, toText: string | null, maxDays = 90, slack = DST_SLACK): DeliveryRange {
  const from = instant(fromText), to = instant(toText)
  if (to.ms <= from.ms || to.ms - from.ms > maxDays * DAY + slack) bad(`时间范围必须大于 0 且不超过 ${maxDays} 天`, 'invalid_time_range')
  return { from: from.iso, to: to.iso, fromMS: from.ms, toMS: to.ms }
}

// A zone over a bounded range is a few constant-offset segments. segment i
// covers [starts[i], starts[i+1]); offsets are seconds east of UTC. SQL and the
// bucket list both derive local time from these, never from per-row Intl calls.
export type ZoneSegments = { starts: number[]; offsets: number[] }
type OffsetFormat = Pick<Intl.DateTimeFormat, 'formatToParts'>

// A distinct code lets the dashboard fall back to UTC instead of failing.
const badZone = (message = '时区无效'): never => { throw new HttpError(400, 'invalid_time_zone', message) }
function zoneFormat(tz: string): Intl.DateTimeFormat {
  if (tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) badZone()
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }) } catch { return badZone() }
}

function offsetAt(format: OffsetFormat, ms: number): number {
  const name = format.formatToParts(ms).find(part => part.type === 'timeZoneName')?.value ?? ''
  const parts = name.match(/^(?:GMT|UTC)(?:([+\-\u2212])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?)?$/)
  if (!parts) return badZone()
  const seconds = Number(parts[2] ?? 0) * 3600 + Number(parts[3] ?? 0) * 60 + Number(parts[4] ?? 0)
  return parts[1] && parts[1] !== '+' ? -seconds : seconds
}

// Sample every 6 h and binary-search each change to the minute: O(range/6 h +
// changes x 9) Intl calls. A zone with more changes than the cap is refused.
export function zoneSegments(format: OffsetFormat, fromMS: number, toMS: number): ZoneSegments {
  const first = Math.floor(fromMS / MINUTE) * MINUTE, last = Math.ceil(toMS / MINUTE) * MINUTE
  const starts = [-Infinity], offsets = [offsetAt(format, first)]
  let known = first, sample = first
  while (sample < last) {
    sample = Math.min(sample + SAMPLE, last)
    const sampled = offsetAt(format, sample)
    while (sampled !== offsets.at(-1)) {
      let low = known, high = sample, highOffset = sampled
      while (high - low > MINUTE) {
        const middle = low + Math.floor((high - low) / MINUTE / 2) * MINUTE, offset = offsetAt(format, middle)
        if (offset === offsets.at(-1)) low = middle
        else { high = middle; highOffset = offset }
      }
      if (starts.length >= MAX_ZONE_SEGMENTS) badZone('所选时段内时区偏移变化过多')
      starts.push(high); offsets.push(highOffset); known = high
    }
    known = sample
  }
  return { starts, offsets }
}

function segmentAt(zone: ZoneSegments, ms: number): number {
  let index = 0
  while (index + 1 < zone.starts.length && zone.starts[index + 1] <= ms) index++
  return index
}
// SQLite date modifier for an offset; LMT-era offsets can carry seconds.
function shift(offset: number): string {
  const sign = offset < 0 ? '-' : '+', size = Math.abs(offset)
  return size % 60 === 0 ? `${sign}${size / 60} minutes` : `${sign}${size} seconds`
}
// First instant whose local wall clock is at or after `wall`: the local
// midnight itself, or the first valid instant when DST skips it.
function localStart(zone: ZoneSegments, wall: number): number {
  for (let index = 0; ; index++) {
    const at = Math.max(zone.starts[index], wall - zone.offsets[index] * 1000)
    if (index + 1 === zone.starts.length || at < zone.starts[index + 1]) return at
  }
}

type Counts = { succeeded: number; retried: number; failed: number; unknown: number }
const zero = (): Counts => ({ succeeded: 0, retried: 0, failed: 0, unknown: 0 })

/** What SummarizeDeliveryAttempts asks for: an exact range (ISO instants), the buckets' length and an IANA zone. */
export interface StatsQuery { from: string; to: string; bucket: DeliveryBucket; tz: string }

export async function deliveryStats(env: Env, query: StatsQuery): Promise<Row> {
  const { bucket, tz } = query
  const format = zoneFormat(tz)
  const range = deliveryRange(query.from, query.to, bucket === 'hour' ? 7 : 90)
  const zone = zoneSegments(format, range.fromMS - 2 * DAY, range.toMS)
  const firstSegment = segmentAt(zone, range.fromMS), lastSegment = segmentAt(zone, range.toMS - 1)
  const binds: string[] = [range.from, range.to]
  let cases = ''
  for (let index = firstSegment; index < lastSegment; index++) {
    binds.push(new Date(zone.starts[index + 1]).toISOString(), shift(zone.offsets[index]))
    cases += ` WHEN a.finished_at<?${binds.length - 1} THEN ?${binds.length}`
  }
  binds.push(shift(zone.offsets[lastSegment]))
  const modifier = cases ? `CASE${cases} ELSE ?${binds.length} END` : `?${binds.length}`
  // An hour key carries its offset, so a repeated fall-back hour stays two buckets.
  const key = bucket === 'hour' ? `strftime('%Y-%m-%dT%H',a.finished_at,${modifier})||'|'||${modifier}` : `strftime('%Y-%m-%d',a.finished_at,${modifier})`
  const grouped = await rows(env, `SELECT ${key} bucket,
    sum(${RESULT_SQL.SUCCEEDED}) succeeded,
    sum(${RESULT_SQL.RETRIED}) retried,
    sum(${RESULT_SQL.FAILED}) failed,
    sum(${RESULT_SQL.UNKNOWN}) unknown
    FROM delivery_attempts a JOIN deliveries d ON d.event_id=a.event_id
    JOIN messages m ON m.id=d.message_id
    WHERE a.finished_at>=?1 AND a.finished_at<?2 AND m.origin='cloudflare'
      AND a.outcome IN('delivered','retryable','rejected','failed','interrupted')
    GROUP BY bucket ORDER BY bucket`, ...binds)
  const totals = zero(), byBucket = new Map<string, Counts>()
  for (const row of grouped) {
    const counts = { succeeded: Number(row.succeeded), retried: Number(row.retried), failed: Number(row.failed), unknown: Number(row.unknown) }
    byBucket.set(row.bucket, counts)
    for (const field of ['succeeded', 'retried', 'failed', 'unknown'] as const) totals[field] += counts[field]
  }
  const starts: Array<{ at: number; key: string }> = []
  const wall = (ms: number) => ms + zone.offsets[segmentAt(zone, ms)] * 1000
  if (bucket === 'day') {
    for (let day = Math.floor(wall(range.fromMS) / DAY), last = Math.floor(wall(range.toMS - 1) / DAY); day <= last; day++) {
      starts.push({ at: localStart(zone, day * DAY), key: new Date(day * DAY).toISOString().slice(0, 10) })
    }
  } else {
    // Local hour boundaries inside each segment, plus the segment start itself.
    for (let index = firstSegment; index <= lastSegment; index++) {
      const offset = zone.offsets[index] * 1000, end = Math.min(zone.starts[index + 1] ?? Infinity, range.toMS)
      let at = index === firstSegment ? Math.max(zone.starts[index], Math.floor((range.fromMS + offset) / HOUR) * HOUR - offset) : zone.starts[index]
      for (; at < end; at = Math.floor((at + offset) / HOUR) * HOUR + HOUR - offset) {
        starts.push({ at, key: `${new Date(at + offset).toISOString().slice(0, 13)}|${shift(zone.offsets[index])}` })
      }
    }
  }
  const buckets = starts.map(({ at, key }, index) => {
    const counts = byBucket.get(key) ?? zero()
    byBucket.delete(key)
    return { start: new Date(at).toISOString(), end: new Date(starts[index + 1]?.at ?? range.toMS).toISOString(), ...counts }
  })
  return { from: range.from, to: range.to, bucket, time_zone: tz, totals, buckets }
}
