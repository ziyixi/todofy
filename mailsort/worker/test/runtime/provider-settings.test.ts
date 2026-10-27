import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClassificationProvider, Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { HOUR, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';

describe('classification provider settings and status', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.dispose(); });

  it('defaults legacy settings to Claude and preserves mode, limits, breaker and existing work when switching', async () => {
    await h.sql(`INSERT INTO meta (key, value) VALUES ('settings', ?), ('next_model_at', ?), ('claude_limited_month', '2026-10'), ('claude_error', 'claude_spend_limit')`,
      JSON.stringify({ mode: 'live', runWriteLimit: 3, dailyWriteLimit: 19, dailyNeuronBudget: 7000, breaker: 'daily_limit', etag: 'legacy' }), String(T0 + HOUR));
    const before = await h.api.getSettings({ name: 'settings' });
    expect(before.classificationProvider).toBe(ClassificationProvider.CLAUDE);
    const requestId = op();
    const request = {
      settings: create(SettingsSchema, { name: 'settings', classificationProvider: ClassificationProvider.CODEX, mode: Mode.OFF, etag: before.etag }),
      updateMask: { paths: ['classification_provider', 'etag'] }, requestId,
    };
    const saved = await h.api.updateSettings(request);
    expect(saved).toEqual({ ...before, classificationProvider: ClassificationProvider.CODEX, etag: saved.etag });
    expect(saved.etag).not.toBe(before.etag);
    expect(await h.api.getSettings({ name: 'settings' })).toEqual(saved);
    expect(await h.api.updateSettings(request)).toEqual(saved);
    expect(reasonOf(await rejection(h.api.updateSettings({ ...request, requestId: op() })))).toBe('ETAG_MISMATCH');
    const stored = await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'settings'`);
    expect(JSON.parse(stored[0]?.value ?? '{}')).toMatchObject({ classificationProvider: 'codex', mode: 'live', breaker: 'daily_limit' });
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'next_model_at'`)).toEqual([{ value: String(T0) }]);
    expect(await h.sql(`SELECT key FROM meta WHERE key IN ('claude_limited_month', 'claude_error') ORDER BY key`)).toEqual([{ key: 'claude_error' }, { key: 'claude_limited_month' }]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).unreadClassification).toBeUndefined();
    expect(h.up.gmail.calls).toHaveLength(0);
    expect(h.up.claude.calls).toHaveLength(0);
  });

  it('preserves a future schedule and deferred work when the selected provider stays the same', async () => {
    await h.sql(`INSERT INTO meta (key, value) VALUES ('settings', '{"classificationProvider":"codex","classificationIntervalMinutes":60}'), ('next_model_at', ?)`, String(T0 + HOUR));
    await h.sql(`INSERT INTO pending (message_id, added_at, not_before, deferred) VALUES ('synthetic-held', ?, ?, ?)`, T0, T0 + HOUR, T0);
    const current = await h.api.getSettings({ name: 'settings' });
    await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', classificationProvider: ClassificationProvider.CODEX, etag: current.etag }),
      updateMask: { paths: ['classification_provider', 'etag'] }, requestId: op(),
    });
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'next_model_at'`)).toEqual([{ value: String(T0 + HOUR) }]);
    expect(await h.sql(`SELECT not_before, deferred FROM pending`)).toEqual([{ not_before: T0 + HOUR, deferred: T0 }]);
    expect(h.up.gmail.calls).toHaveLength(0);
    expect(h.up.codex.calls).toHaveLength(0);
    expect(h.up.claude.calls).toHaveLength(0);
  });

  it('refuses an unspecified provider and requires the provider in the update mask', async () => {
    const before = await h.api.getSettings({ name: 'settings' });
    const rejected = await rejection(h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings' }), updateMask: { paths: ['classification_provider'] }, requestId: op(),
    }));
    expect(reasonOf(rejected)).toBe('INVALID_SETTINGS');
    expect(await h.api.getSettings({ name: 'settings' })).toEqual(before);
    const saved = await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', classificationProvider: ClassificationProvider.CODEX, dailyWriteLimit: 22 }),
      updateMask: { paths: ['daily_write_limit'] }, requestId: op(),
    });
    expect(saved.classificationProvider).toBe(ClassificationProvider.CLAUDE);
    expect(saved.dailyWriteLimit).toBe(22);
  });

  it('reports selected Codex configuration and success separately from preserved Claude usage and refusal', async () => {
    await h.sql(`INSERT INTO meta (key, value) VALUES ('settings', ?), ('claude_error', 'claude_spend_limit'), ('claude_limited_month', '2026-10'),
      ('codex_error', 'codex_503'), ('codex_last_request_at', ?), ('codex_last_success_at', ?), ('next_model_at', ?)`,
    JSON.stringify({ classificationProvider: 'codex' }), String(T0), String(T0 - HOUR), String(T0 + HOUR));
    await h.sql(`INSERT INTO claude_usage (day, requests, input_tokens, output_tokens, cost_micros) VALUES ('2026-10-01', 1, 500, 100, 20000000)`);
    h.up.codex.configured = false;
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status).toMatchObject({
      decisionModel: 'models/sol-6-1',
      classifier: {
        provider: ClassificationProvider.CODEX, model: 'models/sol-6-1', effort: 'medium', configured: false,
        nextBatchTime: timestampFromMs(T0 + HOUR), lastSuccessTime: timestampFromMs(T0 - HOUR),
      },
      claudeBudget: { model: 'models/claude-opus-5-5', spentUsd: 20, providerLimitReached: true, lastErrorCode: 'claude_spend_limit' },
    });
    expect(status.classifier?.lastErrorCode).not.toBe('claude_spend_limit');
    expect(status.claudeBudget?.nextBatchTime).toBeUndefined();
    expect(status.codexUsage).toMatchObject({ requestCount: 0, successCount: 0, failureCount: 0, usageReportedCount: 0 });
    expect(status.codexUsage?.lastRequestTime).toBeUndefined();
  });

  it('does not interpret a historical request timestamp as a successful answer', async () => {
    await h.sql(`INSERT INTO meta (key, value) VALUES ('claude_last_request_at', ?), ('claude_error', 'claude_invalid')`, String(T0));
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.classifier).toMatchObject({ provider: ClassificationProvider.CLAUDE, model: 'models/claude-opus-5-5', effort: 'medium', configured: true, lastErrorCode: 'claude_invalid' });
    expect(status.classifier?.lastSuccessTime).toBeUndefined();
    expect(status.claudeBudget?.lastRequestTime).toEqual(timestampFromMs(T0));
  });
});

it.each([true, false])('reports Router catalog configuration (%s) without a model call', async configured => {
  const h = await startHarness();
  try {
    h.up.codex.configured = configured;
    await h.sql(`INSERT INTO meta (key, value) VALUES ('settings', '{"classificationProvider":"codex"}')`);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.classifier).toMatchObject({ provider: ClassificationProvider.CODEX, configured, lastErrorCode: configured ? '' : 'codex_not_configured' });
    expect(h.up.gmail.calls).toHaveLength(0);
    expect(h.up.codex.calls).toHaveLength(0);
  } finally { await h.dispose(); }
});
