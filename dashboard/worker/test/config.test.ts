/** Reading the Worker's vars (src/config.ts): the canary switch and hour, and the dev clock. */
import { describe, expect, it } from 'vitest';
import { canaryEnabled, canaryHour, devNow } from '../src/config.ts';

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

describe('DEV_NOW', () => {
  it('reads an RFC 3339 UTC instant', () => {
    expect(devNow({ DEV_NOW: '2026-10-01T12:00:00Z' })).toBe(Date.UTC(2026, 9, 1, 12));
    expect(devNow({ DEV_NOW: ' 2026-10-01T23:59:30.250Z ' })).toBe(Date.UTC(2026, 9, 1, 23, 59, 30, 250));
  });

  it('is null (the object reads its own clock) when unset or anything else', () => {
    expect(devNow({})).toBeNull();
    for (const value of ['', '2026-10-01', '2026-10-01 12:00:00', '2026-10-01T12:00:00+02:00', '2026-10-01T12:00:00', '1759320000000', 'now', '2026-13-01T00:00:00Z']) {
      expect(devNow({ DEV_NOW: value }), value).toBeNull();
    }
  });
});
