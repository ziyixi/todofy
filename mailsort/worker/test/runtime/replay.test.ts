/** Historical replay remains readable; Claude never starts or resumes the retired Clef evaluation. */
import { afterEach, describe, expect, it } from 'vitest';
import { ReplayEvaluation_Outcome, ReplayEvaluation_State, ReplayEvaluationSchema } from '@ziyixi/proto/mailsort/ui/v2/replay_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { DAY, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, modifies } from './helpers.ts';

let h: Harness;
const NOW = T0 + DAY;
async function setup(): Promise<void> {
  h = await startHarness();
  await h.step(T0);
  await h.clock(NOW);
}

afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });

describe('historical priority replay', () => {
  it('refuses a new replay with a clear retired-feature error and creates no job', async () => {
    await setup();
    const error = await rejection(h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() }));
    expect(reasonOf(error)).toBe('MODEL_FEATURE_RETIRED');
    expect((error as Error).message).toContain('historical results remain readable');
    expect(await h.sql(`SELECT * FROM replay`)).toEqual([]);
    expect(h.up.ai.calls).toEqual([]);
    expect(h.up.claude.calls).toEqual([]);
    expect(modifies(h)).toEqual([]);
    expect(reasonOf(await rejection(h.api.getReplayEvaluation({ name: 'replayEvaluation' })))).toBe('NOT_FOUND');
  });

  it('reads a completed historical result without replacing its rows or calling either model', async () => {
    await setup();
    await h.sql(`INSERT INTO replay (job_id, message_id, state, create_time, done_time) VALUES ('historical-job', '', 'succeeded', ?, ?)`, T0, T0 + MINUTE);
    await h.sql(`INSERT INTO replay (job_id, message_id, state, owner_label, as_of, outcome, label, create_time, done_time, top_option, top_p, runner_up_p, view2_p, combined, authenticated, trust)
      VALUES ('historical-job', 'abc0000000000011', 'evaluated', 'p3', ?, 'label', 'p3', ?, ?, 'p3', 0.8, 0.15, 0.9, 0.85, 1, 0)`, T0, T0, T0 + MINUTE);
    await h.sql(`INSERT INTO replay (job_id, message_id, state, owner_label, as_of, outcome, reason, create_time, done_time, authenticated, trust)
      VALUES ('historical-job', 'abc0000000000012', 'evaluated', 'p2', ?, 'unsure', 'model_unavailable', ?, ?, 1, 0)`, T0 + 1, T0, T0 + MINUTE);
    const rows = await h.sql(`SELECT * FROM replay ORDER BY message_id`);
    const summary = await h.api.getReplayEvaluation({ name: 'replayEvaluation' });
    expect(summary).toMatchObject({ state: ReplayEvaluation_State.SUCCEEDED, totalCount: 2, evaluatedCount: 2, autoCount: 1, autoMatchCount: 1, unsureCount: 1, reasonCounts: { model_unavailable: 1 } });
    expect(summary.cases).toMatchObject([
      { ownerLabel: 'labels/p3', outcome: ReplayEvaluation_Outcome.LABEL, topLabel: 'labels/p3', topProbability: 0.8, secondViewProbability: 0.9, combinedProbability: 0.85 },
      { ownerLabel: 'labels/p2', outcome: ReplayEvaluation_Outcome.UNSURE, reason: 'model_unavailable' },
    ]);
    expect(JSON.stringify(toWire(ReplayEvaluationSchema, summary))).not.toContain('abc0000000000011');
    expect(reasonOf(await rejection(h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() })))).toBe('MODEL_FEATURE_RETIRED');
    await h.step(NOW + MINUTE);
    expect(await h.sql(`SELECT * FROM replay ORDER BY message_id`)).toEqual(rows);
    expect(await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).toEqual(summary);
    expect(h.up.ai.calls).toEqual([]);
    expect(h.up.claude.calls).toEqual([]);
    expect(modifies(h)).toEqual([]);
  });

  it('leaves an interrupted historical replay readable without resuming its pending mail', async () => {
    await setup();
    await h.sql(`INSERT INTO replay (job_id, message_id, state, create_time) VALUES ('interrupted-job', '', 'running', ?)`, T0);
    await h.sql(`INSERT INTO replay (job_id, message_id, state, owner_label, as_of, create_time) VALUES ('interrupted-job', 'abc0000000000013', 'pending', 'p1', ?, ?)`, T0 + MINUTE, T0);
    const rows = await h.sql(`SELECT * FROM replay ORDER BY message_id`);
    const before = h.up.gmail.calls.length;
    await h.step(NOW + MINUTE);
    expect(h.up.gmail.calls.slice(before).some(call => call.url.includes('/messages/abc0000000000013'))).toBe(false);
    expect(h.up.ai.calls).toEqual([]);
    expect(h.up.claude.calls).toEqual([]);
    expect(await h.sql(`SELECT * FROM replay ORDER BY message_id`)).toEqual(rows);
    expect(await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).toMatchObject({ state: ReplayEvaluation_State.RUNNING, totalCount: 1, evaluatedCount: 0 });
    expect(await h.sql(`SELECT id FROM review`)).toEqual([]);
    expect(modifies(h)).toEqual([]);
  });
});
