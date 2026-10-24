/** Priority pipeline with real workerd SQLite, synthetic Gmail and offline AI. */
import { afterEach, describe, expect, it } from 'vitest';
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { CLEF, DEFAULT_DAILY_NEURON_BUDGET } from '../../src/limits.ts';
import { PRIORITY_LABELS } from '../../src/priority.ts';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { PRIORITY_CASES } from '../fakes/priority-cases.ts';
import { PRIORITY_CLEF_CAPTURES } from '../fakes/priority-clef-captures.ts';
import { MINUTE, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, clefCalls, decision, deliver, gmailLabels, modifies, setMode } from './helpers.ts';

async function initialize(h: Harness, at = T0): Promise<void> {
  for (const [i, label] of PRIORITY_LABELS.entries()) {
    const gmailId = h.up.gmail.createUserLabel(label.displayName, true);
    await h.sql(`INSERT INTO labels (id, seq, display_name, description, enabled, gmail_id, gmail_state, keep_in_inbox, create_time, update_time, etag) VALUES (?, ?, ?, ?, 1, ?, 'linked', ?, ?, ?, 'e')`, label.id, i + 1, label.displayName, label.description, gmailId, label.keepInInbox ? 1 : 0, at, at);
  }
  await h.sql(`INSERT INTO meta (key, value) VALUES ('priority_started_at', ?)`, String(at));
  await h.step(at);
}
const force = (h: Harness, id: string) => { h.up.ai.choiceOverride = () => ({ [id]: 0.92, none: 0.08 }); };
const newMail = (id: string, override: Partial<SyntheticMail> = {}): SyntheticMail => ({ ...MAILS.bankEn, id, subject: 'Synthetic brokerage statement', text: 'Your monthly statement is ready. No deadline or action.', ...override });

let h: Harness;
afterEach(async () => {
  checkGoogleCalls(h); await h.dispose();
});

