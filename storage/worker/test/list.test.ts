import { DatabaseSync } from 'node:sqlite';
import { importHmacKeyHex, signClaims } from '@ziyixi/edge-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dropbox } from '../src/dropbox.ts';
import { list } from '../src/objects.ts';
import { encodeCursor, LIST_CURSOR_TTL_MS } from '../src/keys.ts';
import type { ClientRow } from '../src/store.ts';
import { sqliteStore } from './sqlite.ts';

const secret = 'a'.repeat(64);
const client: ClientRow = { id: 'synthetic', label: 'Synthetic', namespace: 'synthetic', access: 1, token_sha256: 'a'.repeat(64), create_time: 0, revoked: 0 };
interface ProviderPage { readonly entries: readonly Record<string, unknown>[]; readonly has_more: boolean; readonly cursor: string }
interface Listing { readonly objects: { readonly key: string; readonly revision: string }[]; readonly next_cursor: string }
let dropbox: Dropbox;
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
  }), { ...client, namespace }, dropbox, secret);
  return await response.json<Listing>();
}

beforeEach(() => {
  pages = [page(0, 100)];
  calls = [];
  dropbox = new Dropbox({ get: () => null, set: () => undefined, delete: () => undefined, connection: () => ({ appKey: 'synthetic', refreshToken: 'synthetic', generation: 'synthetic' }) }, {});
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('uncached provider pages', () => {
  it('returns one provider page per request with an authenticated provider continuation', async () => {
    pages = [page(0, 100, true, 'next'), page(100, 1)];
    const first = await read();
    expect(first.objects).toHaveLength(100);
    expect(first.next_cursor).not.toBe('');
    const tail = await read(first.next_cursor);
    expect(tail.objects.map((object) => object.key)).toEqual(['parts/100']);
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
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: 'clients' }, { name: 'metadata' }]);
    database.close();
  });
});
