/**
 * The Worker's HTTP surface with a stub HomeState (src/http.ts, src/api.ts): Access on every path but /health, CSRF
 * and Origin on every mutation, the owner API's routes, its google.rpc.Status errors, the views passed through with
 * their ETags, and the retired /api/v2 routes' reload answer. The workerd suite (test/runtime) runs the same routes
 * against the real HomeState.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverrideGuardResponseSchema, RunCanaryResponseSchema } from '@ziyixi/proto/dashboard/ui/v1/dashboard_ui_service_pb';
import { parseStatus } from '@ziyixi/proto/rpc-status';
import type { CanaryRun, CsrfResponse, GuardView, HealthResponse, LegacyApiError, Registry } from '../src/api-types.ts';
import { runView, newRun } from '../src/canary.ts';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { REASONS } from '../src/api.ts';
import { API_DOMAIN, CSRF_COOKIE, LEGACY_CODES, LEGACY_RELOAD_CODE, legacyCode, RELOAD_MESSAGE } from '../src/http.ts';
import { accessClaims, testIssuer, type TestIssuer } from './jwt.ts';
import { expectWire, VIEW_SCHEMAS } from './wire-conformance.ts';

const ISSUER = 'https://synthetic.cloudflareaccess.com';
const AUDIENCE = 'a'.repeat(64);
const OWNER = 'Owner@Example.com';
const HOST = 'home.example.com';
const ORIGIN = `https://${HOST}`;
const REQUEST_ID = '0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0a';

/** The owner API's paths (one place, so a route change touches only this table). */
const PATHS = {
  registry: '/api/v1/registry',
  home: '/api/v1/homeView',
  refreshHome: '/api/v1/homeView:refresh',
  flows: '/api/v1/flowsView',
  cloudflare: '/api/v1/cloudflareView',
  refreshCloudflare: '/api/v1/cloudflareView:refresh',
  ops: '/api/v1/opsView',
  guard: '/api/v1/guard:override',
  canary: '/api/v1/canaries/mail-todofy:run',
  csrf: '/api/csrf',
} as const;

/** Worker handlers receive requests with incoming cf properties; tests have none. */
const incoming = (...args: ConstructorParameters<typeof Request>): Request<unknown, IncomingRequestCfProperties> =>
  new Request(...args) as unknown as Request<unknown, IncomingRequestCfProperties>;

/** A run as HomeState answers RunCanary (a valid dashboard.ui.v1 CanaryRun). */
const RUN: CanaryRun = runView(newRun('canary-manual-20260929T160000Z', 'manual', Date.parse('2026-09-29T16:00:00Z')));
/** A guard as HomeState answers OverrideGuard. */
function guardOf(level: 'normal' | 'shed'): GuardView {
  return {
    desired: { level, reason: level === 'shed' ? 'owner_shed' : 'owner_clear', until: null, source: 'owner' },
    override: null,
    thresholds: { shed_percent: 80, clear_percent: 70 },
    apps: { 'mail-hero': { state: { level, reason: null, until: null, set_at: null, deferred: [] }, last_call_at: null, last_error: null } },
  };
}

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
  /** view calls as `<view>:<refresh>`. */
  views: string[];
  /** The request_id of every startCanary call. */
  startCanary: (string | null)[];
  /** `<app>:<level>:<request_id>` of every setGuardOverride call. */
  guard: string[];
  /** The request time (`at`) of every view, startCanary and setGuardOverride call, in order. */
  at: (number | null)[];
}

