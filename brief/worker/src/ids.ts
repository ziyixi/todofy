/**
 * Identifiers the Worker makes: etags (opaque, new on every write) and request IDs for logs and error bodies.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A new etag (AIP-154): opaque to clients. */
export function newEtag(now: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${now.toString(36)}-${Array.from(bytes, (byte) => ALPHABET[byte % 36] ?? '0').join('')}`;
}

/** A request ID: 16 hex characters. */
export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
