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
 * is compared by its SHA-256, in constant time, with the digests RecallState holds for the route (the token the owner
 * made in 设置 and the one it replaced, while its grace lasts: tokens.ts) and those a Worker secret may hold
 * (INGEST_TOKEN_SHA256[_PREVIOUS], EXPORT_TOKEN_SHA256[_PREVIOUS], put by hand). RecallState's digests are kept in the
 * isolate's memory for TOKEN_CACHE_MS, so a refused bearer reaches the object at most once per TOKEN_RECHECK_MS (to see
 * a token made since), and an accepted one costs no extra call. A machine token never reaches the owner API, and an
 * Access JWT never replaces a machine token.
 *
 * The blob route answers from R2 without waking the object; only when R2 has no such object does it ask the object
 * whether the blob was deleted (410) or lost (500).
 */
import { constantTimeEqual } from '@ziyixi/edge-auth';
import { machineError, toResponse, type MachineAnswer } from './answers.ts';
import { BLOB_PATH, blobKey, contentDigest, hex, sha256Hex } from './blobs.ts';
import { RECALL_OBJECT, type Env } from './env.ts';
import { BATCH_MAX_WIRE_BYTES, TOKEN_CACHE_MS, TOKEN_MAX_CHARS, TOKEN_RECHECK_MS } from './limits.ts';
import { secretDigests, type RouteDigests, type TokenRoute } from './tokens.ts';

export const MACHINE_PREFIX = '/api/machine/';
const V1 = '/api/machine/v1/';

interface Route {
  readonly name: 'batches' | 'changes' | 'blobs';
  readonly method: 'POST' | 'GET';
  readonly token: TokenRoute;
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

/** The SHA-256 of the request's bearer token, or null when it has none (or one too long to hash). */
export async function bearerDigest(request: Request): Promise<string | null> {
  const match = /^Bearer ([!-~]+)$/.exec(request.headers.get('authorization') ?? '');
  const token = match?.[1];
  if (token === undefined || token.length > TOKEN_MAX_CHARS) return null;
  return sha256Hex(new TextEncoder().encode(token));
}

/** Whether a digest is one of `digests` (each compared in constant time). */
export function digestMatches(digest: string | null, digests: readonly string[]): boolean {
  let found = false;
  for (const expected of digests) found = (digest !== null && constantTimeEqual(digest, expected)) || found;
  return found;
}

/**
 * RecallState's digests as this isolate last read them, and when (Date.now(): the real clock). The workerd suite
 * (DEV_MANUAL_ALARMS) reads them on every request, as it moves the object's clock.
 */
let held: { readonly at: number; readonly digests: RouteDigests } | null = null;

/** RecallState's digests, read again when older than `maxAge`. */
async function heldDigests(env: Env, maxAge: number): Promise<RouteDigests> {
  const now = Date.now();
  if (held !== null && now - held.at < maxAge && env.DEV_MANUAL_ALARMS !== 'true') return held.digests;
  const digests = await env.RECALL.get(env.RECALL.idFromName(RECALL_OBJECT)).machineDigests();
  held = { at: now, digests };
  return digests;
}

/** Test hook: forget the digests kept in memory. */
export function forgetHeldDigests(): void {
  held = null;
}

/**
 * Whether the request's bearer is a token of `route`: 'ok', 'refused' (401) or 'none' (no digest anywhere: 503). The
 * Worker-secret digests first (no call), then RecallState's as kept, then, for a refusal, once more freshly read when
 * the kept ones are TOKEN_RECHECK_MS old (a token made since).
 */
export async function checkBearer(request: Request, env: Env, route: TokenRoute): Promise<'ok' | 'refused' | 'none'> {
  const digest = await bearerDigest(request);
  const secrets = secretDigests(env, route);
  if (digestMatches(digest, secrets)) return 'ok';
  let digests = (await heldDigests(env, TOKEN_CACHE_MS))[route];
  if (!digestMatches(digest, digests) && digest !== null) digests = (await heldDigests(env, TOKEN_RECHECK_MS))[route];
  if (digestMatches(digest, digests)) return 'ok';
  return secrets.length === 0 && digests.length === 0 ? 'none' : 'refused';
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
  const bearer = await checkBearer(request, env, route.token);
  if (bearer === 'none') return machineError('NOT_CONFIGURED', requestId);
  if (bearer === 'refused') return machineError('UNAUTHORIZED', requestId, { 'www-authenticate': 'Bearer' });
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

