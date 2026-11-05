import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ReadHomeRequest, ReadHomeResponse } from '@ziyixi/proto/dashboard/mcp/v1/home_service_wire';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkerEntrypoint: class {
    env: unknown;
    constructor(_ctx?: unknown, env?: unknown) {
      this.env = env;
    }
  },
}));

import type { Env } from '../src/env.ts';
import { baselineSource, pollSource, rebaselineSource, RESTORED, type SourceEnv, type SourceState } from '../src/events.ts';
import { SubscriptionStore } from '../src/store.ts';

const AT = '2026-10-20T12:00:00Z';
const NO_OWN_CHANGES = () => new Map<string, string>();
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function snapshot(extra: Partial<ReadHomeResponse> = {}): ReadHomeResponse {
  return { generated_at: AT, build: 'synthetic', rev: 1,
    refresh: { last_tick_at: AT, next_tick_at: AT, last_refresh_at: null, next_refresh_at: AT, refreshed: false },
    entries: [], attention: [], head_seq: 0, control_unavailable_count: 0, ...extra };
}

function sourceEnv(sources: {
  tasks?: (query: URLSearchParams) => Record<string, unknown>;
  mail?: (query: URLSearchParams) => Record<string, unknown>;
  home?: (request: ReadHomeRequest) => ReadHomeResponse;
}): SourceEnv {
  const binding = (read: ((query: URLSearchParams) => Record<string, unknown>) | undefined) => ({ fetch(request: Request) {
    if (request.method !== 'GET' || !read) throw new Error('UNEXPECTED_SYNTHETIC_SOURCE_REQUEST');
    return Promise.resolve(Response.json(read(new URL(request.url).searchParams)));
  } } as unknown as Fetcher);
  return { TASKS: binding(sources.tasks), TODOFY_MAIL: binding(sources.mail), HOME: {
    readHome(request) { return Promise.resolve(sources.home?.(request) ?? snapshot()); },
  } };
}

function change(id: string, etag: string, cursor: string) {
  return { cursor, name: `tasks/${id}`, task: { id, name: `tasks/${id}`, etag, title: 'Synthetic private title' } };
}

it('starts Tasks from the native baseline, then advances bounded pages and stays caught up', async () => {
  const cursors: string[] = [];
  const env = sourceEnv({ tasks: query => {
    if (query.get('baseline') === 'true') {
      expect(query.has('page_token')).toBe(false);
      return { next_page_token: '41' };
    }
    expect(query.get('page_size')).toBe('100');
    const cursor = query.get('page_token') ?? '';
    cursors.push(cursor);
    if (cursor === '41') return { changes: [change('new-task', '2', '42')], next_page_token: '42', has_more: true };
    if (cursor === '42') return { changes: [{ name: 'labels/catalog', cursor: '43' }],
      next_page_token: '43', catalog_changed: true };
    return { next_page_token: '43' };
  } });
  const baseline = await baselineSource('task.changed', env);
  expect(baseline).toEqual({ name: 'task.changed', cursor: '41' });
  const first = await pollSource('task.changed', baseline, env, NO_OWN_CHANGES);
  expect(first.events).toEqual([{ id: 'task_changed_42', name: 'task.changed',
    data: { changes: [{ id: 'new-task', etag: '2', deleted: false }] } }]);
  const second = await pollSource('task.changed', first.state, env, NO_OWN_CHANGES);
  expect(second).toEqual({ state: { name: 'task.changed', cursor: '43' }, events: [] });
  expect(await pollSource('task.changed', second.state, env, NO_OWN_CHANGES)).toEqual(second);
  expect(cursors).toEqual(['41', '42', '43']);
  expect(JSON.stringify(first)).not.toContain('Synthetic private title');
});

it('coalesces each task before suppressing confirmed own revisions and retains tombstones', async () => {
  const env = sourceEnv({ tasks: () => ({ next_page_token: '8', changes: [
    change('own-task', '2', '3'), change('external-task', '1', '4'), change('own-task', '3', '5'),
    change('external-task', '2', '6'), { name: 'projects/metadata', cursor: '7' },
    { name: 'tasks/deleted-task', cursor: '8', deleted: true },
  ] }) });
  const state: SourceState = { name: 'task.changed', cursor: '2' };
  const result = await pollSource('task.changed', state, env, () => new Map([['own-task', '3']]));
  expect(result).toEqual({ state: { name: 'task.changed', cursor: '8' }, events: [
    { id: 'task_changed_8', name: 'task.changed', data: { changes: [
      { id: 'external-task', etag: '2', deleted: false }, { id: 'deleted-task', etag: '', deleted: true },
    ] } },
  ] });
  expect(state).toEqual({ name: 'task.changed', cursor: '2' });
});

