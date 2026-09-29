import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_MAX_TOKEN_CHARS,
  createAccessVerifier,
  type AccessPolicy,
  type AccessResult,
  type AccessVerifier,
} from '../src/index.ts';
import {
  AUDIENCE,
  b64url,
  baseClaims,
  CERTS_URL,
  certsEndpoint,
  encodeJson,
  get,
  ISSUER,
  MAIL_HERO_ALIAS,
  MAIL_HERO_OWNER,
  mailHeroPolicy,
  mintJwt,
  NOW,
  publicJwk,
  rsaPair,
  signJwt,
  text,
  TODOFY_ALIAS,
  TODOFY_OWNER,
  todofyPolicy,
  withToken,
  type CertsFetch,
} from './helpers.ts';

let issuerKey: CryptoKeyPair;
let rotatedKey: CryptoKeyPair;
let foreignKey: CryptoKeyPair;
let smallKey: CryptoKeyPair;
let jwks: unknown[];
let certs: CertsFetch;
let verifier: AccessVerifier;

beforeAll(async () => {
  [issuerKey, rotatedKey, foreignKey, smallKey] = await Promise.all([rsaPair(), rsaPair(), rsaPair(), rsaPair(1024)]);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  jwks = [await publicJwk(issuerKey, 'key-1')];
  certs = certsEndpoint(() => jwks);
  verifier = createAccessVerifier({ fetch: certs });
});

afterEach(() => {
  vi.useRealTimers();
});

const OK_MH = { ok: true, owner: MAIL_HERO_OWNER, bypassed: false } as const;
const OK_TF = { ok: true, owner: TODOFY_OWNER, bypassed: false } as const;
const failure = (name: string): AccessResult => ({ ok: false, failure: name } as AccessResult);

/** A token for the given app's owner, signed by the issuer's key with kid key-1. */
async function jwt(email: string, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = issuerKey): Promise<string> {
  return mintJwt({ key, header, claims: { email, ...claims } });
}

const mh = async (token: string, policy: AccessPolicy = mailHeroPolicy()): Promise<AccessResult> => verifier.verify(withToken(token), policy);
const tf = async (token: string, policy: AccessPolicy = todofyPolicy()): Promise<AccessResult> => verifier.verify(withToken(token), policy);

describe('a valid Access token', () => {
  it('verifies under both apps’ policies and returns the canonical owner', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(OK_MH);
    expect(await tf(await jwt(TODOFY_OWNER))).toEqual(OK_TF);
    expect(certs).toHaveBeenCalledTimes(1); // one issuer, one cache
  });

  it('fetches <issuer>/cdn-cgi/access/certs as a string URL, without following redirects, with a timeout', async () => {
    await mh(await jwt(MAIL_HERO_OWNER));
    const [url, init] = certs.mock.calls[0] ?? [];
    expect(url).toBe(CERTS_URL);
    expect(init?.redirect).toBe('manual');
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts aud as a string or as an array containing the audience', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER, { aud: AUDIENCE }))).toEqual(OK_MH);
    expect(await mh(await jwt(MAIL_HERO_OWNER, { aud: ['other', AUDIENCE] }))).toEqual(OK_MH);
  });

  it('accepts a token without nbf and one with the Access claims it does not check', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER, { nbf: undefined }))).toEqual(OK_MH);
    expect(
      await mh(await jwt(MAIL_HERO_OWNER, { type: 'app', identity_nonce: 'x', country: 'US', custom: { a: 1 } }, { typ: 'JWT' })),
    ).toEqual(OK_MH);
  });

  it('uses globalThis.fetch looked up at call time when no fetch is injected', async () => {
    const stub = certsEndpoint(() => jwks);
    const defaultVerifier = createAccessVerifier();
    vi.stubGlobal('fetch', stub);
    expect(await defaultVerifier.verify(withToken(await jwt(MAIL_HERO_OWNER)), mailHeroPolicy())).toEqual(OK_MH);
    expect(stub).toHaveBeenCalledWith(CERTS_URL, expect.anything());
  });
});

