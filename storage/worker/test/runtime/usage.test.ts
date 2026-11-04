import { afterEach, expect, it } from 'vitest';
import { HASH, harness } from './harness.ts';

interface Count { readonly client: string; readonly namespace: string; readonly operation: string; readonly outcome: string; readonly request_count: number; readonly object_count?: number; readonly upload_bytes?: number; readonly download_bytes?: number; readonly max_batch_object_count?: number }
interface Overview {
  readonly settings: { readonly connected?: boolean; readonly connect_time?: string; readonly last_success_time?: string };
  readonly clients?: readonly { readonly name: string; readonly last_use_time?: string }[];
  readonly usage?: readonly Count[];
  readonly recent_failures?: readonly { readonly client: string; readonly operation: string; readonly reason: string; readonly http_status: number }[];
  readonly build_sha: string;
  readonly state_size_bytes: number;
}

let current: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

function batch(items: readonly { readonly key: string; readonly data: Uint8Array }[]) {
  const body = new Uint8Array(items.reduce((sum, item) => sum + item.data.byteLength, 0));
  let offset = 0;
  for (const item of items) { body.set(item.data, offset); offset += item.data.byteLength; }
  const manifest = { objects: items.map((item) => ({ key: item.key, size_bytes: item.data.byteLength, content_hash: HASH(item.data) })), content_hash: HASH(body) };
  return { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.byteLength), 'x-storage-batch': JSON.stringify(manifest) } };
}

it('counts application requests in memory and writes them on a timer before a restart', async () => {
  current = await harness();
  await current.connect();
  const writer = await current.client('synthetic');
  const reader = await current.client('synthetic', 'read_only');
  const other = await current.client('other');
  const bytes = new TextEncoder().encode('synthetic-object');
  const json = { method: 'POST', headers: { 'content-type': 'application/json' } };
  expect((await current.machine('content?key=one.bin', writer.api_key, { method: 'PUT', body: bytes, headers: { 'if-none-match': '*', 'content-length': String(bytes.byteLength) } })).status).toBe(200);
  const encoder = new TextEncoder();
  expect((await current.machine('content', writer.api_key, batch([{ key: 'a.bin', data: encoder.encode('synthetic a') }, { key: 'b.bin', data: encoder.encode('synthetic bb') }]))).status).toBe(200);
  const read = await current.machine('content?key=one.bin', reader.api_key);
  expect(await read.text()).toBe('synthetic-object');
  expect((await current.machine('stat', reader.api_key, { ...json, body: JSON.stringify({ key: 'absent.bin' }) })).status).toBe(404);
  expect((await current.machine('content?key=two.bin', reader.api_key, { method: 'PUT', body: bytes, headers: { 'if-none-match': '*', 'content-length': String(bytes.byteLength) } })).status).toBe(403);
  for (let index = 0; index < 3; index++) expect((await current.machine('list', other.api_key, { ...json, body: '{}' })).status).toBe(200);
  // Unknown routes and malformed keys are not application operations.
  expect((await current.machine('content?key=one.bin', writer.api_key, { method: 'DELETE' })).status).toBe(405);
  expect((await current.machine('stat', null, { ...json, body: '{}' })).status).toBe(401);

  // The loopback harness writes 50 ms after the first request; a restart then drops only memory.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await current.restart();
  const response = await current.owner('overview');
  expect(response.status).toBe(200);
  const overview = await response.json<Overview>();
  const counts = (overview.usage ?? []).map(({ client, namespace, operation, outcome, request_count, object_count, upload_bytes, download_bytes, max_batch_object_count }) =>
    ({ client, namespace, operation, outcome, request_count, object_count, upload_bytes, download_bytes, max_batch_object_count }));
  expect(counts).toHaveLength(6);
  expect(counts).toEqual(expect.arrayContaining([
    { client: writer.name, namespace: 'synthetic', operation: 'put', outcome: 'ok', request_count: 1, object_count: 1, upload_bytes: bytes.byteLength, download_bytes: undefined, max_batch_object_count: undefined },
    { client: writer.name, namespace: 'synthetic', operation: 'batch_create', outcome: 'ok', request_count: 1, object_count: 2, upload_bytes: 23, download_bytes: undefined, max_batch_object_count: 2 },
    { client: reader.name, namespace: 'synthetic', operation: 'get', outcome: 'ok', request_count: 1, object_count: undefined, upload_bytes: undefined, download_bytes: bytes.byteLength, max_batch_object_count: undefined },
    { client: reader.name, namespace: 'synthetic', operation: 'stat', outcome: 'not_found', request_count: 1, object_count: undefined, upload_bytes: undefined, download_bytes: undefined, max_batch_object_count: undefined },
    { client: reader.name, namespace: 'synthetic', operation: 'put', outcome: 'failed', request_count: 1, object_count: undefined, upload_bytes: undefined, download_bytes: undefined, max_batch_object_count: undefined },
    { client: other.name, namespace: 'other', operation: 'list', outcome: 'ok', request_count: 3, object_count: undefined, upload_bytes: undefined, download_bytes: undefined, max_batch_object_count: undefined },
  ]));
  expect(overview.recent_failures).toEqual([expect.objectContaining({ client: reader.name, operation: 'put', reason: 'READ_ONLY', http_status: 403 })]);
  expect(overview.clients?.every((client) => typeof client.last_use_time === 'string')).toBe(true);
  expect(overview.settings.connected).toBe(true);
  expect([typeof overview.settings.connect_time, typeof overview.settings.last_success_time]).toEqual(['string', 'string']);
  expect(overview.build_sha).toBe('test');
  expect(overview.state_size_bytes).toBeGreaterThan(0);
  expect(JSON.stringify(overview)).not.toContain(writer.api_key);
});

it('writes pending counts when the overview is read and keeps a revoked key in its namespace', async () => {
  current = await harness();
  await current.connect();
  const key = await current.client('synthetic', 'read_only');
  const json = { method: 'POST', headers: { 'content-type': 'application/json' } };
  expect((await current.machine('stat', key.api_key, { ...json, body: JSON.stringify({ key: 'absent.bin' }) })).status).toBe(404);
  expect((await current.owner(key.name, 'DELETE')).status).toBe(200);
  const overview = await (await current.owner('overview')).json<Overview>();
  expect(overview.clients ?? []).toEqual([]);
  expect(overview.usage).toEqual([expect.objectContaining({ client: key.name, namespace: 'synthetic', operation: 'stat', outcome: 'not_found', request_count: 1 })]);
  expect(overview.recent_failures).toBeUndefined();
  const settings = await (await current.owner('settings')).json<Overview['settings']>();
  expect(typeof settings.last_success_time).toBe('string');
  expect((await current.owner('dropbox:disconnect', 'POST', {})).status).toBe(200);
  const disconnected = await (await current.owner('settings')).json<Overview['settings']>();
  expect(disconnected).not.toHaveProperty('last_success_time');
  expect(disconnected).not.toHaveProperty('connect_time');
});
