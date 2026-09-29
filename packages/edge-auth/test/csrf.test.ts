import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CSRF_HEADER,
  CSRF_MAX_TOKEN_CHARS,
  deriveHmacKeyHkdf,
  importHmacKeyHex,
  issueCsrf,
  signClaims,
  verifyCsrf,
  type CsrfPolicy,
} from '../src/index.ts';
import { b64url, NOW, text } from './helpers.ts';

/** SPEC.md §3.1: minted at bf7a769 by each app's code, exp = 4102444800 (2100-01-01). */
const GOLDEN = {
  mailHero:
    'eyJraW5kIjoiY3NyZiIsIm93bmVyIjoib3duZXJAZXhhbXBsZS5vcmciLCJub25jZSI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImV4cCI6NDEwMjQ0NDgwMH0.PsGfEZ9TSpWDV8E-z6nAAyrq-o4zpAHqNtPXxFlC1ac',
  todofy:
    'eyJraW5kIjoiY3NyZiIsIm93bmVyIjoib3duZXJAZXhhbXBsZS5jb20iLCJub25jZSI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUEiLCJleHAiOjQxMDI0NDQ4MDB9.lfoeE-7aIjGjl7ay6lmgyn7btoKqiKIVBGkUjvNu65g',
  todofyPython:
    'eyJraW5kIjogImNzcmYiLCAib3duZXIiOiAib3duZXJAZXhhbXBsZS5jb20iLCAibm9uY2UiOiAidGVzdCIsICJleHAiOiA0MTAyNDQ0ODAwfQ.idEgvgFniPRSJdv7P7EcsU0evUgyoX35jRlO6dor7zA',
} as const;
const GOLDEN_EXP = 4_102_444_800;

const MH_OWNER = 'owner@example.org';
const MH_URL = 'https://mail.example.org/api/v1/settings';
const MH_ORIGIN = 'https://mail.example.org';
const TF_OWNER = 'owner@example.com';
const TF_URL = 'https://todofy.example.com/api/v1/reconcile';
const TF_ORIGIN = 'https://todofy.example.com';

let mailHeroKey: CryptoKey;
let todofyKey: CryptoKey;
let otherKey: CryptoKey;

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

beforeAll(async () => {
  // Mail Hero: HKDF-SHA-256 from CREDENTIAL_KEY, salt "mail-hero", info "tokens-v1".
  mailHeroKey = await deriveHmacKeyHkdf(hexBytes('12'.repeat(32)), 'mail-hero', 'tokens-v1');
  // Todofy: CSRF_SIGNING_KEY imported raw, usage ['sign'] only.
  const tf = await importHmacKeyHex('ab'.repeat(32));
  const other = await importHmacKeyHex('11'.repeat(32));
  if (tf === null || other === null) throw new Error('fixture keys');
  todofyKey = tf;
  otherKey = other;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Mail Hero's adapter: lazy HKDF key, UUID nonce, the request URL's own origin. */
function mailHero(overrides: Partial<CsrfPolicy> = {}, url = MH_URL): CsrfPolicy {
  return {
    cookieName: 'mail_hero_csrf',
    key: () => Promise.resolve(mailHeroKey),
    nonce: () => crypto.randomUUID(),
    allowedOrigins: [new URL(url).origin],
    ...overrides,
  };
}

/** Todofy's adapter: key resolved before the call, default nonce, the public host (+ dev origin). */
function todofy(overrides: Partial<CsrfPolicy> = {}): CsrfPolicy {
  return { cookieName: 'todofy_csrf', key: todofyKey, allowedOrigins: [TF_ORIGIN], ...overrides };
}

function write(url: string, headers: Record<string, string>): Request {
  return new Request(url, { method: 'POST', headers });
}

const mhWrite = (token: string, origin = MH_ORIGIN, cookie = `mail_hero_csrf=${token}`): Request =>
  write(MH_URL, { origin, [CSRF_HEADER]: token, cookie });
const tfWrite = (token: string, origin = TF_ORIGIN, cookie = `todofy_csrf=${token}`): Request =>
  write(TF_URL, { origin, 'x-csrf-token': token, cookie });

/** A token signed like the apps sign theirs, with any claims (or raw payload text). */
async function mint(key: CryptoKey, claims: Record<string, unknown>, raw?: string): Promise<string> {
  if (raw === undefined) return signClaims(key, claims);
  const payload = b64url(text(raw));
  const signature = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, text(payload))));
  return `${payload}.${signature}`;
}

const tfClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'csrf',
  owner: TF_OWNER,
  nonce: 'test',
  exp: NOW + 600,
  ...overrides,
});
const mhClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => tfClaims({ owner: MH_OWNER, nonce: crypto.randomUUID(), ...overrides });

const OK = { ok: true } as const;
const failed = (failure: 'origin' | 'token' | 'key_unavailable') => ({ ok: false, failure }) as const;

describe('golden vectors (tokens already in browsers stay valid)', () => {
  it('accepts the Mail Hero vector with the HKDF-derived key', async () => {
    expect(await verifyCsrf(mhWrite(GOLDEN.mailHero), MH_OWNER, mailHero())).toEqual(OK);
  });

  it('accepts both Todofy vectors, including the old core’s Python json.dumps spacing', async () => {
    expect(await verifyCsrf(tfWrite(GOLDEN.todofy), TF_OWNER, todofy())).toEqual(OK);
    expect(await verifyCsrf(tfWrite(GOLDEN.todofyPython), TF_OWNER, todofy())).toEqual(OK);
  });

  it('accepts the Todofy vectors with an uppercase-hex key (same bytes)', async () => {
    const upper = await importHmacKeyHex('AB'.repeat(32));
    expect(upper).not.toBeNull();
    if (upper === null) return;
    expect(await verifyCsrf(tfWrite(GOLDEN.todofy), TF_OWNER, todofy({ key: upper }))).toEqual(OK);
  });

  it('re-issues each vector byte for byte from the same inputs', async () => {
    vi.setSystemTime((GOLDEN_EXP - 43_200) * 1000 + 999);
    const mh = await issueCsrf(new Request(MH_URL), MH_OWNER, mailHero({ nonce: () => '00000000-0000-4000-8000-000000000000' }));
    expect(mh.token).toBe(GOLDEN.mailHero);
    const tf = await issueCsrf(new Request(TF_URL), TF_OWNER, todofy({ nonce: () => 'A'.repeat(22) }));
    expect(tf.token).toBe(GOLDEN.todofy);
  });

  it('refuses the vectors under the other app’s key, owner or cookie', async () => {
    expect(await verifyCsrf(mhWrite(GOLDEN.mailHero), MH_OWNER, mailHero({ key: todofyKey }))).toEqual(failed('token'));
    expect(await verifyCsrf(tfWrite(GOLDEN.todofy), TF_OWNER, todofy({ key: mailHeroKey }))).toEqual(failed('token'));
    expect(await verifyCsrf(tfWrite(GOLDEN.todofy), MH_OWNER, todofy())).toEqual(failed('token'));
    const crossCookie = write(TF_URL, { origin: TF_ORIGIN, 'x-csrf-token': GOLDEN.todofy, cookie: `mail_hero_csrf=${GOLDEN.todofy}` });
    expect(await verifyCsrf(crossCookie, TF_OWNER, todofy())).toEqual(failed('token'));
  });
});

