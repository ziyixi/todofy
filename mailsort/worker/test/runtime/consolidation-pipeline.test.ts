/** Consolidation runs through real SQLite/Alarm scheduling; all Gmail traffic goes to a synthetic mailbox. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { LabelConsolidationGroupSchema, LabelConsolidationGroup_SourceSchema, LabelConsolidation_State } from '@ziyixi/proto/mailsort/ui/v2/consolidation_pb';
import { LabelSchema } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { MAILS, message } from '../fakes/fixtures.ts';
import { allowedOperation } from '../fakes/table.ts';
import { op, startHarness, T0, MINUTE, DAY, type Harness } from './harness.ts';

const NAME = 'labelConsolidation';
describe('consolidation in the real pipeline', () => {
  let h: Harness;
  let now: number;
  let source: string;
  let target: string;
  const ids = Array.from({ length: 17 }, (_, index) => (0xb00000 + index).toString(16));
  beforeEach(async () => {
    h = await startHarness(); now = T0;
    for (const [id, name] of [['target', 'Legacy One'], ['source', 'Legacy Two']] as const) {
      await h.api.createLabel({ labelId: id, label: create(LabelSchema, { displayName: name, description: 'Synthetic technical notices.', enabled: true }), requestId: op() });
      const gmailId = h.up.gmail.createUserLabel(name, true);
      await h.sql(`UPDATE labels SET gmail_id = ?, gmail_state = 'linked' WHERE id = ?`, gmailId, id);
    }
    source = h.up.gmail.labelIdByName('Legacy Two') ?? '';
    target = h.up.gmail.labelIdByName('Legacy One') ?? '';
    for (const id of ids) h.up.gmail.deliver(message({ id, subject: 'Synthetic old mail', from: 'fixture@example.com', text: 'Synthetic.', receivedAt: T0 - 90 * DAY, labels: [source, 'UNREAD'] }));
    await h.step(now); // Install-time cursor: old mail is only touched by the explicit consolidation.
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', runWriteLimit: 1 }), updateMask: { paths: ['run_write_limit'] }, requestId: op() });
  });
  afterEach(async () => { await h.dispose(); });
  async function start() {
    const labels = await Promise.all(['target', 'source'].map((id) => h.api.getLabel({ name: `labels/${id}` })));
    return h.api.startLabelConsolidation({ name: NAME, requestId: op(), groups: [create(LabelConsolidationGroupSchema, {
      targetLabel: 'labels/target', displayName: 'Development', sources: labels.map((label) => create(LabelConsolidationGroup_SourceSchema, { label: label.name, etag: label.etag })),
    })] });
  }
  async function step() { now += MINUTE; return h.step(now); }

  it('queues newly arrived mail, holds classification, pauses in off mode, then resumes bounded historical swaps', async () => {
    await start();
    h.up.gmail.deliver(message({ ...MAILS.newsletterEn, receivedAt: T0 + 1 }));
    expect(await step()).toMatchObject({ code: 'label_consolidation', decided: 0, synced: 1 });
    expect(await h.sql(`SELECT message_id FROM pending`)).toEqual([{ message_id: MAILS.newsletterEn.id }]);
    expect(h.up.ai.calls).toHaveLength(0);
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.OFF }), updateMask: { paths: ['mode'] }, requestId: op() });
    const before = h.up.gmail.calls.length;
    expect(await step()).toMatchObject({ code: 'off' });
    expect(h.up.gmail.calls).toHaveLength(before);
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.SHADOW }), updateMask: { paths: ['mode'] }, requestId: op() });
    await step(); // Rename only.
    h.up.gmail.failWhen = (method, url) => method === 'POST' && url.pathname.endsWith('/modify') ? 503 : null;
    await step();
    const blocked = await h.api.getLabelConsolidation({ name: NAME });
    expect(blocked.state).toBe(LabelConsolidation_State.BLOCKED);
    expect(await h.sql(`SELECT count(*) AS n FROM label_merge_items WHERE state = 'pending'`)).toEqual([{ n: 10 }]);
    h.up.gmail.failWhen = null;
    await h.api.resumeLabelConsolidation({ name: NAME, etag: blocked.etag, requestId: op() });
    for (let index = 0; index < 60 && (await h.api.getLabelConsolidation({ name: NAME })).state === LabelConsolidation_State.RUNNING; index++) {
      const from = h.up.gmail.calls.length;
      await step();
      expect(h.up.gmail.calls.length - from).toBeLessThanOrEqual(40);
    }
    expect(await h.api.getLabelConsolidation({ name: NAME })).toMatchObject({ state: LabelConsolidation_State.SUCCEEDED, processedCount: 17 });
    expect(h.up.ai.calls).toHaveLength(0);
    expect(await h.sql(`SELECT message_id FROM pending`)).toEqual([{ message_id: MAILS.newsletterEn.id }]);
    for (const id of ids) expect([...h.up.gmail.messages.get(id)?.labelIds ?? []].sort()).toEqual([target, 'UNREAD'].sort());
    for (const call of h.up.gmail.calls) expect(allowedOperation(call.method, call.url, call.body, {
      owned: new Set([source, target]), planned: new Set(['Legacy One', 'Legacy Two', 'Development']), ledger: () => null,
      merge: { labels: new Set([source, target]), messages: new Set(ids), swaps: new Set(ids.map((id) => `${id}:${source}:${target}`)), hidden: new Set([source]), names: new Set(['Development']) },
    }), `${call.method} ${call.url}`).not.toBeNull();
    expect(h.up.strays).toEqual([]);
  });

  it('stops before a batch when the owner changes the frozen Gmail identity', async () => {
    await start(); await step(); await step();
    const label = h.up.gmail.labels.get(target);
    if (label === undefined) throw new Error('missing synthetic target');
    label.name = 'Changed by owner';
    await step();
    expect(await h.api.getLabelConsolidation({ name: NAME })).toMatchObject({ state: LabelConsolidation_State.BLOCKED, errorCode: 'label_changed' });
    expect(h.up.gmail.calls.filter((call) => call.url.endsWith('/modify'))).toHaveLength(0);
  });
});
