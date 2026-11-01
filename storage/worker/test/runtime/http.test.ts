import { afterEach, describe, expect, it } from 'vitest';
import { HASH, harness } from './harness.ts';

let current: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

describe('Storage in workerd with native SQLite', () => {
  it('authenticates before parsing bodies and accepts only separate namespace application keys', async () => {
    current = await harness();
    const unauthorized = await current.machine('stat', null, { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } });
    expect(unauthorized.status).toBe(401);
    expect(current.provider.calls).toHaveLength(0);
    const key = await current.client('quant');
    await current.owner(key.name, 'DELETE');
    const revoked = await current.machine('stat', key.api_key, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(revoked.status).toBe(401);
    const listing = await current.owner('clients');
    expect(JSON.stringify(await listing.json())).not.toContain(key.api_key);
  });

  it('reveals a created credential only once and refuses request ID reuse for another namespace', async () => {
    current = await harness();
    const requestId = crypto.randomUUID();
    const input = { label: 'Synthetic', namespace: 'quant', access: 'read_only' };
    const created = await current.owner('clients?request_id=' + requestId, 'POST', input);
    const first = await created.json<{ api_key: string; name: string }>();
    expect(first.api_key).toMatch(/^sto_[A-Za-z0-9_-]{43}$/);
    const replayed = await current.owner('clients?request_id=' + requestId, 'POST', input);
    const second = await replayed.json<{ api_key?: string; name: string }>();
    expect(second.name).toBe(first.name);
    expect(second.api_key).toBeUndefined();
    expect((await current.owner('clients?request_id=' + requestId, 'POST', { ...input, namespace: 'other' })).status).toBe(400);
  });

  it('persists strict conditional files and enforces namespace, readonly, revision and Range boundaries', async () => {
    current = await harness();
    await current.connect();
    const active = current;
    const write = await current.client('quant');
    const read = await current.client('quant', 'read_only');
    const other = await current.client('other');
    const bytes = new TextEncoder().encode('synthetic-object');
    const put = (token: string, headers: Record<string, string>) => active.machine('content?key=datasets/part.bin', token, {
      method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.byteLength), 'x-storage-content-hash': HASH(bytes), ...headers },
    });
    const first = await put(write.api_key, { 'if-none-match': '*' });
    expect(first.status).toBe(200);
    const metadata = await first.json<{ revision: string; content_hash: string; size_bytes: number }>();
    expect(metadata.size_bytes).toBe(bytes.byteLength);
    expect(metadata.content_hash).toBe(HASH(bytes));
    const head = await current.machine('content?key=datasets/part.bin', read.api_key, { method: 'HEAD', headers: { 'if-match': metadata.revision } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(head.headers.get('x-storage-content-hash')).toBe(HASH(bytes));
    expect(await head.text()).toBe('');
    expect((await put(write.api_key, { 'if-none-match': '*' })).status).toBe(409);
    expect((await put(write.api_key, { 'if-match': 'stale123' })).status).toBe(409);
    expect((await put(read.api_key, { 'if-match': metadata.revision })).status).toBe(403);
    expect((await current.machine('content?key=datasets/part.bin', other.api_key)).status).toBe(404);
    const partial = await current.machine('content?key=datasets/part.bin', read.api_key, { headers: { range: 'bytes=1-3', 'if-match': '"' + metadata.revision + '"' } });
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe('ynt');
    expect(partial.headers.get('content-range')).toBe('bytes 1-3/' + String(bytes.byteLength));
    const unsatisfied = await current.machine('content?key=datasets/part.bin', read.api_key, { headers: { range: 'bytes=9999-' } });
    expect(unsatisfied.status).toBe(416);
    expect(unsatisfied.headers.get('content-range')).toBe('bytes */' + String(bytes.byteLength));
    const listing = await current.machine('list', write.api_key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix: 'datasets/' }) });
    expect(await listing.json()).toMatchObject({ objects: [{ key: 'datasets/part.bin', revision: metadata.revision }], next_cursor: '' });
    expect(current.provider.refreshes).toBe(1);
    const disconnected = await current.owner('dropbox:disconnect', 'POST', {});
    expect(disconnected.status).toBe(200);
    expect(current.provider.files.size).toBe(1);
  });

  it('streams a multi-block 8 MiB object and zero-byte object through native FixedLengthStream', async () => {
    current = await harness();
    await current.connect();
    const key = await current.client('quant');
    const bytes = new Uint8Array(8 * 1024 * 1024);
    bytes.fill(97, 0, 4 * 1024 * 1024);
    bytes.fill(98, 4 * 1024 * 1024);
    for (const [name, content] of [['multi.bin', bytes], ['empty.bin', new Uint8Array()]] as const) {
      const response = await current.machine('content?key=' + name, key.api_key, {
        method: 'PUT', body: content, headers: { 'if-none-match': '*', 'content-length': String(content.byteLength), 'x-storage-content-hash': HASH(content) },
      });
      expect(response.status).toBe(200);
      const metadata = await response.json<{ revision: string; size_bytes: number; content_hash: string }>();
      expect(metadata.size_bytes).toBe(content.byteLength);
      expect(metadata.content_hash).toBe(HASH(content));
      const read = await current.machine('content?key=' + name, key.api_key, { headers: { 'if-match': metadata.revision } });
      expect(read.status).toBe(200);
      expect(HASH(new Uint8Array(await read.arrayBuffer()))).toBe(HASH(content));
    }
  });

  it('persists provider tails and replayable page transitions across fresh SQLite DO instances', async () => {
    current = await harness();
    await current.connect();
    const active = current;
    const key = await current.client('quant', 'read_only');
    const other = await current.client('other');
    const file = (index: number) => ({ '.tag': 'file', path_display: '/namespaces/quant/parts/' + String(index), rev: 'abc123', size: 1, content_hash: 'b'.repeat(64) });
    current.provider.listPages = [
      { entries: [...Array.from({ length: 151 }, (_, index) => file(index)), { '.tag': 'folder' }], has_more: true, cursor: 'next-provider' },
      { entries: Array.from({ length: 51 }, (_, index) => file(151 + index)), has_more: false, cursor: 'done-provider' },
    ];
    const read = async (cursor = '', pageSize = 100, prefix = 'parts/', token = key.api_key) => {
      const response = await active.machine('list', token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix, page_size: pageSize, cursor }) });
      expect(response.status).toBe(200);
      return await response.json<{ objects: { key: string }[]; next_cursor: string }>();
    };
    const first = await read();
    expect(first.objects).toHaveLength(100);
    expect(first.next_cursor.length).toBeLessThan(1024);
    await current.restart();
    expect((await read(first.next_cursor, 10)).objects).toHaveLength(10);
    const tail = await read(first.next_cursor);
    expect(tail.objects).toHaveLength(51);
    expect(current.provider.calls).toHaveLength(1);
    const second = await read(tail.next_cursor, 50);
    expect(second.objects).toHaveLength(50);
    expect(current.provider.calls).toHaveLength(2);
    await current.restart();
    expect(await read(tail.next_cursor, 50)).toEqual(second);
    expect(current.provider.calls).toHaveLength(2);
    const last = await read(second.next_cursor);
    expect(last.objects).toHaveLength(1);
    expect(last.next_cursor).toBe('');
    expect(new Set([...first.objects, ...tail.objects, ...second.objects, ...last.objects].map((object) => object.key)).size).toBe(202);
    for (const [prefix, token] of [['other/', key.api_key], ['parts/', other.api_key]]) {
      const invalid = await active.machine('list', token ?? '', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix, cursor: first.next_cursor }) });
      expect(invalid.status).toBe(400);
    }
    await current.owner('dropbox:disconnect', 'POST', {});
    const disconnected = await current.machine('list', key.api_key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix: 'parts/', cursor: first.next_cursor }) });
    expect(disconnected.status).toBe(400);
  });

  it('continues an empty filtered provider page and bounds 51 files to a request for 50', async () => {
    current = await harness();
    await current.connect();
    const key = await current.client('quant', 'read_only');
    current.provider.listPages = [
      { entries: [{ '.tag': 'folder' }], has_more: true, cursor: 'empty-page' },
      { entries: Array.from({ length: 51 }, (_, index) => ({ '.tag': 'file', path_display: '/namespaces/quant/parts/' + String(index), rev: 'abc123', size: 0, content_hash: 'b'.repeat(64) })), has_more: false, cursor: 'end' },
    ];
    let cursor = '';
    const counts = [];
    do {
      const response = await current.machine('list', key.api_key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix: 'parts/', cursor, page_size: 50 }) });
      expect(response.status).toBe(200);
      const page = await response.json<{ objects: unknown[]; next_cursor: string }>();
      counts.push(page.objects.length);
      cursor = page.next_cursor;
    } while (cursor !== '' && counts.length < 5);
    expect(counts).toEqual([0, 50, 1]);
    expect(cursor).toBe('');
  });
});
