/** Explicit unread batches through the real owner API, SQLite, Alarm pipeline and independent Gmail fake. */
import { afterEach, expect, it } from 'vitest';
import { Mode, UnreadClassification_State as State } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { DAY, MINUTE, op, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, clefCalls, deliver, failModifies, gmailLabels, modifies, setMode } from './helpers.ts';

let h: Harness;
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });

async function ready(): Promise<void> {
  h = await startHarness();
  await h.step(T0);
  await setMode(h, Mode.LIVE);
  await h.api.initializePriorities({ requestId: op() });
  h.up.ai.choiceOverride = () => ({ p2: 0.92, none: 0.08 });
}

const mail = (id: number, labels = ['INBOX', 'UNREAD']): SyntheticMail => ({ ...MAILS.bankEn, id: `abc${id.toString(16).padStart(13, '0')}`, labels });
const start = (requestId = op()) => h.api.startUnreadClassification({ name: 'unreadClassification', requestId });
const progress = async () => (await h.api.getServiceStatus({ name: 'serviceStatus' })).unreadClassification;

it('collects every page before modifying the collection, resumes a failed page, and labels all 103 old unread messages', async () => {
  await ready();
  for (let i = 1; i <= 103; i++) deliver(h, mail(i), T0 - 30 * DAY);
  const id = op();
  const first = await start(id);
  expect(await start(id)).toEqual(first);
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.SCANNING, totalCount: 100 });
  expect(modifies(h)).toHaveLength(0);
  h.up.gmail.failWhen = (method, url) => method === 'GET' && url.pathname.endsWith('/messages') && url.searchParams.has('pageToken') ? 503 : null;
  await h.step(T0 + 2 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.SCANNING, totalCount: 100 });
  const inProgress = await start();
  expect(inProgress.startedTime).toEqual(first.startedTime);
  h.up.gmail.failWhen = null;
  for (let pass = 3; pass <= 22; pass++) await h.step(T0 + pass * MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 103, appliedCount: 103, pendingCount: 0, failedCount: 0 });
  expect(modifies(h)).toHaveLength(103);
  for (const message of h.up.gmail.messages.values()) {
    expect(message.labelIds.has('UNREAD')).toBe(true);
    expect(message.labelIds.has('INBOX')).toBe(false);
    expect(message.labelIds.has(h.up.gmail.labelIdByName('P2') ?? '')).toBe(true);
  }
});

it('includes archived unread and old skipped decisions, leaves read mail alone, and preserves unrelated state', async () => {
  await ready();
  const own = h.up.gmail.createUserLabel('Personal');
  const archived = mail(201, ['UNREAD', 'STARRED', own]);
  const oldInbox = mail(202, ['INBOX', 'UNREAD', own]);
  const read = mail(203, ['INBOX']);
  const spam = mail(204, ['UNREAD', 'SPAM']);
  const trash = mail(205, ['UNREAD', 'TRASH']);
  for (const message of [archived, oldInbox, read, spam, trash]) deliver(h, message, T0 - DAY);
  await h.step(T0 + MINUTE);
  expect(await h.sql(`SELECT outcome FROM decisions WHERE message_id = ?`, oldInbox.id)).toEqual([{ outcome: 'skipped' }]);
  const original = new Map([read, spam, trash].map(message => [message.id, gmailLabels(h, message.id)]));
  h.up.ai.choiceOverride = () => ({ p1: 0.92, none: 0.08 });
  await start();
  await h.step(T0 + 2 * MINUTE);
  const p1 = h.up.gmail.labelIdByName('P1');
  expect(gmailLabels(h, archived.id)).toEqual(['INBOX', 'UNREAD', 'STARRED', own, p1].sort());
  expect(gmailLabels(h, oldInbox.id)).toEqual(['INBOX', 'UNREAD', own, p1].sort());
  for (const [id, before] of original) expect(gmailLabels(h, id)).toEqual(before);
  expect(await progress()).toMatchObject({ totalCount: 2, appliedCount: 2, failedCount: 0 });
  const rows = await h.sql<{ id: string }>(`SELECT id FROM ledger WHERE message_id = ?`, archived.id);
  await h.api.undoLedgerEntry({ name: `ledgerEntries/${rows[0]?.id ?? ''}`, requestId: op() });
  expect(gmailLabels(h, archived.id)).toEqual(['UNREAD', 'STARRED', own].sort());
});

