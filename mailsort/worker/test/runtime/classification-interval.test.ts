/** Persisted interval and schedule transitions in the real SQLite DO, with no mailbox operations. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { ClassificationProvider, Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { HOUR, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';

describe('automatic classification interval', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.dispose(); });

  it('adopts the former idle hour once, persists the choice and reports the adjusted next batch', async () => {
    await h.sql(`INSERT INTO meta(key,value) VALUES('settings', ?),('next_model_at', ?)`,
      JSON.stringify({ mode: 'off', classificationProvider: 'codex', dailyWriteLimit: 19, breaker: 'daily_limit', etag: 'old' }), String(T0 + HOUR));
    expect((await h.api.getSettings({ name: 'settings' })).classificationIntervalMinutes).toBe(15);
    expect(await h.sql(`SELECT value FROM meta WHERE key='next_model_at'`)).toEqual([{ value: String(T0 + HOUR) }]);
    expect(await h.step(T0 + MINUTE)).toMatchObject({ next: T0 + 6 * MINUTE, code: 'off' });
    const initial = await h.api.getSettings({ name: 'settings' });
    expect(initial).toMatchObject({ mode: Mode.OFF, classificationProvider: ClassificationProvider.CODEX, classificationIntervalMinutes: 15, dailyWriteLimit: 19, breakerTripped: true });
    await h.step(T0 + 2 * MINUTE);
    expect(await h.api.getSettings({ name: 'settings' })).toEqual(initial);
    expect(await h.sql(`SELECT value FROM meta WHERE key='next_model_at'`)).toEqual([{ value: String(T0 + 15 * MINUTE) }]);
    const request = {
      settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: 30, etag: initial.etag }),
      updateMask: { paths: ['classification_interval_minutes', 'etag'] }, requestId: op(),
    };
    const saved = await h.api.updateSettings(request);
    expect(saved).toMatchObject({ ...initial, classificationIntervalMinutes: 30, etag: saved.etag });
    expect(await h.api.updateSettings(request)).toEqual(saved);
    expect(reasonOf(await rejection(h.api.updateSettings({ ...request, requestId: op() })))).toBe('ETAG_MISMATCH');
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).classifier).toMatchObject({
      provider: ClassificationProvider.CODEX, classificationIntervalMinutes: 30, nextBatchTime: timestampFromMs(T0 + 30 * MINUTE),
    });
    const row = await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key='settings'`);
    expect(JSON.parse(row[0]?.value ?? '{}')).toMatchObject({ classificationIntervalMinutes: 30, mode: 'off', classificationProvider: 'codex', breaker: 'daily_limit' });
    expect(h.up.gmail.calls).toEqual([]);
    expect(h.up.claude.calls).toEqual([]);
    expect(h.up.codex.calls).toEqual([]);
  });

  it('refuses unsupported intervals and changes the interval only when its mask names it', async () => {
    const initial = await h.api.getSettings({ name: 'settings' });
    for (const minutes of [0, 1, 10, 120, -5]) {
      expect(reasonOf(await rejection(h.api.updateSettings({
        settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: minutes, etag: initial.etag }),
        updateMask: { paths: ['classification_interval_minutes'] }, requestId: op(),
      })))).toBe('INVALID_SETTINGS');
    }
    expect(await h.api.getSettings({ name: 'settings' })).toEqual(initial);
    const saved = await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: 5, classificationProvider: ClassificationProvider.CODEX, dailyWriteLimit: 22 }),
      updateMask: { paths: ['daily_write_limit'] }, requestId: op(),
    });
    expect(saved).toMatchObject({ classificationIntervalMinutes: 15, classificationProvider: ClassificationProvider.CLAUDE, dailyWriteLimit: 22 });
    for (const minutes of [5, 15, 30, 60]) {
      const value = await h.api.updateSettings({
        settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: minutes }),
        updateMask: { paths: ['classification_interval_minutes'] }, requestId: op(),
      });
      expect(value.classificationIntervalMinutes).toBe(minutes);
    }
  });

  it('keeps a pending retry deadline during default adoption and a later shorter interval save', async () => {
    await h.sql(`INSERT INTO meta(key,value) VALUES('settings','{"mode":"off"}'),('next_model_at',?)`, String(T0 + 10 * MINUTE));
    await h.sql(`INSERT INTO pending(message_id,added_at,attempts,not_before) VALUES('synthetic-retry',?,1,?)`, T0, T0 + 10 * MINUTE);
    await h.step(T0);
    const current = await h.api.getSettings({ name: 'settings' });
    expect(current.classificationIntervalMinutes).toBe(15);
    await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: 5, etag: current.etag }),
      updateMask: { paths: ['classification_interval_minutes'] }, requestId: op(),
    });
    expect(await h.sql(`SELECT value FROM meta WHERE key='next_model_at'`)).toEqual([{ value: String(T0 + 10 * MINUTE) }]);
    expect(await h.sql(`SELECT attempts,not_before FROM pending`)).toEqual([{ attempts: 1, not_before: T0 + 10 * MINUTE }]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).classifier).toMatchObject({ classificationIntervalMinutes: 5, nextBatchTime: timestampFromMs(T0 + 10 * MINUTE) });
    expect(h.up.gmail.calls).toEqual([]);
  });
});
