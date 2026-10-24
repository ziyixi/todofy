/** Priority replay reads current feedback, consumes existing budgets and writes no Gmail changes. */
import { afterEach, describe, expect, it } from 'vitest';
import { ReplayEvaluation_State } from '@ziyixi/proto/mailsort/ui/v2/replay_pb';
import { DEFAULT_DAILY_NEURON_BUDGET } from '../../src/limits.ts';
import { PRIORITY_LABELS } from '../../src/priority.ts';
import { MAILS } from '../fakes/fixtures.ts';
import { DAY, MINUTE, op, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, clefCalls, deliver, modifies } from './helpers.ts';

let h: Harness;
const NOW = T0 + DAY;
async function setup(): Promise<void> {
  h = await startHarness();
  for (const [i, label] of PRIORITY_LABELS.entries()) {
    const gmail = h.up.gmail.createUserLabel(label.displayName, true);
    await h.sql(`INSERT INTO labels (id, seq, display_name, description, enabled, gmail_id, gmail_state, keep_in_inbox, create_time, update_time, etag) VALUES (?, ?, ?, ?, 1, ?, 'linked', ?, ?, ?, 'e')`, label.id, i + 1, label.displayName, label.description, gmail, label.keepInInbox ? 1 : 0, T0, T0);
  }
  await h.sql(`INSERT INTO meta (key, value) VALUES ('priority_started_at', ?)`, String(T0));
  await h.step(T0);
}
async function answered(id: string, label: string, at: number): Promise<void> {
  await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, decider, verdict, verdict_label, verdict_source, verdict_at) VALUES (?, ?, ?, ?, 'suggested', ?, 'clef', 'confirmed', ?, 'gmail', ?)`, id, id, at, at, label, label, NOW - MINUTE);
}
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });

describe('priority replay', () => {
  it('ignores old learning and replays current Gmail corrections without business writes', async () => {
    await setup();
    const current = 'abc0000000000011';
    deliver(h, { ...MAILS.bankEn, id: current }, T0 + MINUTE);
    await answered(current, 'p3', T0 + 2 * MINUTE);
    await answered('abc0000000000012', 'p1', T0 - MINUTE);
    await answered('abc0000000000013', 'bank', T0 + MINUTE);
    await h.clock(NOW);
    h.up.ai.choiceOverride = () => ({ p3: 0.92, none: 0.08 });
    const start = await h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() });
    expect(start).toMatchObject({ state: ReplayEvaluation_State.RUNNING, totalCount: 1 });
    const original = await h.sql(`SELECT * FROM decisions ORDER BY message_id`);
    await h.step(NOW + MINUTE);
    expect(await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).toMatchObject({ state: ReplayEvaluation_State.SUCCEEDED, totalCount: 1, evaluatedCount: 1, autoCount: 1, autoMatchCount: 1, unsureCount: 0 });
    expect(await h.sql(`SELECT * FROM decisions ORDER BY message_id`)).toEqual(original);
    expect(modifies(h)).toEqual([]);
    expect(await h.sql(`SELECT id FROM examples`)).toEqual([]);
    expect(clefCalls(h)).toHaveLength(2);
    expect(clefCalls(h)[0]?.state['current_local_time']).toContain('17:02:00');
    expect(await h.sql(`SELECT suspicious, trust FROM replay WHERE message_id = ?`, current)).toEqual([{ suspicious: null, trust: 0 }]);
  });

  it('keeps replay behind the same daily budget', async () => {
    await setup();
    const id = 'abc0000000000014';
    deliver(h, { ...MAILS.bankEn, id }, T0 + MINUTE);
    await answered(id, 'p2', T0 + 2 * MINUTE);
    await h.clock(NOW);
    await h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() });
    const day = new Date(NOW).toISOString().slice(0, 10);
    await h.sql(`INSERT INTO usage (day, neurons) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET neurons = excluded.neurons`, day, DEFAULT_DAILY_NEURON_BUDGET);
    await h.step(NOW + MINUTE);
    expect(h.up.ai.calls).toEqual([]);
    expect(await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).toMatchObject({ state: ReplayEvaluation_State.RUNNING, evaluatedCount: 0 });
    expect(modifies(h)).toEqual([]);
  });

  it('skips an old active replay row without fetching historical mail', async () => {
    await setup();
    await h.sql(`INSERT INTO replay (job_id, message_id, state, create_time) VALUES ('old-job', '', 'running', ?)`, T0 - MINUTE);
    await h.sql(`INSERT INTO replay (job_id, message_id, state, owner_label, as_of, create_time) VALUES ('old-job', 'abc0000000000015', 'pending', 'p1', ?, ?)`, T0 - MINUTE, T0 - MINUTE);
    const before = h.up.gmail.calls.length;
    await h.step(NOW);
    expect(h.up.gmail.calls.slice(before).some((call) => call.url.includes('/messages/abc0000000000015'))).toBe(false);
    expect(h.up.ai.calls).toEqual([]);
    expect(await h.sql(`SELECT state FROM replay WHERE message_id = 'abc0000000000015'`)).toEqual([{ state: 'skipped' }]);
  });
  it('keeps exhausted invalid-answer retries out of mandatory review in replay too', async () => {
    await setup();
    const id = 'abc0000000000016';
    deliver(h, { ...MAILS.bankEn, id }, T0 + MINUTE);
    await answered(id, 'p2', T0 + 2 * MINUTE);
    await h.clock(NOW);
    await h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() });
    h.up.ai.choiceOverride = () => ({ p2: 1, none: 1 });
    await h.step(NOW + MINUTE);
    expect(await h.sql(`SELECT outcome, reason, shown FROM replay WHERE message_id = ?`, id)).toEqual([{ outcome: 'unsure', reason: 'model_unavailable', shown: 0 }]);
    expect(modifies(h)).toEqual([]);
    expect(await h.sql(`SELECT id FROM review`)).toEqual([]);
  });

});
