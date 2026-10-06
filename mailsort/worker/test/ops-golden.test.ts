/**
 * contracts/ops-v1: the exact bytes mailsort's Ops code answers for fixed synthetic state (MailsortState's own SQLite,
 * here node:sqlite behind the SqlStorage surface Store uses). The dashboard reads these answers: every case is compared
 * as compact JSON with test/golden/ops-v1.json, and two of them are the contract's fixtures (OpsStatus/mailsort-ok.json,
 * OpsStatus/mailsort-degraded.json), which proto/'s codecs, Todofy's schema check and the dashboard's reader test as
 * well. `UPDATE_GOLDEN=1 npx vitest run test/ops-golden.test.ts` rewrites the golden file (never the fixtures); only for
 * an intended change. A dashboard deployed before ops-v1 moved onto proto/ never binds mailsort, so the answers are
 * checked against the generated schema, not the legacy one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, test } from 'vitest';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import { guardState, iso, setGuard, sortStatus, uiUrl } from '../src/ops-status.ts';
import { writeSettings, DEFAULTS } from '../src/settings.ts';
import { Store } from '../src/store.ts';

const path = (relative: string): string => decodeURIComponent(new URL(relative, import.meta.url).pathname);
const GOLDEN = path('golden/ops-v1.json');
const CONTRACT = path('../../../contracts/ops-v1/');
const SCHEMA = JSON.parse(readFileSync(`${CONTRACT}ops-v1.schema.json`, 'utf8')) as { $defs: Record<string, unknown> };
const fixture = (name: string): unknown => JSON.parse(readFileSync(`${CONTRACT}fixtures/${name}`, 'utf8'));

const NOW = Date.parse('2026-10-06T14:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GRANT = { GMAIL_CLIENT_ID: 'synthetic.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'synthetic', GMAIL_REFRESH_TOKEN: 'synthetic' };
const env = { PUBLIC_HOST: 'sort.example.com', MODE: 'live', ...GRANT };

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

function usage(target: Store, decided: number, applied: number, unsure: number, neurons: number): void {
  target.run(`INSERT INTO usage (day, gmail_calls, ai_calls, neurons, decided, applied, unsure) VALUES ('2026-10-06', 120, ?, ?, ?, ?, ?)`, decided, neurons, decided, applied, unsure);
}

function cases(): Record<string, unknown> {
  const ok = store();
  writeSettings(ok, { ...DEFAULTS, mode: 'live' }, NOW - HOUR);
  usage(ok, 34, 21, 6, 1520.4);
  ok.setMeta('auth_state', 'ok');
  ok.setMeta('last_sync_at', String(NOW - 4 * MINUTE));
  ok.run(`INSERT INTO pending (message_id, added_at) VALUES ('a1', ?)`, NOW);
  ok.run(`INSERT INTO review (id, message_id, kind, state, decider, subject, sender, receive_time, create_time) VALUES ('r1', 'a2', 'unsure', 'pending', 'clef', '合成主题', 'Sender <example.org>', ?, ?)`, NOW, NOW);

  const degraded = store();
  writeSettings(degraded, { ...DEFAULTS, mode: 'live', breaker: 'daily_limit' }, NOW - HOUR);
  usage(degraded, 160, 150, 3, 8100);
  degraded.run(`UPDATE usage SET quota_exhausted = 1`);
  degraded.setMeta('auth_state', 'failed');
  degraded.setMeta('auth_failures', '3');
  degraded.setMeta('last_sync_at', String(NOW - 3 * HOUR));
  const shed = { level: 'shed', reason: 'ai_neurons_high', until: '2026-10-07T01:00:00Z' };
  const guarded = setGuard(degraded, shed, NOW - 30 * MINUTE);

  const unconfigured = store();
  const stale = store();
  stale.setMeta('auth_state', 'ok');
  stale.setMeta('last_sync_at', String(NOW - 2 * HOUR));
  const broken = store();
  broken.run('DROP TABLE usage');
  const guards = store();
  return {
    'status/ok': sortStatus(ok, env, NOW),
    'status/forced-shadow': sortStatus(ok, { ...env, MODE: 'shadow' }, NOW),
    'status/degraded': sortStatus(degraded, env, NOW),
    'status/not-configured': sortStatus(unconfigured, { PUBLIC_HOST: 'sort.example.com', MODE: 'shadow' }, NOW),
    'status/off': sortStatus(unconfigured, { PUBLIC_HOST: 'sort.example.com', MODE: 'off' }, NOW),
    'status/sync-stale': sortStatus(stale, env, NOW),
    'status/unavailable': sortStatus(broken, env, NOW),
    'guard/normal': guardState(guards, NOW),
    'guard/set-shed': guarded,
    'guard/cleared': setGuard(degraded, { level: 'normal', reason: 'quota_recovered', until: null }, NOW),
    'guard/refused-too-far': setGuard(guards, { level: 'shed', reason: 'x', until: iso(NOW + 40 * HOUR) }, NOW),
  };
}

test('every Ops answer for the synthetic states is byte for byte the golden one', () => {
  const actual = cases();
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(actual)).toEqual(Object.keys(golden));
  for (const [name, value] of Object.entries(actual)) expect(JSON.stringify(value), name).toBe(JSON.stringify(golden[name]));
});

test("two answers are the contract's mailsort fixtures, byte for byte", () => {
  const actual = cases();
  expect(JSON.stringify(actual['status/ok'])).toBe(JSON.stringify(fixture('OpsStatus/mailsort-ok.json')));
  expect(JSON.stringify(actual['status/degraded'])).toBe(JSON.stringify(fixture('OpsStatus/mailsort-degraded.json')));
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

test('the auth failure is critical (it reaches Home attention and the digest); the rest are warnings or information', () => {
  const degraded = cases()['status/degraded'] as { health: string; signals: { code: string; severity: string }[]; modes: Record<string, boolean> };
  expect(degraded.health).toBe('degraded');
  expect(degraded.signals.map((s) => [s.code, s.severity])).toEqual([
    ['gmail_auth_failed', 'critical'],
    ['breaker_tripped', 'warning'],
    ['ai_quota_exhausted', 'info'],
    ['guard_shed', 'info'],
  ]);
  expect(degraded.modes).toMatchObject({ live: false, breaker: true });
});

test('a status holds counts and codes only: never a subject, a sender or a label', () => {
  const text = JSON.stringify(cases());
  for (const leak of ['合成主题', 'example.org', 'Sender', 'synthetic.apps']) expect(text).not.toContain(leak);
});

test('the owner UI URL keeps the contract format, else it is left out', () => {
  expect(uiUrl('sort.example.com')).toBe('https://sort.example.com/');
  expect(uiUrl(null)).toBeUndefined();
});
