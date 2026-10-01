/**
 * SQLite rows read and written in workerd (../../../docs/design.md §8): Workers Free gives the account's SQLite
 * Durable Objects 5,000,000 rows read and 100,000 rows written a day, Mail Hero's included, and every API call and
 * alarm fails past them until 00:00 UTC. WatchState counts what each statement read and wrote (store.ts `takeMeter`,
 * cursor.rowsRead and rowsWritten); this suite fills every table to its bound (WATCHES_MAX watches, CHANGES_KEPT
 * changes and SNAPSHOTS_KEPT + 2 snapshots each) and holds each path to a row budget:
 *
 * - an idle alarm pass, and the once-a-day sweep of every watch's bounds;
 * - a pass that checks watches (each check prunes only its own watch, through the (watch_id, state, id) index);
 * - the heaviest reads of the UI: ListWatches, the inbox (ListChanges state = NEW) and GetServiceStatus.
 *
 * The budgets are measured values with room (the comments give what was measured on 2026-10-01); design.md §8 turns
 * them into a day's worst case. Synthetic pages only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHANGES_KEPT, SNAPSHOTS_KEPT, WATCHES_MAX } from '../../src/limits.ts';
import { page } from '../fake-sites.ts';
import { DAY, HOUR, op, startHarness, T0, type Harness } from './harness.ts';

let h: Harness;
let clock = T0;

/** The page of watch `n` (`variant` changes one line). */
const pageOf = (n: number, variant: number) => page(`R${String(n)}`, `<p>Synthetic page ${String(n)} with enough text, revision ${String(variant)}.</p><p>A stable second line.</p>`);

beforeAll(async () => {
  h = await startHarness();
  for (let n = 0; n < WATCHES_MAX; n++) {
    h.sites.html(`https://rows${String(n)}.example.com/p`, pageOf(n, 0));
    await h.api.createWatch({ watchId: `rows-${String(n)}`, requestId: op(), watch: { displayName: `Rows ${String(n)}`, uri: `https://rows${String(n)}.example.com/p`, stability: { skipConfirmation: true } } });
  }
  // The first checks: every watch's notified state.
  await h.run(clock, 60_000, 200);
  // Every watch at its bounds: CHANGES_KEPT changes (a quarter suppressed, half acknowledged, a quarter new) and
  // SNAPSHOTS_KEPT + 2 snapshots; older than anything a check writes.
  const quarter = CHANGES_KEPT / 4;
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
     INSERT INTO changes (id, watch_id, state, trigger_kind, summary, added, removed, diff, detect_time, resolve_time)
     SELECT printf('00%02d%012d', w.rowid % 100, n.i), w.id,
            CASE WHEN n.i < ? THEN 'suppressed' WHEN n.i < ? THEN 'acknowledged' ELSE 'confirmed' END,
            'any_change', '新增 1 行', 1, 0, '[{"kind":"added","text":"a synthetic line"}]', ?, ?
     FROM watches w, n`,
    CHANGES_KEPT,
    quarter,
    3 * quarter,
    clock - DAY,
    clock - DAY,
  );
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
     INSERT INTO snapshots (watch_id, created_at, sha, line_count, body) SELECT w.id, ?, 'synthetic', 1, x'00' FROM watches w, n`,
    SNAPSHOTS_KEPT + 1,
    clock - DAY,
  );
  // Then the once-a-day sweep's own day has passed, and nothing else is due.
  clock += HOUR;
  await h.rows();
});

afterAll(async () => {
  await h.dispose();
});

describe('rows read and written (Workers Free: 5,000,000 read and 100,000 written a day, for the whole account)', () => {
  it('an idle pass reads a few rows; the daily sweep of every watch stays bounded', async () => {
    const [count] = await h.sql<{ n: number }>('SELECT count(*) AS n FROM changes');
    expect(count?.n).toBe(WATCHES_MAX * CHANGES_KEPT);
    // Nothing due: the passes below only keep the bounds.
    const sweepDay = Date.parse('2026-10-02T00:30:00Z');
    await h.sql('UPDATE watches SET next_check_at = ?', sweepDay + DAY);
    await h.rows();
    // The first pass of a UTC day sweeps every watch's bounds and the global tables: measured ~14,500 rows read.
    await h.step(sweepDay);
    const sweep = await h.rows();
    console.log(`rows: the daily sweep read ${String(sweep.read)}, wrote ${String(sweep.written)}`);
    expect(sweep.read).toBeLessThan(30_000);
    // An idle pass within the hour: the due query and a few meta rows (measured 5).
    await h.step(sweepDay + 10 * 60_000);
    const idle = await h.rows();
    console.log(`rows: an idle pass read ${String(idle.read)}, wrote ${String(idle.written)}`);
    expect(idle.read).toBeLessThan(50);
    expect(idle.written).toBeLessThan(10);
    clock = sweepDay + HOUR;
  });

  it("a check reads a few hundred rows, its own watch's prune included; never the other watches' rows", async () => {
    // Every page changes and every watch is due; the pass checks as many as its request budget allows.
    for (let n = 0; n < WATCHES_MAX; n++) h.sites.html(`https://rows${String(n)}.example.com/p`, pageOf(n, 1));
    clock += 8 * HOUR;
    await h.sql('UPDATE watches SET next_check_at = ?', clock);
    await h.rows();
    const result = await h.step(clock);
    const pass = await h.rows();
    const checks = Object.values(result.outcomes ?? {}).reduce((a, b) => a + b, 0);
    console.log(`rows: a pass of ${String(checks)} checks read ${String(pass.read)}, wrote ${String(pass.written)} (${(pass.read / checks).toFixed(0)} read per check)`);
    expect(checks).toBeGreaterThan(10);
    expect(result.outcomes?.['changed']).toBe(checks);
    // Measured ~330 read (the prune's count over its own watch's 200 changes is most of it) and ~22 written per check.
    expect(pass.read / checks).toBeLessThan(700);
    expect(pass.written / checks).toBeLessThan(60);
  });

  it('the heaviest UI reads stay bounded', async () => {
    await h.rows();
    await h.api.listWatches({});
    const list = await h.rows();
    await h.api.listChanges({ parent: 'watches/-', filter: 'state = NEW' });
    const inbox = await h.rows();
    await h.api.getServiceStatus({ name: 'serviceStatus' });
    const status = await h.rows();
    console.log(`rows: ListWatches read ${String(list.read)}, the inbox ${String(inbox.read)}, GetServiceStatus ${String(status.read)}`);
    // ListWatches counts the new changes of every watch (a quarter of CHANGES_KEPT each here, and the pass's): measured ~5,200.
    expect(list.read).toBeLessThan(6_000);
    // A page of 50 from the (state, id) index: measured ~150.
    expect(inbox.read).toBeLessThan(500);
    // The open changes counted per state (acknowledged ones are not): measured ~5,100.
    expect(status.read).toBeLessThan(10_000);
  });
});
