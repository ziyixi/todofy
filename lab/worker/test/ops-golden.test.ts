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
import { OpsStatusSchema } from '@ziyixi/proto/ops/v1/ops_pb';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import type { Env } from '../src/env.ts';
import { guardState, labStatus, setGuard, uiUrl } from '../src/ops-status.ts';
import { Store } from '../src/store.ts';

/** This test's golden file (a path: the Workers URL type is not Node's). */
const GOLDEN = decodeURIComponent(new URL('golden/ops-v1.json', import.meta.url).pathname);
/** The hand-written schema the dashboards deployed before ops-v1 moved onto proto/ validate every answer with. */
const LEGACY = JSON.parse(readFileSync(decodeURIComponent(new URL('../../../contracts/ops-v1/legacy/ops-v1.schema.json', import.meta.url).pathname), 'utf8')) as {
  $defs: Record<string, unknown>;
};
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

/**
 * The one difference the move onto proto/ made, and on purpose: Lab's status listed version, app, generated_at,
 * last_backup_at, ui_url and capabilities first (an object spread), while the codec writes every message in the
 * contract's field order, the order of contracts/ops-v1/fixtures/OpsStatus/lab-*.json and of every other app. A
 * JSON object's key order carries no meaning and every reader looks fields up by name (the dashboard's reader writes
 * what it keeps in field order too), so a status is compared with the golden one in field order: same keys, same
 * values, same bytes once ordered. The golden file keeps the old bytes.
 */
const STATUS_FIELDS = [...OpsStatusSchema.fields].sort((a, b) => a.number - b.number).map((field) => field.name);
function inFieldOrder(value: unknown): unknown {
  const status = value as Record<string, unknown>;
  expect(Object.keys(status).sort()).toEqual(STATUS_FIELDS.filter((name) => name in status).sort());
  return Object.fromEntries(STATUS_FIELDS.filter((name) => name in status).map((name) => [name, status[name]]));
}

test('every Ops answer for the synthetic states is byte for byte the golden one (a status in field order)', () => {
  const actual = cases();
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(actual)).toEqual(Object.keys(golden));
  for (const [name, value] of Object.entries(actual)) {
    const expected = name.startsWith('status/') ? inFieldOrder(golden[name]) : golden[name];
    expect(JSON.stringify(value), name).toBe(JSON.stringify(expected));
  }
});

// Rollout (the apps and the dashboard deploy separately): the dashboards deployed before the move validate every
// answer against the hand-written schema. Every answer above passes it, so this Lab and such a dashboard work
// together; the earlier Lab's answers are the same values, which a new dashboard reads (its own tests).
test('every golden answer passes the checks of the dashboards deployed before the move', () => {
  for (const [name, value] of Object.entries(cases())) {
    const answer = name.startsWith('guard/') && typeof value === 'object' && value !== null && 'ok' in value ? value.ok : value;
    if (typeof answer === 'object' && answer !== null && 'error' in answer) continue;
    expect(validate(LEGACY, name.startsWith('status/') ? 'OpsStatus' : 'GuardState', answer), name).toEqual([]);
  }
});

// ui_url is written only when the URL keeps the contract's HttpsUrl format (read from the IDL): a PUBLIC_HOST that
// passes Lab's own host check but would make a URL the codec refuses leaves ui_url null instead of failing status().
test('the owner UI URL keeps the contract format, else it is left out', () => {
  expect(uiUrl('lab.example.com')).toBe('https://lab.example.com/');
  expect(uiUrl(null)).toBeUndefined();
  expect(uiUrl(`${'a'.repeat(250)}.com`)).toBeUndefined();
});