it('suppresses a revision confirmed during the source await while retaining other revisions', async () => {
  let beginRead = () => {};
  let releaseRead = () => {};
  const started = new Promise<void>(resolve => { beginRead = resolve; });
  const released = new Promise<void>(resolve => { releaseRead = resolve; });
  const env: SourceEnv = { ...sourceEnv({}), TASKS: { async fetch() {
    beginRead();
    await released;
    return Response.json({ next_page_token: '5', changes: [
      change('new-own-task', '1', '3'), change('own-task-edited-later', '2', '4'), change('external-task', '1', '5'),
    ] });
  } } as unknown as Fetcher };
  let confirmed = new Map<string, string>();
  const polling = pollSource('task.changed', { name: 'task.changed', cursor: '2' }, env, () => new Map(confirmed));
  await started;
  confirmed = new Map([['new-own-task', '1'], ['own-task-edited-later', '1']]);
  releaseRead();
  expect(await polling).toEqual({ state: { name: 'task.changed', cursor: '5' }, events: [
    { id: 'task_changed_5', name: 'task.changed', data: { changes: [
      { id: 'own-task-edited-later', etag: '2', deleted: false }, { id: 'external-task', etag: '1', deleted: false },
    ] } },
  ] });
});

it('uses native must_start transitions even when etags stay the same, including leave and reentry', async () => {
  let entering = false;
  let another = false;
  const env = sourceEnv({ tasks: () => ({ tasks: [
    { id: 'existing', etag: '1', must_start: true, title: 'Synthetic old alert' },
    { id: 'entering', etag: '1', must_start: entering },
    ...(another ? [{ id: 'another', etag: '1', must_start: true }] : []),
  ] }) });
  const ownChanges = new Map([['entering', '1']]);
  const baseline = await baselineSource('task.must_start', env);
  expect(baseline).toEqual({ name: 'task.must_start', ids: ['existing'], revision: 0 });
  expect((await pollSource('task.must_start', baseline, env, () => ownChanges)).events).toEqual([]);
  entering = true;
  const entered = await pollSource('task.must_start', baseline, env, () => ownChanges);
  expect(entered.events).toEqual([{ id: 'must_start_1', name: 'task.must_start', data: { task_ids: ['entering'] } }]);
  entering = false;
  const left = await pollSource('task.must_start', entered.state, env, () => ownChanges);
  expect(left).toEqual({ state: { name: 'task.must_start', ids: ['existing'], revision: 1 }, events: [] });
  entering = true;
  const reentered = await pollSource('task.must_start', left.state, env, () => ownChanges);
  expect(reentered.events[0]?.id).toBe('must_start_2');
  const rebased = await baselineSource('task.must_start', env, reentered.state);
  expect(rebased).toEqual({ name: 'task.must_start', ids: ['entering', 'existing'], revision: 2 });
  another = true;
  expect((await pollSource('task.must_start', rebased, env, () => ownChanges)).events)
    .toEqual([{ id: 'must_start_3', name: 'task.must_start', data: { task_ids: ['another'] } }]);
});

it('reads every bounded must-start page and refuses an incomplete scan', async () => {
  const pages: string[] = [];
  const env = sourceEnv({ tasks: query => {
    expect(query.get('view')).toBe('all');
    expect(query.get('page_size')).toBe('100');
    const cursor = query.get('page_token') ?? '';
    pages.push(cursor);
    return cursor ? { tasks: [{ id: 'last', must_start: true }] }
      : { tasks: [{ id: 'first', must_start: true }], next_page_token: 'second-page' };
  } });
  expect(await baselineSource('task.must_start', env)).toEqual({ name: 'task.must_start', ids: ['first', 'last'], revision: 0 });
  expect(pages).toEqual(['', 'second-page']);
  let scanned = 0;
  const incomplete = sourceEnv({ tasks: () => ({ tasks: [{ id: `task-${String(scanned)}`, must_start: true }],
    next_page_token: `page-${String(++scanned)}` }) });
  await expect(baselineSource('task.must_start', incomplete)).rejects.toThrow('MUST_START_TASK_LIST_INCOMPLETE');
  expect(scanned).toBe(20);
  const previous: SourceState = { name: 'task.must_start', ids: ['old'], revision: 5 };
  await expect(pollSource('task.must_start', previous, incomplete, NO_OWN_CHANGES))
    .rejects.toThrow('MUST_START_TASK_LIST_INCOMPLETE');
  expect(previous).toEqual({ name: 'task.must_start', ids: ['old'], revision: 5 });
});

