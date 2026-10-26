/** Explicit unread batches through the real owner API, SQLite, Alarm pipeline and independent Gmail fake. */
import { afterEach, expect, it } from 'vitest';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { Mode, UnreadClassification_State as State } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { DAY, MINUTE, op, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, decision, deliver, failModifies, gmailLabels, modifies, setMode } from './helpers.ts';

let h: Harness;
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });

async function ready(): Promise<void> {
  h = await startHarness();
  await h.step(T0);
  await setMode(h, Mode.LIVE);
  await h.api.initializePriorities({ requestId: op() });
  h.up.claude.bucket = 'P2';
}

const mail = (id: number, labels = ['INBOX', 'UNREAD']): SyntheticMail => ({ ...MAILS.bankEn, id: `abc${id.toString(16).padStart(13, '0')}`, labels });
const start = (requestId = op(), recheckFallback = false, recheckInitial100 = false) => h.api.startUnreadClassification({ name: 'unreadClassification', requestId, recheckFallback, recheckInitial100 });
const progress = async () => (await h.api.getServiceStatus({ name: 'serviceStatus' })).unreadClassification;

async function storedFallback(message: SyntheticMail, reason = 'low_confidence', at = T0 + MINUTE): Promise<void> {
  deliver(h, message, T0 - DAY);
  await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, top_label, decider, unsure_reason, current_labels)
    VALUES (?, ?, ?, ?, 'applied', 'p1', 'p2', 'clef', ?, '["p1"]')`, message.id, message.id, T0 - DAY, at, reason);
}

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
  for (const message of [archived, oldInbox, read, spam, trash]) deliver(h, message, T0 - 3 * DAY);
  await h.step(T0 + MINUTE);
  expect(await h.sql(`SELECT outcome FROM decisions WHERE message_id = ?`, oldInbox.id)).toEqual([{ outcome: 'skipped' }]);
  const original = new Map([read, spam, trash].map(message => [message.id, gmailLabels(h, message.id)]));
  h.up.claude.bucket = 'P1';
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
  expect(h.up.claude.calls).toHaveLength(0);
  expect(modifies(h)).toHaveLength(0);
});

it('skips already prioritized mail at a full daily cap and defers only eligible unclassified mail', async () => {
  await ready();
  const settings = await h.api.getSettings({ name: 'settings' });
  const graded = mail(1101, ['UNREAD', h.up.gmail.labelIdByName('P3') ?? '']);
  const unclassified = mail(1102);
  deliver(h, graded, T0 - DAY);
  deliver(h, unclassified, T0 - DAY);
  const original = gmailLabels(h, graded.id);
  await h.sql(`INSERT INTO usage (day, applied) VALUES ('2026-10-01', ?) ON CONFLICT (day) DO UPDATE SET applied = excluded.applied`, settings.dailyWriteLimit);
  await start();
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.RUNNING, totalCount: 2, skippedCount: 1, pendingCount: 1, deferredCount: 1, appliedCount: 0 });
  expect(await h.sql(`SELECT message_id, not_before FROM pending`)).toEqual([{ message_id: unclassified.id, not_before: T0 + DAY }]);
  expect(h.up.claude.calls).toEqual([]);
  expect(modifies(h)).toEqual([]);
  expect(gmailLabels(h, graded.id)).toEqual(original);
  expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).gmailWriteResumeTime).toEqual(timestampFromMs(T0 + DAY));
  expect(await h.api.getSettings({ name: 'settings' })).toEqual(settings);
});

it('reports the Gmail write resume time only when automatic and consolidation writes fill the current UTC day', async () => {
  await ready();
  const settings = await h.api.getSettings({ name: 'settings' });
  const status = () => h.api.getServiceStatus({ name: 'serviceStatus' });
  expect((await status()).gmailWriteResumeTime).toBeUndefined();
  await h.sql(`INSERT INTO usage (day, applied) VALUES ('2026-10-01', ?) ON CONFLICT (day) DO UPDATE SET applied = excluded.applied`, settings.dailyWriteLimit - 1);
  expect((await status()).gmailWriteResumeTime).toBeUndefined();
  await h.sql(`INSERT INTO meta (key, value) VALUES ('merge_writes', '{"day":"2026-10-01","count":1}')`);
  expect((await status()).gmailWriteResumeTime).toEqual(timestampFromMs(T0 + DAY));
  await h.clock(T0 + DAY);
  expect((await status()).gmailWriteResumeTime).toBeUndefined();
});

it('keeps an ordinary unread exclusion separate from rechecks even when an existing decision shares its start time', async () => {
  await ready();
  const graded = mail(1103, ['UNREAD', h.up.gmail.labelIdByName('P4') ?? '']);
  deliver(h, graded, T0 - DAY);
  await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, decider)
    VALUES (?, ?, ?, ?, 'applied', 'p4', 'claude')`, graded.id, graded.id, T0 - DAY, T0 + MINUTE);
  await h.clock(T0 + MINUTE);
  await start();
  await h.step(T0 + 2 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 1, skippedCount: 1, unchangedCount: 0, appliedCount: 0 });
  expect(h.up.claude.calls).toEqual([]);
  expect(modifies(h)).toEqual([]);
});

