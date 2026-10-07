/**
 * The pipeline when things go wrong, in workerd with a real SQLite MailsortState and the fakes
 * (../../../docs/design.md §3, §4, §7): a write left for a retry never goes out once live is no longer in force (the
 * owner's shadow, the breaker, the MODE ceiling, the label's switch), retries count against the run cap, a breaker
 * tripped by a pass's own write stops the rest of that pass, one unreadable mail never holds up the queue, a deleted
 * label's entries are refused before any intent, the resync's read order, a model outage backs off per mail, one
 * label per conversation follows the labels a thread carries now, a resync never sorts mail from before the install,
 * a retry never labels mail the owner filed in the meantime, and the 14-day content cleanup runs while the mode is off.
 * After every test, every request Google got is checked against the independent table.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v1/status_pb';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { DAY, HOUR, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { addLabels, checkGoogleCalls, decision, deliver, failModifies, gmailLabels, modifies, setLabelLive, setMode } from './helpers.ts';

async function ledgerOf(h: Harness, id: string): Promise<Record<string, unknown>[]> {
  return h.sql(`SELECT state, origin, last_code FROM ledger WHERE message_id = ? ORDER BY id`, id);
}

async function pendingReview(h: Harness, id: string): Promise<Record<string, unknown>[]> {
  return h.sql(`SELECT kind, suggested_label FROM review WHERE message_id = ? AND state = 'pending'`, id);
}

describe('a write left for a retry goes out only while live is in force', () => {
  let h: Harness;
  let now = T0;
  beforeAll(async () => {
    h = await startHarness();
    await addLabels(h, ['newsletter']);
    await setMode(h, Mode.LIVE);
    await h.step(now);
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    checkGoogleCalls(h);
  });

  /** A live decision whose modify Gmail answered 503: its ledger row stays `intended` for the next pass. */
  async function leaveIntended(id: string): Promise<void> {
    const failing = failModifies(h, 503);
    deliver(h, { ...MAILS.newsletterEn, id, subject: `Weekly digest ${id}` }, now);
    now += 5 * MINUTE;
    await h.step(now);
    failing.off();
    expect(await ledgerOf(h, id)).toEqual([{ state: 'intended', origin: 'auto', last_code: 'message_modify_503' }]);
  }

  /** The next pass sends no modify: the row fails with `code`, and the mail is a suggestion in the review queue. */
  async function nextPassWritesNothing(id: string, code: string): Promise<void> {
    const before = modifies(h).length;
    now += 5 * MINUTE;
    await h.step(now);
    expect(modifies(h).length).toBe(before);
    expect(gmailLabels(h, id)).toContain('INBOX');
    expect(await ledgerOf(h, id)).toEqual([{ state: 'failed', origin: 'auto', last_code: code }]);
    expect(await decision(h, id)).toMatchObject({ outcome: 'suggested', label_id: 'newsletter' });
    expect(await pendingReview(h, id)).toEqual([{ kind: 'suggestion', suggested_label: 'newsletter' }]);
  }

  it('the owner chose shadow', async () => {
    await leaveIntended('a1000000000000a1');
    await setMode(h, Mode.SHADOW);
    await nextPassWritesNothing('a1000000000000a1', 'mode_changed');
    await setMode(h, Mode.LIVE);
  });

  it('the breaker tripped', async () => {
    await leaveIntended('a1000000000000a2');
    await h.sql(`UPDATE meta SET value = json_set(value, '$.breaker', 'label_share') WHERE key = 'settings'`);
    await nextPassWritesNothing('a1000000000000a2', 'mode_changed');
    await setMode(h, Mode.LIVE);
  });

  it('the label left live', async () => {
    await leaveIntended('a1000000000000a3');
    await setLabelLive(h, 'newsletter', false);
    await nextPassWritesNothing('a1000000000000a3', 'label_not_live');
    await setLabelLive(h, 'newsletter', true);
  });

  /** The retry's modifies and label reads after `before` calls. */
  const callsSince = (before: number) => h.up.gmail.calls.slice(before).map((call) => `${call.method} ${new URL(call.url).pathname.split('/').slice(-2).join('/')}`);

  it('the owner archived the mail and filed it under a label of their own meanwhile: the retry writes nothing', async () => {
    const id = 'a1000000000000a4';
    await leaveIntended(id);
    const work = h.up.gmail.createUserLabel('Work');
    h.up.gmail.ownerModify(id, [work], ['INBOX']);
    const before = h.up.gmail.calls.length;
    now += 5 * MINUTE;
    await h.step(now);
    // One metadata read of the mail, and no modify.
    expect(callsSince(before).filter((call) => call.includes(id))).toEqual([`GET messages/${id}`]);
    expect(gmailLabels(h, id)).toEqual([work, 'CATEGORY_UPDATES', 'UNREAD'].sort());
    expect(await ledgerOf(h, id)).toEqual([{ state: 'failed', origin: 'auto', last_code: 'mail_changed' }]);
    expect(await decision(h, id)).toMatchObject({ outcome: 'suggested', label_id: 'newsletter' });
  });

  it('the owner only archived it: the retry writes nothing', async () => {
    const id = 'a1000000000000a5';
    await leaveIntended(id);
    h.up.gmail.ownerModify(id, [], ['INBOX']);
    const before = modifies(h).length;
    now += 5 * MINUTE;
    await h.step(now);
    expect(modifies(h).length).toBe(before);
    expect(gmailLabels(h, id)).not.toContain('INBOX');
    expect(await ledgerOf(h, id)).toEqual([{ state: 'failed', origin: 'auto', last_code: 'mail_changed' }]);
  });

  it('a user label the mail already had when it was decided does not stop the retry', async () => {
    const id = 'a1000000000000a6';
    const filtered = h.up.gmail.createUserLabel('From a filter');
    const failing = failModifies(h, 503);
    deliver(h, { ...MAILS.newsletterEn, id, subject: `Weekly digest ${id}`, labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES', filtered] }, now);
    now += 5 * MINUTE;
    await h.step(now);
    failing.off();
    expect(await ledgerOf(h, id)).toEqual([{ state: 'intended', origin: 'auto', last_code: 'message_modify_503' }]);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await ledgerOf(h, id)).toEqual([{ state: 'applied', origin: 'auto', last_code: null }]);
    const labels = gmailLabels(h, id);
    expect(labels).toContain(filtered);
    expect(labels).toContain('UNREAD');
    expect(labels).not.toContain('INBOX');
  });

  it('the owner turned the label’s 归档 off meanwhile: the retry only adds the label (QA D5)', async () => {
    const id = 'a1000000000000a7';
    await leaveIntended(id);
    expect(await h.sql(`SELECT archived FROM ledger WHERE message_id = ?`, id)).toEqual([{ archived: 1 }]);
    const flowOf = async (outcome: string) => Number((await h.sql(`SELECT coalesce(sum(n), 0) AS n FROM flow WHERE label = 'newsletter' AND outcome = ?`, outcome))[0]?.['n'] ?? 0);
    const [archivedBefore, keptBefore] = [await flowOf('archived'), await flowOf('kept_in_inbox')];
    const keep = async (on: boolean) => {
      const label = await h.api.getLabel({ name: 'labels/newsletter' });
      await h.api.updateLabel({ label: { ...label, keepInInbox: on }, updateMask: { paths: ['keep_in_inbox'] }, requestId: op() });
    };
    await keep(true);
    now += 5 * MINUTE;
    await h.step(now);
    const labels = gmailLabels(h, id);
    expect(labels).toContain('INBOX');
    expect(labels).toContain('UNREAD');
    expect(labels.some((item) => item.startsWith('Label_'))).toBe(true);
    expect(await h.sql(`SELECT state, archived FROM ledger WHERE message_id = ?`, id)).toEqual([{ state: 'applied', archived: 0 }]);
    // The flow counts the write as kept in the inbox now, not archived.
    expect([await flowOf('archived'), await flowOf('kept_in_inbox')]).toEqual([archivedBefore - 1, keptBefore + 1]);
    // An undo then gives nothing back to the inbox (it never left).
    const [entry] = (await h.api.listLedgerEntries({ label: 'labels/newsletter' })).ledgerEntries.filter((item) => item.messageId === id);
    expect(entry).toMatchObject({ archived: false });
    await keep(false);
  });

  it('a row that keeps never starts archiving when the label’s 归档 is turned on', async () => {
    const id = 'a1000000000000a8';
    const label = await h.api.getLabel({ name: 'labels/newsletter' });
    await h.api.updateLabel({ label: { ...label, keepInInbox: true }, updateMask: { paths: ['keep_in_inbox'] }, requestId: op() });
    const failing = failModifies(h, 503);
    deliver(h, { ...MAILS.newsletterEn, id, subject: `Weekly digest ${id}` }, now);
    now += 5 * MINUTE;
    await h.step(now);
    failing.off();
    expect(await h.sql(`SELECT state, archived FROM ledger WHERE message_id = ?`, id)).toEqual([{ state: 'intended', archived: 0 }]);
    const again = await h.api.getLabel({ name: 'labels/newsletter' });
    await h.api.updateLabel({ label: { ...again, keepInInbox: false }, updateMask: { paths: ['keep_in_inbox'] }, requestId: op() });
    now += 5 * MINUTE;
    await h.step(now);
    expect(await h.sql(`SELECT state, archived FROM ledger WHERE message_id = ?`, id)).toEqual([{ state: 'applied', archived: 0 }]);
    expect(gmailLabels(h, id)).toContain('INBOX');
  });

  it('a retry counts against the run cap like a new write', async () => {
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', runWriteLimit: 1 }), updateMask: { paths: ['run_write_limit'] }, requestId: op() });
    const failing = failModifies(h, 503);
    deliver(h, { ...MAILS.newsletterEn, id: 'a1000000000000b1', subject: 'Weekly digest b1' }, now);
    deliver(h, { ...MAILS.newsletterEn, id: 'a1000000000000b2', subject: 'Weekly digest b2' }, now);
    now += 5 * MINUTE;
    // The 503 stops the pass: b1 is left intended, b2 still pending.
    await h.step(now);
    failing.off();
    const before = modifies(h).length;
    now += 5 * MINUTE;
    await h.step(now);
    expect(modifies(h).length - before).toBe(1);
    expect(await ledgerOf(h, 'a1000000000000b1')).toEqual([{ state: 'applied', origin: 'auto', last_code: null }]);
    expect(await ledgerOf(h, 'a1000000000000b2')).toEqual([{ state: 'failed', origin: 'auto', last_code: 'run_limit' }]);
    expect(gmailLabels(h, 'a1000000000000b2')).toContain('INBOX');
    expect(await h.api.getSettings({ name: 'settings' })).toMatchObject({ breakerTripped: true, breakerReason: 'run_limit', effectiveMode: Mode.SHADOW });
  });

  it('a non-mode save keeps the breaker; choosing the mode again clears it', async () => {
    const kept = await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', runWriteLimit: 10 }), updateMask: { paths: ['run_write_limit'] }, requestId: op() });
    expect(kept).toMatchObject({ breakerTripped: true, breakerReason: 'run_limit', effectiveMode: Mode.SHADOW, runWriteLimit: 10 });
    const cleared = await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), updateMask: { paths: ['mode'] }, requestId: op() });
    expect(cleared).toMatchObject({ breakerTripped: false, effectiveMode: Mode.LIVE });
  });
});

