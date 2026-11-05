import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL as NodeURL } from 'node:url';
import { importHmacKeyHex, signClaims } from '@ziyixi/edge-auth';
import { BatchCreateManifestSchema, BatchCreateResponseSchema, ListObjectsResponseSchema, ObjectMetadataSchema } from '@ziyixi/proto/storage/objects/v1/objects_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dropbox } from '../src/dropbox.ts';
import { encodeCursor, LIST_CURSOR_TTL_MS } from '../src/keys.ts';
import { list, readContent, stat, writeContent } from '../src/objects.ts';
import { seedNamespaceAndKey, setupConnected, sqliteStore } from './sqlite.ts';

const secret = 'a'.repeat(64);
const client = seedNamespaceAndKey();
const object = { name: 'file.bin', path_display: '/namespaces/synthetic/file.bin', rev: 'abc123', size: 3, content_hash: 'b'.repeat(64) };
let provider: Dropbox;

beforeEach(() => {
  provider = setupConnected().provider;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => url.endsWith('/oauth2/token')
    ? Promise.resolve(Response.json({ access_token: 'synthetic-access', expires_in: 3600 })) : Promise.resolve(handler(url, init)));
}

describe('metadata and binary reads', () => {
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
    for (const path of ['/namespaces/other/file.bin', '/namespaces/synthetic/other.bin']) {
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
      expect(argument).toMatchObject({ path: '/namespaces/synthetic/file.bin', mode: { '.tag': 'update', update: 'abc123' }, strict_conflict: true, autorename: false });
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

  it('reports a full Dropbox as a distinct non-retryable error rather than unavailable', async () => {
    vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> { constructor(length: number) { super(); expect(length).toBe(3); } });
    const request = () => new Request('https://storage.example.test/api/storage/v1/content?key=file.bin', { method: 'PUT', headers: { 'if-none-match': '*', 'content-length': '3' }, body: 'abc' });
    fakeFetch(() => Response.json({ error_summary: 'path/insufficient_space/..', error: { '.tag': 'path', path: { reason: { '.tag': 'insufficient_space' }, upload_session_id: 'synthetic-upload-session' } } }, { status: 409 }));
    await expect(writeContent(request(), client, provider)).rejects.toMatchObject({ code: 8, reason: 'INSUFFICIENT_SPACE', httpStatus: 507, headers: {} });
    fakeFetch(() => Response.json({ error_summary: 'path/insufficient_space/' }, { status: 409 }));
    await expect(writeContent(request(), client, provider)).rejects.toMatchObject({ reason: 'INSUFFICIENT_SPACE', httpStatus: 507 });
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

describe('uncached provider pages', () => {
  interface ProviderPage { readonly entries: readonly Record<string, unknown>[]; readonly has_more: boolean; readonly cursor: string }
  interface Listing { readonly objects: { readonly key: string; readonly revision: string }[]; readonly next_cursor: string }
  const reader = seedNamespaceAndKey({ access: 1 });
  let pages: ProviderPage[];
  let calls: { method: string; cursor?: string; limit?: number }[];

  function file(index: number, prefix = 'parts/'): Record<string, unknown> {
    return { '.tag': 'file', path_display: '/namespaces/synthetic/' + prefix + String(index), rev: 'abc123', size: 1, content_hash: 'b'.repeat(64) };
  }
  function page(start: number, count: number, more = false, cursor = 'provider-' + String(start)): ProviderPage {
    return { entries: Array.from({ length: count }, (_, at) => file(start + at)), has_more: more, cursor };
  }
  async function read(cursor = '', pageSize = 100, prefix = 'parts/', namespace = 'synthetic'): Promise<Listing> {
    const response = await list(new Request('https://storage.example.test/api/storage/v1/list', {
      method: 'POST', body: JSON.stringify({ prefix, cursor, page_size: pageSize }),
    }), { ...reader, namespace }, provider, secret);
    return await response.json<Listing>();
  }

  beforeEach(() => {
    pages = [page(0, 100)];
    calls = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
      const args = JSON.parse(init.body as string) as { cursor?: string; limit?: number };
      const continuation = url.endsWith('/continue');
      calls.push({ method: continuation ? 'continue' : 'start', ...args });
      const index = continuation ? pages.findIndex((value) => value.cursor === args.cursor) + 1 : 0;
      const answer = continuation && index === 0 ? undefined : pages[index];
      return answer === undefined ? Response.json({ error_summary: 'path/not_found/' }, { status: 409 }) : Response.json(answer);
    });
  });

  it('returns one provider page per request with an authenticated provider continuation', async () => {
    pages = [page(0, 100, true, 'next'), page(100, 1)];
    const first = await read();
    expect(first.objects).toHaveLength(100);
    expect(first.next_cursor).not.toBe('');
    const tail = await read(first.next_cursor);
    expect(tail.objects.map((entry) => entry.key)).toEqual(['parts/100']);
    expect(tail.next_cursor).toBe('');
    expect(calls).toEqual([{ method: 'start', path: '/namespaces/synthetic/parts', recursive: true, include_deleted: false, include_non_downloadable_files: false, limit: 100 }, { method: 'continue', cursor: 'next' }]);
  });

  it('filters many folders and other prefixes before applying the requested page bound', async () => {
    pages = [{ ...page(0, 100), entries: [...page(0, 100).entries, ...Array.from({ length: 40 }, () => ({ '.tag': 'folder' })), file(101, 'other/')] }];
    const answer = await read();
    expect(answer.objects).toHaveLength(100);
    expect(answer.next_cursor).toBe('');
  });

  it('fails a provider page above the requested size instead of truncating it', async () => {
    pages = [page(0, 101)];
    await expect(read()).rejects.toMatchObject({ reason: 'PROVIDER_RESPONSE_INVALID' });
    pages = [page(0, 51, true)];
    await expect(read('', 50)).rejects.toMatchObject({ reason: 'PROVIDER_RESPONSE_INVALID' });
    expect(calls.map((call) => call.limit)).toEqual([100, 50]);
  });

  it('returns empty filtered pages with continuation instead of inventing EOF', async () => {
    pages = [{ entries: [file(1, 'other/'), { '.tag': 'folder' }], has_more: true, cursor: 'empty' }, page(0, 1)];
    const first = await read();
    expect(first.objects).toEqual([]);
    expect(first.next_cursor).not.toBe('');
    expect((await read(first.next_cursor)).objects).toHaveLength(1);
  });

  it('accepts existing provider cursors and refuses retired cached-page cursors', async () => {
    pages = [page(0, 0, true, 'legacy'), page(0, 100)];
    const cursor = await encodeCursor(secret, { provider: 'legacy', namespace: 'synthetic', prefix: 'parts/', expires: Date.now() + LIST_CURSOR_TTL_MS });
    expect((await read(cursor)).objects).toHaveLength(100);
    expect(calls).toEqual([{ method: 'continue', cursor: 'legacy' }]);
    const key = await importHmacKeyHex(secret);
    if (key === null) throw new Error('synthetic cursor key');
    const retired = await signClaims(key, { page: crypto.randomUUID(), offset: 0, namespace: 'synthetic', prefix: 'parts/', expires: Date.now() + 60000, version: 2 });
    await expect(read(retired)).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    expect(calls).toHaveLength(1);
  });

  it('rejects another namespace, prefix or an expired cursor before the provider', async () => {
    pages = [page(0, 1, true)];
    const first = await read();
    await expect(read(first.next_cursor, 100, 'other/')).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    await expect(read(first.next_cursor, 100, 'parts/', 'other')).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + LIST_CURSOR_TTL_MS + 1);
    await expect(read(first.next_cursor)).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    expect(calls).toHaveLength(1);
  });

  it('refuses a provider cursor that a continuation could not carry', async () => {
    pages = [page(0, 1, true, 'x'.repeat(4097))];
    await expect(read()).rejects.toMatchObject({ reason: 'PROVIDER_RESPONSE_INVALID' });
  });

  it('does not treat a failed provider continuation as successful completion', async () => {
    pages = [page(0, 1, true)];
    const first = await read();
    await expect(read(first.next_cursor)).rejects.toMatchObject({ code: 5 });
  });

  it('rejects invalid provider metadata without returning partial data', async () => {
    pages = [{ ...page(0, 100), entries: [...page(0, 99).entries, { ...file(99), path_display: '/namespaces/other/file' }] }];
    await expect(read()).rejects.toMatchObject({ reason: 'PROVIDER_RESPONSE_INVALID' });
  });
});

describe('retired page cache', () => {
  it('drops the durable page table and its index when the object starts', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE list_pages (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, value TEXT NOT NULL, size_bytes INTEGER NOT NULL, next_page TEXT)');
    database.exec('CREATE INDEX list_pages_expiry ON list_pages(expires)');
    database.prepare('INSERT INTO list_pages(id,expires,value,size_bytes) VALUES (?,?,?,?)').run('synthetic', 1, '{}', 2);
    sqliteStore(database);
    sqliteStore(database);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'list_pages%'").all()).toEqual([]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: 'clients' }, { name: 'metadata' }, { name: 'recent_failures' }, { name: 'usage_daily' }]);
    database.close();
  });
});

