import { createHash } from 'node:crypto';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { batchCreate } from '../src/batch.ts';
import { Dropbox } from '../src/dropbox.ts';
import type { ClientRow, Connection } from '../src/store.ts';

const client: ClientRow = { id: 'synthetic', label: 'Synthetic', namespace: 'synthetic', access: 2, token_sha256: 'a'.repeat(64), create_time: 0, revoked: 0 };
const connection: Connection = { appKey: 'synthetic', refreshToken: 'synthetic-private-refresh', generation: 'synthetic' };
const hash = createHash('sha256').update(createHash('sha256').update('abc').digest()).digest('hex');

/** Node lacks the Workers DigestStream; the workerd suite runs the native one. */
class NodeDigestStream extends WritableStream<ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = createHash('sha256');
    const digest = Promise.withResolvers<ArrayBuffer>();
    super({
      write(chunk: ArrayBufferView) { hash.update(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); },
      close() { digest.resolve(new Uint8Array(hash.digest()).buffer); },
    });
    expect(algorithm).toBe('SHA-256');
    this.digest = digest.promise;
  }
}

beforeAll(() => { Object.defineProperty(crypto, 'DigestStream', { value: NodeDigestStream, configurable: true }); });
afterAll(() => { Reflect.deleteProperty(crypto, 'DigestStream'); });
afterEach(() => vi.unstubAllGlobals());

function diagnosticRequest(): Request {
  return new Request('https://storage.example.test/api/storage/v1/content', {
    method: 'POST', body: 'abc', headers: {
      'content-type': 'application/octet-stream', 'content-length': '3',
      'x-storage-batch': JSON.stringify({ objects: [{ key: 'raw/synthetic-private-key.bin', size_bytes: 3, content_hash: hash }], content_hash: hash }),
    },
  });
}

const baseDiagnostic = {
  event: 'storage_batch_failed', phase: 'start', finish_started: false, finish_response_received: false,
  entry_tag: 'none', entry_failure_tag: 'none', entry_detail_tag: 'none', cause_reason: 'BATCH_INCOMPLETE', cause_http_status: 503,
};

it.each([
  { name: 'start', reason: 'BATCH_NOT_COMMITTED', expected: { cause_reason: 'BAD_REQUEST', cause_http_status: 400 } },
  { name: 'append', reason: 'BATCH_NOT_COMMITTED', expected: { phase: 'append', entry_tag: 'failure', entry_failure_tag: 'content_hash_mismatch' } },
  { name: 'untrusted entry', reason: 'BATCH_NOT_COMMITTED', expected: { phase: 'append', entry_tag: 'failure', entry_failure_tag: 'other' } },
  { name: 'finish', reason: 'BATCH_INCOMPLETE', expected: { phase: 'finish', finish_started: true, cause_reason: 'UNAVAILABLE' } },
  { name: 'finish rate', reason: 'BATCH_INCOMPLETE', expected: { phase: 'finish', finish_started: true, cause_reason: 'UNAVAILABLE', cause_http_status: 429 } },
  { name: 'finish entry', reason: 'BATCH_INCOMPLETE', expected: { phase: 'verify', finish_started: true, finish_response_received: true, entry_tag: 'failure', entry_failure_tag: 'path', entry_detail_tag: 'not_found' } },
  { name: 'finish space', reason: 'INSUFFICIENT_SPACE', expected: { phase: 'verify', finish_started: true, finish_response_received: true, entry_tag: 'failure', entry_failure_tag: 'path', entry_detail_tag: 'insufficient_space', cause_reason: 'INSUFFICIENT_SPACE', cause_http_status: 507 } },
  { name: 'verify', reason: 'BATCH_INCOMPLETE', expected: { phase: 'verify', finish_started: true, finish_response_received: true, entry_tag: 'success' } },
  { name: 'metadata', reason: 'BATCH_INCOMPLETE', expected: { phase: 'verify', finish_started: true, finish_response_received: true, entry_tag: 'success', cause_reason: 'PROVIDER_RESPONSE_INVALID' } },
])('logs one safe batch diagnostic for $name and answers $reason', async ({ name, reason, expected }) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> { constructor(length: number) { super(); expect(length).toBe(3); } });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'synthetic-private-access', expires_in: 3600 });
    if (url.endsWith('/start_batch')) return name === 'start'
      ? new Response('synthetic-private-provider-body', { status: 400 })
      : Response.json({ session_ids: ['synthetic-private-session'] });
    if (url.endsWith('/append_batch')) {
      await new Response(init.body).arrayBuffer();
      return Response.json({ entries: [name === 'append' || name === 'untrusted entry'
        ? { '.tag': 'failure', failure: { '.tag': name === 'append' ? 'content_hash_mismatch' : 'synthetic-private-failure', path: 'synthetic-private-path' } }
        : { '.tag': 'success' }] });
    }
    if (name === 'finish' || name === 'finish rate') return new Response('synthetic-private-provider-body', { status: name === 'finish' ? 503 : 429 });
    if (name === 'finish entry' || name === 'finish space') return Response.json({ entries: [{ '.tag': 'failure', failure: { '.tag': 'path', path: { '.tag': name === 'finish entry' ? 'not_found' : 'insufficient_space' } } }] });
    return Response.json({ entries: [{ '.tag': 'success', path_display: '/namespaces/synthetic/raw/synthetic-private-key.bin',
      rev: 'synthetic', size: 3, content_hash: '0'.repeat(64), ...(name === 'metadata' ? { path_display: 'synthetic-private-invalid-path' } : {}) }] });
  });
  const provider = new Dropbox({ get: () => null, set: () => undefined, delete: () => undefined, connection: () => connection }, {});
  await expect(batchCreate(diagnosticRequest(), client, provider)).rejects.toMatchObject({ reason, httpStatus: reason === 'INSUFFICIENT_SPACE' ? 507 : 503 });
  expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ...baseDiagnostic, ...expected }));
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private');
});

