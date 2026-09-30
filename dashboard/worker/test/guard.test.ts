import { describe, expect, it } from 'vitest';
import schema from '../../../contracts/ops-v1/ops-v1.schema.json';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import shedFixture from '../../../contracts/ops-v1/fixtures/GuardState/shed-mail-hero.json';
import normalFixture from '../../../contracts/ops-v1/fixtures/GuardState/normal.json';
import { OPS_LIMITS, type GuardState } from '../../../contracts/ops-v1/ops-v1.ts';
import type { QuotaRow } from '../src/api-types.ts';
import { parseUsage } from '../src/usage.ts';
import { graphqlBody } from './graphql-fixture.ts';
import {
  AUTO_NORMAL,
  AUTO_UNKNOWN,
  NO_APPLIED,
  desiredGuard,
  evaluateAuto,
  guardInput,
  hoursLeft,
  needsApply,
  ownerOverride,
  reachesPercent,
  settled,
  usableTriggerRows,
  usageFresh,
  type AutoGuard,
  type UsageSnapshot,
} from '../src/guard.ts';

const SCHEMA = schema as { $defs: Record<string, unknown> };
const T = (s: string): number => Date.parse(s);

function quota(id: QuotaRow['id'], percent: number | null, trigger = true): QuotaRow {
  return {
    id,
    period: !trigger ? 'storage' : id.startsWith('r2_') ? 'monthly' : 'daily',
    unit: 'rows',
    used: percent,
    limit: 100,
    percent,
    projected: null,
    projected_percent: null,
    guard_trigger: trigger,
    truncated: false,
    breakdown: [],
    source: 'https://developers.cloudflare.com/',
  };
}

function usage(at: number, rows: QuotaRow[]): UsageSnapshot {
  const day = new Date(at).toISOString().slice(0, 10);
  return { fetched_at: at, day, month: `${day.slice(0, 7)}-01`, rows };
}

describe('usage freshness', () => {
  it('needs the same UTC day and at most 90 minutes of age', () => {
    const at = T('2026-09-29T10:00:00Z');
    expect(usageFresh(usage(at, []), at + 90 * 60_000)).toBe(true);
    expect(usageFresh(usage(at, []), at + 91 * 60_000)).toBe(false);
    expect(usageFresh(usage(T('2026-09-29T23:30:00Z'), []), T('2026-09-30T00:00:00Z'))).toBe(false);
    expect(usageFresh(null, at)).toBe(false);
  });
});

