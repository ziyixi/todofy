// Bookkeeping recovery through the real isolate runner with a mock inspector channel. These values are
// synthetic sample identifiers and calibrations, not CPU measurements or evidence for any performance budget.
import test from 'node:test'
import assert from 'node:assert/strict'
import { measureInIsolates, TimedOut } from '../../../../tools/workerd-cpu/workerd-cpu.mts'
import { collectCoordinatorCpu } from './coordinator-samples.mjs'

for (const stage of ['session', 'calibration']) {
  test(`coordinator samples stay paired when an inspector timeout discards an isolate during ${stage}`, async () => {
    const started = [], disposed = []
    const samples = [[1000, 2000], [20, 40], [45, 90]]
    const coordinator = collectCoordinatorCpu(async (isolate, numbers) => {
      numbers.push(...samples[isolate.index])
      if (isolate.index === 0 && stage === 'session') throw new TimedOut('synthetic session channel timeout')
      return [{ label: 'synthetic bookkeeping only', first: 1, median: 1, best: 1 }]
    }, 2)
    const start = async index => {
      started.push(index)
      return {
        index,
        meter: {
          async calibrate() {
            if (index === 0 && stage === 'calibration') throw new TimedOut('synthetic calibration channel timeout')
            const speed = index + 1
            return { wall: 4.8 * speed, cpu: 4.8 * speed, speed }
          },
        },
        async dispose() { disposed.push(index) },
      }
    }
    const { runs } = await measureInIsolates(2, start, coordinator.measure)
    assert.deepEqual(started, [0, 1, 2])
    assert.deepEqual(disposed, started)
    assert.equal(runs.length, 2)
    assert.deepEqual(runs.map(run => coordinator.referenceFor(run)), [[10, 20], [15, 30]])
  })
}

test('a completed isolate without its matching coordinator samples still fails', () => {
  const coordinator = collectCoordinatorCpu(async () => [], 2)
  assert.throws(() => coordinator.referenceFor({ measured: [], calibration: { speed: 1 } }),
    /a completed isolate has coordinator samples/)
})

test('a completed isolate with a partial coordinator session still fails', async () => {
  const coordinator = collectCoordinatorCpu(async (_isolate, numbers) => {
    numbers.push(10)
    return []
  }, 2)
  const measured = await coordinator.measure({})
  assert.throws(() => coordinator.referenceFor({ measured, calibration: { speed: 1 } }),
    /a completed isolate has every coordinator sample/)
})