it('uses readiness baselines, advances empty ledger pages and keeps one stable identity per Mail', async () => {
  let repeatedMail = false;
  const env = sourceEnv({ mail: query => {
    if (query.get('baseline') === 'true') return { cursor: '10' };
    const cursor = query.get('cursor');
    if (cursor === '10') return { cursor: '12', mail_items: [
      { event_id: 'mail-a', ready_time: AT }, { event_id: 'mail-a', ready_time: AT },
    ] };
    if (cursor === '12') return { cursor: '13' };
    return { cursor: '14', mail_items: repeatedMail ? [{ event_id: 'mail-a', ready_time: AT }] : [] };
  } });
  const baseline = await baselineSource('mail.ready', env);
  expect(baseline).toEqual({ name: 'mail.ready', cursor: '10' });
  const ready = await pollSource('mail.ready', baseline, env, NO_OWN_CHANGES);
  expect(ready).toEqual({ state: { name: 'mail.ready', cursor: '12' },
    events: [{ id: 'mail_mail-a', name: 'mail.ready', data: { event_id: 'mail-a', ready_time: AT } }] });
  expect(await pollSource('mail.ready', baseline, env, NO_OWN_CHANGES)).toEqual(ready);
  const empty = await pollSource('mail.ready', ready.state, env, NO_OWN_CHANGES);
  expect(empty).toEqual({ state: { name: 'mail.ready', cursor: '13' }, events: [] });
  repeatedMail = true;
  expect((await pollSource('mail.ready', empty.state, env, NO_OWN_CHANGES)).events).toEqual(ready.events);
});

it('baselines Home attention at head and excludes every Personal MCP issue identity', async () => {
  const requested: number[] = [];
  const item = { source: 'recall', code: 'archive_not_connected', severity: 'warning' as const,
    since: AT, metrics: { private_metric: 7 }, target: { view: 'ops' as const, entry: 'recall' } };
  const env = sourceEnv({ home: request => {
    requested.push(request.after_occurrence_seq);
    return request.after_occurrence_seq === 0
      ? snapshot({ head_seq: 8, attention: [{ occurrence_seq: 7, item }] })
      : snapshot({ head_seq: 12, attention: [
        { occurrence_seq: 9, item },
        { occurrence_seq: 10, item: { ...item, source: 'personal-mcp' } },
        { occurrence_seq: 11, item: { ...item, source: 'cloudflare', target: { view: 'cloudflare', entry: 'personal-mcp' } } },
        { occurrence_seq: 12, item: { ...item, source: 'cloudflare', target: { view: 'cloudflare', script: 'personal-mcp' } } },
      ] });
  } });
  const baseline = await baselineSource('service.attention', env);
  expect(baseline).toEqual({ name: 'service.attention', seq: 8 });
  const result = await pollSource('service.attention', baseline, env, NO_OWN_CHANGES);
  expect(result).toEqual({ state: { name: 'service.attention', seq: 12 }, events: [
    { id: 'attention_9', name: 'service.attention', data: { occurrence_seq: 9, source: 'recall', code: 'archive_not_connected' } },
  ] });
  expect(requested).toEqual([0, 8]);
  expect(JSON.stringify(result)).not.toContain('private_metric');
});

it('does not alert on dismissal or restore, and alerts on a new recurrence sequence', async () => {
  const item = { source: 'recall', code: 'archive_not_connected', severity: 'warning' as const,
    since: AT, metrics: {}, target: { view: 'ops' as const, entry: 'recall' } };
  let current = snapshot({ head_seq: 9, attention: [{ occurrence_seq: 9, item }] });
  const env = sourceEnv({ home: () => current });
  const started = await pollSource('service.attention', { name: 'service.attention', seq: 8 }, env, NO_OWN_CHANGES);
  expect(started.events[0]?.id).toBe('attention_9');
  current = snapshot({ head_seq: 9 });
  const dismissed = await pollSource('service.attention', started.state, env, NO_OWN_CHANGES);
  expect(dismissed.events).toEqual([]);
  current = snapshot({ head_seq: 9, attention: [{ occurrence_seq: 9, item }] });
  const restored = await pollSource('service.attention', dismissed.state, env, NO_OWN_CHANGES);
  expect(restored.events).toEqual([]);
  current = snapshot({ head_seq: 10, attention: [{ occurrence_seq: 10, item }] });
  expect((await pollSource('service.attention', restored.state, env, NO_OWN_CHANGES)).events[0]?.id).toBe('attention_10');
});

