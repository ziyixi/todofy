import { describe, expect, it } from 'vitest';
import { GUARD_CLEAR_PERCENT, GUARD_SHED_PERCENT, QUOTA_RESOURCES } from '../src/api-types.ts';
import worker, { HomeState } from '../src/index.ts';

describe('scaffold', () => {
  it('exports the default handlers and the Durable Object class', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
    expect(typeof HomeState).toBe('function');
  });

  it('keeps the guard hysteresis and one row per quota resource', () => {
    expect(GUARD_CLEAR_PERCENT).toBeLessThan(GUARD_SHED_PERCENT);
    expect(new Set(QUOTA_RESOURCES).size).toBe(QUOTA_RESOURCES.length);
  });
});