describe('claims', () => {
  const rejected: [string, Record<string, unknown>][] = [
    ['wrong issuer', { iss: 'https://evil.cloudflareaccess.com' }],
    ['issuer with a trailing slash', { iss: `${ISSUER}/` }],
    ['no issuer', { iss: undefined }],
    ['wrong audience (array)', { aud: ['someone-else'] }],
    ['wrong audience (string)', { aud: 'someone-else' }],
    ['empty audience array', { aud: [] }],
    ['numeric audience', { aud: 1 }],
    ['no audience', { aud: undefined }],
    ['audience as an object', { aud: { [AUDIENCE]: true } }],
    ['expired now', { exp: NOW }],
    ['expired long ago', { exp: NOW - 3600 }],
    ['no exp', { exp: undefined }],
    ['string exp', { exp: String(NOW + 600) }],
    ['null exp', { exp: null }],
    ['iat 60 s in the future', { iat: NOW + 60 }],
    ['iat far in the future', { iat: 4_102_444_800 }],
    ['no iat', { iat: undefined }],
    ['string iat', { iat: String(NOW) }],
    ['nbf in the future', { nbf: NOW + 3600 }],
    ['string nbf', { nbf: 'x' }],
    ['null nbf', { nbf: null }],
    ['no sub', { sub: undefined }],
    ['empty sub', { sub: '' }],
    ['numeric sub', { sub: 7 }],
    ['not the owner', { email: 'intruder@example.com' }],
    ['no email', { email: undefined }],
    ['numeric email', { email: 7 }],
    ['email array', { email: [MAIL_HERO_OWNER] }],
    ['owner with a suffix', { email: `${MAIL_HERO_OWNER}.evil` }],
    ['owner with whitespace', { email: ` ${MAIL_HERO_OWNER}` }],
  ];

  for (const [name, claims] of rejected) {
    it(`rejects ${name} under both policies`, async () => {
      expect(await mh(await jwt(MAIL_HERO_OWNER, claims))).toEqual(failure('invalid_token'));
      expect(await tf(await jwt(TODOFY_OWNER, claims))).toEqual(failure('invalid_token'));
    });
  }

  it('treats exp = now as expired and exp = now + 1 as valid', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER, { exp: NOW }))).toEqual(failure('invalid_token'));
    expect(await mh(await jwt(MAIL_HERO_OWNER, { exp: NOW + 1 }))).toEqual(OK_MH);
  });

  it('accepts iat up to 59 s in the future (clock skew) and refuses 60 s', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER, { iat: NOW + 59 }))).toEqual(OK_MH);
    expect(await tf(await jwt(TODOFY_OWNER, { iat: NOW + 59 }))).toEqual(OK_TF);
    expect(await mh(await jwt(MAIL_HERO_OWNER, { iat: NOW + 60 }))).toEqual(failure('invalid_token'));
    expect(await mh(await jwt(MAIL_HERO_OWNER, { iat: 0 }))).toEqual(OK_MH);
  });

  it('applies each app’s nbf leeway: 0 s for Mail Hero, 60 s for Todofy', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER, { nbf: NOW }))).toEqual(OK_MH);
    expect(await mh(await jwt(MAIL_HERO_OWNER, { nbf: NOW + 1 }))).toEqual(failure('invalid_token'));
    expect(await tf(await jwt(TODOFY_OWNER, { nbf: NOW + 60 }))).toEqual(OK_TF);
    expect(await tf(await jwt(TODOFY_OWNER, { nbf: NOW + 61 }))).toEqual(failure('invalid_token'));
  });

  it('uses whole seconds for now (a fractional clock does not shift the edges)', async () => {
    vi.setSystemTime(NOW * 1000 + 999);
    expect(await mh(await jwt(MAIL_HERO_OWNER, { exp: NOW + 1 }))).toEqual(OK_MH);
    expect(await mh(await jwt(MAIL_HERO_OWNER, { nbf: NOW }))).toEqual(OK_MH);
    expect(await mh(await jwt(MAIL_HERO_OWNER, { exp: NOW }))).toEqual(failure('invalid_token'));
  });

  it('refuses non-finite numeric claims (1e999 parses as Infinity)', async () => {
    const raw = (fields: string): string =>
      `{"iss":"${ISSUER}","aud":["${AUDIENCE}"],"email":"${MAIL_HERO_OWNER}","sub":"owner-id",${fields}}`;
    const cases = [
      raw(`"iat":${String(NOW)},"exp":1e999`),
      raw(`"iat":-1e999,"exp":${String(NOW + 600)}`),
      raw(`"iat":${String(NOW)},"exp":${String(NOW + 600)},"nbf":-1e999`),
    ];
    for (const rawPayload of cases) {
      expect(await mh(await mintJwt({ key: issuerKey, rawPayload }))).toEqual(failure('invalid_token'));
    }
    // The same raw builder with finite values verifies, so only the non-finite value is refused.
    const valid = raw(`"iat":${String(NOW)},"exp":${String(NOW + 600)}`);
    expect(await mh(await mintJwt({ key: issuerKey, rawPayload: valid }))).toEqual(OK_MH);
  });
});

describe('owner and aliases', () => {
  it('maps an alias login to the canonical owner (Mail Hero, exact match)', async () => {
    expect(await mh(await jwt(MAIL_HERO_ALIAS))).toEqual(OK_MH);
    expect(await mh(await jwt('other@example.org'))).toEqual(OK_MH);
  });

  it('matches Mail Hero emails case-sensitively and keeps the owner as configured', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER.toUpperCase()))).toEqual(failure('invalid_token'));
    expect(await mh(await jwt(`GITHUB-${MAIL_HERO_ALIAS.slice(7)}`))).toEqual(failure('invalid_token'));
    const mixed = mailHeroPolicy({ owner: ' Owner@Example.org ' });
    expect(await mh(await jwt('Owner@Example.org'), mixed)).toEqual({ ok: true, owner: 'Owner@Example.org', bypassed: false });
    expect(await mh(await jwt('owner@example.org'), mixed)).toEqual(failure('invalid_token'));
  });

  it('matches Todofy emails case-insensitively and returns the lowercased owner', async () => {
    expect(await tf(await jwt('OWNER@example.com'))).toEqual(OK_TF);
    expect(await tf(await jwt(TODOFY_ALIAS))).toEqual(OK_TF);
    expect(await tf(await jwt(TODOFY_ALIAS.toUpperCase()))).toEqual(OK_TF);
    expect(await tf(await jwt('Other.Login@Example.org'))).toEqual(OK_TF);
    expect(await tf(await jwt('intruder@example.com'))).toEqual(failure('invalid_token'));
  });

  it('never returns the alias itself', async () => {
    const result = await tf(await jwt(TODOFY_ALIAS));
    expect(result.ok && result.owner).toBe(TODOFY_OWNER);
  });
});

