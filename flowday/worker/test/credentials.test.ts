/**
 * The sealed Todoist key (../src/credentials.ts): AES-256-GCM under CREDENTIAL_KEY, bound to its settings key.
 */
import { describe, expect, it } from 'vitest';
import { importCredentialKey, isSealed, openCredential, sealCredential } from '../src/credentials.ts';

const SECRET = 'ab'.repeat(32);

describe('credentials at rest', () => {
  it('seals with a fresh IV, opens only with the same key and settings name, and never stores the plaintext', async () => {
    const key = await importCredentialKey(SECRET);
    if (key === null) throw new Error('no key');
    const first = await sealCredential(key, 'todoist_api_key', 'synthetic-token-123');
    const second = await sealCredential(key, 'todoist_api_key', 'synthetic-token-123');
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('synthetic');
    expect(isSealed(first)).toBe(true);
    expect(await openCredential(key, 'todoist_api_key', first)).toBe('synthetic-token-123');
    expect(await openCredential(key, 'other_key', first)).toBeNull();
    const other = await importCredentialKey('cd'.repeat(32));
    if (other === null) throw new Error('no key');
    expect(await openCredential(other, 'todoist_api_key', first)).toBeNull();
  });

  it('refuses a missing or malformed secret, plaintext and damaged values', async () => {
    expect(await importCredentialKey(undefined)).toBeNull();
    expect(await importCredentialKey('ab'.repeat(31))).toBeNull();
    expect(await importCredentialKey('zz'.repeat(32))).toBeNull();
    const key = await importCredentialKey(SECRET);
    if (key === null) throw new Error('no key');
    expect(isSealed('plain-token')).toBe(false);
    expect(await openCredential(key, 'todoist_api_key', 'plain-token')).toBeNull();
    expect(await openCredential(key, 'todoist_api_key', null)).toBeNull();
    expect(await openCredential(key, 'todoist_api_key', 'v1.AAAA.BBBB')).toBeNull();
    expect(await openCredential(key, 'todoist_api_key', 'v1.!!.??')).toBeNull();
  });
});
