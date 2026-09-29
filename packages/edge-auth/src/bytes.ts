/**
 * Byte and text primitives shared by the JWT and CSRF code. Web platform APIs only (no Buffer, no
 * workerd-only `crypto.subtle.timingSafeEqual`), so the same source runs in workerd and in Node tests.
 */

const encoder = new TextEncoder();

/** UTF-8 bytes typed with a plain ArrayBuffer, which the DOM lib's BufferSource requires. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(text));
}

/** Unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * base64url with optional `=`/`==` padding (Todofy's decoder, used for every JWT segment); null when
 * the text is not base64url. The empty string decodes to no bytes.
 */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  const unpadded = text.replace(/={1,2}$/, '');
  if (!BASE64URL.test(unpadded) || unpadded.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(unpadded.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The JSON value in a base64url segment, decoded as fatal UTF-8 (a leading BOM is dropped);
 * undefined when the segment is not base64url, not UTF-8 or not JSON.
 */
export function decodeJsonSegment(segment: string): unknown {
  const bytes = base64UrlDecode(segment);
  if (bytes === null) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Constant-time equality of two strings' UTF-8 bytes: an XOR over the whole length, so only the
 * length can leak (as with Python's `hmac.compare_digest`).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = utf8(a);
  const right = utf8(b);
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** Whole seconds since the epoch, as both apps compute "now". */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
