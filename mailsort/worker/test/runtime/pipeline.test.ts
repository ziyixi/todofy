/** Native Claude batching with real workerd SQLite and synthetic Gmail/Anthropic only. */
import { afterEach, describe, expect, it } from 'vitest';
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { PRIORITY_LABELS } from '../../src/priority.ts';
import { MAILS, message, type SyntheticMail } from '../fakes/fixtures.ts';
import { DAY, HOUR, MINUTE, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, decision, deliver, gmailLabels, modifies, setMode } from './helpers.ts';

let h: Harness;
async function initialize(bindings: Record<string, string | undefined> = {}): Promise<void> {
  h = await startHarness({ bindings });
  for (const [i, label] of PRIORITY_LABELS.entries()) {
    const gmail = h.up.gmail.createUserLabel(label.displayName, true);
    await h.sql(`INSERT INTO labels (id, seq, display_name, description, enabled, gmail_id, gmail_state, keep_in_inbox, create_time, update_time, etag) VALUES (?, ?, ?, ?, 1, ?, 'linked', ?, ?, ?, 'e')`, label.id, i + 1, label.displayName, label.description, gmail, label.keepInInbox ? 1 : 0, T0, T0);
  }
  await h.sql(`INSERT INTO meta (key, value) VALUES ('priority_started_at', ?)`, String(T0));
  await h.step(T0);
  await setMode(h, Mode.LIVE);
  await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
}
const mail = (i: number, fields: Partial<SyntheticMail> = {}): SyntheticMail => ({ ...MAILS.bankEn, id: `abc${i.toString(16).padStart(13, '0')}`, ...fields });
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });

