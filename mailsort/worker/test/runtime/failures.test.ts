/** Retry gates and bounded recovery, with fixed priorities and only synthetic upstreams. */
import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { PRIORITY_LABELS } from '../../src/priority.ts';
import { MAILS } from '../fakes/fixtures.ts';
import { DAY, HOUR, MINUTE, op, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, decision, deliver, failModifies, gmailLabels, modifies, setMode } from './helpers.ts';

let h: Harness;
let now = T0;
async function setup(bindings: Record<string, string> = {}): Promise<void> {
  h = await startHarness({ bindings });
  now = T0;
  for (const [i, label] of PRIORITY_LABELS.entries()) {
    const gmailId = h.up.gmail.createUserLabel(label.displayName, true);
    await h.sql(`INSERT INTO labels (id, seq, display_name, description, enabled, gmail_id, gmail_state, keep_in_inbox, create_time, update_time, etag) VALUES (?, ?, ?, ?, 1, ?, 'linked', ?, ?, ?, 'e')`, label.id, i + 1, label.displayName, label.description, gmailId, label.keepInInbox ? 1 : 0, T0, T0);
  }
  await h.sql(`INSERT INTO meta (key, value) VALUES ('priority_started_at', ?)`, String(T0));
  h.up.claude.bucket = 'P2';
  await h.step(now);
  await setMode(h, Mode.LIVE);
  await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
}
async function step(): Promise<void> { now += 5 * MINUTE; await h.step(now); }
async function ledger(id: string): Promise<unknown> { return h.sql(`SELECT state, last_code FROM ledger WHERE message_id = ? ORDER BY id`, id); }
async function intended(id: string): Promise<void> {
  const failing = failModifies(h, 503);
  deliver(h, { ...MAILS.bankEn, id }, now + MINUTE);
  await step();
  failing.off();
  expect(await ledger(id)).toEqual([{ state: 'intended', last_code: 'message_modify_503' }]);
}
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });

