import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiError, CsrfResponse, HealthResponse } from '../src/api-types.ts';
import type { RegistryResponse } from '../src/api-v2-types.ts';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { CSRF_COOKIE, MESSAGES } from '../src/http.ts';
import { accessClaims, testIssuer, type TestIssuer } from './jwt.ts';

const ISSUER = 'https://synthetic.cloudflareaccess.com';
const AUDIENCE = 'a'.repeat(64);
const OWNER = 'Owner@Example.com';
const HOST = 'home.example.com';
const ORIGIN = `https://${HOST}`;

/** Worker handlers receive requests with incoming cf properties; tests have none. */
const incoming = (...args: ConstructorParameters<typeof Request>): Request<unknown, IncomingRequestCfProperties> =>
  new Request(...args) as unknown as Request<unknown, IncomingRequestCfProperties>;

let issuer: TestIssuer;
let certRequests: string[];

beforeAll(async () => {
  issuer = await testIssuer();
});

beforeEach(() => {
  certRequests = [];
  vi.stubGlobal('fetch', (url: string) => {
    certRequests.push(url);
    if (url === `${ISSUER}/cdn-cgi/access/certs`) return Promise.resolve(Response.json(issuer.jwks));
    return Promise.resolve(new Response('unexpected', { status: 599 }));
  });
});

interface HomeCalls {
  /** v2View calls as `<view>:<refresh>`. */
  views: string[];
  startCanary: number;
  guard: string[];
  /** The request time (`at`) of every v2View, startCanary and setGuardOverride call, in order. */
  at: (number | null)[];
}

function makeEnv(overrides: Partial<Env> = {}, answers: { startCanary?: unknown; guard?: unknown; view?: () => unknown } = {}) {
  const calls: HomeCalls = { views: [], startCanary: 0, guard: [], at: [] };
  const stub = {
    startCanary(at: number | null) {
      calls.startCanary++;
      calls.at.push(at);
      return Promise.resolve(answers.startCanary ?? { ok: true, run: { run_id: 'canary-manual-20260929T160000Z' } });
    },
    setGuardOverride(level: string, at: number | null) {
      calls.guard.push(level);
      calls.at.push(at);
      return Promise.resolve(answers.guard ?? { guard: { desired: { level } } });
    },
    tick: vi.fn(() => Promise.resolve({ ran: true })),
    v2View: vi.fn((view: string, refresh: boolean, ifNoneMatch: string | null, at: number | null) => {
      calls.views.push(`${view}:${String(refresh)}`);
      calls.at.push(at);
      if (answers.view) return Promise.resolve(answers.view());
      return Promise.resolve(ifNoneMatch === '"7"' ? { etag: '"7"', body: null } : { etag: '"7"', body: JSON.stringify({ view, refresh }) });
    }),
  };
  const assets: string[] = [];
  const env = {
    HOME: { idFromName: (name: string) => name, get: () => stub },
    ASSETS: {
      fetch: (request: Request) => {
        assets.push(new URL(request.url).pathname);
        const path = new URL(request.url).pathname;
        return Promise.resolve(
          path.startsWith('/assets/')
            ? new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } })
            : new Response('<!doctype html><title>家</title>', { headers: { 'content-type': 'text/html' } }),
        );
      },
    },
    MAIL_HERO: {},
    TODOFY: {},
    PUBLIC_HOST: HOST,
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: AUDIENCE,
    ACCOUNT_ID: '0'.repeat(32),
    ACCESS_OWNER: OWNER,
    ACCESS_OWNER_ALIASES: 'second@example.org',
    CSRF_SIGNING_KEY: 'ab'.repeat(32),
    BUILD_SHA: 'abc123',
    ...overrides,
  } as unknown as Env;
  return { env, calls, stub, assets };
}

async function token(email = 'owner@example.com', extra: Record<string, unknown> = {}): Promise<string> {
  return issuer.sign({ ...accessClaims(ISSUER, AUDIENCE, email), ...extra });
}

