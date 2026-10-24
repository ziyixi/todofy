/** The private consolidation API: frozen ownership, stale plans, replay and conflicting mutations. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import {
  LabelConsolidation_Group_State, LabelConsolidation_Phase, LabelConsolidation_State,
  LabelConsolidationGroupSchema, LabelConsolidationGroup_SourceSchema,
} from '@ziyixi/proto/mailsort/ui/v2/consolidation_pb';
import { LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { message } from '../fakes/fixtures.ts';
import { op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';

const NAME = 'labelConsolidation';

describe('label consolidation owner API', () => {
  let h: Harness;
  let first: Label;
  let second: Label;
  beforeEach(async () => {
    h = await startHarness();
    for (const [id, name] of [['first', 'Original One'], ['second', 'Original Two']] as const) {
      await h.api.createLabel({ labelId: id, label: create(LabelSchema, { displayName: name, description: 'Original synthetic notices.', enabled: true }), requestId: op() });
      const gmailId = h.up.gmail.createUserLabel(name);
      await h.sql(`UPDATE labels SET gmail_id = ?, gmail_state = 'linked' WHERE id = ?`, gmailId, id);
    }
    first = await h.api.getLabel({ name: 'labels/first' });
    second = await h.api.getLabel({ name: 'labels/second' });
  });
  afterEach(async () => { await h.dispose(); });

  function group(labels: readonly Label[] = [first, second]) {
    return create(LabelConsolidationGroupSchema, {
      targetLabel: labels[0]?.name ?? '', displayName: 'Combined', description: 'Synthetic notices for the same topic.',
      sources: labels.map((label) => create(LabelConsolidationGroup_SourceSchema, { label: label.name, etag: label.etag })),
    });
  }

  it('refuses stale, duplicate, unowned and invalid sources before freezing a plan', async () => {
    expect(reasonOf(await rejection(h.api.getLabelConsolidation({ name: NAME })))).toBe('NOT_FOUND');
    const stale = group();
    stale.sources = stale.sources.map((source) => ({ ...source, etag: 'old-etag' }));
    expect(reasonOf(await rejection(h.api.startLabelConsolidation({ name: NAME, groups: [stale], requestId: op() })))).toBe('ETAG_MISMATCH');
    const wrongTarget = group();
    wrongTarget.targetLabel = second.name;
    const invalidName = group();
    invalidName.displayName = 'Nested/English';
    for (const groups of [[group([first, first])], [group([first]), group([first])], [wrongTarget], [invalidName], []]) {
      expect(reasonOf(await rejection(h.api.startLabelConsolidation({ name: NAME, groups, requestId: op() })))).toBe('INVALID_LABEL');
    }
    await h.sql(`UPDATE labels SET gmail_state = 'missing', gmail_id = NULL WHERE id = 'second'`);
    expect(reasonOf(await rejection(h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId: op() })))).toBe('INVALID_LABEL');
    expect(await h.sql(`SELECT count(*) AS n FROM label_merge_jobs`)).toEqual([{ n: 0 }]);
  });

  it('accepts uncreated legacy labels through the owner API', async () => {
    for (const label of [first, second]) h.up.gmail.labels.delete(label.gmailLabelId);
    await h.sql(`UPDATE labels SET gmail_state = 'pending', gmail_id = NULL,
      display_name = 'Legacy/' || id, problem = 'invalid_name' WHERE id IN ('first', 'second')`);
    const callsBefore = h.up.gmail.calls.length;
    const started = await h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId: op() });
    expect(started).toMatchObject({ state: LabelConsolidation_State.RUNNING, phase: LabelConsolidation_Phase.PREFLIGHT,
      groups: [{ targetLabel: first.name, sourceLabels: [first.name, second.name], displayName: 'Combined' }] });
    expect(await h.api.getLabelConsolidation({ name: NAME })).toEqual(started);
    expect(h.up.gmail.calls).toHaveLength(callsBefore);
  });

  it('freezes one private plan, replays its receipt and blocks conflicting mutations', async () => {
    const requestId = op();
    const started = await h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId });
    expect(started).toMatchObject({ name: NAME, jobId: requestId, state: LabelConsolidation_State.RUNNING,
      phase: LabelConsolidation_Phase.PREFLIGHT, nextAction: 'wait', processedCount: 0,
      groups: [{ targetLabel: first.name, sourceLabels: [first.name, second.name], displayName: 'Combined', state: LabelConsolidation_Group_State.PENDING }] });
    expect(started.etag).not.toBe('');
    const changed = group();
    changed.displayName = 'A Different Plan';
    expect(await h.api.startLabelConsolidation({ name: NAME, groups: [changed], requestId })).toEqual(started);
    expect(await h.sql(`SELECT count(*) AS n FROM label_merge_jobs`)).toEqual([{ n: 1 }]);
    const blocked = [
      () => h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId: op() }),
      () => h.api.syncLabels({ requestId: op() }),
      () => h.api.createLabel({ labelId: 'third', label: create(LabelSchema, { displayName: 'Third' }), requestId: op() }),
      () => h.api.updateLabel({ label: create(LabelSchema, { name: first.name, description: 'Changed' }), updateMask: { paths: ['description'] }, requestId: op() }),
      () => h.api.deleteLabel({ name: first.name, requestId: op() }),
      () => h.api.resolveReviewItem({ name: 'reviewItems/synthetic-item', label: first.name, requestId: op() }),
      () => h.api.skipReviewItem({ name: 'reviewItems/synthetic-item', requestId: op() }),
      () => h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() }),
    ];
    const callsBefore = h.up.gmail.calls.length;
    for (const call of blocked) expect(reasonOf(await rejection(call()))).toBe('CONSOLIDATION_ACTIVE');
    expect(h.up.gmail.calls).toHaveLength(callsBefore);
    expect(await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.OFF }), updateMask: { paths: ['mode'] }, requestId: op() }))
      .toMatchObject({ mode: Mode.OFF });
    expect(await h.api.getLabelConsolidation({ name: NAME })).toEqual(started);
  });

  it('resumes only the exact blocked plan and keeps the same phase after a lost response', async () => {
    const started = await h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId: op() });
    expect(reasonOf(await rejection(h.api.resumeLabelConsolidation({ name: NAME, etag: started.etag, requestId: op() })))).toBe('CONSOLIDATION_NOT_BLOCKED');
    await h.sql(`UPDATE label_merge_jobs SET state = 'blocked', phase = 'move', error_code = 'message_changed', etag = 'blocked-version', update_time = ?`, T0 + 10);
    const blocked = await h.api.getLabelConsolidation({ name: NAME });
    expect(blocked).toMatchObject({ state: LabelConsolidation_State.BLOCKED, phase: LabelConsolidation_Phase.MOVE, errorCode: 'message_changed', nextAction: 'resume' });
    expect(reasonOf(await rejection(h.api.resumeLabelConsolidation({ name: NAME, etag: started.etag, requestId: op() })))).toBe('ETAG_MISMATCH');
    const requestId = op();
    const resumed = await h.api.resumeLabelConsolidation({ name: NAME, etag: blocked.etag, requestId });
    expect(resumed).toMatchObject({ jobId: started.jobId, state: LabelConsolidation_State.RUNNING, phase: LabelConsolidation_Phase.MOVE, errorCode: '', nextAction: 'wait' });
    expect(resumed.etag).not.toBe(blocked.etag);
    expect(await h.api.resumeLabelConsolidation({ name: NAME, etag: blocked.etag, requestId })).toEqual(resumed);
    expect(reasonOf(await rejection(h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId })))).toBe('BAD_REQUEST');
  });

  it('preserves a running replay instead of replacing it or changing its label inputs', async () => {
    await h.sql(`INSERT INTO replay (job_id, message_id, state, create_time) VALUES ('existing-replay', '', 'running', ?)`, T0);
    const before = await h.sql(`SELECT * FROM replay`);
    expect(reasonOf(await rejection(h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() })))).toBe('REPLAY_ACTIVE');
    expect(reasonOf(await rejection(h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId: op() })))).toBe('REPLAY_ACTIVE');
    expect(await h.sql(`SELECT * FROM replay`)).toEqual(before);
  });

  it('waits for an owner Gmail operation without blocking reads or emergency off', async () => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const original = h.up.handle.bind(h.up);
    h.up.handle = async (request) => {
      if (request.method === 'GET' && request.headers.get('x-mailsort-original-url')?.endsWith('/labels')) {
        entered.resolve(undefined);
        await release.promise;
      }
      return original(request);
    };
    const syncing = h.api.syncLabels({ requestId: op() });
    try {
      await Promise.race([entered.promise, syncing.then(() => { throw new Error('sync completed before the held Gmail call'); })]);
      expect(reasonOf(await rejection(h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId: op() })))).toBe('CONSOLIDATION_PENDING_WRITES');
      expect(await h.api.getServiceStatus({ name: 'serviceStatus' })).toMatchObject({ name: 'serviceStatus' });
      expect(await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.OFF }), updateMask: { paths: ['mode'] }, requestId: op() })).toMatchObject({ mode: Mode.OFF });
      expect(await h.sql(`SELECT count(*) AS n FROM label_merge_jobs`)).toEqual([{ n: 0 }]);
    } finally {
      release.resolve(undefined);
      await syncing;
      h.up.handle = original;
    }
    expect(await h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId: op() })).toMatchObject({ state: LabelConsolidation_State.RUNNING });
  });

  it('waits for an alarm already reading Gmail before freezing labels', async () => {
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.SHADOW }), updateMask: { paths: ['mode'] }, requestId: op() });
    await h.step(T0);
    h.up.gmail.deliver(message({ id: 'a200000000000001', from: 'sender@example.com', subject: 'Synthetic notices', text: 'An original notice.', receivedAt: T0 + 1000 }));
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const original = h.up.handle.bind(h.up);
    h.up.handle = async (request) => {
      if (new URL(request.url).pathname.endsWith('/history')) {
        entered.resolve(undefined);
        await release.promise;
      }
      return original(request);
    };
    const pass = h.step(T0 + 1000);
    try {
      await Promise.race([entered.promise, pass.then(() => { throw new Error('alarm completed without reaching Gmail history'); })]);
      expect(reasonOf(await rejection(h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId: op() })))).toBe('CONSOLIDATION_PENDING_WRITES');
      expect(await h.api.getServiceStatus({ name: 'serviceStatus' })).toMatchObject({ name: 'serviceStatus' });
      expect(await h.sql(`SELECT count(*) AS n FROM label_merge_jobs`)).toEqual([{ n: 0 }]);
    } finally {
      release.resolve(undefined);
      await pass;
      h.up.handle = original;
    }
    expect(await h.api.startLabelConsolidation({ name: NAME, groups: [group()], requestId: op() })).toMatchObject({ state: LabelConsolidation_State.RUNNING });
  });

  it('reads old reviews and report counts through aliases without rewriting their evidence', async () => {
    await h.sql(`INSERT INTO label_aliases (source_id, target_id) VALUES ('second', 'first')`);
    await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, top_label, decider,
      probabilities, verdict, verdict_label, verdict_source)
      VALUES ('synthetic-message', 'synthetic-thread', ?, ?, 'applied', 'second', 'second', 'clef', '{"first":0.2,"second":0.6}', 'corrected', 'first', 'review')`, T0, T0);
    await h.sql(`INSERT INTO review (id, message_id, kind, state, suggested_label, candidates, decider, subject, sender, receive_time, create_time)
      VALUES ('synthetic-review', 'synthetic-message', 'unsure', 'pending', 'second', '[{"label":"first","probability":0.2},{"label":"second","probability":0.6}]',
      'clef', 'Synthetic subject', 'Synthetic sender', ?, ?)`, T0, T0);
    const originalDecision = await h.sql(`SELECT * FROM decisions`);
    const originalReview = await h.sql(`SELECT * FROM review`);
    expect((await h.api.listLabels({})).labels.map((label) => label.name)).toEqual([first.name]);
    expect(await h.api.getLabel({ name: second.name })).toMatchObject({ name: first.name, displayName: first.displayName });
    expect(reasonOf(await rejection(h.api.deleteLabel({ name: second.name, requestId: op() })))).toBe('NOT_FOUND');
    expect(reasonOf(await rejection(h.api.updateLabel({ label: create(LabelSchema, { name: second.name, enabled: true }), updateMask: { paths: ['enabled'] }, requestId: op() })))).toBe('NOT_FOUND');
    const review = await h.api.getReviewItem({ name: 'reviewItems/synthetic-review' });
    expect(review).toMatchObject({ candidates: [{ label: first.name, probability: 0.8 }] });
    expect((await h.api.listReviewItems({})).reviewItems).toEqual([review]);
    expect(await h.api.getLabelReport({ name: 'labelReport' })).toMatchObject({ decidedCount: 1, autoCount: 1,
      labels: [{ label: first.name, autoCount: 1, reviewCorrectionCount: 0 }] });
    await h.sql(`INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time)
      VALUES ('synthetic-ledger', 'synthetic-message', 'second', ?, 0, 'auto', 'applied', ?)`, second.gmailLabelId, T0);
    expect(await h.api.getLedgerEntry({ name: 'ledgerEntries/synthetic-ledger' })).toMatchObject({ label: first.name });
    expect((await h.api.listLedgerEntries({ label: first.name })).ledgerEntries).toMatchObject([{ label: first.name }]);
    expect((await h.api.listLedgerEntries({ label: second.name })).ledgerEntries).toMatchObject([{ label: first.name }]);
    await h.sql(`INSERT INTO flow (day, stage, outcome, label, n) VALUES ('2026-10-01', 'clef', 'archived', 'second', 2), ('2026-10-01', 'clef', 'archived', 'first', 1)`);
    expect((await h.api.getMailFlow({ name: 'mailFlows/today' })).counts).toMatchObject([{ label: first.name, mailCount: 3 }]);
    await h.sql(`INSERT INTO replay (job_id, message_id, state, create_time, done_time) VALUES ('past-replay', '', 'succeeded', ?, ?)`, T0, T0);
    await h.sql(`INSERT INTO replay (job_id, message_id, state, owner_label, outcome, label, top_option, top_p, authenticated, create_time, done_time)
      VALUES ('past-replay', 'synthetic-message', 'evaluated', 'first', 'label', 'second', 'second', 0.9, 1, ?, ?)`, T0, T0);
    expect(await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).toMatchObject({ autoMatchCount: 1, mismatches: [], cases: [{ ownerLabel: first.name, topLabel: first.name, topProbability: 0.9 }] });
    expect(await h.sql(`SELECT * FROM decisions`)).toEqual(originalDecision);
    expect(await h.sql(`SELECT * FROM review`)).toEqual(originalReview);
  });

  it('keeps merged history read-only while normal target entries remain undoable', async () => {
    await h.api.syncLabels({ requestId: op() });
    await h.sql(`INSERT INTO label_aliases (source_id, target_id) VALUES ('second', 'first')`);
    for (const [id, source] of [['a100000000000001', 'first'], ['a100000000000002', 'second']] as const) {
      h.up.gmail.deliver(message({ id, from: 'sender@example.com', subject: 'Synthetic undo', text: 'Synthetic.', labels: ['INBOX', 'UNREAD', first.gmailLabelId] }));
      await h.sql(`INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time)
        VALUES (?, ?, ?, ?, 0, 'auto', 'applied', ?)`, id, id, source, source === 'first' ? first.gmailLabelId : second.gmailLabelId, T0);
    }
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), updateMask: { paths: ['mode'] }, requestId: op() });
    const original = await h.sql(`SELECT id, label_id, gmail_label_id FROM ledger ORDER BY id`);
    expect((await h.api.listLedgerEntries({ label: first.name })).ledgerEntries).toMatchObject([
      { name: 'ledgerEntries/a100000000000002', label: first.name, undoable: false },
      { name: 'ledgerEntries/a100000000000001', label: first.name, undoable: true },
    ]);
    expect(reasonOf(await rejection(h.api.undoLedgerEntry({ name: 'ledgerEntries/a100000000000002', requestId: op() })))).toBe('NOT_UNDOABLE');
    const request = { startTime: timestampFromMs(T0), endTime: timestampFromMs(T0 + 1000), label: first.name, requestId: op() };
    const result = await h.api.undoLedgerEntries(request);
    expect(result).toMatchObject({ undoneCount: 1, failedCount: 0, remainingCount: 0 });
    expect(await h.api.undoLedgerEntries(request)).toEqual(result);
    expect([...h.up.gmail.messages.get('a100000000000001')?.labelIds ?? []].sort()).toEqual(['INBOX', 'UNREAD']);
    expect([...h.up.gmail.messages.get('a100000000000002')?.labelIds ?? []].sort()).toEqual(['INBOX', first.gmailLabelId, 'UNREAD'].sort());
    expect(await h.sql(`SELECT id, label_id, gmail_label_id FROM ledger ORDER BY id`)).toEqual(original);
  });
});
