/**
 * The shared signed-claims token format: `base64url(JSON) "." base64url(HMAC-SHA-256(key, base64url(JSON)))`,
 * both parts unpadded. CSRF tokens in both apps use it; the bytes must never change, or tokens already
 * in browsers stop verifying.
 */
import { base64UrlEncode, constantTimeEqual, decodeJsonSegment, isJsonObject, utf8, type JsonObject } from './bytes.ts';

/** Default and CSRF length cap for a signed-claims token. */
export const SIGNED_TOKEN_MAX_CHARS = 1024;

async function mac(key: CryptoKey, payload: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(payload))));
}

/** A token over `JSON.stringify(claims)` (key order as given). Key errors propagate. */
export async function signClaims(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const payload = base64UrlEncode(utf8(JSON.stringify(claims)));
  return `${payload}.${await mac(key, payload)}`;
}

/**
 * The claims of a token this key signed, or null. The token must be non-empty and at most
 * `maxChars` characters; it is split at its first `.`, and the signature text must equal the
 * canonical base64url HMAC of the payload text (constant-time compare, so only canonical tokens
 * verify). The payload must be fatal-UTF-8 JSON and an object. Expiry and meaning are the caller's.
 * Never throws: a key that cannot sign also gives null.
 */
export async function verifySignedClaims(
  key: CryptoKey,
  token: string,
  maxChars: number = SIGNED_TOKEN_MAX_CHARS,
): Promise<JsonObject | null> {
  if (typeof token !== 'string' || token === '' || token.length > maxChars) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let expected: string;
  try {
    expected = await mac(key, payload);
  } catch {
    return null;
  }
  if (!constantTimeEqual(signature, expected)) return null;
  const claims = decodeJsonSegment(payload);
  return isJsonObject(claims) ? claims : null;
}
