import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { HASH, harness } from './harness.ts';

interface Item { readonly key: string; readonly data: Uint8Array }
interface Metadata { readonly key: string; readonly revision: string; readonly size_bytes: number; readonly content_hash: string }
let current: Awaited<ReturnType<typeof harness>> | undefined;
const items = [
  { key: 'raw/first.json.gz', data: new TextEncoder().encode('synthetic first bytes') },
  { key: 'working/parts/second.parquet', data: new TextEncoder().encode('synthetic second bytes') },
] as const satisfies readonly Item[];

function input(files: readonly Item[] = items) {
  const body = new Uint8Array(files.reduce((sum, item) => sum + item.data.byteLength, 0));
  let offset = 0;
  for (const item of files) { body.set(item.data, offset); offset += item.data.byteLength; }
  const manifest = { objects: files.map((item) => ({ key: item.key, size_bytes: item.data.byteLength, content_hash: HASH(item.data) })), content_hash: HASH(body) };
  return { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.byteLength), 'x-storage-batch': JSON.stringify(manifest) } };
}

async function setup() {
  current = await harness();
  await current.connect();
  const key = await current.client('synthetic');
  return { active: current, token: key.api_key };
}

async function failure(response: Response, status: number, reason: string) {
  expect(response.status).toBe(status);
  const body = await response.text();
  const error = JSON.parse(body) as { error: { details: Record<string, unknown>[] } };
  expect(error.error.details).toContainEqual(expect.objectContaining({ reason }));
  for (const value of ['synthetic-session-', 'synthetic-private-access', 'synthetic unknown', 'dropboxapi.com', '/namespaces/']) expect(body).not.toContain(value);
}

afterEach(async () => { await current?.dispose(); current = undefined; });

it('creates one ordered batch with native streams and three Dropbox requests', async () => {
  const { active, token } = await setup();
  const response = await active.machine('content', token, input());
  expect(response.status).toBe(200);
  const metadata = await response.json<{ objects: Metadata[] }>();
  expect(metadata.objects.map((item) => item.key)).toEqual(items.map((item) => item.key));
  expect(active.provider.calls.map((call) => call.path)).toEqual([
    '/2/files/upload_session/start_batch', '/2/files/upload_session/append_batch', '/2/files/upload_session/finish_batch_v2',
  ]);
  for (const [index, item] of items.entries()) {
    expect(metadata.objects[index]).toMatchObject({ key: item.key, size_bytes: item.data.byteLength, content_hash: HASH(item.data) });
    const file = active.provider.files.get('/namespaces/synthetic/' + item.key);
    expect(file?.bytes).toEqual(item.data);
  }
  expect(active.provider.refreshes).toBe(1);
});

it('rejects unauthenticated and readonly batches before parsing headers or forwarding bytes', async () => {
  const { active } = await setup();
  const reader = await active.client('synthetic', 'read_only');
  const invalid = { ...input(), headers: { ...input().headers, 'x-storage-batch': '{invalid' } };
  await failure(await active.machine('content', null, invalid), 401, 'UNAUTHORIZED');
  await failure(await active.machine('content', reader.api_key, invalid), 403, 'READ_ONLY');
  expect(active.provider.calls).toEqual([]);
});

it('validates the manifest, exact total, body type and query before starting sessions', async () => {
  const { active, token } = await setup();
  const valid = input();
  const manifest = JSON.parse(valid.headers['x-storage-batch']) as { objects: { key: string; size_bytes: number; content_hash: string }[]; content_hash: string };
  const invalid = [
    { ...manifest, objects: [] },
    { ...manifest, objects: Array.from({ length: 33 }, () => manifest.objects[0]) },
    { ...manifest, objects: [{ ...manifest.objects[0], size_bytes: 0 }] },
    { ...manifest, objects: [{ ...manifest.objects[0], key: '../outside' }] },
    { ...manifest, objects: [manifest.objects[0], manifest.objects[0]] },
    { ...manifest, objects: [{ ...manifest.objects[0], key: 'raw/FILE' }, { ...manifest.objects[1], key: 'raw/file' }] },
    { ...manifest, objects: [{ ...manifest.objects[0], content_hash: 'invalid' }] },
    { ...manifest, private: 'unknown' },
  ];
  for (const value of invalid) {
    await failure(await active.machine('content', token, { ...valid, headers: { ...valid.headers, 'x-storage-batch': JSON.stringify(value) } }), 400, 'BAD_REQUEST');
  }
  await failure(await active.machine('content', token, { method: 'DELETE' }), 405, 'METHOD_NOT_ALLOWED');
  await failure(await active.machine('content?extra=1', token, valid), 400, 'BAD_REQUEST');
  await failure(await active.machine('content?key=raw/legacy.bin', token, valid), 400, 'BAD_REQUEST');
  await failure(await active.machine('content', token, { ...valid, headers: { ...valid.headers, 'content-type': 'application/json' } }), 400, 'BAD_REQUEST');
  await failure(await active.machine('content', token, { ...valid, headers: { ...valid.headers, 'x-storage-batch': JSON.stringify({ ...manifest, objects: manifest.objects.map((item, index) => ({ ...item, size_bytes: item.size_bytes + (index === 0 ? 1 : 0) })) }) } }), 400, 'UPLOAD_LENGTH_MISMATCH');
  await failure(await active.machine('content', token, { ...valid, headers: { ...valid.headers, 'x-storage-batch': 'x'.repeat(8193) } }), 400, 'BAD_REQUEST');
  await failure(await active.machine('content', token, { ...valid, headers: { ...valid.headers, 'x-storage-batch': JSON.stringify({ ...manifest, objects: [{ ...manifest.objects[0], size_bytes: 33554432 }, { ...manifest.objects[1], size_bytes: 1 }] }) } }), 413, 'UPLOAD_TOO_LARGE');
  expect(active.provider.calls).toEqual([]);
});

