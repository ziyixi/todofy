/** Frozen Clef-era Ops replies stay decodable; current Claude status uses actual monthly usage and no guard. */
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, test } from 'vitest';
import { GuardStateSchema, OpsStatusSchema } from '@ziyixi/proto/ops/v1/ops_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
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
const env = { PUBLIC_HOST: 'sort.example.com', MODE: 'live', MODEL_ROUTER: { fetch: () => Promise.resolve(new Response()) }, ...GRANT };

test('Ops reports only the selected provider failure and keeps Claude accounting historical under Codex', () => {
  const target = store();
  writeSettings(target, { ...DEFAULTS, mode: 'live', classificationProvider: 'codex' }, NOW);
  target.setMeta('auth_state', 'ok');
  target.setMeta('last_sync_at', String(NOW));
  target.setMeta('claude_error', 'claude_spend_limit');
  target.setMeta('claude_limited_month', '2026-10');
  target.addClaudeUsage('2026-10-06', { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, costMicros: 20_000_000 });
  const configured = env;
  expect(sortStatus(target, configured, NOW).signals).toEqual([]);
  expect(sortStatus(target, configured, NOW).counters.claude_spent_usd).toBe(20);
  target.setMeta('codex_error', 'codex_auth');
  expect(sortStatus(target, configured, NOW).signals).toMatchObject([{ code: 'codex_auth', severity: 'warning' }]);
  writeSettings(target, { ...DEFAULTS, mode: 'live', classificationProvider: 'claude' }, NOW + 1);
  expect(sortStatus(target, configured, NOW).signals).toMatchObject([{ code: 'claude_spend_limit', severity: 'warning' }]);
});

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
  ok.addClaudeUsage('2026-10-06', { inputTokens: 139_914, outputTokens: 5_476, cacheWriteTokens: 0, cacheReadTokens: 0, thinkingTokens: 1_303, costMicros: 669_176 });
  ok.addClaudeUsage('2026-09-30', { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, costMicros: 140 });
  ok.setMeta('auth_state', 'ok');
  ok.setMeta('last_sync_at', String(NOW - 4 * MINUTE));
  ok.run(`INSERT INTO pending (message_id, added_at) VALUES ('a1', ?)`, NOW);
  ok.run(`INSERT INTO review (id, message_id, kind, state, decider, subject, sender, receive_time, create_time) VALUES ('r1', 'a2', 'unsure', 'pending', 'clef', '合成主题', 'Sender <example.org>', ?, ?)`, NOW, NOW);

  const degraded = store();
  // A breaker stored by an older release is neither a signal nor a mode any more.
  degraded.setMeta('settings', JSON.stringify({ ...DEFAULTS, mode: 'live', classificationProvider: 'claude', breaker: 'daily_limit', etag: 'legacy' }));
  usage(degraded, 160, 150, 3, 8100);
  degraded.run(`UPDATE usage SET quota_exhausted = 1`);
  degraded.setMeta('auth_state', 'failed');
  degraded.setMeta('auth_failures', '3');
  degraded.setMeta('last_sync_at', String(NOW - 3 * HOUR));
  degraded.setMeta('claude_limited_month', '2026-10');
  // Persisted state from an earlier deployment must not advertise or activate the retired guard.
  degraded.setMeta('guard_reason', 'ai_neurons_high');
  degraded.setMeta('guard_until', String(NOW + HOUR));
  degraded.setMeta('guard_set_at', String(NOW - HOUR));
  const shed = { level: 'shed', reason: 'ai_neurons_high', until: '2026-10-07T01:00:00Z' };
  const guarded = setGuard(degraded, shed);

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
    'guard/normal': guardState(),
    'guard/set-shed': guarded,
    'guard/cleared': setGuard(degraded, { level: 'normal', reason: 'quota_recovered', until: null }),
    'guard/refused-too-far': setGuard(guards, { level: 'shed', reason: 'x', until: iso(NOW + 40 * HOUR) }),
  };
}

test('the frozen Clef-era Ops golden replies still decode and roundtrip', () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  for (const [name, value] of Object.entries(golden)) {
    const answer = typeof value === 'object' && value !== null && 'ok' in value ? value.ok : value;
    if (typeof answer === 'object' && answer !== null && 'error' in answer) continue;
    if (name.startsWith('status/')) {
      const decoded = fromWire(OpsStatusSchema, answer);
      expect(decoded.unrecognized, name).toEqual([]);
      expect(toWire(OpsStatusSchema, decoded.message), name).toEqual(answer);
    } else {
      const decoded = fromWire(GuardStateSchema, answer);
      expect(decoded.unrecognized, name).toEqual([]);
      expect(toWire(GuardStateSchema, decoded.message), name).toEqual(answer);
    }
  }
});

