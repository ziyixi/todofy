/** Normal recent-mail intake uses real SQLite, synthetic Gmail and the existing classifier/write gates. */
import { afterEach, expect, it } from 'vitest';
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { PRIORITY_LABELS } from '../../src/priority.ts';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { ORIGINAL_URL_HEADER } from '../fakes/upstream.ts';
import { DAY, MINUTE, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, decision, deliver, gmailLabels, modifies, setMode } from './helpers.ts';

let h: Harness;
async function ready(): Promise<void> {
  h = await startHarness();
  for (const [i, label] of PRIORITY_LABELS.entries()) {
    const gmail = h.up.gmail.createUserLabel(label.displayName, true);
    await h.sql(`INSERT INTO labels (id, seq, display_name, description, enabled, gmail_id, gmail_state, keep_in_inbox, create_time, update_time, etag)
      VALUES (?, ?, ?, ?, 1, ?, 'linked', ?, ?, ?, 'e')`, label.id, i + 1, label.displayName, label.description, gmail, label.keepInInbox ? 1 : 0, T0, T0);
  }
  await h.sql(`INSERT INTO meta (key, value) VALUES ('priority_started_at', ?)`, String(T0));
  await h.step(T0);
  await setMode(h, Mode.LIVE);
  await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
}
const mail = (i: number, labels = ['INBOX', 'UNREAD']): SyntheticMail => ({ ...MAILS.bankEn, id: `eed${i.toString(16).padStart(13, '0')}`, labels });
const inputs = () => h.up.claude.calls.flat().map(item => item.id);
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });

it('classifies mail opened before sync or while queued, preserving read, stars and unrelated labels', async () => {
  await ready();
  const callsBefore = h.up.gmail.calls.length;
  const own = h.up.gmail.createUserLabel('Personal');
  const opened = { ...mail(1, ['INBOX', 'STARRED', own]), threadId: 'eed0000000000000' };
  const queued = { ...mail(2, ['INBOX', 'UNREAD', 'STARRED', own]), threadId: opened.threadId };
  await h.sql(`UPDATE meta SET value = ? WHERE key = 'next_model_at'`, String(T0 + 15 * MINUTE));
  deliver(h, opened, T0 + MINUTE);
  deliver(h, queued, T0 + MINUTE);
  await h.step(T0 + 2 * MINUTE);
  expect(await h.sql(`SELECT count(*) AS n FROM pending`)).toEqual([{ n: 2 }]);
  expect(h.up.claude.calls).toHaveLength(0);
  expect(h.up.gmail.calls.slice(callsBefore).filter(call => new URL(call.url).pathname.endsWith('/messages'))).toHaveLength(0);
  h.up.gmail.ownerModify(queued.id, [], ['UNREAD']);
  await h.step(T0 + 15 * MINUTE);
  expect(inputs()).toEqual([opened.id, queued.id]);
  const priority = h.up.gmail.labelIdByName('P2');
  expect(gmailLabels(h, opened.id)).toEqual(['STARRED', own, priority].sort());
  expect(gmailLabels(h, queued.id)).toEqual(['STARRED', own, priority].sort());
});

