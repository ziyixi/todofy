/**
 * AIP-158 page tokens for list methods: opaque to the client, and bound to the list's other parameters.
 *
 *   const token = encodePageToken({ at: 1700000000000, id: 'w-2609' }, { filter });
 *   const cursor = decodePageToken(request.pageToken, { filter }); // PageTokenError: answer INVALID_ARGUMENT
 *
 * A token is base64url (no padding) of the JSON `{"v": 1, "c": <cursor>, "p": <fingerprint>}`: the app's
 * cursor and a fingerprint of the parameters the token was made for (everything but page_size and
 * page_token: AIP-158 lets page_size change between pages and requires the others to stay). A token that is
 * malformed, longer than MAX_TOKEN_CHARS or made for other parameters is refused, so a page of one filter is
 * never continued with another. The fingerprint (FNV-1a, 32 bits) detects a mistake, not an attacker: a
 * token is not a credential (the owner API sits behind Access), and the app still validates the cursor it
 * gets back as untrusted input.
 */
import type { JsonValue } from '@bufbuild/protobuf';

/** Longer tokens are refused before they are decoded. */
export const MAX_TOKEN_CHARS = 1024;
const VERSION = 1;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export class PageTokenError extends Error {}

/** The list parameters a token is bound to (by name; page_size and page_token are never among them). */
export type PageParameters = Readonly<Record<string, string | number | boolean>>;

/** FNV-1a over the UTF-16 code units of the parameters' canonical JSON (keys sorted), as 8 hex digits. */
function fingerprint(parameters: PageParameters): string {
  const text = JSON.stringify(Object.keys(parameters).sort().map((key) => [key, parameters[key]]));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(token: string): string {
  const binary = atob(token.replaceAll('-', '+').replaceAll('_', '/'));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** The token of the page after `cursor`, for a list called with `parameters`. */
export function encodePageToken(cursor: JsonValue, parameters: PageParameters): string {
  const token = toBase64Url(JSON.stringify({ v: VERSION, c: cursor, p: fingerprint(parameters) }));
  if (token.length > MAX_TOKEN_CHARS) throw new PageTokenError('the cursor is too large for a page token');
  return token;
}

/** The cursor of `token`, which must have been made for `parameters`; throws PageTokenError otherwise. */
export function decodePageToken(token: string, parameters: PageParameters): JsonValue {
  if (token === '' || token.length > MAX_TOKEN_CHARS || !BASE64URL.test(token)) throw new PageTokenError('not a page token');
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(token));
  } catch {
    throw new PageTokenError('not a page token');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new PageTokenError('not a page token');
  const { v, c, p } = payload as { v?: unknown; c?: JsonValue; p?: unknown };
  if (v !== VERSION || c === undefined || typeof p !== 'string') throw new PageTokenError('not a page token');
  if (p !== fingerprint(parameters)) throw new PageTokenError('the page token was made for other list parameters');
  return c;
}
