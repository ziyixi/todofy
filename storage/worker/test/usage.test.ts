import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { OverviewSchema, type Overview } from '@ziyixi/proto/storage/ui/v1/overview_pb';
import { ListClientsResponseSchema, type ListClientsResponse } from '@ziyixi/proto/storage/ui/v1/storage_ui_service_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dropbox, Space } from '../src/dropbox.ts';
import { handlers, type OwnerContext } from '../src/owner.ts';
import type { Store } from '../src/store.ts';
import { DAY_MS, outcomeOf, Usage } from '../src/usage.ts';
import { seedNamespaceAndKey, setupConnected, sqliteStore } from './sqlite.ts';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const WRITER = '00000000-0000-4000-8000-000000000001';
const READER = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const transaction = (write: () => void): void => { write(); };
const refused = (reason: string, httpStatus: number, headers: Record<string, string> = {}): RpcError =>
  new RpcError(Code.UNAVAILABLE, reason, 'Synthetic refusal.', { httpStatus, headers });

function fixture() {
  const { store, database } = sqliteStore();
  // A connection from before this client's records, so successes are kept.
  setupConnected(store, { connectTime: NOW - 200 * DAY_MS });
  for (const [id, namespace, access] of [[WRITER, 'synthetic', 2], [READER, 'synthetic', 1], [OTHER, 'other', 2]] as const) {
    seedNamespaceAndKey({ id, label: 'Synthetic ' + id.slice(-1), namespace, access, create_time: NOW - DAY_MS }, store);
  }
  const rows = (query: string) => database.prepare(query).all() as Record<string, unknown>[];
  return { store, rows, usage: new Usage() };
}

interface WireClient { readonly name: string; readonly last_use_time?: string }
interface WireOverview {
  readonly usage?: readonly { readonly day: string }[]; readonly usage_truncated?: boolean; readonly clients?: readonly WireClient[];
  readonly settings?: Record<string, unknown>; readonly space?: Record<string, unknown>; readonly object_scan?: Record<string, unknown>;
}

const SPACE: Space = { state: 'observed', used: 600 * 2 ** 30, allocated: 2 * 2 ** 40, time: NOW - 60_000 };

function context(store: Store, flushUsage = vi.fn()): OwnerContext {
  return {
    store, dropbox: { space: () => Promise.resolve(SPACE) } as unknown as Dropbox, redirectUri: 'https://storage.example.test/api/dropbox/callback',
    flushUsage, buildSha: 'synthetic', stateSizeBytes: () => 8192, scheduleScan: () => Promise.resolve(),
  };
}

/** The overview's wire JSON, as the console reads it. */
async function overview(store: Store, flushUsage = vi.fn()): Promise<WireOverview> {
  const answer = await handlers.getOverview({ name: 'overview' } as never, context(store, flushUsage)) as Overview;
  const wire: unknown = toWire(OverviewSchema, answer);
  return wire as WireOverview;
}

afterEach(() => { vi.useRealTimers(); });

describe('request outcomes', () => {
  it('keeps absent objects and create conflicts apart from rate limits and failures', () => {
    expect(outcomeOf(new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'Synthetic.'))).toBe('not_found');
    expect(outcomeOf(new RpcError(Code.ABORTED, 'REVISION_CONFLICT', 'Synthetic.'))).toBe('conflict');
    expect(outcomeOf(refused('UNAVAILABLE', 429, { 'retry-after': '3' }))).toBe('rate_limited');
    for (const error of [refused('INSUFFICIENT_SPACE', 507), refused('BATCH_INCOMPLETE', 503), refused('READ_ONLY', 403), new Error('synthetic bug')]) {
      expect(outcomeOf(error)).toBe('failed');
    }
  });
});

