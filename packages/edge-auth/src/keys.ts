import { utf8 } from './bytes.ts';

/** An HMAC-SHA-256 key, or a function that resolves one (so key errors surface where the app wants). */
export type HmacKey = CryptoKey | (() => Promise<CryptoKey>);

const HMAC_SHA256 = { name: 'HMAC', hash: 'SHA-256' } as const;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/**
 * 64 hex characters (either case) as a 32-byte, non-extractable HMAC-SHA-256 key with usage
 * `['sign']` (Todofy's `CSRF_SIGNING_KEY`); null when the text is not exactly that. The caller trims.
 */
export async function importHmacKeyHex(hex: string): Promise<CryptoKey | null> {
  if (typeof hex !== 'string' || !HEX_KEY.test(hex)) return null;
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.importKey('raw', raw, HMAC_SHA256, false, ['sign']);
}

/**
 * HKDF-SHA-256(ikm, salt, info) → a non-extractable 256-bit HMAC-SHA-256 key with usages
 * `['sign','verify']` (Mail Hero: `CREDENTIAL_KEY` bytes, salt "mail-hero", info "tokens-v1").
 */
export async function deriveHmacKeyHkdf(ikm: Uint8Array<ArrayBuffer>, salt: string, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(salt), info: utf8(info) },
    base,
    { ...HMAC_SHA256, length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/** The key itself, or the key its function resolves (errors propagate). */
export async function resolveHmacKey(key: HmacKey): Promise<CryptoKey> {
  return typeof key === 'function' ? key() : key;
}
