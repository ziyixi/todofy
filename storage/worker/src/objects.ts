import { create, type DescMessage, type MessageShape } from '@ziyixi/proto/protobuf';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { ObjectMetadataSchema, ListObjectsResponseSchema, ListObjectsRequestSchema, StatObjectRequestSchema, type ObjectMetadata } from '@ziyixi/proto/storage/objects/v1/objects_pb';
import { Client_Access } from '@ziyixi/proto/storage/ui/v1/client_pb';
import { formatMatches, fromWire, toWire } from '@ziyixi/proto/wire-json';
import type { Dropbox } from './dropbox.ts';
import { MAX_OBJECT_BYTES, MAX_PAGE_SIZE } from './env.ts';
import { badRequest, failure, readJson } from './errors.ts';
import { decodeCursor, encodeCursor, matchedRevision, objectKey, providerPath, providerRoot, writeMode } from './keys.ts';
import type { ClientRow } from './store.ts';

function metadata(value: Record<string, unknown>, clientNamespace: string, expectedKey?: string): ObjectMetadata {
  const path = value.path_display;
  const root = providerRoot(clientNamespace) + '/';
  if ((value['.tag'] !== undefined && value['.tag'] !== 'file') || typeof path !== 'string' || !path.toLowerCase().startsWith(root)
    || typeof value.rev !== 'string' || !formatMatches(ObjectMetadataSchema.file, 'Revision', value.rev)
    || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_OBJECT_BYTES
    || typeof value.content_hash !== 'string' || !formatMatches(ObjectMetadataSchema.file, 'ContentHash', value.content_hash)) {
    throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
  }
  const key = objectKey(path.slice(root.length));
  if (expectedKey !== undefined && key.toLowerCase() !== expectedKey.toLowerCase()) throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
  return create(ObjectMetadataSchema, { key, revision: value.rev, sizeBytes: value.size, contentHash: value.content_hash });
}

function json<D extends DescMessage>(schema: D, value: MessageShape<D>): Response {
  return Response.json(toWire(schema, value), { headers: { 'cache-control': 'no-store' } });
}

export async function stat(request: Request, client: ClientRow, dropbox: Dropbox): Promise<Response> {
  const input = fromWire(StatObjectRequestSchema, await readJson(request) as never, { strict: true }).message;
  const result = metadata(await dropbox.json('files/get_metadata', { path: providerPath(client.namespace, input.key), include_deleted: false }), client.namespace, input.key);
  return json(ObjectMetadataSchema, result);
}