describe('the MODE ceiling stops a write left for a retry', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ bindings: { MODE: 'shadow' } });
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    checkGoogleCalls(h);
  });

  it('MAILSORT_MODE=shadow: the owner’s live is lowered, and no leftover row reaches Gmail', async () => {
    await addLabels(h, ['newsletter']);
    await setMode(h, Mode.LIVE);
    await h.step(T0);
    const gmailId = h.up.gmail.createUserLabel('订阅', true);
    await h.api.syncLabels({ requestId: op() });
    deliver(h, MAILS.newsletterEn, T0);
    await h.step(T0 + 5 * MINUTE);
    expect(await decision(h, MAILS.newsletterEn.id)).toMatchObject({ outcome: 'suggested' });
    // A row an earlier deployment (with MODE=live) left intended.
    await h.sql(`UPDATE decisions SET outcome = 'applied' WHERE message_id = ?`, MAILS.newsletterEn.id);
    await h.sql(`DELETE FROM review`);
    await h.sql(
      `INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time) VALUES ('t0000000000-leftover', ?, 'newsletter', ?, 1, 'auto', 'intended', ?)`,
      MAILS.newsletterEn.id,
      gmailId,
      T0,
    );
    await h.step(T0 + 10 * MINUTE);
    expect(modifies(h)).toEqual([]);
    expect(await ledgerOf(h, MAILS.newsletterEn.id)).toEqual([{ state: 'failed', origin: 'auto', last_code: 'mode_changed' }]);
    expect(await pendingReview(h, MAILS.newsletterEn.id)).toEqual([{ kind: 'suggestion', suggested_label: 'newsletter' }]);
  });
});