describe('write gates and retries', () => {
  it('retries the same ledger row after a 503, preserving UNREAD', async () => {
    await setup();
    const id = 'abc0000000000101';
    await intended(id);
    await step();
    expect(await ledger(id)).toEqual([{ state: 'applied', last_code: null }]);
    expect(gmailLabels(h, id)).toEqual(['CATEGORY_UPDATES', 'UNREAD', h.up.gmail.labelIdByName('P2')].sort());
    expect(await h.sql(`SELECT count(*) AS n FROM ledger WHERE message_id = ?`, id)).toEqual([{ n: 1 }]);
  });

  it.each(['shadow', 'breaker'])('refuses a retry after %s stops live writes', async (reason) => {
    await setup();
    const id = 'abc0000000000102';
    await intended(id);
    if (reason === 'shadow') await setMode(h, Mode.SHADOW);
    else await h.sql(`UPDATE meta SET value = json_set(value, '$.breaker', 'label_share') WHERE key = 'settings'`);
    const count = modifies(h).length;
    await step();
    expect(modifies(h)).toHaveLength(count);
    expect(await ledger(id)).toEqual([{ state: 'failed', last_code: 'mode_changed' }]);
    expect(await decision(h, id)).toMatchObject({ outcome: 'suggested', label_id: 'p2' });
    expect(gmailLabels(h, id)).toContain('INBOX');
  });

  it('checks label enablement again before retry', async () => {
    await setup();
    const id = 'abc0000000000103';
    await intended(id);
    await h.sql(`UPDATE labels SET enabled = 0 WHERE id = 'p2'`);
    const count = modifies(h).length;
    await step();
    expect(modifies(h)).toHaveLength(count);
    expect(await ledger(id)).toEqual([{ state: 'failed', last_code: 'label_disabled' }]);
  });

  it('does not apply retired auth/trust conditions to a retry', async () => {
    await setup();
    const id = 'abc0000000000104';
    await intended(id);
    await h.sql(`UPDATE labels SET trust = 1 WHERE id = 'p2'`);
    await h.sql(`UPDATE decisions SET dmarc = 0 WHERE message_id = ?`, id);
    await step();
    expect(await ledger(id)).toEqual([{ state: 'applied', last_code: null }]);
  });

  it('leaves mail the owner archived under another label alone', async () => {
    await setup();
    const id = 'abc0000000000105';
    await intended(id);
    const own = h.up.gmail.createUserLabel('Owner work');
    h.up.gmail.ownerModify(id, [own], ['INBOX']);
    const count = modifies(h).length;
    await step();
    expect(modifies(h)).toHaveLength(count);
    expect(await ledger(id)).toEqual([{ state: 'failed', last_code: 'mail_changed' }]);
    expect(gmailLabels(h, id)).toEqual(['CATEGORY_UPDATES', 'UNREAD', own].sort());
  });

  it('counts a retry against the same run cap as new mail', async () => {
    await setup();
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', runWriteLimit: 1 }), updateMask: { paths: ['run_write_limit'] }, requestId: op() });
    const first = 'abc0000000000106';
    const second = 'abc0000000000107';
    const failing = failModifies(h, 503);
    deliver(h, { ...MAILS.bankEn, id: first }, now + MINUTE);
    deliver(h, { ...MAILS.bankEn, id: second }, now + 2 * MINUTE);
    await step();
    failing.off();
    const count = modifies(h).length;
    await step();
    expect(modifies(h).length - count).toBe(1);
    expect(await h.sql(`SELECT state, count(*) AS n FROM ledger WHERE message_id IN (?, ?) GROUP BY state ORDER BY state`, first, second)).toEqual([{ state: 'applied', n: 1 }, { state: 'intended', n: 1 }]);
    expect(await h.api.getSettings({ name: 'settings' })).toMatchObject({ breakerTripped: false, breakerReason: '', effectiveMode: Mode.LIVE });
    await step();
    expect(await ledger(first)).toEqual([{ state: 'applied', last_code: null }]);
    expect(await ledger(second)).toEqual([{ state: 'applied', last_code: null }]);
  });

  it('waits for the next UTC day at the daily cap without switching to shadow', async () => {
    await setup();
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyWriteLimit: 1 }), updateMask: { paths: ['daily_write_limit'] }, requestId: op() });
    await h.sql(`INSERT INTO usage (day, applied) VALUES ('2026-10-01', 1) ON CONFLICT (day) DO UPDATE SET applied = 1`);
    deliver(h, { ...MAILS.bankEn, id: 'abc0000000000108' }, now + MINUTE);
    await step();
    expect(await ledger('abc0000000000108')).toEqual([]);
    expect(modifies(h)).toEqual([]);
    expect(await h.sql(`SELECT not_before FROM pending`)).toEqual([{ not_before: T0 + DAY }]);
    expect(await h.api.getSettings({ name: 'settings' })).toMatchObject({ breakerTripped: false, effectiveMode: Mode.LIVE });
    await h.step(T0 + DAY);
    expect(await ledger('abc0000000000108')).toEqual([{ state: 'applied', last_code: null }]);
  });

  it('keeps the deployment mode ceiling above all owner write requests', async () => {
    await setup({ MODE: 'shadow' });
    const id = 'abc0000000000109';
    deliver(h, { ...MAILS.bankEn, id }, now + MINUTE);
    await step();
    const gmailId = h.up.gmail.labelIdByName('P2') ?? '';
    await h.sql(`INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time) VALUES ('leftover', ?, 'p2', ?, 1, 'auto', 'intended', ?)`, id, gmailId, now);
    await step();
    expect(modifies(h)).toEqual([]);
    expect(await ledger(id)).toEqual([{ state: 'failed', last_code: 'mode_changed' }]);
  });
});

