/**
 * Model Router failures by the shared error contract, in real workerd SQLite with synthetic Gmail and Router only:
 * capacity and outages defer the whole pass without attempts, configuration waits an hour or a settings save, content
 * and timeouts count per mail, and a mail that already failed is retried alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { PRIORITY_LABELS } from '../../src/priority.ts';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { HOUR, MINUTE, op, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, decision, deliver, modifies, setMode } from './helpers.ts';

let h: Harness;
async function initialize(): Promise<void> {
  h = await startHarness();
  for (const [i, label] of PRIORITY_LABELS.entries()) {
    const gmail = h.up.gmail.createUserLabel(label.displayName, true);
    await h.sql(`INSERT INTO labels (id, seq, display_name, description, enabled, gmail_id, gmail_state, keep_in_inbox, create_time, update_time, etag) VALUES (?, ?, ?, ?, 1, ?, 'linked', ?, ?, ?, 'e')`, label.id, i + 1, label.displayName, label.description, gmail, label.keepInInbox ? 1 : 0, T0, T0);
  }
  await h.sql(`INSERT INTO meta (key, value) VALUES ('priority_started_at', ?)`, String(T0));
  await h.step(T0);
  await setMode(h, Mode.LIVE);
  await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
}
const mail = (i: number): SyntheticMail => ({ ...MAILS.bankEn, id: `fad${i.toString(16).padStart(13, '0')}` });
function fail(reason: string, code: number, retryAfterSeconds = 0): void {
  Object.assign(h.up.claude, { errorReason: reason, errorCode: code, retryAfterSeconds });
}
async function nextModelAt(): Promise<number> {
  return Number((await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'next_model_at'`))[0]?.value);
}
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });

describe('model failures', () => {
  it('defers the whole pass on a rate limit, honoring Retry-After, without burning attempts', async () => {
    await initialize();
    fail('MODEL_RATE_LIMIT', 8, 600);
    deliver(h, mail(1), T0 + MINUTE);
    deliver(h, mail(2), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'claude_rate_limit', decided: 0, deferred: 2 });
    expect(await h.sql(`SELECT attempts, not_before FROM pending`)).toEqual([{ attempts: 0, not_before: T0 + 12 * MINUTE }, { attempts: 0, not_before: T0 + 12 * MINUTE }]);
    expect(await nextModelAt()).toBe(T0 + 12 * MINUTE);
    await h.step(T0 + 7 * MINUTE);
    expect(h.up.claude.calls).toHaveLength(1);
    fail('', 0);
    expect(await h.step(T0 + 12 * MINUTE)).toMatchObject({ decided: 2, applied: 2 });
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'model_deferrals'`)).toEqual([]);
  });

  it('keeps mail through an outage longer than five hours, backing off from 5 minutes to an hour', async () => {
    await initialize();
    fail('MODEL_UNAVAILABLE', 14);
    deliver(h, mail(1), T0 + MINUTE);
    let at = T0 + 2 * MINUTE;
    const waits: number[] = [];
    for (let pass = 0; pass < 9; pass++) {
      expect(await h.step(at)).toMatchObject({ code: 'claude_unavailable', decided: 0 });
      const next = await nextModelAt();
      waits.push((next - at) / MINUTE);
      at = next;
    }
    expect(waits).toEqual([5, 10, 20, 40, 60, 60, 60, 60, 60]);
    expect(at - T0).toBeGreaterThan(5 * HOUR);
    expect(await h.sql(`SELECT attempts FROM pending`)).toEqual([{ attempts: 0 }]);
    expect(await decision(h, mail(1).id)).toBeUndefined();
    fail('', 0);
    expect(await h.step(at)).toMatchObject({ decided: 1, applied: 1 });
    expect(await decision(h, mail(1).id)).toMatchObject({ outcome: 'applied', label_id: 'p2' });
  });

  it('retries a configuration failure hourly without attempts, and at once after a settings save', async () => {
    await initialize();
    fail('MODEL_AUTH', 16);
    deliver(h, mail(1), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'claude_auth', decided: 0, deferred: 0 });
    expect(await h.sql(`SELECT attempts FROM pending`)).toEqual([{ attempts: 0 }]);
    expect(await nextModelAt()).toBe(T0 + 2 * MINUTE + HOUR);
    await h.step(T0 + 30 * MINUTE);
    expect(h.up.claude.calls).toHaveLength(1);
    fail('', 0);
    await h.clock(T0 + 31 * MINUTE);
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', runWriteLimit: 10 }), updateMask: { paths: ['run_write_limit'] }, requestId: op() });
    expect(await nextModelAt()).toBe(T0 + 31 * MINUTE);
    expect(await h.step(T0 + 32 * MINUTE)).toMatchObject({ decided: 1, applied: 1 });
    expect(h.up.claude.calls).toHaveLength(2);
  });

  it('caps a content-dependent invalid request at three tries, and a timeout at the ordinary seven', async () => {
    await initialize();
    fail('MODEL_INVALID_REQUEST', 3);
    deliver(h, mail(1), T0 + MINUTE);
    let at = T0 + 2 * MINUTE;
    for (const attempts of [1, 2]) {
      expect(await h.step(at)).toMatchObject({ code: 'claude_bad_input', decided: 0 });
      expect(await h.sql(`SELECT attempts FROM pending`)).toEqual([{ attempts }]);
      at = await nextModelAt();
    }
    await h.step(at);
    expect(await h.sql(`SELECT count(*) AS n FROM pending`)).toEqual([{ n: 0 }]);
    expect(await decision(h, mail(1).id)).toMatchObject({ outcome: 'unsure', unsure_reason: 'model_unavailable' });
    fail('MODEL_TIMEOUT', 4);
    deliver(h, mail(2), at + MINUTE);
    await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
    expect(await h.step(at + 2 * MINUTE)).toMatchObject({ code: 'claude_timeout' });
    expect(await h.sql(`SELECT attempts FROM pending`)).toEqual([{ attempts: 1 }]);
    await h.sql(`UPDATE pending SET attempts = 3, not_before = 0`);
    await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
    await h.step(at + 3 * MINUTE);
    expect(await h.sql(`SELECT attempts FROM pending`)).toEqual([{ attempts: 4 }]);
    expect(modifies(h)).toEqual([]);
  });

  it('retries a failed batch one mail at a time, so only the mail the model cannot answer is given up', async () => {
    await initialize();
    h.up.claude.poison = mail(2).id;
    for (const i of [1, 2, 3]) deliver(h, mail(i), T0 + MINUTE);
    let at = T0 + 2 * MINUTE;
    expect(await h.step(at)).toMatchObject({ code: 'claude_bad_answer', decided: 0 });
    for (let pass = 0; pass < 10 && (await h.sql(`SELECT 1 AS x FROM pending`)).length > 0; pass++) {
      at = Math.max(at + 30_000, await nextModelAt());
      await h.step(at);
    }
    expect(h.up.claude.calls[0]).toHaveLength(3);
    expect(h.up.claude.calls.slice(1).every(call => call.length === 1)).toBe(true);
    expect(await decision(h, mail(1).id)).toMatchObject({ outcome: 'applied', label_id: 'p2' });
    expect(await decision(h, mail(3).id)).toMatchObject({ outcome: 'applied', label_id: 'p2' });
    expect(await decision(h, mail(2).id)).toMatchObject({ outcome: 'unsure', unsure_reason: 'model_unavailable' });
  });
});
