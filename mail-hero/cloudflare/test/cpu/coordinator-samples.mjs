import assert from 'node:assert/strict'
import { scaleFor } from '../../../../tools/workerd-cpu/workerd-cpu.mts'

/** Pair coordinator samples with the exact measured array of a completed isolate session. */
export function collectCoordinatorCpu(session, expectedCount) {
  const byMeasured = new WeakMap()
  return {
    async measure(isolate, index) {
      const numbers = []
      const measured = await session(isolate, numbers, index)
      byMeasured.set(measured, numbers)
      return measured
    },
    referenceFor(run) {
      // A session or calibration timeout has no returned run, so its samples cannot shift later runs.
      assert.ok(byMeasured.has(run.measured), 'a completed isolate has coordinator samples')
      const numbers = byMeasured.get(run.measured)
      assert.equal(numbers.length, expectedCount, 'a completed isolate has every coordinator sample')
      return numbers.map(ms => ms / scaleFor(run.calibration.speed))
    },
  }
}
