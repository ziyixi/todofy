import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dropbox } from '../src/dropbox.ts';
import { list, readContent, stat, writeContent } from '../src/objects.ts';
import type { ClientRow, Connection } from '../src/store.ts';
import { sqliteStore } from './sqlite.ts';

const client: ClientRow = { id: 'synthetic', label: 'Synthetic', namespace: 'quant', access: 2, token_sha256: 'a'.repeat(64), create_time: 0, revoked: 0 };
const object = { name: 'file.bin', path_display: '/namespaces/quant/file.bin', rev: 'abc123', size: 3, content_hash: 'b'.repeat(64) };
let provider: Dropbox;

beforeEach(() => {
  const connection: Connection = { appKey: 'syntheticappkey', refreshToken: 'synthetic-refresh', generation: 'synthetic' };
  provider = new Dropbox({ get: () => null, set: () => undefined, delete: () => undefined, connection: () => connection }, {});
});
afterEach(() => vi.unstubAllGlobals());

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => url.endsWith('/oauth2/token')
    ? Promise.resolve(Response.json({ access_token: 'synthetic-access', expires_in: 3600 })) : Promise.resolve(handler(url, init)));
}

describe('metadata and binary reads', () => {
  it('returns a bounded service page when the provider exceeds its approximate limit', async () => {
    fakeFetch(() => Response.json({ entries: Array.from({ length: 101 }, (_, index) => ({ '.tag': 'file', ...object, path_display: '/namespaces/quant/part-' + String(index) })), has_more: false, cursor: 'synthetic-provider-cursor' }));
    const cache = sqliteStore();
    try {
      const response = await list(new Request('https://storage.example.test/api/storage/v1/list', { method: 'POST', body: JSON.stringify({ page_size: 100 }) }), client, provider, 'a'.repeat(64), cache.store);
      const page = await response.json<{ objects: unknown[]; next_cursor: string }>();
      expect(page.objects).toHaveLength(100);
      expect(page.next_cursor).not.toBe('');
    } finally { cache.database.close(); }
  });

  it('returns the complete wire metadata including a zero byte size', async () => {
    fakeFetch(() => Response.json({ '.tag': 'file', ...object, size: 0 }));
    const response = await stat(new Request('https://storage.example.test/api/storage/v1/stat', { method: 'POST', body: JSON.stringify({ key: 'file.bin' }) }), client, provider);
    expect(await response.json()).toEqual({ key: 'file.bin', revision: 'abc123', size_bytes: 0, content_hash: 'b'.repeat(64) });
  });

  it('accepts native untagged download metadata, preserves 206 and checks the exact revision before forwarding bytes', async () => {
    fakeFetch((_url, init) => {
      expect(new Headers(init.headers).get('range')).toBe('bytes=1-2');
      return new Response('bc', { status: 206, headers: { 'dropbox-api-result': JSON.stringify(object), 'content-range': 'bytes 1-2/3', 'content-length': '2' } });
    });
    const response = await readContent(new Request('https://storage.example.test/api/storage/v1/content?key=file.bin', { headers: { range: 'bytes=1-2', 'if-match': '"abc123"' } }), client, provider);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-2/3');
    expect(response.headers.get('etag')).toBe('"abc123"');
    expect(await response.text()).toBe('bc');
  });

  it('cancels a different revision rather than returning a mismatched stat/read pair', async () => {
    let cancelled = false;
    fakeFetch(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'dropbox-api-result': JSON.stringify({ '.tag': 'file', ...object }) } }));
    await expect(readContent(new Request('https://storage.example.test/api/storage/v1/content?key=file.bin', { headers: { 'if-match': 'old123' } }), client, provider)).rejects.toMatchObject({ reason: 'REVISION_CONFLICT', httpStatus: 409 });
    expect(cancelled).toBe(true);
  });

  it('retains an upstream 200 when the provider did not honor a Range', async () => {
    fakeFetch(() => new Response('abc', { headers: { 'dropbox-api-result': JSON.stringify({ '.tag': 'file', ...object }) } }));
    const response = await readContent(new Request('https://storage.example.test/api/storage/v1/content?key=file.bin', { headers: { range: 'bytes=1-2' } }), client, provider);
    expect(response.status).toBe(200);
    expect(response.headers.has('content-range')).toBe(false);
  });

  it('keeps the provider 416 total length in the error response', async () => {
    fakeFetch(() => new Response(null, { status: 416, headers: { 'content-range': 'bytes */3' } }));
    await expect(readContent(new Request('https://storage.example.test/api/storage/v1/content?key=file.bin', { headers: { range: 'bytes=9-' } }), client, provider)).rejects.toMatchObject({ httpStatus: 416, headers: { 'content-range': 'bytes */3' } });
  });

  it('never forwards a provider answer for another object or namespace', async () => {
    for (const path of ['/namespaces/other/file.bin', '/namespaces/quant/other.bin']) {
      let cancelled = false;
      fakeFetch(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'dropbox-api-result': JSON.stringify({ ...object, path_display: path }) } }));
      await expect(readContent(new Request('https://storage.example.test/api/storage/v1/content?key=file.bin'), client, provider)).rejects.toMatchObject({ reason: 'PROVIDER_RESPONSE_INVALID' });
      expect(cancelled).toBe(true);
    }
  });
});