it('reuses identical conflicts without overwriting and rejects a different existing object', async () => {
  const { active, token } = await setup();
  expect((await active.machine('content', token, input())).status).toBe(200);
  const revisions = [...active.provider.files.values()].map((file) => file.revision);
  const repeated = await active.machine('content', token, input());
  expect(repeated.status).toBe(200);
  expect([...active.provider.files.values()].map((file) => file.revision)).toEqual(revisions);
  expect(active.provider.calls.filter((call) => call.path === '/2/files/get_metadata')).toHaveLength(2);
  const different = [items[0], { ...items[1], data: new TextEncoder().encode('different bytes') }];
  await failure(await active.machine('content', token, input(different)), 409, 'REVISION_CONFLICT');
  expect([...active.provider.files.values()].map((file) => file.revision)).toEqual(revisions);
  expect(active.provider.files.get('/namespaces/synthetic/' + items[1].key)?.bytes).toEqual(items[1].data);
  active.provider.folders.add('/namespaces/synthetic/raw/folder');
  await failure(await active.machine('content', token, input([{ ...items[0], key: 'raw/folder' }])), 409, 'REVISION_CONFLICT');
  expect(active.provider.folders.has('/namespaces/synthetic/raw/folder')).toBe(true);
});

it.each([
  ['append_partial', 503, 'BATCH_NOT_COMMITTED'], ['finish_partial', 507, 'INSUFFICIENT_SPACE'], ['finish_unknown', 503, 'BATCH_INCOMPLETE'],
  ['finish_metadata', 503, 'BATCH_INCOMPLETE'], ['finish_rate', 503, 'BATCH_INCOMPLETE'],
] as const)('does not acknowledge or replay a %s batch', async (fault, status, reason) => {
  const { active, token } = await setup();
  active.provider.batchFault = fault;
  const response = await active.machine('content', token, input());
  await failure(response, status, reason);
  expect(response.headers.get('retry-after')).toBeNull();
  expect(active.provider.calls.filter((call) => call.path.endsWith('/start_batch'))).toHaveLength(1);
  expect(active.provider.calls.filter((call) => call.path.endsWith('/append_batch'))).toHaveLength(1);
  expect(active.provider.calls.filter((call) => call.path.endsWith('/finish_batch_v2'))).toHaveLength(fault === 'append_partial' ? 0 : 1);
  expect(active.provider.files.size).toBe(fault === 'append_partial' || fault === 'finish_rate' ? 0 : fault === 'finish_partial' ? 1 : 2);
});

it.each(['start_rate', 'append_rate'] as const)('preserves an explicit %s rejection before any file commit', async (fault) => {
  const { active, token } = await setup();
  active.provider.batchFault = fault;
  const response = await active.machine('content', token, input());
  await failure(response, 429, 'UNAVAILABLE');
  expect(response.headers.get('retry-after')).toBe('3');
  expect(active.provider.calls.some((call) => call.path.endsWith('/finish_batch_v2'))).toBe(false);
  expect(active.provider.files.size).toBe(0);
});

it('checks the concatenated hash before committing and keeps old single-object CAS routes', async () => {
  const { active, token } = await setup();
  const valid = input();
  const manifest = JSON.parse(valid.headers['x-storage-batch']) as Record<string, unknown>;
  await failure(await active.machine('content', token, { ...valid, headers: { ...valid.headers, 'x-storage-batch': JSON.stringify({ ...manifest, content_hash: 'f'.repeat(64) }) } }), 503, 'BATCH_NOT_COMMITTED');
  expect(active.provider.files.size).toBe(0);
  const body = new TextEncoder().encode('mutable head');
  const first = await active.machine('content?key=control/head', token, { method: 'PUT', body, headers: { 'content-length': String(body.byteLength), 'if-none-match': '*' } });
  expect(first.status).toBe(200);
  const metadata = await first.json<Metadata>();
  const updated = await active.machine('content?key=control/head', token, { method: 'PUT', body, headers: { 'content-length': String(body.byteLength), 'if-match': metadata.revision } });
  expect(updated.status).toBe(200);
});

