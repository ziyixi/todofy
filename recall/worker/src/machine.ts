/**
 * The machine routes (../../docs/design.md §2.1), checked by the Worker itself, strictly and cheaply, before any Durable
 * Object call (an Access Bypass application lets exactly these through Access, and Bypass traffic counts against the
 * account's Worker requests):
 *
 * | Route | Token |
 * | --- | --- |
 * | POST /api/machine/v1/batches (the extension's uploads, gzip, at most 1 MiB) | ingest (write-only) |
 * | GET /api/machine/v1/changes (the archive's change feed) | export (read-only) |
 * | GET /api/machine/v1/blobs/<path> (a captured text's stored bytes) | export |
 *
 * Every other path under /api/machine/ is 404, another method 405, a route without a digest configured 503
 * `NOT_CONFIGURED`, a missing or wrong bearer 401, a larger body 413 (Content-Length first, then while reading). A token
 * is compared by its SHA-256 with the route's current and previous digest (INGEST_TOKEN_SHA256[_PREVIOUS],
 * EXPORT_TOKEN_SHA256[_PREVIOUS], put by the owner's mint-tokens.mjs), in constant time. A machine token never reaches
 * the owner API, and an Access JWT never replaces a machine token.
 *
 * The blob route answers from R2 without waking the object; only when R2 has no such object does it ask the object
 * whether the blob was deleted (410) or lost (500).
 */
import { constantTimeEqual } from '@ziyixi/edge-auth';
import { machineError, toResponse, type MachineAnswer } from './answers.ts';
import { BLOB_PATH, blobKey, contentDigest, hex, sha256Hex } from './blobs.ts';
import { RECALL_OBJECT, type Env } from './env.ts';
import { BATCH_MAX_WIRE_BYTES, TOKEN_MAX_CHARS } from './limits.ts';

export const MACHINE_PREFIX = '/api/machine/';
const V1 = '/api/machine/v1/';

type Token = 'ingest' | 'export';

interface Route {
  readonly name: 'batches' | 'changes' | 'blobs';
  readonly method: 'POST' | 'GET';
  readonly token: Token;
  /** The blob route's path (`2026/10/<uuid>.txt.gz`). */
  readonly blobPath?: string;
}

/** The route a path names, or null (404). */
export function machineRoute(pathname: string): Route | null {
  if (pathname === `${V1}batches`) return { name: 'batches', method: 'POST', token: 'ingest' };
  if (pathname === `${V1}changes`) return { name: 'changes', method: 'GET', token: 'export' };
  if (pathname.startsWith(`${V1}blobs/`)) return { name: 'blobs', method: 'GET', token: 'export', blobPath: pathname.slice(`${V1}blobs/`.length) };
  return null;
}

const DIGEST = /^[0-9a-f]{64}$/;

/** The configured digests of a route's token (current, then previous), lower-case hex only. */
export function tokenDigests(env: Env, token: Token): string[] {
  const values = token === 'ingest' ? [env.INGEST_TOKEN_SHA256, env.INGEST_TOKEN_SHA256_PREVIOUS] : [env.EXPORT_TOKEN_SHA256, env.EXPORT_TOKEN_SHA256_PREVIOUS];
  return values.map((value) => (value ?? '').trim().toLowerCase()).filter((value) => DIGEST.test(value));
}

/** Whether the request's bearer token hashes to one of the digests (each compared in constant time). */
export async function bearerMatches(request: Request, digests: readonly string[]): Promise<boolean> {
  const match = /^Bearer ([!-~]+)$/.exec(request.headers.get('authorization') ?? '');
  const token = match?.[1];
  if (token === undefined || token.length > TOKEN_MAX_CHARS) return false;
  const digest = await sha256Hex(new TextEncoder().encode(token));
  let found = false;
  for (const expected of digests) found = constantTimeEqual(digest, expected) || found;
  return found;
}

/** The body, or null when it passes `max` bytes (read as it streams, whatever Content-Length said). */
async function readCapped(request: Request, max: number): Promise<ArrayBuffer | null> {
  if (request.body === null) return new ArrayBuffer(0);
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks).arrayBuffer();
}

/** The blob route: R2's object as stored (gzip, no Content-Encoding), with its RFC 9530 digest. */
async function blob(env: Env, path: string, requestId: string): Promise<Response | MachineAnswer> {
  if (!BLOB_PATH.test(path)) return machineError('NOT_FOUND', requestId);
  let object: R2ObjectBody | null;
  try {
    object = await env.STORE.get(blobKey(path));
  } catch {
    return machineError('UNAVAILABLE', requestId, { 'retry-after': '60' });
  }
  if (object === null) {
    const state = await env.RECALL.get(env.RECALL.idFromName(RECALL_OBJECT)).blobState(path);
    return machineError(state === 'deleted' ? 'BLOB_DELETED' : 'BLOB_MISSING', requestId);
  }
  let body: ReadableStream | ArrayBuffer = object.body;
  let sha256 = object.checksums.sha256 === undefined ? null : hex(object.checksums.sha256);
  if (sha256 === null) {
    body = await object.arrayBuffer();
    sha256 = await sha256Hex(body);
  }
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(object.size),
      'content-digest': contentDigest(sha256),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** A machine request's answer; the caller adds the private headers and logs a refusal. */
export async function handleMachine(request: Request, env: Env, url: URL, requestId: string): Promise<{ readonly response: Response; readonly reason?: string }> {
  const answer = await machineAnswer(request, env, url, requestId);
  return answer instanceof Response ? { response: answer } : { response: toResponse(answer), ...(answer.reason === undefined ? {} : { reason: answer.reason }) };
}

async function machineAnswer(request: Request, env: Env, url: URL, requestId: string): Promise<Response | MachineAnswer> {
  const route = machineRoute(url.pathname);
  if (route === null) return machineError('NOT_FOUND', requestId);
  if (request.method !== route.method) return machineError('METHOD_NOT_ALLOWED', requestId, { allow: route.method });
  const digests = tokenDigests(env, route.token);
  if (digests.length === 0) return machineError('NOT_CONFIGURED', requestId);
  if (!(await bearerMatches(request, digests))) return machineError('UNAUTHORIZED', requestId, { 'www-authenticate': 'Bearer' });
  const stub = () => env.RECALL.get(env.RECALL.idFromName(RECALL_OBJECT));
  if (route.name === 'batches') {
    if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/gzip') return machineError('BAD_REQUEST', requestId);
    const length = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > BATCH_MAX_WIRE_BYTES) return machineError('PAYLOAD_TOO_LARGE', requestId);
    const body = await readCapped(request, BATCH_MAX_WIRE_BYTES);
    if (body === null) return machineError('PAYLOAD_TOO_LARGE', requestId);
    // RecallState logs the upload itself (batch ID, counts, a code).
    return stub().ingest(body, requestId);
  }
  if (route.name === 'changes') return stub().feed(url.search, requestId);
  return blob(env, route.blobPath ?? '', requestId);
}