describe('header and algorithm', () => {
  it('refuses RS512, none, lowercase rs256, a missing alg and a non-string alg before fetching keys', async () => {
    for (const alg of ['RS512', 'none', 'rs256', undefined, ['RS256'], 'PS256', 'ES256']) {
      expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { alg })), String(alg)).toEqual(failure('invalid_token'));
    }
    const unsigned = `${encodeJson({ alg: 'none', kid: 'key-1' })}.${encodeJson({ ...baseClaims(MAIL_HERO_OWNER) })}.`;
    expect(await mh(unsigned)).toEqual(failure('invalid_token'));
    expect(certs).not.toHaveBeenCalled();
  });

  it('refuses HS256 signed with the issuer’s public key as the HMAC secret (alg confusion)', async () => {
    const jwk = (await crypto.subtle.exportKey('jwk', issuerKey.publicKey)) as unknown as Record<string, unknown>;
    const spki = new Uint8Array((await crypto.subtle.exportKey('spki', issuerKey.publicKey)) as ArrayBuffer);
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki)).replace(/.{64}/g, '$&\n')}\n-----END PUBLIC KEY-----\n`;
    const secrets: Uint8Array<ArrayBuffer>[] = [
      text(JSON.stringify(jwk)),
      text(JSON.stringify(jwks[0])),
      text(String(jwk.n)),
      new Uint8Array(spki),
      text(pem),
    ];
    for (const secret of secrets) {
      const hmac = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      for (const [alg, owner, verify] of [
        ['HS256', MAIL_HERO_OWNER, mh],
        ['HS256', TODOFY_OWNER, tf],
        ['RS256', MAIL_HERO_OWNER, mh],
        ['RS256', TODOFY_OWNER, tf],
      ] as const) {
        const input = `${encodeJson({ alg, kid: 'key-1', typ: 'JWT' })}.${encodeJson(baseClaims(owner))}`;
        const forged = `${input}.${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', hmac, text(input))))}`;
        const fetches = certs.mock.calls.length;
        expect(await verify(forged), `${alg} ${owner}`).toEqual(failure('invalid_token'));
        // HS256 is refused before any key lookup; an RS256 header reaches RSA verification and fails there.
        if (alg === 'HS256') expect(certs.mock.calls.length).toBe(fetches);
      }
    }
  });

  it('requires a non-empty string kid (no single-key fallback)', async () => {
    for (const kid of [undefined, '', 7, null, ['key-1']]) {
      expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { kid })), String(kid)).toEqual(failure('invalid_token'));
    }
    expect(certs).not.toHaveBeenCalled();
  });

  it('refuses any crit header, even an empty one or b64', async () => {
    for (const crit of [['b64'], [], ['exp'], 'b64']) {
      expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { crit, b64: true }))).toEqual(failure('invalid_token'));
      expect(await tf(await jwt(TODOFY_OWNER, {}, { crit }))).toEqual(failure('invalid_token'));
    }
  });

  it('never takes a key from the token header (jwk, jku, x5u, x5c are ignored)', async () => {
    const attackerJwk = await publicJwk(foreignKey, 'key-1');
    const forged = await jwt(
      MAIL_HERO_OWNER,
      {},
      { jwk: attackerJwk, jku: 'https://evil.example/certs', x5u: 'https://evil.example/cert', x5c: ['AAAA'] },
      foreignKey,
    );
    expect(await mh(forged)).toEqual(failure('invalid_token'));
    expect(certs).toHaveBeenCalledTimes(1);
    expect(certs.mock.calls[0]?.[0]).toBe(CERTS_URL);
  });

  it('refuses an unknown kid', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { kid: 'other' }))).toEqual(failure('invalid_token'));
  });
});

describe('signature', () => {
  it('refuses a token signed by another key under the issuer’s kid', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER, {}, {}, foreignKey))).toEqual(failure('invalid_token'));
  });

  it('refuses tampered claims, a tampered header, an empty or truncated signature', async () => {
    const valid = await jwt(MAIL_HERO_OWNER);
    const [h = '', p = '', s = ''] = valid.split('.');
    const cases = {
      'tampered claims': `${h}.${encodeJson({ ...baseClaims(MAIL_HERO_OWNER), exp: NOW + 99_999 })}.${s}`,
      'swapped owner': `${h}.${encodeJson(baseClaims(MAIL_HERO_ALIAS))}.${s}`,
      'tampered header': `${encodeJson({ alg: 'RS256', kid: 'key-1' })}.${p}.${s}`,
      'empty signature': `${h}.${p}.`,
      'truncated signature': `${h}.${p}.${s.slice(0, -4)}`,
      'flipped signature': `${h}.${p}.${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}`,
    };
    for (const [name, token] of Object.entries(cases)) expect(await mh(token), name).toEqual(failure('invalid_token'));
  });
});

describe('malformed tokens', () => {
  it('refuses every malformed shape as invalid_token', async () => {
    const valid = await jwt(MAIL_HERO_OWNER);
    const [h = '', p = '', s = ''] = valid.split('.');
    const cases: Record<string, string> = {
      garbage: 'not-a-jwt',
      'one dot': 'a.b',
      'two parts': `${h}.${p}`,
      'four parts': `${valid}.x`,
      'five parts': `${valid}.x.y`,
      'bad base64 character': `${h.slice(0, 5)}*${h.slice(6)}.${p}.${s}`,
      'standard base64 alphabet': `${h}.${p}.${s.replace(/-/g, '+').replace(/_/g, '/')}+/`,
      'length 1 mod 4 segment': `AAAAA.${p}.${s}`,
      'three pad characters': `${h}===.${p}.${s}`,
      'empty header': `.${p}.${s}`,
      'empty payload': `${h}..${s}`,
      'dots only': '..',
      'header not JSON': `${b64url(text('not json'))}.${p}.${s}`,
      'header is an array': `${encodeJson(['RS256'])}.${p}.${s}`,
      'header is a string': `${encodeJson('RS256')}.${p}.${s}`,
      'header is null': `${encodeJson(null)}.${p}.${s}`,
      'payload is an array': `${h}.${encodeJson([MAIL_HERO_OWNER])}.${s}`,
      'payload is a number': `${h}.${encodeJson(1)}.${s}`,
      'invalid UTF-8 payload': `${h}.${b64url(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))}.${s}`,
      'whitespace inside': `${h} .${p}.${s}`,
    };
    for (const [name, token] of Object.entries(cases)) expect(await mh(token), name).toEqual(failure('invalid_token'));
    for (const [name, token] of Object.entries(cases)) expect(await tf(token), name).toEqual(failure('invalid_token'));
  });

  it('refuses a validly signed token whose payload is not an object', async () => {
    const input = `${encodeJson({ alg: 'RS256', kid: 'key-1' })}.${encodeJson([baseClaims(MAIL_HERO_OWNER)])}`;
    expect(await mh(await signJwt(issuerKey, input))).toEqual(failure('invalid_token'));
  });

  it('refuses a validly signed payload that is not UTF-8', async () => {
    const input = `${encodeJson({ alg: 'RS256', kid: 'key-1' })}.${b64url(new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]))}`;
    expect(await mh(await signJwt(issuerKey, input))).toEqual(failure('invalid_token'));
  });

  it('refuses a signed, otherwise valid payload with invalid UTF-8 in a string (fatal decoding)', async () => {
    const claims = JSON.stringify({ ...baseClaims(MAIL_HERO_OWNER), name: 'MARK' });
    const [before = '', after = ''] = claims.split('MARK');
    const header = encodeJson({ alg: 'RS256', kid: 'key-1' });
    const broken = b64url(new Uint8Array([...text(before), 0xff, ...text(after)]));
    expect(await mh(await signJwt(issuerKey, `${header}.${broken}`))).toEqual(failure('invalid_token'));
    const clean = b64url(new Uint8Array([...text(before), 0x78, ...text(after)]));
    expect(await mh(await signJwt(issuerKey, `${header}.${clean}`))).toEqual(OK_MH);
  });

  it('accepts padded base64url segments when the signature covers them (Todofy’s decoder)', async () => {
    const header = encodeJson({ alg: 'RS256', kid: 'key-1', typ: 'JWT' });
    const claims = encodeJson(baseClaims(MAIL_HERO_OWNER));
    const pad = (segment: string): string => segment + '='.repeat((4 - (segment.length % 4)) % 4);
    expect(await mh(await signJwt(issuerKey, `${pad(header)}.${pad(claims)}`))).toEqual(OK_MH);
  });
});