describe('a breaker tripped by a pass’s own write stops the rest of that pass', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    checkGoogleCalls(h);
  });

  it('the label-share rule trips on the first write; the next mails of the pass stay in the inbox', async () => {
    await addLabels(h, ['newsletter']);
    await setMode(h, Mode.LIVE);
    await h.step(T0);
    // A week of writes to another label, and 14 newsletter writes today: the next newsletter write makes 15.
    for (let i = 0; i < 30; i++) {
      await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, decider) VALUES (?, ?, 0, ?, 'applied', 'receipt', 'clef')`, `w${String(i)}`, `tw${String(i)}`, T0 - 2 * DAY);
    }
    for (let i = 0; i < 14; i++) {
      await h.sql(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, decider) VALUES (?, ?, 0, ?, 'applied', 'newsletter', 'clef')`, `d${String(i)}`, `td${String(i)}`, T0 + MINUTE);
    }
    const ids = ['a2000000000000a1', 'a2000000000000a2', 'a2000000000000a3'];
    for (const id of ids) deliver(h, { ...MAILS.newsletterEn, id, subject: `Weekly digest ${id}` }, T0 + 2 * MINUTE);
    await h.step(T0 + 5 * MINUTE);
    expect(modifies(h).length).toBe(1);
    expect(await h.api.getSettings({ name: 'settings' })).toMatchObject({ breakerTripped: true, breakerReason: 'label_share' });
    expect(await decision(h, ids[0] ?? '')).toMatchObject({ outcome: 'applied' });
    for (const id of ids.slice(1)) {
      expect(await decision(h, id)).toMatchObject({ outcome: 'suggested' });
      expect(gmailLabels(h, id)).toContain('INBOX');
    }
  });
});

