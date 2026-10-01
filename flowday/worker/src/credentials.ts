/**
 * Credentials at rest (../../docs/design.md "Data"). The Todoist API key is stored in D1 only sealed with AES-256-GCM
 * under the Worker secret CREDENTIAL_KEY (64 hex characters), so D1, its Time Travel history and any export hold
 * ciphertext only. The settings key name is the additional authenticated data: a sealed value cannot be moved to
 * another key. A lost or rotated CREDENTIAL_KEY only means entering the Todoist key again in Settings.
 *
 * Format: "v1.<base64url IV>.<base64url ciphertext and tag>". A value without the prefix (for example a plaintext
 * key from an older copy) is never used.
 */

export const SEALED_PREFIX = 'v1.';
const IV_BYTES = 12;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/** Whether a stored value has the sealed format (it may still fail to open under another key). */
export function isSealed(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX) && value.split('.').length === 3;
}

/** The AES-GCM key from the secret's 64 hex characters; null when the secret is missing or malformed. */
export async function importCredentialKey(hex: string | undefined): Promise<CryptoKey | null> {
  const value = (hex ?? '').trim();
  if (!HEX_KEY.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function aad(name: string): Uint8Array {
  return new TextEncoder().encode(`flowday:${name}`);
}

/** Seals `plaintext` for the settings key `name`. */
export async function sealCredential(key: CryptoKey, name: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(name) }, key, new TextEncoder().encode(plaintext));
  return `${SEALED_PREFIX}${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

/** Opens a sealed value of the settings key `name`; null when it is not sealed, damaged or sealed under another key. */
export async function openCredential(key: CryptoKey, name: string, value: string | null | undefined): Promise<string | null> {
  if (!isSealed(value)) return null;
  const [, ivText = '', dataText = ''] = value.split('.');
  const iv = fromBase64Url(ivText);
  const data = fromBase64Url(dataText);
  if (iv?.byteLength !== IV_BYTES || data === null) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(name) }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
