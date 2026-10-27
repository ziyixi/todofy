import type { UsageBucket } from '@ziyixi/proto/modelrouter/inference/v1/console_wire'
import type { TimeRange } from './api'

export interface Estimate {
  requests: number
  known: number
  missing: number
  value?: number
}
export function estimate(buckets: readonly UsageBucket[], kind: string): Estimate {
  const selected = buckets.filter((bucket) => bucket.billing_kind === kind)
  const requests = selected.reduce((sum, bucket) => sum + (bucket.request_count ?? 0), 0)
  const priced = selected.filter((bucket) => (bucket.cost_available_count ?? 0) > 0)
  const known = priced.reduce((sum, bucket) => sum + (bucket.cost_available_count ?? 0), 0)
  return {
    requests,
    known,
    missing: requests - known,
    ...(known
      ? { value: priced.reduce((sum, bucket) => sum + (bucket.estimated_cost_microusd ?? 0), 0) }
      : {}),
  }
}
export function totals(buckets: readonly UsageBucket[]) {
  const sum = (
    field:
      | 'request_count'
      | 'success_count'
      | 'failure_count'
      | 'usage_available_count'
      | 'input_tokens'
      | 'output_tokens',
  ) => buckets.reduce((value, bucket) => value + (bucket[field] ?? 0), 0)
  return {
    requests: sum('request_count'),
    succeeded: sum('success_count'),
    failed: sum('failure_count'),
    known: sum('usage_available_count'),
    tokens: sum('input_tokens') + sum('output_tokens'),
    api: estimate(buckets, 'api'),
    subscription: estimate(buckets, 'subscription'),
  }
}

export interface UsagePoint {
  time: string
  requests: number
  failures: number
  input: number | null
  output: number | null
  apiCost: number | null
  subscriptionCost: number | null
  apiUnpriced: number
  subscriptionUnpriced: number
}

/** The API selects UTC hours for today and UTC days for longer ranges. Empty bins have no calls. */
export function usagePoints(buckets: readonly UsageBucket[], days: TimeRange, until: string): UsagePoint[] {
  const hour = 3_600_000
  const day = 24 * hour
  const end = Date.parse(until)
  const start = Math.floor(end / day) * day - (days - 1) * day
  const step = days === 1 ? hour : day
  const groups = new Map<number, UsageBucket[]>()
  for (const bucket of buckets) {
    const stamp = Date.parse(bucket.time ?? '')
    groups.set(stamp, [...(groups.get(stamp) ?? []), bucket])
  }
  const points: UsagePoint[] = []
  for (let stamp = start; stamp <= end; stamp += step) {
    const rows = groups.get(stamp) ?? []
    const total = totals(rows)
    const complete = total.known === total.requests
    const api = estimate(rows, 'api')
    const subscription = estimate(rows, 'subscription')
    const costAt = (value: Estimate) => (value.requests === 0 ? 0 : (value.value ?? null))
    points.push({
      time: new Date(stamp).toISOString(),
      requests: total.requests,
      failures: total.failed,
      input: complete ? rows.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0) : null,
      output: complete ? rows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0) : null,
      apiCost: costAt(api),
      subscriptionCost: costAt(subscription),
      apiUnpriced: api.missing,
      subscriptionUnpriced: subscription.missing,
    })
  }
  return points
}
