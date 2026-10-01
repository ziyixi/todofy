/**
 * Identifiers the Worker makes: change IDs (16 characters of a-z0-9, ordered by creation: 9 of time, 7 random), watch
 * IDs when CreateWatch has no watch_id (`w` and 9 random characters), and etags (opaque, new on every owner write).
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function random(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => ALPHABET[byte % 36] ?? '0').join('');
}

/** A change ID for a change created at `now` (base 36 epoch milliseconds, 9 digits, until the year 5188). */
export function changeId(now: number): string {
  return `${Math.max(0, Math.floor(now)).toString(36).padStart(9, '0').slice(-9)}${random(7)}`;
}

/** A watch ID: `w` and 9 random characters (AIP-122, Watch.name's rule). */
export function watchId(): string {
  return `w${random(9)}`;
}

/** A new etag (AIP-154): opaque to clients. */
export function newEtag(now: number): string {
  return `${now.toString(36)}-${random(6)}`;
}
