import { afterEach, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { LabelSchema } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { message } from '../fakes/fixtures.ts';
import { checkGoogleCalls, gmailLabels, setMode } from './helpers.ts';
import { op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => { await h.dispose(); });

async function legacy(id: string, name: string): Promise<string> {
  await h.api.createLabel({ labelId: id, label: create(LabelSchema, { displayName: name, description: 'Old topic', enabled: true }), requestId: op() });
  const gmailId = h.up.gmail.createUserLabel(name);
  await h.sql(`UPDATE labels SET gmail_id = ?, gmail_state = 'linked' WHERE id = ?`, gmailId, id);
  return gmailId;
}

it('removes all managed topic identities while preserving mail, status, unrelated labels and frozen history', async () => {
  h = await startHarness();
  const first = await legacy('finance', 'Finance');
  const hidden = await legacy('old-finance', 'Old Finance');
  await h.sql(`INSERT INTO label_aliases (source_id, target_id) VALUES ('old-finance', 'finance')`);
  const personal = h.up.gmail.createUserLabel('Personal');
  h.up.gmail.deliver(message({ id: 'aa000001', from: 'sender@example.net', subject: 'Synthetic inbox', text: 'Unchanged body', receivedAt: T0 - 1000, labels: ['INBOX', 'UNREAD', 'STARRED', first, personal] }));
  h.up.gmail.deliver(message({ id: 'aa000002', from: 'sender@example.net', subject: 'Synthetic archived', text: 'Also unchanged', receivedAt: T0 - 1000, labels: ['UNREAD', hidden, personal] }));
  const bodies = [...h.up.gmail.messages.values()].map(mail => mail.payload);
  await h.sql(`INSERT INTO examples (id, label_id, summary, origin, create_time) VALUES ('old-example', 'finance', 'Old topic sample', 'correction', ?)`, T0 - 1000);
  await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, decider) VALUES ('aa000002', 'thread-old', ?, ?, 'applied', 'finance', 'model')`, T0 - 1000, T0 - 1000);
  await setMode(h, Mode.LIVE);
  const requestId = op();
  const result = await h.api.initializePriorities({ requestId });
  expect(result.completed).toBe(true);
  expect(result.removedLabelCount).toBe(2);
  expect(result.labels.map(label => [label.name, label.displayName, label.keepInInbox])).toEqual([
    ['labels/p1', 'P1', true], ['labels/p2', 'P2', false], ['labels/p3', 'P3', false], ['labels/p4', 'P4', false],
  ]);
  expect(h.up.gmail.labels.has(first)).toBe(false);
  expect(h.up.gmail.labels.has(hidden)).toBe(false);
  expect(h.up.gmail.labels.has(personal)).toBe(true);
  expect(h.up.gmail.messages.size).toBe(2);
  expect(gmailLabels(h, 'aa000001')).toEqual(['INBOX', 'STARRED', 'UNREAD', personal].sort());
  expect(gmailLabels(h, 'aa000002')).toEqual(['UNREAD', personal].sort());
  expect([...h.up.gmail.messages.values()].map(mail => mail.payload)).toEqual(bodies);
  expect(await h.sql(`SELECT message_id, label_id FROM decisions`)).toEqual([{ message_id: 'aa000002', label_id: 'finance' }]);
  expect(await h.sql(`SELECT count(*) AS n FROM examples`)).toEqual([{ n: 0 }]);
  expect(await h.sql(`SELECT count(*) AS n FROM label_aliases`)).toEqual([{ n: 0 }]);
  expect(h.up.ai.calls).toEqual([]);
  const calls = h.up.gmail.calls.length;
  expect(await h.api.initializePriorities({ requestId })).toEqual(result);
  expect(await h.api.initializePriorities({ requestId: op() })).toEqual(result);
  expect(h.up.gmail.calls.length).toBe(calls);
  checkGoogleCalls(h);
});

it('continues one frozen setup after a failed delete without touching other mail or labels', async () => {
  h = await startHarness();
  const first = await legacy('first', 'First');
  const second = await legacy('second', 'Second');
  await setMode(h, Mode.LIVE);
  let failed = false;
  h.up.gmail.failWhen = (method, url) => {
    if (!failed && method === 'DELETE' && url.pathname.endsWith(`/${second}`)) { failed = true; return 503; }
    return null;
  };
  const requestId = op();
  await rejection(h.api.initializePriorities({ requestId }));
  expect(h.up.gmail.labels.has(first)).toBe(false);
  expect(h.up.gmail.labels.has(second)).toBe(true);
  expect(await h.sql(`SELECT value FROM meta WHERE key = 'priority_started_at'`)).toEqual([]);
  const result = await h.api.initializePriorities({ requestId });
  expect(result.completed).toBe(true);
  expect(result.removedLabelCount).toBe(2);
  expect(h.up.gmail.calls.filter(call => call.method === 'DELETE' && call.url.endsWith(`/${first}`))).toHaveLength(1);
  checkGoogleCalls(h);
});

it('refuses external priority names before deleting anything, and preserves the owner mode', async () => {
  h = await startHarness();
  const old = await legacy('old', 'Old Topic');
  const external = h.up.gmail.createUserLabel('P1');
  const before = await h.api.getSettings({ name: 'settings' });
  expect(reasonOf(await rejection(h.api.initializePriorities({ requestId: op() })))).toBe('LABEL_EXISTS');
  expect(h.up.gmail.labels.has(old)).toBe(true);
  expect(h.up.gmail.labels.has(external)).toBe(true);
  expect(h.up.gmail.calls.some(call => call.method === 'DELETE')).toBe(false);
  expect((await h.api.getSettings({ name: 'settings' })).mode).toBe(before.mode);
});

it('checks the label snapshot again after the asynchronous preflight and before the first deletion', async () => {
  h = await startHarness();
  const old = await legacy('old', 'Old Topic');
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const original = h.up.handle.bind(h.up);
  h.up.handle = async request => {
    if (new URL(request.url).pathname.endsWith('/profile')) { entered.resolve(undefined); await release.promise; }
    return original(request);
  };
  const initializing = h.api.initializePriorities({ requestId: op() });
  await entered.promise;
  await legacy('another', 'Another Topic');
  release.resolve(undefined);
  expect(reasonOf(await rejection(initializing))).toBe('ETAG_MISMATCH');
  expect(h.up.gmail.labels.has(old)).toBe(true);
  expect(h.up.gmail.calls.some(call => call.method === 'DELETE')).toBe(false);
  expect(await h.sql(`SELECT value FROM meta WHERE key = 'priority_setup'`)).toEqual([]);
});

it('keeps an established history cursor so mail arriving during setup is classified afterward', async () => {
  h = await startHarness();
  await h.step(T0);
  const baseline = await h.sql(`SELECT value FROM meta WHERE key = 'history_cursor'`);
  let delivered = false;
  h.up.gmail.afterCall = (method, url) => {
    if (!delivered && method === 'GET' && url.pathname.endsWith('/labels')) {
      delivered = true;
      h.up.gmail.deliver(message({ id: 'ab000001', from: 'sender@example.net', subject: 'Synthetic ordinary notice', text: 'No action needed.', receivedAt: T0 + 1000 }));
    }
  };
  await setMode(h, Mode.LIVE);
  expect((await h.api.initializePriorities({ requestId: op() })).completed).toBe(true);
  expect(await h.sql(`SELECT value FROM meta WHERE key = 'history_cursor'`)).toEqual(baseline);
  const pass = await h.step(T0 + 2000);
  expect(pass.decided).toBe(1);
  const rows = await h.sql<{ label_id: string; outcome: string }>(`SELECT label_id, outcome FROM decisions WHERE message_id = 'ab000001'`);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.outcome).toBe('applied');
  expect(['p1', 'p2', 'p3', 'p4']).toContain(rows[0]?.label_id);
});