it('does not spend model allowance on already graded or no-longer-unread messages', async () => {
  await ready();
  const graded = mail(301, ['UNREAD', h.up.gmail.labelIdByName('P3') ?? '']);
  const changed = mail(302);
  deliver(h, graded, T0 - DAY);
  deliver(h, changed, T0 - DAY);
  await start();
  h.up.gmail.afterCall = (method, url) => {
    if (method === 'GET' && url.pathname.endsWith('/messages') && url.searchParams.get('labelIds') === 'UNREAD') h.up.gmail.ownerModify(changed.id, [], ['UNREAD']);
  };
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 2, appliedCount: 0, skippedCount: 2 });
  expect(clefCalls(h)).toHaveLength(0);
  expect(modifies(h)).toHaveLength(0);
});

it('uses the remaining daily write allowance and resumes next day without changing caps or tripping the breaker', async () => {
  await ready();
  for (let i = 401; i <= 403; i++) deliver(h, mail(i), T0 - DAY);
  const before = await h.api.getSettings({ name: 'settings' });
  await h.sql(`INSERT INTO usage (day, applied) VALUES ('2026-10-01', ?) ON CONFLICT (day) DO UPDATE SET applied = excluded.applied`, before.dailyWriteLimit - 1);
  await start();
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.RUNNING, totalCount: 3, appliedCount: 1, pendingCount: 2, deferredCount: 2 });
  expect((await h.api.getSettings({ name: 'settings' })).breakerTripped).toBe(false);
  await h.step(T0 + DAY + MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, appliedCount: 3 });
  expect(await h.api.getSettings({ name: 'settings' })).toEqual(before);
});

it('waits in shadow without consuming the batch, switches at 70%, and defers quota until the next UTC day', async () => {
  await ready();
  deliver(h, mail(501), T0 - DAY);
  deliver(h, mail(502), T0 - DAY);
  await start();
  await setMode(h, Mode.SHADOW);
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.RUNNING, pendingCount: 2, appliedCount: 0 });
  expect(clefCalls(h)).toHaveLength(0);
  await setMode(h, Mode.LIVE);
  await h.sql(`INSERT INTO usage (day, neurons) VALUES ('2026-10-01', 7000) ON CONFLICT (day) DO UPDATE SET neurons = 7000`);
  h.up.ai.quota = true;
  await h.step(T0 + 6 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.RUNNING, pendingCount: 2, deferredCount: 2 });
  expect(h.up.ai.calls[0]?.model).toContain('clef-flash');
  const calls = h.up.ai.calls.length;
  await h.step(T0 + 7 * MINUTE);
  expect(h.up.ai.calls).toHaveLength(calls);
  h.up.ai.quota = false;
  await h.step(T0 + DAY + MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, appliedCount: 2 });
});

it('keeps a persisted Gmail retry pending and counts a terminal failure separately from success', async () => {
  await ready();
  deliver(h, mail(601, ['UNREAD']), T0 - DAY);
  const failing = failModifies(h, 503);
  await start();
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.RUNNING, pendingCount: 1, appliedCount: 0, failedCount: 0 });
  failing.off();
  await setMode(h, Mode.SHADOW);
  await h.step(T0 + 2 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.RUNNING, pendingCount: 1, appliedCount: 0, failedCount: 0 });
  expect(await h.sql(`SELECT state FROM ledger WHERE message_id = ?`, mail(601).id)).toEqual([{ state: 'intended' }]);
  await setMode(h, Mode.LIVE);
  const settings = await h.api.getSettings({ name: 'settings' });
  await h.sql(`UPDATE usage SET applied = ? WHERE day = '2026-10-01'`, settings.dailyWriteLimit);
  await h.step(T0 + 3 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.RUNNING, pendingCount: 1, failedCount: 0 });
  expect((await h.api.getSettings({ name: 'settings' })).breakerTripped).toBe(false);
  await h.step(T0 + DAY + MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, appliedCount: 1 });
  deliver(h, mail(602), T0 - DAY);
  h.up.gmail.failWhen = (method, url) => method === 'POST' && url.pathname.endsWith('/modify') ? 403 : null;
  await start();
  await h.step(T0 + DAY + 2 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 2, appliedCount: 0, skippedCount: 1, failedCount: 1 });
});

it('does not start a batch under an inactive mode and handles an empty unread list', async () => {
  await ready();
  await setMode(h, Mode.SHADOW);
  await expect(start()).rejects.toThrow();
  expect(await progress()).toBeUndefined();
  await setMode(h, Mode.LIVE);
  await start();
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 0, appliedCount: 0 });
});
