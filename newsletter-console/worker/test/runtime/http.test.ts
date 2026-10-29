/**
 * The console Worker in workerd, as deployed (no dev bypass): the owner's login is verified against a synthetic
 * issuer whose keys the outbound handler serves, every read answers NOT_CONFIGURED until the transport to Newsletter
 * exists, and nothing else leaves the Worker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessClaims, testIssuer, type TestIssuer } from '../jwt.ts';
import { AUDIENCE, ISSUER, PAGE, startHarness, type Harness } from './harness.ts';

let h: Harness;
let issuer: TestIssuer;

beforeAll(async () => {
  issuer = await testIssuer();
  h = await startHarness(issuer.jwks);
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
  it('needs the owner login on every path', async () => {
    for (const path of ['/', '/api/v1/overview']) {
      const anonymous = await h.fetch(path);
      expect(anonymous.status, path).toBe(401);
      expect(await reason(anonymous), path).toBe('UNAUTHORIZED');
      const other = await h.fetch(path, { headers: { 'cf-access-jwt-assertion': await login('someone@example.com') } });
      expect(other.status, path).toBe(401);
      await other.text();
    }
  });

  it('serves the UI and answers every read NOT_CONFIGURED for the owner', async () => {
    const page = await h.fetch('/', { headers: { cookie: `CF_Authorization=${await login()}` } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const overview = await h.fetch('/api/v1/overview', { headers: { 'cf-access-jwt-assertion': await login() } });
    expect(overview.status).toBe(503);
    expect(overview.headers.get('cache-control')).toBe('no-store');
    expect(await reason(overview)).toBe('NOT_CONFIGURED');
    const write = await h.fetch('/api/v1/overview', { method: 'POST', headers: { 'cf-access-jwt-assertion': await login() } });
    expect(write.status).toBe(405);
    expect(await reason(write)).toBe('METHOD_NOT_ALLOWED');
  });

  it('reaches only the issuer keys, never Newsletter or anything else', () => {
    expect(new Set(h.outbound)).toEqual(new Set([`${ISSUER}/cdn-cgi/access/certs`]));
  });
});
