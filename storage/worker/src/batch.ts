import { create } from '@ziyixi/proto/protobuf';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { BatchCreateManifestSchema, BatchCreateResponseSchema, type BatchCreateObject, type ObjectMetadata } from '@ziyixi/proto/storage/objects/v1/objects_pb';
import { Client_Access } from '@ziyixi/proto/storage/ui/v1/client_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { insufficientSpace, type Dropbox } from './dropbox.ts';
import { MAX_OBJECT_BYTES } from './env.ts';
import { badRequest, failure } from './errors.ts';
import { hex, objectKey, providerPath } from './keys.ts';
import { objectMetadata } from './objects.ts';
import type { ClientRow } from './store.ts';

type BatchPhase = 'start' | 'append' | 'finish' | 'verify';
const DIAGNOSTIC_REASONS = new Set([
  'BATCH_INCOMPLETE', 'REVISION_CONFLICT', 'UPLOAD_LENGTH_MISMATCH', 'UPLOAD_HASH_MISMATCH', 'NOT_FOUND', 'BAD_REQUEST',
  'PROVIDER_RESPONSE_INVALID', 'UNAVAILABLE', 'CONNECTION_INVALID', 'NOT_CONFIGURED', 'INTERNAL', 'INSUFFICIENT_SPACE',
]);
const ENTRY_FAILURE_TAGS = new Set([
  'lookup_failed', 'not_closed', 'content_hash_mismatch', 'too_many_write_operations', 'path', 'not_found',
  'incorrect_offset', 'closed', 'too_large', 'insufficient_space', 'payload_too_large', 'other',
  'file', 'folder', 'file_ancestor', 'conflict', 'no_write_permission',
]);

function logFailure(error: unknown, phase: BatchPhase, finishing: boolean, entry: Record<string, unknown> | null): void {
  const rpc = error instanceof RpcError ? error : null;
  const tag = entry?.['.tag'];
  const failure = entry?.failure;
  const failureRecord = typeof failure === 'object' && failure !== null && !Array.isArray(failure) ? failure as Record<string, unknown> : null;
  const failureTag = failureRecord?.['.tag'];
  const detail = failureTag === 'lookup_failed' ? failureRecord?.lookup_failed : failureTag === 'path' ? failureRecord?.path : undefined;
  const detailTag = typeof detail === 'object' && detail !== null && !Array.isArray(detail) ? (detail as Record<string, unknown>)['.tag'] : undefined;
  try {
    console.error(JSON.stringify({
      event: 'storage_batch_failed', phase, finish_started: finishing, finish_response_received: phase === 'verify',
      entry_tag: entry === null ? 'none' : tag === 'success' || tag === 'failure' ? tag : 'other',
      entry_failure_tag: tag !== 'failure' ? 'none' : typeof failureTag === 'string' && ENTRY_FAILURE_TAGS.has(failureTag) ? failureTag : 'other',
      entry_detail_tag: tag !== 'failure' || detail === undefined ? 'none' : typeof detailTag === 'string' && ENTRY_FAILURE_TAGS.has(detailTag) ? detailTag : 'other',
      cause_reason: rpc === null ? 'UNEXPECTED_ERROR' : DIAGNOSTIC_REASONS.has(rpc.reason) ? rpc.reason : 'UNKNOWN_RPC_ERROR',
      cause_http_status: rpc !== null && Number.isInteger(rpc.httpStatus) && rpc.httpStatus >= 100 && rpc.httpStatus <= 599 ? rpc.httpStatus : 0,
    }));
  } catch { /* Diagnostics must not replace the original request result. */ }
}

function incomplete(): RpcError { return failure(Code.UNAVAILABLE, 'BATCH_INCOMPLETE'); }

const HASH_BLOCK_BYTES = 4 * 1024 * 1024;

/** Dropbox content hashes of consecutive manifest items, through native SHA-256 streams without buffering bytes. */
class ItemHashes {
  private readonly items: readonly BatchCreateObject[];
  private item = 0;
  private itemBytes = 0;
  private blockBytes = 0;
  private block: { readonly writer: WritableStreamDefaultWriter<ArrayBufferView>; readonly digest: Promise<ArrayBuffer> } | null = null;
  private blocks: ArrayBuffer[] = [];

  constructor(items: readonly BatchCreateObject[]) { this.items = items; }

  /** Rejects as soon as a completed item differs from its manifest hash, before its last bytes are forwarded. */
  async write(chunk: Uint8Array): Promise<void> {
    for (let at = 0; at < chunk.byteLength;) {
      const expected = this.items[this.item];
      if (expected === undefined) throw failure(Code.INVALID_ARGUMENT, 'UPLOAD_LENGTH_MISMATCH');
      if (this.block === null) {
        const stream = new crypto.DigestStream('SHA-256');
        this.block = { writer: stream.getWriter(), digest: stream.digest };
      }
      const take = Math.min(chunk.byteLength - at, expected.sizeBytes - this.itemBytes, HASH_BLOCK_BYTES - this.blockBytes);
      await this.block.writer.write(chunk.subarray(at, at + take));
      at += take;
      this.itemBytes += take;
      this.blockBytes += take;
      if (this.blockBytes === HASH_BLOCK_BYTES || this.itemBytes === expected.sizeBytes) {
        await this.block.writer.close();
        this.blocks.push(await this.block.digest);
        this.block = null;
        this.blockBytes = 0;
      }
      if (this.itemBytes === expected.sizeBytes) {
        const joined = new Uint8Array(this.blocks.length * 32);
        for (const [index, digest] of this.blocks.entries()) joined.set(new Uint8Array(digest), index * 32);
        if (hex(await crypto.subtle.digest('SHA-256', joined)) !== expected.contentHash) throw failure(Code.INVALID_ARGUMENT, 'UPLOAD_HASH_MISMATCH');
        this.blocks = [];
        this.item++;
        this.itemBytes = 0;
      }
    }
  }
}

