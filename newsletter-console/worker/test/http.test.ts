/**
 * The owner surface in Node with fake bindings: a synthetic Access issuer serves its keys through a stubbed fetch, so
 * the real edge-auth verifier runs, and a fake Newsletter answers the forwarded reads. Every request needs the owner's
 * login; reads only; every method of newsletter.ui.v1 is forwarded with the assertion that was verified, and nothing
 * else.
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

const UPSTREAM = 'https://runtime.example.test';

let issuer: TestIssuer;
let certs: () => Response;
const fetched: string[] = [];
/** Reads that reached the fake Newsletter. */
const forwarded: Request[] = [];
let newsletter: (request: Request) => Response = () => new Response('{}', { headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  issuer = await testIssuer();
});

function env(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  return {
    ASSETS: { fetch: (request: Request) => Promise.resolve(assetFor(new URL(request.url).pathname)) },
    PUBLIC_HOST: HOST,
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: AUDIENCE,
    NEWSLETTER_ORIGIN: UPSTREAM,
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
  forwarded.length = 0;
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    if (url === `${ISSUER}/cdn-cgi/access/certs`) return Promise.resolve(certs());
    if (input instanceof Request && url.startsWith(`${UPSTREAM}/api/newsletter/v1/`)) {
      forwarded.push(input);
      return Promise.resolve(newsletter(input));
    }
    return Promise.reject(new Error('unexpected network'));
  });
}

/** The fake Newsletter answers every read with `body` (200, JSON) until the next call. */
function answerWith(body: string): void {
  newsletter = () => new Response(body, { headers: { 'content-type': 'application/json' } });
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
  it('forwards every method to Newsletter as a GET with the verified assertion only, and passes the answer through', async () => {
    stubCerts();
    const body = '{"name":"overview","time_zone":"America/Los_Angeles","title":"合成"}';
    answerWith(body);
    for (const path of ROUTES) {
      const assertion = await token();
      const response = await call(path, { token: assertion, headers: { cookie: 'CF_Authorization=another-login; other=value', origin: 'https://evil.example.test' } });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(/^application\/json/);
      expect(await response.text(), path).toBe(body);
      expectPrivate(response);
      const sent = forwarded.at(-1);
      expect(sent?.url, path).toBe(`${UPSTREAM}${path.replace('/api/v1/', '/api/newsletter/v1/')}`);
      expect(sent?.method, path).toBe('GET');
      expect(sent?.redirect, path).toBe('manual');
      // The header edge-auth read wins over the cookie, as it did for the verification; nothing else crosses.
      expect([...(sent?.headers.entries() ?? [])].sort(), path).toEqual([['accept', 'application/json'], ['cf-access-token', assertion]]);
    }
    expect(forwarded).toHaveLength(ROUTES.length);
  });

  it('forwards the login from the Access cookie when the header is absent or empty, the last cookie as verified', async () => {
    stubCerts();
    const first = await token();
    const last = await token('owner@example.com', { iat: Math.floor(Date.now() / 1000) - 5 });
    for (const headers of [{ cookie: `CF_Authorization=${last}` }, { cookie: `CF_Authorization=${first}; CF_Authorization=${last}`, 'cf-access-jwt-assertion': '' }]) {
      const response = await handleRequest(new Request(`https://${HOST}/api/v1/overview`, { headers }), env());
      expect(response.status).toBe(200);
      expect(forwarded.at(-1)?.headers.get('cf-access-token')).toBe(last);
    }
  });

  it('answers HEAD from a forwarded GET without the body', async () => {
    stubCerts();
    answerWith('{"name":"overview"}');
    const head = await call('/api/v1/overview', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(forwarded.at(-1)?.method).toBe('GET');
  });

  it("maps Newsletter's answers to the console's own Status, never echoing them", async () => {
    stubCerts();
    for (const [status, httpStatus, reasonCode] of [[404, 404, 'NOT_FOUND'], [400, 400, 'BAD_REQUEST'], [403, 503, 'UNAVAILABLE'], [302, 503, 'UNAVAILABLE'], [500, 503, 'UNAVAILABLE']] as const) {
      newsletter = () => new Response('{"secret":"upstream-detail"}', { status, headers: { 'content-type': 'application/json', location: 'https://login.example.test/' } });
      const response = await call('/api/v1/runs/run-1');
      expect(response.status, String(status)).toBe(httpStatus);
      const text = await response.text();
      expect(text, String(status)).not.toContain('upstream-detail');
      expect(response.headers.get('location'), String(status)).toBeNull();
      expect((JSON.parse(text) as { error: { details: { reason?: string }[] } }).error.details.find((d) => d.reason)?.reason).toBe(reasonCode);
      expectPrivate(response);
    }
  });

  it('is NOT_CONFIGURED without a usable Newsletter origin, sending nothing', async () => {
    stubCerts();
    const response = await call('/api/v1/overview', {}, env({ NEWSLETTER_ORIGIN: 'http://runtime.example.test' }));
    expect([response.status, await reason(response)]).toEqual([503, 'NOT_CONFIGURED']);
    expect(forwarded).toEqual([]);
  });

  it('forwards nothing under the local development bypass, which has no assertion to send', async () => {
    stubCerts();
    fetched.length = 0;
    const local = await handleRequest(new Request('http://127.0.0.1:8796/api/v1/overview'), env({ DEV_AUTH_BYPASS: 'true' }));
    expect([local.status, await reason(local)]).toEqual([503, 'NOT_CONFIGURED']);
    expect(fetched).toEqual([]);
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
    const unknown = await call('/api/v1/runs?filter=x');
    expect([unknown.status, await reason(unknown)]).toEqual([400, 'BAD_REQUEST']);
    expect(forwarded).toEqual([]);
  });

  it('logs the request ID, method, status classes and duration only', async () => {
    stubCerts();
    newsletter = () => new Response('{"secret":"run-secret-id"}', { status: 503 });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const assertion = await token();
    await call('/api/v1/runs/run-secret-id/modelCalls?page_size=7', { token: assertion });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(['event', 'ms', 'request_id', 'rpc', 'status_class', 'upstream']);
    expect(entry).toMatchObject({ event: 'newsletter_console_request', rpc: 'ListModelCalls', status_class: '5xx', upstream: '5xx' });
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