it('uses the remaining daily write allowance and resumes next day without changing caps or tripping the breaker', async () => {
  await ready();
  for (let i = 401; i <= 403; i++) deliver(h, mail(i), T0 - DAY);
  const before = await h.api.getSettings({ name: 'settings' });
  await h.sql(`INSERT INTO usage (day, applied) VALUES ('2026-10-01', ?) ON CONFLICT (day) DO UPDATE SET applied = excluded.applied`, before.dailyWriteLimit - 1);
  await start();
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.RUNNING, totalCount: 3, appliedCount: 1, pendingCount: 2, deferredCount: 0 });
  expect((await h.api.getSettings({ name: 'settings' })).breakerTripped).toBe(false);
  await h.step(T0 + DAY + MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, appliedCount: 3 });
  expect(await h.api.getSettings({ name: 'settings' })).toEqual(before);
});

it('waits in shadow and defers provider spend exhaustion until the next UTC month', async () => {
  await ready();
  deliver(h, mail(501), T0 - DAY);
  deliver(h, mail(502), T0 - DAY);
  await start();
  await setMode(h, Mode.SHADOW);
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ state: State.RUNNING, pendingCount: 2, appliedCount: 0 });
  expect(h.up.claude.calls).toHaveLength(0);
  await setMode(h, Mode.LIVE);
  h.up.claude.spendLimit = true;
  await h.step(T0 + 6 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.RUNNING, pendingCount: 2, deferredCount: 2 });
  expect(h.up.claude.calls).toHaveLength(1);
  h.up.claude.spendLimit = false;
  await h.step(T0 + DAY);
  expect(h.up.claude.calls).toHaveLength(1);
  await h.step(Date.parse('2026-11-01T00:00:00Z'));
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

it('keeps normal unread batches unchanged and rechecks only the current unconfirmed fallback P1 cohort', async () => {
  await ready();
  const p1 = h.up.gmail.labelIdByName('P1') ?? '';
  const eligible = [mail(701, ['INBOX', 'UNREAD', p1]), mail(702, ['INBOX', 'UNREAD', p1]), mail(703, ['INBOX', 'UNREAD', p1])];
  for (const [index, message] of eligible.entries()) await storedFallback(message, ['low_confidence', 'views_disagree', 'no_match'][index]);
  await storedFallback(mail(704, ['INBOX', 'UNREAD', p1]), '');
  await storedFallback(mail(705, ['INBOX', 'UNREAD', p1]), 'low_confidence', T0 - 1);
  await storedFallback(mail(706, ['INBOX', 'UNREAD', p1]));
  await h.sql(`UPDATE decisions SET verdict = 'confirmed', verdict_source = 'review', verdict_label = 'p1' WHERE message_id = ?`, mail(706).id);
  await storedFallback(mail(707, ['INBOX', 'UNREAD', p1]));
  await h.sql(`UPDATE decisions SET verdict = 'corrected', verdict_source = 'gmail', verdict_label = NULL WHERE message_id = ?`, mail(707).id);
  await storedFallback(mail(708, ['INBOX', 'UNREAD', p1]), 'model_unavailable');
  await storedFallback(mail(709, ['INBOX', 'UNREAD', p1]));
  await h.sql(`UPDATE decisions SET label_id = 'p2' WHERE message_id = ?`, mail(709).id);

  await start();
  await h.step(T0 + 2 * MINUTE);
  await h.step(T0 + 3 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 9, skippedCount: 9 });
  expect(h.up.claude.calls).toHaveLength(0);
  h.up.claude.bucket = 'P3';
  await start(op(), true);
  await h.step(T0 + 4 * MINUTE);
  expect(await h.sql(`SELECT message_id FROM unread_batch ORDER BY message_id`)).toEqual(eligible.map(message => ({ message_id: message.id })));
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 3, appliedCount: 3, failedCount: 0 });
  expect(h.up.claude.calls).toHaveLength(1);
});