describe('one unreadable mail never holds up the queue', () => {
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
    h.up.gmail.failWhen = null;
    checkGoogleCalls(h);
  });

  const failRead = (id: string, status: number) => {
    h.up.gmail.failWhen = (method, url) => (method === 'GET' && url.pathname.endsWith(`/messages/${id}`) ? status : null);
  };

  it('a 400 skips the mail at once and decides the one behind it', async () => {
    failRead('b0000000000000b1', 400);
    deliver(h, { ...MAILS.unsure, id: 'b0000000000000b1' }, now);
    deliver(h, { ...MAILS.receiptEn, id: 'b0000000000000b2' }, now + 1000);
    now += 5 * MINUTE;
    const pass = await h.step(now);
    expect(pass.code).toBe('ok');
    expect(await decision(h, 'b0000000000000b1')).toMatchObject({ outcome: 'skipped', unsure_reason: 'unreadable' });
    expect(await decision(h, 'b0000000000000b2')).toMatchObject({ label_id: 'receipt' });
  });

  it('a lasting 500 backs the mail off, decides the next one, and skips it after its tries', async () => {
    const poison = 'b1000000000000b1';
    failRead(poison, 500);
    deliver(h, { ...MAILS.unsure, id: poison }, now);
    deliver(h, { ...MAILS.travelZh, id: 'b1000000000000b2' }, now + 1000);
    now += 5 * MINUTE;
    expect((await h.step(now)).code).toBe('message_get_500');
    expect(await h.sql(`SELECT attempts, not_before FROM pending WHERE message_id = ?`, poison)).toEqual([{ attempts: 1, not_before: now + 5 * MINUTE }]);
    now += 30_000;
    await h.step(now);
    expect(await decision(h, 'b1000000000000b2')).toMatchObject({ label_id: 'travel' });
    for (let i = 0; i < 12 && (await decision(h, poison)) === undefined; i++) {
      const [row] = await h.sql<{ not_before: number }>(`SELECT not_before FROM pending WHERE message_id = ?`, poison);
      now = Math.max(now + 5 * MINUTE, row?.not_before ?? 0);
      await h.step(now);
    }
    expect(await decision(h, poison)).toMatchObject({ outcome: 'skipped', unsure_reason: 'unreadable' });
    expect(h.up.gmail.calls.filter((call) => call.url.includes(`/messages/${poison}`)).length).toBe(7);
  });

  it('a history record with an ID the guard would refuse is never queued', async () => {
    deliver(h, { ...MAILS.unsure, id: 'not-a-gmail-id' }, now);
    deliver(h, { ...MAILS.receiptZh, id: 'b2000000000000b2' }, now);
    now += 5 * MINUTE;
    expect((await h.step(now)).code).toBe('ok');
    expect(await h.sql(`SELECT message_id FROM pending`)).toEqual([]);
    expect(await decision(h, 'b2000000000000b2')).toMatchObject({ label_id: 'receipt' });
    expect(h.up.gmail.calls.some((call) => call.url.includes('not-a-gmail-id'))).toBe(false);
  });
});

