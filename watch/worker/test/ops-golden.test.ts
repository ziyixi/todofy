/**
 * contracts/ops-v1: the exact bytes the watch app's Ops code answers for fixed synthetic state (WatchState's own
 * SQLite, here node:sqlite behind the SqlStorage surface Store uses). The dashboard reads these answers: every case is
 * compared as compact JSON with test/golden/ops-v1.json, and three of them are the contract's fixtures
 * (OpsStatus/watch-ok.json, OpsStatus/watch-degraded.json, GuardState/shed-watch.json), which proto/'s codecs, Todofy's
 * schema check and the dashboard's reader test as well. `UPDATE_GOLDEN=1 npx vitest run test/ops-golden.test.ts`
 * rewrites the golden file (never the fixtures); only for an intended change of the contract.
 *
 * Unlike Mail Hero's, Todofy's and Lab's, these answers are not checked against contracts/ops-v1/legacy: a dashboard
 * deployed before ops-v1 moved onto proto/ never binds the watch app, and its legacy schema lists only the first three
 * apps. They are checked against the generated schema instead.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, test } from 'vitest';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import { activeShed, guardState, iso, NEW_CHANGES_COUNTED, setGuard, uiUrl, watchStatus } from '../src/ops-status.ts';
import { Store } from '../src/store.ts';

/** A file next to this test (the Workers URL type is not Node's, so paths are strings). */
const path = (relative: string): string => decodeURIComponent(new URL(relative, import.meta.url).pathname);
const GOLDEN = path('golden/ops-v1.json');
const CONTRACT = path('../../../contracts/ops-v1/');
const SCHEMA = JSON.parse(readFileSync(`${CONTRACT}ops-v1.schema.json`, 'utf8')) as { $defs: Record<string, unknown> };
const fixture = (name: string): unknown => JSON.parse(readFileSync(`${CONTRACT}fixtures/${name}`, 'utf8'));

const NOW = Date.parse('2026-10-01T14:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TODOFY = {} as Service;
const env = { PUBLIC_HOST: 'watch.example.com', TODOFY };

/** The SqlStorage surface Store uses (exec(...).toArray() and the cursor's row counts), on real SQLite. */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...params: SQLInputValue[]) {
      const statement = db.prepare(query);
      if (statement.columns().length > 0) {
        const rows = statement.all(...params).map((row) => ({ ...row }));
        return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
      }
      const { changes } = statement.run(...params);
      return { toArray: () => [], rowsRead: 0, rowsWritten: Number(changes) };
    },
  } as unknown as SqlStorage;
}

function store(): Store {
  const value = new Store(sqlStorage());
  value.migrate();
  return value;
}

/** A synthetic watch row (its settings never reach ops-v1: only its state and failures count). */
function watch(target: Store, id: string, state: 'active' | 'paused' | 'broken', failures = 0, failureStart: number | null = null): void {
  target.run(
    `INSERT INTO watches (id, settings, host, read_hash, check_hash, state, etag, create_time, update_time, failures, failure_start)
     VALUES (?, '{"display_name":"合成示例"}', 'shop.example.org', 'r', 'c', ?, 'e', ?, ?, ?, ?)`,
    id,
    state,
    NOW - 30 * DAY,
    NOW - 30 * DAY,
    failures,
    failureStart,
  );
}

function change(target: Store, id: string, watchId: string, state: 'confirmed' | 'acknowledged' | 'suppressed'): void {
  target.run(
    `INSERT INTO changes (id, watch_id, state, trigger_kind, summary, added, removed, diff, detect_time) VALUES (?, ?, ?, 'any_change', 's', 1, 0, '', ?)`,
    id,
    watchId,
    state,
    NOW - HOUR,
  );
}

function intent(target: Store, id: string, state: 'open' | 'recorded' | 'refused' | 'expired', createdAt: number, day = '2026-10-01'): void {
  target.run(
    `INSERT INTO intents (intent_id, kind, day, payload, events, state, attempts, next_at, created_at, updated_at) VALUES (?, 'urgent', ?, '', 1, ?, 1, ?, ?, ?)`,
    id,
    day,
    state,
    NOW + 5 * MINUTE,
    createdAt,
    createdAt,
  );
}