it('recovers consumed-history recent mail and an old read skip without reopening prior model decisions', async () => {
  await ready();
  const missed = mail(11, ['INBOX']);
  const skipped = mail(12, ['INBOX']);
  const preInstallSkip = mail(16, ['INBOX']);
  for (const input of [missed, skipped, mail(13), mail(14), mail(15)]) deliver(h, input, T0 + MINUTE);
  deliver(h, preInstallSkip, T0 - MINUTE);
  await h.sql(`UPDATE meta SET value = ? WHERE key = 'history_cursor'`, String(h.up.gmail.historyId));
  await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, unsure_reason)
    VALUES (?, ?, ?, ?, 'skipped', 'skip', 'not_inbox')`, skipped.id, skipped.id, T0 + MINUTE, T0 + 2 * MINUTE);
  await h.sql(`INSERT INTO flow (day, stage, outcome, label, n) VALUES ('2026-10-01', 'skipped', 'not_inbox', '', 1)`);
  await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, unsure_reason)
    VALUES (?, ?, ?, ?, 'skipped', 'skip', 'before_install')`, preInstallSkip.id, preInstallSkip.id, T0 - MINUTE, T0 + 2 * MINUTE);
  await h.sql(`INSERT INTO flow (day, stage, outcome, label, n) VALUES ('2026-10-01', 'skipped', 'before_install', '', 1)`);
  for (const [id, outcome] of [[13, 'suggested'], [14, 'applied'], [15, 'unsure']] as const) {
    await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, label_id)
      VALUES (?, ?, ?, ?, ?, 'claude', ?)`, mail(id).id, mail(id).id, T0 + MINUTE, T0 + 2 * MINUTE, outcome, outcome === 'unsure' ? null : 'p2');
  }
  await h.step(T0 + 3 * MINUTE);
  expect(inputs()).toEqual([missed.id, skipped.id, preInstallSkip.id]);
  expect(await decision(h, skipped.id)).toMatchObject({ outcome: 'applied', label_id: 'p2' });
  expect(await h.sql(`SELECT n FROM flow WHERE stage = 'skipped' AND outcome = 'not_inbox'`)).toEqual([{ n: 0 }]);
  expect(await h.sql(`SELECT n FROM flow WHERE stage = 'skipped' AND outcome = 'before_install'`)).toEqual([{ n: 0 }]);
  expect(await h.sql(`SELECT message_id, outcome FROM decisions WHERE message_id IN (?, ?, ?) ORDER BY message_id`, mail(13).id, mail(14).id, mail(15).id))
    .toEqual([{ message_id: mail(13).id, outcome: 'suggested' }, { message_id: mail(14).id, outcome: 'applied' }, { message_id: mail(15).id, outcome: 'unsure' }]);
  await h.step(T0 + 18 * MINUTE);
  expect(inputs()).toEqual([missed.id, skipped.id, preInstallSkip.id]);
  expect(modifies(h)).toHaveLength(3);
});

it('recovers recent read and unread model failures once without reopening valid decisions or owner verdicts', async () => {
  await ready();
  await h.sql(`DELETE FROM meta WHERE key = 'optional_accounting_recovery'`);
  const own = h.up.gmail.createUserLabel('Personal');
  const read = mail(51, ['INBOX', 'STARRED', own]);
  const unread = mail(52, ['INBOX', 'UNREAD', 'STARRED', own]);
  for (const input of [read, unread, mail(53), mail(54), mail(55), mail(56), mail(57)]) deliver(h, input, T0 + MINUTE);
  for (const input of [read, unread, mail(55), mail(56), mail(57)]) {
    await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, unsure_reason)
      VALUES (?, ?, ?, ?, 'unsure', 'none', 'model_unavailable')`, input.id, input.id, T0 + MINUTE, T0 + 2 * MINUTE);
  }
  for (const [id, outcome] of [[53, 'suggested'], [54, 'applied']] as const) {
    await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, label_id)
      VALUES (?, ?, ?, ?, ?, 'claude', 'p2')`, mail(id).id, mail(id).id, T0 + MINUTE, T0 + 2 * MINUTE, outcome);
  }
  await h.sql(`UPDATE decisions SET verdict = 'corrected', verdict_label = 'p1', verdict_source = 'owner' WHERE message_id = ?`, mail(55).id);
  await h.sql(`UPDATE decisions SET unsure_reason = 'historical_uncertainty' WHERE message_id = ?`, mail(56).id);
  await h.sql(`UPDATE decisions SET label_id = 'p1' WHERE message_id = ?`, mail(57).id);
  const frozen = await h.sql(`SELECT * FROM decisions WHERE message_id NOT IN (?, ?) ORDER BY message_id`, read.id, unread.id);
  await h.sql(`UPDATE meta SET value = ? WHERE key = 'history_cursor'`, String(h.up.gmail.historyId));
  expect(await h.step(T0 + 3 * MINUTE)).toMatchObject({ decided: 2, applied: 2 });
  expect(inputs()).toEqual([read.id, unread.id]);
  const priority = h.up.gmail.labelIdByName('P2');
  expect(gmailLabels(h, read.id)).toEqual(['STARRED', own, priority].sort());
  expect(gmailLabels(h, unread.id)).toEqual(['UNREAD', 'STARRED', own, priority].sort());
  for (const input of [read, unread]) expect(await decision(h, input.id)).toMatchObject({ outcome: 'applied', label_id: 'p2', decider: 'claude' });
  expect(await h.sql(`SELECT * FROM decisions WHERE message_id NOT IN (?, ?) ORDER BY message_id`, read.id, unread.id)).toEqual(frozen);
  expect(await h.sql(`SELECT value FROM meta WHERE key = 'optional_accounting_recovery'`)).toEqual([{ value: String(T0 + 3 * MINUTE) }]);
});

it('preserves pending backoff during recovery and does not revive future model failures', async () => {
  await ready();
  await h.sql(`DELETE FROM meta WHERE key = 'optional_accounting_recovery'`);
  const waiting = mail(61, ['INBOX']);
  deliver(h, waiting, T0 + MINUTE);
  await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, unsure_reason)
    VALUES (?, ?, ?, ?, 'unsure', 'none', 'model_unavailable')`, waiting.id, waiting.id, T0 + MINUTE, T0 + 2 * MINUTE);
  await h.sql(`INSERT INTO pending (message_id, added_at, attempts, not_before) VALUES (?, ?, 2, ?)`, waiting.id, T0 + MINUTE, T0 + 20 * MINUTE);
  const pending = await h.sql(`SELECT * FROM pending`);
  const prior = await decision(h, waiting.id);
  await h.step(T0 + 3 * MINUTE);
  expect(await h.sql(`SELECT * FROM pending`)).toEqual(pending);
  expect(await decision(h, waiting.id)).toEqual(prior);
  expect(inputs()).toEqual([]);
  const later = mail(62, ['INBOX', 'UNREAD']);
  deliver(h, later, T0 + 4 * MINUTE);
  await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, unsure_reason)
    VALUES (?, ?, ?, ?, 'unsure', 'none', 'model_unavailable')`, later.id, later.id, T0 + 4 * MINUTE, T0 + 4 * MINUTE);
  await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
  await h.step(T0 + 5 * MINUTE);
  expect(await h.sql(`SELECT * FROM pending`)).toEqual(pending);
  await h.step(T0 + 20 * MINUTE);
  await h.step(T0 + 35 * MINUTE);
  expect(inputs()).toEqual([waiting.id]);
  expect(await decision(h, later.id)).toMatchObject({ outcome: 'unsure', decider: 'none', unsure_reason: 'model_unavailable' });
  expect(gmailLabels(h, later.id)).toEqual(['INBOX', 'UNREAD']);
  expect(await h.sql(`SELECT count(*) AS n FROM pending`)).toEqual([{ n: 0 }]);
  expect(await h.sql(`SELECT value FROM meta WHERE key = 'optional_accounting_recovery'`)).toEqual([{ value: String(T0 + 3 * MINUTE) }]);
});

it('waits for filtered normal catch-up to complete recovery after a history resync', async () => {
  await ready();
  await h.sql(`DELETE FROM meta WHERE key = 'optional_accounting_recovery'`);
  const input = mail(71, ['INBOX']);
  deliver(h, input, T0 + MINUTE);
  await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, unsure_reason)
    VALUES (?, ?, ?, ?, 'unsure', 'none', 'model_unavailable')`, input.id, input.id, T0 + MINUTE, T0 + 2 * MINUTE);
  await h.sql(`UPDATE meta SET value = ? WHERE key = 'next_model_at'`, String(T0 + 15 * MINUTE));
  h.up.gmail.oldestHistoryId = h.up.gmail.historyId + 1;
  await h.step(T0 + 3 * MINUTE);
  expect(await h.sql(`SELECT value FROM meta WHERE key = 'optional_accounting_recovery'`)).toEqual([]);
  expect(await h.sql(`SELECT count(*) AS n FROM pending`)).toEqual([{ n: 0 }]);
  expect(inputs()).toEqual([]);
  h.up.gmail.oldestHistoryId = 0;
  expect(await h.step(T0 + 15 * MINUTE)).toMatchObject({ decided: 1, applied: 1 });
  expect(inputs()).toEqual([input.id]);
  expect(await h.sql(`SELECT value FROM meta WHERE key = 'optional_accounting_recovery'`)).toEqual([{ value: String(T0 + 15 * MINUTE) }]);
});

