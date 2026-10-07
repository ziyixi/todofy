/**
 * The pipeline in workerd with a real SQLite MailsortState, the fake Gmail and the fake Workers AI
 * (../../../docs/design.md §4-§7): no backfill, shadow suggestions, live label + archive with UNREAD untouched, unsure
 * mail left in the inbox, undo, a Gmail correction becoming an example and then a rule proposal, trust labels, skips,
 * the history resync, the auth-failure stop, the neuron budget's switch to Clef-flash and the quota deferral. After every
 * test, every request Google got is checked against the independent table (../fakes/table.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { LabelSchema } from '@ziyixi/proto/mailsort/ui/v1/label_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v1/status_pb';
import { RuleSchema, Rule_Kind } from '@ziyixi/proto/mailsort/ui/v1/rule_pb';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { MAILS } from '../fakes/fixtures.ts';
import { DAY, HOUR, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { addLabels, checkGoogleCalls, decision, deliver, gmailLabels, modifies, setMode } from './helpers.ts';

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

  it('shadow: a confident decision is only a suggestion; nothing is written to Gmail', async () => {
    deliver(h, MAILS.newsletterEn, now);
    now += 5 * MINUTE;
    const pass = await h.step(now);
    expect(pass.decided).toBe(1);
    expect(await decision(h, MAILS.newsletterEn.id)).toMatchObject({ outcome: 'suggested', label_id: 'newsletter', decider: 'clef' });
    const { reviewItems } = await h.api.listReviewItems({});
    expect(reviewItems[0]).toMatchObject({ suggestedLabel: 'labels/newsletter', subject: 'Your weekly digest: 5 new posts' });
    expect(modifies(h)).toEqual([]);
    expect(gmailLabels(h, MAILS.newsletterEn.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    // The model saw masked text and a code for the address, never the address.
    const state = JSON.stringify(h.up.ai.calls.at(-1)?.input['state']);
    expect(state).not.toContain('owner@example.com');
    expect(state).not.toContain('digest@news.example.com');
    expect(state).toContain('[link news.example.com]');
    expect(state).not.toContain('123456789');
  });

  it('live: label added and INBOX removed, UNREAD untouched; unsure mail stays in the inbox without a label', async () => {
    await setMode(h, Mode.LIVE);
    const labels = await h.api.listLabels({});
    const newsletter = labels.labels.find((label) => label.name === 'labels/newsletter');
    await h.api.updateLabel({ label: create(LabelSchema, { name: 'labels/newsletter', live: true, etag: newsletter?.etag ?? '' }), updateMask: { paths: ['live'] }, requestId: op() });
    deliver(h, MAILS.newsletterZh, now);
    deliver(h, MAILS.unsure, now);
    now += 5 * MINUTE;
    await h.step(now);
    const labelId = h.up.gmail.labelIdByName('订阅');
    expect(labelId).toMatch(/^Label_/);
    expect(gmailLabels(h, MAILS.newsletterZh.id)).toEqual(['CATEGORY_UPDATES', labelId, 'UNREAD'].sort());
    expect(await decision(h, MAILS.newsletterZh.id)).toMatchObject({ outcome: 'applied', label_id: 'newsletter' });
    expect(gmailLabels(h, MAILS.unsure.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    expect(await decision(h, MAILS.unsure.id)).toMatchObject({ outcome: 'unsure', unsure_reason: 'none' });
    const [entry] = (await h.api.listLedgerEntries({})).ledgerEntries;
    expect(entry).toMatchObject({ messageId: MAILS.newsletterZh.id, label: 'labels/newsletter', archived: true, origin: 'auto' });
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status).toMatchObject({ appliedTodayCount: 1, writeScope: true, decisionModel: 'clef' });
  });

  it('undo removes exactly what it added and restores INBOX', async () => {
    const [entry] = (await h.api.listLedgerEntries({})).ledgerEntries;
    const undone = await h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() });
    expect(undone.state).toBe(4);
    expect(gmailLabels(h, MAILS.newsletterZh.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    expect(reasonOf(await rejection(h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() })))).toBe('NOT_UNDOABLE');
    // The history records of mailsort's own writes are not feedback.
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.newsletterZh.id)).toMatchObject({ verdict: null });
  });

  it('a Gmail correction becomes an example; the second for the same list proposes a rule', async () => {
    // The owner made 收据 in Gmail by hand: the sync adopts it for the label of that path.
    const receiptGmail = h.up.gmail.createUserLabel('收据', true);
    await h.api.syncLabels({ requestId: op() });
    expect((await h.api.getLabel({ name: 'labels/receipt' })).gmailLabelId).toBe(receiptGmail);
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
    const { rules } = await h.api.listRules({});
    expect(rules).toEqual([expect.objectContaining({ kind: Rule_Kind.LIST_ID, value: 'digest.news.example.com', label: 'labels/receipt', state: 1, correctionCount: 2 })]);
    // Putting the label back withdraws the correction: the example goes, the proposal with it.
    h.up.gmail.ownerModify('c000000000000c02', [newsletterGmail], [receiptGmail]);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, 'c000000000000c02')).toMatchObject({ verdict: null });
    expect((await h.api.listExamples({ label: 'labels/receipt' })).examples.length).toBe(1);
    expect((await h.api.listRules({})).rules).toEqual([]);
    // The examples are embedded by the next passes.
    expect((await h.api.listExamples({})).examples.every((example) => example.embedded)).toBe(true);
  });

  it('an approved rule decides without the model; a trust label needs a rule and DMARC', async () => {
    await h.api.createRule({ rule: create(RuleSchema, { kind: Rule_Kind.SENDER_ADDRESS, value: 'statements@bank.example.com', label: 'labels/bank' }), requestId: op() });
    const calls = h.up.ai.calls.length;
    deliver(h, MAILS.bankEn, now);
    deliver(h, { ...MAILS.bankEn, id: 'd000000000000d01', dmarc: 'fail', subject: 'Your monthly bank statement (copy)' }, now);
    deliver(h, MAILS.phishing, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.bankEn.id)).toMatchObject({ outcome: 'suggested', decider: 'rule', label_id: 'bank' });
    // Without DMARC the rule is skipped and the model may only suggest a trust label: unsure.
    expect(await decision(h, 'd000000000000d01')).toMatchObject({ outcome: 'unsure' });
    expect(await decision(h, MAILS.phishing.id)).toMatchObject({ outcome: 'unsure' });
    expect(['suspicious', 'trust_needs_rule']).toContain((await decision(h, MAILS.phishing.id))?.['unsure_reason']);
    expect(h.up.ai.calls.length - calls).toBeGreaterThanOrEqual(2);
  });

  it('skips sent mail and a conversation already sorted', async () => {
    deliver(h, MAILS.sent, now);
    deliver(h, { ...MAILS.newsletterZh, id: 'e000000000000e01', threadId: `t${MAILS.bankEn.id}` }, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.sent.id)).toBeUndefined();
    const rows = await h.sql(`SELECT count(*) AS n FROM pending`);
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('a review choice in live mode writes the owner’s label (and archives)', async () => {
    const { reviewItems } = await h.api.listReviewItems({});
    const unsure = reviewItems.find((item) => item.subject === 'Lunch on Friday?');
    const corrected = await h.api.correctReviewItem({ name: unsure?.name ?? '', label: 'labels/travel', requestId: op() });
    expect(corrected.state).toBe(3);
    const travel = h.up.gmail.labelIdByName('出行');
    expect(gmailLabels(h, MAILS.unsure.id)).toEqual(['CATEGORY_UPDATES', travel, 'UNREAD'].sort());
    expect(reasonOf(await rejection(h.api.skipReviewItem({ name: unsure?.name ?? '', requestId: op() })))).toBe('ALREADY_RESOLVED');
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
    // 20,000 input tokens: Clef 436 neurons a call, Clef-flash 164.
    h.up.ai.tokensPerCall = 20_000;
    for (let i = 0; i < 4; i++) deliver(h, { ...MAILS.receiptZh, id: `f00000000000f00${String(i)}`, subject: `您的订单 ${String(i)} 已发货` }, now);
    now += 5 * MINUTE;
    await h.step(now);
    const models = h.up.ai.calls.filter((call) => call.model.includes('clef')).map((call) => call.model);
    expect(models.slice(0, 2)).toEqual(['@cf/cloudflare/clef', '@cf/cloudflare/clef']);
    expect(models[2]).toBe('@cf/cloudflare/clef-flash');
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.decisionModel).toBe('clef-flash');
    expect(status.neuronsToday).toBeGreaterThan(1000);
    // Past the budget the rest waits for the next UTC day: deferred, not failed.
    expect(status.deferredCount).toBe(1);
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
    const labels = await h.api.listLabels({});
    for (const label of labels.labels) await h.api.updateLabel({ label: create(LabelSchema, { name: label.name, live: true }), updateMask: { paths: ['live'] }, requestId: op() });
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
    await addLabels(h, ['receipt']);
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
  });

  it('undoes a time range', async () => {
    const result = await h.api.undoLedgerEntries({ startTime: timestampFromMs(T0 - DAY), endTime: timestampFromMs(T0 + DAY), requestId: op() });
    expect(result).toMatchObject({ undoneCount: 1, remainingCount: 0 });
    expect(gmailLabels(h, 'f30000000000f301')).toContain('INBOX');
  });
});
