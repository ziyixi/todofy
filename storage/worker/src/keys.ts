import { base64UrlEncode, importHmacKeyHex, signClaims, verifySignedClaims } from '@ziyixi/edge-auth';
import { Code } from '@ziyixi/proto/rpc-status';
import { ObjectMetadataSchema } from '@ziyixi/proto/storage/objects/v1/objects_pb';
import { ClientSchema } from '@ziyixi/proto/storage/ui/v1/client_pb';
import { formatMatches } from '@ziyixi/proto/wire-json';
import { badRequest, failure } from './errors.ts';

export function randomText(length = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(length)));
}

export function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export function namespace(value: string): string {
  if (!formatMatches(ClientSchema.file, 'Namespace', value)) badRequest();
  return value;
}

export function objectKey(value: string, prefix = false): string {
  if (!formatMatches(ObjectMetadataSchema.file, prefix ? 'Prefix' : 'Key', value)) badRequest();
  if (prefix && value === '') return value;
  const parts = (prefix && value.endsWith('/') ? value.slice(0, -1) : value).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) badRequest();
  return value;
}

export function providerRoot(clientNamespace: string): string {
  return '/namespaces/' + namespace(clientNamespace);
}

export function providerPath(clientNamespace: string, key: string): string {
  return providerRoot(clientNamespace) + '/' + objectKey(key);
}

/** An exact strong ETag or the protocol's original opaque revision, never a wildcard/list. */
export function revision(value: string): string {
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (!formatMatches(ObjectMetadataSchema.file, 'Revision', unquoted)) badRequest();
  return unquoted;
}

export function matchedRevision(request: Request): string | null {
  const value = request.headers.get('if-match');
  return value === null ? null : revision(value);
}

export function writeMode(request: Request): { readonly '.tag': 'add' } | { readonly '.tag': 'update'; readonly update: string } {
  const match = matchedRevision(request);
  const absent = request.headers.get('if-none-match');
  if (match !== null && absent === null) return { '.tag': 'update', update: match };
  if (match === null && absent === '*') return { '.tag': 'add' };
  throw failure(Code.FAILED_PRECONDITION, 'WRITE_PRECONDITION_REQUIRED', 428);
}

export const LIST_CURSOR_TTL_MS = 24 * 60 * 60_000;

interface CursorScope {
  readonly namespace: string;
  readonly prefix: string;
  readonly expires: number;
}

export type ListCursor = CursorScope & (
  | { readonly provider: string }
  | { readonly page: string; readonly offset: number }
);

async function cursorKey(secret: string): Promise<CryptoKey> {
  const key = await importHmacKeyHex(secret);
  if (key === null) throw failure(Code.INTERNAL, 'INTERNAL');
  return key;
}

export async function encodeCursor(secret: string, cursor: ListCursor): Promise<string> {
  return signClaims(await cursorKey(secret), { ...cursor, version: 'page' in cursor ? 2 : 1 });
}

export async function decodeCursor(secret: string, value: string, clientNamespace: string, prefix: string): Promise<ListCursor> {
  const cursor = await verifySignedClaims(await cursorKey(secret), value, 8192);
  if (cursor === null || cursor.namespace !== clientNamespace || cursor.prefix !== prefix
    || typeof cursor.expires !== 'number' || !Number.isSafeInteger(cursor.expires) || cursor.expires <= Date.now()) {
    throw failure(Code.INVALID_ARGUMENT, 'CURSOR_INVALID');
  }
  const scope = { namespace: clientNamespace, prefix, expires: cursor.expires };
  if (cursor.version === 1 && typeof cursor.provider === 'string' && cursor.provider.length > 0 && cursor.provider.length <= 4096) {
    return { ...scope, provider: cursor.provider };
  }
  if (cursor.version === 2 && typeof cursor.page === 'string' && /^[0-9a-f-]{36}$/.test(cursor.page)
    && typeof cursor.offset === 'number' && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0) {
    return { ...scope, page: cursor.page, offset: cursor.offset };
  }
  throw failure(Code.INVALID_ARGUMENT, 'CURSOR_INVALID');
}
