import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiError, CsrfResponse, HealthResponse } from '../src/api-types.ts';
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
  overview: boolean[];
  startCanary: number;
  guard: string[];
}

function makeEnv(overrides: Partial<Env> = {}, answers: { startCanary?: unknown; guard?: unknown; overview?: () => unknown } = {}) {
  const calls: HomeCalls = { overview: [], startCanary: 0, guard: [] };
  const stub = {
    overview(refresh: boolean) {
      calls.overview.push(refresh);
      return Promise.resolve(answers.overview ? answers.overview() : { version: 'home-v1', refreshed: refresh });
    },
    startCanary() {
      calls.startCanary++;
      return Promise.resolve(answers.startCanary ?? { ok: true, run: { run_id: 'canary-manual-20260929T160000Z' } });
    },
    setGuardOverride(level: string) {
      calls.guard.push(level);
      return Promise.resolve(answers.guard ?? { guard: { desired: { level } } });
    },
    tick: vi.fn(() => Promise.resolve({ ran: true })),
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
    MAIL_HERO_URL: 'https://mail.example.com/',
    TODOFY_URL: 'https://todofy.example.com/',
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
  const response = await call(env, '/api/v1/csrf');
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
    expect(calls.overview).toEqual([]);
    expect((await call(env, '/health', { method: 'POST', jwt: null })).status).toBe(405);
  });
});