describe('the automatic rule', () => {
  const at = T('2026-09-29T14:00:00Z');

  it('enters shed at 80 % of the highest trigger resource, until next midnight + 60 min', () => {
    const auto = evaluateAuto(at, usage(at, [quota('workers_requests', 50), quota('d1_rows_read', 81.5)]), null);
    expect(auto).toEqual({
      level: 'shed',
      reason: 'quota_d1_rows_read',
      until: T('2026-09-30T01:00:00Z'),
      entered_day: '2026-09-29',
      entered_at: at,
    });
    expect(evaluateAuto(at, usage(at, [quota('d1_rows_read', 79.9)]), null)).toEqual(AUTO_NORMAL);
  });

  it('never triggers on storage', () => {
    expect(evaluateAuto(at, usage(at, [quota('d1_storage', 99, false)]), null).level).toBe('normal');
  });

  it('holds at 70 % or more on the same day and clears below', () => {
    const shed = evaluateAuto(at, usage(at, [quota('do_rows_written', 85)]), null);
    const later = at + 3 * 3_600_000;
    const held = evaluateAuto(later, usage(later, [quota('do_rows_written', 70)]), shed);
    expect(held).toEqual(shed);
    expect(evaluateAuto(later, usage(later, [quota('do_rows_written', 69.9)]), shed)).toEqual(AUTO_NORMAL);
  });

  it('starts a new UTC day normal and re-enters (renews) only at 80 %', () => {
    const shed = evaluateAuto(at, usage(at, [quota('r2_class_a', 90)]), null);
    const midnight = T('2026-09-30T00:00:00Z');
    expect(evaluateAuto(midnight, usage(midnight, [quota('r2_class_a', 75)]), shed)).toEqual(AUTO_NORMAL);
    const renewed = evaluateAuto(midnight, usage(midnight, [quota('r2_class_a', 81)]), shed);
    expect(renewed).toMatchObject({ level: 'shed', entered_day: '2026-09-30', until: T('2026-10-01T01:00:00Z') });
    // Renewed before the old until expired.
    expect(midnight).toBeLessThan(shed.until ?? 0);
  });

  it('without fresh usage keeps a shed until it lapses, and never enters one', () => {
    const shed = evaluateAuto(at, usage(at, [quota('d1_rows_read', 90)]), null);
    const stale = usage(at, [quota('d1_rows_read', 90)]);
    const later = at + 2 * 3_600_000;
    expect(evaluateAuto(later, stale, shed)).toEqual(shed);
    expect(evaluateAuto(T('2026-09-30T01:00:00Z'), stale, shed)).toEqual(AUTO_UNKNOWN);
    expect(evaluateAuto(later, stale, null)).toEqual(AUTO_UNKNOWN);
    expect(evaluateAuto(later, null, null)).toEqual(AUTO_UNKNOWN);
    // Without data the reason says so (the UI must not claim "配额正常").
    expect(AUTO_UNKNOWN).toMatchObject({ level: 'normal', reason: 'usage_unknown' });
    expect(desiredGuard(later, AUTO_UNKNOWN, null)).toEqual({ level: 'normal', reason: 'usage_unknown', until: null, source: 'auto' });
  });

  it('keeps a monthly R2 shed across midnight when GraphQL fails at the day change (no flap)', () => {
    // Yesterday 23:30: R2 Class A at 85 % of the month; the auto shed lasts until 01:00.
    const lastFetch = T('2026-09-29T23:30:00Z');
    const snapshot = usage(lastFetch, [quota('d1_rows_read', 90), quota('r2_class_a', 85)]);
    const shed = evaluateAuto(lastFetch, snapshot, null);
    expect(shed).toMatchObject({ level: 'shed', reason: 'quota_d1_rows_read', until: T('2026-09-30T01:00:00Z') });
    // 00:00 and 00:30 fetches fail: the daily row no longer counts, the monthly one still does.
    expect(usableTriggerRows(snapshot, T('2026-09-30T00:30:00Z'))?.map((row) => row.id)).toEqual(['r2_class_a']);
    const at0000 = evaluateAuto(T('2026-09-30T00:00:00Z'), snapshot, shed);
    expect(at0000).toMatchObject({ level: 'shed', reason: 'quota_r2_class_a', entered_day: '2026-09-30', until: T('2026-10-01T01:00:00Z') });
    const at0030 = evaluateAuto(T('2026-09-30T00:30:00Z'), snapshot, at0000);
    expect(desiredGuard(T('2026-09-30T00:30:00Z'), at0030, null)).toMatchObject({ level: 'shed', reason: 'quota_r2_class_a' });
    // With only a daily resource high, the new day starts normal, as with fresh data.
    const dailyOnly = usage(lastFetch, [quota('d1_rows_read', 90), quota('r2_class_a', 20)]);
    expect(evaluateAuto(T('2026-09-30T00:30:00Z'), dailyOnly, evaluateAuto(lastFetch, dailyOnly, null))).toEqual(AUTO_NORMAL);
    // Beyond the 90-minute window, or into a new month, nothing carries over.
    expect(usableTriggerRows(snapshot, T('2026-09-30T01:01:00Z'))).toBeNull();
    const monthEnd = usage(T('2026-09-30T23:30:00Z'), [quota('r2_class_a', 85)]);
    expect(usableTriggerRows(monthEnd, T('2026-10-01T00:00:00Z'))).toBeNull();
    // Snapshots stored before the month field existed never carry over.
    expect(usableTriggerRows({ fetched_at: lastFetch, day: '2026-09-29', rows: snapshot.rows }, T('2026-09-30T00:00:00Z'))).toBeNull();
  });
});

