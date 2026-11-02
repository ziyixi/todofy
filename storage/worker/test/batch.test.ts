import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { batchCreate } from '../src/batch.ts';
import { Dropbox } from '../src/dropbox.ts';
import type { ClientRow, Connection } from '../src/store.ts';

const client: ClientRow = { id: 'synthetic', label: 'Synthetic', namespace: 'quant', access: 2, token_sha256: 'a'.repeat(64), create_time: 0, revoked: 0 };
const connection: Connection = { appKey: 'synthetic', refreshToken: 'synthetic-private-refresh', generation: 'synthetic' };
const hash = createHash('sha256').update(createHash('sha256').update('abc').digest()).digest('hex');

afterEach(() => vi.unstubAllGlobals());

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
