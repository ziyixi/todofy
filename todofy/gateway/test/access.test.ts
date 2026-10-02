import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { fakes, statusReason, uiOk, type Vars } from './helpers.ts';

const ISSUER = 'https://team-name.cloudflareaccess.com';
const AUDIENCE = 'aud-1';
const HOST = 'todofy.example.com';
const ALIAS = 'owner.alias@example.net';
const RS256 = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const encodeJson = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

let issuerKey: CryptoKeyPair;
let foreignKey: CryptoKeyPair;
let jwks: Record<string, unknown>[];

async function publicJwk(pair: CryptoKeyPair, kid: string): Promise<Record<string, unknown>> {
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { ...(jwk as JsonWebKey), kid, alg: 'RS256', use: 'sig' };
}

beforeAll(async () => {
  issuerKey = (await crypto.subtle.generateKey(RS256, true, ['sign', 'verify'])) as CryptoKeyPair;
  foreignKey = (await crypto.subtle.generateKey(RS256, true, ['sign', 'verify'])) as CryptoKeyPair;
});

interface TokenOptions {
  readonly key?: CryptoKeyPair;
  readonly header?: Record<string, unknown>;
  readonly claims?: Record<string, unknown>;
}

async function token({ key = issuerKey, header = {}, claims = {} }: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: ISSUER, aud: [AUDIENCE], email: 'owner@example.com', sub: 'owner-id', iat: now, exp: now + 600, ...claims };
  const signingInput = `${encodeJson({ alg: 'RS256', kid: 'test-key', typ: 'JWT', ...header })}.${encodeJson(body)}`;
  const signature = await crypto.subtle.sign(RS256.name, key.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

const certs = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function accessVars(extra: Vars = {}): Vars {
  return {
    TODOFY_PUBLIC_HOST: HOST,
    ACCESS_ISSUER: `${ISSUER}/`,
    ACCESS_AUDIENCE: AUDIENCE,
    ACCESS_OWNER: ' Owner@Example.com ',
    ACCESS_OWNER_ALIASES: `${ALIAS.toUpperCase()}, other.login@example.org`,
    DEV_AUTH_BYPASS: undefined,
    ...extra,
  };
}

/** A request through a fresh module graph, so every test starts with an empty key cache. */
async function send(env: Env, headers: Record<string, string> = {}, path = '/', host = HOST): Promise<Response> {
  const { default: worker } = await import('../src/index.ts');
  const request = new Request(`https://${host}${path}`, { headers });
  return worker.fetch(request as never, env);
}

async function status(env: Env, jwt: string | null, extra: Record<string, string> = {}): Promise<number> {
  return (await send(env, { ...(jwt === null ? {} : { 'cf-access-jwt-assertion': jwt }), ...extra })).status;
}

beforeEach(async () => {
  vi.resetModules();
  jwks = [await publicJwk(issuerKey, 'test-key')];
  certs.mockReset();
  certs.mockImplementation(() => Promise.resolve(Response.json({ keys: jwks })));
  vi.stubGlobal('fetch', certs);
});

describe('Access JWT', () => {
  it('accepts a valid RS256 token from the header or the last CF_Authorization cookie', async () => {
    const { env, assets } = fakes(accessVars());
    expect(await status(env, await token())).toBe(200);
    const cookie = `CF_Authorization=stale; theme=dark; CF_Authorization=${await token()}`;
    expect(await status(env, null, { cookie })).toBe(200);
    expect(await status(env, '', { cookie })).toBe(200);
    expect(await status(env, await token({ claims: { email: 'OWNER@example.com', aud: AUDIENCE } }))).toBe(200);
    expect(await status(env, await token({ claims: { nbf: Math.floor(Date.now() / 1000) } }))).toBe(200);
    expect(assets).toHaveLength(5);
    expect(certs).toHaveBeenCalledTimes(1);
    expect(certs.mock.calls[0]?.[0]).toBe(`${ISSUER}/cdn-cgi/access/certs`);
  });

  it('maps an alias login to the canonical owner', async () => {
    const { env, core } = fakes(accessVars(), () => uiOk({ name: 'serviceStatus' }));
    const response = await send(env, { 'cf-access-jwt-assertion': await token({ claims: { email: ALIAS } }) }, '/api/v1/serviceStatus');
    expect(response.status).toBe(200);
    expect(core[0]?.args[0]).toBe('owner@example.com');
  });

  it('rejects every invalid token with 401 before touching assets or the core', async () => {
    // Frozen clock: 'issued in the future' sits exactly on the 60 s iat bound, which a second
    // boundary between signing and verifying would otherwise move (then the token is accepted).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { env, core, assets } = fakes(accessVars());
    const now = Math.floor(Date.now() / 1000);
    const valid = await token();
    const rejected: Record<string, string | null> = {
      missing: null,
      garbage: 'not-a-jwt',
      'two parts': valid.split('.').slice(0, 2).join('.'),
      'four parts': `${valid}.x`,
      'bad base64': `${valid.slice(0, 5)}*${valid.slice(6)}`,
      'too long': `${valid}${'a'.repeat(16_001 - valid.length)}`,
      'foreign key': await token({ key: foreignKey }),
      'tampered claims': `${valid.split('.')[0] ?? ''}.${encodeJson({ email: 'owner@example.com' })}.${valid.split('.')[2] ?? ''}`,
      'wrong audience': await token({ claims: { aud: ['someone-else'] } }),
      'wrong issuer': await token({ claims: { iss: 'https://evil.cloudflareaccess.com' } }),
      expired: await token({ claims: { exp: now } }),
      'string exp': await token({ claims: { exp: String(now + 600) } }),
      'issued in the future': await token({ claims: { iat: now + 60 } }),
      'no iat': await token({ claims: { iat: undefined } }),
      'not yet valid': await token({ claims: { nbf: now + 3600 } }),
      'string nbf': await token({ claims: { nbf: 'x' } }),
      'no sub': await token({ claims: { sub: undefined } }),
      'empty sub': await token({ claims: { sub: '' } }),
      'not the owner': await token({ claims: { email: 'intruder@example.com' } }),
      'no email': await token({ claims: { email: undefined } }),
      'wrong algorithm': await token({ header: { alg: 'RS512' } }),
      'no algorithm': await token({ header: { alg: 'none' } }),
      'numeric kid': await token({ header: { kid: 7 } }),
      'unknown kid': await token({ header: { kid: 'other' } }),
      'array header': `${encodeJson(['RS256'])}.${valid.split('.').slice(1).join('.')}`,
    };
    for (const [name, jwt] of Object.entries(rejected)) {
      const response = await send(env, jwt === null ? {} : { 'cf-access-jwt-assertion': jwt });
      expect(response.status, name).toBe(401);
      expect(await statusReason(response), name).toBe('UNAUTHORIZED');
      expect(response.headers.get('x-frame-options'), name).toBe('DENY');
    }
    expect(core).toHaveLength(0);
    expect(assets).toHaveLength(0);
  });

  it('fails closed with 503 access_not_configured on incomplete configuration', async () => {
    const cases: Record<string, Vars> = {
      'no issuer': { ACCESS_ISSUER: undefined },
      'plain http issuer': { ACCESS_ISSUER: 'http://team-name.cloudflareaccess.com' },
      'other domain': { ACCESS_ISSUER: 'https://team.cloudflareaccess.com.evil.example' },
      'loopback outside local dev': { ACCESS_ISSUER: 'http://127.0.0.1:9000', DEV_ACCESS_LOOPBACK_ISSUER: 'true' },
      'no audience': { ACCESS_AUDIENCE: ' ' },
      'no owner': { ACCESS_OWNER: undefined },
      'nine aliases': { ACCESS_OWNER_ALIASES: Array.from({ length: 9 }, (_, i) => `a${String(i)}@example.com`).join(',') },
      'aliases too long': { ACCESS_OWNER_ALIASES: `${'a'.repeat(2040)}@example.com` },
      'non-ASCII owner': { ACCESS_OWNER: '\u212Aate@example.com' },
      'non-ASCII alias': { ACCESS_OWNER_ALIASES: 'kim@example.net, \u212Aim@example.net' },
    };
    for (const [name, vars] of Object.entries(cases)) {
      const { env } = fakes(accessVars(vars));
      const response = await send(env, { 'cf-access-jwt-assertion': await token() });
      expect(response.status, name).toBe(503);
      expect(await statusReason(response), name).toBe('ACCESS_NOT_CONFIGURED');
    }
    expect(certs).not.toHaveBeenCalled();
  });

  it('allows eight aliases and a loopback issuer only for a *.localhost public host', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => `a${String(i)}@example.com`).join(',');
    const { env } = fakes(accessVars({ ACCESS_OWNER_ALIASES: eight }));
    expect(await status(env, await token())).toBe(200);

    const loopback = 'http://127.0.0.1:9000';
    const local = fakes(accessVars({ TODOFY_PUBLIC_HOST: 'todofy.localhost', ACCESS_ISSUER: loopback, DEV_ACCESS_LOOPBACK_ISSUER: 'true' }));
    const response = await send(local.env, { 'cf-access-jwt-assertion': await token({ claims: { iss: loopback } }) }, '/', 'todofy.localhost');
    expect(response.status).toBe(200);
    expect(certs).toHaveBeenLastCalledWith(`${loopback}/cdn-cgi/access/certs`, expect.anything());
  });

  it('matches the owner case-insensitively for ASCII only: a Kelvin-sign login is not the owner', async () => {
    // U+212A KELVIN SIGN lowercases to ASCII 'k' with String.prototype.toLowerCase.
    const { env, core } = fakes(accessVars({ ACCESS_OWNER: ' Kate@Example.com ', ACCESS_OWNER_ALIASES: 'kim@example.net' }), () => uiOk({ name: 'serviceStatus' }));
    for (const email of ['\u212Aate@example.com', '\u212AATE@EXAMPLE.COM', '\u212Aim@example.net']) {
      const response = await send(env, { 'cf-access-jwt-assertion': await token({ claims: { email } }) });
      expect(response.status, email).toBe(401);
      expect(await statusReason(response), email).toBe('UNAUTHORIZED');
    }
    expect(core).toHaveLength(0);
    for (const email of ['KATE@example.com', 'Kim@Example.NET']) {
      const response = await send(env, { 'cf-access-jwt-assertion': await token({ claims: { email } }) }, '/api/v1/serviceStatus');
      expect(response.status, email).toBe(200);
    }
    expect(core.map((call) => call.args[0])).toEqual(['kate@example.com', 'kate@example.com']);
  });

  it('bypasses Access only in local dev and never for a request that came through the edge', async () => {
    const local = fakes({ DEV_AUTH_BYPASS: 'true', ACCESS_OWNER: 'Owner@Example.com' }, () => uiOk({ name: 'serviceStatus' }));
    const response = await send(local.env, {}, '/api/v1/serviceStatus', 'todofy.localhost');
    expect(response.status).toBe(200);
    expect(local.core[0]?.args[0]).toBe('owner@example.com');

    // The bypass principal uses the verifier's ASCII-only fold: a Kelvin sign is not turned into 'k'.
    const kelvin = fakes({ DEV_AUTH_BYPASS: 'true', ACCESS_OWNER: '\u212AATE@Example.com' }, () => uiOk({ name: 'serviceStatus' }));
    expect((await send(kelvin.env, {}, '/api/v1/serviceStatus', 'todofy.localhost')).status).toBe(200);
    expect(kelvin.core[0]?.args[0]).toBe('\u212Aate@example.com');

    const edge = await send(local.env, { 'cf-ray': '8f1c2d3e4f5a6b7c-SJC' }, '/', 'todofy.localhost');
    expect(edge.status).toBe(503);
    expect(await statusReason(edge)).toBe('ACCESS_NOT_CONFIGURED');

    const production = fakes(accessVars({ DEV_AUTH_BYPASS: 'true' }));
    expect(await status(production.env, null)).toBe(401);
  });

  it('answers 503 unavailable when the certs cannot be fetched', async () => {
    const { env } = fakes(accessVars());
    for (const failure of [
      () => Promise.resolve(new Response('nope', { status: 500 })),
      () => Promise.resolve(new Response('not json', { status: 200 })),
      () => Promise.reject(new Error('timeout')),
    ]) {
      vi.resetModules();
      certs.mockImplementationOnce(failure);
      const response = await send(env, { 'cf-access-jwt-assertion': await token() });
      expect(response.status).toBe(503);
      expect(await statusReason(response)).toBe('UNAVAILABLE');
    }
  });

  it('answers 503 unavailable when the certs answer with a redirect, and never follows it', async () => {
    const { env } = fakes(accessVars());
    certs.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example/certs' } })));
    const response = await send(env, { 'cf-access-jwt-assertion': await token() });
    expect(response.status).toBe(503);
    expect(await statusReason(response)).toBe('UNAVAILABLE');
    expect(certs).toHaveBeenCalledTimes(1);
    expect(certs.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses a crit header and keys that are not RS256 signing keys of at least 2048 bits', async () => {
    const small = (await crypto.subtle.generateKey({ ...RS256, modulusLength: 1024 }, true, ['sign', 'verify'])) as CryptoKeyPair;
    jwks = [
      ...jwks,
      await publicJwk(small, 'small'),
      { ...(await publicJwk(foreignKey, 'encryption')), use: 'enc' },
      { ...(await publicJwk(foreignKey, 'rs512')), alg: 'RS512' },
      { ...(await publicJwk(foreignKey, 'sign-only')), key_ops: ['sign'] },
      await publicJwk(foreignKey, 'twice'),
      await publicJwk(foreignKey, 'twice'),
    ];
    const { env } = fakes(accessVars());
    expect(await status(env, await token())).toBe(200);
    const rejected: Record<string, string> = {
      crit: await token({ header: { crit: ['exp'], exp: 1 } }),
      'empty kid': await token({ header: { kid: '' } }),
      '1024-bit key': await token({ key: small, header: { kid: 'small' } }),
      'use enc': await token({ key: foreignKey, header: { kid: 'encryption' } }),
      'alg RS512 key': await token({ key: foreignKey, header: { kid: 'rs512' } }),
      'key_ops without verify': await token({ key: foreignKey, header: { kid: 'sign-only' } }),
      'kid listed twice': await token({ key: foreignKey, header: { kid: 'twice' } }),
    };
    for (const [name, jwt] of Object.entries(rejected)) {
      const response = await send(env, { 'cf-access-jwt-assertion': jwt });
      expect(response.status, name).toBe(401);
      expect(await statusReason(response), name).toBe('UNAUTHORIZED');
    }
  });

  it('accepts the claim edges Todofy has always accepted', async () => {
    const { env } = fakes(accessVars());
    const now = Math.floor(Date.now() / 1000);
    expect(await status(env, await token({ claims: { iat: now + 30 } }))).toBe(200);
    expect(await status(env, await token({ claims: { nbf: now + 30 } }))).toBe(200);
  });

  it('treats any cooldown at or above the hour-long cache as the cache itself', async () => {
    const { env } = fakes(accessVars({ JWKS_REFRESH_COOLDOWN_MS: '99999999999999999999' }));
    expect(await status(env, await token())).toBe(200);
  });

  it('skips keys WebCrypto cannot import', async () => {
    jwks = [{ kty: 'RSA', kid: 'broken', n: 'AA', e: 5 }, { kty: 'EC', kid: 'ec' }, ...jwks];
    const { env } = fakes(accessVars());
    expect(await status(env, await token())).toBe(200);
    expect(await status(env, await token({ header: { kid: 'broken' } }))).toBe(401);
  });
});