describe('read and model recovery', () => {
  it('skips a malformed/unreadable 400 and decides the message behind it', async () => {
    await setup();
    const poison = 'abc0000000000110';
    h.up.gmail.failWhen = (method, url) => method === 'GET' && url.pathname.endsWith(`/messages/${poison}`) ? 400 : null;
    deliver(h, { ...MAILS.bankEn, id: poison }, now + MINUTE);
    deliver(h, { ...MAILS.bankEn, id: 'abc0000000000111' }, now + 2 * MINUTE);
    await step();
    expect(await decision(h, poison)).toMatchObject({ outcome: 'skipped', unsure_reason: 'unreadable' });
    expect(await decision(h, 'abc0000000000111')).toMatchObject({ label_id: 'p2' });
  });

  it('backs off a persistent 500 per message and stops after the existing seven tries', async () => {
    await setup();
    const poison = 'abc0000000000112';
    h.up.gmail.failWhen = (method, url) => method === 'GET' && url.pathname.endsWith(`/messages/${poison}`) ? 500 : null;
    deliver(h, { ...MAILS.bankEn, id: poison }, now + MINUTE);
    deliver(h, { ...MAILS.bankEn, id: 'abc0000000000113' }, now + 2 * MINUTE);
    await step();
    expect(await h.sql(`SELECT attempts, not_before FROM pending WHERE message_id = ?`, poison)).toEqual([{ attempts: 1, not_before: now + 5 * MINUTE }]);
    now += 30_000;
    await h.step(now);
    expect(await decision(h, 'abc0000000000113')).toMatchObject({ label_id: 'p2' });
    for (let i = 0; i < 10 && await decision(h, poison) === undefined; i++) {
      const [row] = await h.sql<{ not_before: number }>(`SELECT not_before FROM pending WHERE message_id = ?`, poison);
      now = Math.max(now + MINUTE, row?.not_before ?? 0);
      await h.step(now);
    }
    expect(await decision(h, poison)).toMatchObject({ outcome: 'skipped', unsure_reason: 'unreadable' });
    expect(h.up.gmail.calls.filter((call) => call.url.includes(`/messages/${poison}`))).toHaveLength(7);
  });

  it('never queues Gmail message IDs refused by the closed table', async () => {
    await setup();
    deliver(h, { ...MAILS.bankEn, id: 'invalid-gmail-id' }, now + MINUTE);
    deliver(h, { ...MAILS.bankEn, id: 'abc0000000000114' }, now + MINUTE);
    await step();
    expect(await decision(h, 'abc0000000000114')).toMatchObject({ label_id: 'p2' });
    expect(h.up.gmail.calls.some((call) => call.url.includes('invalid-gmail-id'))).toBe(false);
  });

  it('retains provider spend-limited mail and ignores old embeddings until the next UTC month', async () => {
    await setup();
    h.up.claude.spendLimit = true;
    deliver(h, { ...MAILS.bankEn, id: 'abc0000000000115' }, now + MINUTE);
    await step();
    const november = Date.parse('2026-11-01T00:00:00Z');
    expect(await decision(h, 'abc0000000000115')).toBeUndefined();
    expect(await h.sql(`SELECT attempts, not_before FROM pending`)).toEqual([{ attempts: 0, not_before: november }]);
    await h.sql(`INSERT INTO examples (id, label_id, summary, origin, create_time) VALUES ('quota-example', 'p2', 'Synthetic statement', 'confirmation', ?)`, now);
    h.up.claude.spendLimit = false;
    await step();
    expect(h.up.claude.calls).toHaveLength(1);
    expect(h.up.ai.calls).toEqual([]);
    expect(modifies(h)).toEqual([]);
    await h.step(november);
    expect(await decision(h, 'abc0000000000115')).toMatchObject({ outcome: 'applied', label_id: 'p2' });
    expect(await h.sql(`SELECT embedding FROM examples WHERE id = 'quota-example'`)).toEqual([{ embedding: null }]);
  });

  it('retries invalid model answers three times and records failure without a priority write or mandatory review', async () => {
    await setup();
    h.up.claude.badItems = true;
    const id = 'abc0000000000116';
    deliver(h, { ...MAILS.bankEn, id }, now + MINUTE);
    for (let i = 0; i < 3; i++) {
      await step();
      const row = (await h.sql<{ not_before: number }>(`SELECT not_before FROM pending WHERE message_id = ?`, id))[0];
      if (row !== undefined) now = row.not_before - 5 * MINUTE;
    }
    expect(await decision(h, id)).toMatchObject({ outcome: 'unsure', unsure_reason: 'model_unavailable', label_id: null, shown: 0 });
    expect(modifies(h)).toEqual([]);
    expect(await h.sql(`SELECT id FROM review`)).toEqual([]);
  });

  it('keeps the resync cursor-first order and skips pre-cutover mail', async () => {
    await setup();
    deliver(h, { ...MAILS.bankEn, id: 'abc0000000000117' }, T0 - MINUTE);
    deliver(h, { ...MAILS.bankEn, id: 'abc0000000000118' }, now + MINUTE);
    let injected = false;
    h.up.gmail.afterCall = (method, url) => {
      if (!injected && method === 'GET' && url.pathname.endsWith('/messages') && url.searchParams.get('labelIds') === 'INBOX') {
        injected = true;
        deliver(h, { ...MAILS.bankEn, id: 'abc0000000000119' }, now);
      }
    };
    h.up.gmail.oldestHistoryId = h.up.gmail.historyId + 1;
    await step();
    h.up.gmail.oldestHistoryId = 0;
    await step();
    expect(injected).toBe(true);
    expect(await decision(h, 'abc0000000000117')).toMatchObject({ outcome: 'skipped', unsure_reason: 'before_install' });
    expect(await decision(h, 'abc0000000000118')).toMatchObject({ label_id: 'p2' });
    await h.step(now + HOUR);
    expect(await decision(h, 'abc0000000000119')).toMatchObject({ label_id: 'p2' });
  });

  it('clears 14-day content while off without contacting Gmail', async () => {
    await setup();
    const id = 'abc0000000000120';
    deliver(h, { ...MAILS.bankEn, id }, now + MINUTE);
    await step();
    const hash = (await decision(h, id))?.['sender_hash'];
    await setMode(h, Mode.OFF);
    const before = h.up.gmail.calls.length;
    const pass = await h.step(T0 + 20 * DAY);
    expect(pass.code).toBe('off');
    expect(h.up.gmail.calls).toHaveLength(before);
    expect(await decision(h, id)).toMatchObject({ content_cleared: 1, sender_hash: hash, subject: null, sender: null, summary: null, sender_domain: null });
  });
});