describe('streamed conditional writes', () => {
  it('rejects a read-only write, blind write or oversized length before provider access', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const request = (headers: Record<string, string>) => new Request('https://storage.example.test/api/storage/v1/content?key=file.bin', { method: 'PUT', headers, body: 'abc' });
    await expect(writeContent(request({ 'if-none-match': '*', 'content-length': '3' }), { ...client, access: 1 }, provider)).rejects.toMatchObject({ reason: 'READ_ONLY' });
    await expect(writeContent(request({ 'content-length': '3' }), client, provider)).rejects.toMatchObject({ reason: 'WRITE_PRECONDITION_REQUIRED' });
    await expect(writeContent(request({ 'if-none-match': '*', 'content-length': '33554433' }), client, provider)).rejects.toMatchObject({ reason: 'UPLOAD_TOO_LARGE' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('streams an update with strict provider CAS and accepts the native untagged upload metadata', async () => {
    vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> { constructor(length: number) { super(); expect(length).toBe(3); } });
    fakeFetch(async (_url, init) => {
      const argument = JSON.parse(new Headers(init.headers).get('dropbox-api-arg') ?? '{}') as Record<string, unknown>;
      expect(argument).toMatchObject({ path: '/namespaces/quant/file.bin', mode: { '.tag': 'update', update: 'abc123' }, strict_conflict: true, autorename: false });
      expect(await new Response(init.body).text()).toBe('abc');
      return Response.json({ ...object, rev: 'def456' });
    });
    const response = await writeContent(new Request('https://storage.example.test/api/storage/v1/content?key=file.bin', { method: 'PUT', headers: { 'if-match': '"abc123"', 'content-length': '3' }, body: 'abc' }), client, provider);
    expect(response.headers.get('etag')).toBe('"def456"');
    expect(await response.json()).toMatchObject({ revision: 'def456', size_bytes: 3 });
  });

  it('distinguishes namespace write contention from a real CAS conflict', async () => {
    vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> { constructor(length: number) { super(); expect(length).toBe(3); } });
    const request = () => new Request('https://storage.example.test/api/storage/v1/content?key=file.bin', { method: 'PUT', headers: { 'if-none-match': '*', 'content-length': '3' }, body: 'abc' });
    fakeFetch(() => Response.json({ error: { '.tag': 'path', path: { reason: { '.tag': 'too_many_write_operations' }, upload_session_id: 'synthetic-upload-session' } } }, { status: 409 }));
    await expect(writeContent(request(), client, provider)).rejects.toMatchObject({ code: 14, httpStatus: 429, headers: { 'retry-after': '1' } });
    fakeFetch(() => Response.json({ error_summary: 'path/too_many_write_operations/' }, { status: 409, headers: { 'retry-after': '0' } }));
    await expect(writeContent(request(), client, provider)).rejects.toMatchObject({ httpStatus: 429, headers: { 'retry-after': '0' } });
    fakeFetch(() => Response.json({ error: { '.tag': 'path', path: { reason: { '.tag': 'conflict' } } } }, { status: 409 }));
    await expect(writeContent(request(), client, provider)).rejects.toMatchObject({ reason: 'REVISION_CONFLICT', httpStatus: 409 });
  });

  it('rejects short and oversized actual streams rather than trusting Content-Length', async () => {
    vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> { constructor(length: number) { super(); expect(length).toBe(3); } });
    fakeFetch(async (_url, init) => {
      await new Response(init.body).arrayBuffer();
      return Response.json(object);
    });
    for (const body of ['ab', 'abcd']) {
      await expect(writeContent(new Request('https://storage.example.test/api/storage/v1/content?key=file.bin', { method: 'PUT', headers: { 'if-none-match': '*', 'content-length': '3' }, body }), client, provider)).rejects.toMatchObject({ reason: 'UPLOAD_LENGTH_MISMATCH' });
    }
  });
});
