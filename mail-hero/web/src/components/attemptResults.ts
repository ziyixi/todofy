// The delivery dashboard's results (mailhero.ui.v2 AttemptResult, delivery.proto): the counts of
// SummarizeDeliveryAttempts and the drill-down filter of ListDeliveries both use them. The values, their names and
// their meaning come from the generated enum; this file adds only the owner's words and the count field of each.
import { AttemptResult, type AttemptCounts } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { enumName } from '../api/client'

/** The owner's word for each result, in display order (exhaustive: a new result fails the typecheck). */
const LABELS: Readonly<Record<Exclude<keyof typeof AttemptResult, 'UNSPECIFIED'>, string>> = {
  SUCCEEDED: '成功', RETRIED: '进入重试', FAILED: '失败', UNKNOWN: '结果不明',
}

/** Every result, in display order. */
export const ATTEMPT_RESULTS: readonly AttemptResult[] = (Object.keys(LABELS) as (keyof typeof LABELS)[]).map(name => AttemptResult[name])

/** The owner's word for `result` ('' for one this build does not know). */
export function resultLabel(result: AttemptResult): string {
  const name = enumName(AttemptResult, result).toUpperCase()
  return Object.hasOwn(LABELS, name) ? LABELS[name as keyof typeof LABELS] : ''
}

/** The wire name of `result` (`retried`): its CSS class and the drill-down URL's `attempt_result`. */
export function resultName(result: AttemptResult): string {
  return enumName(AttemptResult, result)
}

/** The result a wire name stands for (`retried`), or null for none, UNSPECIFIED or one this build does not know. */
export function resultOf(name: string): AttemptResult | null {
  const key = name.toUpperCase()
  return name === key.toLowerCase() && Object.hasOwn(LABELS, key) ? AttemptResult[key as keyof typeof LABELS] : null
}

/** ListDeliveries' restriction for `result`: `attempt_result = RETRIED`. */
export function resultRestriction(result: AttemptResult): string {
  return `attempt_result = ${resultName(result).toUpperCase()}`
}

/** The count of `result` in `counts` (0 when unset). */
export function countOf(counts: AttemptCounts | undefined, result: AttemptResult): number {
  if (counts === undefined) return 0
  switch (result) {
    case AttemptResult.SUCCEEDED: return counts.succeededCount
    case AttemptResult.RETRIED: return counts.retriedCount
    case AttemptResult.FAILED: return counts.failedCount
    case AttemptResult.UNKNOWN: return counts.unknownCount
    default: return 0
  }
}

/** Every attempt `counts` holds. */
export function countAll(counts: AttemptCounts | undefined): number {
  return ATTEMPT_RESULTS.reduce<number>((sum, result) => sum + countOf(counts, result), 0)
}