export async function list(request: Request, client: ClientRow, dropbox: Dropbox, secret: string): Promise<Response> {
  const input = fromWire(ListObjectsRequestSchema, await readJson(request) as never, { strict: true }).message;
  const prefix = objectKey(input.prefix, true);
  const pageSize = Math.min(input.pageSize || MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  let answer: Record<string, unknown>;
  try {
    answer = input.cursor !== ''
      ? await dropbox.json('files/list_folder/continue', { cursor: await decodeCursor(secret, input.cursor, client.namespace, prefix) })
      : await dropbox.json('files/list_folder', {
        path: providerRoot(client.namespace) + (prefix.includes('/') ? '/' + prefix.slice(0, prefix.lastIndexOf('/')) : ''),
        recursive: true, include_deleted: false, include_non_downloadable_files: false, limit: pageSize,
      });
  } catch (error) {
    if (error instanceof RpcError && error.code === Code.NOT_FOUND) return json(ListObjectsResponseSchema, create(ListObjectsResponseSchema, { objects: [], nextCursor: '' }));
    throw error;
  }
  if (!Array.isArray(answer.entries) || answer.entries.length > MAX_PAGE_SIZE || typeof answer.has_more !== 'boolean'
    || typeof answer.cursor !== 'string' || answer.cursor.length > 4096) throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
  const objects: ObjectMetadata[] = [];
  for (const entry of answer.entries as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
    const item = entry as Record<string, unknown>;
    if (item['.tag'] === 'folder') continue;
    const object = metadata(item, client.namespace);
    if (object.key.startsWith(prefix)) objects.push(object);
  }
  const nextCursor = answer.has_more ? await encodeCursor(secret, {
    provider: answer.cursor, namespace: client.namespace, prefix, expires: Date.now() + 24 * 60 * 60_000,
  }) : '';
  return json(ListObjectsResponseSchema, create(ListObjectsResponseSchema, { objects, nextCursor }));
}

function contentKey(request: Request): string {
  const query = new URL(request.url).searchParams;
  if (query.size !== 1 || !query.has('key')) badRequest();
  return objectKey(query.get('key') ?? '');
}

export async function readContent(request: Request, client: ClientRow, dropbox: Dropbox): Promise<Response> {
  const key = contentKey(request);
  const path = providerPath(client.namespace, key);
  const expected = matchedRevision(request);
  const range = request.headers.get('range');
  if (range !== null && (range.length > 128 || !/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(range))) badRequest();
  const result = await dropbox.download(path, range);
  const response = result.response;
  if (response.status === 416) {
    await response.body?.cancel();
    const contentRange = response.headers.get('content-range');
    throw new RpcError(Code.OUT_OF_RANGE, 'RANGE_NOT_SATISFIABLE', 'The requested range is unavailable.', {
      httpStatus: 416, headers: contentRange !== null && /^bytes \*\/[0-9]+$/.test(contentRange) ? { 'content-range': contentRange } : {},
    });
  }
  try {
    const object = metadata(result.metadata, client.namespace, key);
    if (expected !== null && expected !== object.revision) throw failure(Code.ABORTED, 'REVISION_CONFLICT');
    const headers = new Headers({
      'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes',
      etag: '"' + object.revision + '"', 'x-storage-content-hash': object.contentHash,
    });
    if (response.status === 206) {
      const contentRange = response.headers.get('content-range');
      if (contentRange === null || !/^bytes [0-9]+-[0-9]+\/[0-9]+$/.test(contentRange)) throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
      headers.set('content-range', contentRange);
    } else if (response.status !== 200) throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
    const length = response.headers.get('content-length');
    if (length !== null && /^[0-9]+$/.test(length)) headers.set('content-length', length);
    if (request.method === 'HEAD') await response.body?.cancel();
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
}

export async function writeContent(request: Request, client: ClientRow, dropbox: Dropbox): Promise<Response> {
  if (client.access !== Client_Access.READ_WRITE) throw failure(Code.PERMISSION_DENIED, 'READ_ONLY');
  const key = contentKey(request);
  const path = providerPath(client.namespace, key);
  const mode = writeMode(request);
  const rawLength = request.headers.get('content-length');
  if (rawLength === null) throw failure(Code.FAILED_PRECONDITION, 'UPLOAD_LENGTH_MISMATCH', 411);
  if (!/^(0|[1-9][0-9]{0,9})$/.test(rawLength)) badRequest();
  const length = Number(rawLength);
  if (length > MAX_OBJECT_BYTES) throw failure(Code.RESOURCE_EXHAUSTED, 'UPLOAD_TOO_LARGE', 413);
  const expectedHash = request.headers.get('x-storage-content-hash');
  if (expectedHash !== null && !formatMatches(ObjectMetadataSchema.file, 'ContentHash', expectedHash)) badRequest();
  if (request.body === null && length !== 0) throw failure(Code.INVALID_ARGUMENT, 'UPLOAD_LENGTH_MISMATCH');
  const stream = new FixedLengthStream(length);
  let received = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > length || received > MAX_OBJECT_BYTES) throw failure(Code.INVALID_ARGUMENT, 'UPLOAD_LENGTH_MISMATCH');
      controller.enqueue(chunk);
    },
    flush() {
      if (received !== length) throw failure(Code.INVALID_ARGUMENT, 'UPLOAD_LENGTH_MISMATCH');
    },
  });
  const body = request.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  const pumpingController = new AbortController();
  const pumping = body.pipeThrough(limiter).pipeTo(stream.writable, { signal: pumpingController.signal });
  // Attach a handler immediately; a provider rejection may happen before it reads the stream.
  void pumping.catch(() => undefined);
  try {
    const result = await dropbox.upload({
      path, mode, strict_conflict: true, autorename: false, mute: true,
      ...(expectedHash === null ? {} : { content_hash: expectedHash }),
    }, stream.readable);
    await pumping;
    const object = metadata(result, client.namespace, key);
    if (object.sizeBytes !== length || (expectedHash !== null && object.contentHash !== expectedHash)) throw failure(Code.DATA_LOSS, 'PROVIDER_RESPONSE_INVALID');
    const response = json(ObjectMetadataSchema, object);
    response.headers.set('etag', '"' + object.revision + '"');
    return response;
  } catch (error) {
    pumpingController.abort();
    await stream.readable.cancel().catch(() => undefined);
    try { await pumping; } catch (streamError) {
      if (streamError instanceof RpcError && streamError.reason === 'UPLOAD_LENGTH_MISMATCH') throw streamError;
    }
    throw error;
  }
}