it('uses the existing Inbox and priority checks when recovered mail changes after listing', async () => {
  await ready();
  await h.sql(`DELETE FROM meta WHERE key = 'optional_accounting_recovery'`);
  const archived = mail(81, ['INBOX']);
  const graded = mail(82, ['INBOX', 'UNREAD']);
  for (const input of [archived, graded]) {
    deliver(h, input, T0 + MINUTE);
    await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, unsure_reason)
      VALUES (?, ?, ?, ?, 'unsure', 'none', 'model_unavailable')`, input.id, input.id, T0 + MINUTE, T0 + 2 * MINUTE);
  }
  const prior = await h.sql(`SELECT * FROM decisions ORDER BY message_id`);
  const priority = h.up.gmail.labelIdByName('P1') ?? '';
  let changed = false;
  h.up.gmail.afterCall = (method, url) => {
    if (!changed && method === 'GET' && url.pathname.endsWith('/messages') && url.searchParams.get('q')?.includes('-label:P1')) {
      changed = true;
      h.up.gmail.ownerModify(archived.id, [], ['INBOX']);
      h.up.gmail.ownerModify(graded.id, [priority], []);
    }
  };
  await h.step(T0 + 3 * MINUTE);
  expect(changed).toBe(true);
  expect(inputs()).toEqual([]);
  expect(modifies(h)).toEqual([]);
  expect(await h.sql(`SELECT count(*) AS n FROM pending`)).toEqual([{ n: 0 }]);
  expect(await h.sql(`SELECT * FROM decisions ORDER BY message_id`)).toEqual(prior);
  expect(gmailLabels(h, archived.id)).toEqual([]);
  expect(gmailLabels(h, graded.id)).toEqual(['INBOX', 'UNREAD', priority].sort());
});

it('rejects intake outside the 48-hour window or with unknown dates and excludes archived or already graded mail', async () => {
  await ready();
  const at = T0 + 3 * DAY;
  const old = mail(21, ['INBOX']);
  const unknown = mail(22, ['INBOX']);
  const invalid = mail(23, ['INBOX']);
  const archived = mail(24, ['STARRED']);
  const graded = mail(25, ['INBOX', h.up.gmail.labelIdByName('P1') ?? '']);
  const before = mail(26, ['INBOX']);
  deliver(h, old, T0 + MINUTE);
  for (const input of [unknown, invalid, archived, graded]) deliver(h, input, at - MINUTE);
  deliver(h, before, T0 - MINUTE);
  const handle = h.up.handle.bind(h.up);
  h.up.handle = async request => {
    const response = await handle(request);
    const url = new URL(request.headers.get(ORIGINAL_URL_HEADER) ?? request.url);
    if (url.pathname.endsWith(`/messages/${unknown.id}`) || url.pathname.endsWith(`/messages/${invalid.id}`)) {
      const value = await response.json<Record<string, unknown>>();
      if (url.pathname.endsWith(unknown.id)) delete value['internalDate'];
      else value['internalDate'] = 'not-a-date';
      return Response.json(value);
    }
    return response;
  };
  await h.step(at);
  expect(inputs()).toEqual([]);
  expect(modifies(h)).toEqual([]);
  expect(await decision(h, old.id)).toMatchObject({ outcome: 'skipped', unsure_reason: 'outside_recent_window' });
  expect(await decision(h, before.id)).toMatchObject({ outcome: 'skipped', unsure_reason: 'outside_recent_window' });
  for (const id of [unknown.id, invalid.id]) expect(await decision(h, id)).toMatchObject({ outcome: 'skipped', unsure_reason: 'unreadable', received_at: 0 });
  expect(await decision(h, archived.id)).toBeUndefined();
  expect(await decision(h, graded.id)).toBeUndefined();
  expect(gmailLabels(h, archived.id)).toEqual(['STARRED']);
  expect(gmailLabels(h, graded.id)).toEqual(graded.labels?.slice().sort());
});

it('keeps accepted recent mail across provider holds and repeated reconciliation preserves its deadline', async () => {
  await ready();
  const accepted = mail(31, ['INBOX']);
  deliver(h, accepted, T0 + MINUTE);
  h.up.claude.spendLimit = true;
  await h.step(T0 + 2 * MINUTE);
  const november = Date.parse('2026-11-01T00:00:00Z');
  const pending = await h.sql(`SELECT added_at, attempts, not_before FROM pending`);
  expect(pending).toEqual([{ added_at: T0 + 2 * MINUTE, attempts: 0, not_before: november }]);
  await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
  await h.sql(`DELETE FROM meta WHERE key = 'claude_limited_month'`);
  h.up.claude.spendLimit = false;
  await h.step(T0 + 3 * MINUTE);
  expect(await h.sql(`SELECT added_at, attempts, not_before FROM pending`)).toEqual(pending);
  expect(h.up.claude.calls).toHaveLength(1);
  await h.step(november);
  expect(inputs()).toEqual([accepted.id, accepted.id]);
  expect(await decision(h, accepted.id)).toMatchObject({ outcome: 'applied', label_id: 'p2' });
  expect(modifies(h)).toHaveLength(1);
});

it('reconciles an existing pending message without resetting its failed-attempt backoff', async () => {
  await ready();
  const retry = mail(32, ['INBOX']);
  deliver(h, retry, T0 + MINUTE);
  h.up.claude.badItems = true;
  await h.step(T0 + 2 * MINUTE);
  const pending = await h.sql(`SELECT added_at, attempts, not_before FROM pending`);
  expect(pending).toEqual([{ added_at: T0 + 2 * MINUTE, attempts: 1, not_before: T0 + 7 * MINUTE }]);
  await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
  h.up.claude.badItems = false;
  await h.step(T0 + 3 * MINUTE);
  expect(await h.sql(`SELECT added_at, attempts, not_before FROM pending`)).toEqual(pending);
  expect(h.up.claude.calls).toHaveLength(1);
  await h.step(T0 + 7 * MINUTE);
  expect(await decision(h, retry.id)).toMatchObject({ outcome: 'applied', label_id: 'p2' });
  expect(modifies(h)).toHaveLength(1);
});

it('classifies existing recent read Inbox mail when initializing its history cursor', async () => {
  await ready();
  deliver(h, mail(41, ['INBOX']), T0 - MINUTE);
  await h.sql(`DELETE FROM meta WHERE key = 'history_cursor'`);
  await h.step(T0 + MINUTE);
  expect(inputs()).toEqual([mail(41).id]);
  expect(modifies(h)).toHaveLength(1);
  expect(await decision(h, mail(41).id)).toMatchObject({ outcome: 'applied', label_id: 'p2' });
});

it('skips an Inbox copy of the owner\'s own sent mail once and never lists it again', async () => {
  await ready();
  const sent = mail(31, ['INBOX', 'SENT']);
  const incoming = mail(32, ['INBOX']);
  deliver(h, sent, T0 + MINUTE);
  deliver(h, incoming, T0 + MINUTE);
  await h.sql(`UPDATE meta SET value = ? WHERE key = 'history_cursor'`, String(h.up.gmail.historyId));
  await h.step(T0 + 2 * MINUTE);
  expect(inputs()).toEqual([incoming.id]);
  expect(await decision(h, sent.id)).toBeUndefined();
  await h.step(T0 + 20 * MINUTE);
  expect(inputs()).toEqual([incoming.id]);
  expect(await h.sql(`SELECT count(*) AS n FROM pending`)).toEqual([{ n: 0 }]);
  expect(await decision(h, sent.id)).toBeUndefined();
  expect(gmailLabels(h, sent.id)).toEqual(['INBOX', 'SENT']);
});