describe('in-memory counters', () => {
  it('writes one row per day, credential, operation and outcome, not one per request', () => {
    const { store, rows, usage } = fixture();
    for (let index = 0; index < 1000; index++) usage.succeeded(WRITER, 'stat', {}, NOW);
    for (let index = 0; index < 500; index++) usage.succeeded(READER, 'get', { downloadBytes: 3 }, NOW + 1);
    usage.succeeded(WRITER, 'batch_create', { objects: 32, uploadBytes: 4096 }, NOW + 2);
    usage.succeeded(WRITER, 'batch_create', { objects: 7, uploadBytes: 512 }, NOW + 3);
    usage.failed(READER, 'stat', new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'Synthetic.'), NOW + 4);
    expect(rows('SELECT * FROM usage_daily')).toEqual([]);

    usage.flush(store, transaction, NOW + 5);
    expect(usage.dirty).toBe(false);
    expect(rows('SELECT client_id, operation, outcome, requests, objects, upload_bytes, download_bytes, max_batch FROM usage_daily ORDER BY client_id, operation, outcome')).toEqual([
      { client_id: WRITER, operation: 'batch_create', outcome: 'ok', requests: 2, objects: 39, upload_bytes: 4608, download_bytes: 0, max_batch: 32 },
      { client_id: WRITER, operation: 'stat', outcome: 'ok', requests: 1000, objects: 0, upload_bytes: 0, download_bytes: 0, max_batch: 0 },
      { client_id: READER, operation: 'get', outcome: 'ok', requests: 500, objects: 0, upload_bytes: 0, download_bytes: 1500, max_batch: 0 },
      { client_id: READER, operation: 'stat', outcome: 'not_found', requests: 1, objects: 0, upload_bytes: 0, download_bytes: 0, max_batch: 0 },
    ]);
    expect(rows('SELECT id, last_use_time FROM clients ORDER BY id')).toEqual([
      { id: WRITER, last_use_time: NOW + 3 }, { id: READER, last_use_time: NOW + 4 }, { id: OTHER, last_use_time: 0 },
    ]);
    // An absent object is still a Dropbox answer; only a successful PUT or batch is a write.
    expect(store.get('last_success')).toBe(NOW + 4);
    expect(store.get('last_write_success')).toBe(NOW + 3);
    expect(rows('SELECT * FROM recent_failures')).toEqual([]);

    usage.flush(store, transaction, NOW + 6);
    usage.succeeded(WRITER, 'stat', {}, NOW + 7);
    usage.failed(WRITER, 'put', refused('INSUFFICIENT_SPACE', 507), NOW + 8);
    usage.flush(store, transaction, NOW + 9);
    expect(rows("SELECT requests FROM usage_daily WHERE client_id = '" + WRITER + "' AND operation = 'stat'")).toEqual([{ requests: 1001 }]);
    expect([store.get('last_success'), store.get('last_write_success')]).toEqual([NOW + 7, NOW + 3]);
  });

  it('keeps successes counted before a reconnect or after a disconnect off the current connection', () => {
    const { store, usage } = fixture();
    setupConnected(store, { generation: 'synthetic-new', connectTime: NOW + 10 });
    usage.succeeded(WRITER, 'put', { objects: 1, uploadBytes: 3 }, NOW);
    usage.flush(store, transaction, NOW + 20);
    expect([store.get('last_success'), store.get('last_write_success')]).toEqual([null, null]);
    usage.succeeded(READER, 'get', { downloadBytes: 3 }, NOW + 30);
    usage.flush(store, transaction, NOW + 40);
    expect([store.get('last_success'), store.get('last_write_success')]).toEqual([NOW + 30, null]);
    store.delete('connection');
    usage.succeeded(WRITER, 'put', { objects: 1, uploadBytes: 3 }, NOW + 50);
    usage.flush(store, transaction, NOW + 60);
    expect([store.get('last_success'), store.get('last_write_success')]).toEqual([NOW + 30, null]);
  });

  it('starts a new row on the next UTC day and prunes days older than 90', () => {
    const { store, rows, usage } = fixture();
    usage.succeeded(WRITER, 'put', { objects: 1, uploadBytes: 3 }, NOW - 100 * DAY_MS);
    usage.flush(store, transaction, NOW - 100 * DAY_MS);
    usage.succeeded(WRITER, 'put', { objects: 1, uploadBytes: 3 }, NOW - DAY_MS);
    usage.succeeded(WRITER, 'put', { objects: 1, uploadBytes: 3 }, NOW);
    usage.flush(store, transaction, NOW);
    expect(rows('SELECT day, requests FROM usage_daily ORDER BY day')).toEqual([{ day: '2026-11-02', requests: 1 }, { day: '2026-11-03', requests: 1 }]);
  });

  it('lists a failure once a minute per credential, operation and reason, a rate limit once per credential, and keeps the newest 50', () => {
    const { store, rows, usage } = fixture();
    usage.failed(WRITER, 'put', new RpcError(Code.ABORTED, 'REVISION_CONFLICT', 'Synthetic.'), NOW);
    usage.failed(WRITER, 'batch_create', refused('UNAVAILABLE', 429, { 'retry-after': '7' }), NOW);
    usage.failed(WRITER, 'batch_create', refused('UNAVAILABLE', 429, { 'retry-after': '7' }), NOW + 59_000);
    usage.failed(WRITER, 'stat', refused('UNAVAILABLE', 429, { 'retry-after': '2' }), NOW + 3);
    usage.failed(OTHER, 'stat', refused('UNAVAILABLE', 429, { 'retry-after': '2' }), NOW + 4);
    usage.failed(WRITER, 'stat', refused('UNAVAILABLE', 503), NOW + 5);
    usage.failed(WRITER, 'list', refused('UNAVAILABLE', 503), NOW + 6);
    usage.failed(READER, 'put', refused('READ_ONLY', 403), NOW + 1);
    usage.flush(store, transaction, NOW + 7);
    expect(rows('SELECT client_id, operation, reason, http_status, retry_after FROM recent_failures ORDER BY time')).toEqual([
      { client_id: WRITER, operation: 'batch_create', reason: 'UNAVAILABLE', http_status: 429, retry_after: 7 },
      { client_id: READER, operation: 'put', reason: 'READ_ONLY', http_status: 403, retry_after: 0 },
      { client_id: OTHER, operation: 'stat', reason: 'UNAVAILABLE', http_status: 429, retry_after: 2 },
      { client_id: WRITER, operation: 'stat', reason: 'UNAVAILABLE', http_status: 503, retry_after: 0 },
      { client_id: WRITER, operation: 'list', reason: 'UNAVAILABLE', http_status: 503, retry_after: 0 },
    ]);
    expect(rows("SELECT operation, outcome, requests FROM usage_daily WHERE client_id = '" + WRITER + "' AND outcome = 'rate_limited' ORDER BY operation")).toEqual([
      { operation: 'batch_create', outcome: 'rate_limited', requests: 2 }, { operation: 'stat', outcome: 'rate_limited', requests: 1 },
    ]);

    for (let index = 0; index < 60; index++) usage.failed(OTHER, 'list', refused('PROVIDER_RESPONSE_INVALID', 503), NOW + (index + 1) * 61_000);
    usage.flush(store, transaction, NOW + 61 * 61_000);
    const kept = store.failures();
    expect(kept).toHaveLength(50);
    expect(kept[0]?.time).toBe(NOW + 60 * 61_000);
    expect(kept.at(-1)?.time).toBe(NOW + 11 * 61_000);
  });
});

