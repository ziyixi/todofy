/**
 * The hooks hosts' credential helpers (the Mail Hero webhook Bearer and the newsletter Basic
 * digests). Access, CSRF and the private headers come from `@ziyixi/edge-auth`.
 */
const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant-time equality of the UTF-8 bytes (only the length can leak, as in `hmac.compare_digest`). */
function timingSafeEqual(a: string, b: string): boolean {
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

// Python's base64.b64decode(validate=True): standard alphabet, exact padding, nothing else.
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function base64DecodeStrict(text: string): Uint8Array | null {
  return STRICT_BASE64.test(text) ? fromBinary(atob(text)) : null;
}