test("the frozen golden preserves the contract's Mailsort fixture bytes", () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(JSON.stringify(golden['status/ok'])).toBe(JSON.stringify(fixture('OpsStatus/mailsort-ok.json')));
  expect(JSON.stringify(golden['status/degraded'])).toBe(JSON.stringify(fixture('OpsStatus/mailsort-degraded.json')));
});

test('current status reports actual monthly Claude usage and no guard capability', () => {
  const current = cases();
  expect(current['status/ok']).toMatchObject({
    health: 'ok', capabilities: [], guard: { level: 'normal', deferred: [] },
    counters: { decided_today: 34, applied_today: 21, unsure_today: 6, review_pending: 1, pending: 1, gmail_calls_today: 120,
      claude_spent_usd: 0.669176, claude_monthly_limit_usd: 20, claude_input_tokens: 139_914, claude_output_tokens: 5_476, claude_thinking_tokens: 1_303, last_sync_minutes: 4 },
  });
  expect(current['status/forced-shadow']).toMatchObject({ modes: { live: false, mode_limited: true } });
  for (const [name, value] of Object.entries(current)) {
    if (!name.startsWith('status/')) continue;
    expect(value, name).toMatchObject({ capabilities: [], guard: { level: 'normal', deferred: [] } });
    expect(value, name).not.toHaveProperty('counters.neurons_today');
    expect(value, name).not.toHaveProperty('counters.neuron_budget');
  }
  expect(current['guard/set-shed']).toEqual({ error: 'invalid_input' });
  expect(current['guard/cleared']).toMatchObject({ ok: { level: 'normal', deferred: [] } });
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
    ['claude_spend_limit', 'warning'],
  ]);
  expect(degraded.modes).toMatchObject({ live: true, breaker: false });
});

test('model errors become safe configuration, capacity or availability signals for the selected provider', () => {
  const target = store();
  target.setMeta('auth_state', 'ok');
  target.setMeta('last_sync_at', String(NOW));
  writeSettings(target, { ...DEFAULTS, classificationProvider: 'claude' }, NOW);
  for (const [code, expected] of [['claude_not_configured', 'claude_not_configured'], ['claude_auth', 'claude_auth'], ['claude_not_allowed', 'claude_auth'], ['claude_quota', 'claude_unavailable'],
    ['claude_http_429', 'claude_unavailable'], ['claude_bad_items', 'claude_unavailable']]) {
    target.setMeta('claude_error', code ?? '');
    expect(sortStatus(target, env, NOW).signals).toMatchObject([{ code: expected, severity: 'warning' }]);
  }
  writeSettings(target, { ...DEFAULTS, classificationProvider: 'codex' }, NOW);
  for (const [code, expected] of [['codex_not_configured', 'codex_not_configured'], ['codex_not_allowed', 'codex_auth'], ['codex_quota', 'codex_quota'], ['codex_rate_limit', 'codex_quota'],
    ['codex_unavailable', 'codex_unavailable'], ['codex_timeout', 'codex_unavailable']]) {
    target.setMeta('codex_error', code ?? '');
    expect(sortStatus(target, env, NOW).signals).toMatchObject([{ code: expected, severity: 'warning' }]);
  }
  expect(sortStatus(target, { ...env, MODE: 'off' }, NOW).signals).toEqual([]);
});

test('an unavailable thinking breakdown stays absent from the current counters', () => {
  const target = store();
  target.addClaudeUsage('2026-10-06', { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, thinkingTokens: null, costMicros: 140 });
  const status = sortStatus(target, { ...env, MODE: 'off' }, NOW);
  expect(status.counters).toMatchObject({ claude_spent_usd: 0.00014, claude_input_tokens: 10, claude_output_tokens: 5 });
  expect(status.counters).not.toHaveProperty('claude_thinking_tokens');
});

test('a status holds counts and codes only: never a subject, a sender or a label', () => {
  const text = JSON.stringify(cases());
  for (const leak of ['合成主题', 'example.org', 'Sender', 'synthetic.apps']) expect(text).not.toContain(leak);
});

test('the owner UI URL keeps the contract format, else it is left out', () => {
  expect(uiUrl('sort.example.com')).toBe('https://sort.example.com/');
  expect(uiUrl(null)).toBeUndefined();
});
