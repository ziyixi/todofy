import { describe, expect, it } from 'vitest';
import { adoptClassificationInterval, DEFAULTS, effectiveMode, readSettings, writeSettings } from '../src/settings.ts';
import { Store } from '../src/store.ts';
import { memorySql } from './fakes/sql.ts';

const NOW = Date.parse('2026-10-25T12:00:00Z');

function store(): Store {
  const value = new Store(memorySql());
  value.migrate();
  return value;
}

describe('classification provider settings', () => {
  it('defaults new and legacy settings to Claude', () => {
    const value = store();
    expect(readSettings(value).classificationProvider).toBe('claude');
    value.setMeta('settings', JSON.stringify({ mode: 'live', breaker: 'daily_limit', etag: 'legacy' }));
    expect(readSettings(value)).toMatchObject({ classificationProvider: 'claude', mode: 'live', breaker: 'daily_limit', etag: 'legacy' });
  });

  it('reads a persisted fixed provider choice and preserves mode and breaker', () => {
    const sql = memorySql();
    const value = new Store(sql);
    value.migrate();
    const saved = writeSettings(value, { ...DEFAULTS, mode: 'live', breaker: 'daily_limit', classificationProvider: 'codex' }, NOW);
    expect(readSettings(new Store(sql))).toEqual(saved);
    expect(effectiveMode(saved, 'live')).toBe('shadow');
    expect(writeSettings(value, { ...saved, classificationProvider: 'claude' }, NOW + 1)).toMatchObject({ mode: 'live', breaker: 'daily_limit', classificationProvider: 'claude' });
  });
});

describe('automatic classification interval', () => {
  it('adopts 15 minutes once, converts a legacy idle hour and survives reopening', () => {
    const sql = memorySql();
    const value = new Store(sql);
    value.migrate();
    value.setMeta('settings', JSON.stringify({ mode: 'live', classificationProvider: 'codex', breaker: 'daily_limit', dailyWriteLimit: 19, etag: 'legacy' }));
    value.setMeta('next_model_at', String(NOW + 50 * 60_000));
    expect(readSettings(value).classificationIntervalMinutes).toBe(15);
    const saved = adoptClassificationInterval(value, NOW);
    expect(saved).toMatchObject({ classificationIntervalMinutes: 15, mode: 'live', classificationProvider: 'codex', breaker: 'daily_limit', dailyWriteLimit: 19 });
    expect(value.getMeta('next_model_at')).toBe(String(NOW + 5 * 60_000));
    expect(adoptClassificationInterval(value, NOW + 60_000)).toEqual(saved);
    expect(value.getMeta('next_model_at')).toBe(String(NOW + 5 * 60_000));
    expect(readSettings(new Store(sql))).toEqual(saved);
  });

  it('adjusts a future ordinary wait from the previous interval without changing current mode', () => {
    const value = store();
    writeSettings(value, { ...DEFAULTS, classificationIntervalMinutes: 15 }, NOW);
    value.setMeta('next_model_at', String(NOW + 10 * 60_000));
    writeSettings(value, { ...readSettings(value), classificationIntervalMinutes: 30 }, NOW);
    expect(value.getMeta('next_model_at')).toBe(String(NOW + 25 * 60_000));
    writeSettings(value, { ...readSettings(value), classificationIntervalMinutes: 5 }, NOW);
    expect(value.getMeta('next_model_at')).toBe(String(NOW));
    expect(readSettings(value).mode).toBe('shadow');
  });

  it.each([
    { attempts: 1, deferred: 0, notBefore: NOW + 5 * 60_000 },
    { attempts: 0, deferred: NOW, notBefore: NOW + 24 * 60 * 60_000 },
    { attempts: 0, deferred: 0, notBefore: NOW + 5 * 60_000 },
  ])('preserves a pending retry, quota or write wait: $attempts/$deferred', ({ attempts, deferred, notBefore }) => {
    const value = store();
    writeSettings(value, { ...DEFAULTS, classificationIntervalMinutes: 60 }, NOW);
    value.run('INSERT INTO pending(message_id,added_at,not_before,attempts,deferred) VALUES(?,?,?,?,?)', 'synthetic-pending', NOW, notBefore, attempts, deferred);
    value.setMeta('next_model_at', String(notBefore));
    writeSettings(value, { ...readSettings(value), classificationIntervalMinutes: 5 }, NOW);
    expect(value.getMeta('next_model_at')).toBe(String(notBefore));
    expect(value.one('SELECT not_before,attempts,deferred FROM pending')).toEqual({ not_before: notBefore, attempts, deferred });
  });

  it.each(['claude', 'codex'] as const)('preserves a %s quota hold even without pending rows', (provider) => {
    const value = store();
    writeSettings(value, { ...DEFAULTS, classificationProvider: provider, classificationIntervalMinutes: 60 }, NOW);
    if (provider === 'claude') value.run("INSERT INTO claude_usage(day,requests,cost_micros) VALUES('2026-10-25',1,20000000)");
    else value.setMeta('codex_error', 'codex_quota');
    value.setMeta('next_model_at', String(NOW + 60 * 60_000));
    writeSettings(value, { ...readSettings(value), classificationIntervalMinutes: 5 }, NOW);
    expect(value.getMeta('next_model_at')).toBe(String(NOW + 60 * 60_000));
  });
});