describe('token source', () => {
  const url = 'https://mail.example.org/';

  it('reads the Cf-Access-Jwt-Assertion header, case-insensitively by name', async () => {
    const token = await jwt(MAIL_HERO_OWNER);
    expect(await verifier.verify(get(url, { 'Cf-Access-Jwt-Assertion': token }), mailHeroPolicy())).toEqual(OK_MH);
  });

  it('falls back to the CF_Authorization cookie when the header is absent', async () => {
    const token = await jwt(MAIL_HERO_OWNER);
    expect(await verifier.verify(get(url, { cookie: `theme=dark; CF_Authorization=${token}` }), mailHeroPolicy())).toEqual(OK_MH);
    const tfToken = await jwt(TODOFY_OWNER);
    expect(await verifier.verify(get(url, { cookie: `CF_Authorization=${tfToken}` }), todofyPolicy())).toEqual(OK_TF);
  });

  it('prefers the header over the cookie', async () => {
    const good = await jwt(MAIL_HERO_OWNER);
    expect(await verifier.verify(get(url, { 'cf-access-jwt-assertion': good, cookie: 'CF_Authorization=garbage' }), mailHeroPolicy())).toEqual(OK_MH);
    expect(await verifier.verify(get(url, { 'cf-access-jwt-assertion': 'garbage', cookie: `CF_Authorization=${good}` }), mailHeroPolicy())).toEqual(
      failure('invalid_token'),
    );
  });

  it('treats an empty header as missing for Mail Hero and falls back to the cookie for Todofy', async () => {
    const mhToken = await jwt(MAIL_HERO_OWNER);
    const tfToken = await jwt(TODOFY_OWNER);
    expect(await verifier.verify(get(url, { 'cf-access-jwt-assertion': '', cookie: `CF_Authorization=${mhToken}` }), mailHeroPolicy())).toEqual(
      failure('missing_token'),
    );
    expect(await verifier.verify(get(url, { 'cf-access-jwt-assertion': '', cookie: `CF_Authorization=${tfToken}` }), todofyPolicy())).toEqual(OK_TF);
  });

  it('uses the first CF_Authorization cookie for Mail Hero and the last for Todofy', async () => {
    const mhToken = await jwt(MAIL_HERO_OWNER);
    const tfToken = await jwt(TODOFY_OWNER);
    expect(await verifier.verify(get(url, { cookie: `CF_Authorization=${mhToken}; x=1; CF_Authorization=stale` }), mailHeroPolicy())).toEqual(OK_MH);
    expect(await verifier.verify(get(url, { cookie: `CF_Authorization=stale; x=1; CF_Authorization=${mhToken}` }), mailHeroPolicy())).toEqual(
      failure('invalid_token'),
    );
    expect(await verifier.verify(get(url, { cookie: `CF_Authorization=stale; theme=dark; CF_Authorization=${tfToken}` }), todofyPolicy())).toEqual(OK_TF);
    expect(await verifier.verify(get(url, { cookie: `CF_Authorization=${tfToken}; CF_Authorization=stale` }), todofyPolicy())).toEqual(
      failure('invalid_token'),
    );
  });

  it('matches the cookie name exactly', async () => {
    const token = await jwt(MAIL_HERO_OWNER);
    for (const cookie of [`cf_authorization=${token}`, `XCF_Authorization=${token}`, `CF_Authorization2=${token}`, `CF_Authorization`]) {
      expect(await verifier.verify(get(url, { cookie }), mailHeroPolicy()), cookie.slice(0, 20)).toEqual(failure('missing_token'));
    }
  });

  it('reports a missing, empty or oversize token as missing_token without fetching keys', async () => {
    expect(await verifier.verify(get(url), mailHeroPolicy())).toEqual(failure('missing_token'));
    expect(await verifier.verify(get(url), todofyPolicy())).toEqual(failure('missing_token'));
    expect(await verifier.verify(get(url, { cookie: 'CF_Authorization=' }), mailHeroPolicy())).toEqual(failure('missing_token'));
    expect(await verifier.verify(get(url, { 'cf-access-jwt-assertion': '' }), todofyPolicy())).toEqual(failure('missing_token'));
    const oversize = 'a'.repeat(ACCESS_MAX_TOKEN_CHARS + 1);
    expect(await mh(oversize)).toEqual(failure('missing_token'));
    expect(await tf(oversize)).toEqual(failure('missing_token'));
    expect(await verifier.verify(get(url, { cookie: `CF_Authorization=${oversize}` }), todofyPolicy())).toEqual(failure('missing_token'));
    expect(certs).not.toHaveBeenCalled();
  });

  it('parses a token of exactly 16,000 characters and refuses 16,001', async () => {
    const valid = await jwt(MAIL_HERO_OWNER);
    expect(ACCESS_MAX_TOKEN_CHARS).toBe(16_000);
    expect(await mh('a'.repeat(16_000))).toEqual(failure('invalid_token'));
    const padded = await jwt(MAIL_HERO_OWNER, { pad: 'x'.repeat(11_000) });
    expect(padded.length).toBeLessThanOrEqual(16_000);
    expect(padded.length).toBeGreaterThan(valid.length);
    expect(await mh(padded)).toEqual(OK_MH);
    const tooLong = await jwt(MAIL_HERO_OWNER, { pad: 'x'.repeat(12_000) });
    expect(tooLong.length).toBeGreaterThan(16_000);
    expect(await mh(tooLong)).toEqual(failure('missing_token'));
  });
});

