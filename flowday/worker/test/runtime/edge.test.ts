/**
 * The Worker's edge (../../src/router.ts, http.ts, assets.ts, e2e.ts): Access on every path but /health and the
 * exact PWA files, CSRF and Origin on mutations, the private headers, the page CSP made of the served HTML's inline
 * script hashes, and the E2E routes that only a loopback dev-bypass request with E2E_TEST_ROUTES can reach.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PWA_PUBLIC_PATHS } from '../../src/assets.ts';
import { accessClaims, testIssuer, type TestIssuer } from '../jwt.ts';
import { SYNTHETIC_BINDINGS, TEST_PAGE, startHarness, type Harness } from './harness.ts';

/** The ErrorInfo reason of a google.rpc.Status body. */
async function reasonOf(response: Response): Promise<string | undefined> {
  const body = await response.json<{ error: { details?: { '@type': string; reason?: string }[] } }>();
  return body.error.details?.find((detail) => detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')?.reason;
}

const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';

describe('with Cloudflare Access (no dev bypass)', () => {
  let h: Harness;
  let issuer: TestIssuer;
  beforeAll(async () => {
    issuer = await testIssuer();
    h = await startHarness({
      bindings: { DEV_AUTH_BYPASS: 'false', PUBLIC_HOST: 'flowday.example.com', E2E_TEST_ROUTES: 'true' },
      routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(issuer.jwks)]]),
    });
  });
  afterAll(async () => {
    await h.dispose();
  });

  const jwt = (email = 'owner@example.com') => issuer.sign(accessClaims(ISSUER, AUDIENCE, email));

  it('every exact PWA path answers 200 without a JWT; the service worker carries its scope header', async () => {
    for (const path of PWA_PUBLIC_PATHS) {
      const response = await h.fetch(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const sw = await h.fetch('/pwa/sw');
    expect(sw.headers.get('service-worker-allowed')).toBe('/');
    expect(sw.headers.get('content-type')).toMatch(/^application\/javascript/);
    expect((await h.fetch('/pwa/manifest.webmanifest')).headers.get('content-type')).toBe('application/manifest+json');
  });

  it('everything else needs the JWT: other /pwa/ files, the page, the API, the E2E routes', async () => {
    for (const path of ['/', '/index.html', '/pwa/sw.js', '/pwa/other.png', '/pwa/', '/pwa/icon-192x192.png/', '/api/v1/tasks', '/api/v1/settings', '/api/csrf', '/api/test/health', '/_next/static/chunks/app.js']) {
      const response = await h.fetch(path);
      expect(response.status, path).toBe(401);
      expect(await reasonOf(response), path).toBe('UNAUTHORIZED');
    }
    expect((await h.fetch('/api/v1/tasks', { headers: { 'cf-access-jwt-assertion': await jwt('someone@example.com') } })).status).toBe(401);
  });

  it("the old UI's routes answer an expired sign-in in their old envelope, which the old UI reads as a session to renew", async () => {
    const response = await h.fetch('/api/tasks');
    expect(response.status).toBe(401);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe('unauthorized');
    const signedIn = await h.fetch('/api/flows', { headers: { 'cf-access-jwt-assertion': await jwt() } });
    expect(signedIn.status).toBe(410);
    expect((await signedIn.json<{ error: { code: string } }>()).error.code).toBe('reload_required');
  });

  it('/health is public and says nothing but the service, status and build', async () => {
    expect(await (await h.fetch('/health')).json()).toEqual({ service: 'flowday', status: 'ok', build: 'test' });
  });

  it('the owner JWT reads the API and the page; the E2E routes stay 404 without the dev bypass', async () => {
    const headers = { 'cf-access-jwt-assertion': await jwt() };
    expect((await h.fetch('/api/v1/tasks', { headers })).status).toBe(200);
    expect((await h.fetch('/', { headers })).status).toBe(200);
    expect((await h.fetch('/api/test/health', { headers })).status).toBe(404);
    expect((await h.fetch('/api/test/reset', { method: 'POST', headers })).status).toBe(404);
  });

  it('a mutation needs the CSRF token, its cookie and the public Origin', async () => {
    const token = await jwt();
    const csrf = await h.fetch('/api/csrf', { headers: { 'cf-access-jwt-assertion': token } });
    const { token: csrfToken } = await csrf.json<{ token: string }>();
    const cookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const send = (headers: Record<string, string>) =>
      h.fetch('/api/v1/settings?update_mask=day_capacity_minutes', {
        method: 'PATCH',
        headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ day_capacity_minutes: 300 }),
      });
    expect((await send({ origin: 'https://flowday.example.com', 'x-csrf-token': csrfToken, cookie })).status).toBe(200);
    for (const headers of [
      { origin: 'https://flowday.example.com', cookie },
      { origin: 'https://flowday.example.com', 'x-csrf-token': csrfToken },
      { origin: 'https://evil.example.com', 'x-csrf-token': csrfToken, cookie },
      { 'x-csrf-token': csrfToken, cookie },
    ]) {
      const response = await send(headers);
      expect(response.status).toBe(403);
      expect(await reasonOf(response)).toBe('CSRF_FAILED');
    }
  });
});

