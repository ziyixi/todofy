/** The selected subscription classifier through real workerd SQLite and the closed Gmail fake. */
import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v2/flow_pb';
import { ClassificationPromptSchema } from '@ziyixi/proto/mailsort/ui/v2/prompt_pb';
import { ClassificationProvider, Mode, SettingsSchema, UnreadClassification_State } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { PRIORITY_LABELS } from '../../src/priority.ts';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { MODEL_ENDPOINT } from '../fakes/upstream.ts';
import { HOUR, MINUTE, op, startHarness, T0, type Harness } from './harness.ts';
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
}
async function select(provider: ClassificationProvider) {
  const current = await h.api.getSettings({ name: 'settings' });
  return h.api.updateSettings({
    settings: create(SettingsSchema, { name: 'settings', classificationProvider: provider, etag: current.etag }),
    updateMask: { paths: ['classification_provider', 'etag'] }, requestId: op(),
  });
}
async function savePrompt(baseText: string, personalRules: string): Promise<void> {
  const current = await h.api.getClassificationPrompt({ name: 'classificationPrompt' });
  await h.api.updateClassificationPrompt({
    classificationPrompt: create(ClassificationPromptSchema, { name: 'classificationPrompt', baseText, personalRules, etag: current.etag }),
    updateMask: { paths: ['base_text', 'personal_rules', 'etag'] }, requestId: op(),
  });
}
const mail = (i: number, fields: Partial<SyntheticMail> = {}): SyntheticMail => ({ ...MAILS.bankEn, id: `cde${i.toString(16).padStart(13, '0')}`, ...fields });
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });

describe('Codex priority pipeline', () => {
  it('uses the saved interval for new automatic batches while Gmail maintenance stays at five minutes', async () => {
    await initialize();
    await select(ClassificationProvider.CODEX);
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    const handle = h.up.handle.bind(h.up);
    h.up.handle = async (request) => {
      if (request.url === MODEL_ENDPOINT) {
        started();
        await held;
      }
      return handle(request);
    };
    deliver(h, mail(91), T0 + MINUTE);
    const running = h.step(T0 + 2 * MINUTE);
    await requested;
    // A settings save stays responsive while the existing classifier request is in flight.
    const current = await h.api.getSettings({ name: 'settings' });
    await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: 60, etag: current.etag }),
      updateMask: { paths: ['classification_interval_minutes'] }, requestId: op(),
    });
    release();
    expect(await running).toMatchObject({ decided: 1, applied: 1, next: T0 + 7 * MINUTE });
    deliver(h, mail(92), T0 + 3 * MINUTE);
    await h.step(T0 + 6 * MINUTE);
    expect(h.up.codex.calls).toHaveLength(1);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).classifier).toMatchObject({
      classificationIntervalMinutes: 60, nextBatchTime: timestampFromMs(T0 + 62 * MINUTE),
    });
    await h.step(T0 + 61 * MINUTE);
    expect(h.up.codex.calls).toHaveLength(1);
    expect(await h.step(T0 + 62 * MINUTE)).toMatchObject({ decided: 1, applied: 1 });
    expect(h.up.codex.calls).toHaveLength(2);
    expect(h.up.claude.calls).toEqual([]);
    expect(h.up.codex.calls.flat().map(email => email.id)).toEqual([mail(91).id, mail(92).id]);
  });

  it('applies all four priorities, records Codex flow and counts unchanged explicit rechecks correctly', async () => {
    await initialize();
    await select(ClassificationProvider.CODEX);
    const owner = h.up.gmail.createUserLabel('Synthetic owner tag');
    for (const [i, bucket] of (['P1', 'P2', 'P3', 'P4'] as const).entries()) {
      h.up.codex.bucket = bucket;
      const at = T0 + i * HOUR;
      const input = mail(i + 1, { labels: ['INBOX', 'UNREAD', 'STARRED', owner] });
      deliver(h, input, at + MINUTE);
      expect(await h.step(at + 2 * MINUTE)).toMatchObject({ decided: 1, applied: 1 });
      expect(gmailLabels(h, input.id)).toEqual(['UNREAD', 'STARRED', owner, h.up.gmail.labelIdByName(bucket), ...(bucket === 'P1' ? ['INBOX'] : [])].sort());
      expect(await decision(h, input.id)).toMatchObject({ outcome: 'applied', label_id: bucket.toLowerCase(), decider: 'codex', model: 'gpt-6.1-sol', confidence: null, probabilities: '{}', probabilities2: '{}' });
    }
    expect(h.up.codex.calls).toHaveLength(4);
    expect(h.up.codex.requests.every(request => request.model === 'gpt-6.1-sol')).toBe(true);
    expect(h.up.claude.calls).toEqual([]);
    expect(await h.sql(`SELECT requests FROM claude_usage`)).toEqual([]);
    const flow = await h.api.getMailFlow({ name: 'mailFlows/today' });
    expect(flow.counts.filter(row => row.stage === MailFlow_Stage.CODEX).reduce((sum, row) => sum + row.mailCount, 0)).toBe(4);
    expect(flow.counts.some(row => row.stage === MailFlow_Stage.CLAUDE)).toBe(false);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.classifier).toMatchObject({ provider: ClassificationProvider.CODEX, model: 'gpt-6.1-sol', effort: 'medium', configured: true, lastErrorCode: '', lastSuccessTime: timestampFromMs(T0 + 3 * HOUR + 2 * MINUTE) });
    expect(status.codexUsage).toMatchObject({ month: '2026-10', requestCount: 4, successCount: 4, failureCount: 0, usageReportedCount: 4, inputTokens: 4800, outputTokens: 480, lastRequestTime: timestampFromMs(T0 + 3 * HOUR + 2 * MINUTE) });
    await h.clock(T0 + 3 * HOUR + 3 * MINUTE);
    await h.api.startUnreadClassification({ name: 'unreadClassification', recheckInitial100: true, requestId: op() });
    await h.step(T0 + 3 * HOUR + 4 * MINUTE);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).unreadClassification).toMatchObject({
      state: UnreadClassification_State.COMPLETED, totalCount: 4, appliedCount: 3, unchangedCount: 1, skippedCount: 0, failedCount: 0,
    });
    expect(h.up.claude.calls).toEqual([]);
  });

  it('uses editable prompt snapshots and masked input for read and unread mail while leaving labelled mail unchanged', async () => {
    await initialize();
    await select(ClassificationProvider.CODEX);
    await savePrompt('Saved synthetic classification base.', 'Synthetic owner rules: personal reports are P3.');
    h.up.codex.bucket = 'P3';
    const oldPriority = h.up.gmail.labelIdByName('P4') ?? '';
    deliver(h, mail(11, { labels: ['INBOX', 'UNREAD', oldPriority] }), T0 + MINUTE);
    deliver(h, mail(12, { labels: ['INBOX'] }), T0 + MINUTE);
    deliver(h, mail(13, { text: 'Synthetic account owner@example.com uses https://example.com/private?secret=1 for 12345678.' }), T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(h.up.codex.calls[0]?.map(email => email.id)).toEqual([mail(12).id, mail(13).id]);
    expect(h.up.codex.requests[0]?.instructions.map(block => block.text).join('\n\n')).toBe('Saved synthetic classification base.\n\nSynthetic owner rules: personal reports are P3.');
    expect(JSON.stringify(h.up.codex.calls)).not.toContain('owner@example.com');
    expect(JSON.stringify(h.up.codex.calls)).not.toContain('/private?secret');
    expect(await decision(h, mail(11).id)).toBeUndefined();
    expect(await decision(h, mail(12).id)).toMatchObject({ outcome: 'applied', label_id: 'p3' });
    expect(gmailLabels(h, mail(11).id)).toEqual(['INBOX', 'UNREAD', oldPriority].sort());
    await savePrompt('Updated synthetic base.', 'Updated synthetic rules.');
    deliver(h, mail(14), T0 + HOUR + MINUTE);
    await h.step(T0 + HOUR + 2 * MINUTE);
    expect(h.up.codex.requests[1]?.instructions.map(block => block.text).join('\n\n')).toBe('Updated synthetic base.\n\nUpdated synthetic rules.');
    expect(h.up.codex.calls.flat().map(email => email.id)).toEqual([mail(12).id, mail(13).id, mail(14).id]);
    expect(modifies(h)).toHaveLength(3);
  });

  it('escapes a Claude monthly hold with Codex without charging it and retains the hold when switching back', async () => {
    await initialize();
    await h.sql(`INSERT INTO claude_usage (day, requests, input_tokens, output_tokens, cost_micros) VALUES ('2026-10-01', 1, 500, 100, 20000000)`);
    await h.sql(`INSERT INTO meta (key, value) VALUES ('claude_limited_month', '2026-10')`);
    deliver(h, mail(21), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'claude_spend_limit', decided: 0, deferred: 1 });
    const usage = await h.sql(`SELECT * FROM claude_usage`);
    await h.clock(T0 + 3 * MINUTE);
    await select(ClassificationProvider.CODEX);
    expect(h.up.codex.calls).toEqual([]);
    expect(modifies(h)).toEqual([]);
    expect(await h.step(T0 + 3 * MINUTE)).toMatchObject({ decided: 1, applied: 1 });
    expect(await decision(h, mail(21).id)).toMatchObject({ decider: 'codex', model: 'gpt-6.1-sol' });
    expect(await h.sql(`SELECT * FROM claude_usage`)).toEqual(usage);
    const codexUsage = (await h.api.getServiceStatus({ name: 'serviceStatus' })).codexUsage;
    expect(codexUsage).toMatchObject({ requestCount: 1, successCount: 1, usageReportedCount: 1, inputTokens: 1200, outputTokens: 120 });
    const flow = await h.api.getMailFlow({ name: 'mailFlows/today' });
    expect(flow.counts.filter(row => row.stage === MailFlow_Stage.DEFERRED).reduce((sum, row) => sum + row.mailCount, 0)).toBe(0);
    expect(flow.counts.filter(row => row.stage === MailFlow_Stage.CODEX).reduce((sum, row) => sum + row.mailCount, 0)).toBe(1);
    await h.clock(T0 + 4 * MINUTE);
    await select(ClassificationProvider.CLAUDE);
    deliver(h, mail(22), T0 + 5 * MINUTE);
    expect(await h.step(T0 + 6 * MINUTE)).toMatchObject({ code: 'claude_spend_limit', decided: 0 });
    expect(h.up.codex.calls).toHaveLength(1);
    expect(h.up.claude.calls).toEqual([]);
    expect(await h.sql(`SELECT * FROM claude_usage`)).toEqual(usage);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).claudeBudget).toMatchObject({ spentUsd: 20, providerLimitReached: true });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).codexUsage).toEqual(codexUsage);
    expect(await decision(h, mail(22).id)).toBeUndefined();
    expect(modifies(h)).toHaveLength(1);
  });

  it('backs off an invalid Codex batch without partial priorities or falling back to Claude', async () => {
    await initialize();
    await select(ClassificationProvider.CODEX);
    h.up.codex.badItems = true;
    deliver(h, mail(31), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'codex_bad_answer', decided: 0, applied: 0 });
    expect(await h.sql(`SELECT attempts, not_before FROM pending`)).toEqual([{ attempts: 1, not_before: T0 + 7 * MINUTE }]);
    expect(await decision(h, mail(31).id)).toBeUndefined();
    expect(modifies(h)).toEqual([]);
    expect(h.up.claude.calls).toEqual([]);
    expect(await h.sql(`SELECT requests FROM claude_usage`)).toEqual([]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).classifier?.lastErrorCode).toBe('codex_bad_answer');
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).codexUsage).toMatchObject({ requestCount: 1, successCount: 0, failureCount: 1, usageReportedCount: 1, inputTokens: 1200, outputTokens: 120 });
    h.up.codex.badItems = false;
    expect(await h.step(T0 + 7 * MINUTE)).toMatchObject({ decided: 1, applied: 1 });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).classifier?.lastErrorCode).toBe('');
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).codexUsage).toMatchObject({ requestCount: 2, successCount: 1, failureCount: 1, usageReportedCount: 2, inputTokens: 2400, outputTokens: 240 });
    expect(h.up.claude.calls).toEqual([]);
  });

  it('leaves missing Codex configuration pending without trying the configured Claude API', async () => {
    await initialize();
    h.up.codex.configured = false;
    await select(ClassificationProvider.CODEX);
    deliver(h, mail(41), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'codex_not_configured', decided: 0, applied: 0 });
    expect(await h.sql(`SELECT attempts FROM pending`)).toEqual([{ attempts: 0 }]);
    expect(h.up.codex.calls).toEqual([]);
    expect(h.up.claude.calls).toEqual([]);
    expect(modifies(h)).toEqual([]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).classifier).toMatchObject({ provider: ClassificationProvider.CODEX, configured: false, lastErrorCode: 'codex_not_configured' });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).codexUsage).toMatchObject({ requestCount: 0, failureCount: 0 });
  });

  it('records an HTTP failure as one attempted request without inventing token usage', async () => {
    await initialize();
    await select(ClassificationProvider.CODEX);
    h.up.codex.errorReason = 'MODEL_UNAVAILABLE';
    h.up.codex.errorCode = 14;
    deliver(h, mail(42), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'codex_unavailable', decided: 0, applied: 0 });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).codexUsage).toMatchObject({ requestCount: 1, successCount: 0, failureCount: 1, usageReportedCount: 0, inputTokens: 0, outputTokens: 0, lastRequestTime: timestampFromMs(T0 + 2 * MINUTE) });
    expect(modifies(h)).toEqual([]);
  });

  it('keeps a valid classification with unavailable legacy token usage separate from reported zero tokens', async () => {
    await initialize();
    await select(ClassificationProvider.CODEX);
    h.up.codex.inputTokens = 0;
    h.up.codex.outputTokens = 0;
    h.up.codex.usageAvailable = false;
    deliver(h, mail(43), T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).codexUsage).toMatchObject({ requestCount: 1, successCount: 1, usageReportedCount: 0 });
    h.up.codex.usageAvailable = true;
    deliver(h, mail(44), T0 + HOUR + MINUTE);
    await h.step(T0 + HOUR + 2 * MINUTE);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).codexUsage).toMatchObject({ requestCount: 2, successCount: 2, usageReportedCount: 1, inputTokens: 0, outputTokens: 0 });
  });

  it('switches only the model and its deferred work while retaining write limits and Gmail retry times', async () => {
    await initialize();
    await h.sql(`UPDATE meta SET value = json_set(value, '$.runWriteLimit', 2, '$.dailyWriteLimit', 7) WHERE key = 'settings'`);
    await h.sql(`INSERT INTO pending (message_id, added_at, not_before, attempts, deferred) VALUES ('model-held', ?, ?, 0, ?), ('gmail-retry', ?, ?, 2, 0)`, T0, T0 + HOUR, T0, T0, T0 + HOUR);
    await h.sql(`INSERT INTO meta (key, value) VALUES ('next_model_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(T0 + HOUR));
    const before = await h.api.getSettings({ name: 'settings' });
    const googleCalls = h.up.gmail.calls.length;
    await h.clock(T0 + 3 * MINUTE);
    const saved = await select(ClassificationProvider.CODEX);
    expect(saved).toMatchObject({ classificationProvider: ClassificationProvider.CODEX, mode: before.mode, effectiveMode: before.effectiveMode, runWriteLimit: 2, dailyWriteLimit: 7 });
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'next_model_at'`)).toEqual([{ value: String(T0 + 3 * MINUTE) }]);
    expect(await h.sql(`SELECT message_id, not_before, attempts, deferred FROM pending ORDER BY message_id`)).toEqual([
      { message_id: 'gmail-retry', not_before: T0 + HOUR, attempts: 2, deferred: 0 },
      { message_id: 'model-held', not_before: T0 + 3 * MINUTE, attempts: 0, deferred: T0 },
    ]);
    expect(h.up.gmail.calls).toHaveLength(googleCalls);
    expect(h.up.codex.calls).toEqual([]);
    expect(h.up.claude.calls).toEqual([]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).unreadClassification).toBeUndefined();
  });
});
