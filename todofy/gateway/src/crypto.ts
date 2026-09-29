const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant-time equality of the UTF-8 bytes (only the length can leak, as in `hmac.compare_digest`). */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = utf8(a);
  const right = utf8(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

/** Compare with every digest, so timing does not reveal which one matched. */
export function matchesAny(presented: string, digests: readonly string[]): boolean {
  let matched = false;
  for (const digest of digests) matched = timingSafeEqual(presented, digest) || matched;
  return matched;
}

function fromBinary(binary: string): Uint8Array {
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Unpadded (or padded) base64url; null when the text is not base64url. */
export function base64UrlDecode(text: string): Uint8Array | null {
  const unpadded = text.replace(/={1,2}$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(unpadded) || unpadded.length % 4 === 1) return null;
  return fromBinary(atob(unpadded.replace(/-/g, '+').replace(/_/g, '/')));
}

// Python's base64.b64decode(validate=True): standard alphabet, exact padding, nothing else.
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function base64DecodeStrict(text: string): Uint8Array | null {
  return STRICT_BASE64.test(text) ? fromBinary(atob(text)) : null;
}

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON from a base64url segment (JWT parts, CSRF claims); undefined when it is not valid. */
export function decodeJsonSegment(segment: string): unknown {
  const bytes = base64UrlDecode(segment);
  if (bytes === null) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}
