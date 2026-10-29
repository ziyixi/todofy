/**
 * The owner surface in Node with fake bindings: a synthetic Access issuer serves its keys through a stubbed fetch, so
 * the real edge-auth verifier runs. Every request needs the owner's login; reads only; every method of
 * newsletter.ui.v1 answers UNAVAILABLE/NOT_CONFIGURED until the transport to Newsletter exists.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { handleRequest } from '../src/http.ts';
import { accessClaims, testIssuer, type TestIssuer } from './jwt.ts';

const ISSUER = 'https://synthetic.cloudflareaccess.com';
const AUDIENCE = 'a'.repeat(64);
const HOST = 'news.example.test';
const STATIC = '<!doctype html><title>Newsletter</title>';

// Every route of the service (newsletter_ui_service.proto), as the shared client lays it out.
const ROUTES = [
  '/api/v1/overview',
  '/api/v1/runs?month=2026-10',
  '/api/v1/runs/run-1',
  '/api/v1/runs/run-1/modelCalls',
  '/api/v1/runs:summarizeModelUsage?day_count=30',
  '/api/v1/editions',
  '/api/v1/editions/edition-1',
  '/api/v1/editions/edition-1/rendering',
  '/api/v1/sourceCatalog',
  '/api/v1/backupStatus',
];

let issuer: TestIssuer;
let certs: () => Response;
const fetched: string[] = [];

beforeAll(async () => {
  issuer = await testIssuer();
});

function env(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  return {
    ASSETS: { fetch: (request: Request) => Promise.resolve(assetFor(new URL(request.url).pathname)) },
    PUBLIC_HOST: HOST,
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: AUDIENCE,
    NEWSLETTER_ORIGIN: 'https://runtime.example.test',
    ACCESS_OWNER: 'owner@example.com',
    ACCESS_OWNER_ALIASES: ' ',
    ...overrides,
  } as unknown as Env;
}

function assetFor(path: string): Response {
  if (path.startsWith('/assets/') && path.endsWith('.js')) {
    return new Response('export {}', { headers: { 'content-type': 'text/javascript' } });
  }
  return new Response(STATIC, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function stubCerts(answer: () => Response = () => Response.json(issuer.jwks)): void {
  certs = answer;
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    if (url === `${ISSUER}/cdn-cgi/access/certs`) return Promise.resolve(certs());
    return Promise.reject(new Error('unexpected network'));
  });
}

async function token(email = 'owner@example.com', claims: Record<string, unknown> = {}): Promise<string> {
  return issuer.sign({ ...accessClaims(ISSUER, AUDIENCE, email), ...claims });
}

async function call(path: string, init: RequestInit & { token?: string | null } = {}, bindings = env()): Promise<Response> {
  const headers = new Headers(init.headers);
  const assertion = init.token === undefined ? await token() : init.token;
  if (assertion !== null) headers.set('cf-access-jwt-assertion', assertion);
  return handleRequest(new Request(`https://${HOST}${path}`, { ...init, headers }), bindings);
}

async function reason(response: Response): Promise<string | undefined> {
  const body = await response.json<{ error?: { details?: { '@type'?: string; reason?: string }[] } }>();
  return body.error?.details?.find((detail) => detail['@type']?.endsWith('google.rpc.ErrorInfo'))?.reason;
}

function expectPrivate(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
}

describe('authentication comes first', () => {
  it('answers another host, or plain HTTP, with 404 before reading any token', async () => {
    stubCerts();
    fetched.length = 0;
    for (const url of [`https://other.example.test/api/v1/overview`, `http://${HOST}/api/v1/overview`]) {
      const response = await handleRequest(new Request(url, { headers: { 'cf-access-jwt-assertion': await token() } }), env());
      expect(response.status, url).toBe(404);
    }
    expect(fetched).toEqual([]);
  });

  it('refuses a request without the owner login, on the API and on the UI alike', async () => {
    stubCerts();
    for (const path of ['/', '/assets/index.js', ...ROUTES]) {
      const response = await call(path, { token: null });
      expect(response.status, path).toBe(401);
      expect(await reason(response), path).toBe('UNAUTHORIZED');
      expectPrivate(response);
    }
  });

  it('refuses a valid login of anyone else, an expired one, another audience and a forged one', async () => {
    stubCerts();
    const now = Math.floor(Date.now() / 1000);
    for (const assertion of [
      await token('someone@example.com'),
      await token('owner@example.com', { exp: now - 600, iat: now - 4000, nbf: now - 4000 }),
      await token('owner@example.com', { aud: ['b'.repeat(64)] }),
      `${(await token()).split('.').slice(0, 2).join('.')}.AAAA`,
      'not-a-token',
    ]) {
      const response = await call('/api/v1/overview', { token: assertion });
      expect(response.status).toBe(401);
      expect(await reason(response)).toBe('UNAUTHORIZED');
    }
  });

  it('accepts the owner in either letter case, from the header or the Access cookie, and an alias', async () => {
    stubCerts();
    expect((await call('/', { token: await token('OWNER@example.com') })).status).toBe(200);
    const cookie = await handleRequest(new Request(`https://${HOST}/`, { headers: { cookie: `CF_Authorization=${await token()}` } }), env());
    expect(cookie.status).toBe(200);
    const alias = await call('/', { token: await token('alias@example.com') }, env({ ACCESS_OWNER_ALIASES: 'alias@example.com' }));
    expect(alias.status).toBe(200);
  });

  it('is UNAVAILABLE, never open, while the Access audience is not configured or the keys cannot be read', async () => {
    stubCerts();
    fetched.length = 0;
    const unconfigured = await call('/api/v1/overview', {}, env({ ACCESS_AUDIENCE: undefined }));
    expect(unconfigured.status).toBe(503);
    expect(await reason(unconfigured)).toBe('UNAVAILABLE');
    expect(fetched).toEqual([]);
    const ownerless = await call('/', {}, env({ ACCESS_OWNER: undefined }));
    expect(ownerless.status).toBe(503);
    // A fresh isolate: the verifier caches the keys it has read.
    vi.resetModules();
    const { handleRequest: fresh } = await import('../src/http.ts');
    stubCerts(() => new Response('down', { status: 500 }));
    const down = await fresh(new Request(`https://${HOST}/api/v1/overview`, { headers: { 'cf-access-jwt-assertion': await token() } }), env());
    expect([down.status, await reason(down)]).toEqual([503, 'UNAVAILABLE']);
  });

  it('refuses the development bypass on a production request', async () => {
    stubCerts();
    const response = await call('/api/v1/overview', { token: null }, env({ DEV_AUTH_BYPASS: 'true' }));
    expect(response.status).toBe(503);
    expect(await reason(response)).toBe('UNAVAILABLE');
  });
});

describe('the owner API', () => {
  it('answers every method UNAVAILABLE with NOT_CONFIGURED until reads reach Newsletter', async () => {
    stubCerts();
    for (const path of ROUTES) {
      const response = await call(path);
      expect(response.status, path).toBe(503);
      expect(response.headers.get('content-type'), path).toMatch(/^application\/json/);
      expect(await reason(response), path).toBe('NOT_CONFIGURED');
      expectPrivate(response);
    }
    const head = await call('/api/v1/overview', { method: 'HEAD' });
    expect(head.status).toBe(503);
    expect(await head.text()).toBe('');
  });

  it('admits reads only, answering anything else METHOD_NOT_ALLOWED on the API and the UI alike', async () => {
    stubCerts();
    for (const path of ['/api/v1/overview', '/']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await call(path, { method, ...(method === 'OPTIONS' ? {} : { body: '{}' }) });
        expect(response.status, `${method} ${path}`).toBe(405);
        expect(response.headers.get('allow'), method).toBe('GET, HEAD');
        expect(await reason(response), method).toBe('METHOD_NOT_ALLOWED');
        expectPrivate(response);
      }
    }
  });

  it('answers an unknown API path 404 and a malformed query BAD_REQUEST', async () => {
    stubCerts();
    expect((await call('/api/v1/notAMethod')).status).toBe(404);
    expect((await call('/api/newsletter/v1/overview')).status).toBe(404);
    const bad = await call('/api/v1/runs?page_size=many');
    expect([bad.status, await reason(bad)]).toEqual([400, 'BAD_REQUEST']);
  });

  it('logs the request ID, method, status class and duration only', async () => {
    stubCerts();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const assertion = await token();
    await call('/api/v1/runs/run-secret-id/modelCalls?page_size=7', { token: assertion });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(['event', 'ms', 'request_id', 'rpc', 'status_class']);
    expect(entry).toMatchObject({ event: 'newsletter_console_request', rpc: 'ListModelCalls', status_class: '5xx' });
    for (const secret of ['run-secret-id', 'page_size', assertion, 'owner@example.com']) expect(lines[0]).not.toContain(secret);
  });
});

describe('the UI', () => {
  it('serves the single-page app to the owner under the strict CSP, never cached', async () => {
    stubCerts();
    for (const path of ['/', '/issues/edition-1']) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(STATIC);
      expectPrivate(response);
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    }
  });

  it('lets the browser keep hashed build output, and only that', async () => {
    stubCerts();
    const script = await call('/assets/index-abc123.js');
    expect(script.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const fallback = await call('/assets/missing.css');
    expect(fallback.headers.get('cache-control')).toBe('no-store');
  });
});
