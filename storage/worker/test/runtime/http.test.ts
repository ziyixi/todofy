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
});