it.each([false, true])('refreshes a historical fallback P1 without a Gmail write or false applied count, legacyCase=%s', async () => {
  await ready();
  const p1 = h.up.gmail.labelIdByName('P1') ?? '';
  const other = h.up.gmail.createUserLabel('Personal');
  const message = mail(711, ['INBOX', 'UNREAD', 'STARRED', other]);
  deliver(h, message, T0 + MINUTE);
  h.up.claude.bucket = 'P1';
  await h.step(T0 + 2 * MINUTE);
  const originalLedger = await h.sql(`SELECT id, state, superseded FROM ledger WHERE message_id = ?`, message.id);
  expect(originalLedger).toHaveLength(1);
  expect(originalLedger[0]).toMatchObject({ state: 'applied', superseded: 0 });
  h.up.gmail.ownerModify(message.id, [], ['INBOX']);
  const before = gmailLabels(h, message.id);
  await h.sql(`UPDATE decisions SET top_label = 'p2', unsure_reason = 'low_confidence' WHERE message_id = ?`, message.id);
  const modelCalls = h.up.claude.calls.length;
  h.up.claude.bucket = 'P1';

  await start(op(), true);
  await h.step(T0 + 3 * MINUTE);

  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 1, skippedCount: 0, unchangedCount: 1, appliedCount: 0, failedCount: 0 });
  expect(await decision(h, message.id)).toMatchObject({ outcome: 'applied', label_id: 'p1', top_label: 'p1', unsure_reason: '', current_labels: '["p1"]', decided_at: T0 + 3 * MINUTE });
  expect(await h.sql(`SELECT id, state, superseded FROM ledger WHERE message_id = ?`, message.id)).toEqual(originalLedger);
  expect(await h.sql(`SELECT n FROM flow WHERE outcome IN ('archived', 'kept_in_inbox')`)).toEqual([{ n: 1 }]);
  expect(modifies(h)).toHaveLength(1);
  expect(gmailLabels(h, message.id)).toEqual(before);
  expect(gmailLabels(h, message.id)).toContain(p1);
  expect(h.up.claude.calls.slice(modelCalls)).toHaveLength(1);
});