describe('ledger entries whose label is no longer owned', () => {
  let h: Harness;
  let now = T0;
  beforeAll(async () => {
    h = await startHarness();
    await addLabels(h, ['newsletter', 'receipt']);
    await setMode(h, Mode.LIVE);
    await h.step(now);
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    checkGoogleCalls(h);
  });

  it('a deleted label: its entries are refused before any intent, and the pipeline goes on', async () => {
    deliver(h, MAILS.newsletterEn, now);
    now += 5 * MINUTE;
    await h.step(now);
    const [entry] = (await h.api.listLedgerEntries({})).ledgerEntries;
    expect(entry).toMatchObject({ undoable: true, subject: 'Your weekly digest: 5 new posts', sender: 'Weekly Digest <news.example.com>' });
    const label = await h.api.getLabel({ name: 'labels/newsletter' });
    await h.api.deleteLabel({ name: 'labels/newsletter', etag: label.etag, requestId: op() });
    expect((await h.api.listLedgerEntries({})).ledgerEntries[0]).toMatchObject({ undoable: false });
    expect(reasonOf(await rejection(h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() })))).toBe('NOT_UNDOABLE');
    expect(await ledgerOf(h, MAILS.newsletterEn.id)).toEqual([{ state: 'applied', origin: 'auto', last_code: null }]);
    const range = await h.api.undoLedgerEntries({ startTime: timestampFromMs(T0 - DAY), endTime: timestampFromMs(T0 + DAY), requestId: op() });
    expect(range).toMatchObject({ undoneCount: 0, remainingCount: 0 });
    deliver(h, MAILS.unsure, now);
    now += 5 * MINUTE;
    const pass = await h.step(now);
    expect(pass).toMatchObject({ code: 'ok', decided: 1 });
  });

  it('an undo the guard refuses (the label went missing) is permanent for that row only', async () => {
    deliver(h, MAILS.receiptEn, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await ledgerOf(h, MAILS.receiptEn.id)).toEqual([{ state: 'applied', origin: 'auto', last_code: null }]);
    await h.sql(`UPDATE ledger SET state = 'undo_intended' WHERE message_id = ?`, MAILS.receiptEn.id);
    await h.sql(`UPDATE labels SET gmail_state = 'missing' WHERE id = 'receipt'`);
    const before = modifies(h).length;
    deliver(h, { ...MAILS.travelZh }, now);
    now += 5 * MINUTE;
    const pass = await h.step(now);
    expect(pass).toMatchObject({ code: 'ok', decided: 1 });
    expect(modifies(h).length).toBe(before);
    expect(await ledgerOf(h, MAILS.receiptEn.id)).toEqual([{ state: 'applied', origin: 'auto', last_code: 'guard_refused' }]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).recentErrorCodes).toContain('gmail_guard_refused');
  });
});

