import type { Env } from './types.ts'
import { bad, rows } from './api-common.ts'
import { json } from './security.ts'

const DAY = 86_400_000
const HOUR = 3_600_000

export type DeliveryBucket = 'hour' | 'day'
export type DeliveryRange = { from: string; to: string; fromMS: number; toMS: number }

function instant(value: string | null): { iso: string; ms: number } {
  // Require an explicit timezone. Date.parse alone also accepts ambiguous local
  // timestamps, which would make owner-selected UTC ranges vary by location.
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  if (!parts) return bad('时间范围必须为带时区的 ISO 时间')
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) bad('时间范围无效')
  const ms = Date.parse(value as string)
  if (!Number.isFinite(ms)) bad('时间范围无效')
  return { iso: new Date(ms).toISOString(), ms }
}

export function deliveryRange(params: URLSearchParams, maxDays = 90): DeliveryRange {
  const from = instant(params.get('from')), to = instant(params.get('to'))
  if (to.ms <= from.ms || to.ms - from.ms > maxDays * DAY) bad(`时间范围必须大于 0 且不超过 ${maxDays} 天`)
  return { from: from.iso, to: to.iso, fromMS: from.ms, toMS: to.ms }
}

type Counts = { succeeded: number; retried: number; failed: number; unknown: number }
const zero = (): Counts => ({ succeeded: 0, retried: 0, failed: 0, unknown: 0 })

export async function deliveryStats(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams
  const bucket = params.get('bucket') ?? 'day'
  if (bucket !== 'hour' && bucket !== 'day') bad('bucket 只能为 hour 或 day')
  const range = deliveryRange(params, bucket === 'hour' ? 7 : 90)
  const step = bucket === 'hour' ? HOUR : DAY
  const prefixLength = bucket === 'hour' ? 13 : 10
  const grouped = await rows(env, `SELECT substr(a.finished_at,1,${prefixLength}) bucket,
    sum(a.outcome='delivered') succeeded,
    sum(a.outcome='retryable') retried,
    sum(a.outcome IN('rejected','failed')) failed,
    sum(a.outcome='interrupted') unknown
    FROM delivery_attempts a JOIN deliveries d ON d.event_id=a.event_id
    JOIN messages m ON m.id=d.message_id
    WHERE a.finished_at>=? AND a.finished_at<? AND m.origin='cloudflare'
      AND a.outcome IN('delivered','retryable','rejected','failed','interrupted')
    GROUP BY bucket ORDER BY bucket`, range.from, range.to)
  const byBucket = new Map<string, Counts>()
  for (const row of grouped) byBucket.set(row.bucket, {
    succeeded: Number(row.succeeded), retried: Number(row.retried),
    failed: Number(row.failed), unknown: Number(row.unknown),
  })
  const totals = zero(), buckets: Array<{ start: string } & Counts> = []
  for (let start = Math.floor(range.fromMS / step) * step; start < range.toMS; start += step) {
    const iso = new Date(start).toISOString()
    const key = iso.slice(0, prefixLength), counts = byBucket.get(key) ?? zero()
    buckets.push({ start: iso, ...counts })
    for (const field of ['succeeded', 'retried', 'failed', 'unknown'] as const) totals[field] += counts[field]
  }
  return json({ from: range.from, to: range.to, bucket, totals, buckets })
}
