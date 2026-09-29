import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  deriveHmacKeyHkdf,
  importHmacKeyHex,
  readCookie,
  signClaims,
  SIGNED_TOKEN_MAX_CHARS,
  verifySignedClaims,
} from '../src/index.ts';
import { text } from './helpers.ts';

describe('base64url', () => {
  it('round-trips every byte value, unpadded', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (let length = 0; length <= 5; length++) {
      const slice = bytes.slice(0, 250 + length);
      const encoded = base64UrlEncode(slice);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(base64UrlDecode(encoded)).toEqual(slice);
    }
  });

  it('accepts one or two padding characters and the empty string', () => {
    expect(base64UrlDecode('YQ==')).toEqual(text('a'));
    expect(base64UrlDecode('YWI=')).toEqual(text('ab'));
    expect(base64UrlDecode('YQ')).toEqual(text('a'));
    expect(base64UrlDecode('')).toEqual(new Uint8Array());
    // As Todofy's former decoder: bare padding is the empty string (no JSON segment can use it).
    expect(base64UrlDecode('=')).toEqual(new Uint8Array());
    expect(base64UrlDecode('==')).toEqual(new Uint8Array());
  });

  it('refuses other alphabets, three pads, whitespace and a length of 1 mod 4', () => {
    for (const bad of ['a+b/', 'YQ===', 'Y Q', 'YQ\n', 'A', 'AAAAA', '===', 'Y=Q', 'ä']) {
      expect(base64UrlDecode(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('constantTimeEqual', () => {
  it('compares UTF-8 bytes', () => {
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('é', 'é')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('é', 'e')).toBe(false);
    expect(constantTimeEqual('é', 'é')).toBe(false);
  });
});

describe('readCookie', () => {
  const request = (cookie?: string): Request => new Request('https://x.example/', cookie === undefined ? {} : { headers: { cookie } });

  it('returns the first or last value of an exactly named cookie', () => {
    const r = request(' a=1; CF_Authorization=first ;b=2;CF_Authorization=last');
    expect(readCookie(r, 'CF_Authorization', 'first')).toBe('first');
    expect(readCookie(r, 'CF_Authorization', 'last')).toBe('last');
    expect(readCookie(r, 'a', 'first')).toBe('1');
    expect(readCookie(r, 'cf_authorization', 'first')).toBeNull();
    expect(readCookie(r, 'missing', 'last')).toBeNull();
  });

  it('splits at the first = and keeps an empty value', () => {
    const r = request('t=a=b==; e=');
    expect(readCookie(r, 't', 'first')).toBe('a=b==');
    expect(readCookie(r, 'e', 'first')).toBe('');
  });

  it('ignores pairs without = and an empty name', () => {
    expect(readCookie(request('t; t=v'), 't', 'first')).toBe('v');
    expect(readCookie(request('t=v; t'), 't', 'last')).toBe('v');
    expect(readCookie(request('=v'), '', 'first')).toBeNull();
    expect(readCookie(request(), 't', 'first')).toBeNull();
    expect(readCookie(request(''), 't', 'first')).toBeNull();
  });
});

describe('HMAC keys', () => {
  it('imports exactly 64 hex characters in either case as a sign-only key', async () => {
    const lower = await importHmacKeyHex('ab'.repeat(32));
    const upper = await importHmacKeyHex('AB'.repeat(32));
    expect(lower?.usages).toEqual(['sign']);
    expect(lower?.extractable).toBe(false);
    if (lower === null || upper === null) throw new Error('keys');
    expect(await signClaims(lower, { a: 1 })).toBe(await signClaims(upper, { a: 1 }));
  });

  it('refuses anything else', async () => {
    for (const bad of ['', 'ab'.repeat(31), 'ab'.repeat(33), `${'ab'.repeat(31)}zz`, ` ${'ab'.repeat(32)}`, `${'ab'.repeat(32)}\n`, 7 as never]) {
      expect(await importHmacKeyHex(bad), String(bad).slice(0, 10)).toBeNull();
    }
  });

  it('derives Mail Hero’s HKDF key deterministically, non-extractable, for sign and verify', async () => {
    const ikm = Uint8Array.from({ length: 32 }, () => 0x12);
    const a = await deriveHmacKeyHkdf(ikm, 'mail-hero', 'tokens-v1');
    const b = await deriveHmacKeyHkdf(ikm, 'mail-hero', 'tokens-v1');
    const otherInfo = await deriveHmacKeyHkdf(ikm, 'mail-hero', 'tokens-v2');
    expect(a.extractable).toBe(false);
    expect([...a.usages].sort()).toEqual(['sign', 'verify']);
    expect(a.algorithm).toMatchObject({ name: 'HMAC', hash: { name: 'SHA-256' }, length: 256 });
    expect(await signClaims(a, { x: 1 })).toBe(await signClaims(b, { x: 1 }));
    expect(await signClaims(a, { x: 1 })).not.toBe(await signClaims(otherInfo, { x: 1 }));
  });

  it('matches Mail Hero’s former signingKey derivation byte for byte', async () => {
    const ikm = Uint8Array.from({ length: 32 }, (_, i) => i);
    const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    const former = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: text('mail-hero'), info: text('tokens-v1') },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify'],
    );
    const derived = await deriveHmacKeyHkdf(ikm, 'mail-hero', 'tokens-v1');
    const claims = { kind: 'retention', exp: 4_102_444_800 };
    expect(await signClaims(derived, claims)).toBe(await signClaims(former, claims));
  });
});

describe('signed claims', () => {
  it('round-trips claims and keeps their key order', async () => {
    const key = await importHmacKeyHex('ab'.repeat(32));
    if (key === null) throw new Error('key');
    const token = await signClaims(key, { z: 1, a: 'é', nested: { b: [1, 2] } });
    expect(atob(token.split('.')[0]?.replace(/-/g, '+').replace(/_/g, '/') ?? '')).toBe(
      String.fromCharCode(...new TextEncoder().encode('{"z":1,"a":"é","nested":{"b":[1,2]}}')),
    );
    expect(await verifySignedClaims(key, token)).toEqual({ z: 1, a: 'é', nested: { b: [1, 2] } });
  });

  it('enforces the length cap and the shape', async () => {
    const key = await importHmacKeyHex('ab'.repeat(32));
    if (key === null) throw new Error('key');
    const token = await signClaims(key, { pad: 'x'.repeat(800) });
    expect(token.length).toBeGreaterThan(SIGNED_TOKEN_MAX_CHARS);
    expect(await verifySignedClaims(key, token)).toBeNull();
    expect(await verifySignedClaims(key, token, 4096)).toEqual({ pad: 'x'.repeat(800) });
    expect(await verifySignedClaims(key, '')).toBeNull();
    expect(await verifySignedClaims(key, 'no-dot')).toBeNull();
    expect(await verifySignedClaims(key, 7 as never)).toBeNull();
  });
});