describe('overview', () => {
  it('answers settings, credentials, 14 UTC days of counts and failures in one wire answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { store, usage } = fixture();
    setupConnected(store, { connectTime: NOW - 2 * DAY_MS });
    store.set('app_key', 'syntheticappkey');
    store.set('provider_error', { reason: 'UNAVAILABLE', time: NOW - DAY_MS });
    usage.succeeded(WRITER, 'put', { objects: 1, uploadBytes: 3 }, NOW - 14 * DAY_MS);
    usage.flush(store, transaction, NOW - 14 * DAY_MS);
    usage.succeeded(WRITER, 'put', { objects: 1, uploadBytes: 3 }, NOW - 13 * DAY_MS);
    usage.succeeded(OTHER, 'list', {}, NOW - 60_000);
    usage.failed(READER, 'put', refused('READ_ONLY', 403), NOW - 30_000);
    const flushUsage = vi.fn(() => { usage.flush(store, transaction); });
    const answer = await overview(store, flushUsage);
    expect(flushUsage).toHaveBeenCalledOnce();
    expect(answer).toMatchObject({
      name: 'overview', generate_time: '2026-11-03T12:00:00Z', build_sha: 'synthetic', state_size_bytes: 8192,
      settings: {
        connected: true, app_key: 'syntheticappkey', last_provider_error: 'UNAVAILABLE', last_provider_error_time: '2026-11-02T12:00:00Z',
        connect_time: '2026-11-01T12:00:00Z', last_success_time: '2026-11-03T11:59:00Z',
      },
      usage: [
        { day: '2026-11-03', client: 'clients/' + READER, namespace: 'synthetic', operation: 'put', outcome: 'failed', request_count: 1 },
        { day: '2026-11-03', client: 'clients/' + OTHER, namespace: 'other', operation: 'list', outcome: 'ok', request_count: 1 },
        { day: '2026-10-21', client: 'clients/' + WRITER, namespace: 'synthetic', operation: 'put', outcome: 'ok', request_count: 1, object_count: 1, upload_bytes: 3 },
      ],
      recent_failures: [{ failure_time: '2026-11-03T11:59:30Z', client: 'clients/' + READER, namespace: 'synthetic', operation: 'put', reason: 'READ_ONLY', http_status: 403 }],
      space: { state: 'observed', used_bytes: 600 * 2 ** 30, allocated_bytes: 2 * 2 ** 40, observe_time: '2026-11-03T11:59:00Z' },
    });
    expect(answer).not.toHaveProperty('object_scan');
    expect(answer.usage).toHaveLength(3);
    expect(answer.usage_truncated).toBeUndefined();
    // Both writes predate this connection.
    expect(answer.settings).not.toHaveProperty('last_write_success_time');
    store.set('last_write_success', NOW - 45_000);
    expect((await overview(store)).settings).toMatchObject({ last_write_success_time: '2026-11-03T11:59:15Z' });
    expect(answer.clients?.map((client) => [client.name, client.last_use_time])).toEqual([
      ['clients/' + WRITER, '2026-10-21T12:00:00Z'], ['clients/' + READER, '2026-11-03T11:59:30Z'], ['clients/' + OTHER, '2026-11-03T11:59:00Z'],
    ]);
    const listed = toWire(ListClientsResponseSchema, await handlers.listClients({ pageSize: 0, pageToken: '' } as never, context(store)) as ListClientsResponse) as { clients?: WireClient[] };
    expect(listed.clients?.[2]?.last_use_time).toBe('2026-11-03T11:59:00Z');
  });

  it('drops the oldest counts past the response bound and says so', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { store, usage } = fixture();
    // Every operation and outcome on each of 14 days: 150 counts a day for five credentials.
    const outcomes = [refused('UNAVAILABLE', 429), refused('INTERNAL', 500), new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'Synthetic.'), new RpcError(Code.ABORTED, 'REVISION_CONFLICT', 'Synthetic.')];
    const fill = (clients: readonly string[]): void => {
      for (let day = 0; day < 14; day++) {
        for (const client of clients) {
          for (const operation of ['stat', 'list', 'get', 'head', 'put', 'batch_create'] as const) {
            for (const error of outcomes) usage.failed(client, operation, error, NOW - day * DAY_MS);
            usage.succeeded(client, operation, {}, NOW - day * DAY_MS);
          }
        }
      }
      usage.flush(store, transaction, NOW);
    };
    fill([WRITER, READER, OTHER]);
    const bounded = await overview(store);
    expect(bounded.usage).toHaveLength(1260);
    expect(bounded.usage_truncated).toBeUndefined();
    const more = ['00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005'];
    for (const [index, id] of more.entries()) {
      seedNamespaceAndKey({ id, label: 'Synthetic more', namespace: 'more', token_sha256: String(index).repeat(64), create_time: NOW }, store);
    }
    fill(more);
    const truncated = await overview(store);
    expect(truncated.usage).toHaveLength(2000);
    expect(truncated.usage_truncated).toBe(true);
    expect(truncated.usage?.[0]?.day).toBe('2026-11-03');
    expect(truncated.usage?.filter((count) => count.day === '2026-10-21')).toHaveLength(50);
  });
});
