/** Retry gates and bounded recovery, with fixed priorities and only synthetic upstreams. */
import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { PRIORITY_LABELS } from '../../src/priority.ts';
import { MAILS } from '../fakes/fixtures.ts';
import { MINUTE, op, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, classifyUnread, decision, deliver, failModifies, gmailLabels, modifies, setMode } from './helpers.ts';

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
  h.up.ai.choiceOverride = () => ({ p2: 0.92, none: 0.08 });
  await h.step(now);
  await setMode(h, Mode.LIVE);
}
async function step(): Promise<void> { now += 5 * MINUTE; await h.clock(now); await classifyUnread(h); await h.step(now); }
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

  it.each(['shadow', 'breaker'])('holds a retry while %s pauses live writes', async (reason) => {
    await setup();
    const id = 'abc0000000000102';
    await intended(id);
    if (reason === 'shadow') await setMode(h, Mode.SHADOW);
    else await h.sql(`UPDATE meta SET value = json_set(value, '$.breaker', 'label_share') WHERE key = 'settings'`);
    const count = modifies(h).length;
    await step();
    expect(modifies(h)).toHaveLength(count);
    expect(await ledger(id)).toEqual([{ state: 'intended', last_code: 'message_modify_503' }]);
    expect(await decision(h, id)).toMatchObject({ outcome: 'applied', label_id: 'p2' });
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
  });

  it('holds writes at the daily cap and resumes without tripping the breaker', async () => {
    await setup();
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyWriteLimit: 1 }), updateMask: { paths: ['daily_write_limit'] }, requestId: op() });
    await h.sql(`INSERT INTO usage (day, applied) VALUES ('2026-10-01', 1) ON CONFLICT (day) DO UPDATE SET applied = 1`);
    deliver(h, { ...MAILS.bankEn, id: 'abc0000000000108' }, now + MINUTE);
    await step();
    expect(await ledger('abc0000000000108')).toEqual([{ state: 'intended', last_code: null }]);
    expect(modifies(h)).toEqual([]);
    const kept = await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyWriteLimit: 150 }), updateMask: { paths: ['daily_write_limit'] }, requestId: op() });
    expect(kept.breakerReason).toBe('');
    await setMode(h, Mode.LIVE);
    expect((await h.api.getSettings({ name: 'settings' })).breakerTripped).toBe(false);
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
    expect(await ledger(id)).toEqual([{ state: 'intended', last_code: null }]);
  });
});
