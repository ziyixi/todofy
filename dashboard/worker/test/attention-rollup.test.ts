import { describe, expect, it } from 'vitest';
import { rollupAttention, sortAttention } from '../src/attention-rollup.ts';

const warning = { severity: 'warning' } as const;
const critical = { severity: 'critical' } as const;
const observedUnknown = { severity: 'warning', observed: 'unknown' } as const;

describe('attention rollup (evaluation, dispositions and the UI cache share it)', () => {
  it('is ok when every item was dismissed (no open item is left)', () => {
    expect(rollupAttention([])).toBe('ok');
  });

  it('is unknown before anything ran, whatever the items say', () => {
    expect(rollupAttention([], true)).toBe('unknown');
    expect(rollupAttention([critical], true)).toBe('unknown');
  });

  it('ranks an observed unknown above a warning and below a critical item', () => {
    expect(rollupAttention([warning, observedUnknown])).toBe('unknown');
    expect(rollupAttention([observedUnknown, critical])).toBe('critical');
    expect(rollupAttention([warning])).toBe('warning');
  });

  it('sorts in place into strip order, stable within a level', () => {
    const first = { ...warning, id: 1 }, second = { ...warning, id: 2 };
    const items = [first, observedUnknown, second, critical];
    expect(sortAttention(items)).toBe(items);
    expect(items).toEqual([critical, observedUnknown, first, second]);
  });
});
