import { describe, expect, it } from 'vitest'
import { create } from '@ziyixi/proto/protobuf'
import { AttemptCountsSchema, AttemptResult } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { ATTEMPT_RESULTS, countAll, countOf, resultLabel, resultName, resultOf, resultRestriction } from './attemptResults'

describe('the dashboard results come from the generated AttemptResult', () => {
  it('lists every result but UNSPECIFIED, in display order, each with its words', () => {
    const generated = Object.entries(AttemptResult).filter(([name]) => name !== 'UNSPECIFIED').map(([, value]) => value)
    expect([...ATTEMPT_RESULTS].sort()).toEqual(generated.sort())
    expect(ATTEMPT_RESULTS.map(resultName)).toEqual(['succeeded', 'retried', 'failed', 'unknown'])
    expect(ATTEMPT_RESULTS.map(resultLabel)).toEqual(['成功', '进入重试', '失败', '结果不明'])
    expect(resultLabel(AttemptResult.UNSPECIFIED)).toBe('')
  })

  it('reads a URL name back, and nothing else', () => {
    for (const result of ATTEMPT_RESULTS) expect(resultOf(resultName(result))).toBe(result)
    for (const name of ['', 'unspecified', 'RETRIED', 'Retried', 'delivered', 'rejected', 'constructor', '__proto__']) expect(resultOf(name)).toBeNull()
  })

  it('writes the restriction ListDeliveries takes and counts by result', () => {
    expect(resultRestriction(AttemptResult.RETRIED)).toBe('attempt_result = RETRIED')
    const counts = create(AttemptCountsSchema, { succeededCount: 3, retriedCount: 2, failedCount: 1, unknownCount: 4 })
    expect(ATTEMPT_RESULTS.map(result => countOf(counts, result))).toEqual([3, 2, 1, 4])
    expect([countAll(counts), countAll(undefined), countOf(undefined, AttemptResult.FAILED), countOf(counts, AttemptResult.UNSPECIFIED)]).toEqual([10, 0, 0, 0])
  })
})