describe('Claude priority pipeline', () => {
  it.each(['P1', 'P2', 'P3', 'P4'] as const)('applies %s while preserving unread and unrelated labels', async bucket => {
    await initialize();
    h.up.claude.bucket = bucket;
    const own = h.up.gmail.createUserLabel('Owner tag');
    const input = mail(1, { labels: ['INBOX', 'UNREAD', 'STARRED', own] });
    deliver(h, input, T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ decided: 1, applied: 1 });
    expect(gmailLabels(h, input.id)).toEqual(['UNREAD', 'STARRED', own, h.up.gmail.labelIdByName(bucket), ...(bucket === 'P1' ? ['INBOX'] : [])].sort());
    expect(await decision(h, input.id)).toMatchObject({ outcome: 'applied', label_id: bucket.toLowerCase(), decider: 'claude', model: 'claude-opus-5-5', confidence: null, probabilities: '{}', probabilities2: '{}' });
    expect(h.up.claude.calls).toHaveLength(1);
    expect(h.up.ai.calls).toEqual([]);
    expect(await h.sql(`SELECT id FROM review`)).toEqual([]);
  });

  it('starts roughly hourly, drains ten per request, and reaches a run cap without switching to shadow', async () => {
    await initialize();
    await h.sql(`UPDATE meta SET value = json_set(value, '$.runWriteLimit', 10) WHERE key = 'settings'`);
    for (let i = 1; i <= 21; i++) deliver(h, mail(i), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ decided: 10, applied: 10 });
    expect(await h.step(T0 + 3 * MINUTE)).toMatchObject({ decided: 10, applied: 10 });
    expect(await h.step(T0 + 4 * MINUTE)).toMatchObject({ decided: 1, applied: 1 });
    expect(h.up.claude.calls.map(call => call.length)).toEqual([10, 10, 1]);
    expect((await h.api.getSettings({ name: 'settings' })).breakerTripped).toBe(false);
    deliver(h, mail(22), T0 + 5 * MINUTE);
    await h.step(T0 + 9 * MINUTE);
    expect(h.up.claude.calls).toHaveLength(3);
    await h.step(T0 + HOUR + 4 * MINUTE);
    expect(h.up.claude.calls).toHaveLength(4);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.claudeBudget).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', month: '2026-10', limitUsd: 20, spentUsd: 0.0288, inputTokens: 4800, outputTokens: 480, thinkingTokens: 160 });
  });

  it('reads only ordinary new unread mail without a priority and leaves historical/read mail unchanged', async () => {
    await initialize();
    const graded = h.up.gmail.labelIdByName('P3') ?? '';
    deliver(h, mail(1, { labels: ['INBOX'] }), T0 + MINUTE);
    deliver(h, mail(2, { labels: ['INBOX', 'UNREAD', graded] }), T0 + MINUTE);
    deliver(h, mail(3), T0 - MINUTE);
    deliver(h, mail(4), T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(h.up.claude.calls.flat().map(item => item.id)).toEqual([mail(4).id]);
    expect(await decision(h, mail(1).id)).toBeUndefined();
    expect(await decision(h, mail(2).id)).toBeUndefined();
    expect(await decision(h, mail(3).id)).toMatchObject({ outcome: 'skipped', unsure_reason: 'before_install' });
  });

  it('sends masked text up to 12000 characters and records no raw addresses or paths in the request', async () => {
    await initialize();
    deliver(h, mail(1, { subject: 'Synthetic account 12345678 for owner@example.com', text: `Please see https://example.com/private?secret=1 and owner@example.com. ${'合成正文'.repeat(4000)}` }), T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    const input = h.up.claude.calls[0]?.[0];
    expect(input?.body.length).toBeGreaterThan(11000);
    expect(Array.from(input?.body ?? '').length).toBeLessThanOrEqual(12000);
    expect(input?.body_truncated).toBe(true);
    expect(JSON.stringify(input)).not.toContain('owner@example.com');
    expect(JSON.stringify(input)).not.toContain('/private?secret');
    expect(input?.subject).toContain('[number]');
  });

  it('reports body truncation after bounded HTML decoding and metadata fallback', async () => {
    await initialize();
    const html = `<head>${' '.repeat(110000)}</head><body>Important synthetic content beyond the decoded budget.</body>`;
    const input = mail(31, { html, text: '' });
    deliver(h, input, T0 + MINUTE);
    const tooLarge = message({ ...mail(32), text: 'x'.repeat(600000), receivedAt: T0 + MINUTE });
    h.up.gmail.deliver(tooLarge);
    await h.step(T0 + 2 * MINUTE);
    expect(h.up.claude.calls[0]?.find(item => item.id === input.id)?.body_truncated).toBe(true);
    expect(h.up.claude.calls[0]?.find(item => item.id === mail(32).id)?.body_truncated).toBe(true);
  });

  it('stops Gmail writes on an auth failure and persists the remaining classified intents', async () => {
    await initialize();
    deliver(h, mail(41), T0 + MINUTE);
    deliver(h, mail(42), T0 + MINUTE);
    h.up.gmail.failWhen = (method, url) => method === 'POST' && url.pathname.endsWith('/modify') ? 401 : null;
    const pass = await h.step(T0 + 2 * MINUTE);
    expect(pass).toMatchObject({ code: 'gmail_stopped', decided: 2 });
    expect(modifies(h)).toHaveLength(1);
    expect(await h.sql(`SELECT count(*) AS n FROM ledger WHERE state = 'intended'`)).toEqual([{ n: 2 }]);
    expect(await h.sql(`SELECT count(*) AS n FROM decisions WHERE decider = 'claude'`)).toEqual([{ n: 2 }]);
    expect(h.up.claude.calls).toHaveLength(1);
  });

  it('retains provider-limited mail until the next UTC month without inventing a P1 or retrying that month', async () => {
    await initialize();
    h.up.claude.spendLimit = true;
    deliver(h, mail(1), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'claude_spend_limit', decided: 0, deferred: 1 });
    const november = Date.parse('2026-11-01T00:00:00Z');
    expect(await h.sql(`SELECT attempts, not_before FROM pending`)).toEqual([{ attempts: 0, not_before: november }]);
    h.up.claude.spendLimit = false;
    deliver(h, mail(2), T0 + 3 * MINUTE);
    await h.step(T0 + DAY);
    expect(h.up.claude.calls).toHaveLength(1);
    expect(modifies(h)).toEqual([]);
    await h.step(november);
    expect(h.up.claude.calls).toHaveLength(2);
    expect(modifies(h)).toHaveLength(2);
  });

  it('clears only a prior-month spend error when a new month starts with no pending mail', async () => {
    await initialize();
    await h.sql(`INSERT INTO meta (key, value) VALUES ('claude_limited_month', '2026-10'), ('claude_error', 'claude_spend_limit')`);
    const november = Date.parse('2026-11-01T00:00:00Z');
    await h.step(november);
    expect(h.up.claude.calls).toEqual([]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).claudeBudget).toMatchObject({ month: '2026-11', lastErrorCode: '', providerLimitReached: false });
    const ops = await h.opsStatus();
    expect((ops['signals'] as { code: string }[]).some(signal => signal.code.startsWith('claude_'))).toBe(false);
    await h.sql(`INSERT INTO meta (key, value) VALUES ('claude_error', 'claude_401')`);
    await h.step(november + DAY);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).claudeBudget?.lastErrorCode).toBe('claude_401');
  });

  it('stops on the app recorded monthly cost and keeps daily Gmail caps as waits', async () => {
    await initialize();
    await h.sql(`INSERT INTO claude_usage (day, cost_micros) VALUES ('2026-10-01', 20000000)`);
    deliver(h, mail(1), T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(h.up.claude.calls).toEqual([]);
    expect(await decision(h, mail(1).id)).toBeUndefined();
    expect((await h.api.getSettings({ name: 'settings' })).effectiveMode).toBe(Mode.LIVE);
  });

  it('counts billed invalid outputs and backs off without a priority or a review', async () => {
    await initialize();
    h.up.claude.badItems = true;
    deliver(h, mail(1), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'claude_bad_items', decided: 0 });
    expect(await h.sql(`SELECT attempts, not_before FROM pending`)).toEqual([{ attempts: 1, not_before: T0 + 7 * MINUTE }]);
    expect(await h.sql(`SELECT requests, cost_micros FROM claude_usage`)).toEqual([{ requests: 1, cost_micros: 7200 }]);
    expect(await decision(h, mail(1).id)).toBeUndefined();
    expect(modifies(h)).toEqual([]);
    expect(await h.sql(`SELECT id FROM review`)).toEqual([]);
  });

  it('keeps missing credentials visible without consuming pending attempts', async () => {
    await initialize({ ANTHROPIC_API_KEY: undefined });
    deliver(h, mail(1), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'claude_not_configured', decided: 0 });
    expect(await h.sql(`SELECT attempts FROM pending`)).toEqual([{ attempts: 0 }]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).claudeBudget?.lastErrorCode).toBe('claude_not_configured');
    expect(modifies(h)).toEqual([]);
  });

  it('preserves shadow/off modes and never executes historical embeddings, replay or weak learning', async () => {
    await initialize();
    await setMode(h, Mode.SHADOW);
    await h.sql(`INSERT INTO examples (id, label_id, summary, origin, create_time) VALUES ('old', 'p2', 'Synthetic historical example', 'confirmation', ?)`, T0);
    deliver(h, mail(1), T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(await decision(h, mail(1).id)).toMatchObject({ outcome: 'suggested' });
    expect(modifies(h)).toEqual([]);
    await setMode(h, Mode.OFF);
    await h.step(T0 + 4 * DAY);
    expect(h.up.ai.calls).toEqual([]);
    expect(await h.sql(`SELECT embedding FROM examples`)).toEqual([{ embedding: null }]);
    expect(await h.sql(`SELECT verdict FROM decisions WHERE message_id = ?`, mail(1).id)).toEqual([{ verdict: null }]);
  });
});
