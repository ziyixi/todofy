import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dropbox } from '../src/dropbox.ts';
import { list } from '../src/objects.ts';
import { encodeCursor, LIST_CURSOR_TTL_MS } from '../src/keys.ts';
import type { ClientRow } from '../src/store.ts';
import { sqliteStore } from './sqlite.ts';

const secret = 'a'.repeat(64);
const client: ClientRow = { id: 'synthetic', label: 'Synthetic', namespace: 'quant', access: 1, token_sha256: 'a'.repeat(64), create_time: 0, revoked: 0 };
interface ProviderPage { readonly entries: readonly Record<string, unknown>[]; readonly has_more: boolean; readonly cursor: string }
interface Listing { readonly objects: { readonly key: string; readonly revision: string }[]; readonly next_cursor: string }
let cache: ReturnType<typeof sqliteStore>;
let dropbox: Dropbox;
let pages: ProviderPage[];
let calls: { method: string; cursor?: string }[];

function file(index: number, prefix = 'parts/'): Record<string, unknown> {
  return { '.tag': 'file', path_display: '/namespaces/quant/' + prefix + String(index), rev: 'abc123', size: 1, content_hash: 'b'.repeat(64) };
}
function page(start: number, count: number, more = false, cursor = 'provider-' + String(start)): ProviderPage {
  return { entries: Array.from({ length: count }, (_, at) => file(start + at)), has_more: more, cursor };
}
async function read(cursor = '', pageSize = 100, prefix = 'parts/', namespace = 'quant'): Promise<Listing> {
  const response = await list(new Request('https://storage.example.test/api/storage/v1/list', {
    method: 'POST', body: JSON.stringify({ prefix, cursor, page_size: pageSize }),
  }), { ...client, namespace }, dropbox, secret, cache.store);
  return await response.json<Listing>();
}