describe('Access', () => {
  it('lets the owner, an alias and any ASCII case of them in', async () => {
    const { env } = makeEnv();
    for (const email of ['owner@example.com', 'OWNER@EXAMPLE.COM', 'Second@Example.org']) {
      const response = await call(env, '/api/v1/overview', { jwt: await token(email) });
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
      const response = await call(env, '/api/v1/overview', { jwt });
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('unauthorized');
      expectPrivate(response);
    }
    expect(calls.overview).toEqual([]);
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
    const response = await call(bad.env, '/api/v1/overview');
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('access_not_configured');
    const noOwner = makeEnv({ ACCESS_OWNER: undefined } as unknown as Partial<Env>);
    expect(await errorCode(await call(noOwner.env, '/'))).toBe('access_not_configured');
    const other = makeEnv({ ACCESS_ISSUER: 'https://unreachable.cloudflareaccess.com' });
    const keys = await call(other.env, '/api/v1/overview', { jwt: await issuer.sign(accessClaims('https://unreachable.cloudflareaccess.com', AUDIENCE, 'owner@example.com')) });
    expect(keys.status).toBe(503);
    expect(await errorCode(keys)).toBe('unavailable');
  });

  it('allows the dev bypass only on loopback http without cf-ray, and refuses it elsewhere', async () => {
    const { env } = makeEnv({ DEV_AUTH_BYPASS: 'true' });
    const local = await worker.fetch(incoming('http://127.0.0.1:8787/api/v1/overview'), env);
    expect(local.status).toBe(200);
    const viaEdge = await worker.fetch(incoming('http://127.0.0.1:8787/api/v1/overview', { headers: { 'cf-ray': 'x' } }), env);
    expect(viaEdge.status).toBe(503);
    const production = await call(env, '/api/v1/overview');
    expect(production.status).toBe(503);
    expect(await errorCode(production)).toBe('access_not_configured');
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
    const response = await mutate(env, '/api/v1/canary', {});
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ run: { run_id: 'canary-manual-20260929T160000Z' } });
    expect(calls.startCanary).toBe(1);
    expect((await mutate(env, '/api/v1/canary', '')).status).toBe(202);
  });

  it('refuses a wrong Origin, a missing or foreign token, before reading the body or calling the object', async () => {
    const { env, calls } = makeEnv();
    const pair = await csrf(env);
    const cases = [
      await mutate(env, '/api/v1/canary', {}, { origin: 'https://evil.example.com', csrf: pair }),
      await mutate(env, '/api/v1/canary', {}, { origin: 'http://home.example.com', csrf: pair }),
      await mutate(env, '/api/v1/canary', {}, { csrf: null }),
      await mutate(env, '/api/v1/canary', {}, { csrf: { token: pair.token, cookie: `${CSRF_COOKIE}=other` } }),
      await mutate(env, '/api/v1/guard', 'not json', { csrf: { token: `${pair.token}x`, cookie: `${CSRF_COOKIE}=${pair.token}x` } }),
    ];
    for (const response of cases) {
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('csrf_failed');
    }
    // A token minted with another key does not verify.
    const other = makeEnv({ CSRF_SIGNING_KEY: 'cd'.repeat(32) });
    expect((await mutate(env, '/api/v1/guard', { level: 'shed' }, { csrf: await csrf(other.env) })).status).toBe(403);
    expect(calls.startCanary).toBe(0);
    expect(calls.guard).toEqual([]);
  });

  it('needs a signing key for the CSRF token and every mutation', async () => {
    const { env, calls } = makeEnv({ CSRF_SIGNING_KEY: 'short' });
    expect(await errorCode(await call(env, '/api/v1/csrf'))).toBe('not_configured');
    const response = await mutate(env, '/api/v1/guard', { level: 'shed' }, { csrf: { token: 'a.b', cookie: `${CSRF_COOKIE}=a.b` } });
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('not_configured');
    expect(calls.guard).toEqual([]);
    // Reads keep working.
    expect((await call(env, '/api/v1/overview')).status).toBe(200);
  });

  it('sets the guard override from {level}', async () => {
    const { env, calls } = makeEnv();
    const response = await mutate(env, '/api/v1/guard', { level: 'normal' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ guard: { desired: { level: 'normal' } } });
    expect(calls.guard).toEqual(['normal']);
  });

  it('refuses malformed bodies with 400', async () => {
    const { env, calls } = makeEnv();
    for (const body of ['not json', '[]', JSON.stringify({ level: 'panic' }), JSON.stringify({ level: 'shed', extra: 1 }), JSON.stringify({ level: 'shed', pad: 'x'.repeat(2000) })]) {
      const response = await mutate(env, '/api/v1/guard', body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('bad_request');
    }
    expect(await errorCode(await mutate(env, '/api/v1/canary', { run_id: 'mine' }))).toBe('bad_request');
    expect(calls.guard).toEqual([]);
    expect(calls.startCanary).toBe(0);
  });

  it('maps the object\'s refusals to 409 and 429, and its failure to 503', async () => {
    for (const [answer, status, code] of [
      [{ ok: false, code: 'canary_active' }, 409, 'canary_active'],
      [{ ok: false, code: 'canary_limit' }, 429, 'canary_limit'],
    ] as const) {
      const { env } = makeEnv({}, { startCanary: answer });
      const response = await mutate(env, '/api/v1/canary', {});
      expect(response.status).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
    const { env, stub } = makeEnv();
    stub.startCanary = () => Promise.reject(new Error('object reset'));
    stub.setGuardOverride = () => Promise.reject(new Error('object reset'));
    for (const [path, body] of [['/api/v1/canary', {}], ['/api/v1/guard', { level: 'shed' }]] as const) {
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
    const request = incoming(`https://${HOST}/api/v1/guard`, {
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
      incoming(`https://${HOST}/api/v1/guard`, {
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
      const refused = await mutate(env, '/api/v1/guard', { level: 'shed' }, { csrf: pair, headers: { 'content-length': length } });
      expect(refused.status, length).toBe(400);
    }
    expect(calls.guard).toEqual(['shed']);
  });
});

describe('routing', () => {
  it('passes ?refresh=1 to the overview', async () => {
    const { env, calls } = makeEnv();
    await call(env, '/api/v1/overview');
    await call(env, '/api/v1/overview?refresh=1');
    await call(env, '/api/v1/overview?refresh=yes');
    expect(calls.overview).toEqual([false, true, false]);
  });

  it('answers unknown API paths 404 and wrong methods 405 with Allow', async () => {
    const { env } = makeEnv();
    const missing = await call(env, '/api/v1/nothing');
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('not_found');
    expect(await errorCode(await call(env, '/api'))).toBe('not_found');
    const wrong = await call(env, '/api/v1/canary');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    expect(await errorCode(wrong)).toBe('method_not_allowed');
    expect((await call(env, '/api/v1/overview', { method: 'POST' })).headers.get('allow')).toBe('GET');
  });

  it('turns a failing Durable Object into 503 unavailable', async () => {
    const { env } = makeEnv({}, { overview: () => { throw new Error('storage exploded with detail'); } });
    const response = await call(env, '/api/v1/overview');
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('exploded');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'unavailable' } });
  });

  it('logs only the request ID, status and code of an error', async () => {
    const log = vi.spyOn(console, 'log');
    const { env } = makeEnv();
    const jwt = await token('someone@example.com');
    await call(env, '/api/v1/overview', { jwt });
    const lines = log.mock.calls.map((args) => String(args[0]));
    expect(lines).toHaveLength(1);
    expect(Object.keys(JSON.parse(lines[0] ?? '{}') as object).sort()).toEqual(['code', 'request_id', 'status']);
    expect(lines[0]).not.toContain('someone');
    expect(lines[0]).not.toContain(jwt.slice(0, 20));
  });
});

describe('the cron handler', () => {
  it('awaits one tick of the HomeState object with the scheduled time', async () => {
    const { env, stub } = makeEnv();
    await worker.scheduled({ scheduledTime: 1_790_000_000_000, cron: '*/30 * * * *', noRetry: () => undefined }, env);
    expect(stub.tick).toHaveBeenCalledWith(1_790_000_000_000);
  });
});