describe('thresholds on measured usage, not the rounded percent', () => {
  const at = T('2026-09-15T12:00:00Z');
  // Real rows from parseUsage: percent is rounded to 0.1, so 79.95 % reads 80.0.
  const d1 = (rowsRead: number): QuotaRow[] => parseUsage(graphqlBody({ d1RowsRead: rowsRead }), at)?.rows ?? [];
  const r2 = (puts: number): QuotaRow[] =>
    parseUsage(graphqlBody({ r2Ops: [{ actionType: 'PutObject', bucketName: 'b', requests: puts }] }), at)?.rows ?? [];

  it('does not shed at 79.95 % although it displays as 80 %', () => {
    const rows = d1(3_997_500);
    expect(rows.find((row) => row.id === 'd1_rows_read')?.percent).toBe(80);
    expect(evaluateAuto(at, usage(at, rows), null)).toEqual(AUTO_NORMAL);
    expect(evaluateAuto(at, usage(at, r2(799_950)), null)).toEqual(AUTO_NORMAL);
    expect(evaluateAuto(at, usage(at, d1(4_000_000)), null)).toMatchObject({ level: 'shed', reason: 'quota_d1_rows_read' });
    expect(evaluateAuto(at, usage(at, r2(800_000)), null)).toMatchObject({ level: 'shed', reason: 'quota_r2_class_a' });
  });

  it('clears at 69.95 % although it displays as 70 %', () => {
    const shed = evaluateAuto(at, usage(at, d1(4_000_000)), null);
    const later = at + 3_600_000;
    expect(evaluateAuto(later, usage(later, d1(3_500_000)), shed)).toEqual(shed);
    const edge = d1(3_497_500);
    expect(edge.find((row) => row.id === 'd1_rows_read')?.percent).toBe(70);
    expect(evaluateAuto(later, usage(later, edge), shed)).toEqual(AUTO_NORMAL);
  });

  it('compares used with the allowance', () => {
    expect(reachesPercent({ used: 80, limit: 100 }, 80)).toBe(true);
    expect(reachesPercent({ used: 79.99, limit: 100 }, 80)).toBe(false);
    expect(reachesPercent({ used: null, limit: 100 }, 80)).toBe(false);
  });
});

describe('a shed continuing across midnight', () => {
  it('stays in force through the 00:30 retry when the 00:00 renewal call fails', () => {
    // R2 Class A at 85 % of the month: shed at 23:30, renewed by the 00:00 tick's evaluation.
    const lastFetch = T('2026-09-15T23:30:00Z');
    const shed = evaluateAuto(lastFetch, usage(lastFetch, [quota('r2_class_a', 85)]), null);
    const renewed = evaluateAuto(T('2026-09-16T00:00:00Z'), usage(T('2026-09-16T00:00:00Z'), [quota('r2_class_a', 85)]), shed);
    // The apps hold the 23:30 input when the 00:00 setGuard failed; the retry comes with the 00:30 tick
    // (possibly late), and the stored until must still be ahead of it.
    const stored = Date.parse(guardInput(desiredGuard(lastFetch, shed, null), lastFetch).until ?? '');
    expect(stored).toBeGreaterThan(T('2026-09-16T00:30:00Z') + 20 * 60_000);
    const retry = T('2026-09-16T00:30:00Z');
    expect(needsApply(guardInput(desiredGuard(retry, renewed, null), retry), { ...NO_APPLIED, input: guardInput(desiredGuard(lastFetch, shed, null), lastFetch), consecutive_failures: 1 }, null)).toBe(true);
    // And never more than the contract's 36 h ahead.
    expect((renewed.until ?? 0) - T('2026-09-16T00:00:00Z')).toBeLessThanOrEqual(OPS_LIMITS.guardMaxAheadSeconds * 1000);
  });
});

