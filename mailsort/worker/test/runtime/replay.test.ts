/** Historical replay remains readable; it never resumes the retired model. */
import { afterEach, expect, it } from 'vitest';
import { op, reasonOf, rejection, startHarness, T0, DAY, type Harness } from './harness.ts';
import { checkGoogleCalls } from './helpers.ts';
let h: Harness;
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });
it('refuses a new replay and preserves its existing historical rows without model calls', async () => {
  h = await startHarness();
  await h.sql(`INSERT INTO replay (job_id, message_id, state, create_time) VALUES ('old-job', '', 'running', ?)`, T0);
  await h.sql(`INSERT INTO replay (job_id, message_id, state, owner_label, as_of, create_time) VALUES ('old-job', 'abc0000000000015', 'pending', 'p1', ?, ?)`, T0, T0);
  const before = await h.sql(`SELECT * FROM replay`);
  expect(reasonOf(await rejection(h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() })))).toBe('BAD_REQUEST');
  await h.step(T0 + DAY);
  expect(await h.sql(`SELECT * FROM replay`)).toEqual(before);
  expect(h.up.ai.calls).toEqual([]);
});
