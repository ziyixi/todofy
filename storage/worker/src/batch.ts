import { create } from '@ziyixi/proto/protobuf';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { BatchCreateManifestSchema, BatchCreateResponseSchema, type ObjectMetadata } from '@ziyixi/proto/storage/objects/v1/objects_pb';
import { Client_Access } from '@ziyixi/proto/storage/ui/v1/client_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import type { Dropbox } from './dropbox.ts';
import { MAX_OBJECT_BYTES } from './env.ts';
import { badRequest, failure } from './errors.ts';
import { objectKey, providerPath } from './keys.ts';
import { objectMetadata } from './objects.ts';
import type { ClientRow } from './store.ts';

function incomplete(): RpcError { return failure(Code.UNAVAILABLE, 'BATCH_INCOMPLETE'); }

function records(value: unknown, length: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))) throw incomplete();
  return value as Record<string, unknown>[];
}

function conflict(entry: Record<string, unknown>): boolean {
  const error = entry.failure;
  if (entry['.tag'] !== 'failure' || typeof error !== 'object' || error === null || Array.isArray(error)) return false;
  const reason = error as Record<string, unknown>;
  const path = reason.path;
  return reason['.tag'] === 'path' && typeof path === 'object' && path !== null && !Array.isArray(path)
    && (path as Record<string, unknown>)['.tag'] === 'conflict';
}

export async function batchCreate(request: Request, client: ClientRow, dropbox: Dropbox): Promise<Response> {
  if (client.access !== Client_Access.READ_WRITE) throw failure(Code.PERMISSION_DENIED, 'READ_ONLY');
  if (new URL(request.url).search !== '' || !/^application\/octet-stream(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) badRequest();
  const raw = request.headers.get('x-storage-batch');
  if (raw === null || raw.length > 8192 || /[^\x20-\x7e]/.test(raw)) badRequest();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return badRequest(); }
  const manifest = fromWire(BatchCreateManifestSchema, value as never, { strict: true }).message;
  if (manifest.objects.length === 0) badRequest();
  const keys = new Set<string>();
  let length = 0;
  for (const item of manifest.objects) {
    const key = objectKey(item.key).toLowerCase();
    if (keys.has(key)) badRequest();
    keys.add(key);
    length += item.sizeBytes;
  }
  if (length > MAX_OBJECT_BYTES) throw failure(Code.RESOURCE_EXHAUSTED, 'UPLOAD_TOO_LARGE', 413);
  const declared = request.headers.get('content-length');
  if (declared === null) throw failure(Code.FAILED_PRECONDITION, 'UPLOAD_LENGTH_MISMATCH', 411);
  if (!/^(0|[1-9][0-9]{0,9})$/.test(declared)) badRequest();
  if (Number(declared) !== length || request.body === null) throw failure(Code.INVALID_ARGUMENT, 'UPLOAD_LENGTH_MISMATCH');

  const controller = new AbortController();
  let pumping: Promise<void> | undefined;
  let outgoing: ReadableStream<Uint8Array> | undefined;
  let finishing = false;
  try {
    const started = await dropbox.json('files/upload_session/start_batch', { num_sessions: manifest.objects.length });
    const sessionValues = started.session_ids;
    if (!Array.isArray(sessionValues) || sessionValues.length !== manifest.objects.length
      || sessionValues.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 1024)
      || new Set(sessionValues).size !== sessionValues.length) throw incomplete();
    const sessions = sessionValues as string[];
    const stream = new FixedLengthStream(length);
    outgoing = stream.readable;
    let received = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, target) {
        received += chunk.byteLength;
        if (received > length) throw failure(Code.INVALID_ARGUMENT, 'UPLOAD_LENGTH_MISMATCH');
        target.enqueue(chunk);
      },
      flush() { if (received !== length) throw failure(Code.INVALID_ARGUMENT, 'UPLOAD_LENGTH_MISMATCH'); },
    });
    pumping = request.body.pipeThrough(limiter).pipeTo(stream.writable, { signal: controller.signal });
    void pumping.catch(() => undefined);
    const appended = await dropbox.appendBatch({
      entries: manifest.objects.map((item, index) => ({ cursor: { session_id: sessions[index], offset: 0 }, length: item.sizeBytes, close: true })),
      content_hash: manifest.contentHash,
    }, stream.readable);
    await pumping;
    if (records(appended.entries, sessions.length).some((entry) => entry['.tag'] !== 'success')) throw incomplete();

    finishing = true;
    const finished = await dropbox.json('files/upload_session/finish_batch_v2', {
      entries: manifest.objects.map((item, index) => ({
        cursor: { session_id: sessions[index], offset: item.sizeBytes },
        commit: { path: providerPath(client.namespace, item.key), mode: { '.tag': 'add' }, autorename: false, strict_conflict: true, mute: true },
      })),
    });
    const objects: ObjectMetadata[] = [];
    for (const [index, entry] of records(finished.entries, sessions.length).entries()) {
      const expected = manifest.objects[index];
      if (expected === undefined) throw incomplete();
      let metadata: ObjectMetadata;
      if (entry['.tag'] === 'success') metadata = objectMetadata({ ...entry, '.tag': 'file' }, client.namespace, expected.key);
      else if (conflict(entry)) {
        const existing = await dropbox.json('files/get_metadata', { path: providerPath(client.namespace, expected.key), include_deleted: false });
        if (existing['.tag'] === 'folder') throw failure(Code.ABORTED, 'REVISION_CONFLICT');
        metadata = objectMetadata(existing, client.namespace, expected.key);
      } else throw incomplete();
      if (metadata.sizeBytes !== expected.sizeBytes || metadata.contentHash !== expected.contentHash) {
        if (conflict(entry)) throw failure(Code.ABORTED, 'REVISION_CONFLICT');
        throw incomplete();
      }
      objects.push(metadata);
    }
    return Response.json(toWire(BatchCreateResponseSchema, create(BatchCreateResponseSchema, { objects })), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    controller.abort();
    await outgoing?.cancel().catch(() => undefined);
    if (pumping !== undefined) {
      try { await pumping; } catch (streamError) {
        if (streamError instanceof RpcError && streamError.reason === 'UPLOAD_LENGTH_MISMATCH') throw streamError;
      }
    }
    if (error instanceof RpcError && error.reason === 'REVISION_CONFLICT') throw error;
    // A finish response may describe partial commits; it never authorizes replay of the batch.
    if (!finishing && error instanceof RpcError && error.httpStatus === 429) throw error;
    throw incomplete();
  }
}