function makeEnv(overrides: Partial<Env> = {}, answers: { startCanary?: unknown; guard?: unknown; view?: () => unknown } = {}) {
  const calls: HomeCalls = { views: [], startCanary: [], guard: [], at: [] };
  const stub = {
    startCanary(at: number | null, requestId: string | null) {
      calls.startCanary.push(requestId);
      calls.at.push(at);
      return Promise.resolve(answers.startCanary ?? { ok: true, run: RUN });
    },
    setGuardOverride(app: string, level: 'normal' | 'shed', at: number | null, requestId: string | null) {
      calls.guard.push(`${app}:${level}:${String(requestId)}`);
      calls.at.push(at);
      return Promise.resolve(answers.guard ?? { ok: true, guard: guardOf(level) });
    },
    tick: vi.fn(() => Promise.resolve({ ran: true })),
    view: vi.fn((view: string, refresh: boolean, ifNoneMatch: string | null, at: number | null) => {
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

/** The ErrorInfo reason of a google.rpc.Status answer, after checking its domain, request ID and copy. */
async function reasonOf(response: Response): Promise<string> {
  const status = parseStatus(response.status, await response.json());
  expect(status).not.toBeNull();
  expect(status?.domain).toBe(API_DOMAIN);
  expect(status?.requestId).toMatch(/^[0-9a-f]{16}$/);
  const reason = status?.reason ?? '';
  expect(status?.localizedMessage).toEqual({ locale: 'zh-CN', message: REASONS[reason as keyof typeof REASONS].zh });
  return reason;
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
  const response = await call(env, PATHS.csrf);
  expect(response.status).toBe(200);
  expectPrivate(response);
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
      const response = await call(env, PATHS.home, { jwt: await token(email) });
      expect(response.status).toBe(200);
    }
    // The key set was fetched once for all of them.
    expect(certRequests).toEqual([`${ISSUER}/cdn-cgi/access/certs`]);
  });

  it('refuses missing, invalid, expired, foreign and wrong-audience tokens on every path', async () => {
    const { env, calls } = makeEnv();
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      null,
      'not-a-jwt',
      await token('someone@example.com'),
      await token('owner@example.com', { exp: now - 1 }),
      await token('owner@example.com', { aud: ['b'.repeat(64)] }),
      await token('owner@example.com', { iss: 'https://other.cloudflareaccess.com' }),
      await token('Kowner@example.com'),
      (await token()).slice(0, -4) + 'AAAA',
    ];
    for (const jwt of cases) {
      for (const path of [PATHS.home, PATHS.registry, PATHS.csrf, '/api/v1/nothing']) {
        const response = await call(env, path, { jwt });
        expect(response.status, path).toBe(401);
        expect(await reasonOf(response)).toBe('UNAUTHORIZED');
        expectPrivate(response);
      }
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
    const response = await call(bad.env, PATHS.home);
    expect(response.status).toBe(503);
    expect(await reasonOf(response)).toBe('ACCESS_NOT_CONFIGURED');
    const noOwner = makeEnv({ ACCESS_OWNER: undefined } as unknown as Partial<Env>);
    expect(await reasonOf(await call(noOwner.env, '/'))).toBe('ACCESS_NOT_CONFIGURED');
    const other = makeEnv({ ACCESS_ISSUER: 'https://unreachable.cloudflareaccess.com' });
    const keys = await call(other.env, PATHS.home, { jwt: await issuer.sign(accessClaims('https://unreachable.cloudflareaccess.com', AUDIENCE, 'owner@example.com')) });
    expect(keys.status).toBe(503);
    expect(await reasonOf(keys)).toBe('UNAVAILABLE');
  });

  it('allows the dev bypass only on loopback http without cf-ray, and refuses it elsewhere', async () => {
    const { env } = makeEnv({ DEV_AUTH_BYPASS: 'true' });
    const local = await worker.fetch(incoming(`http://127.0.0.1:8787${PATHS.home}`), env);
    expect(local.status).toBe(200);
    const viaEdge = await worker.fetch(incoming(`http://127.0.0.1:8787${PATHS.home}`, { headers: { 'cf-ray': 'x' } }), env);
    expect(viaEdge.status).toBe(503);
    const production = await call(env, PATHS.home);
    expect(production.status).toBe(503);
    expect(await reasonOf(production)).toBe('ACCESS_NOT_CONFIGURED');
  });

  it('pins the request time to DEV_NOW only for requests the loopback dev bypass signed in', async () => {
    const NOW = '2026-10-01T12:00:00Z';
    const local = async (env: Env, path: string, body?: unknown): Promise<Response> => {
      const url = `http://127.0.0.1:8787${path}`;
      if (body === undefined) return worker.fetch(incoming(url), env);
      const issued = await worker.fetch(incoming(`http://127.0.0.1:8787${PATHS.csrf}`), env);
      const { token: csrfToken } = await issued.json<CsrfResponse>();
      const cookie = (issued.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const headers = { origin: 'http://127.0.0.1:8787', 'x-csrf-token': csrfToken, cookie, 'content-type': 'application/json' };
      return worker.fetch(incoming(url, { method: 'POST', headers, body: JSON.stringify(body) }), env);
    };

    // Bypassed: every request-driven call of the object takes DEV_NOW as now.
    const pinned = makeEnv({ DEV_AUTH_BYPASS: 'true', DEV_NOW: NOW });
    expect((await local(pinned.env, PATHS.refreshHome, {})).status).toBe(200);
    expect((await local(pinned.env, PATHS.canary, {})).status).toBe(200);
    expect((await local(pinned.env, PATHS.guard, { level: 'shed', app: 'mail-hero' })).status).toBe(200);
    expect(pinned.calls.at).toEqual([Date.parse(NOW), Date.parse(NOW), Date.parse(NOW)]);

    // Unset or not an RFC 3339 UTC instant: the object's own clock.
    for (const value of ['', ' ', '2026-10-01 12:00:00', '2026-10-01T12:00:00+02:00', '1759320000000', 'now']) {
      const { env, calls } = makeEnv({ DEV_AUTH_BYPASS: 'true', DEV_NOW: value });
      expect((await local(env, PATHS.ops)).status).toBe(200);
      expect(calls.at, value).toEqual([null]);
    }

    // A request Access verified never reads it, even where the Worker holds a DEV_NOW.
    const verified = makeEnv({ DEV_NOW: NOW });
    expect((await call(verified.env, PATHS.home)).status).toBe(200);
    expect((await mutate(verified.env, PATHS.canary, {})).status).toBe(200);
    expect((await mutate(verified.env, PATHS.guard, { level: 'normal', app: 'mail-hero' })).status).toBe(200);
    expect(verified.calls.at).toEqual([null, null, null]);
    // And with the bypass switched on as well, the edge's requests are refused before the object is called.
    const both = makeEnv({ DEV_AUTH_BYPASS: 'true', DEV_NOW: NOW });
    expect((await call(both.env, PATHS.home)).status).toBe(503);
    expect(both.calls.at).toEqual([]);
  });
});

describe('CSRF and mutations', () => {
  it('issues a signed token and cookie at /api/csrf (GET only)', async () => {
    const { env } = makeEnv();
    const pair = await csrf(env);
    expect(pair.token.split('.')).toHaveLength(2);
    expect(pair.cookie).toBe(`${CSRF_COOKIE}=${pair.token}`);
    for (const method of ['POST', 'HEAD']) {
      const refused = await call(env, PATHS.csrf, { method });
      expect(refused.status, method).toBe(405);
      expect(refused.headers.get('allow')).toBe('GET');
      expect(refused.headers.get('set-cookie')).toBeNull();
    }
  });

  it('starts a canary with Origin + CSRF and answers its first run', async () => {
    const { env, calls } = makeEnv();
    const response = await mutate(env, PATHS.canary, { request_id: REQUEST_ID.toUpperCase() });
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(expectWire(RunCanaryResponseSchema, await response.json())).toEqual({ run: RUN });
    // The transcoder lower-cased the UUID4 request_id.
    expect(calls.startCanary).toEqual([REQUEST_ID]);
    expect((await mutate(env, PATHS.canary, {})).status).toBe(200);
    expect(calls.startCanary).toEqual([REQUEST_ID, null]);
  });

  it('refuses a wrong Origin, a missing or foreign token, before reading the body or calling the object', async () => {
    const { env, calls } = makeEnv();
    const pair = await csrf(env);
    const cases = [
      await mutate(env, PATHS.canary, {}, { origin: 'https://evil.example.com', csrf: pair }),
      await mutate(env, PATHS.canary, {}, { origin: 'http://home.example.com', csrf: pair }),
      await mutate(env, PATHS.canary, {}, { csrf: null }),
      await mutate(env, PATHS.canary, {}, { csrf: { token: pair.token, cookie: `${CSRF_COOKIE}=other` } }),
      await mutate(env, PATHS.guard, 'not json', { csrf: { token: `${pair.token}x`, cookie: `${CSRF_COOKIE}=${pair.token}x` } }),
      await mutate(env, PATHS.refreshHome, {}, { csrf: null }),
      await mutate(env, PATHS.refreshCloudflare, {}, { origin: 'https://evil.example.com', csrf: pair }),
    ];
    for (const response of cases) {
      expect(response.status).toBe(403);
      expect(await reasonOf(response)).toBe('CSRF_FAILED');
    }
    // A token minted with another key does not verify.
    const other = makeEnv({ CSRF_SIGNING_KEY: 'cd'.repeat(32) });
    expect((await mutate(env, PATHS.guard, { level: 'shed', app: 'mail-hero' }, { csrf: await csrf(other.env) })).status).toBe(403);
    expect(calls.startCanary).toEqual([]);
    expect(calls.guard).toEqual([]);
    expect(calls.views).toEqual([]);
  });

  it('needs a signing key for the CSRF token and every mutation', async () => {
    const { env, calls } = makeEnv({ CSRF_SIGNING_KEY: 'short' });
    expect(await reasonOf(await call(env, PATHS.csrf))).toBe('NOT_CONFIGURED');
    const response = await mutate(env, PATHS.guard, { level: 'shed', app: 'mail-hero' }, { csrf: { token: 'a.b', cookie: `${CSRF_COOKIE}=a.b` } });
    expect(response.status).toBe(503);
    expect(await reasonOf(response)).toBe('NOT_CONFIGURED');
    expect(calls.guard).toEqual([]);
    // Reads keep working.
    expect((await call(env, PATHS.home)).status).toBe(200);
  });

  it('sets the guard override from {level, request_id}', async () => {
    const { env, calls } = makeEnv();
    const response = await mutate(env, PATHS.guard, { level: 'normal', app: 'mail-hero', request_id: REQUEST_ID });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ guard: guardOf('normal') });
    expectWire(OverrideGuardResponseSchema, body);
    expect(calls.guard).toEqual([`mail-hero:normal:${REQUEST_ID}`]);
  });

  it('refuses malformed bodies with BAD_REQUEST before calling the object', async () => {
    const { env, calls } = makeEnv();
    for (const body of [
      'not json',
      '[]',
      '{}',
      JSON.stringify({ level: 'panic' }),
      JSON.stringify({ level: null }),
      JSON.stringify({ level: 'shed', extra: 1 }),
      JSON.stringify({ level: 'shed', app: 'mail-hero', request_id: 'not-a-uuid' }),
      JSON.stringify({ level: 'shed', pad: 'x'.repeat(2000) }),
    ]) {
      const response = await mutate(env, PATHS.guard, body);
      expect(response.status, body).toBe(400);
      expect(await reasonOf(response)).toBe('BAD_REQUEST');
    }
    for (const body of ['', '[]', { run_id: 'mine' }, { canary_id: 'mail-todofy' }, { request_id: 7 }]) {
      expect(await reasonOf(await mutate(env, PATHS.canary, body))).toBe('BAD_REQUEST');
    }
    // A refresh takes nothing but its name.
    expect(await reasonOf(await mutate(env, PATHS.refreshHome, { refresh: true }))).toBe('BAD_REQUEST');
    expect(calls.guard).toEqual([]);
    expect(calls.startCanary).toEqual([]);
    expect(calls.views).toEqual([]);
  });

  it("maps the object's refusals to their reasons, another canary to NOT_FOUND and the object's failure to UNAVAILABLE", async () => {
    for (const [answer, status, reason] of [
      [{ ok: false, code: 'canary_disabled' }, 400, 'CANARY_DISABLED'],
      [{ ok: false, code: 'canary_active' }, 409, 'CANARY_ACTIVE'],
      [{ ok: false, code: 'canary_limit' }, 429, 'CANARY_LIMIT'],
      [{ ok: false, code: 'request_id_reused' }, 400, 'BAD_REQUEST'],
    ] as const) {
      const { env } = makeEnv({}, { startCanary: answer });
      const response = await mutate(env, PATHS.canary, {});
      expect(response.status).toBe(status);
      expect(await reasonOf(response)).toBe(reason);
    }
    const reused = await mutate(makeEnv({}, { guard: { ok: false, code: 'request_id_reused' } }).env, PATHS.guard, { level: 'shed', app: 'mail-hero', request_id: REQUEST_ID });
    expect(await reasonOf(reused)).toBe('BAD_REQUEST');
    // The switch names the variable that turns it back on.
    const disabled = await mutate(makeEnv({}, { startCanary: { ok: false, code: 'canary_disabled' } }).env, PATHS.canary, {});
    expect(parseStatus(400, await disabled.json())?.localizedMessage?.message).toBe('金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）');
    const { env, stub, calls } = makeEnv();
    const unknown = await mutate(env, '/api/v1/canaries/other:run', {});
    expect(unknown.status).toBe(404);
    expect(await reasonOf(unknown)).toBe('NOT_FOUND');
    expect(calls.startCanary).toEqual([]);
    stub.startCanary = () => Promise.reject(new Error('object reset'));
    stub.setGuardOverride = () => Promise.reject(new Error('object reset'));
    for (const [path, body] of [[PATHS.canary, {}], [PATHS.guard, { level: 'shed', app: 'mail-hero' }]] as const) {
      const response = await mutate(env, path, body);
      expect(response.status).toBe(503);
      expect(await reasonOf(response)).toBe('UNAVAILABLE');
    }
  });

  it('answers INTERNAL, never the object’s answer, when HomeState answers what the IDL refuses', async () => {
    const { env } = makeEnv({}, { startCanary: { ok: true, run: { ...RUN, phase: 'exploded' } } });
    const response = await mutate(env, PATHS.canary, {});
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('exploded');
    expect(parseStatus(500, JSON.parse(text))?.reason).toBe('INTERNAL');
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
    const headers = { 'cf-access-jwt-assertion': await token(), origin: ORIGIN, 'x-csrf-token': pair.token, cookie: pair.cookie, 'content-type': 'application/json' };
    const request = incoming(`https://${HOST}${PATHS.guard}`, { method: 'POST', headers, body: endless, duplex: 'half' } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
    expect(await reasonOf(response)).toBe('BAD_REQUEST');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(3);
    expect(calls.guard).toEqual([]);

    // A small chunked body is read normally.
    const small = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"level":'));
        controller.enqueue(new TextEncoder().encode('"shed","app":"mail-hero"}'));
        controller.close();
      },
    });
    const ok = await worker.fetch(incoming(`https://${HOST}${PATHS.guard}`, { method: 'POST', headers, body: small, duplex: 'half' } as RequestInit), env);
    expect(ok.status).toBe(200);
    expect(calls.guard).toEqual(['mail-hero:shed:null']);
    // A declared length above the limit or a malformed one is refused before reading.
    for (const length of ['1025', 'abc', '-1']) {
      const refused = await mutate(env, PATHS.guard, { level: 'shed', app: 'mail-hero' }, { csrf: pair, headers: { 'content-length': length } });
      expect(refused.status, length).toBe(400);
    }
    expect(calls.guard).toEqual(['mail-hero:shed:null']);
  });
});

