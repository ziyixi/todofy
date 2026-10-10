/**
 * The pipeline in workerd with a real SQLite MailsortState, the fake Gmail and the fake Workers AI
 * (../../../docs/design.md §4-§7): no backfill, the model's two views, shadow decisions only recorded, live label +
 * archive with UNREAD untouched, confident none left in the inbox, needs_action keeping a labelled mail in the inbox,
 * undo, a Gmail correction becoming an example, a trust label waiting for a trusted domain that a review choice
 * teaches, the review queue's daily quota, skips, the history resync, the auth-failure stop, the neuron budget's switch
 * to Clef-flash and the quota deferral. After every test, every request Google got is checked against the independent
 * table (../fakes/table.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { ReviewItem_State } from '@ziyixi/proto/mailsort/ui/v2/review_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { MAILS } from '../fakes/fixtures.ts';
import { DAY, HOUR, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { addLabels, checkGoogleCalls, clefCalls, decision, deliver, gmailLabels, modifies, setMode } from './helpers.ts';

describe('the pipeline, shadow then live', () => {
  let h: Harness;
  let now = T0;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    checkGoogleCalls(h);
  });

  it('starts from the install-time cursor: mail from before is never sorted', async () => {
    await addLabels(h);
    deliver(h, MAILS.receiptEn, now - HOUR);
    const first = await h.step(now);
    expect(first.code).toBe('ok');
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'history_cursor'`)).toEqual([{ value: String(h.up.gmail.historyId) }]);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.receiptEn.id)).toBeUndefined();
    expect(h.up.gmail.calls.some((call) => call.url.includes('/messages/'))).toBe(false);
  });

  it('shadow: two views agree, the decision is only recorded; nothing is written and nothing waits for review', async () => {
    const from = h.up.ai.calls.length;
    deliver(h, MAILS.newsletterEn, now);
    now += 5 * MINUTE;
    const pass = await h.step(now);
    expect(pass.decided).toBe(1);
    expect(await decision(h, MAILS.newsletterEn.id)).toMatchObject({ outcome: 'suggested', label_id: 'newsletter', decider: 'clef', shown: 0, dmarc: 1 });
    // View 1 over every described label plus none; view 2 over view 1's three most likely labels, reversed, plus none.
    const [view1, view2, ...rest] = clefCalls(h, from);
    expect(rest).toEqual([]);
    expect(view1?.options).toHaveLength(5);
    expect(view2?.options).toHaveLength(4);
    expect(view2?.options.at(-1)).toBe('none');
    expect(view2?.options.at(-2)).toBe(view1?.options[0]);
    expect(view2?.state).toEqual(view1?.state);
    expect(view1?.state['sender_authenticated']).toBe('yes');
    const row = await decision(h, MAILS.newsletterEn.id);
    expect(Object.keys(JSON.parse(String(row?.['probabilities2'])) as object)).toHaveLength(4);
    expect(row?.['sender_hash']).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toContain('digest@news.example.com');
    expect((await h.api.listReviewItems({})).reviewItems).toEqual([]);
    expect(modifies(h)).toEqual([]);
    expect(gmailLabels(h, MAILS.newsletterEn.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    // The model saw masked text and a code for the address, never the address.
    const state = JSON.stringify(view1?.state);
    expect(state).not.toContain('owner@example.com');
    expect(state).not.toContain('digest@news.example.com');
    expect(state).toContain('[link news.example.com]');
    expect(state).not.toContain('123456789');
  });

  it('live: a confident label is added and INBOX removed, UNREAD untouched; confident none stays in the inbox, not shown', async () => {
    await setMode(h, Mode.LIVE);
    deliver(h, MAILS.newsletterZh, now);
    deliver(h, MAILS.unsure, now);
    now += 5 * MINUTE;
    await h.step(now);
    const labelId = h.up.gmail.labelIdByName('订阅');
    expect(labelId).toMatch(/^Label_/);
    expect(gmailLabels(h, MAILS.newsletterZh.id)).toEqual(['CATEGORY_UPDATES', labelId, 'UNREAD'].sort());
    expect(await decision(h, MAILS.newsletterZh.id)).toMatchObject({ outcome: 'applied', label_id: 'newsletter' });
    expect(gmailLabels(h, MAILS.unsure.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    expect(await decision(h, MAILS.unsure.id)).toMatchObject({ outcome: 'none', label_id: null, unsure_reason: '', shown: 0 });
    const [entry] = (await h.api.listLedgerEntries({})).ledgerEntries;
    expect(entry).toMatchObject({ messageId: MAILS.newsletterZh.id, label: 'labels/newsletter', archived: true, origin: 'auto' });
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status).toMatchObject({ appliedTodayCount: 1, writeScope: true, decisionModel: 'clef', reviewCount: 0 });
    expect(await h.sql(`SELECT outcome, n FROM flow WHERE outcome = 'no_label'`)).toEqual([{ outcome: 'no_label', n: 1 }]);
  });

  it('a mail that asks the owner to act soon keeps its label in the inbox', async () => {
    deliver(h, { ...MAILS.receiptZh, id: 'a1000000000000b1', subject: '订单已到快递柜', text: '订单包裹已到快递柜，凭取件码 1234 取件。' }, now);
    now += 5 * MINUTE;
    await h.step(now);
    const receipt = h.up.gmail.labelIdByName('收据');
    expect(gmailLabels(h, 'a1000000000000b1')).toEqual(['CATEGORY_UPDATES', 'INBOX', receipt, 'UNREAD'].sort());
    expect((await decision(h, 'a1000000000000b1'))?.['needs_action']).toBeGreaterThanOrEqual(0.6);
    const entry = (await h.api.listLedgerEntries({})).ledgerEntries.find((item) => item.messageId === 'a1000000000000b1');
    expect(entry).toMatchObject({ archived: false });
    expect(await h.sql(`SELECT n FROM flow WHERE outcome = 'kept_in_inbox' AND label = 'receipt'`)).toEqual([{ n: 1 }]);
  });

  it('undo removes exactly what it added and restores INBOX', async () => {
    const entry = (await h.api.listLedgerEntries({})).ledgerEntries.find((item) => item.messageId === MAILS.newsletterZh.id);
    const undone = await h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() });
    expect(undone.state).toBe(4);
    expect(gmailLabels(h, MAILS.newsletterZh.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    expect(reasonOf(await rejection(h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() })))).toBe('NOT_UNDOABLE');
    // The history records of mailsort's own writes are not feedback.
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.newsletterZh.id)).toMatchObject({ verdict: null });
  });

  it('a Gmail correction becomes an example, and putting the label back takes it away', async () => {
    const receiptGmail = h.up.gmail.labelIdByName('收据') ?? '';
    const newsletterGmail = h.up.gmail.labelIdByName('订阅') ?? '';
    for (const [i, id] of ['c000000000000c01', 'c000000000000c02'].entries()) {
      deliver(h, { ...MAILS.newsletterEn, id, subject: `Weekly digest ${String(i)}` }, now);
      now += 5 * MINUTE;
      await h.step(now);
      expect(await decision(h, id)).toMatchObject({ outcome: 'applied', label_id: 'newsletter' });
      h.up.gmail.ownerModify(id, [receiptGmail], [newsletterGmail]);
      now += 5 * MINUTE;
      await h.step(now);
      expect(await decision(h, id)).toMatchObject({ verdict: 'corrected', verdict_label: 'receipt', verdict_source: 'gmail' });
    }
    const examples = await h.api.listExamples({ label: 'labels/receipt' });
    expect(examples.examples.length).toBe(2);
    expect(examples.examples[0]?.summary).toContain('Weekly digest');
    // Putting the label back withdraws the correction: the example goes.
    h.up.gmail.ownerModify('c000000000000c02', [newsletterGmail], [receiptGmail]);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, 'c000000000000c02')).toMatchObject({ verdict: null });
    expect((await h.api.listExamples({ label: 'labels/receipt' })).examples.length).toBe(1);
    // The examples are embedded by the next passes, and the next decision reads them as context, never as a decider.
    expect((await h.api.listExamples({})).examples.every((example) => example.embedded)).toBe(true);
    const report = await h.api.getLabelReport({ name: 'labelReport' });
    expect(report.labels.find((row) => row.label === 'labels/newsletter')).toMatchObject({ gmailCorrectionCount: 1, reviewCorrectionCount: 0 });
  });

  it('a trust label waits for a trusted domain, which the owner\'s review choice teaches; a forged copy never gets it', async () => {
    deliver(h, MAILS.bankEn, now);
    now += 5 * MINUTE;
    await h.step(now);
    // Authenticated, but bank.example.com is not among the label's trusted domains yet: uncertain, and informative.
    expect(await decision(h, MAILS.bankEn.id)).toMatchObject({ outcome: 'unsure', unsure_reason: 'untrusted_sender', top_label: 'bank', shown: 1 });
    expect(modifies(h).filter((call) => call.url.includes(MAILS.bankEn.id))).toEqual([]);
    const [item] = (await h.api.listReviewItems({})).reviewItems;
    expect(item).toMatchObject({ reason: 'untrusted_sender', subject: 'Your monthly bank statement', state: ReviewItem_State.PENDING });
    expect(item?.candidates[0]?.label).toBe('labels/bank');
    // The owner's answer: a verdict, the label written in live mode (archived), and the domain learned.
    const resolved = await h.api.resolveReviewItem({ name: item?.name ?? '', label: 'labels/bank', requestId: op() });
    expect(resolved).toMatchObject({ state: ReviewItem_State.RESOLVED, resolvedLabel: 'labels/bank' });
    const bank = h.up.gmail.labelIdByName('银行');
    expect(gmailLabels(h, MAILS.bankEn.id)).toEqual(['CATEGORY_UPDATES', bank, 'UNREAD'].sort());
    expect((await h.api.getLabel({ name: 'labels/bank' })).trustedDomains).toEqual(['bank.example.com']);
    expect(reasonOf(await rejection(h.api.skipReviewItem({ name: item?.name ?? '', requestId: op() })))).toBe('ALREADY_RESOLVED');
    // The sender's next statement: confident and written; the model read the owner's verdict in the sender history.
    const from = h.up.ai.calls.length;
    deliver(h, { ...MAILS.bankEn, id: 'b100000000000001', subject: 'Your monthly bank statement for October' }, now);
    deliver(h, { ...MAILS.bankEn, id: 'b100000000000002', subject: 'Your monthly bank statement (copy)', dmarc: 'fail' }, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, 'b100000000000001')).toMatchObject({ outcome: 'applied', label_id: 'bank' });
    expect(String(clefCalls(h, from)[0]?.state['sender_history'])).toMatch(/^bank[a-z0-9-]* ×1$/);
    // The owner's choice, written to Gmail, came back from the history as the same verdict: still the review's.
    expect(await decision(h, MAILS.bankEn.id)).toMatchObject({ verdict_source: 'review', verdict_label: 'bank' });
    // The forged copy (DMARC failed) stays uncertain, and the day's one place in the queue is taken.
    expect(await decision(h, 'b100000000000002')).toMatchObject({ outcome: 'unsure', unsure_reason: 'untrusted_sender', shown: 0 });
    expect(gmailLabels(h, 'b100000000000002')).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    expect((await h.api.listReviewItems({})).reviewItems).toEqual([]);
  });

  it('shows at most the day\'s quota of uncertain mail; the next day has room again', async () => {
    // A weak model: one view's 0.5 for the matched label, both views agreeing, is uncertain and informative.
    h.up.ai.confidence = 0.5;
    deliver(h, { ...MAILS.travelZh, id: 'd100000000000001' }, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, 'd100000000000001')).toMatchObject({ outcome: 'unsure', unsure_reason: 'low_confidence', top_label: 'travel', shown: 0 });
    now = T0 + DAY + MINUTE;
    deliver(h, { ...MAILS.travelZh, id: 'd100000000000002', subject: '航班行程变更' }, now);
    await h.step(now);
    expect(await decision(h, 'd100000000000002')).toMatchObject({ outcome: 'unsure', shown: 1, confidence: 0.5 });
    const items = (await h.api.listReviewItems({})).reviewItems;
    expect(items.map((item) => item.reason)).toEqual(['low_confidence']);
    expect(await h.sql(`SELECT outcome, sum(n) AS n FROM flow WHERE outcome LIKE 'unsure%' GROUP BY outcome ORDER BY outcome`)).toEqual([
      { outcome: 'unsure', n: 2 },
      { outcome: 'unsure_shown', n: 2 },
    ]);
    // 都不是: a verdict without a label, nothing written.
    const writes = modifies(h).length;
    await h.api.resolveReviewItem({ name: items[0]?.name ?? '', label: '', requestId: op() });
    expect(await decision(h, 'd100000000000002')).toMatchObject({ verdict: 'confirmed', verdict_label: null, verdict_source: 'review' });
    expect(modifies(h).length).toBe(writes);
    h.up.ai.confidence = 0.92;
  });

  it('skips sent mail and a conversation already sorted', async () => {
    deliver(h, MAILS.sent, now);
    deliver(h, { ...MAILS.newsletterZh, id: 'e000000000000e01', threadId: `t${MAILS.bankEn.id}` }, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.sent.id)).toBeUndefined();
    expect(await decision(h, 'e000000000000e01')).toMatchObject({ outcome: 'skipped', unsure_reason: 'thread_sorted' });
    const rows = await h.sql(`SELECT count(*) AS n FROM pending`);
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('the history resync after a lost cursor reads the inbox of the last two days', async () => {
    deliver(h, { ...MAILS.travelZh }, now);
    h.up.gmail.oldestHistoryId = h.up.gmail.historyId + 1;
    now += 5 * MINUTE;
    await h.step(now);
    expect(h.up.gmail.calls.some((call) => call.url.includes('/messages?labelIds=INBOX'))).toBe(true);
    expect(await decision(h, MAILS.travelZh.id)).toMatchObject({ label_id: 'travel' });
    h.up.gmail.oldestHistoryId = 0;
  });
});

describe('limits and failures', () => {
  let h: Harness;
  let now = T0;
  beforeAll(async () => {
    h = await startHarness();
    await addLabels(h);
    await h.step(now);
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    checkGoogleCalls(h);
  });

  it('switches to Clef-flash past 70 % of the neuron budget, then defers past the budget', async () => {
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyNeuronBudget: 1000 }), updateMask: { paths: ['daily_neuron_budget'] }, requestId: op() });
    // 20,000 input tokens: Clef 436 neurons a call, Clef-flash 164; each mail asks two views.
    h.up.ai.tokensPerCall = 20_000;
    for (let i = 0; i < 4; i++) deliver(h, { ...MAILS.receiptZh, id: `f00000000000f00${String(i)}`, subject: `您的订单 ${String(i)} 已发货` }, now);
    now += 5 * MINUTE;
    await h.step(now);
    const models = h.up.ai.calls.filter((call) => call.model.includes('clef')).map((call) => call.model);
    expect(models).toEqual(['@cf/cloudflare/clef', '@cf/cloudflare/clef', '@cf/cloudflare/clef-flash', '@cf/cloudflare/clef-flash']);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.decisionModel).toBe('clef-flash');
    expect(status.neuronsToday).toBeGreaterThan(1000);
    expect(await decision(h, 'f00000000000f001')).toMatchObject({ decider: 'clef-flash', outcome: 'suggested' });
    // Past the budget the rest waits for the next UTC day: deferred, not failed.
    expect(status.deferredCount).toBe(2);
    h.up.ai.tokensPerCall = 2000;
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyNeuronBudget: 10_000 }), updateMask: { paths: ['daily_neuron_budget'] }, requestId: op() });
  });

  it('defers (never fails) while Workers AI’s daily quota is used up, and decides the next UTC day', async () => {
    h.up.ai.quota = true;
    deliver(h, { ...MAILS.travelZh, id: 'f10000000000f101' }, now);
    now += 5 * MINUTE;
    const pass = await h.step(now);
    expect(pass.code).toBe('deferred');
    expect(await decision(h, 'f10000000000f101')).toBeUndefined();
    // Waiting: counted as deferred (once, however many passes defer it again).
    await h.step(now + 30_000);
    expect((await h.sql(`SELECT sum(n) AS n FROM flow WHERE stage = 'deferred'`))[0]?.['n']).toBeGreaterThanOrEqual(1);
    expect((await h.sql(`SELECT sum(n) AS n FROM flow WHERE stage = 'deferred'`))[0]?.['n']).toBe((await h.sql(`SELECT count(*) AS n FROM pending WHERE deferred > 0`))[0]?.['n']);
    const status = await h.opsStatus();
    expect(JSON.stringify(status['signals'])).toContain('ai_quota_exhausted');
    h.up.ai.quota = false;
    now = T0 + DAY + MINUTE;
    await h.step(now);
    await h.step(now + 30_000);
    expect(await decision(h, 'f10000000000f101')).toMatchObject({ label_id: 'travel' });
    // Each mail is in the flow once: the deferred ones left 延后 for the stage that decided them.
    expect(await h.sql(`SELECT coalesce(sum(n), 0) AS n FROM flow WHERE stage = 'deferred'`)).toEqual([{ n: 0 }]);
    const [counted] = await h.sql(`SELECT sum(n) AS n FROM flow WHERE outcome != 'corrected'`);
    const [mails] = await h.sql(`SELECT count(*) AS n FROM decisions`);
    expect(counted?.['n']).toBe(mails?.['n']);
  });

  it('a read-only grant never writes, even in live mode', async () => {
    await setMode(h, Mode.LIVE);
    h.up.gmail.grants.set('synthetic-refresh-token', 'https://www.googleapis.com/auth/gmail.readonly');
    deliver(h, { ...MAILS.receiptEn, id: 'f20000000000f201' }, now);
    // The cached access token expires (55 minutes of the test clock): the next refresh brings the read-only scope.
    now += 2 * HOUR;
    const pass = await h.step(now);
    expect(pass.code, JSON.stringify(pass)).toBe('ok');
    expect(await decision(h, 'f20000000000f201')).toMatchObject({ outcome: 'suggested' });
    expect(modifies(h)).toEqual([]);
    h.up.gmail.grants.set('synthetic-refresh-token', 'https://www.googleapis.com/auth/gmail.modify');
  });

  it('stops calling Google after the grant is refused three times, and raises a critical ops signal', async () => {
    h.up.gmail.grants.clear();
    now += 2 * HOUR;
    for (let i = 0; i < 3; i++) {
      now += 5 * MINUTE;
      await h.step(now);
    }
    const calls = h.up.gmail.calls.length;
    now += 5 * MINUTE;
    const pass = await h.step(now);
    expect(pass.code).toBe('stopped');
    expect(h.up.gmail.calls.length).toBe(calls);
    const status = await h.opsStatus();
    expect(status['health']).toBe('degraded');
    expect(status['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'gmail_auth_failed', severity: 'critical' })]));
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).authState).toBe(3);
  });

  it('the daily write limit trips the breaker to shadow', async () => {
    h.up.gmail.grants.set('synthetic-refresh-token', 'https://www.googleapis.com/auth/gmail.modify');
    // A fresh object (the stop holds until the refresh token changes).
    await h.dispose();
    h = await startHarness();
    now = T0;
    await addLabels(h);
    await setMode(h, Mode.LIVE);
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyWriteLimit: 1 }), updateMask: { paths: ['daily_write_limit'] }, requestId: op() });
    await h.step(now);
    deliver(h, { ...MAILS.receiptEn, id: 'f30000000000f301' }, now);
    deliver(h, { ...MAILS.receiptEn, id: 'f30000000000f302', subject: 'Receipt for order 2' }, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(modifies(h).length).toBe(1);
    const settings = await h.api.getSettings({ name: 'settings' });
    expect(settings).toMatchObject({ breakerTripped: true, breakerReason: 'daily_limit', effectiveMode: Mode.SHADOW });
    expect(JSON.stringify((await h.opsStatus())['signals'])).toContain('breaker_tripped');
    // The refused write leaves its decision only recorded, not a review item.
    expect(await decision(h, 'f30000000000f302')).toMatchObject({ outcome: 'suggested', shown: 0 });
    expect((await h.api.listReviewItems({})).reviewItems).toEqual([]);
  });

  it('undoes a time range', async () => {
    const result = await h.api.undoLedgerEntries({ startTime: timestampFromMs(T0 - DAY), endTime: timestampFromMs(T0 + DAY), requestId: op() });
    expect(result).toMatchObject({ undoneCount: 1, remainingCount: 0 });
    expect(gmailLabels(h, 'f30000000000f301')).toContain('INBOX');
  });
});
