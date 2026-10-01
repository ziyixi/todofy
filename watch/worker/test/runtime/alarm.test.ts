/**
 * WatchState's scheduling in workerd (../../../docs/design.md §6): with real alarms (DEV_MANUAL_ALARMS off), any owner
 * API call arms an alarm when none is set, the alarm checks the due watches and arms the next one; with manual alarms,
 * a failing pass is caught and asks for the next one 5 minutes later. The schema and its bounds.
 */
import { describe, expect, it } from 'vitest';
import { page } from '../fake-sites.ts';
import { DAY, MINUTE, op, startHarness, T0 } from './harness.ts';

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('the alarm', () => {
  it('an API call arms it; it runs, checks the new watch and arms the next one', async () => {
    const h = await startHarness({ bindings: { DEV_MANUAL_ALARMS: 'false' } });
    try {
      expect(await h.alarmAt()).toBeNull();
      const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
      expect(status.nextAlarmTime).toBeDefined();
      h.sites.html('https://alarm.example.com/p', page('P', '<p>Checked by a real alarm within a few seconds.</p>'));
      await h.api.createWatch({ watchId: 'real', requestId: op(), watch: { displayName: 'real', uri: 'https://alarm.example.com/p' } });
      const checked = await until(
        () => h.api.getWatch({ name: 'watches/real' }),
        (watch) => watch.health?.lastCheckTime !== undefined,
      );
      expect(checked.health?.lastCheckTime).toBeDefined();
      const next = await h.alarmAt();
      expect(next).not.toBeNull();
      // The next alarm is the watch's next check (about 6 hours away), never sooner than a second.
      expect((next ?? 0) - Date.now()).toBeGreaterThan(5 * 60 * MINUTE);
      const last = await h.api.getServiceStatus({ name: 'serviceStatus' });
      expect(last.lastAlarmTime).toBeDefined();
    } finally {
      await h.dispose();
    }
  });

  it('a failing check is retried in 5 minutes without stopping the others; a failing pass asks for the next in 5 minutes', async () => {
    const h = await startHarness();
    try {
      h.sites.html('https://broken.example.com/p', page('P', '<p>A page whose stored settings get corrupted.</p>'));
      h.sites.html('https://fine.example.com/p', page('P', '<p>A page next to it that is checked as usual.</p>'));
      await h.api.createWatch({ watchId: 'corrupt', requestId: op(), watch: { displayName: 'c', uri: 'https://broken.example.com/p' } });
      await h.api.createWatch({ watchId: 'fine', requestId: op(), watch: { displayName: 'f', uri: 'https://fine.example.com/p' } });
      await h.sql("UPDATE watches SET settings = '{' WHERE id = 'corrupt'");
      const checked = await h.step(T0);
      expect(checked.outcomes).toEqual({ error: 1, unchanged: 1 });
      expect(await h.sql("SELECT next_check_at FROM watches WHERE id = 'corrupt'")).toEqual([{ next_check_at: T0 + 5 * MINUTE }]);
      expect(h.logs.filter((line) => line.startsWith('{"event":"check_failed"'))).toEqual(['{"event":"check_failed","watch":"corrupt","code":"SyntaxError"}']);
      // The pass itself fails (its storage is gone): caught, logged as a code, and the next pass in 5 minutes.
      await h.sql('DROP TABLE ledger');
      const result = await h.step(T0 + DAY);
      expect(result.error).toBeDefined();
      expect(result.next).toBe(T0 + DAY + 5 * MINUTE);
      expect(h.logs.some((line) => line.startsWith('{"event":"alarm_failed"'))).toBe(true);
    } finally {
      await h.dispose();
    }
  });
});

describe('storage bounds', () => {
  it('keeps at most 20 snapshots and 50 suppressed changes per watch, with the notified one', async () => {
    const h = await startHarness();
    try {
      const url = 'https://bounds.example.com/p';
      const text = (n: number) => page('P', `<p>Counter ${String(n)} on a synthetic page with a floor.</p><p>Stable line.</p>`);
      h.sites.html(url, text(0));
      await h.api.createWatch({ watchId: 'bounds', requestId: op(), watch: { displayName: 'b', uri: url, checkIntervalMinutes: 60, trigger: { anyChange: { minChangedLines: 100 } } } });
      let clock = T0;
      await h.run(clock);
      for (let n = 1; n <= 60; n++) {
        h.sites.html(url, text(n));
        clock += 2 * 60 * MINUTE;
        await h.run(clock);
      }
      const [{ snapshots } = { snapshots: 0 }] = await h.sql<{ snapshots: number }>('SELECT count(*) AS snapshots FROM snapshots WHERE watch_id = ?', 'bounds');
      expect(snapshots).toBeLessThanOrEqual(22);
      const [{ suppressed } = { suppressed: 0 }] = await h.sql<{ suppressed: number }>("SELECT count(*) AS suppressed FROM changes WHERE state = 'suppressed'");
      expect(suppressed).toBe(50);
      const [row] = await h.sql<{ baseline_id: number }>('SELECT baseline_id FROM watches');
      expect(await h.sql('SELECT id FROM snapshots WHERE id = ?', row?.baseline_id ?? 0)).toHaveLength(1);
      // Request IDs are kept a day.
      await h.step(clock + 2 * DAY);
      expect(await h.sql('SELECT request_id FROM requests')).toEqual([]);
    } finally {
      await h.dispose();
    }
  });
});
