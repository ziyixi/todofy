/**
 * The replay evaluation in workerd with a real SQLite MailsortState, the fake Gmail and the fake Workers AI
 * (../../../docs/design.md §5.1): the owner's resolved review items decided again by today's pipeline, after the drain,
 * without writing anything (no Gmail write even in live mode, no decision, verdict, example, review item, ledger row or
 * flow count), compared with the owner's answers; a mail Gmail no longer gives is skipped; the summary holds counts and
 * label pairs only; a repeated request ID answers the first start, a new one starts again; the guard's shed and the
 * neuron share make it wait. Every request Google got is checked against the independent table after each test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { ReplayEvaluation_State } from '@ziyixi/proto/mailsort/ui/v2/replay_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { HOUR, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { addLabels, checkGoogleCalls, clefCalls, deliver, modifies, roomInReview, setMode } from './helpers.ts';

/** Every row the replay must leave alone, as it is now. */
async function snapshot(h: Harness): Promise<unknown> {
  const tables = ['decisions', 'review', 'examples', 'ledger', 'flow', 'trusted_domains', 'pending', 'labels'];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await h.sql(`SELECT * FROM ${table} ORDER BY 1, 2`)] as const)));
}

describe('the replay evaluation', () => {
  let h: Harness;
  let now = T0;
  const mails: Record<string, SyntheticMail> = {
    unsure: MAILS.unsure,
    newsletter: MAILS.newsletterEn,
    receipt: MAILS.receiptEn,
    travel: MAILS.travelZh,
    bank: MAILS.bankEn,
  };
  /** The owner's answers: a label, or '' for 都不是 (the receipt answered as travel, the travel mail as none). */
  const answers: Record<string, string> = { unsure: '', newsletter: 'labels/newsletter', receipt: 'labels/travel', travel: '', bank: 'labels/bank' };

  beforeAll(async () => {
    h = await startHarness();
    await addLabels(h);
    await roomInReview(h, now);
    await h.step(now);
    // A weak model: every mail uncertain, and five of them shown. The owner answers them all.
    h.up.ai.confidence = 0.5;
    for (const mail of Object.values(mails)) deliver(h, mail, now);
    now += 5 * MINUTE;
    await h.step(now);
    h.up.ai.confidence = 0.92;
    for (const [key, mail] of Object.entries(mails)) {
      const [item] = await h.sql<{ id: string }>(`SELECT id FROM review WHERE message_id = ? AND state = 'pending'`, mail.id);
      expect(item, key).toBeDefined();
      await h.api.resolveReviewItem({ name: `reviewItems/${item?.id ?? ''}`, label: answers[key] ?? '', requestId: op() });
    }
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    checkGoogleCalls(h);
  });

  it('answers NOT_FOUND before the first start', async () => {
    expect(reasonOf(await rejection(h.api.getReplayEvaluation({ name: 'replayEvaluation' })))).toBe('NOT_FOUND');
  });

  it('decides every resolved mail again without writing anything, even in live mode, and compares with the owner', async () => {
    // Gmail no longer has the travel mail: it is skipped.
    h.up.gmail.messages.delete(MAILS.travelZh.id);
    await setMode(h, Mode.LIVE);
    // A pass first embeds the examples the answers made (the live pipeline's work, not the replay's).
    now += 5 * MINUTE;
    await h.step(now);
    const started = await h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() });
    expect(started).toMatchObject({ name: 'replayEvaluation', state: ReplayEvaluation_State.RUNNING, totalCount: 5, evaluatedCount: 0 });
    const before = await snapshot(h);
    const writes = modifies(h).length;
    const from = h.up.ai.calls.length;
    now += 5 * MINUTE;
    const pass = await h.step(now);
    expect(pass.code).toBe('ok');
    const summary = await h.api.getReplayEvaluation({ name: 'replayEvaluation' });
    expect(summary).toMatchObject({
      state: ReplayEvaluation_State.SUCCEEDED,
      totalCount: 5,
      evaluatedCount: 4,
      skippedCount: 1,
      autoCount: 3,
      autoMatchCount: 2,
      noLabelCount: 1,
      noLabelMatchCount: 1,
      unsureCount: 0,
      shownCount: 0,
    });
    expect(summary.completeTime).toBeDefined();
    expect(summary.mismatches.map((m) => [m.decidedLabel, m.ownerLabel, m.mailCount])).toEqual([['labels/receipt', 'labels/travel', 1]]);
    // Nothing written: no Gmail write, and every row of the pipeline as it was (only the day's usage grew).
    expect(modifies(h).length).toBe(writes);
    expect(await snapshot(h)).toEqual(before);
    // The full Clef, both views where they run; the bank mail's sender is trusted since the owner's answer.
    const calls = clefCalls(h, from);
    expect(calls.every((call) => call.model === '@cf/cloudflare/clef')).toBe(true);
    expect(calls.length).toBe(7);
    // No mail content in the summary, as the browser reads it.
    const text = await (await h.fetch('/api/v2/replayEvaluation')).text();
    expect(text).toContain('"total_count":5');
    for (const secret of ['digest', 'Receipt', 'bank.example.com', 'Lunch']) expect(text).not.toContain(secret);
  });

  it('a repeated request ID answers the first start; a new one starts again, replacing it', async () => {
    const requestId = op();
    const first = await h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId });
    expect(first).toMatchObject({ state: ReplayEvaluation_State.RUNNING, totalCount: 5, evaluatedCount: 0 });
    now += 5 * MINUTE;
    await h.step(now);
    expect((await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).evaluatedCount).toBe(4);
    expect(await h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId })).toEqual(first);
    expect((await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).evaluatedCount).toBe(4);
    expect(await h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() })).toMatchObject({ state: ReplayEvaluation_State.RUNNING, evaluatedCount: 0 });
    expect(await h.sql(`SELECT count(DISTINCT job_id) AS n FROM replay`)).toEqual([{ n: 1 }]);
  });

  it('waits while the guard sheds, and while the day\'s neurons reach half the budget', async () => {
    const until = new Date(now + 2 * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await h.opsSetGuard({ level: 'shed', reason: 'usage_80', until });
    now += 5 * MINUTE;
    await h.step(now);
    expect((await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).evaluatedCount).toBe(0);
    await h.opsSetGuard({ level: 'normal', reason: 'usage_ok', until: null });
    // 500 neurons a day: today's use is past half of it already.
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyNeuronBudget: 500 }), updateMask: { paths: ['daily_neuron_budget'] }, requestId: op() });
    now += 5 * MINUTE;
    await h.step(now);
    expect((await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).state).toBe(ReplayEvaluation_State.RUNNING);
    expect((await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).evaluatedCount).toBe(0);
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyNeuronBudget: 7000 }), updateMask: { paths: ['daily_neuron_budget'] }, requestId: op() });
    now += 5 * MINUTE;
    await h.step(now);
    expect((await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).state).toBe(ReplayEvaluation_State.SUCCEEDED);
  });
});
