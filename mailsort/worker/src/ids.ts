/**
 * Identifiers the Worker makes: row IDs ordered by creation (9 base-36 digits of time, 7 random), label IDs when a
 * create has none and its path gives none, and etags (opaque, new on every write).
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function random(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => ALPHABET[byte % 36] ?? '0').join('');
}

/** An ID for a row created at `now` (base 36 epoch milliseconds, 9 digits, until the year 5188): newest sorts last. */
export function timeId(now: number): string {
  return `${Math.max(0, Math.floor(now)).toString(36).padStart(9, '0').slice(-9)}${random(7)}`;
}

/** A label ID: a letter and 9 random characters (AIP-122). */
export function shortId(prefix: 'l'): string {
  return `${prefix}${random(9)}`;
}

/** A new etag (AIP-154): opaque to clients. */
export function newEtag(now: number): string {
  return `${now.toString(36)}-${random(6)}`;
}