describe('routing', () => {
  it('refreshes only through the refresh methods, never through a GET', async () => {
    const { env, calls } = makeEnv();
    await call(env, PATHS.home);
    expect((await mutate(env, PATHS.refreshHome, {})).status).toBe(200);
    // The old query parameter is an unknown query parameter of GetHomeView now.
    const query = await call(env, `${PATHS.home}?refresh=1`);
    expect(query.status).toBe(400);
    expect(await reasonOf(query)).toBe('BAD_REQUEST');
    expect((await mutate(env, PATHS.refreshCloudflare, {})).status).toBe(200);
    expect(calls.views).toEqual(['home:false', 'home:true', 'cloudflare:true']);
  });

  it('answers unknown API paths NOT_FOUND and wrong methods METHOD_NOT_ALLOWED with Allow', async () => {
    const { env } = makeEnv();
    for (const path of ['/api/v1/nothing', '/api/v1/overview', '/api/v1', '/api/v1/canaries', '/api/v1/flowsView:refresh']) {
      const missing = await call(env, path);
      expect(missing.status, path).toBe(404);
      expect(await reasonOf(missing)).toBe('NOT_FOUND');
    }
    const wrong = await call(env, PATHS.canary);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST, OPTIONS');
    expect(await reasonOf(wrong)).toBe('METHOD_NOT_ALLOWED');
    expect((await call(env, PATHS.home, { method: 'DELETE' })).headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    const head = await call(env, PATHS.home, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('turns a failing Durable Object into UNAVAILABLE without its message', async () => {
    const { env } = makeEnv({}, {
      view: () => {
        throw new Error('storage exploded with detail');
      },
    });
    const response = await call(env, PATHS.home);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('exploded');
    expect(parseStatus(503, JSON.parse(text))?.reason).toBe('UNAVAILABLE');
  });

  it('logs only the request ID, status and reason of an error', async () => {
    const log = vi.spyOn(console, 'log');
    const { env } = makeEnv();
    const jwt = await token('someone@example.com');
    await call(env, PATHS.home, { jwt });
    const lines = log.mock.calls.map((args) => String(args[0]));
    expect(lines).toHaveLength(1);
    expect(Object.keys(JSON.parse(lines[0] ?? '{}') as object).sort()).toEqual(['reason', 'request_id', 'status']);
    expect(lines[0]).not.toContain('someone');
    expect(lines[0]).not.toContain(jwt.slice(0, 20));
    expect(lines[0]).not.toContain('homeView');
  });
});

/** The error codes of the UI before dashboard.ui.v1 (its ApiErrorCode at 327ad52), frozen: that client no longer changes. */
const OLD_UI_CODES = [
  'unauthorized',
  'access_not_configured',
  'not_configured',
  'csrf_failed',
  'bad_request',
  'not_found',
  'method_not_allowed',
  'canary_active',
  'canary_disabled',
  'canary_limit',
  'unavailable',
] as const;

/**
 * What a tab still running the old UI makes of an error answer: its readError (dashboard/web/src/api/client.ts at
 * 327ad52), step for step. The envelope's message is shown only for a code it knows; anything else is its generic
 * "unrecognized response" error.
 */
async function oldUiError(response: Response): Promise<{ status: number; code: string; message: string }> {
  try {
    const body = await response.json<{ error?: { code?: unknown; message?: unknown } }>();
    const error = body.error;
    if (error && typeof error.code === 'string' && (OLD_UI_CODES as readonly string[]).includes(error.code)) {
      const message = typeof error.message === 'string' && error.message ? error.message : `<copy of ${error.code}>`;
      return { status: response.status, code: error.code, message };
    }
  } catch {
    // An HTML answer, as from the Access edge.
  }
  return { status: response.status, code: 'bad_response', message: `服务返回了无法识别的响应（HTTP ${String(response.status)}）` };
}

describe('the retired /api/v2 routes', () => {
  it('only use codes the old UI knows', () => {
    expect(LEGACY_CODES).toEqual(OLD_UI_CODES);
    expect(OLD_UI_CODES).toContain(LEGACY_RELOAD_CODE);
    // Every reason an authentication failure may carry, INTERNAL (a bug) as `unavailable`.
    for (const reason of Object.keys(REASONS)) expect(OLD_UI_CODES, reason).toContain(legacyCode(reason));
    expect(legacyCode('INTERNAL')).toBe('unavailable');
    expect(legacyCode('UNAUTHORIZED')).toBe('unauthorized');
  });

  it('answer 410 with the reload message, which the old UI shows, behind Access, without calling the object', async () => {
    const { env, calls } = makeEnv();
    for (const [path, method] of [
      ['/api/v2/home', 'GET'],
      ['/api/v2/home?refresh=1', 'GET'],
      ['/api/v2/registry', 'GET'],
      ['/api/v2/csrf', 'GET'],
      ['/api/v2/guard', 'POST'],
      ['/api/v2/canary', 'POST'],
      ['/api/v2/nothing', 'GET'],
      ['/api', 'GET'],
    ] as const) {
      const response = await call(env, path, { method });
      expect(response.status, path).toBe(410);
      expectPrivate(response);
      const body = await response.clone().json<LegacyApiError>();
      expect({ code: body.error.code, message: body.error.message }).toEqual({ code: LEGACY_RELOAD_CODE, message: RELOAD_MESSAGE });
      expect(body.error.request_id).toMatch(/^[0-9a-f]{16}$/);
      expect(await oldUiError(response), path).toEqual({ status: 410, code: 'not_found', message: RELOAD_MESSAGE });
    }
    expect(calls).toMatchObject({ views: [], startCanary: [], guard: [] });
  });

  it('answer an authentication failure in the old envelope with a code the old UI shows', async () => {
    const { env } = makeEnv();
    expect(await oldUiError(await call(env, '/api/v2/home', { jwt: null }))).toEqual({
      status: 401,
      code: 'unauthorized',
      message: REASONS.UNAUTHORIZED.zh,
    });
    const bad = makeEnv({ ACCESS_AUDIENCE: '' });
    expect(await oldUiError(await call(bad.env, '/api/v2/home'))).toEqual({
      status: 503,
      code: 'access_not_configured',
      message: REASONS.ACCESS_NOT_CONFIGURED.zh,
    });
    const unreachable = 'https://unreachable.cloudflareaccess.com';
    const other = makeEnv({ ACCESS_ISSUER: unreachable });
    const jwt = await issuer.sign(accessClaims(unreachable, AUDIENCE, 'owner@example.com'));
    expect(await oldUiError(await call(other.env, '/api/v2/home', { jwt }))).toEqual({
      status: 503,
      code: 'unavailable',
      message: REASONS.UNAVAILABLE.zh,
    });
  });
});

describe('DashboardUiService', () => {
  it('serves the registry from the Worker with the build as ETag, and 304 for it', async () => {
    const { env, stub } = makeEnv();
    const response = await call(env, PATHS.registry);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"abc123"');
    expectPrivate(response);
    const text = await response.text();
    expectWire(VIEW_SCHEMAS.registry, text);
    const body = JSON.parse(text) as Registry;
    expect(body).toMatchObject({ name: 'registry', build: 'abc123' });
    expect(body.entries.map((entry) => entry.id)).toContain('mail-hero');
    const again = await call(env, PATHS.registry, { headers: { 'if-none-match': '"abc123"' } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe('"abc123"');
    expect(again.headers.get('content-type')).toBeNull();
    expect(await again.text()).toBe('');
    expect(stub.view).not.toHaveBeenCalled();
    expect((await call(env, PATHS.registry, { jwt: null })).status).toBe(401);
  });

  it('passes a view through with its ETag, and 304 for a matching If-None-Match', async () => {
    const { env, stub } = makeEnv();
    const home = await call(env, PATHS.home);
    expect(home.status).toBe(200);
    expect(home.headers.get('etag')).toBe('"7"');
    expect(home.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expectPrivate(home);
    // The bytes HomeState serialized, untouched.
    expect(await home.text()).toBe('{"view":"home","refresh":false}');
    await call(env, PATHS.flows);
    await call(env, PATHS.cloudflare);
    await call(env, PATHS.ops);
    await mutate(env, PATHS.refreshCloudflare, {});
    expect(stub.view.mock.calls.map((args) => [args[0], args[1], args[2]])).toEqual([
      ['home', false, null],
      ['flows', false, null],
      ['cloudflare', false, null],
      ['ops', false, null],
      // A refresh always wants the fresh body: no If-None-Match is passed on.
      ['cloudflare', true, null],
    ]);
    const cached = await call(env, PATHS.ops, { headers: { 'if-none-match': '"7"' } });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('etag')).toBe('"7"');
    expectPrivate(cached);
    expect(await cached.text()).toBe('');
    const refreshed = await mutate(env, PATHS.refreshHome, {}, { headers: { 'if-none-match': '"7"' } });
    expect(refreshed.status).toBe(200);
  });
});

describe('the cron handler', () => {
  it('awaits one tick of the HomeState object with the scheduled time', async () => {
    const { env, stub } = makeEnv();
    await worker.scheduled({ scheduledTime: 1_790_000_000_000, cron: '*/30 * * * *', noRetry: () => undefined }, env);
    expect(stub.tick).toHaveBeenCalledWith(1_790_000_000_000);
  });
});