async function call(env: Env, path: string, init: RequestInit & { jwt?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const jwt = init.jwt === undefined ? await token() : init.jwt;
  if (jwt !== null) headers.set('cf-access-jwt-assertion', jwt);
  return worker.fetch(incoming(`https://${HOST}${path}`, { ...init, headers }), env);
}

async function errorCode(response: Response): Promise<string> {
  const body = await response.json<ApiError>();
  expect(body.error.message).toBe(MESSAGES[body.error.code]);
  expect(body.error.request_id).toMatch(/^[0-9a-f]{16}$/);
  return body.error.code;
}

function expectPrivate(response: Response, cache = 'no-store'): void {
  expect(response.headers.get('cache-control')).toBe(cache);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
}

async function csrf(env: Env): Promise<{ token: string; cookie: string }> {
  const response = await call(env, '/api/v2/csrf');
  expect(response.status).toBe(200);
  const body = await response.json<CsrfResponse>();
  const setCookie = response.headers.get('set-cookie') ?? '';
  expect(setCookie).toMatch(new RegExp(`^${CSRF_COOKIE}=[^;]+; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$`));
  return { token: body.token, cookie: setCookie.split(';')[0] ?? '' };
}

async function mutate(
  env: Env,
  path: string,
  body: unknown,
  options: { origin?: string; csrf?: { token: string; cookie: string } | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const pair = options.csrf === undefined ? await csrf(env) : options.csrf;
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: options.origin ?? ORIGIN, ...options.headers };
  if (pair !== null) {
    headers['x-csrf-token'] = pair.token;
    headers.cookie = pair.cookie;
  }
  return call(env, path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

describe('/health', () => {
  it('answers without an app login and without the Durable Object', async () => {
    const { env, calls } = makeEnv();
    const response = await call(env, '/health', { jwt: null });
    expect(response.status).toBe(200);
    expect(await response.json<HealthResponse>()).toEqual({ service: 'home', status: 'ok', build: 'abc123' });
    expectPrivate(response);
    expect(calls.views).toEqual([]);
    expect((await call(env, '/health', { method: 'POST', jwt: null })).status).toBe(405);
  });
});

describe('Access', () => {
  it('lets the owner, an alias and any ASCII case of them in', async () => {
    const { env } = makeEnv();
    for (const email of ['owner@example.com', 'OWNER@EXAMPLE.COM', 'Second@Example.org']) {
      const response = await call(env, '/api/v2/home', { jwt: await token(email) });
      expect(response.status).toBe(200);
    }
    // The key set was fetched once for all of them.
    expect(certRequests).toEqual([`${ISSUER}/cdn-cgi/access/certs`]);
  });

  it('refuses missing, invalid, expired, foreign and wrong-audience tokens', async () => {
    const { env, calls } = makeEnv();
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      null,
      'not-a-jwt',
      await token('someone@example.com'),
      await token('owner@example.com', { exp: now - 1 }),
      await token('owner@example.com', { aud: ['b'.repeat(64)] }),
      await token('owner@example.com', { iss: 'https://other.cloudflareaccess.com' }),
      await token('Kowner@example.com'),
      (await token()).slice(0, -4) + 'AAAA',
    ];
    for (const jwt of cases) {
      const response = await call(env, '/api/v2/home', { jwt });
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('unauthorized');
      expectPrivate(response);
    }
    expect(calls.views).toEqual([]);
  });

  it('guards the UI assets too', async () => {
    const { env, assets } = makeEnv();
    expect((await call(env, '/', { jwt: null })).status).toBe(401);
    expect(assets).toEqual([]);
    const page = await call(env, '/');
    expect(page.status).toBe(200);
    expectPrivate(page);
    const script = await call(env, '/assets/index-abc.js');
    expectPrivate(script, 'private, max-age=31536000, immutable');
    expect((await call(env, '/', { method: 'POST' })).status).toBe(405);
  });

  it('fails closed on bad configuration and unreachable keys', async () => {
    const bad = makeEnv({ ACCESS_AUDIENCE: '' });
    const response = await call(bad.env, '/api/v2/home');
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('access_not_configured');
    const noOwner = makeEnv({ ACCESS_OWNER: undefined } as unknown as Partial<Env>);
    expect(await errorCode(await call(noOwner.env, '/'))).toBe('access_not_configured');
    const other = makeEnv({ ACCESS_ISSUER: 'https://unreachable.cloudflareaccess.com' });
    const keys = await call(other.env, '/api/v2/home', { jwt: await issuer.sign(accessClaims('https://unreachable.cloudflareaccess.com', AUDIENCE, 'owner@example.com')) });
    expect(keys.status).toBe(503);
    expect(await errorCode(keys)).toBe('unavailable');
  });

  it('allows the dev bypass only on loopback http without cf-ray, and refuses it elsewhere', async () => {
    const { env } = makeEnv({ DEV_AUTH_BYPASS: 'true' });
    const local = await worker.fetch(incoming('http://127.0.0.1:8787/api/v2/home'), env);
    expect(local.status).toBe(200);
    const viaEdge = await worker.fetch(incoming('http://127.0.0.1:8787/api/v2/home', { headers: { 'cf-ray': 'x' } }), env);
    expect(viaEdge.status).toBe(503);
    const production = await call(env, '/api/v2/home');
    expect(production.status).toBe(503);
    expect(await errorCode(production)).toBe('access_not_configured');
  });

  it('pins the request time to DEV_NOW only for requests the loopback dev bypass signed in', async () => {
    const NOW = '2026-10-01T12:00:00Z';
    const local = async (env: Env, path: string, body?: unknown): Promise<Response> => {
      const url = `http://127.0.0.1:8787${path}`;
      if (body === undefined) return worker.fetch(incoming(url), env);
      const issued = await worker.fetch(incoming('http://127.0.0.1:8787/api/v2/csrf'), env);
      const { token: csrfToken } = await issued.json<CsrfResponse>();
      const cookie = (issued.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const headers = { origin: 'http://127.0.0.1:8787', 'x-csrf-token': csrfToken, cookie, 'content-type': 'application/json' };
      return worker.fetch(incoming(url, { method: 'POST', headers, body: JSON.stringify(body) }), env);
    };

    // Bypassed: every request-driven call of the object takes DEV_NOW as now.
    const pinned = makeEnv({ DEV_AUTH_BYPASS: 'true', DEV_NOW: NOW });
    expect((await local(pinned.env, '/api/v2/home?refresh=1')).status).toBe(200);
    expect((await local(pinned.env, '/api/v2/canary', { canary_id: 'mail-todofy' })).status).toBe(202);
    expect((await local(pinned.env, '/api/v2/guard', { level: 'shed' })).status).toBe(200);
    expect(pinned.calls.at).toEqual([Date.parse(NOW), Date.parse(NOW), Date.parse(NOW)]);

    // Unset or not an RFC 3339 UTC instant: the object's own clock.
    for (const value of ['', ' ', '2026-10-01 12:00:00', '2026-10-01T12:00:00+02:00', '1759320000000', 'now']) {
      const { env, calls } = makeEnv({ DEV_AUTH_BYPASS: 'true', DEV_NOW: value });
      expect((await local(env, '/api/v2/ops')).status).toBe(200);
      expect(calls.at, value).toEqual([null]);
    }

    // A request Access verified never reads it, even where the Worker holds a DEV_NOW.
    const verified = makeEnv({ DEV_NOW: NOW });
    expect((await call(verified.env, '/api/v2/home')).status).toBe(200);
    expect((await mutate(verified.env, '/api/v2/canary', { canary_id: 'mail-todofy' })).status).toBe(202);
    expect((await mutate(verified.env, '/api/v2/guard', { level: 'normal' })).status).toBe(200);
    expect(verified.calls.at).toEqual([null, null, null]);
    // And with the bypass switched on as well, the edge's requests are refused before the object is called.
    const both = makeEnv({ DEV_AUTH_BYPASS: 'true', DEV_NOW: NOW });
    expect((await call(both.env, '/api/v2/home')).status).toBe(503);
    expect(both.calls.at).toEqual([]);
  });
});

describe('CSRF and mutations', () => {
  it('issues a signed token and cookie', async () => {
    const { env } = makeEnv();
    const pair = await csrf(env);
    expect(pair.token.split('.')).toHaveLength(2);
    expect(pair.cookie).toBe(`${CSRF_COOKIE}=${pair.token}`);
  });

  it('starts a canary with Origin + CSRF', async () => {
    const { env, calls } = makeEnv();
    const response = await mutate(env, '/api/v2/canary', { canary_id: 'mail-todofy' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ run: { run_id: 'canary-manual-20260929T160000Z' } });
    expect(calls.startCanary).toBe(1);
  });

  it('refuses a wrong Origin, a missing or foreign token, before reading the body or calling the object', async () => {
    const { env, calls } = makeEnv();
    const pair = await csrf(env);
    const cases = [
      await mutate(env, '/api/v2/canary', { canary_id: 'mail-todofy' }, { origin: 'https://evil.example.com', csrf: pair }),
      await mutate(env, '/api/v2/canary', { canary_id: 'mail-todofy' }, { origin: 'http://home.example.com', csrf: pair }),
      await mutate(env, '/api/v2/canary', { canary_id: 'mail-todofy' }, { csrf: null }),
      await mutate(env, '/api/v2/canary', { canary_id: 'mail-todofy' }, { csrf: { token: pair.token, cookie: `${CSRF_COOKIE}=other` } }),
      await mutate(env, '/api/v2/guard', 'not json', { csrf: { token: `${pair.token}x`, cookie: `${CSRF_COOKIE}=${pair.token}x` } }),
    ];
    for (const response of cases) {
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('csrf_failed');
    }
    // A token minted with another key does not verify.
    const other = makeEnv({ CSRF_SIGNING_KEY: 'cd'.repeat(32) });
    expect((await mutate(env, '/api/v2/guard', { level: 'shed' }, { csrf: await csrf(other.env) })).status).toBe(403);
    expect(calls.startCanary).toBe(0);
    expect(calls.guard).toEqual([]);
  });

  it('needs a signing key for the CSRF token and every mutation', async () => {
    const { env, calls } = makeEnv({ CSRF_SIGNING_KEY: 'short' });
    expect(await errorCode(await call(env, '/api/v2/csrf'))).toBe('not_configured');
    const response = await mutate(env, '/api/v2/guard', { level: 'shed' }, { csrf: { token: 'a.b', cookie: `${CSRF_COOKIE}=a.b` } });
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('not_configured');
    expect(calls.guard).toEqual([]);
    // Reads keep working.
    expect((await call(env, '/api/v2/home')).status).toBe(200);
  });

  it('sets the guard override from {level}', async () => {
    const { env, calls } = makeEnv();
    const response = await mutate(env, '/api/v2/guard', { level: 'normal' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ guard: { desired: { level: 'normal' } } });
    expect(calls.guard).toEqual(['normal']);
  });

  it('refuses malformed bodies with 400', async () => {
    const { env, calls } = makeEnv();
    for (const body of ['not json', '[]', JSON.stringify({ level: 'panic' }), JSON.stringify({ level: 'shed', extra: 1 }), JSON.stringify({ level: 'shed', pad: 'x'.repeat(2000) })]) {
      const response = await mutate(env, '/api/v2/guard', body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('bad_request');
    }
    for (const body of ['', {}, { run_id: 'mine' }, { canary_id: 'other' }, { canary_id: 'mail-todofy', extra: 1 }]) {
      expect(await errorCode(await mutate(env, '/api/v2/canary', body))).toBe('bad_request');
    }
    expect(calls.guard).toEqual([]);
    expect(calls.startCanary).toBe(0);
  });

  it('maps the object\'s refusals to 409 and 429, and its failure to 503', async () => {
    for (const [answer, status, code] of [
      [{ ok: false, code: 'canary_disabled' }, 409, 'canary_disabled'],
      [{ ok: false, code: 'canary_active' }, 409, 'canary_active'],
      [{ ok: false, code: 'canary_limit' }, 429, 'canary_limit'],
    ] as const) {
      const { env } = makeEnv({}, { startCanary: answer });
      const response = await mutate(env, '/api/v2/canary', { canary_id: 'mail-todofy' });
      expect(response.status).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
    // The switch names the variable that turns it back on.
    const disabled = await mutate(makeEnv({}, { startCanary: { ok: false, code: 'canary_disabled' } }).env, '/api/v2/canary', { canary_id: 'mail-todofy' });
    expect((await disabled.json<ApiError>()).error.message).toBe('金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）');
    const { env, stub } = makeEnv();
    stub.startCanary = () => Promise.reject(new Error('object reset'));
    stub.setGuardOverride = () => Promise.reject(new Error('object reset'));
    for (const [path, body] of [['/api/v2/canary', { canary_id: 'mail-todofy' }], ['/api/v2/guard', { level: 'shed' }]] as const) {
      const response = await mutate(env, path, body);
      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe('unavailable');
    }
  });

  it('reads at most 1 KiB of a chunked body (no Content-Length) and never buffers the rest', async () => {
    const { env, calls } = makeEnv();
    const pair = await csrf(env);
    let pulled = 0;
    let cancelled = false;
    // An endless upload: 64 KiB chunks until cancelled.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(65_536).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = incoming(`https://${HOST}/api/v2/guard`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': await token(), origin: ORIGIN, 'x-csrf-token': pair.token, cookie: pair.cookie },
      body: endless,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('bad_request');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(3);
    expect(calls.guard).toEqual([]);

    // A small chunked body is read normally.
    const small = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"level":'));
        controller.enqueue(new TextEncoder().encode('"shed"}'));
        controller.close();
      },
    });
    const ok = await worker.fetch(
      incoming(`https://${HOST}/api/v2/guard`, {
        method: 'POST',
        headers: { 'cf-access-jwt-assertion': await token(), origin: ORIGIN, 'x-csrf-token': pair.token, cookie: pair.cookie },
        body: small,
        duplex: 'half',
      } as RequestInit),
      env,
    );
    expect(ok.status).toBe(200);
    expect(calls.guard).toEqual(['shed']);
    // A declared length above the limit or a malformed one is refused before reading.
    for (const length of ['1025', 'abc', '-1']) {
      const refused = await mutate(env, '/api/v2/guard', { level: 'shed' }, { csrf: pair, headers: { 'content-length': length } });
      expect(refused.status, length).toBe(400);
    }
    expect(calls.guard).toEqual(['shed']);
  });
});

describe('routing', () => {
  it('passes only ?refresh=1 on as a refresh', async () => {
    const { env, calls } = makeEnv();
    await call(env, '/api/v2/home');
    await call(env, '/api/v2/home?refresh=1');
    await call(env, '/api/v2/home?refresh=yes');
    expect(calls.views).toEqual(['home:false', 'home:true', 'home:false']);
  });

  it('answers unknown API paths 404 and wrong methods 405 with Allow', async () => {
    const { env } = makeEnv();
    for (const path of ['/api/v2/nothing', '/api/v1/overview', '/api/v1/csrf']) {
      const missing = await call(env, path);
      expect(missing.status, path).toBe(404);
      expect(await errorCode(missing)).toBe('not_found');
    }
    // v1 is retired: its mutations are unknown paths too (404 before any CSRF check).
    expect((await call(env, '/api/v1/guard', { method: 'POST', body: '{"level":"shed"}' })).status).toBe(404);
    expect(await errorCode(await call(env, '/api'))).toBe('not_found');
    const wrong = await call(env, '/api/v2/canary');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    expect(await errorCode(wrong)).toBe('method_not_allowed');
    expect((await call(env, '/api/v2/home', { method: 'POST' })).headers.get('allow')).toBe('GET');
  });

  it('turns a failing Durable Object into 503 unavailable', async () => {
    const { env } = makeEnv({}, { view: () => { throw new Error('storage exploded with detail'); } });
    const response = await call(env, '/api/v2/home');
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('exploded');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'unavailable' } });
  });

  it('logs only the request ID, status and code of an error', async () => {
    const log = vi.spyOn(console, 'log');
    const { env } = makeEnv();
    const jwt = await token('someone@example.com');
    await call(env, '/api/v2/home', { jwt });
    const lines = log.mock.calls.map((args) => String(args[0]));
    expect(lines).toHaveLength(1);
    expect(Object.keys(JSON.parse(lines[0] ?? '{}') as object).sort()).toEqual(['code', 'request_id', 'status']);
    expect(lines[0]).not.toContain('someone');
    expect(lines[0]).not.toContain(jwt.slice(0, 20));
  });
});