describe('certs endpoint failures', () => {
  const failures: [string, () => Promise<Response>][] = [
    ['500', () => Promise.resolve(new Response('nope', { status: 500 }))],
    ['404', () => Promise.resolve(new Response('{"keys":[]}', { status: 404 }))],
    ['302 redirect', () => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example/certs' } }))],
    ['204', () => Promise.resolve(new Response(null, { status: 204 }))],
    ['200 not JSON', () => Promise.resolve(new Response('not json', { status: 200 }))],
    ['200 empty body', () => Promise.resolve(new Response('', { status: 200 }))],
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
    ['oversize body', () => Promise.resolve(new Response(`{"keys":[],"pad":"${'x'.repeat(1_000_001)}"}`, { status: 200 }))],
  ];

  for (const [name, answer] of failures) {
    it(`reports keys_unavailable for ${name}`, async () => {
      certs.mockImplementationOnce(answer);
      expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(failure('keys_unavailable'));
    });
  }

  it('reports keys_unavailable when fetch throws synchronously', async () => {
    const throwing = createAccessVerifier({
      fetch: () => {
        throw new Error('boom');
      },
    });
    expect(await throwing.verify(withToken(await jwt(MAIL_HERO_OWNER)), mailHeroPolicy())).toEqual(failure('keys_unavailable'));
  });

  it('aborts the certs request after 5 seconds', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    certs.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    const pending = mh(await jwt(MAIL_HERO_OWNER));
    await vi.waitFor(() => {
      expect(certs).toHaveBeenCalledTimes(1);
    });
    expect(timeout).toHaveBeenCalledWith(5000);
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await pending).toEqual(failure('keys_unavailable'));
  });

  it('does not cache a failure: the next request fetches again', async () => {
    certs.mockImplementationOnce(() => Promise.resolve(new Response('nope', { status: 503 })));
    const token = await jwt(MAIL_HERO_OWNER);
    expect(await mh(token)).toEqual(failure('keys_unavailable'));
    expect(await mh(token)).toEqual(OK_MH);
    expect(certs).toHaveBeenCalledTimes(2);
  });

  it('treats a body without a keys array as an empty key set', async () => {
    for (const body of [{}, { keys: 'x' }, { keys: null }, [], 'keys', null]) {
      const local = createAccessVerifier({ fetch: () => Promise.resolve(Response.json(body)) });
      expect(await local.verify(withToken(await jwt(MAIL_HERO_OWNER)), mailHeroPolicy()), JSON.stringify(body)).toEqual(failure('invalid_token'));
    }
  });
});

describe('key selection', () => {
  it('uses only the key whose kid matches', async () => {
    jwks = [await publicJwk(foreignKey, 'key-0'), await publicJwk(issuerKey, 'key-1'), await publicJwk(rotatedKey, 'key-2')];
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(OK_MH);
    expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { kid: 'key-2' }, rotatedKey))).toEqual(OK_MH);
    expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { kid: 'key-0' }))).toEqual(failure('invalid_token'));
  });

  it('imports a key without alg, use or key_ops, and one whose key_ops include verify', async () => {
    const { alg: _alg, use: _use, key_ops: _ops, ext: _ext, ...bare } = await publicJwk(issuerKey, 'key-1');
    jwks = [bare];
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(OK_MH);
    jwks = [await publicJwk(issuerKey, 'key-1', { key_ops: ['verify', 'encrypt'] })];
    expect(await createAccessVerifier({ fetch: certs }).verify(withToken(await jwt(MAIL_HERO_OWNER)), mailHeroPolicy())).toEqual(OK_MH);
  });

  const filtered: [string, Record<string, unknown>][] = [
    ['use: enc', { use: 'enc' }],
    ['alg: RS512', { alg: 'RS512' }],
    ['alg: HS256', { alg: 'HS256' }],
    ['key_ops: [sign]', { key_ops: ['sign'] }],
    ['key_ops not an array', { key_ops: 'verify' }],
    ['kty: EC', { kty: 'EC' }],
    ['kty: oct', { kty: 'oct', k: 'AAAA' }],
    ['numeric n', { n: 5 }],
    ['numeric e', { e: 65537 }],
    ['broken n', { n: 'AA' }],
  ];
  for (const [name, change] of filtered) {
    it(`drops a JWK with ${name}`, async () => {
      jwks = [await publicJwk(issuerKey, 'key-1', change), await publicJwk(rotatedKey, 'key-2')];
      expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(failure('invalid_token'));
      expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { kid: 'key-2' }, rotatedKey))).toEqual(OK_MH);
    });
  }

  it('drops a JWK without a kid or with an empty kid', async () => {
    const { kid: _kid, ...noKid } = await publicJwk(issuerKey, 'key-1');
    jwks = [noKid, await publicJwk(issuerKey, '')];
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(failure('invalid_token'));
  });

  it('refuses RSA keys smaller than 2048 bits', async () => {
    jwks = [await publicJwk(smallKey, 'key-1')];
    expect(await mh(await jwt(MAIL_HERO_OWNER, {}, {}, smallKey))).toEqual(failure('invalid_token'));
    expect(await tf(await jwt(TODOFY_OWNER, {}, {}, smallKey))).toEqual(failure('invalid_token'));
  });

  it('drops a kid listed twice, even when both entries are the same key', async () => {
    const entry = await publicJwk(issuerKey, 'key-1');
    for (const pair of [[entry, entry], [await publicJwk(foreignKey, 'key-1'), entry], [entry, { kty: 'EC', kid: 'key-1' }]]) {
      jwks = [...pair, await publicJwk(rotatedKey, 'key-2')];
      const local = createAccessVerifier({ fetch: certs });
      expect(await local.verify(withToken(await jwt(MAIL_HERO_OWNER)), mailHeroPolicy())).toEqual(failure('invalid_token'));
      expect(await local.verify(withToken(await jwt(MAIL_HERO_OWNER, {}, { kid: 'key-2' }, rotatedKey)), mailHeroPolicy())).toEqual(OK_MH);
    }
  });

  it('skips non-object members and keeps the valid keys next to them', async () => {
    jwks = [null, 'key', 7, ['x'], await publicJwk(issuerKey, 'key-1')];
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(OK_MH);
  });

  it('considers only the first 16 members of the certs', async () => {
    const filler = await Promise.all(Array.from({ length: 16 }, (_, i) => publicJwk(rotatedKey, `filler-${String(i)}`)));
    jwks = [...filler, await publicJwk(issuerKey, 'key-1')];
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(failure('invalid_token'));
  });
});