it('streams the bounded 32-object 32-MiB batch without putting binary bytes in JSON', async () => {
  const { active, token } = await setup();
  const files = Array.from({ length: 32 }, (_, index) => ({ key: `raw/synthetic-${String(index)}.bin`, data: new Uint8Array(1024 * 1024).fill(index) }));
  const response = await active.machine('content', token, input(files));
  expect(response.status).toBe(200);
  expect((await response.json<{ objects: Metadata[] }>()).objects).toHaveLength(32);
  expect(active.provider.calls).toHaveLength(3);
  expect(active.provider.files.size).toBe(32);
  // The worst case: every item conflicts and needs its own stat, still within the 50 subrequests of one invocation.
  const repeated = await active.machine('content', token, input(files));
  expect(repeated.status).toBe(200);
  expect(active.provider.calls).toHaveLength(3 + 35);
});

it('checks every item hash across 4 MiB blocks and refuses different bytes before finish', async () => {
  const { active, token } = await setup();
  const block = 4 * 1024 * 1024;
  const files = [
    { key: 'raw/multi-block.bin', data: new Uint8Array(block + 5).map((_, index) => index % 251) },
    { key: 'raw/after-boundary.bin', data: new Uint8Array(block - 3).fill(7) },
    { key: 'raw/small.bin', data: new TextEncoder().encode('synthetic tail') },
  ];
  const response = await active.machine('content', token, input(files));
  expect(response.status).toBe(200);
  for (const item of files) {
    const stored = active.provider.files.get('/namespaces/synthetic/' + item.key)?.bytes ?? new Uint8Array();
    expect([stored.byteLength, HASH(stored)]).toEqual([item.data.byteLength, HASH(item.data)]);
  }
  const swapped = input([{ ...items[0], key: 'raw/swapped-first.bin' }, { ...items[1], key: 'raw/swapped-second.bin' }]);
  const manifest = JSON.parse(swapped.headers['x-storage-batch']) as { objects: { content_hash: string }[] };
  const [first, second] = manifest.objects;
  if (first === undefined || second === undefined) throw new Error('synthetic manifest');
  [first.content_hash, second.content_hash] = [second.content_hash, first.content_hash];
  const calls = active.provider.calls.length;
  await failure(await active.machine('content', token, { ...swapped, headers: { ...swapped.headers, 'x-storage-batch': JSON.stringify(manifest) } }), 400, 'UPLOAD_HASH_MISMATCH');
  expect(active.provider.calls.slice(calls).map((call) => call.path)).not.toContain('/2/files/upload_session/finish_batch_v2');
  expect(active.provider.files.has('/namespaces/synthetic/raw/swapped-first.bin')).toBe(false);
});

it('accepts the contract golden batch unchanged and answers the golden confirmation bytes', async () => {
  const { active, token } = await setup();
  const fixture = (name: string) => new NodeURL('../../../../contracts/storage-objects-v1/fixtures/' + name, import.meta.url);
  const body = new Uint8Array(readFileSync(fixture('body.bin')));
  const response = await active.machine('content', token, {
    method: 'POST', body,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.byteLength), 'x-storage-batch': readFileSync(fixture('manifest.json'), 'utf8') },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(readFileSync(fixture('response.json'), 'utf8'));
});

it('shows the newest error Dropbox answered, without provider content, until disconnect', async () => {
  const { active, token } = await setup();
  const settings = async () => await (await active.owner('settings')).json<{ last_provider_error?: string; last_provider_error_time?: string }>();
  expect((await settings()).last_provider_error).toBeUndefined();
  active.provider.batchFault = 'finish_partial';
  await failure(await active.machine('content', token, input()), 507, 'INSUFFICIENT_SPACE');
  const shown = await settings();
  expect(shown.last_provider_error).toBe('INSUFFICIENT_SPACE');
  expect(Date.parse(shown.last_provider_error_time ?? '')).toBeGreaterThan(Date.now() - 60_000);
  expect(JSON.stringify(shown)).not.toContain('insufficient_space');
  const missing = await active.machine('stat', token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'raw/absent.bin' }) });
  expect(missing.status).toBe(404);
  expect((await settings()).last_provider_error).toBe('INSUFFICIENT_SPACE');
  expect((await active.owner('dropbox:disconnect', 'POST', {})).status).toBe(200);
  expect((await settings()).last_provider_error).toBeUndefined();
});