describe('API v2', () => {
  it('serves the registry from the Worker with the build as ETag, and 304 for it', async () => {
    const { env, stub } = makeEnv();
    const response = await call(env, '/api/v2/registry');
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"abc123"');
    expectPrivate(response);
    const body = await response.json<RegistryResponse>();
    expect(body).toMatchObject({ version: 'home-v2', build: 'abc123' });
    expect(body.entries.map((entry) => entry.id)).toContain('mail-hero');
    const again = await call(env, '/api/v2/registry', { headers: { 'if-none-match': '"abc123"' } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe('"abc123"');
    expect(await again.text()).toBe('');
    expect(stub.v2View).not.toHaveBeenCalled();
    expect((await call(env, '/api/v2/registry', { jwt: null })).status).toBe(401);
  });

  it('passes a view through with its ETag, refresh only where a view has one', async () => {
    const { env, stub } = makeEnv();
    const home = await call(env, '/api/v2/home?refresh=1');
    expect(home.status).toBe(200);
    expect(home.headers.get('etag')).toBe('"7"');
    expect(home.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expectPrivate(home);
    expect(await home.json()).toEqual({ view: 'home', refresh: true });
    await call(env, '/api/v2/flows?refresh=1');
    await call(env, '/api/v2/cloudflare?refresh=1');
    await call(env, '/api/v2/ops');
    expect(stub.v2View.mock.calls.map((args) => [args[0], args[1]])).toEqual([
      ['home', true],
      ['flows', false],
      ['cloudflare', true],
      ['ops', false],
    ]);
    const cached = await call(env, '/api/v2/home', { headers: { 'if-none-match': '"7"' } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
  });

  it('requires canary_id on the canary mutation and serves the CSRF token', async () => {
    const { env, calls } = makeEnv();
    const pair = await csrf(env);
    expect(await errorCode(await mutate(env, '/api/v2/canary', {}, { csrf: pair }))).toBe('bad_request');
    expect(await errorCode(await mutate(env, '/api/v2/canary', { canary_id: 'other' }, { csrf: pair }))).toBe('bad_request');
    expect(calls.startCanary).toBe(0);
    expect((await mutate(env, '/api/v2/canary', { canary_id: 'mail-todofy' }, { csrf: pair })).status).toBe(202);
    expect((await mutate(env, '/api/v2/canary', { canary_id: 'mail-todofy' }, { csrf: null })).status).toBe(403);
    expect((await mutate(env, '/api/v2/guard', { level: 'shed' }, { csrf: pair })).status).toBe(200);
    expect((await mutate(env, '/api/v2/guard', { level: 'shed' }, { origin: 'https://evil.example.com', csrf: pair })).status).toBe(403);
    expect(calls).toMatchObject({ startCanary: 1, guard: ['shed'] });
    const v2csrf = await call(env, '/api/v2/csrf');
    expect(v2csrf.status).toBe(200);
    expect(v2csrf.headers.get('set-cookie')).toMatch(new RegExp(`^${CSRF_COOKIE}=`));
  });
});

describe('the cron handler', () => {
  it('awaits one tick of the HomeState object with the scheduled time', async () => {
    const { env, stub } = makeEnv();
    await worker.scheduled({ scheduledTime: 1_790_000_000_000, cron: '*/30 * * * *', noRetry: () => undefined }, env);
    expect(stub.tick).toHaveBeenCalledWith(1_790_000_000_000);
  });
});
