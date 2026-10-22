/** Native Watch transitions become reports in linked work; no browsing content or real services are used. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EVENT_NAMES, WORK_EVENT_NAME } from '../src/server.ts';
import { WorkWatchSource, WATCH_POLL_INTERVAL_MS, WATCH_SOURCE_NAME } from '../src/watch-events.ts';
import { WorkStore, type WorkAttention, type WorkStorage } from '../src/work-store.ts';
import type { WorkCreateInput } from '../src/work-model.ts';
import type { WatchToolEnv } from '../src/watch.ts';

const AT = '2026-10-22T12:00:00Z';
const WATCH = 'watches/synthetic';
const databases: DatabaseSync[] = [];

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT); });
afterEach(() => { vi.useRealTimers(); for (const database of databases.splice(0)) database.close(); });

function uuid(value: number) { return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`; }
function advance() { vi.setSystemTime(Date.now() + WATCH_POLL_INTERVAL_MS); }
function event(sequence: number, kind = 'change_confirmed', watch = WATCH) {
  return { sequence: String(sequence), kind, watch,
    change: kind === 'change_confirmed' ? `${watch}/changes/synthetic-${String(sequence)}` : '', create_time: AT };
}
function expired() {
  return Response.json({ error: { code: 400, status: 'OUT_OF_RANGE', message: 'Synthetic event cursor expired',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'CURSOR_EXPIRED', domain: 'watch.ziyixi.science' }],
  } }, { status: 400 });
}

function fixture(read: (query: URLSearchParams) => Record<string, unknown> | Response) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const sql = { exec(query: string, ...bindings: SqlStorageValue[]) {
    if (query.trimStart().startsWith('CREATE')) { database.exec(query); return { toArray: () => [] }; }
    const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) satisfies SQLInputValue[];
    const rows = database.prepare(query).all(...values);
    return { toArray: () => rows };
  } } as unknown as SqlStorage;
  let transaction = 0;
  const storage: WorkStorage = { sql, transactionSync<T>(action: () => T): T {
    const savepoint = `watch_test_${String(++transaction)}`;
    database.exec(`SAVEPOINT ${savepoint}`);
    try { const result = action(); database.exec(`RELEASE ${savepoint}`); return result; }
    catch (error) { database.exec(`ROLLBACK TO ${savepoint}`); database.exec(`RELEASE ${savepoint}`); throw error; }
  } };
  storage.sql.exec('CREATE TABLE event_sources (name TEXT PRIMARY KEY,state TEXT NOT NULL,checked_at INTEGER NOT NULL,error_code TEXT)');
  const attention: WorkAttention[] = [];
  const store = new WorkStore(storage, notification => attention.push(notification));
  const calls: { path: string; baseline: boolean; cursor: string }[] = [];
  const env: WatchToolEnv = { WATCH: { fetch(request: Request) {
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    expect(url.pathname).toBe('/api/v1/watchEvents:poll');
    expect(url.searchParams.get('page_size')).toBe('20');
    calls.push({ path: url.pathname, baseline: url.searchParams.get('baseline') === 'true', cursor: url.searchParams.get('cursor') ?? '' });
    const result = read(url.searchParams);
    return Promise.resolve(result instanceof Response ? result : Response.json(result));
  } } as unknown as Fetcher };
  const source = new WorkWatchSource(storage, store, env);
  const create = (id: number, fields: Partial<WorkCreateInput> = {}) => store.create({ request_id: uuid(id),
    title: `Synthetic watch work ${String(id)}`, goal: 'Review a synthetic release', scope: 'Synthetic Watch only',
    completion_criteria: 'Review source evidence before deciding the result', next_action: 'Review the next confirmed change',
    links: [{ type: 'watch', ref: WATCH }], ...fields }).work;
  const cursor = () => storage.sql.exec<{ state: string; error_code: string | null }>(
    'SELECT state,error_code FROM event_sources WHERE name=?', WATCH_SOURCE_NAME).toArray()[0];
  return { source, store, storage, env, attention, calls, create, cursor };
}

it('skips history at the native baseline and polls only while open work has Watch links', async () => {
  const f = fixture(query => query.get('baseline') === 'true' ? { cursor: 'head-40' } : { cursor: 'head-40' });
  await f.source.refresh();
  expect(f.calls).toEqual([]);
  const work = f.create(1);
  await f.source.refresh();
  expect(f.calls.map(call => call.baseline)).toEqual([true]);
  expect(f.cursor()?.state).toBe('head-40');
  expect(f.store.get({ work_id: work.id }).pending_reports).toEqual([]);
  await f.source.refresh();
  expect(f.calls).toHaveLength(1);
  advance();
  await f.source.refresh();
  expect(f.calls.at(-1)).toMatchObject({ baseline: false, cursor: 'head-40' });
  expect(f.attention).toEqual([]);
  f.store.checkpoint({ work_id: work.id, request_id: uuid(2), etag: work.etag,
    changes: { state: 'done', result: 'The synthetic goal was reviewed.' } });
  advance();
  await f.source.refresh();
  expect(f.calls).toHaveLength(2);
});

it('routes confirmed silent-watch candidates only to linked open work through work.attention', async () => {
  const f = fixture(query => query.get('baseline') === 'true' ? { cursor: '40' }
    : { cursor: '42', events: [event(41), event(42, 'change_confirmed', 'watches/unlinked')] });
  const active = f.create(10, { links: [{ type: 'watch', ref: WATCH, owned: true }] });
  const waiting = f.create(11, { state: 'waiting', waiting_for: 'A synthetic release', links: [{ type: 'watch', ref: WATCH }] });
  const done = f.create(12, { state: 'done', result: 'Already reviewed.' });
  const cancelled = f.create(13, { state: 'cancelled', result: 'Owner stopped this synthetic work.' });
  const unrelated = f.create(14, { links: [] });
  await f.source.refresh();
  advance();
  await f.source.refresh();
  expect(f.attention.map(item => item.work_id)).toEqual([active.id, waiting.id]);
  for (const work of [active, waiting]) {
    const read = f.store.get({ work_id: work.id });
    expect(read.pending_reports).toHaveLength(1);
    expect(read.pending_reports[0]).toMatchObject({ report_id: 'watch:41', kind: 'progress',
      source: { type: 'watch', ref: WATCH }, evidence_ref: `${WATCH}/changes/synthetic-41` });
    expect(read.work.state).toBe(work.state);
  }
  for (const work of [done, cancelled, unrelated]) expect(f.store.get({ work_id: work.id }).pending_reports).toEqual([]);
  // The source reads the metadata feed regardless of NONE; no Tasks call or second Watch subscription is used.
  expect(f.calls.every(call => call.path === '/api/v1/watchEvents:poll')).toBe(true);
  expect(EVENT_NAMES.filter(name => name === WORK_EVENT_NAME || name.includes('watch'))).toEqual([WORK_EVENT_NAME]);
  expect(JSON.stringify(f.attention)).not.toContain('synthetic-41');
});

it('reuses stable report IDs when a restart rereads a page before its cursor update was saved', async () => {
  const f = fixture(query => query.get('baseline') === 'true' ? { cursor: '40' } : { cursor: '41', events: [event(41)] });
  const work = f.create(20);
  await f.source.refresh();
  advance();
  await f.source.refresh();
  const first = f.store.get({ work_id: work.id });
  f.storage.sql.exec('UPDATE event_sources SET state=? WHERE name=?', '40', WATCH_SOURCE_NAME);
  const restarted = new WorkWatchSource(f.storage, new WorkStore(f.storage, item => f.attention.push(item)), f.env);
  advance();
  await restarted.refresh();
  const reread = f.store.get({ work_id: work.id });
  expect(reread.pending_reports).toHaveLength(1);
  expect(reread.work.last_report_seq).toBe(first.work.last_report_seq);
  expect(f.attention).toHaveLength(1);
  expect(f.cursor()?.state).toBe('41');
  expect(f.calls.filter(call => call.baseline)).toHaveLength(1);
});

it('records broken and auto-paused Watch transitions as blocked reports without finishing the work', async () => {
  const f = fixture(query => query.get('baseline') === 'true' ? { cursor: '40' }
    : { cursor: '42', events: [event(41, 'watch_broken'), event(42, 'watch_paused')] });
  const work = f.create(30);
  await f.source.refresh();
  advance();
  await f.source.refresh();
  const read = f.store.get({ work_id: work.id });
  expect(read.pending_reports.map(report => [report.report_id, report.kind, report.evidence_ref]))
    .toEqual([['watch:41', 'blocked', ''], ['watch:42', 'blocked', '']]);
  expect(read.pending_reports[0]?.summary).toContain('failing');
  expect(read.pending_reports[1]?.summary).toContain('paused');
  expect(read.work.state).toBe('active');
  expect(f.attention).toHaveLength(2);
});

it('keeps an expired cursor and exposes the source error instead of silently jumping to a new baseline', async () => {
  const f = fixture(query => query.get('baseline') === 'true' ? { cursor: 'expired-40' } : expired());
  const work = f.create(40);
  await f.source.refresh();
  advance();
  await f.source.refresh();
  expect(f.source.status()).toMatchObject({ name: WATCH_SOURCE_NAME, error_code: 'watch_cursor_expired', checked_at: Date.now() });
  expect(f.cursor()?.state).toBe('expired-40');
  expect(f.store.get({ work_id: work.id }).pending_reports).toEqual([]);
  await f.source.refresh();
  expect(f.calls).toHaveLength(2);
  advance();
  await f.source.refresh();
  expect(f.calls.map(call => call.baseline)).toEqual([true, false, false]);
  expect(f.calls.slice(1).map(call => call.cursor)).toEqual(['expired-40', 'expired-40']);
  expect(f.attention).toEqual([]);
});

it('makes first-baseline failures visible and throttles retries before establishing a later baseline', async () => {
  let fail = true;
  const f = fixture(() => fail ? Response.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'Synthetic source outage' } }, { status: 503 })
    : { cursor: 'recovered-40' });
  const work = f.create(50);
  await f.source.refresh();
  expect(f.source.status()).toMatchObject({ error_code: 'watch_source_unavailable', checked_at: Date.now() });
  expect(f.cursor()?.state).toBe('');
  await f.source.refresh();
  expect(f.calls).toHaveLength(1);
  fail = false;
  advance();
  await f.source.refresh();
  expect(f.calls.map(call => call.baseline)).toEqual([true, true]);
  expect(f.source.status().error_code).toBeNull();
  expect(f.cursor()?.state).toBe('recovered-40');
  expect(f.store.get({ work_id: work.id }).pending_reports).toEqual([]);
});
