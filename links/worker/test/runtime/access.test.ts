/**
 * Cloudflare Access in workerd without the dev bypass (src/auth.ts, packages/edge-auth): a synthetic issuer signs
 * RS256 tokens and serves its keys through the outbound handler. Under /_/ every request needs the owner's token. On a
 * short link the token decides only whether a private link opens: any failure there (no token, another person, a bad
 * token, keys that cannot be fetched) is anonymous, and an anonymous request never fetches the keys.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessClaims, testIssuer, type TestIssuer } from '../jwt.ts';
import { reasonOf, startHarness, SYNTHETIC_BINDINGS, type Harness } from './harness.ts';

const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';
const CERTS = `${ISSUER}/cdn-cgi/access/certs`;

let h: Harness;
let issuer: TestIssuer;
// The issuer's keys cannot be fetched until the first describe block below is done (no negative caching).
let certsStatus = 500;
let certsFetches = 0;

beforeAll(async () => {
  issuer = await testIssuer();
  h = await startHarness({
    bindings: { DEV_AUTH_BYPASS: 'false' },
    routes: new Map([
      [
        CERTS,
        () => {
          certsFetches += 1;
          return certsStatus === 200 ? Response.json(issuer.jwks) : new Response('down', { status: certsStatus });
        },
      ],
    ]),
  });
  const now = Date.now();
  // Fixtures straight into D1: the API itself needs a login, which the tests below check.
  for (const [key, target, visibility] of [
    ['priv', 'https://private.example.org/', 'private'],
    ['pub', 'https://public.example.org/', 'public'],
  ] as const) {
    await h.sql(
      `INSERT INTO links (key, target, path_mode, visibility, description, tags, expire_time, create_time, update_time, delete_time, purge_time, revision, revision_time, etag)
       VALUES (?, ?, 'exact', ?, '', '[]', NULL, ?, ?, NULL, NULL, 1, ?, 'e')`,
      key,
      target,
      visibility,
      now,
      now,
      now,
    );
  }
});
afterAll(async () => {
  await h.dispose();
});

const jwt = (email = 'owner@example.com') => issuer.sign(accessClaims(ISSUER, AUDIENCE, email));

describe('while the keys cannot be fetched', () => {
  afterAll(() => {
    certsStatus = 200;
  });

  it('the owner half answers UNAVAILABLE, which the launcher may repeat', async () => {
    const response = await h.fetch('/_/api/v1/links', { headers: { 'cf-access-jwt-assertion': await jwt() } });
    expect(response.status).toBe(503);
    expect(reasonOf(await response.json())).toBe('UNAVAILABLE');
  });

  it('a short link stays anonymous instead of failing', async () => {
    const response = await h.fetch('/priv', { headers: { cookie: `CF_Authorization=${await jwt()}` } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/_/k/priv');
    expect((await h.fetch('/pub', { headers: { cookie: `CF_Authorization=${await jwt()}` } })).headers.get('location')).toBe('https://public.example.org/');
  });
});

describe('the owner half (/_/)', () => {
  it('needs the owner token on every path', async () => {
    for (const path of ['/_/', '/_/api/v1/links', '/_/api/csrf', '/_/k/priv']) {
      const response = await h.fetch(path);
      expect(response.status, path).toBe(401);
      expect(reasonOf(await response.json())).toBe('UNAUTHORIZED');
    }
    expect((await h.fetch('/_/api/v1/links', { headers: { 'cf-access-jwt-assertion': await jwt('someone@example.com') } })).status).toBe(401);
    expect((await h.fetch('/_/api/v1/links', { headers: { 'cf-access-jwt-assertion': await jwt('OWNER@example.com') } })).status).toBe(200);
    expect((await h.fetch('/_/', { headers: { cookie: `CF_Authorization=${await jwt()}` } })).status).toBe(200);
  });
});

describe('short links', () => {
  it('open a private link for the owner token in the Access cookie', async () => {
    const response = await h.fetch('/priv', { headers: { cookie: `CF_Authorization=${await jwt()}` } });
    expect(response.headers.get('location')).toBe('https://private.example.org/');
  });

  it('read any other token as anonymous', async () => {
    for (const cookie of [`CF_Authorization=${await jwt('someone@example.com')}`, 'CF_Authorization=garbage', 'CF_Authorization=']) {
      const response = await h.fetch('/priv', { headers: { cookie } });
      expect(response.status, cookie).toBe(302);
      expect(response.headers.get('location'), cookie).toBe('/_/k/priv');
    }
    expect((await h.fetch('/pub', { headers: { cookie: 'CF_Authorization=garbage' } })).headers.get('location')).toBe('https://public.example.org/');
  });

  it('never fetch the keys for an anonymous request', async () => {
    const before = certsFetches;
    for (const path of ['/priv', '/pub', '/nope', '/priv+']) await (await h.fetch(path)).text();
    expect(certsFetches).toBe(before);
  });

});