describe('key cache', () => {
  it('refetches for an unknown kid at most once per cooldown and keeps the old key (Todofy timings)', async () => {
    const policy = todofyPolicy({ jwks: { ttlMs: 3_600_000, refreshCooldownMs: 2000 } });
    for (let i = 0; i < 3; i++) expect(await tf(await jwt(TODOFY_OWNER), policy)).toEqual(OK_TF);
    expect(certs).toHaveBeenCalledTimes(1);

    jwks = [await publicJwk(rotatedKey, 'rotated-key'), ...jwks];
    const rotated = await jwt(TODOFY_OWNER, {}, { kid: 'rotated-key' }, rotatedKey);
    expect(await tf(rotated, policy)).toEqual(failure('invalid_token')); // inside the cooldown: no refetch
    expect(certs).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW * 1000 + 2500);
    expect(await tf(await jwt(TODOFY_OWNER, {}, { kid: 'rotated-key' }, rotatedKey), policy)).toEqual(OK_TF);
    expect(await tf(await jwt(TODOFY_OWNER), policy)).toEqual(OK_TF);
    expect(await tf(await jwt(TODOFY_OWNER, {}, { kid: 'unknown-key' }), policy)).toEqual(failure('invalid_token'));
    expect(certs).toHaveBeenCalledTimes(2);

    vi.setSystemTime(NOW * 1000 + 3_603_000);
    expect(await tf(await jwt(TODOFY_OWNER), policy)).toEqual(OK_TF); // the hour-long cache expired
    expect(certs).toHaveBeenCalledTimes(3);
  });

  it('applies Mail Hero’s 10 minute TTL and 30 s cooldown', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(OK_MH);
    vi.setSystemTime(NOW * 1000 + 29_999);
    expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { kid: 'new' }))).toEqual(failure('invalid_token'));
    expect(certs).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW * 1000 + 30_000);
    expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { kid: 'new' }))).toEqual(failure('invalid_token'));
    expect(certs).toHaveBeenCalledTimes(2);
    vi.setSystemTime(NOW * 1000 + 30_000 + 599_999);
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(OK_MH);
    expect(certs).toHaveBeenCalledTimes(2);
    vi.setSystemTime(NOW * 1000 + 30_000 + 600_000);
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(OK_MH);
    expect(certs).toHaveBeenCalledTimes(3);
  });

  it('uses the defaults (10 min / 60 s) when the policy gives none', async () => {
    const policy = mailHeroPolicy({ jwks: {} });
    expect(await mh(await jwt(MAIL_HERO_OWNER), policy)).toEqual(OK_MH);
    vi.setSystemTime(NOW * 1000 + 59_999);
    expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { kid: 'new' }), policy)).toEqual(failure('invalid_token'));
    expect(certs).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW * 1000 + 60_000);
    expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { kid: 'new' }), policy)).toEqual(failure('invalid_token'));
    expect(certs).toHaveBeenCalledTimes(2);
    vi.setSystemTime(NOW * 1000 + 660_000);
    expect(await mh(await jwt(MAIL_HERO_OWNER), policy)).toEqual(OK_MH);
    expect(certs).toHaveBeenCalledTimes(3);
  });

  it('keeps the old key set when a refetch fails, and has no stale fallback after the TTL', async () => {
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(OK_MH);
    vi.setSystemTime(NOW * 1000 + 31_000);
    certs.mockImplementationOnce(() => Promise.resolve(new Response('down', { status: 500 })));
    expect(await mh(await jwt(MAIL_HERO_OWNER, {}, { kid: 'new' }))).toEqual(failure('keys_unavailable'));
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(OK_MH); // still cached
    expect(certs).toHaveBeenCalledTimes(2);
    vi.setSystemTime(NOW * 1000 + 600_000);
    certs.mockImplementationOnce(() => Promise.reject(new Error('down')));
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(failure('keys_unavailable'));
  });

  it('shares one certs request between concurrent verifications', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    certs.mockImplementationOnce(async () => {
      await gate;
      return Response.json({ keys: jwks });
    });
    const token = await jwt(MAIL_HERO_OWNER);
    const pending = Array.from({ length: 5 }, () => mh(token));
    await vi.waitFor(() => {
      expect(certs).toHaveBeenCalledTimes(1);
    });
    release();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 5 }, () => OK_MH));
    expect(certs).toHaveBeenCalledTimes(1);
  });

  it('keeps one cache per verifier and per issuer', async () => {
    const other = createAccessVerifier({ fetch: certs });
    expect(await mh(await jwt(MAIL_HERO_OWNER))).toEqual(OK_MH);
    expect(await other.verify(withToken(await jwt(MAIL_HERO_OWNER)), mailHeroPolicy())).toEqual(OK_MH);
    expect(certs).toHaveBeenCalledTimes(2);

    const second = 'https://second-team.cloudflareaccess.com';
    expect(await mh(await jwt(MAIL_HERO_OWNER, { iss: second }), mailHeroPolicy({ issuer: second }))).toEqual(OK_MH);
    expect(certs).toHaveBeenCalledTimes(3);
    expect(certs.mock.calls[2]?.[0]).toBe(`${second}/cdn-cgi/access/certs`);
    // A token from the second issuer does not verify under the first issuer's policy.
    expect(await mh(await jwt(MAIL_HERO_OWNER, { iss: second }))).toEqual(failure('invalid_token'));
  });
});

