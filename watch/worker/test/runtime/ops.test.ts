/**
 * ops-v1 in workerd (../../../docs/design.md §7, contracts/ops-v1): the named entrypoint Ops of the Worker "watch"
 * called over a service binding, as the dashboard calls it. status() answers counts that a strict read of the contract
 * accepts and that never carry a watch's name, URL or page text, and arms a missing alarm (real alarms); setGuard()
 * sheds: scheduled checks wait for a day since the last one and the daily sweep waits, while an owner's check still
 * runs; an input the contract refuses rejects with invalid_input.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromWire } from '@ziyixi/proto/wire-json';
import { OpsStatusSchema } from '@ziyixi/proto/ops/v1/ops_pb';
import { STATUS_ROWS_MAX } from '../../src/ops-status.ts';
import { page } from '../fake-sites.ts';
import { DAY, HOUR, MINUTE, op, resetWatches, startHarness, T0, type Harness } from './harness.ts';

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

describe('the Ops entrypoint (manual alarms)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('status() counts what the inbox and the scheduler hold, in the contract, with no name or URL', async () => {
    h.sites.html('https://shop.example.org/kettle', page('Kettle', '<p>A synthetic kettle costs 30 dollars today.</p>'));
    await h.clock(T0);
    await h.api.createWatch({ watchId: 'kettle', requestId: op(), watch: { displayName: '合成：水壶', uri: 'https://shop.example.org/kettle', stability: { skipConfirmation: true } } });
    await h.run(T0);
    h.sites.html('https://shop.example.org/kettle', page('Kettle', '<p>A synthetic kettle costs 25 dollars today.</p>'));
    await h.clock(T0 + 7 * HOUR);
    await h.run(T0 + 7 * HOUR);
    const status = (await h.opsStatus()) as { app: string; health: string; counters: Record<string, number>; capabilities: string[]; modes: Record<string, boolean> };
    // A strict read by the generated codec: every rule of the contract holds.
    expect(() => fromWire(OpsStatusSchema, status, { strict: true })).not.toThrow();
    expect(status.app).toBe('watch');
    expect(status.health).toBe('ok');
    expect(status.capabilities).toEqual(['guard']);
    expect(status.modes).toEqual({ maintenance: false, notifications: false });
    expect(status.counters).toMatchObject({ watches_active: 1, watches_broken: 0, changes_new: 1, notifications_pending: 1 });
    const text = JSON.stringify(status);
    for (const leak of ['水壶', 'shop.example.org', 'kettle', 'dollars']) expect(text).not.toContain(leak);
    await resetWatches(h);
  });

  it('setGuard() sheds: a scheduled check waits a day since the last, an owner check runs, the sweep waits', async () => {
    const at = T0 + 10 * DAY;
    h.sites.html('https://news.example.org/a', page('A', '<p>Synthetic page A, checked every hour.</p>'));
    h.sites.html('https://blog.example.org/b', page('B', '<p>Synthetic page B, checked every hour.</p>'));
    await h.clock(at);
    for (const [id, url] of [['a', 'https://news.example.org/a'], ['b', 'https://blog.example.org/b']] as const) {
      await h.api.createWatch({ watchId: id, requestId: op(), watch: { displayName: id, uri: url, checkIntervalMinutes: 60, stability: { skipConfirmation: true } } });
    }
    await h.run(at);
    const before = await h.sql<{ id: string; last_check_at: number }>('SELECT id, last_check_at FROM watches ORDER BY id');
    expect(before.every((row) => row.last_check_at >= at)).toBe(true);

    const shed = await h.opsSetGuard({ level: 'shed', reason: 'do_rows_read_high', until: iso(at + DAY + HOUR) });
    expect(shed).toMatchObject({ level: 'shed', reason: 'do_rows_read_high', deferred: ['scheduled_checks', 'daily_sweep'] });
    // Two hours on: both are due by their schedule, neither is checked; the alarm sleeps (at most its idle interval).
    const { next, outcomes } = await h.step(at + 2 * HOUR);
    expect(outcomes).toEqual({});
    expect(next).toBe(at + 2 * HOUR + 6 * HOUR);
    // An owner's check is not deferred.
    await h.clock(at + 2 * HOUR);
    await h.api.checkWatch({ name: 'watches/a', requestId: op() });
    await h.run(at + 2 * HOUR);
    const after = await h.sql<{ id: string; last_check_at: number }>('SELECT id, last_check_at FROM watches ORDER BY id');
    expect(after.map((row) => [row.id, row.last_check_at >= at + 2 * HOUR])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    // status() shows the shed.
    const status = (await h.opsStatus()) as { guard: { level: string }; signals: { code: string }[] };
    expect(status.guard.level).toBe('shed');
    expect(status.signals.map((signal) => signal.code)).toContain('guard_shed');
    // The next UTC day, still shed: b, a day since its last check, is checked (the bound); a, checked by the owner
    // since, waits; the sweep of the new day waits.
    const swept = (await h.sql<{ value: string }>("SELECT value FROM meta WHERE key = 'swept_day'"))[0]?.value;
    expect(swept).toBe(iso(at).slice(0, 10));
    const bound = await h.step(at + DAY + 5 * MINUTE);
    expect(bound.outcomes).toEqual({ unchanged: 1 });
    expect((await h.sql<{ value: string }>("SELECT value FROM meta WHERE key = 'swept_day'"))[0]?.value).toBe(swept);
    // Back to normal: the schedule applies again at once.
    await h.clock(at + DAY + 5 * MINUTE);
    expect(await h.opsSetGuard({ level: 'normal', reason: 'quota_recovered', until: null })).toMatchObject({ level: 'normal', deferred: [] });
    const resumed = await h.step(at + DAY + 6 * MINUTE);
    expect(resumed.outcomes).toEqual({ unchanged: 1 });
    await resetWatches(h);
  });

  it('status() reads at most STATUS_ROWS_MAX rows at the bounds (SQLite rows are a budget, docs/design.md §8)', async () => {
    // The bounds: 50 watches, 1,000 new changes and more, 500 undelivered events, 300 intents of 30 days (a week of
    // them unsettled or ended badly, as many recorded today as Todofy allows).
    const at = T0 + 20 * DAY + 12 * HOUR;
    await h.clock(at);
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
       INSERT INTO watches (id, settings, host, read_hash, check_hash, state, etag, create_time, update_time, failures, failure_start)
       SELECT 'bound' || i, '{}', 'b' || i || '.example.org', 'r', 'c', CASE WHEN i % 10 = 0 THEN 'broken' ELSE 'active' END, 'e', ?, ?, i % 3, ? FROM n`,
      at - DAY,
      at - DAY,
      at - DAY,
    );
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
       INSERT INTO changes (id, watch_id, state, trigger_kind, summary, added, removed, diff, detect_time)
       SELECT printf('bound%05d', i), 'bound' || (1 + i % 50), CASE WHEN i <= 1100 THEN 'confirmed' ELSE 'acknowledged' END, 'any_change', 's', 1, 0, '', ? FROM n`,
      at - HOUR,
    );
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
       INSERT INTO notifications (kind, watch_id, change_id, policy, created_at, delivered_at)
       SELECT 'change_confirmed', 'bound' || (1 + i % 50), printf('bound%05d', i), 'digest', ?, CASE WHEN i <= 500 THEN NULL ELSE ? END FROM n`,
      at - HOUR,
      at - HOUR,
    );
    // 300 intents: 70 unsettled (a week of carried-over ones), 70 ended badly this week, 10 recorded today, the rest
    // settled before.
    await h.sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
       INSERT INTO intents (intent_id, kind, day, payload, events, state, attempts, next_at, last_code, recorded_at, created_at, updated_at)
       SELECT 'urgent-bound' || i, 'urgent', '2026-10-21', '', 1,
              CASE WHEN i <= 35 THEN 'open' WHEN i <= 70 THEN 'held' WHEN i <= 140 THEN 'expired' ELSE 'recorded' END,
              1, ?, CASE WHEN i <= 70 AND i % 2 = 0 THEN 'failed' ELSE 'pending' END,
              CASE WHEN i > 35 AND i <= 70 THEN ? - 2 * 86400000 WHEN i > 140 AND i <= 150 THEN ? - 3600000 WHEN i > 150 THEN ? - 10 * 86400000 END,
              ? - (i % 30) * 86400000, CASE WHEN i > 70 AND i <= 140 THEN ? - 86400000 ELSE ? - 20 * 86400000 END FROM n`,
      at + HOUR,
      at,
      at,
      at,
      at,
      at,
      at,
    );
    await h.rows();
    const status = (await h.opsStatus()) as { counters: Record<string, number>; signals: { code: string }[] };
    const { read, written } = await h.rows();
    console.log(`rows: status() at the bounds read ${String(read)}, wrote ${String(written)}`);
    expect(status.counters).toMatchObject({ watches_active: 45, watches_broken: 5, changes_new: 1000, notifications_pending: 500, intents_open: 70, intents_sent_today: 10 });
    expect(status.signals.map((signal) => signal.code)).toContain('notify_unsettled');
    expect(read).toBeLessThanOrEqual(STATUS_ROWS_MAX);
    expect(written).toBe(0);
    for (const table of ['watches', 'changes', 'notifications', 'intents']) await h.sql(`DELETE FROM ${table}`);
  });

  it('an input the contract refuses rejects with invalid_input', async () => {
    await h.clock(T0);
    await expect(h.opsSetGuard({ level: 'shed', reason: 'Not A Code', until: iso(T0 + HOUR) })).rejects.toThrow('invalid_input');
    await expect(h.opsSetGuard({ level: 'shed', reason: 'x', until: iso(T0 + 40 * HOUR) })).rejects.toThrow('invalid_input');
  });
});

describe('the Ops entrypoint (real alarms)', () => {
  it("status() arms a missing alarm, so the dashboard's tick restarts a lost scheduler", async () => {
    const h = await startHarness({ bindings: { DEV_MANUAL_ALARMS: 'false' } });
    try {
      expect(await h.alarmAt()).toBeNull();
      await h.opsStatus();
      expect(await h.alarmAt()).not.toBeNull();
    } finally {
      await h.dispose();
    }
  });
});