describe('signing key cache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches for an unknown kid at most once per cooldown and keeps the old key', async () => {
    const { env } = fakes(accessVars({ JWKS_REFRESH_COOLDOWN_MS: '2000' }));
    const { default: worker } = await import('../src/index.ts');
    const request = async (jwt: string): Promise<number> =>
      (await worker.fetch(new Request(`https://${HOST}/`, { headers: { 'cf-access-jwt-assertion': jwt } }) as never, env)).status;

    for (let i = 0; i < 3; i++) expect(await request(await token())).toBe(200);
    expect(certs).toHaveBeenCalledTimes(1);

    jwks = [await publicJwk(foreignKey, 'rotated-key'), ...jwks];
    const rotated = await token({ key: foreignKey, header: { kid: 'rotated-key' } });
    expect(await request(rotated)).toBe(401); // inside the cooldown: no refetch
    expect(certs).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T12:00:02.500Z'));
    expect(await request(await token({ key: foreignKey, header: { kid: 'rotated-key' } }))).toBe(200);
    expect(await request(await token())).toBe(200);
    expect(await request(await token({ header: { kid: 'unknown-key' } }))).toBe(401);
    expect(certs).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-09-29T13:00:03Z'));
    expect(await request(await token())).toBe(200); // the hour-long cache expired
    expect(certs).toHaveBeenCalledTimes(3);
  });
});