describe('desired guard and overrides', () => {
  const now = T('2026-09-29T14:00:00Z');
  const shed: AutoGuard = { level: 'shed', reason: 'quota_d1_rows_read', until: T('2026-09-30T01:00:00Z'), entered_day: '2026-09-29', entered_at: now };

  it('follows the automatic decision without an override', () => {
    expect(desiredGuard(now, null, null)).toEqual({ level: 'normal', reason: 'quota_normal', until: null, source: 'none' });
    expect(desiredGuard(now, shed, null)).toEqual({ level: 'shed', reason: 'quota_d1_rows_read', until: shed.until, source: 'auto' });
    expect(desiredGuard(T('2026-09-30T01:00:00Z'), shed, null).level).toBe('normal');
  });

  it('lets the owner force shed for 24 h, or clear until the next UTC midnight', () => {
    const force = ownerOverride('shed', now);
    expect(force).toEqual({ level: 'shed', until: now + 86_400_000, set_at: now });
    expect(desiredGuard(now, null, force)).toEqual({ level: 'shed', reason: 'owner_shed', until: force.until, source: 'owner' });
    const clear = ownerOverride('normal', now);
    expect(clear.until).toBe(T('2026-09-30T00:00:00Z'));
    expect(desiredGuard(now, shed, clear)).toEqual({ level: 'normal', reason: 'owner_clear', until: null, source: 'owner' });
    // Expired overrides no longer count.
    expect(desiredGuard(clear.until, shed, clear).source).toBe('auto');
  });

  it('produces SetGuardInput values the contract accepts, at most 36 h ahead', () => {
    for (const desired of [desiredGuard(now, shed, null), desiredGuard(now, null, ownerOverride('shed', now)), desiredGuard(now, null, null)]) {
      const input = guardInput(desired, now);
      expect(validate(SCHEMA, 'SetGuardInput', input)).toEqual([]);
      if (input.until !== null) expect(Date.parse(input.until) - now).toBeLessThanOrEqual(OPS_LIMITS.guardMaxAheadSeconds * 1000);
    }
    const far = guardInput({ level: 'shed', reason: 'owner_shed', until: now + 40 * 3_600_000, source: 'owner' }, now);
    expect(Date.parse(far.until ?? '') - now).toBeLessThan(OPS_LIMITS.guardMaxAheadSeconds * 1000);
  });

  it('reports hours left with one decimal', () => {
    expect(hoursLeft(now + 5_400_000, now)).toBe(1.5);
    expect(hoursLeft(null, now)).toBe(0);
  });
});

describe('applying the guard', () => {
  const now = T('2026-09-29T14:05:00Z');
  const shedInput = { level: 'shed', reason: 'd1_reads_high', until: '2026-09-30T00:00:00.000Z' } as const;
  const normalInput = { level: 'normal', reason: 'quota_normal', until: null } as const;
  const shedState = shedFixture as GuardState;
  const normalState = normalFixture as GuardState;
  const applied = { input: shedInput, state: shedState, last_call_at: now, last_error: null, consecutive_failures: 0 };

  it('calls on a change and stays quiet in a steady state', () => {
    expect(needsApply(shedInput, NO_APPLIED, null)).toBe(true);
    expect(needsApply(shedInput, applied, null)).toBe(false);
    expect(needsApply(shedInput, applied, shedState)).toBe(false);
    expect(needsApply({ ...shedInput, until: '2026-10-01T00:00:00.000Z' }, applied, shedState)).toBe(true);
  });

  it('re-applies when the app lost the state or the last call failed', () => {
    expect(needsApply(shedInput, applied, normalState)).toBe(true);
    expect(needsApply(shedInput, { ...applied, consecutive_failures: 1, last_error: 'unavailable' }, null)).toBe(true);
  });

  it('drops pending failures once no call is needed', () => {
    const failed = { ...NO_APPLIED, last_call_at: now, last_error: 'unavailable', consecutive_failures: 2 } as const;
    // shed failed twice and was never applied; now normal is wanted and nothing needs sending.
    expect(needsApply(normalInput, failed, null)).toBe(false);
    expect(settled(failed)).toEqual({ ...failed, last_error: null, consecutive_failures: 0 });
    expect(settled(applied)).toBe(applied);
  });

  it('sends normal only to an app that is, or was last left, shed', () => {
    expect(needsApply(normalInput, NO_APPLIED, normalState)).toBe(false);
    expect(needsApply(normalInput, NO_APPLIED, null)).toBe(false);
    expect(needsApply(normalInput, applied, null)).toBe(true);
    expect(needsApply(normalInput, NO_APPLIED, shedState)).toBe(true);
    expect(needsApply(normalInput, { ...NO_APPLIED, input: normalInput }, normalState)).toBe(false);
  });
});