describe('fixed priorities', () => {
  it('registers arrivals while waiting for explicit setup without classifying with old labels', async () => {
    h = await startHarness();
    const pass = await h.step(T0);
    expect(pass.code).toBe('priority_setup_required');
    deliver(h, newMail('abc0000000000000'), T0 + MINUTE);
    expect((await h.step(T0 + 2 * MINUTE)).code).toBe('priority_setup_required');
    expect(await h.sql(`SELECT message_id FROM pending`)).toEqual([{ message_id: 'abc0000000000000' }]);
    expect(await decision(h, 'abc0000000000000')).toBeUndefined();
    expect(modifies(h)).toEqual([]);
    expect(h.up.ai.calls).toEqual([]);
  });

  it.each(['p1', 'p2', 'p3', 'p4'])('writes real %s and preserves UNREAD, keeping only P1 in Inbox', async (priority) => {
    h = await startHarness();
    await initialize(h);
    await setMode(h, Mode.LIVE);
    force(h, priority);
    const mail = newMail('abc0000000000001', { dmarc: 'fail' });
    deliver(h, mail, T0 + MINUTE);
    const pass = await h.step(T0 + 2 * MINUTE);
    expect(pass).toMatchObject({ decided: 1, applied: 1 });
    const gmailId = h.up.gmail.labelIdByName(priority.toUpperCase());
    expect(gmailLabels(h, mail.id)).toEqual(['CATEGORY_UPDATES', 'UNREAD', gmailId, ...(priority === 'p1' ? ['INBOX'] : [])].sort());
    expect(await decision(h, mail.id)).toMatchObject({ outcome: 'applied', label_id: priority, shown: 0, suspicious: null, bulk: null });
    expect((await h.api.listReviewItems({})).reviewItems).toEqual([]);
    for (const call of h.up.ai.calls) {
      expect(Object.keys(call.input['questions'] as object)).toEqual(['label']);
      expect(JSON.stringify(call.input)).not.toMatch(/scam|phishing|suspicious|sender_authenticated/i);
    }
  });

  it.each(['none', 'uncertain', 'disagreement'])('writes P1 without a mandatory review after valid %s', async (kind) => {
    h = await startHarness();
    await initialize(h);
    await setMode(h, Mode.LIVE);
    let calls = 0;
    h.up.ai.choiceOverride = () => kind === 'none' ? { none: 0.92, p1: 0.08 } : kind === 'uncertain' ? { p2: 0.5, none: 0.5 } : ++calls === 1 ? { p2: 0.92, none: 0.08 } : { p1: 0.92, none: 0.08 };
    const mail = newMail('abc0000000000002');
    deliver(h, mail, T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(await decision(h, mail.id)).toMatchObject({ outcome: 'applied', label_id: 'p1', shown: 0 });
    expect(gmailLabels(h, mail.id)).toContain('INBOX');
    expect(gmailLabels(h, mail.id)).toContain(h.up.gmail.labelIdByName('P1'));
    expect(await h.sql(`SELECT id FROM review`)).toEqual([]);
  });

  it.each(['next-week-review-en', 'missing-deadline-zh'])('applies the captured confidence policy to %s', async (caseId) => {
    const fixture = PRIORITY_CASES.find(row => row.id === caseId);
    const capture = PRIORITY_CLEF_CAPTURES.find(row => row.id === caseId && row.model === CLEF);
    if (fixture === undefined || capture === undefined) throw new Error('Missing synthetic calibration fixture');
    h = await startHarness();
    await initialize(h);
    await setMode(h, Mode.LIVE);
    let calls = 0;
    h.up.ai.choiceOverride = () => ++calls === 1 ? { ...capture.first } : { ...capture.second };
    const mail = newMail('abc00000000000c1', { subject: fixture.subject, text: fixture.body });
    deliver(h, mail, fixture.receivedAt);
    expect(await h.step(fixture.now)).toMatchObject({ decided: 1, applied: 1 });
    expect(clefCalls(h)).toHaveLength(2);
    expect(await decision(h, mail.id)).toMatchObject({ outcome: 'applied', label_id: fixture.expected, top_label: 'p2', unsure_reason: fixture.expected === 'p1' ? 'low_confidence' : '' });
    expect(gmailLabels(h, mail.id)).toContain('UNREAD');
    expect(gmailLabels(h, mail.id).includes('INBOX')).toBe(fixture.expected === 'p1');
    expect(gmailLabels(h, mail.id)).toContain(h.up.gmail.labelIdByName(fixture.expected.toUpperCase()));
  });

  it('judges an urgent new reply even when its conversation and message carry P3', async () => {
    h = await startHarness();
    await initialize(h);
    await setMode(h, Mode.LIVE);
    force(h, 'p3');
    const first = newMail('abc0000000000003', { threadId: 'thread-synthetic' });
    deliver(h, first, T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    force(h, 'p1');
    const before = h.up.ai.calls.length;
    const p3 = h.up.gmail.labelIdByName('P3') ?? '';
    const reply = newMail('abc0000000000004', { threadId: 'thread-synthetic', subject: 'Urgent reply: action needed today', text: 'Please reply within one hour.', labels: ['INBOX', 'UNREAD', p3] });
    deliver(h, reply, T0 + 3 * MINUTE);
    await h.step(T0 + 4 * MINUTE);
    expect(clefCalls(h, before)).toHaveLength(2);
    expect(await h.sql(`SELECT state, last_code FROM ledger WHERE message_id = ?`, reply.id)).toEqual([{ state: 'applied', last_code: null }]);
    expect(await decision(h, reply.id)).toMatchObject({ outcome: 'applied', label_id: 'p1', shown: 0 });
    expect(gmailLabels(h, reply.id)).toContain('INBOX');
    expect(gmailLabels(h, reply.id)).toContain(h.up.gmail.labelIdByName('P1'));
    // Same message ID is never classified twice even if Gmail repeats the delivery record.
    const after = h.up.ai.calls.length;
    deliver(h, reply, T0 + 5 * MINUTE);
    await h.step(T0 + 6 * MINUTE);
    expect(h.up.ai.calls).toHaveLength(after);
  });

  it('retains fallback evidence and learns it only after a Gmail correction', async () => {
    h = await startHarness();
    await initialize(h);
    await setMode(h, Mode.LIVE);
    let calls = 0;
    h.up.ai.choiceOverride = () => ++calls % 2 === 1
      ? { p1: 0.05, p2: 0.55, p3: 0.30, p4: 0.05, none: 0.05 }
      : { p1: 0.06, p2: 0.57, p3: 0.31, none: 0.06 };
    const first = newMail('abc0000000000010');
    deliver(h, first, T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(await decision(h, first.id)).toMatchObject({ outcome: 'applied', label_id: 'p1', top_label: 'p2', unsure_reason: 'low_confidence', shown: 0 });
    expect(gmailLabels(h, first.id)).toContain('INBOX');
    expect(await h.sql(`SELECT id FROM review`)).toEqual([]);
    const report = await h.api.getLabelReport({ name: 'labelReport' });
    expect(report).toMatchObject({ autoCount: 1, fallbackCount: 1 });
    expect(report.labels.find(row => row.label === 'labels/p1')).toMatchObject({ autoCount: 1, fallbackCount: 1 });
    expect(report.labels.find(row => row.label === 'labels/p2')).toMatchObject({ autoCount: 0, fallbackCount: 0 });

    const before = h.up.ai.calls.length;
    deliver(h, newMail('abc0000000000011'), T0 + 3 * MINUTE);
    await h.step(T0 + 4 * MINUTE);
    expect(clefCalls(h, before)).toHaveLength(2);
    for (const call of clefCalls(h, before)) expect(call.state['sender_history']).toBeUndefined();
    await h.step(T0 + 4 * 86_400_000);
    expect(await h.sql(`SELECT verdict FROM decisions WHERE message_id IN (?, ?)`, first.id, 'abc0000000000011')).toEqual([{ verdict: null }, { verdict: null }]);
    expect(await h.sql(`SELECT id FROM examples`)).toEqual([]);

    const writes = modifies(h).length;
    h.up.gmail.ownerModify(first.id, [h.up.gmail.labelIdByName('P3') ?? ''], [h.up.gmail.labelIdByName('P1') ?? '']);
    await h.step(T0 + 4 * 86_400_000 + MINUTE);
    expect(await decision(h, first.id)).toMatchObject({ label_id: 'p1', top_label: 'p2', unsure_reason: 'low_confidence', verdict: 'corrected', verdict_label: 'p3', verdict_source: 'gmail' });
    expect(await h.sql(`SELECT label_id, origin FROM examples WHERE message_id = ?`, first.id)).toEqual([{ label_id: 'p3', origin: 'correction' }]);
    expect(modifies(h)).toHaveLength(writes);
    force(h, 'p3');
    const after = h.up.ai.calls.length;
    deliver(h, newMail('abc0000000000012'), T0 + 4 * 86_400_000 + 2 * MINUTE);
    await h.step(T0 + 4 * 86_400_000 + 3 * MINUTE);
    for (const call of clefCalls(h, after)) expect(call.state['sender_history']).toBe('p3 ×1');
  });

  it('keeps shadow as records only and does not reclassify mail received before cutover', async () => {
    h = await startHarness();
    await initialize(h);
    force(h, 'p2');
    const mail = newMail('abc0000000000005');
    deliver(h, mail, T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(await decision(h, mail.id)).toMatchObject({ outcome: 'suggested', label_id: 'p2' });
    expect(modifies(h)).toEqual([]);
    const old = newMail('abc0000000000006');
    deliver(h, old, T0 - MINUTE);
    await h.step(T0 + 3 * MINUTE);
    expect(await decision(h, old.id)).toMatchObject({ outcome: 'skipped', unsure_reason: 'before_install' });
  });

  it('preserves the daily neuron budget, flash switch and next-day deferral', async () => {
    h = await startHarness();
    await initialize(h);
    await setMode(h, Mode.LIVE);
    force(h, 'p2');
    const day = new Date(T0).toISOString().slice(0, 10);
    await h.sql(`INSERT INTO usage (day, neurons) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET neurons = excluded.neurons`, day, DEFAULT_DAILY_NEURON_BUDGET * 0.71);
    deliver(h, newMail('abc0000000000007'), T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(clefCalls(h).map((call) => call.model)).toEqual(['@cf/cloudflare/clef-flash', '@cf/cloudflare/clef-flash']);
    await h.sql(`UPDATE usage SET neurons = ? WHERE day = ?`, DEFAULT_DAILY_NEURON_BUDGET, day);
    deliver(h, newMail('abc0000000000008'), T0 + 3 * MINUTE);
    const calls = h.up.ai.calls.length;
    const pass = await h.step(T0 + 4 * MINUTE);
    expect(pass.code).toBe('deferred');
    expect(pass.deferred).toBeGreaterThan(0);
    expect(await h.sql(`SELECT message_id FROM pending`)).toEqual([{ message_id: 'abc0000000000008' }]);
    expect(await decision(h, 'abc0000000000008')).toBeUndefined();
    expect(h.up.ai.calls).toHaveLength(calls);
    expect(await h.sql(`SELECT not_before FROM pending WHERE message_id = 'abc0000000000008'`)).toEqual([{ not_before: T0 + 86_400_000 }]);
  });

  it('backs off a model outage without creating a P1 write', async () => {
    h = await startHarness();
    await initialize(h);
    await setMode(h, Mode.LIVE);
    h.up.ai.broken = true;
    deliver(h, newMail('abc0000000000009'), T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(await decision(h, 'abc0000000000009')).toBeUndefined();
    expect(modifies(h)).toEqual([]);
    expect(await h.sql(`SELECT attempts, not_before FROM pending WHERE message_id = 'abc0000000000009'`)).toEqual([{ attempts: 1, not_before: T0 + 7 * MINUTE }]);
  });
});