it.each([false, true])('supersedes the original P1 ledger only after P3 applies and restores the recheck preimage on undo, retry=%s', async retry => {
  await ready();
  const p1 = h.up.gmail.labelIdByName('P1') ?? '';
  const p3 = h.up.gmail.labelIdByName('P3') ?? '';
  const other = h.up.gmail.createUserLabel('Personal');
  const message = mail(721, ['INBOX', 'UNREAD', 'STARRED', other]);
  deliver(h, message, T0 + MINUTE);
  h.up.claude.bucket = 'P1';
  await h.step(T0 + 2 * MINUTE);
  await h.sql(`UPDATE decisions SET top_label = 'p2', unsure_reason = 'low_confidence' WHERE message_id = ?`, message.id);
  const oldRows = await h.sql<{ id: string }>(`SELECT id FROM ledger WHERE message_id = ? AND label_id = 'p1'`, message.id);
  const oldName = `ledgerEntries/${oldRows[0]?.id ?? ''}`;
  expect((await h.api.getLedgerEntry({ name: oldName })).undoable).toBe(true);
  const before = gmailLabels(h, message.id);
  expect(before).toContain(p1);
  h.up.claude.bucket = 'P3';
  const failing = retry ? failModifies(h, 503) : null;

  await start(op(), true);
  await h.step(T0 + 3 * MINUTE);
  if (failing !== null) {
    expect(await progress()).toMatchObject({ pendingCount: 1, appliedCount: 0 });
    expect((await h.api.getLedgerEntry({ name: oldName })).undoable).toBe(true);
    expect(gmailLabels(h, message.id)).toEqual(before);
    failing.off();
    await h.step(T0 + 4 * MINUTE);
  }

  expect(gmailLabels(h, message.id)).toEqual(['UNREAD', 'STARRED', p3, other].sort());
  expect(await progress()).toMatchObject({ totalCount: 1, appliedCount: 1, skippedCount: 0, failedCount: 0 });
  const rows = await h.sql<{ id: string; base_inbox: number; state: string; superseded: number }>(`SELECT id, base_inbox, state, superseded FROM ledger WHERE message_id = ? AND label_id = 'p3'`, message.id);
  expect(rows[0]).toMatchObject({ base_inbox: 1, state: 'applied', superseded: 0 });
  expect((await h.api.getLedgerEntry({ name: oldName })).undoable).toBe(false);
  const writes = modifies(h).length;
  await expect(h.api.undoLedgerEntry({ name: oldName, requestId: op() })).rejects.toThrow();
  expect(modifies(h)).toHaveLength(writes);
  expect(gmailLabels(h, message.id)).toEqual(['UNREAD', 'STARRED', p3, other].sort());
  await h.api.undoLedgerEntry({ name: `ledgerEntries/${rows[0]?.id ?? ''}`, requestId: op() });
  expect(gmailLabels(h, message.id)).toEqual(before);
});

it('skips a collected fallback when the owner reads it, changes its priority or records a verdict', async () => {
  await ready();
  const p1 = h.up.gmail.labelIdByName('P1') ?? '';
  const p2 = h.up.gmail.labelIdByName('P2') ?? '';
  const messages = [731, 732, 733, 734].map(id => mail(id, ['INBOX', 'UNREAD', p1]));
  for (const message of messages) await storedFallback(message);
  await start(op(), true);
  await setMode(h, Mode.SHADOW);
  await h.step(T0 + 2 * MINUTE);
  expect(await progress()).toMatchObject({ totalCount: 4, pendingCount: 4 });
  h.up.gmail.ownerModify(mail(731).id, [], ['UNREAD']);
  h.up.gmail.ownerModify(mail(732).id, [p2], [p1]);
  h.up.gmail.ownerModify(mail(733).id, [], [p1]);
  await h.sql(`UPDATE decisions SET verdict = 'confirmed', verdict_source = 'review', verdict_label = 'p1' WHERE message_id = ?`, mail(734).id);
  const before = messages.map(message => gmailLabels(h, message.id));
  await setMode(h, Mode.LIVE);
  await h.step(T0 + 8 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 4, skippedCount: 4, appliedCount: 0, failedCount: 0 });
  expect(h.up.claude.calls).toHaveLength(0);
  expect(modifies(h)).toHaveLength(0);
  expect(messages.map(message => gmailLabels(h, message.id))).toEqual(before);
});