it('re-baselines a restored source at the current head, and moves must-start revisions past any the lost store used', async () => {
  let head = 41;
  const env = sourceEnv({ tasks: query => query.get('baseline') === 'true' ? { next_page_token: String(head) }
    : query.has('view') ? { tasks: [{ id: 'due', etag: '1', must_start: true }] } : { next_page_token: String(head) } });
  // The backup's cursor (12) is behind the feed, or ahead of a Tasks restored behind it: neither is read.
  expect(await rebaselineSource('task.changed', { name: 'task.changed', cursor: '12' }, env, Date.parse(AT)))
    .toEqual({ name: 'task.changed', cursor: '41' });
  head = 3;
  expect(await rebaselineSource('task.changed', { name: 'task.changed', cursor: '12' }, env, Date.parse(AT)))
    .toEqual({ name: 'task.changed', cursor: '3' });
  const minutes = Math.floor(Date.parse(AT) / 60_000);
  const restored = await rebaselineSource('task.must_start', { name: 'task.must_start', ids: [], revision: 7 }, env, Date.parse(AT));
  expect(restored).toEqual({ name: 'task.must_start', ids: ['due'], revision: minutes });
  // The lost store reached at most one revision a minute past the backup's 7, far below the minutes since the epoch.
  expect((await pollSource('task.must_start', { name: 'task.must_start', ids: [], revision: minutes }, env, NO_OWN_CHANGES)).events[0]?.id)
    .toBe(`must_start_${String(minutes + 1)}`);
});