it.each([
  { tag: 'lookup_failed', value: { '.tag': 'not_closed' }, detail: 'not_closed' },
  { tag: 'lookup_failed', value: { '.tag': 'incorrect_offset' }, detail: 'incorrect_offset' },
  { tag: 'path', value: { '.tag': 'no_write_permission' }, detail: 'no_write_permission' },
  { tag: 'path', value: { '.tag': 'insufficient_space' }, detail: 'insufficient_space' },
  { tag: 'path', value: { '.tag': 'conflict', conflict: { '.tag': 'file', path: 'synthetic-private-path' } }, detail: 'conflict' },
  { tag: 'path', value: { '.tag': 'synthetic-private-tag' }, detail: 'other' },
  { tag: 'path', value: { reason: { '.tag': 'insufficient_space' } }, detail: 'other' },
  { tag: 'other', value: { '.tag': 'incorrect_offset' }, detail: 'none' },
])('limits nested batch diagnostic tags to one approved field: $tag/$detail', async ({ tag, value, detail }) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> { constructor(length: number) { super(); expect(length).toBe(3); } });
  const provider = new Dropbox({ get: () => null, set: () => undefined, delete: () => undefined, connection: () => connection }, {});
  vi.spyOn(provider, 'json').mockResolvedValue({ session_ids: ['synthetic-private-session'] });
  vi.spyOn(provider, 'appendBatch').mockImplementation(async (_args, body) => {
    await new Response(body).arrayBuffer();
    return { entries: [{ '.tag': 'failure', failure: { '.tag': tag, [tag]: value } }] };
  });
  await expect(batchCreate(diagnosticRequest(), client, provider)).rejects.toMatchObject({ reason: 'BATCH_NOT_COMMITTED', httpStatus: 503 });
  expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ...baseDiagnostic,
    phase: 'append', entry_tag: 'failure', entry_failure_tag: tag, entry_detail_tag: detail }));
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private');
});

