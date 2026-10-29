/**
 * The console Worker in workerd, as deployed (no dev bypass): the owner's login is verified against a synthetic
 * issuer whose keys the outbound handler serves, each read is forwarded to a fake Newsletter with only that login,
 * Newsletter's golden answers cross unchanged, and nothing else leaves the Worker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessClaims, testIssuer, type TestIssuer } from '../jwt.ts';
import { AUDIENCE, ISSUER, PAGE, startHarness, UPSTREAM, type Harness } from './harness.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'contracts', 'newsletter-ui-v1', 'fixtures');
const OVERVIEW = readFileSync(join(FIXTURES, 'overview.json'), 'utf8');
const BLOCKED = readFileSync(join(FIXTURES, 'run-blocked-selection-timeout.json'), 'utf8');
const BLOCKED_RUN = 'runs/00000000-0000-4000-8000-000000002800';

let h: Harness;
let issuer: TestIssuer;

const json = (body: string) => new Response(body, { headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  issuer = await testIssuer();
  h = await startHarness(issuer.jwks, {
    newsletter: (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/newsletter/v1/overview') return json(OVERVIEW);
      if (path === `/api/newsletter/v1/${BLOCKED_RUN}`) return json(BLOCKED);
      if (path === '/api/newsletter/v1/sourceCatalog') return new Response(null, { status: 302, headers: { location: `${ISSUER}/cdn-cgi/access/login` } });
      return new Response('{"error":"synthetic-upstream-detail"}', { status: 404, headers: { 'content-type': 'application/json' } });
    },
  });
});
afterAll(async () => {
  await h.dispose();
});

const login = (email = 'owner@example.com') => issuer.sign(accessClaims(ISSUER, AUDIENCE, email));

async function reason(response: { json(): Promise<unknown> }): Promise<string | undefined> {
  const body = await response.json() as { error?: { details?: { '@type'?: string; reason?: string }[] } };
  return body.error?.details?.find((detail) => detail['@type']?.endsWith('google.rpc.ErrorInfo'))?.reason;
}

describe('the deployed Worker', () => {
  it('needs the owner login on every path, and forwards nothing without it', async () => {
    const before = h.outbound.length;
    for (const path of ['/', '/api/v1/overview']) {
      const anonymous = await h.fetch(path);
      expect(anonymous.status, path).toBe(401);
      expect(await reason(anonymous), path).toBe('UNAUTHORIZED');
      const other = await h.fetch(path, { headers: { 'cf-access-jwt-assertion': await login('someone@example.com') } });
      expect(other.status, path).toBe(401);
      await other.text();
    }
    expect(h.outbound.slice(before).filter((request) => request.url.startsWith(UPSTREAM))).toEqual([]);
  });

  it('serves the UI to the owner under the strict CSP', async () => {
    const page = await h.fetch('/', { headers: { cookie: `CF_Authorization=${await login()}` } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it("forwards the owner's reads with the verified login only, and passes Newsletter's answers through unchanged", async () => {
    const assertion = await login();
    for (const [path, golden] of [['/api/v1/overview', OVERVIEW], [`/api/v1/${BLOCKED_RUN}`, BLOCKED]] as const) {
      const response = await h.fetch(path, { headers: { cookie: `CF_Authorization=${assertion}` } });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
      expect(await response.text(), path).toBe(golden);
      const sent = h.outbound.at(-1);
      expect(sent?.url, path).toBe(`${UPSTREAM}${path.replace('/api/v1/', '/api/newsletter/v1/')}`);
      expect(sent?.method, path).toBe('GET');
      expect(sent?.headers['cf-access-token'], path).toBe(assertion);
      expect(sent?.headers.cookie, path).toBeUndefined();
      expect(sent?.headers['cf-access-jwt-assertion'], path).toBeUndefined();
    }
  });

  it("answers a missing record NOT_FOUND and Access's redirect UNAVAILABLE, never echoing either", async () => {
    const headers = { 'cf-access-jwt-assertion': await login() };
    const missing = await h.fetch('/api/v1/runs/run-1', { headers });
    expect(missing.status).toBe(404);
    const text = await missing.text();
    expect(text).not.toContain('synthetic-upstream-detail');
    const redirected = await h.fetch('/api/v1/sourceCatalog', { headers });
    expect(redirected.status).toBe(503);
    expect(redirected.headers.get('location')).toBeNull();
    expect(await reason(redirected)).toBe('UNAVAILABLE');
    const write = await h.fetch('/api/v1/overview', { method: 'POST', headers });
    expect(write.status).toBe(405);
    expect(await reason(write)).toBe('METHOD_NOT_ALLOWED');
  });

  it('reaches only the issuer keys and Newsletter, never anything else', () => {
    const origins = new Set(h.outbound.map((request) => new URL(request.url).origin));
    expect(origins).toEqual(new Set([ISSUER, UPSTREAM]));
  });
});