beforeEach(() => {
  cache = sqliteStore();
  pages = [page(0, 101)];
  calls = [];
  dropbox = new Dropbox({ get: () => null, set: () => undefined, delete: () => undefined, connection: () => ({ appKey: 'synthetic', refreshToken: 'synthetic', generation: 'synthetic' }) }, {});
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
    const args = JSON.parse(init.body as string) as { cursor?: string };
    const continuation = url.endsWith('/continue');
    calls.push({ method: continuation ? 'continue' : 'start', ...args });
    const index = continuation ? pages.findIndex((value) => value.cursor === args.cursor) + 1 : 0;
    const answer = continuation && index === 0 ? undefined : pages[index];
    return answer === undefined ? Response.json({ error_summary: 'path/not_found/' }, { status: 409 }) : Response.json(answer);
  });
});
afterEach(() => { cache.database.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('bounded service pages over approximate provider pages', () => {
  it('keeps all 101 files even when the provider has no further page', async () => {
    const first = await read();
    expect(first.objects).toHaveLength(100);
    expect(first.next_cursor).not.toBe('');
    const tail = await read(first.next_cursor);
    expect(tail.objects.map((object) => object.key)).toEqual(['parts/100']);
    expect(tail.next_cursor).toBe('');
    expect(calls).toHaveLength(1);
  });

  it('filters many folders and other prefixes before applying the service page bound', async () => {
    pages = [{ ...page(0, 100), entries: [...page(0, 100).entries, ...Array.from({ length: 40 }, () => ({ '.tag': 'folder' })), file(101, 'other/')] }];
    const answer = await read();
    expect(answer.objects).toHaveLength(100);
    expect(answer.next_cursor).toBe('');
  });

  it('bounds each response to the requested size and supports size changes and replay', async () => {
    pages = [page(0, 180)];
    const first = await read('', 50);
    const small = await read(first.next_cursor, 7);
    expect(small.objects).toHaveLength(7);
    expect(await read(first.next_cursor, 7)).toEqual(small);
    const large = await read(first.next_cursor, 1000);
    expect(large.objects).toHaveLength(100);
    expect(large.objects[0]?.key).toBe('parts/50');
    const last = await read(large.next_cursor, 50);
    expect(last.objects).toHaveLength(30);
    expect(last.next_cursor).toBe('');
    expect(calls).toHaveLength(1);
  });

  it('keeps the extra item when a request for 50 receives 51', async () => {
    pages = [page(0, 51)];
    const first = await read('', 50);
    expect(first.objects).toHaveLength(50);
    expect((await read(first.next_cursor, 1)).objects.map((object) => object.key)).toEqual(['parts/50']);
  });

  it('advances only after the tail and caches provider transitions for stable replay', async () => {
    pages = [page(0, 101, true), page(101, 103, true), page(204, 0)];
    const first = await read();
    const tail = await read(first.next_cursor);
    expect(tail.objects).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const second = await read(tail.next_cursor);
    expect(second.objects).toHaveLength(100);
    expect(calls).toHaveLength(2);
    pages[1] = { ...page(101, 103, true), entries: page(999, 1).entries };
    expect(await read(tail.next_cursor)).toEqual(second);
    expect(calls).toHaveLength(2);
    const secondTail = await read(second.next_cursor);
    expect(secondTail.objects).toHaveLength(3);
    const last = await read(secondTail.next_cursor);
    expect(last).toEqual({ objects: [], next_cursor: '' });
    expect(new Set([...first.objects, ...tail.objects, ...second.objects, ...secondTail.objects].map((object) => object.key)).size).toBe(204);
  });

  it('returns empty filtered pages with continuation instead of inventing EOF', async () => {
    pages = [{ entries: [file(1, 'other/'), { '.tag': 'folder' }], has_more: true, cursor: 'empty' }, page(0, 1)];
    const first = await read();
    expect(first.objects).toEqual([]);
    expect(first.next_cursor).not.toBe('');
    expect((await read(first.next_cursor)).objects).toHaveLength(1);
  });

  it('accepts existing v1 provider cursors and emits bounded v2 continuations', async () => {
    pages = [page(0, 0, true, 'legacy'), page(0, 101)];
    const cursor = await encodeCursor(secret, { provider: 'legacy', namespace: 'quant', prefix: 'parts/', expires: Date.now() + LIST_CURSOR_TTL_MS });
    const first = await read(cursor);
    expect(first.objects).toHaveLength(100);
    expect(calls[0]).toMatchObject({ method: 'continue', cursor: 'legacy' });
    expect((await read(first.next_cursor)).objects).toHaveLength(1);
  });

  it('keeps provider cursors in the page cache rather than enlarging public cursor payloads', async () => {
    pages = [page(0, 1, true, 'x'.repeat(9000)), page(1, 1)];
    const first = await read();
    expect(first.next_cursor.length).toBeLessThan(1024);
    expect((await read(first.next_cursor)).objects[0]?.key).toBe('parts/1');
    expect(calls[1]?.cursor).toHaveLength(9000);
  });

  it('rejects another namespace, prefix, missing page or offset beyond the cached page', async () => {
    const first = await read();
    await expect(read(first.next_cursor, 100, 'other/')).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    await expect(read(first.next_cursor, 100, 'parts/', 'other')).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    const missing = await encodeCursor(secret, { page: crypto.randomUUID(), offset: 0, namespace: 'quant', prefix: 'parts/', expires: Date.now() + 60000 });
    await expect(read(missing)).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    const stored = cache.database.prepare('SELECT id FROM list_pages').get() as { id: string };
    const invalidOffset = await encodeCursor(secret, { page: stored.id, offset: 102, namespace: 'quant', prefix: 'parts/', expires: (cache.store.listPage(stored.id, Date.now()))?.expires ?? 0 });
    await expect(read(invalidOffset)).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    expect(calls).toHaveLength(1);
  });

  it('does not treat a failed provider continuation as successful completion', async () => {
    pages = [page(0, 1, true)];
    const first = await read();
    await expect(read(first.next_cursor)).rejects.toMatchObject({ code: 5 });
  });

  it('rejects expired cursors and invalid provider metadata without returning partial data', async () => {
    const first = await read();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + LIST_CURSOR_TTL_MS + 1);
    await expect(read(first.next_cursor)).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    vi.restoreAllMocks();
    pages = [{ ...page(0, 101), entries: [...page(0, 100).entries, { ...file(100), path_display: '/namespaces/other/file' }] }];
    await expect(read()).rejects.toMatchObject({ reason: 'PROVIDER_RESPONSE_INVALID' });
  });

  it('does not repopulate a previous connection cache from a list response already in flight', async () => {
    const started = Promise.withResolvers<undefined>();
    const answer = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', (url: string) => {
      if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
      started.resolve(undefined);
      return answer.promise;
    });
    const pending = read();
    await started.promise;
    cache.store.set('connection', { appKey: 'synthetic', refreshToken: 'synthetic', generation: 'replacement' });
    answer.resolve(Response.json(page(0, 101)));
    await expect(pending).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    expect(cache.database.prepare('SELECT COUNT(*) AS count FROM list_pages').get()).toEqual({ count: 0 });
  });
});