it.each([
  { error: new Error('synthetic-private-exception'), reason: 'UNEXPECTED_ERROR' },
  { error: new RpcError(Code.UNAVAILABLE, 'SYNTHETIC_PRIVATE_REASON', 'synthetic-private-message', { httpStatus: 700 }), reason: 'UNKNOWN_RPC_ERROR' },
])('bounds unexpected diagnostic reasons and status: $reason', async ({ error, reason }) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const provider = new Dropbox({ get: () => null, set: () => undefined, delete: () => undefined, connection: () => connection }, {});
  vi.spyOn(provider, 'json').mockRejectedValue(error);
  await expect(batchCreate(diagnosticRequest(), client, provider)).rejects.toMatchObject({ reason: 'BATCH_NOT_COMMITTED', httpStatus: 503 });
  expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ...baseDiagnostic, cause_reason: reason, cause_http_status: 0 }));
});

it('keeps the original error when the diagnostic sink fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('synthetic log unavailable'); });
  const provider = new Dropbox({ get: () => null, set: () => undefined, delete: () => undefined, connection: () => connection }, {});
  vi.spyOn(provider, 'json').mockRejectedValue(new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'synthetic-private-message', { httpStatus: 429 }));
  await expect(batchCreate(diagnosticRequest(), client, provider)).rejects.toMatchObject({ reason: 'UNAVAILABLE', httpStatus: 429 });
});

it.each(['ab', 'abcd'])('rejects actual stream length %s before any finish call', async (body) => {
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> { constructor(length: number) { super(); expect(length).toBe(3); } });
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'synthetic-access', expires_in: 3600 });
    calls.push(url);
    if (url.endsWith('/start_batch')) return Response.json({ session_ids: ['synthetic-session'] });
    if (url.endsWith('/append_batch')) {
      await new Response(init.body).arrayBuffer();
      return Response.json({ entries: [{ '.tag': 'success' }] });
    }
    throw new Error('finish must not receive an incomplete stream');
  });
  const provider = new Dropbox({ get: () => null, set: () => undefined, delete: () => undefined, connection: () => connection }, {});
  const request = new Request('https://storage.example.test/api/storage/v1/content', {
    method: 'POST', body, headers: {
      'content-type': 'application/octet-stream', 'content-length': '3',
      'x-storage-batch': JSON.stringify({ objects: [{ key: 'raw/one.bin', size_bytes: 3, content_hash: hash }], content_hash: hash }),
    },
  });
  await expect(batchCreate(request, client, provider)).rejects.toMatchObject({ reason: 'UPLOAD_LENGTH_MISMATCH', httpStatus: 400 });
  expect(calls.map((url) => new URL(url).pathname)).toEqual(['/2/files/upload_session/start_batch', '/2/files/upload_session/append_batch']);
});

it('refuses an item whose bytes differ from its manifest hash before any finish call', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> { constructor(length: number) { super(); expect(length).toBe(7); } });
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'synthetic-access', expires_in: 3600 });
    calls.push(new URL(url).pathname);
    if (url.endsWith('/start_batch')) return Response.json({ session_ids: ['synthetic-first', 'synthetic-second'] });
    if (url.endsWith('/append_batch')) {
      await new Response(init.body).arrayBuffer();
      return Response.json({ entries: [{ '.tag': 'success' }, { '.tag': 'success' }] });
    }
    throw new Error('finish must not commit an item with different bytes');
  });
  const digest = (value: string) => createHash('sha256').update(createHash('sha256').update(value).digest()).digest('hex');
  const provider = new Dropbox({ get: () => null, set: () => undefined, delete: () => undefined, connection: () => connection }, {});
  const request = new Request('https://storage.example.test/api/storage/v1/content', {
    method: 'POST', body: 'abcdefg', headers: {
      'content-type': 'application/octet-stream', 'content-length': '7',
      'x-storage-batch': JSON.stringify({ objects: [{ key: 'raw/a.bin', size_bytes: 3, content_hash: digest('abc') }, { key: 'raw/b.bin', size_bytes: 4, content_hash: digest('defh') }], content_hash: digest('abcdefg') }),
    },
  });
  await expect(batchCreate(request, client, provider)).rejects.toMatchObject({ reason: 'UPLOAD_HASH_MISMATCH', httpStatus: 400 });
  expect(calls).toEqual(['/2/files/upload_session/start_batch', '/2/files/upload_session/append_batch']);
  expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"cause_reason":"UPLOAD_HASH_MISMATCH"'));
});