describe('public wire bytes', () => {
  it('roundtrips the fixed four-field metadata and an empty listing without losing zeros', () => {
    const fixture = '{"key":"datasets/part.bin","revision":"abc123","size_bytes":0,"content_hash":"' + 'b'.repeat(64) + '"}';
    const parsed = fromWire(ObjectMetadataSchema, JSON.parse(fixture) as never, { strict: true }).message;
    expect(JSON.stringify(toWire(ObjectMetadataSchema, parsed))).toBe(fixture);
    const listing = fromWire(ListObjectsResponseSchema, { objects: [], next_cursor: '' }, { strict: true }).message;
    expect(JSON.stringify(toWire(ListObjectsResponseSchema, listing))).toBe('{"objects":[],"next_cursor":""}');
  });

  it('rejects invalid provider metadata under both strict and lenient reads', () => {
    const valid = { key: 'datasets/part.bin', revision: 'abc123', size_bytes: 3, content_hash: 'b'.repeat(64) };
    for (const invalid of [{ ...valid, size_bytes: 33554433 }, { ...valid, content_hash: 'plain-sha-not-a-dropbox-hash' }, { ...valid, key: 'id:outside' }, { ...valid, revision: '*' }]) {
      for (const strict of [true, false]) expect(() => fromWire(ObjectMetadataSchema, invalid, { strict })).toThrow();
    }
  });

  it('roundtrips bounded batch manifests and confirmations without binary JSON fields', () => {
    const manifestBytes = readFileSync(new NodeURL('../../../contracts/storage-objects-v1/fixtures/manifest.json', import.meta.url), 'utf8');
    const responseBytes = readFileSync(new NodeURL('../../../contracts/storage-objects-v1/fixtures/response.json', import.meta.url), 'utf8');
    expect(JSON.stringify(toWire(BatchCreateManifestSchema, fromWire(BatchCreateManifestSchema, JSON.parse(manifestBytes) as never, { strict: true }).message))).toBe(manifestBytes);
    expect(JSON.stringify(toWire(BatchCreateResponseSchema, fromWire(BatchCreateResponseSchema, JSON.parse(responseBytes) as never, { strict: true }).message))).toBe(responseBytes);
    const item = { key: 'raw/synthetic.json.gz', size_bytes: 3, content_hash: 'b'.repeat(64) };
    const manifest = { objects: [item], content_hash: 'c'.repeat(64) };
    const decoded = fromWire(BatchCreateManifestSchema, manifest, { strict: true }).message;
    expect(toWire(BatchCreateManifestSchema, decoded)).toEqual(manifest);
    const response = { objects: [{ key: item.key, revision: 'abc123', size_bytes: 3, content_hash: item.content_hash }] };
    expect(toWire(BatchCreateResponseSchema, fromWire(BatchCreateResponseSchema, response, { strict: true }).message)).toEqual(response);
    expect(() => fromWire(BatchCreateManifestSchema, { ...manifest, objects: Array.from({ length: 32 }, () => item) }, { strict: true })).not.toThrow();
    for (const invalid of [
      { ...manifest, unknown: 'refused' },
      { ...manifest, objects: [{ ...item, bytes: 'not-a-payload-field' }] },
      { ...manifest, objects: [{ ...item, size_bytes: 0 }] },
      { ...manifest, objects: [{ ...item, size_bytes: 33554433 }] },
      { ...manifest, objects: Array.from({ length: 33 }, () => item) },
    ]) expect(() => fromWire(BatchCreateManifestSchema, invalid, { strict: true })).toThrow();
    expect(() => fromWire(BatchCreateResponseSchema, { objects: Array.from({ length: 33 }, () => response.objects[0]) }, { strict: true })).toThrow();
  });
});