function cases(): Record<string, unknown> {
  const fresh = store();
  watch(fresh, 'kettle', 'active');
  watch(fresh, 'jobs', 'active', 1, NOW - 2 * HOUR);
  watch(fresh, 'quiet', 'paused');
  change(fresh, 'c1', 'kettle', 'confirmed');
  change(fresh, 'c2', 'jobs', 'confirmed');
  change(fresh, 'c3', 'jobs', 'acknowledged');
  change(fresh, 'c4', 'jobs', 'suppressed');
  fresh.enqueue('change_confirmed', 'kettle', 'c1', 'digest', NOW - HOUR);
  intent(fresh, 'urgent-c0', 'recorded', NOW - 3 * HOUR);
  fresh.addLedger('2026-10-01', 37);
  fresh.setMeta('last_alarm_at', String(NOW - 5 * MINUTE));

  const degraded = store();
  watch(degraded, 'old', 'broken', 3, NOW - 3 * DAY);
  watch(degraded, 'older', 'broken', 5, NOW - 5 * DAY);
  watch(degraded, 'fine', 'active');
  degraded.enqueue('watch_broken', 'old', null, 'digest', NOW - DAY);
  intent(degraded, 'digest-2026-09-29', 'open', NOW - 2 * DAY, '2026-09-29');
  intent(degraded, 'urgent-c9', 'expired', NOW - 8 * DAY, '2026-09-23');
  degraded.run(`UPDATE intents SET updated_at = ? WHERE intent_id = 'urgent-c9'`, NOW - DAY);
  degraded.setMeta('last_alarm_at', String(NOW - 13 * HOUR));
  const shed = { level: 'shed', reason: 'do_rows_read_high', until: '2026-10-02T01:00:00Z' };
  const guarded = setGuard(degraded, shed, NOW - 30 * MINUTE);

  const never = store();
  watch(never, 'new', 'active');

  const broken = store();
  broken.run('DROP TABLE intents');

  const guards = store();
  return {
    'status/ok': watchStatus(fresh, env, NOW),
    'status/no-host': watchStatus(fresh, { PUBLIC_HOST: '' }, NOW),
    'status/degraded': watchStatus(degraded, env, NOW),
    'status/never-ran': watchStatus(never, env, NOW),
    'status/unavailable': watchStatus(broken, env, NOW),
    'guard/normal': guardState(guards, NOW),
    'guard/set-shed': guarded,
    'guard/shed': guardState(degraded, NOW),
    'guard/shed-again': setGuard(degraded, shed, NOW),
    'guard/renewed': setGuard(degraded, { ...shed, until: iso(NOW + 20 * HOUR) }, NOW),
    'guard/cleared': setGuard(degraded, { level: 'normal', reason: 'quota_recovered', until: null }, NOW),
    'guard/refused-too-far': setGuard(guards, { level: 'shed', reason: 'x', until: iso(NOW + 40 * HOUR) }, NOW),
    'guard/refused-past': setGuard(guards, { level: 'shed', reason: 'x', until: iso(NOW - HOUR) }, NOW),
    'guard/refused-shape': setGuard(guards, { level: 'shed', reason: 'Not A Code', until: iso(NOW + HOUR) }, NOW),
  };
}

test('every Ops answer for the synthetic states is byte for byte the golden one', () => {
  const actual = cases();
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(actual)).toEqual(Object.keys(golden));
  for (const [name, value] of Object.entries(actual)) expect(JSON.stringify(value), name).toBe(JSON.stringify(golden[name]));
});

test("three answers are the contract's watch fixtures, byte for byte", () => {
  const actual = cases();
  const compact = (value: unknown): string => JSON.stringify(value);
  expect(compact(actual['status/ok'])).toBe(compact(fixture('OpsStatus/watch-ok.json')));
  expect(compact(actual['status/degraded'])).toBe(compact(fixture('OpsStatus/watch-degraded.json')));
  expect(compact(actual['guard/shed'])).toBe(compact(fixture('GuardState/shed-watch.json')));
});

test('every answer passes the generated schema; a refusal is invalid_input', () => {
  for (const [name, value] of Object.entries(cases())) {
    const answer = typeof value === 'object' && value !== null && 'ok' in value ? value.ok : value;
    if (typeof answer === 'object' && answer !== null && 'error' in answer) {
      expect(answer, name).toEqual({ error: 'invalid_input' });
      continue;
    }
    expect(validate(SCHEMA, name.startsWith('status/') ? 'OpsStatus' : 'GuardState', answer), name).toEqual([]);
  }
});

test('a status holds counts and codes only: never a watch name, a URL of a watched site or page text', () => {
  const text = JSON.stringify(cases());
  for (const leak of ['合成示例', 'example.org', 'kettle', 'jobs', 'quiet', 'digest-2026', 'urgent-c']) expect(text).not.toContain(leak);
});

test('the guard: a shed ends at its until; the same shed keeps its set_at', () => {
  const target = store();
  const shed = { level: 'shed', reason: 'do_rows_read_high', until: iso(NOW + HOUR) };
  setGuard(target, shed, NOW - 10 * MINUTE);
  expect(activeShed(target, NOW)).toEqual({ reason: 'do_rows_read_high', until: NOW + HOUR, setAt: NOW - 10 * MINUTE });
  setGuard(target, shed, NOW);
  expect(activeShed(target, NOW)?.setAt).toBe(NOW - 10 * MINUTE);
  expect(activeShed(target, NOW + HOUR)).toBeNull();
  expect(guardState(target, NOW + HOUR)).toEqual({ level: 'normal', reason: null, until: null, set_at: null, deferred: [] });
});

test('new changes are counted up to a bound (one index row each)', () => {
  const target = store();
  watch(target, 'w', 'active');
  for (let n = 0; n < NEW_CHANGES_COUNTED + 5; n++) change(target, `c${String(n)}`, 'w', 'confirmed');
  const status = watchStatus(target, env, NOW) as unknown as { counters: Record<string, number> };
  expect(status.counters['changes_new']).toBe(NEW_CHANGES_COUNTED);
});

// ui_url is written only when the URL keeps the contract's HttpsUrl format (read from the IDL).
test('the owner UI URL keeps the contract format, else it is left out', () => {
  expect(uiUrl('watch.example.com')).toBe('https://watch.example.com/');
  expect(uiUrl(null)).toBeUndefined();
  expect(uiUrl(`${'a'.repeat(250)}.com`)).toBeUndefined();
});