describe('sync, the model and conversations', () => {
  let h: Harness;
  let now = T0;
  beforeAll(async () => {
    h = await startHarness();
    await addLabels(h, ['receipt']);
    deliver(h, { ...MAILS.receiptEn, id: 'c0000000000000c0', subject: 'Receipt from before the install' }, T0 - HOUR);
    await h.step(now);
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    h.up.gmail.afterCall = null;
    h.up.gmail.oldestHistoryId = 0;
    h.up.ai.broken = false;
    checkGoogleCalls(h);
  });

  it('a lost cursor’s resync never sorts mail from before the install', async () => {
    deliver(h, { ...MAILS.travelZh, id: 'c0000000000000c1' }, now);
    h.up.gmail.oldestHistoryId = h.up.gmail.historyId + 1;
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, 'c0000000000000c0')).toMatchObject({ outcome: 'skipped', unsure_reason: 'before_install' });
    expect(await decision(h, 'c0000000000000c1')).toMatchObject({ label_id: 'travel' });
    expect(JSON.stringify(h.up.ai.calls)).not.toContain('Receipt from before the install');
  });

  it('a mail that arrives between the resync’s two reads is still sorted', async () => {
    let injected = false;
    h.up.gmail.afterCall = (method, url) => {
      if (!injected && method === 'GET' && url.pathname.endsWith('/messages') && url.searchParams.get('labelIds') === 'INBOX') {
        injected = true;
        deliver(h, { ...MAILS.travelZh, id: 'c1000000000000c2' }, now);
      }
    };
    deliver(h, { ...MAILS.receiptZh, id: 'c1000000000000c1' }, now);
    h.up.gmail.oldestHistoryId = h.up.gmail.historyId + 1;
    now += 5 * MINUTE;
    await h.step(now);
    expect(injected).toBe(true);
    h.up.gmail.oldestHistoryId = 0;
    for (let i = 0; i < 2; i++) {
      now += 5 * MINUTE;
      await h.step(now);
    }
    expect(await decision(h, 'c1000000000000c1')).toMatchObject({ label_id: 'receipt' });
    expect(await decision(h, 'c1000000000000c2')).toMatchObject({ label_id: 'travel' });
  });

  it('a model outage backs each mail off instead of deciding it unsure', async () => {
    h.up.ai.broken = true;
    deliver(h, { ...MAILS.receiptEn, id: 'c2000000000000c1' }, now);
    deliver(h, { ...MAILS.travelZh, id: 'c2000000000000c2' }, now);
    now += 5 * MINUTE;
    for (let i = 0; i < 4; i++) {
      const pass = await h.step(now);
      now = pass.next;
    }
    // Before the fix, the third pass (60 s in) had decided both unsure for good.
    expect(await h.sql(`SELECT message_id FROM decisions WHERE message_id LIKE 'c2%'`)).toEqual([]);
    const pending = await h.sql<{ attempts: number; not_before: number }>(`SELECT attempts, not_before FROM pending ORDER BY message_id`);
    expect(pending.length).toBe(2);
    for (const row of pending) {
      expect(row.attempts).toBeGreaterThanOrEqual(1);
      expect(row.attempts).toBeLessThanOrEqual(2);
      expect(row.not_before).toBeGreaterThan(now);
    }
    h.up.ai.broken = false;
    now = Math.max(now, ...pending.map((row) => row.not_before));
    await h.step(now);
    expect(await decision(h, 'c2000000000000c1')).toMatchObject({ label_id: 'receipt' });
    expect(await decision(h, 'c2000000000000c2')).toMatchObject({ label_id: 'travel' });
  });

  it('shadow: a review verdict (nothing written) does not hide the rest of its conversation', async () => {
    const first = { ...MAILS.receiptEn, id: 'c3000000000000c1', threadId: 'c3000000000000c1' } satisfies SyntheticMail;
    deliver(h, first, now);
    now += 5 * MINUTE;
    await h.step(now);
    const [item] = await h.sql<{ id: string }>(`SELECT id FROM review WHERE message_id = ? AND state = 'pending'`, first.id);
    await h.api.confirmReviewItem({ name: `reviewItems/${item?.id ?? ''}`, requestId: op() });
    deliver(h, { ...first, id: 'c3000000000000c2', subject: 'Re: Receipt' }, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, 'c3000000000000c2')).toMatchObject({ outcome: 'suggested', label_id: 'receipt' });
  });

  it('live: after the owner undoes mailsort’s label, the next mail of the conversation is decided again', async () => {
    await setMode(h, Mode.LIVE);
    const first = { ...MAILS.receiptEn, id: 'c4000000000000c1', threadId: 'c4000000000000c1' } satisfies SyntheticMail;
    deliver(h, first, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, first.id)).toMatchObject({ outcome: 'applied' });
    // While the label stands, the conversation keeps it.
    deliver(h, { ...first, id: 'c4000000000000c2', subject: 'Re: Receipt (1)' }, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, 'c4000000000000c2')).toMatchObject({ outcome: 'skipped', unsure_reason: 'thread_sorted' });
    const entry = (await h.api.listLedgerEntries({})).ledgerEntries.find((item) => item.messageId === first.id);
    await h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() });
    deliver(h, { ...first, id: 'c4000000000000c3', subject: 'Re: Receipt (2)' }, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, 'c4000000000000c3')).toMatchObject({ outcome: 'applied', label_id: 'receipt' });
  });
});

describe('the 14-day content cleanup runs while the mode is off', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    checkGoogleCalls(h);
  });

  it('twenty days off: the subject, the sender keys and the review item are gone, and Google was never called', async () => {
    await addLabels(h);
    await h.step(T0);
    deliver(h, MAILS.unsure, T0);
    await h.step(T0 + 5 * MINUTE);
    expect(await decision(h, MAILS.unsure.id)).toMatchObject({ outcome: 'unsure', content_cleared: 0, subject: 'Lunch on Friday?' });
    expect(await pendingReview(h, MAILS.unsure.id)).toHaveLength(1);
    await setMode(h, Mode.OFF);
    const calls = h.up.gmail.calls.length;
    for (let day = 1; day <= 20; day++) {
      const result = await h.step(T0 + day * DAY);
      expect(result.code).toBe('off');
    }
    expect(h.up.gmail.calls.length).toBe(calls);
    expect(await decision(h, MAILS.unsure.id)).toMatchObject({
      content_cleared: 1, subject: null, sender: null, summary: null, sender_address: null, sender_domain: null, list_id: null, delivered_to: null,
    });
    expect(await h.sql(`SELECT id FROM review WHERE message_id = ?`, MAILS.unsure.id)).toEqual([]);
  });
});
