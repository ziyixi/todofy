/** Reading the Worker's vars (src/config.ts): the canary switch and hour. */
import { describe, expect, it } from 'vitest';
import { canaryEnabled, canaryHour } from '../src/config.ts';

describe('CANARY_ENABLED', () => {
  it('is on when unset, empty or true', () => {
    expect(canaryEnabled({})).toBe(true);
    expect(canaryEnabled({ CANARY_ENABLED: '' })).toBe(true);
    expect(canaryEnabled({ CANARY_ENABLED: 'true' })).toBe(true);
    expect(canaryEnabled({ CANARY_ENABLED: ' true ' })).toBe(true);
  });

  it('is off for false and for any value it cannot read (the switch exists to stop canaries)', () => {
    for (const value of ['false', ' false', 'False', 'TRUE', '0', '1', 'no', 'yes', 'off', 'on']) {
      expect(canaryEnabled({ CANARY_ENABLED: value }), value).toBe(false);
    }
  });
});

describe('CANARY_UTC_HOUR', () => {
  it('reads 0-23 and falls back to 16', () => {
    expect(canaryHour({})).toBe(16);
    expect(canaryHour({ CANARY_UTC_HOUR: '0' })).toBe(0);
    expect(canaryHour({ CANARY_UTC_HOUR: '23' })).toBe(23);
    for (const value of ['24', '-1', '1.5', 'x', '']) expect(canaryHour({ CANARY_UTC_HOUR: value }), value).toBe(16);
  });
});
