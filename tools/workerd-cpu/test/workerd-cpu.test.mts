// node --test tools/workerd-cpu/test/*.test.mts (the Changes job). The parts that need no workerd: reading a profile,
// the summaries, the scale, and the calibration workload itself. Lab's and FlowDay's runtime suites (test/runtime/
// cpu.test.ts) run the meter against their Workers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  CALIBRATION_CALL,
  CALIBRATION_CHARS,
  CALIBRATION_SETUP,
  MAX_SAMPLE_US,
  profileCpu,
  scaleFor,
  summarize,
  type Profile,
} from '../workerd-cpu.mts';

function profile(samples: [string, number][]): Profile {
  const names = [...new Set(samples.map(([name]) => name))];
  return {
    nodes: names.map((functionName, index) => ({ id: index + 1, callFrame: { functionName } })),
    samples: samples.map(([name]) => names.indexOf(name) + 1),
    timeDeltas: samples.map(([, micros]) => micros),
  };
}

test('a profile counts every sample but idle ones, each capped at four sampling intervals', () => {
  const { ms, byFunction } = profileCpu(profile([['(idle)', 5000], ['parse', 100], ['parse', 120], ['sort', 9000], ['(program)', 80]]));
  assert.equal(ms, (100 + 120 + MAX_SAMPLE_US + 80) / 1000);
  assert.deepEqual([...byFunction.entries()], [['parse', 220], ['sort', MAX_SAMPLE_US], ['(program)', 80]]);
  assert.equal(profileCpu(profile([])).ms, 0);
});

test('a measurement is the first run, then the median and best of the warm runs', () => {
  assert.deepEqual(summarize('x', [4, 1, 3, 2]), { label: 'x', first: 4, median: 2, best: 1 });
  // An even count takes the upper median, as the calibration does.
  assert.deepEqual(summarize('x', [9, 1, 2, 3, 4]), { label: 'x', first: 9, median: 3, best: 1 });
  // A single run is its own warm numbers.
  assert.deepEqual(summarize('x', [5]), { label: 'x', first: 5, median: 5, best: 5 });
});

test('a faster machine never tightens a bound; a slower one widens it', () => {
  assert.equal(scaleFor(0.8), 1);
  assert.equal(scaleFor(1), 1);
  assert.equal(scaleFor(2.5), 2.5);
});

test('the calibration workload is deterministic and returns CALIBRATION_CHARS', () => {
  // The reference time (CALIBRATION_REFERENCE_MS) was measured for exactly this work: a change to the workload must
  // change this number too, which is the reminder to measure the reference again.
  const context: Record<string, unknown> = {};
  runInNewContext(CALIBRATION_SETUP, context);
  assert.equal(runInNewContext(CALIBRATION_CALL, context), CALIBRATION_CHARS);
  assert.equal(runInNewContext(CALIBRATION_CALL, context), CALIBRATION_CHARS);
});