describe('configuration (fail closed)', () => {
  const broken: [string, Partial<AccessPolicy>][] = [
    ['no issuer', { issuer: undefined }],
    ['empty issuer', { issuer: ' ' }],
    ['plain http issuer', { issuer: 'http://team-name.cloudflareaccess.com' }],
    ['other domain', { issuer: 'https://team.cloudflareaccess.com.evil.example' }],
    ['uppercase issuer', { issuer: 'https://Team-Name.cloudflareaccess.com' }],
    ['issuer with a path', { issuer: `${ISSUER}/x` }],
    ['issuer with a port', { issuer: `${ISSUER}:443` }],
    ['loopback issuer without the flag', { issuer: 'http://127.0.0.1:9000' }],
    ['no audience', { audience: undefined }],
    ['blank audience', { audience: '  ' }],
    ['no owner', { owner: undefined }],
    ['blank owner', { owner: ' ' }],
    ['owner not an email', { owner: 'owner' }],
    ['owner with a space', { owner: 'own er@example.com' }],
    ['owner without a dot in the domain', { owner: 'owner@example' }],
    ['nine aliases', { aliases: Array.from({ length: 9 }, (_, i) => `a${String(i)}@example.com`).join(',') }],
    ['aliases longer than 2048 characters', { aliases: `${'a'.repeat(2038)}@example.com` }],
    ['alias not an email', { aliases: 'a@example.com, not-an-email' }],
    ['bad emailMatch', { emailMatch: 'loose' as never }],
    ['negative nbf leeway', { nbfLeewaySeconds: -1 }],
    ['fractional nbf leeway', { nbfLeewaySeconds: 1.5 }],
    ['nbf leeway above 300 s', { nbfLeewaySeconds: 301 }],
    ['NaN nbf leeway', { nbfLeewaySeconds: Number.NaN }],
    ['negative TTL', { jwks: { ttlMs: -1 } }],
    ['infinite cooldown', { jwks: { refreshCooldownMs: Number.POSITIVE_INFINITY } }],
    ['bad token source', { tokenSource: { emptyHeader: 'x' as never, cookie: 'first' } }],
    ['no token source', { tokenSource: undefined as never }],
  ];

  for (const [name, change] of broken) {
    it(`answers not_configured for ${name}, before reading the token`, async () => {
      expect(await mh(await jwt(MAIL_HERO_OWNER), mailHeroPolicy(change))).toEqual(failure('not_configured'));
      expect(await verifier.verify(get('https://mail.example.org/'), todofyPolicy(change))).toEqual(failure('not_configured'));
      expect(certs).not.toHaveBeenCalled();
    });
  }

  it('trims values, strips every trailing slash from the issuer and measures aliases after trimming', async () => {
    const policy = mailHeroPolicy({
      issuer: `  ${ISSUER}///  `,
      audience: ` ${AUDIENCE} `,
      owner: ` ${MAIL_HERO_OWNER}\n`,
      aliases: `  ${' '.repeat(3000)}${MAIL_HERO_ALIAS}${' '.repeat(3000)} `,
    });
    expect(await mh(await jwt(MAIL_HERO_OWNER), policy)).toEqual(OK_MH);
    expect(await mh(await jwt(MAIL_HERO_ALIAS), policy)).toEqual(OK_MH);
    expect(certs.mock.calls[0]?.[0]).toBe(CERTS_URL);
  });

  it('allows exactly eight aliases and 2048 characters, and drops empty entries', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => `a${String(i)}@example.com`).join(',');
    expect(await mh(await jwt('a7@example.com'), mailHeroPolicy({ aliases: `,,${eight},, ,` }))).toEqual(OK_MH);
    const long = `${'a'.repeat(2048 - '@example.com'.length)}@example.com`;
    expect(long.length).toBe(2048);
    expect(await mh(await jwt(long), mailHeroPolicy({ aliases: long }))).toEqual(OK_MH);
    expect(await mh(await jwt(MAIL_HERO_OWNER), mailHeroPolicy({ aliases: undefined }))).toEqual(OK_MH);
    expect(await mh(await jwt(MAIL_HERO_OWNER), mailHeroPolicy({ aliases: '' }))).toEqual(OK_MH);
  });

  it('accepts a loopback issuer only when the app allows it', async () => {
    const loopback = 'http://127.0.0.1:9000';
    const allowed = todofyPolicy({ issuer: loopback }, { localDev: true, loopback: true });
    expect(await tf(await jwt(TODOFY_OWNER, { iss: loopback }), allowed)).toEqual(OK_TF);
    expect(certs).toHaveBeenLastCalledWith(`${loopback}/cdn-cgi/access/certs`, expect.anything());
    expect(await tf(await jwt(TODOFY_OWNER, { iss: loopback }), todofyPolicy({ issuer: loopback }, { localDev: true }))).toEqual(
      failure('not_configured'),
    );
    for (const issuer of ['http://localhost:9000', 'http://127.0.0.1', 'http://127.0.0.1:123456', 'https://127.0.0.1:9000', 'http://127.0.0.2:9000']) {
      expect(await tf(await jwt(TODOFY_OWNER, { iss: issuer }), { ...allowed, issuer }), issuer).toEqual(failure('not_configured'));
    }
    // The Cloudflare issuer still works when the loopback issuer is allowed.
    expect(await tf(await jwt(TODOFY_OWNER), { ...allowed, issuer: ISSUER })).toEqual(OK_TF);
  });

  it('never throws, even for a nonsensical policy', async () => {
    expect(await verifier.verify(get('https://x.example/'), null as never)).toEqual(failure('not_configured'));
    expect(await verifier.verify(get('https://x.example/'), { ...mailHeroPolicy(), issuer: 7 as never })).toEqual(failure('not_configured'));
  });
});