describe('with the loopback dev bypass', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ bindings: { E2E_TEST_ROUTES: 'true' } });
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('the page CSP allows exactly the inline scripts of the served HTML, by SHA-256', async () => {
    const response = await h.fetch('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(TEST_PAGE);
    const csp = response.headers.get('content-security-policy') ?? '';
    const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
    expect(csp).toContain(`script-src 'self' ${hash('window.a=1')} ${hash('self.__next_f=[]')};`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('hashed build files are cached as immutable; API answers are private and no-store', async () => {
    expect((await h.fetch('/_next/static/chunks/app.js')).headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const api = await h.fetch('/api/v1/tasks');
    expect(api.headers.get('cache-control')).toBe('no-store');
    expect(api.headers.get('content-security-policy')).toContain("script-src 'self';");
    expect(api.headers.get('x-flowday-rows-written')).toBe('0');
  });

  it('the E2E routes reset and seed synthetic data over loopback', async () => {
    expect(await (await h.fetch('/api/test/health')).json()).toEqual({ ok: true });
    const seeded = await h.fetch('/api/test/seed', { method: 'POST', body: JSON.stringify({ tasks: [{ id: 'a', title: 'Seeded' }], flows: { '2026-04-13': ['a'] } }) });
    expect(seeded.status).toBe(200);
    expect((await (await h.fetch('/api/v1/tasks')).json<{ tasks: { name: string }[] }>()).tasks.map((task) => task.name)).toEqual(['tasks/a']);
    expect(await (await h.fetch('/api/test/sync-orphans', { method: 'POST', body: '{}' })).json()).toEqual({ ok: true, changed: 0 });
    expect((await h.fetch('/api/test/reset', { method: 'POST' })).status).toBe(200);
    expect(await (await h.fetch('/api/v1/tasks')).json()).toEqual({});
  });

  it('a seeded Todoist key is sealed like one saved in Settings', async () => {
    await h.fetch('/api/test/seed', { method: 'POST', body: JSON.stringify({ settings: { todoist_api_key: 'saved-secret-key' } }) });
    const [row] = await h.sql<{ value: string }>("SELECT value FROM settings WHERE key = 'todoist_api_key'");
    expect(row?.value).toMatch(/^v1\./);
    expect((await (await h.fetch('/api/v1/settings')).json<{ todoist_api_key_set: boolean }>()).todoist_api_key_set).toBe(true);
  });

  it('a request that came through Cloudflare (cf-ray) never gets the bypass or the E2E routes', async () => {
    const response = await h.fetch('/api/test/health', { headers: { 'cf-ray': 'synthetic' } });
    expect(response.status).toBe(503);
    expect(await reasonOf(response)).toBe('ACCESS_NOT_CONFIGURED');
  });

  it('logs one line per mutation with IDs, route, status and row counts only: no title, note, token or key', async () => {
    h.logs.length = 0;
    await h.api.updateSettings({ settings: { name: 'settings', todoistApiKey: 'synthetic-secret-key' }, updateMask: { paths: ['todoist_api_key'] } });
    await h.api.createTask({ task: { title: 'Synthetic private title' } });
    await h.api.updateNote({ note: { name: 'flows/2026-04-13/notes/t1', content: 'Synthetic private note' } });
    await h.call((api) => api.getTask({ name: 'tasks/synthetic-private-id' }));
    const lines = h.logs.filter((line) => line.startsWith('{'));
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(['code', 'method', 'request_id', 'route', 'rows_read', 'rows_written', 'status']);
    }
    expect(lines.map((line) => (JSON.parse(line) as { route: string; code: string | null }).route)).toEqual(['UpdateSettings', 'CreateTask', 'UpdateNote', 'GetTask']);
    expect((JSON.parse(lines[3] ?? '{}') as { code: string }).code).toBe('NOT_FOUND');
    const all = h.logs.join('\n');
    for (const secret of ['synthetic-secret-key', 'Synthetic private title', 'Synthetic private note', 'synthetic-private-id', 'owner@example.com']) expect(all).not.toContain(secret);
  });

  it('refuses bodies over 256 KiB, non-JSON bodies and unknown methods', async () => {
    const big = await h.mutate('PATCH', '/api/v1/flows/2026-04-13/notes/t1', { content: 'x'.repeat(300 * 1024) });
    expect(big.status).toBe(400);
    expect((await h.fetch('/api/v1/flows', { method: 'POST' })).status).toBe(405);
    expect((await h.fetch('/', { method: 'POST' })).status).toBe(405);
    expect((await h.fetch('/api/nothing-here')).status).toBe(404);
  });
});

describe('without E2E_TEST_ROUTES or CREDENTIAL_KEY', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ bindings: { CREDENTIAL_KEY: '' } });
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('the E2E routes do not exist even over loopback', async () => {
    expect((await h.fetch('/api/test/health')).status).toBe(404);
    expect((await h.fetch('/api/test/reset', { method: 'POST' })).status).toBe(404);
  });

  it('without the credential key a Todoist key is refused (503), never stored in plain text', async () => {
    const result = await h.call((api) => api.updateSettings({ settings: { name: 'settings', todoistApiKey: 'synthetic-secret-key' }, updateMask: { paths: ['todoist_api_key'] } }));
    expect(result.status).toMatchObject({ httpStatus: 503, reason: 'NOT_CONFIGURED' });
    expect(result.rowsWritten).toBe(0);
    expect(await h.sql("SELECT * FROM settings WHERE key = 'todoist_api_key'")).toEqual([]);
  });
});
