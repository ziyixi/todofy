/**
 * contracts/ops-v1: the exact bytes Lab's Ops code answers for fixed synthetic state (LabState's own SQLite, here
 * node:sqlite behind the SqlStorage surface Store uses). The dashboard reads these answers, so a refactor of the Ops
 * code (its move onto the generated proto types, for one) must not change one byte: every case is compared as
 * compact JSON (key order and number spelling included) with test/golden/ops-v1.json, which the code before that
 * move wrote. `UPDATE_GOLDEN=1 npx vitest run test/ops-golden.test.ts` rewrites it; only for an intended change of
 * the contract, never to make a refactor pass.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, test } from 'vitest';
import type { Env } from '../src/env.ts';
import { guardState, labStatus, setGuard } from '../src/ops-status.ts';
import { Store } from '../src/store.ts';

/** This test's golden file (a path: the Workers URL type is not Node's). */
const GOLDEN = decodeURIComponent(new URL('golden/ops-v1.json', import.meta.url).pathname);
const NOW = Date.parse('2026-09-30T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (offset: number): string => new Date(NOW + offset).toISOString();

/** The SqlStorage surface Store uses (exec(...).toArray()), on real SQLite. */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...params: SQLInputValue[]) {
      const statement = db.prepare(query);
      const rows = statement.columns().length > 0 ? statement.all(...params).map((row) => ({ ...row })) : (statement.run(...params), []);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

function store(): Store {
  const value = new Store(sqlStorage());
  value.migrate();
  return value;
}

const env = { PUBLIC_HOST: 'lab.example.com' } as unknown as Env;

function cases(): Record<string, unknown> {
  const fresh = store();
  fresh.set('fetch_last_ok_at', NOW - HOUR);
  fresh.set('mirror_neuron_cap', 5000);
  fresh.set('mirror_ingest_paused', '0');
  fresh.count(NOW - HOUR, 'ingested', 612);
  fresh.count(NOW - 2 * HOUR, 'ranked', 20);
  fresh.charge(NOW, 341.5);
  fresh.sql.exec("INSERT INTO labels (paper_id, label, source, deck_id, at) VALUES ('2609.00001', 'like', 'deck', 'd', ?)", NOW - DAY);
  fresh.sql.exec("INSERT INTO labels (paper_id, label, source, deck_id, at) VALUES ('2609.00002', 'dislike', 'deck', 'd', ?)", NOW - DAY);

  const degraded = store();
  degraded.set('bootstrap_at', NOW - 100 * HOUR);
  degraded.set('mirror_neuron_cap', 5000);
  degraded.set('mirror_ingest_paused', '1');
  degraded.charge(NOW, 4996.24);
  degraded.capHit(NOW - HOUR, false);
  degraded.sql.exec('INSERT INTO send_watch (intent_id, since) VALUES (?, ?)', 'deck-2026-09-28-g1', NOW - 30 * HOUR);
  degraded.sql.exec('INSERT INTO send_watch (intent_id, since) VALUES (?, ?)', 'deck-2026-09-29-g1', NOW - 25 * HOUR);
  const shed = { level: 'shed', reason: 'd1_reads_high', until: '2026-09-30T20:00:00Z' };
  const guarded = setGuard(degraded, shed, NOW - 30 * 60_000);

  const broken = store();
  broken.sql.exec('DROP TABLE neurons');

  const guards = store();
  return {
    'status/ok': labStatus(fresh, env, NOW),
    'status/no-host': labStatus(fresh, { PUBLIC_HOST: '' } as unknown as Env, NOW),
    'status/degraded': labStatus(degraded, env, NOW),
    'status/unavailable': labStatus(broken, env, NOW),
    'guard/normal': guardState(guards, NOW),
    'guard/set-shed': guarded,
    'guard/shed': guardState(degraded, NOW),
    'guard/shed-again': setGuard(degraded, shed, NOW),
    'guard/renewed': setGuard(degraded, { ...shed, until: iso(20 * HOUR) }, NOW),
    'guard/cleared': setGuard(degraded, { level: 'normal', reason: 'quota_recovered', until: null }, NOW),
    'guard/refused': setGuard(guards, { level: 'shed', reason: 'x', until: iso(40 * HOUR) }, NOW),
  };
}

test('every Ops answer for the synthetic states is byte for byte the golden one', () => {
  const actual = cases();
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(actual)).toEqual(Object.keys(golden));
  for (const [name, value] of Object.entries(actual)) expect(JSON.stringify(value), name).toBe(JSON.stringify(golden[name]));
});