describe('issueCsrf', () => {
  it('issues Mail Hero’s token format: UUID nonce, 12 hour exp, its cookie', async () => {
    const { token, setCookie } = await issueCsrf(new Request(MH_URL), MH_OWNER, mailHero());
    const [payload = ''] = token.split('.');
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    expect(Object.keys(claims)).toEqual(['kind', 'owner', 'nonce', 'exp']);
    expect(claims).toMatchObject({ kind: 'csrf', owner: MH_OWNER, exp: NOW + 43_200 });
    expect(claims.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(setCookie).toBe(`mail_hero_csrf=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure`);
    expect(await verifyCsrf(mhWrite(token), MH_OWNER, mailHero())).toEqual(OK);
  });

  it('issues Todofy’s token format: 22-character base64url nonce, its cookie', async () => {
    const { token, setCookie } = await issueCsrf(new Request(TF_URL), TF_OWNER, todofy());
    const [payload = '', signature = ''] = token.split('.');
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    expect(claims).toMatchObject({ kind: 'csrf', owner: TF_OWNER, exp: NOW + 43_200 });
    expect(claims.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie).toBe(`todofy_csrf=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure`);
    expect(await verifyCsrf(tfWrite(token), TF_OWNER, todofy())).toEqual(OK);
  });

  it('draws a fresh nonce for every token', async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 20; i++) tokens.add((await issueCsrf(new Request(TF_URL), TF_OWNER, todofy())).token);
    expect(tokens.size).toBe(20);
  });

  it('adds Secure only for an https: request URL', async () => {
    const local = await issueCsrf(new Request('http://127.0.0.1:8787/api/v1/csrf'), 'local-development', mailHero());
    expect(local.setCookie).toBe(`mail_hero_csrf=${local.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
    const dev = await issueCsrf(new Request('http://todofy.localhost:8787/api/v1/csrf'), TF_OWNER, todofy());
    expect(dev.setCookie.endsWith('Max-Age=43200')).toBe(true);
  });

  it('uses a custom TTL for exp and Max-Age', async () => {
    const { token, setCookie } = await issueCsrf(new Request(TF_URL), TF_OWNER, todofy({ ttlSeconds: 60 }));
    expect(setCookie).toContain('; Max-Age=60;');
    expect(await verifyCsrf(tfWrite(token), TF_OWNER, todofy())).toEqual(OK);
    vi.setSystemTime((NOW + 60) * 1000);
    expect(await verifyCsrf(tfWrite(token), TF_OWNER, todofy())).toEqual(failed('token'));
  });

  it('lets a key error propagate (Mail Hero answers 503 service_unavailable)', async () => {
    const broken = mailHero({ key: () => Promise.reject(new Error('credential_key_not_configured')) });
    await expect(issueCsrf(new Request(MH_URL), MH_OWNER, broken)).rejects.toThrow('credential_key_not_configured');
    const throwing = mailHero({
      key: () => {
        throw new Error('credential_key_not_configured');
      },
    });
    await expect(issueCsrf(new Request(MH_URL), MH_OWNER, throwing)).rejects.toThrow('credential_key_not_configured');
  });

  it('never issues a token longer than verifyCsrf accepts', async () => {
    await expect(issueCsrf(new Request(TF_URL), `${'a'.repeat(1000)}@example.com`, todofy())).rejects.toThrow(/too long/);
    const longest = `${'a'.repeat(242)}@example.com`; // 254 characters, the longest email address
    const { token } = await issueCsrf(new Request(MH_URL), longest, mailHero());
    expect(token.length).toBeLessThanOrEqual(CSRF_MAX_TOKEN_CHARS);
    expect(await verifyCsrf(mhWrite(token), longest, mailHero())).toEqual(OK);
    expect(GOLDEN.mailHero.length).toBeLessThan(200);
  });

  it('refuses an invalid cookie name, TTL or nonce', async () => {
    for (const cookieName of ['', 'a b', 'a;b', 'a=b', 'a,b', 'ä']) {
      await expect(issueCsrf(new Request(TF_URL), TF_OWNER, todofy({ cookieName })), cookieName).rejects.toThrow(TypeError);
      await expect(verifyCsrf(tfWrite(GOLDEN.todofy), TF_OWNER, todofy({ cookieName })), cookieName).rejects.toThrow(TypeError);
    }
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN, 31 * 86_400]) {
      await expect(issueCsrf(new Request(TF_URL), TF_OWNER, todofy({ ttlSeconds })), String(ttlSeconds)).rejects.toThrow(TypeError);
    }
    await expect(issueCsrf(new Request(TF_URL), TF_OWNER, todofy({ nonce: () => 7 as never }))).rejects.toThrow(TypeError);
  });
});

describe('verifyCsrf', () => {
  it('checks the Origin case-insensitively against the allowed list', async () => {
    const token = await mint(todofyKey, tfClaims());
    expect(await verifyCsrf(tfWrite(token, 'HTTPS://TODOFY.EXAMPLE.COM'), TF_OWNER, todofy())).toEqual(OK);
    expect(await verifyCsrf(tfWrite(token, TF_ORIGIN), TF_OWNER, todofy({ allowedOrigins: ['HTTPS://todofy.example.com'] }))).toEqual(OK);
    const dev = todofy({ allowedOrigins: ['https://todofy.localhost', 'http://todofy.localhost:8787'] });
    expect(await verifyCsrf(tfWrite(token, 'http://todofy.localhost:8787'), TF_OWNER, dev)).toEqual(OK);
  });

  it('refuses a missing, foreign or look-alike Origin before looking at the token', async () => {
    const token = await mint(todofyKey, tfClaims());
    const origins: (string | null)[] = [
      null,
      '',
      'null',
      'https://evil.example',
      'http://todofy.example.com',
      'https://todofy.example.com:8443',
      'https://todofy.example.com.evil.example',
      `${TF_ORIGIN}/`,
      'https://sub.todofy.example.com',
    ];
    for (const origin of origins) {
      const headers: Record<string, string> = { 'x-csrf-token': token, cookie: `todofy_csrf=${token}` };
      if (origin !== null) headers.origin = origin;
      expect(await verifyCsrf(write(TF_URL, headers), TF_OWNER, todofy()), String(origin)).toEqual(failed('origin'));
    }
    expect(await verifyCsrf(tfWrite(token, ''), TF_OWNER, todofy({ allowedOrigins: [''] }))).toEqual(failed('origin'));
    expect(await verifyCsrf(tfWrite(token), TF_OWNER, todofy({ allowedOrigins: [] }))).toEqual(failed('origin'));
  });

  it('uses Mail Hero’s request-URL origin: a write to another host or port is refused', async () => {
    const token = await mint(mailHeroKey, mhClaims());
    const request = write('http://localhost:8787/api/v1/settings', { origin: 'http://localhost:9999', 'x-csrf-token': token, cookie: `mail_hero_csrf=${token}` });
    expect(await verifyCsrf(request, MH_OWNER, mailHero({}, request.url))).toEqual(failed('origin'));
    const same = write('http://localhost:8787/api/v1/settings', { origin: 'http://localhost:8787', 'x-csrf-token': token, cookie: `mail_hero_csrf=${token}` });
    expect(await verifyCsrf(same, MH_OWNER, mailHero({}, same.url))).toEqual(OK);
  });

  it('requires the header to equal the first cookie', async () => {
    const token = await mint(todofyKey, tfClaims());
    const other = await mint(todofyKey, tfClaims({ nonce: 'other' }));
    const cases: Record<string, Record<string, string>> = {
      'no header': { origin: TF_ORIGIN, cookie: `todofy_csrf=${token}` },
      'empty header': { origin: TF_ORIGIN, 'x-csrf-token': '', cookie: `todofy_csrf=${token}` },
      'no cookie': { origin: TF_ORIGIN, 'x-csrf-token': token },
      'empty cookie': { origin: TF_ORIGIN, 'x-csrf-token': token, cookie: 'todofy_csrf=' },
      'other cookie name': { origin: TF_ORIGIN, 'x-csrf-token': token, cookie: `mail_hero_csrf=${token}` },
      'header differs from cookie': { origin: TF_ORIGIN, 'x-csrf-token': token, cookie: `todofy_csrf=${other}` },
      'first cookie wins': { origin: TF_ORIGIN, 'x-csrf-token': token, cookie: `todofy_csrf=${other}; todofy_csrf=${token}` },
      'cookie with a suffix': { origin: TF_ORIGIN, 'x-csrf-token': token, cookie: `todofy_csrf=${token}x` },
    };
    for (const [name, headers] of Object.entries(cases)) {
      expect(await verifyCsrf(write(TF_URL, headers), TF_OWNER, todofy()), name).toEqual(failed('token'));
    }
    const firstMatches = write(TF_URL, { origin: TF_ORIGIN, 'x-csrf-token': token, cookie: `a=1; todofy_csrf=${token}; todofy_csrf=${other}` });
    expect(await verifyCsrf(firstMatches, TF_OWNER, todofy())).toEqual(OK);
  });

  it('refuses a token over 1024 characters, even one both sides agree on', async () => {
    const token = await mint(todofyKey, tfClaims());
    const long = `${token}${'a'.repeat(CSRF_MAX_TOKEN_CHARS + 1 - token.length)}`;
    expect(long.length).toBe(1025);
    expect(await verifyCsrf(tfWrite(long), TF_OWNER, todofy())).toEqual(failed('token'));
    const signedLong = await mint(todofyKey, tfClaims({ nonce: 'n'.repeat(900) }));
    expect(signedLong.length).toBeGreaterThan(CSRF_MAX_TOKEN_CHARS);
    expect(await verifyCsrf(tfWrite(signedLong), TF_OWNER, todofy())).toEqual(failed('token'));
    const signedFits = await mint(todofyKey, tfClaims({ nonce: 'n'.repeat(600) }));
    expect(signedFits.length).toBeLessThanOrEqual(CSRF_MAX_TOKEN_CHARS);
    expect(await verifyCsrf(tfWrite(signedFits), TF_OWNER, todofy())).toEqual(OK);
  });

  it('refuses every forged, tampered or wrong token (both apps’ test cases)', async () => {
    const valid = await mint(todofyKey, tfClaims());
    const [payload = '', signature = ''] = valid.split('.');
    const flip = (s: string, i: number): string => `${s.slice(0, i)}${s[i] === 'A' ? 'B' : 'A'}${s.slice(i + 1)}`;
    const cases: Record<string, string> = {
      'no signature': payload,
      'empty signature': `${payload}.`,
      'signature only': `.${signature}`,
      'tampered signature': `${payload}.${flip(signature, 5)}`,
      'truncated signature': `${payload}.${signature.slice(0, -1)}`,
      'padded signature': `${payload}.${signature}=`,
      'standard base64 signature': `${payload}.${btoa(atob(signature.replace(/-/g, '+').replace(/_/g, '/')))}`,
      'tampered payload': `${flip(payload, 12)}.${signature}`,
      'extra part': `${valid}.x`,
      'signed with another key': await mint(otherKey, tfClaims()),
      'signed with the other app’s key': await mint(mailHeroKey, tfClaims()),
      expired: await mint(todofyKey, tfClaims({ exp: 1 })),
      'expires now': await mint(todofyKey, tfClaims({ exp: NOW })),
      'another owner': await mint(todofyKey, tfClaims({ owner: 'owner.alias@example.net' })),
      'owner in another case': await mint(todofyKey, tfClaims({ owner: TF_OWNER.toUpperCase() })),
      'no owner': await mint(todofyKey, tfClaims({ owner: undefined })),
      'not a csrf token': await mint(todofyKey, tfClaims({ kind: 'confirm' })),
      'Mail Hero preview token kind': await mint(todofyKey, tfClaims({ kind: 'retention' })),
      'no kind': await mint(todofyKey, tfClaims({ kind: undefined })),
      'fractional exp': await mint(todofyKey, tfClaims({ exp: NOW + 600.5 })),
      'string exp': await mint(todofyKey, tfClaims({ exp: String(NOW + 600) })),
      'no exp': await mint(todofyKey, tfClaims({ exp: undefined })),
      'signed garbage': await mint(todofyKey, {}, 'not json'),
      'signed array': await mint(todofyKey, {}, '["csrf"]'),
      'signed null': await mint(todofyKey, {}, 'null'),
      'signed infinite exp': await mint(todofyKey, {}, `{"kind":"csrf","owner":"${TF_OWNER}","nonce":"x","exp":1e999}`),
    };
    for (const [name, token] of Object.entries(cases)) {
      expect(await verifyCsrf(tfWrite(token), TF_OWNER, todofy()), name).toEqual(failed('token'));
    }
  });

  it('refuses a non-canonical signature that decodes to the same bytes', async () => {
    // 32 HMAC bytes → 43 base64url characters; the last one carries 4 padding bits.
    const valid = await mint(todofyKey, tfClaims());
    const [payload = '', signature = ''] = valid.split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(signature.at(-1) ?? 'A');
    const twin = `${signature.slice(0, -1)}${alphabet[last ^ 1] ?? 'A'}`;
    expect(twin).not.toBe(signature);
    expect(atob(twin.replace(/-/g, '+').replace(/_/g, '/'))).toBe(atob(signature.replace(/-/g, '+').replace(/_/g, '/')));
    expect(await verifyCsrf(tfWrite(`${payload}.${twin}`), TF_OWNER, todofy())).toEqual(failed('token'));
  });

  it('refuses a signed, otherwise valid payload with invalid UTF-8 in a string (fatal decoding)', async () => {
    const before = text(`{"kind":"csrf","owner":"${TF_OWNER}","nonce":"`);
    const after = text(`","exp":${String(NOW + 600)}}`);
    const bytes = new Uint8Array([...before, 0xff, 0xfe, ...after]);
    const payload = b64url(bytes);
    const signature = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', todofyKey, text(payload))));
    expect(await verifyCsrf(tfWrite(`${payload}.${signature}`), TF_OWNER, todofy())).toEqual(failed('token'));
    // The same bytes with a valid nonce verify, so only the invalid UTF-8 is refused.
    const clean = b64url(new Uint8Array([...before, 0x78, ...after]));
    const cleanSignature = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', todofyKey, text(clean))));
    expect(await verifyCsrf(tfWrite(`${clean}.${cleanSignature}`), TF_OWNER, todofy())).toEqual(OK);
  });

  it('refuses a signed payload that is not UTF-8', async () => {
    const payload = b64url(new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]));
    const signature = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', todofyKey, text(payload))));
    expect(await verifyCsrf(tfWrite(`${payload}.${signature}`), TF_OWNER, todofy())).toEqual(failed('token'));
  });

  it('expires at exp: valid one second before, refused at exp', async () => {
    const token = await mint(mailHeroKey, mhClaims({ exp: NOW + 10 }));
    vi.setSystemTime((NOW + 9) * 1000 + 999);
    expect(await verifyCsrf(mhWrite(token), MH_OWNER, mailHero())).toEqual(OK);
    vi.setSystemTime((NOW + 10) * 1000);
    expect(await verifyCsrf(mhWrite(token), MH_OWNER, mailHero())).toEqual(failed('token'));
  });

  it('binds the token to the authenticated owner (Mail Hero dev principal included)', async () => {
    const dev = await issueCsrf(new Request('http://127.0.0.1:8787/api/v1/csrf'), 'local-development', mailHero({}, 'http://127.0.0.1:8787/'));
    const request = write('http://127.0.0.1:8787/api/v1/settings', {
      origin: 'http://127.0.0.1:8787',
      'x-csrf-token': dev.token,
      cookie: `mail_hero_csrf=${dev.token}`,
    });
    expect(await verifyCsrf(request, 'local-development', mailHero({}, request.url))).toEqual(OK);
    expect(await verifyCsrf(request, MH_OWNER, mailHero({}, request.url))).toEqual(failed('token'));
  });

  it('works with a sign-only key (Todofy) and a sign+verify key (Mail Hero)', async () => {
    expect(todofyKey.usages).toEqual(['sign']);
    expect([...mailHeroKey.usages].sort()).toEqual(['sign', 'verify']);
    const tf = await issueCsrf(new Request(TF_URL), TF_OWNER, todofy());
    const mh = await issueCsrf(new Request(MH_URL), MH_OWNER, mailHero());
    expect(await verifyCsrf(tfWrite(tf.token), TF_OWNER, todofy())).toEqual(OK);
    expect(await verifyCsrf(mhWrite(mh.token), MH_OWNER, mailHero())).toEqual(OK);
  });

  it('refuses when the key cannot sign', async () => {
    const verifyOnly = await crypto.subtle.importKey('raw', hexBytes('ab'.repeat(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    expect(await verifyCsrf(tfWrite(GOLDEN.todofy), TF_OWNER, todofy({ key: verifyOnly }))).toEqual(failed('token'));
  });
});

describe('key_unavailable ordering (Mail Hero’s lazy key)', () => {
  it('resolves the key only after the Origin, header and cookie checks pass', async () => {
    const key = vi.fn(() => Promise.reject(new Error('credential_key_not_configured')));
    const token = GOLDEN.mailHero;
    expect(await verifyCsrf(mhWrite(token, 'https://evil.example'), MH_OWNER, mailHero({ key }))).toEqual(failed('origin'));
    expect(await verifyCsrf(write(MH_URL, { origin: MH_ORIGIN, cookie: `mail_hero_csrf=${token}` }), MH_OWNER, mailHero({ key }))).toEqual(
      failed('token'),
    );
    expect(await verifyCsrf(mhWrite(token, MH_ORIGIN, 'mail_hero_csrf=other'), MH_OWNER, mailHero({ key }))).toEqual(failed('token'));
    expect(key).not.toHaveBeenCalled();
    expect(await verifyCsrf(mhWrite(token), MH_OWNER, mailHero({ key }))).toEqual(failed('key_unavailable'));
    expect(key).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversize token (header equal to cookie) before resolving the key', async () => {
    const key = vi.fn(() => Promise.reject(new Error('credential_key_not_configured')));
    const long = `${GOLDEN.mailHero}${'a'.repeat(CSRF_MAX_TOKEN_CHARS + 1 - GOLDEN.mailHero.length)}`;
    expect(await verifyCsrf(mhWrite(long), MH_OWNER, mailHero({ key }))).toEqual(failed('token'));
    expect(key).not.toHaveBeenCalled();
  });

  it('reports key_unavailable for a key function that throws synchronously', async () => {
    const key = (): Promise<CryptoKey> => {
      throw new Error('credential_key_not_configured');
    };
    expect(await verifyCsrf(mhWrite(GOLDEN.mailHero), MH_OWNER, mailHero({ key }))).toEqual(failed('key_unavailable'));
  });
});
