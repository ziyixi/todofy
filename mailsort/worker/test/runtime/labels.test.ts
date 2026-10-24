/** Fixed priority identities, optional Gmail feedback, and ledger undo in real workerd. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { Label_GmailState, LabelSchema } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import { Example_Origin } from '@ziyixi/proto/mailsort/ui/v2/review_pb';
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v2/flow_pb';
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { MAILS } from '../fakes/fixtures.ts';
import { DAY, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, decision, deliver, gmailLabels, modifies, setMode } from './helpers.ts';

describe('fixed priority labels and owner corrections', () => {
  let h: Harness;
  let now = T0;
  beforeAll(async () => {
    h = await startHarness();
    await h.clock(now);
    expect((await h.api.initializePriorities({ requestId: op() })).completed).toBe(true);
    await setMode(h, Mode.LIVE);
    await h.step(now);
  });
  afterAll(async () => { await h.dispose(); });
  afterEach(() => { checkGoogleCalls(h); });

  async function classified(id: string, priority: string, labels?: string[]): Promise<void> {
    h.up.ai.choiceOverride = () => ({ [priority]: 0.92, none: 0.08 });
    deliver(h, { ...MAILS.bankEn, id, ...(labels === undefined ? {} : { labels }) }, now + MINUTE);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, id)).toMatchObject({ outcome: 'applied', label_id: priority, shown: 0 });
  }

  it('owns exactly four flat Gmail identities, with P1 retained and P2-P4 archived', async () => {
    const labels = (await h.api.listLabels({})).labels;
    expect(labels.map((label) => [label.name, label.displayName, label.keepInInbox])).toEqual([
      ['labels/p1', 'P1', true], ['labels/p2', 'P2', false], ['labels/p3', 'P3', false], ['labels/p4', 'P4', false],
    ]);
    expect(labels.every((label) => label.enabled && !label.trustImplying && label.trustedDomains.length === 0 && label.gmailState === Label_GmailState.LINKED)).toBe(true);
    expect([...h.up.gmail.labels.values()].filter((label) => label.type === 'user').map((label) => label.name)).toEqual(['P1', 'P2', 'P3', 'P4']);
  });

  it('repeated setup preserves existing Gmail IDs and sends no further writes', async () => {
    const before = h.up.gmail.calls.length;
    const ids = (await h.api.listLabels({})).labels.map((label) => label.gmailLabelId);
    const requestId = op();
    const first = await h.api.initializePriorities({ requestId });
    const second = await h.api.initializePriorities({ requestId });
    expect(second).toEqual(first);
    expect(first.completed).toBe(true);
    expect((await h.api.listLabels({})).labels.map((label) => label.gmailLabelId)).toEqual(ids);
    expect(h.up.gmail.calls).toHaveLength(before);
  });

  it('rejects old label CRUD, sync and trusted-domain controls after setup', async () => {
    const p1 = await h.api.getLabel({ name: 'labels/p1' });
    const requests = [
      () => h.api.createLabel({ labelId: 'extra', label: create(LabelSchema, { displayName: 'Extra', description: 'extra' }), requestId: op() }),
      () => h.api.updateLabel({ label: { ...p1, displayName: 'Custom' }, updateMask: { paths: ['display_name'] }, requestId: op() }),
      () => h.api.updateLabel({ label: { ...p1, keepInInbox: false }, updateMask: { paths: ['keep_in_inbox'] }, requestId: op() }),
      () => h.api.deleteLabel({ name: p1.name, etag: p1.etag, requestId: op() }),
      () => h.api.syncLabels({ requestId: op() }),
      () => h.api.removeTrustedDomain({ name: p1.name, domain: 'broker.example.com', etag: p1.etag, requestId: op() }),
    ];
    const before = h.up.gmail.calls.length;
    for (const request of requests) expect(reasonOf(await rejection(request()))).toBe('BAD_REQUEST');
    expect(h.up.gmail.calls).toHaveLength(before);
    expect((await h.api.listLabels({})).labels).toHaveLength(4);
  });

  it('undo of P1 removes its label while preserving INBOX and UNREAD', async () => {
    const id = 'abc0000000000201';
    await classified(id, 'p1');
    const entry = (await h.api.listLedgerEntries({})).ledgerEntries.find((row) => row.messageId === id);
    expect(entry).toMatchObject({ label: 'labels/p1', archived: false, undoable: true });
    await h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() });
    expect(gmailLabels(h, id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
  });

  it('undo of an archived priority restores INBOX and leaves UNREAD intact', async () => {
    const id = 'abc0000000000202';
    await classified(id, 'p2');
    const entry = (await h.api.listLedgerEntries({})).ledgerEntries.find((row) => row.messageId === id);
    expect(entry).toMatchObject({ label: 'labels/p2', archived: true, undoable: true });
    await h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() });
    expect(gmailLabels(h, id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
  });

  it('replaces inherited priority on a new reply and undo restores its original label', async () => {
    const id = 'abc0000000000203';
    const p3 = h.up.gmail.labelIdByName('P3') ?? '';
    await classified(id, 'p1', ['INBOX', 'UNREAD', p3]);
    const p1 = h.up.gmail.labelIdByName('P1') ?? '';
    expect(gmailLabels(h, id)).toEqual(['INBOX', 'UNREAD', p1].sort());
    const entry = (await h.api.listLedgerEntries({})).ledgerEntries.find((row) => row.messageId === id);
    await h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() });
    expect(gmailLabels(h, id)).toEqual(['INBOX', 'UNREAD', p3].sort());
  });

  it('learns a current Gmail priority correction, with flow counters and bounded examples', async () => {
    const id = 'abc0000000000204';
    await classified(id, 'p2');
    const p2 = h.up.gmail.labelIdByName('P2') ?? '';
    const p3 = h.up.gmail.labelIdByName('P3') ?? '';
    h.up.gmail.ownerModify(id, [p3], [p2]);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, id)).toMatchObject({ verdict: 'corrected', verdict_label: 'p3', verdict_source: 'gmail' });
    expect(await h.sql(`SELECT label_id, origin FROM examples WHERE message_id = ?`, id)).toEqual([{ label_id: 'p3', origin: 'correction' }]);
    expect((await h.api.listExamples({ label: 'labels/p3' })).examples).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'labels/p3', origin: Example_Origin.CORRECTION })]));
    expect((await h.api.getLabel({ name: 'labels/p3' })).trustedDomains).toEqual([]);
    const flow = await h.api.getMailFlow({ name: 'mailFlows/today' });
    expect(flow.counts.find((row) => row.stage === MailFlow_Stage.CLEF && row.outcome === MailFlow_Outcome.CORRECTED && row.label === 'labels/p2')?.mailCount).toBeGreaterThan(0);
    const report = await h.api.getLabelReport({ name: 'labelReport' });
    expect(report.labels.find((row) => row.label === 'labels/p2')?.gmailCorrectionCount).toBeGreaterThan(0);
    // Returning to the applied label withdraws this correction and its example.
    h.up.gmail.ownerModify(id, [p2], [p3]);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, id)).toMatchObject({ verdict: null });
    expect(await h.sql(`SELECT id FROM examples WHERE message_id = ?`, id)).toEqual([]);
  });

  it('a range undo filtered to one priority affects only its ledger entries', async () => {
    const second = 'abc0000000000205';
    const fourth = 'abc0000000000206';
    await classified(second, 'p2');
    await classified(fourth, 'p4');
    const otherBefore = await h.sql(`SELECT id, state FROM ledger WHERE label_id != 'p2' ORDER BY id`);
    await h.api.undoLedgerEntries({ label: 'labels/p2', startTime: timestampFromMs(T0 - DAY), endTime: timestampFromMs(T0 + DAY), requestId: op() });
    expect(gmailLabels(h, second)).toContain('INBOX');
    expect(gmailLabels(h, fourth)).not.toContain('INBOX');
    expect(gmailLabels(h, fourth)).toContain(h.up.gmail.labelIdByName('P4'));
    expect(await h.sql(`SELECT id, state FROM ledger WHERE label_id != 'p2' ORDER BY id`)).toEqual(otherBefore);
    expect(modifies(h).every((call) => !call.body.includes('SPAM') && !call.body.includes('TRASH') && !call.body.includes('UNREAD'))).toBe(true);
  });
});