function createTestStore(overrides: Partial<Env> = {}) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const kvMap = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const sql = {
    exec(query: string, ...bindings: SqlStorageValue[]) {
      const trimmed = query.trimStart();
      if (bindings.length === 0 && !/^(SELECT|PRAGMA)/i.test(trimmed)) {
        database.exec(query);
        return { toArray: () => [], one: () => ({}), raw: () => [][Symbol.iterator]() };
      }
      const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) satisfies SQLInputValue[];
      const statement = database.prepare(query);
      if (/^(SELECT|PRAGMA)/i.test(trimmed)) {
        const rows = statement.all(...values) as Record<string, unknown>[];
        return {
          toArray: () => rows,
          one: () => rows[0] ?? {},
          raw: () => rows.map(row => Object.values(row))[Symbol.iterator](),
        };
      }
      statement.run(...values);
      return { toArray: () => [], one: () => ({}), raw: () => [][Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
  let transaction = 0;
  const storage = {
    sql,
    kv: {
      get: <T>(key: string) => kvMap.get(key) as T | undefined,
      put: (key: string, value: unknown) => { kvMap.set(key, structuredClone(value)); },
      delete: (key: string) => kvMap.delete(key),
      list: () => new Map(kvMap),
    },
    get: <T>(key: string) => Promise.resolve(kvMap.get(key) as T | undefined),
    put: (key: string, value: unknown) => { kvMap.set(key, structuredClone(value)); return Promise.resolve(); },
    delete: (key: string) => Promise.resolve(kvMap.delete(key)),
    getAlarm: () => Promise.resolve(alarmAt),
    setAlarm: (time: number) => { alarmAt = time; return Promise.resolve(); },
    deleteAlarm: () => { alarmAt = null; return Promise.resolve(); },
    transactionSync<T>(action: () => T): T {
      const savepoint = `store_test_${String(++transaction)}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = action();
        database.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  const ctx = {
    id: { equals: () => true },
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
  const env = {
    SUBSCRIPTIONS: { idFromName: () => ({}) },
    ACCESS_OWNER: 'owner@example.org',
    CALLBACK_HOSTS: 'receiver.example.org',
    TASKS: { fetch: () => Promise.resolve(Response.json({ next_page_token: '1' })) },
    TODOFY_MAIL: { fetch: () => Promise.resolve(Response.json({ cursor: '1' })) },
    RECALL: { fetch: () => Promise.resolve(Response.json({})) },
    WATCH: { fetch: () => Promise.resolve(Response.json({ cursor: '1' })) },
    HOME: { readHome: () => Promise.resolve(snapshot()) },
    ...overrides,
  } as unknown as Env;
  return { store: new SubscriptionStore(ctx, env), sql };
}

it('retries 408/429/5xx callback deliveries with backoff before failing and deletes deliveries for expired subscriptions', async () => {
  const now = Date.parse(AT);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const { store, sql } = createTestStore();
  const secret = `whsec_${btoa('s'.repeat(32))}`;
  const url = 'https://receiver.example.org/callback';
  sql.exec(
    'INSERT INTO subscriptions (id, owner, name, url, secret, expires_at, verified_at, arguments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'sub_retry', 'owner@example.org', 'personal_cloud.test', url, secret, null, now, '{}',
  );
  sql.exec(
    'INSERT INTO subscriptions (id, owner, name, url, secret, expires_at, verified_at, arguments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'sub_expired', 'owner@example.org', 'personal_cloud.test', url, secret, now - 1, now - 10_000, '{}',
  );
  sql.exec(
    "INSERT INTO deliveries (subscription_id, event_id, body, state, attempts, next_at) VALUES (?, ?, ?, 'pending', 0, ?)",
    'sub_retry', 'evt_retry', '{"eventId":"evt_retry"}', now,
  );
  sql.exec(
    "INSERT INTO deliveries (subscription_id, event_id, body, state, attempts, next_at) VALUES (?, ?, ?, 'pending', 0, ?)",
    'sub_expired', 'evt_expired', '{"eventId":"evt_expired"}', now,
  );

  const statuses = [429, 503, 408];
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response(null, { status: statuses.shift() ?? 500 })),
  );

  await store.alarm();
  // Expired subscription delivery is deleted without calling fetch.
  expect(sql.exec("SELECT * FROM deliveries WHERE subscription_id = 'sub_expired'").toArray()).toEqual([]);
  // Attempt 1 (429): stays pending with 60_000ms backoff.
  expect(sql.exec("SELECT state, attempts, next_at, error_code FROM deliveries WHERE event_id = 'evt_retry'").one()).toEqual({
    state: 'pending',
    attempts: 1,
    next_at: now + 60_000,
    error_code: 'callback_http_429',
  });

  // Advance past first backoff and run Attempt 2 (503): stays pending with 300_000ms backoff.
  vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
  await store.alarm();
  expect(sql.exec("SELECT state, attempts, next_at, error_code FROM deliveries WHERE event_id = 'evt_retry'").one()).toEqual({
    state: 'pending',
    attempts: 2,
    next_at: now + 60_000 + 300_000,
    error_code: 'callback_http_503',
  });

  // Advance past second backoff and run Attempt 3 (408): exhausts RETRY_MS and transitions to failed.
  vi.spyOn(Date, 'now').mockReturnValue(now + 360_000);
  await store.alarm();
  expect(sql.exec("SELECT state, attempts, error_code FROM deliveries WHERE event_id = 'evt_retry'").one()).toEqual({
    state: 'failed',
    attempts: 3,
    error_code: 'callback_http_408',
  });
});

it('records cursor_reset_required when pollSources catches CURSOR_RESET_REQUIRED and preserves restored marks', async () => {
  const now = Date.parse(AT);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const { store, sql } = createTestStore({
    TASKS: {
      fetch: () => Promise.resolve(Response.json({
        error: {
          code: 400,
          status: 'OUT_OF_RANGE',
          message: 'Cursor expired',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'CURSOR_RESET_REQUIRED', domain: 'tasks.ziyixi.science' }],
        },
      }, { status: 400 })),
    } as unknown as Fetcher,
    TODOFY_MAIL: {
      fetch: () => Promise.resolve(Response.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'Mail outage' } }, { status: 503 })),
    } as unknown as Fetcher,
  });

  const secret = `whsec_${btoa('s'.repeat(32))}`;
  const url = 'https://receiver.example.org/callback';
  for (const [id, name] of [['sub_tasks', 'task.changed'], ['sub_mail', 'mail.ready']] as const) {
    sql.exec(
      'INSERT INTO subscriptions (id, owner, name, url, secret, expires_at, verified_at, arguments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, 'owner@example.org', name, url, secret, null, now, '{}',
    );
  }
  sql.exec(
    'INSERT INTO event_sources (name, state, checked_at, error_code) VALUES (?, ?, ?, NULL)',
    'task.changed', JSON.stringify({ name: 'task.changed', cursor: '10' }), now - 120_000,
  );
  sql.exec(
    'INSERT INTO event_sources (name, state, checked_at, error_code) VALUES (?, ?, ?, ?)',
    'mail.ready', JSON.stringify({ name: 'mail.ready', cursor: '20' }), 0, RESTORED,
  );

  await store.alarm();
  expect(sql.exec("SELECT error_code, checked_at FROM event_sources WHERE name = 'task.changed'").one()).toEqual({
    error_code: 'cursor_reset_required',
    checked_at: now,
  });
  // A restored source keeps its 'restored' mark when rebaseline fails.
  expect(sql.exec("SELECT error_code, checked_at FROM event_sources WHERE name = 'mail.ready'").one()).toEqual({
    error_code: RESTORED,
    checked_at: now,
  });
});

