/**
 * Identifiers the Worker makes: etags (opaque, new on every write) and request IDs for logs.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function random(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => ALPHABET[byte % 36] ?? '0').join('');
}

/** A new etag (AIP-154): opaque to clients. */
export function newEtag(now: number): string {
  return `${now.toString(36)}-${random(6)}`;
}

/** A request ID for logs and error bodies: 16 hex characters. */
export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
