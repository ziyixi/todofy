/**
 * The replay evaluation in workerd with a real SQLite MailsortState, the fake Gmail and the fake Workers AI
 * (../../../docs/design.md §5.1): the owner's resolved review items decided again by today's pipeline, after the drain,
 * without writing anything (no Gmail write even in live mode, no decision, verdict, example, review item, ledger row or
 * flow count), compared with the owner's answers, as of each mail's original decision (never with the example or the
 * trusted domain the owner's answer to it taught, while a seeded one counts at any time); a mail Gmail no longer gives
 * is skipped; a model outage backs a mail off without using up its tries; the answer holds counts, label pairs and each
 * evaluated mail's decision numbers only (no content); a repeated request ID answers the first start, a new one starts
 * again, also once the last one finished; the guard's shed and the neuron share make it wait. Every request Google got
 * is checked against the independent table after each test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { ReplayEvaluation_Outcome, ReplayEvaluation_State } from '@ziyixi/proto/mailsort/ui/v2/replay_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { DAY, HOUR, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
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

  /** An example of the newsletter label from an answer a day before these mails came: evidence the replay may use. */
  const OLDER = 'Older digest · Digest <news.example.com> · last week in posts';

  beforeAll(async () => {
    h = await startHarness();
    await addLabels(h);
    await roomInReview(h, now);
    await h.sql(`INSERT INTO examples (id, label_id, summary, origin, message_id, create_time) VALUES ('older-example', 'newsletter', ?, 'confirmation', 'c10000000000c001', ?)`, OLDER, now - DAY);
    await h.step(now);
    // A weak model: every mail uncertain, and five of them shown. The owner answers them all, a minute later.
    h.up.ai.confidence = 0.5;
    for (const mail of Object.values(mails)) deliver(h, mail, now);
    now += 5 * MINUTE;
    await h.step(now);
    h.up.ai.confidence = 0.92;
    now += MINUTE;
    await h.clock(now);
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
    // The bank mail's domain was taught by the owner's answer to it, after it came: as of then its sender was not
    // trusted yet, so it is uncertain (and the day's quota would have shown it), not a confident bank label.
    expect(summary).toMatchObject({
      state: ReplayEvaluation_State.SUCCEEDED,
      totalCount: 5,
      evaluatedCount: 4,
      skippedCount: 1,
      autoCount: 2,
      autoMatchCount: 1,
      noLabelCount: 1,
      noLabelMatchCount: 1,
      unsureCount: 1,
      shownCount: 1,
    });
    expect(summary.completeTime).toBeDefined();
    expect(summary.mismatches.map((m) => [m.decidedLabel, m.ownerLabel, m.mailCount])).toEqual([['labels/receipt', 'labels/travel', 1]]);
    // Each evaluated mail's numbers, in the order of their decisions (all at one time: by message ID); the skipped
    // travel mail has none.
    expect(summary.reasonCounts).toEqual({ untrusted_sender: 1 });
    expect(summary.cases.map((c) => [c.ownerLabel, c.outcome, c.topLabel, c.reason])).toEqual([
      ['labels/newsletter', ReplayEvaluation_Outcome.LABEL, 'labels/newsletter', ''],
      ['labels/travel', ReplayEvaluation_Outcome.LABEL, 'labels/receipt', ''],
      ['', ReplayEvaluation_Outcome.NONE, '', ''],
      ['labels/bank', ReplayEvaluation_Outcome.UNSURE, 'labels/bank', 'untrusted_sender'],
    ]);
    // The fake model gives its top 0.92 and the rest an equal share. View 2 ran over view 1's three most likely labels
    // and none, to which view 1 gave 0.98: on view 1's scale its 0.92 is worth 0.9016, and the mean is 0.9108.
    const [newsletter, , none, bank] = summary.cases;
    expect(bank).toMatchObject({ authenticated: true, trustImplying: true, suspiciousProbability: 0.05, needsActionProbability: 0.05 });
    expect(bank?.topProbability).toBeCloseTo(0.92, 10);
    expect(bank?.runnerUpProbability).toBeCloseTo(0.02, 10);
    expect(bank?.secondViewProbability).toBeCloseTo(0.92, 10);
    expect(bank?.combinedProbability).toBeCloseTo((0.92 + 0.92 * 0.98) / 2, 10);
    expect(newsletter).toMatchObject({ authenticated: true, trustImplying: false });
    // A none top: no view 2, and its combined value is p(none).
    expect(none?.secondViewProbability).toBeUndefined();
    expect(none?.combinedProbability).toBeCloseTo(0.92, 10);
    // Nothing written: no Gmail write, and every row of the pipeline as it was (only the day's usage grew).
    expect(modifies(h).length).toBe(writes);
    expect(await snapshot(h)).toEqual(before);
    expect(await h.sql(`SELECT reason FROM replay WHERE message_id = ?`, MAILS.bankEn.id)).toEqual([{ reason: 'untrusted_sender' }]);
    // The full Clef, both views where they run.
    const calls = clefCalls(h, from);
    expect(calls.every((call) => call.model === '@cf/cloudflare/clef')).toBe(true);
    expect(calls.length).toBe(7);
    // The neighbours are the examples of before each mail: the older one, never the one the owner's answer to the
    // same mail made (its own summary, labelled with the answer) nor any other made after it.
    for (const call of calls) {
      const neighbours = (call.state['similar_examples'] ?? []) as { text: string }[];
      expect(neighbours.map((n) => n.text)).toEqual([OLDER]);
    }
    // No mail content in the answer, as the browser reads it: each case has only its numbers, the owner's answer and
    // the outcome (no message ID either).
    const text = await (await h.fetch('/api/v2/replayEvaluation')).text();
    expect(text).toContain('"total_count":5');
    expect(text).toContain('"reason_counts":{"untrusted_sender":1}');
    for (const secret of ['digest', 'Receipt', 'bank.example.com', 'Lunch', 'example', ...Object.values(mails).map((mail) => mail.id)]) expect(text).not.toContain(secret);
    const fields = ['owner_label', 'outcome', 'top_label', 'top_probability', 'runner_up_probability', 'second_view_probability', 'combined_probability',
      'suspicious_probability', 'needs_action_probability', 'authenticated', 'trust_implying', 'reason'];
    const cases = (JSON.parse(text) as { cases: Record<string, unknown>[] }).cases;
    expect(cases).toHaveLength(4);
    for (const c of cases) expect(fields).toEqual(expect.arrayContaining(Object.keys(c)));
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

  it('a model outage backs a mail off without using up its tries; the rest goes on, and so does the mail later', async () => {
    await h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() });
    h.up.ai.broken = true;
    now += 5 * MINUTE;
    const from = h.up.ai.calls.length;
    await h.step(now);
    // One call failed: the mail waits 5 minutes (as a pending mail in the drain would), and the pass calls the model
    // no more.
    expect(h.up.ai.calls.length - from).toBe(1);
    expect(await h.sql(`SELECT attempts, not_before, state FROM replay WHERE attempts > 0`)).toEqual([{ attempts: 1, not_before: now + 5 * MINUTE, state: 'pending' }]);
    h.up.ai.broken = false;
    now += MINUTE;
    await h.step(now);
    expect(await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).toMatchObject({ state: ReplayEvaluation_State.RUNNING, evaluatedCount: 3, skippedCount: 1 });
    now += 5 * MINUTE;
    await h.step(now);
    // Decided after the outage like the others: nothing counted as uncertain for it.
    expect(await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).toMatchObject({ state: ReplayEvaluation_State.SUCCEEDED, evaluatedCount: 4, autoCount: 2, unsureCount: 1 });
    expect(await h.sql(`SELECT count(*) AS n FROM replay WHERE reason = 'model_unavailable'`)).toEqual([{ n: 0 }]);
  });

  it('starts afresh once the last one finished; a seeded trusted domain counts at any time, a learned one from its time', async () => {
    // The last run finished with the bank mail uncertain: its domain was learned from the owner's later answer.
    expect(await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).toMatchObject({ state: ReplayEvaluation_State.SUCCEEDED, reasonCounts: { untrusted_sender: 1 } });
    // The same domain seeded instead (the owner's former rule), recorded after the mail came, as the migration of
    // 2026-10-10 recorded the rules.
    await h.sql(`UPDATE trusted_domains SET origin = 'seed' WHERE label_id = 'bank' AND domain = 'bank.example.com'`);
    expect(await h.sql(`SELECT t.create_time > r.as_of AS later FROM trusted_domains t, replay r WHERE t.label_id = 'bank' AND r.message_id = ?`, MAILS.bankEn.id)).toEqual([{ later: 1 }]);
    const started = await h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() });
    expect(started).toMatchObject({ state: ReplayEvaluation_State.RUNNING, totalCount: 5, evaluatedCount: 0, cases: [], reasonCounts: {} });
    now += 5 * MINUTE;
    await h.step(now);
    const summary = await h.api.getReplayEvaluation({ name: 'replayEvaluation' });
    expect(summary).toMatchObject({ state: ReplayEvaluation_State.SUCCEEDED, evaluatedCount: 4, autoCount: 3, autoMatchCount: 2, unsureCount: 0, reasonCounts: {} });
    expect(summary.cases.find((c) => c.ownerLabel === 'labels/bank')).toMatchObject({ outcome: ReplayEvaluation_Outcome.LABEL, topLabel: 'labels/bank', trustImplying: true, authenticated: true, reason: '' });
    expect(await h.sql(`SELECT count(DISTINCT job_id) AS n FROM replay`)).toEqual([{ n: 1 }]);
    await h.sql(`UPDATE trusted_domains SET origin = 'owner' WHERE label_id = 'bank' AND domain = 'bank.example.com'`);
  });
});