describe('dev bypass', () => {
  const enabled = (): AccessPolicy => mailHeroPolicy({}, { DEV_AUTH_BYPASS: 'true' });

  it('bypasses Mail Hero only for http: on localhost, 127.0.0.1 or [::1] without cf-ray', async () => {
    for (const url of ['http://localhost:8787/api/v1/overview', 'http://127.0.0.1:8787/', 'http://[::1]:8787/', 'http://localhost/']) {
      expect(await verifier.verify(get(url), enabled()), url).toEqual({ ok: true, owner: 'local-development', bypassed: true });
    }
    // Even with no Access configuration at all.
    const bare = { ...enabled(), issuer: undefined, audience: undefined, owner: undefined };
    expect(await verifier.verify(get('http://127.0.0.1:8787/'), bare)).toEqual({ ok: true, owner: 'local-development', bypassed: true });
    expect(certs).not.toHaveBeenCalled();
  });

  it('refuses Mail Hero’s flag anywhere else, before checking the configuration', async () => {
    const refused = [
      get('http://localhost:8787/', { 'cf-ray': '8f1c2d3e4f5a6b7c-SJC' }),
      get('http://127.0.0.1/', { 'CF-Ray': 'x' }),
      get('https://localhost/'),
      get('https://mail.example.org/'),
      get('http://mail.example.org/'),
      get('http://localhost.evil.example/'),
      get('http://127.0.0.1.nip.io/'),
      get('http://app.localhost/'),
      get('http://0.0.0.0/'),
      get('http://[::2]/'),
    ];
    for (const request of refused) {
      expect(await verifier.verify(request, { ...enabled(), issuer: undefined }), request.url).toEqual(failure('dev_bypass_refused'));
    }
  });

  it('bypasses Todofy only for a *.localhost host without cf-ray, and otherwise verifies normally', async () => {
    const policy = todofyPolicy({}, { localDev: true, bypass: true });
    for (const url of ['https://todofy.localhost/', 'http://todofy.localhost:8787/api/v1/overview']) {
      expect(await verifier.verify(get(url), policy), url).toEqual({ ok: true, owner: TODOFY_OWNER, bypassed: true });
    }
    const through = [
      get('https://todofy.localhost/', { 'cf-ray': '8f1c2d3e4f5a6b7c-SJC' }),
      get('https://todofy.example.com/'),
      get('http://localhost/'),
      get('http://127.0.0.1/'),
      get('https://evil-localhost/'),
      get('https://todofy.localhost.evil.example/'),
    ];
    for (const request of through) expect(await verifier.verify(request, policy), request.url).toEqual(failure('missing_token'));
    const token = await jwt(TODOFY_OWNER);
    expect(await verifier.verify(get('https://todofy.example.com/', { 'cf-access-jwt-assertion': token }), policy)).toEqual(OK_TF);
    // Under 'verify', an edge request with the flag set still needs a valid configuration.
    expect(await verifier.verify(get('https://todofy.localhost/', { 'cf-ray': 'x' }), { ...policy, audience: undefined })).toEqual(
      failure('not_configured'),
    );
  });

  it('keeps the package invariant whatever host rule the app picks', async () => {
    for (const hosts of ['loopback-http', 'dot-localhost'] as const) {
      const policy = mailHeroPolicy({ devBypass: { enabled: true, hosts, principal: 'dev', whenNotLocal: 'verify' } });
      for (const url of ['https://mail.example.org/', 'http://mail.example.org/', 'https://127.0.0.1.example/']) {
        expect(await verifier.verify(get(url), policy), `${hosts} ${url}`).toEqual(failure('missing_token'));
      }
    }
    const unknown = mailHeroPolicy({ devBypass: { enabled: true, hosts: 'anything' as never, principal: 'dev', whenNotLocal: 'refuse' } });
    expect(await verifier.verify(get('http://localhost/'), unknown)).toEqual(failure('dev_bypass_refused'));
  });

  it('never bypasses when the app’s flag is off', async () => {
    expect(await verifier.verify(get('http://localhost:8787/'), mailHeroPolicy())).toEqual(failure('missing_token'));
    expect(await verifier.verify(get('https://todofy.localhost/'), todofyPolicy({}, { localDev: true }))).toEqual(failure('missing_token'));
  });

  it('refuses a principal that is not a string', async () => {
    const policy = mailHeroPolicy({ devBypass: { enabled: true, hosts: 'loopback-http', principal: undefined as never, whenNotLocal: 'refuse' } });
    expect(await verifier.verify(get('http://localhost/'), policy)).toEqual(failure('not_configured'));
  });
});