it('rechecks the original 100 successful identities without substituting a later 101st message after evidence refresh or undo', async () => {
  await ready();
  const p4 = h.up.gmail.labelIdByName('P4') ?? '';
  const originals = Array.from({ length: 100 }, (_, index) => mail(800 + index, ['UNREAD', p4]));
  const later = mail(900, ['UNREAD', p4]);
  for (const [index, message] of [...originals, later].entries()) {
    deliver(h, message, T0 - DAY);
    await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, top_label, decider, current_labels)
      VALUES (?, ?, ?, ?, 'applied', 'p4', 'p4', 'clef', '["p4"]')`, message.id, message.id, T0 - DAY, T0 + (102 - index) * MINUTE);
    await h.sql(`INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time, apply_time)
      VALUES (?, ?, 'p4', ?, 1, 'auto', ?, ?, ?)`, `original-${String(index)}`, message.id, p4, index === 0 ? 'undone' : 'applied', T0 + index, T0 + index);
  }
  await h.sql(`INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time, apply_time)
    VALUES ('later-reapply', ?, 'p4', ?, 1, 'auto', 'applied', ?, ?)`, originals[0]?.id ?? '', p4, T0 + DAY, T0 + DAY);
  h.up.claude.bucket = 'P4';
  await start(op(), false, true);
  const selected = await h.sql(`SELECT message_id FROM unread_batch ORDER BY message_id`);
  expect(selected).toEqual(originals.map(message => ({ message_id: message.id })));
  await setMode(h, Mode.SHADOW);
  await h.step(T0 + MINUTE);
  expect(await progress()).toMatchObject({ totalCount: 100, pendingCount: 100, appliedCount: 0 });
  expect(h.up.claude.calls).toHaveLength(0);
  await setMode(h, Mode.LIVE);
  for (let pass = 6; pass <= 23; pass++) await h.step(T0 + pass * MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 100, skippedCount: 0, unchangedCount: 100, appliedCount: 0, failedCount: 0 });
  expect(h.up.claude.calls.flat()).toHaveLength(100);
  expect(modifies(h)).toHaveLength(0);
  expect(h.up.gmail.calls.filter(call => new URL(call.url).pathname.endsWith('/messages'))).toHaveLength(0);
  await start(op(), false, true);
  expect(await h.sql(`SELECT message_id FROM unread_batch ORDER BY message_id`)).toEqual(selected);
  expect(await h.sql(`SELECT message_id FROM unread_batch WHERE message_id = ?`, later.id)).toEqual([]);
});

it('rejects conflicting recheck scopes without consuming the request ID or starting a batch', async () => {
  await ready();
  const id = op();
  await expect(start(id, true, true)).rejects.toThrow();
  expect(await progress()).toBeUndefined();
  expect(await h.sql(`SELECT message_id FROM unread_batch`)).toEqual([]);
  const initial = await start(id, false, true);
  expect(initial).toMatchObject({ state: State.COMPLETED, totalCount: 0 });
  expect(await start(id, false, true)).toEqual(initial);
  await expect(start(id)).rejects.toThrow();
  expect(modifies(h)).toHaveLength(0);
});

it('refreshes a same-P4 result without undoing the owner read or Inbox position and without another Gmail intent', async () => {
  await ready();
  const other = h.up.gmail.createUserLabel('Personal');
  const message = mail(911, ['INBOX', 'UNREAD', 'STARRED', other]);
  deliver(h, message, T0 + MINUTE);
  h.up.claude.bucket = 'P4';
  await h.step(T0 + 2 * MINUTE);
  h.up.gmail.ownerModify(message.id, ['INBOX'], ['UNREAD']);
  const before = gmailLabels(h, message.id);
  const ledger = await h.sql(`SELECT id, state, superseded FROM ledger WHERE message_id = ?`, message.id);
  await start(op(), false, true);
  await h.step(T0 + 3 * MINUTE);
  expect(await progress()).toMatchObject({ totalCount: 1, skippedCount: 0, unchangedCount: 1, appliedCount: 0, failedCount: 0 });
  expect(await decision(h, message.id)).toMatchObject({ label_id: 'p4', outcome: 'applied', current_labels: '["p4"]', decided_at: T0 + 3 * MINUTE });
  expect(await h.sql(`SELECT id, state, superseded FROM ledger WHERE message_id = ?`, message.id)).toEqual(ledger);
  expect(gmailLabels(h, message.id)).toEqual(before);
  expect(modifies(h)).toHaveLength(1);
});

it('rechecks read mail but skips owner priority changes, explicit verdicts, Spam and Trash in the original cohort', async () => {
  await ready();
  const p4 = h.up.gmail.labelIdByName('P4') ?? '';
  const p3 = h.up.gmail.labelIdByName('P3') ?? '';
  const messages = Array.from({ length: 6 }, (_, index) => mail(921 + index));
  for (const message of messages) deliver(h, message, T0 + MINUTE);
  h.up.claude.bucket = 'P4';
  await h.step(T0 + 2 * MINUTE);
  expect(modifies(h)).toHaveLength(6);
  h.up.gmail.ownerModify(mail(921).id, [], ['UNREAD']);
  h.up.gmail.ownerModify(mail(922).id, [p3], [p4]);
  h.up.gmail.ownerModify(mail(923).id, [p3], []);
  await h.sql(`UPDATE decisions SET verdict = 'confirmed', verdict_source = 'review', verdict_label = 'p4' WHERE message_id = ?`, mail(924).id);
  h.up.gmail.ownerModify(mail(925).id, ['SPAM'], []);
  h.up.gmail.ownerModify(mail(926).id, ['TRASH'], []);
  const unchanged = messages.slice(1).map(message => gmailLabels(h, message.id));
  const calls = h.up.claude.calls.length;
  h.up.claude.bucket = 'P2';
  await h.clock(T0 + 3 * MINUTE);
  await start(op(), false, true);
  await h.step(T0 + 3 * MINUTE);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, totalCount: 6, appliedCount: 1, skippedCount: 5, unchangedCount: 0, failedCount: 0 });
  expect(h.up.claude.calls.slice(calls).flat().map(item => item.id)).toEqual([mail(921).id]);
  expect(gmailLabels(h, mail(921).id)).toEqual([h.up.gmail.labelIdByName('P2') ?? '']);
  expect(messages.slice(1).map(message => gmailLabels(h, message.id))).toEqual(unchanged);
});

it.each([['p2', true, false], ['p1', false, true]] as const)('replaces P4 with %s while preserving read state and latest undo, unread=%s retry=%s', async (target, unread, retry) => {
  await ready();
  const p4 = h.up.gmail.labelIdByName('P4') ?? '';
  const other = h.up.gmail.createUserLabel('Personal');
  const message = mail(931, ['INBOX', 'UNREAD', 'STARRED', other]);
  deliver(h, message, T0 + MINUTE);
  h.up.claude.bucket = 'P4';
  await h.step(T0 + 2 * MINUTE);
  if (!unread) h.up.gmail.ownerModify(message.id, [], ['UNREAD']);
  const before = gmailLabels(h, message.id);
  const old = (await h.api.listLedgerEntries({})).ledgerEntries[0];
  expect(old?.undoable).toBe(true);
  h.up.claude.bucket = target.toUpperCase() as 'P1' | 'P2';
  const failing = retry ? failModifies(h, 503) : null;
  await start(op(), false, true);
  await h.step(T0 + 3 * MINUTE);
  if (failing !== null) {
    expect((await h.api.getLedgerEntry({ name: old?.name ?? '' })).undoable).toBe(true);
    expect(gmailLabels(h, message.id)).toEqual(before);
    failing.off();
    await h.step(T0 + 4 * MINUTE);
  }
  const targetId = h.up.gmail.labelIdByName(target.toUpperCase()) ?? '';
  expect(gmailLabels(h, message.id)).toEqual(['STARRED', other, targetId, ...(unread ? ['UNREAD'] : []), ...(target === 'p1' ? ['INBOX'] : [])].sort());
  expect((await h.api.getLedgerEntry({ name: old?.name ?? '' })).undoable).toBe(false);
  const latest = (await h.api.listLedgerEntries({})).ledgerEntries.find(row => row.name !== old?.name);
  expect(latest?.undoable).toBe(true);
  await h.api.undoLedgerEntry({ name: latest?.name ?? '', requestId: op() });
  expect(gmailLabels(h, message.id)).toEqual(before);
  expect(gmailLabels(h, message.id)).toContain(p4);
});


it('preserves historical decision evidence when a requested fallback recheck exhausts invalid-response retries', async () => {
  await ready();
  const p1 = h.up.gmail.labelIdByName('P1') ?? '';
  const input = mail(950, ['INBOX', 'UNREAD', p1]);
  await storedFallback(input);
  const before = await decision(h, input.id);
  const labels = gmailLabels(h, input.id);
  h.up.claude.badItems = true;
  await start(op(), true);
  let now = T0 + 2 * MINUTE;
  for (let attempt = 0; attempt < 3; attempt++) {
    await h.step(now);
    const pending = (await h.sql<{ not_before: number }>(`SELECT not_before FROM pending WHERE message_id = ?`, input.id))[0];
    if (pending !== undefined) now = pending.not_before;
  }
  expect(await decision(h, input.id)).toEqual(before);
  expect(await progress()).toMatchObject({ state: State.COMPLETED, failedCount: 1, appliedCount: 0 });
  expect(gmailLabels(h, input.id)).toEqual(labels);
  expect(modifies(h)).toEqual([]);
});