function records(value: unknown, length: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))) throw incomplete();
  return value as Record<string, unknown>[];
}

/** The write error of a failed finish entry, such as conflict or insufficient_space. */
function pathFailure(entry: Record<string, unknown>): unknown {
  const error = entry.failure;
  if (entry['.tag'] !== 'failure' || typeof error !== 'object' || error === null || Array.isArray(error)) return undefined;
  const reason = error as Record<string, unknown>;
  const path = reason.path;
  return reason['.tag'] === 'path' && typeof path === 'object' && path !== null && !Array.isArray(path)
    ? (path as Record<string, unknown>)['.tag'] : undefined;
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
  let phase: BatchPhase = 'start';
  let diagnosticEntry: Record<string, unknown> | null = null;
  try {
    const started = await dropbox.json('files/upload_session/start_batch', { num_sessions: manifest.objects.length });
    const sessionValues = started.session_ids;
    if (!Array.isArray(sessionValues) || sessionValues.length !== manifest.objects.length
      || sessionValues.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 1024)
      || new Set(sessionValues).size !== sessionValues.length) throw incomplete();
    const sessions = sessionValues as string[];
    phase = 'append';
    const stream = new FixedLengthStream(length);
    outgoing = stream.readable;
    let received = 0;
    // Each item is checked against its own manifest hash before finish can commit wrong bytes under a create-only key.
    const hashes = new ItemHashes(manifest.objects);
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, target) {
        received += chunk.byteLength;
        if (received > length) throw failure(Code.INVALID_ARGUMENT, 'UPLOAD_LENGTH_MISMATCH');
        await hashes.write(chunk);
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
    const appendFailure = records(appended.entries, sessions.length).find((entry) => entry['.tag'] !== 'success');
    if (appendFailure !== undefined) { diagnosticEntry = appendFailure; throw incomplete(); }

    phase = 'finish';
    finishing = true;
    const finished = await dropbox.json('files/upload_session/finish_batch_v2', {
      entries: manifest.objects.map((item, index) => ({
        cursor: { session_id: sessions[index], offset: item.sizeBytes },
        commit: { path: providerPath(client.namespace, item.key), mode: { '.tag': 'add' }, autorename: false, strict_conflict: true, mute: true },
      })),
    });
    phase = 'verify';
    const objects: ObjectMetadata[] = [];
    for (const [index, entry] of records(finished.entries, sessions.length).entries()) {
      diagnosticEntry = entry;
      const expected = manifest.objects[index];
      if (expected === undefined) throw incomplete();
      let metadata: ObjectMetadata;
      const failed = pathFailure(entry);
      if (entry['.tag'] === 'success') metadata = objectMetadata({ ...entry, '.tag': 'file' }, client.namespace, expected.key);
      else if (failed === 'conflict') {
        // With refresh, start, append and finish, 32 conflicts use 36 of an invocation's 50 subrequests.
        const existing = await dropbox.json('files/get_metadata', { path: providerPath(client.namespace, expected.key), include_deleted: false });
        if (existing['.tag'] === 'folder') throw failure(Code.ABORTED, 'REVISION_CONFLICT');
        metadata = objectMetadata(existing, client.namespace, expected.key);
      } else if (failed === 'insufficient_space') throw dropbox.recordFailure(insufficientSpace());
      else throw incomplete();
      if (metadata.sizeBytes !== expected.sizeBytes || metadata.contentHash !== expected.contentHash) {
        if (failed === 'conflict') throw failure(Code.ABORTED, 'REVISION_CONFLICT');
        throw incomplete();
      }
      objects.push(metadata);
    }
    return Response.json(toWire(BatchCreateResponseSchema, create(BatchCreateResponseSchema, { objects })), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    controller.abort();
    await outgoing?.cancel().catch(() => undefined);
    let streamFailure: RpcError | undefined;
    if (pumping !== undefined) {
      try { await pumping; } catch (streamError) {
        if (streamError instanceof RpcError && (streamError.reason === 'UPLOAD_LENGTH_MISMATCH' || streamError.reason === 'UPLOAD_HASH_MISMATCH')) streamFailure = streamError;
      }
    }
    logFailure(streamFailure ?? error, phase, finishing, diagnosticEntry);
    if (streamFailure !== undefined) throw streamFailure;
    // Definite answers; either may still follow partial commits of other items, so neither acknowledges the batch.
    if (error instanceof RpcError && (error.reason === 'REVISION_CONFLICT' || error.reason === 'INSUFFICIENT_SPACE')) throw error;
    // A finish response may describe partial commits; it never authorizes replay of the batch.
    if (finishing) throw incomplete();
    // Nothing is committed before finish: a rate limit keeps its Retry-After, and any other failure permits replay.
    if (error instanceof RpcError && error.httpStatus === 429) throw error;
    throw failure(Code.UNAVAILABLE, 'BATCH_NOT_COMMITTED');
  }
}
