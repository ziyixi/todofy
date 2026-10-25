import { describe, expect, it } from 'vitest';
import { DEFAULTS, effectiveMode, readSettings, writeSettings } from '../src/settings.ts';
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
