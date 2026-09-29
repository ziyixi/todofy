import { describe, expect, it } from 'vitest';
import { PRIVATE_HEADERS } from '../src/http.ts';
import { bodyText, CSRF_KEY, errorCode, failure, fakes, ok, OWNER, owner, send, type CoreReply } from './helpers.ts';

const ORIGIN = 'http://todofy.localhost:8787';
const RECONCILE = '/api/v1/events/0b8f5a4e-3c1d-4c52-9f0e-2d7c8b6a5f41/reconcile';

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A token in the Python format (json.dumps with its default ", " / ": " separators). */
async function mintCsrf(overrides: Record<string, unknown> = {}, key = CSRF_KEY, raw?: string): Promise<string> {
  const claims = { kind: 'csrf', owner: OWNER, nonce: 'test', exp: Math.floor(Date.now() / 1000) + 600, ...overrides };
  const json = raw ?? JSON.stringify(claims).replace(/,"/g, ', "').replace(/":/g, '": ');
  const payload = b64url(new TextEncoder().encode(json));
  const bytes = Uint8Array.from(key.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  const hmac = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(signature))}`;
}

function csrfHeaders(token: string, origin = ORIGIN): Record<string, string> {
  return { origin, 'x-csrf-token': token, cookie: `todofy_csrf=${token}` };
}

function expectPrivate(response: Response, cacheControl = 'no-store'): void {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) {
    expect(response.headers.get(name), name).toBe(name === 'cache-control' ? cacheControl : value);
  }
}

const echo: CoreReply = () => ok({ ok: true });

describe('private headers and assets', () => {
  it('adds the private headers to assets, the SPA fallback and core answers', async () => {
    const { env } = fakes({}, echo);
    for (const path of ['/', '/events/abc', '/assets/missing-chunk.js', '/favicon.svg', '/api/v1/overview']) {
      const response = await owner(env, path);
      expect(response.status, path).toBe(200);
      expectPrivate(response);
    }
  });

  it('keeps the core JSON bytes and sends a core 429 with Retry-After and the private headers', async () => {
    const text = '{"items": [], "next_cursor": null}';
    const listed = await owner(fakes({}, () => ok(null, text)).env, '/api/v1/events');
    expect(await listed.text()).toBe(text);
    expect(listed.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expectPrivate(listed);

    const limited = await owner(fakes({}, () => failure(429, 'rate_limited', 42)).env, '/api/v1/overview');
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('42');
    expectPrivate(limited);
  });

  it('lets the browser cache only a real hashed file under /assets/', async () => {
    const { env } = fakes();
    const hashed = await owner(env, '/assets/app-1a2b3c.js');
    expect(hashed.headers.get('content-type')).toBe('text/javascript');
    expectPrivate(hashed, 'private, max-age=31536000, immutable');

    const fallback = await owner(env, '/assets/app-old.js');
    expect(fallback.headers.get('content-type')).toBe('text/html');
    expectPrivate(fallback);

    const post = await owner(env, '/assets/app-1a2b3c.js', { method: 'POST', headers: csrfHeaders(await mintCsrf()) });
    expect(post.status).toBe(405);
    expectPrivate(post);
  });

  it('keeps the private headers on gate errors', async () => {
    const { env } = fakes({ DEV_AUTH_BYPASS: undefined });
    const response = await owner(env, '/');
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('access_not_configured');
    expectPrivate(response);
  });
});

describe('owner API forwarding', () => {
  it('passes a write with the verified owner and nothing else from the client', async () => {
    let received = '';
    const { env, core } = fakes({}, async (call) => {
      received = await bodyText(call);
      return ok({ event_id: 'x' });
    });
    const body = JSON.stringify({ action: 'retry', version: 3, action_request_id: 'r-1' });
    const token = await mintCsrf();
    const response = await owner(env, `${RECONCILE}?a=1`, {
      method: 'POST',
      body,
      headers: {
        ...csrfHeaders(token),
        'content-type': 'application/json',
        'content-length': String(body.length),
        authorization: 'Bearer x',
        'cf-access-jwt-assertion': 'jwt',
        'x-todofy-owner': 'intruder@example.com',
        'x-todofy-internal': '0',
      },
    });
    expect(response.status).toBe(200);
    expect(received).toBe(body);
    const [call] = core;
    expect(call?.method).toBe('owner_api');
    expect(call?.args.slice(0, 5)).toEqual([OWNER, 'POST', RECONCILE, 'a=1', String(body.length)]);
    expect(call?.args[5]).toBeInstanceOf(ReadableStream);
  });

  it('passes reads without a body and every other /api/v1/ path for the core to route', async () => {
    const { env, core } = fakes({}, echo);
    await owner(env, '/api/v1/events?view=attention&limit=5');
    await owner(env, '/api/v1/setup', { method: 'HEAD' });
    await owner(env, '/api/v1/csrf', { method: 'POST', headers: csrfHeaders(await mintCsrf()) });
    await owner(env, '/api/v1/nope');
    expect(core.map((call) => call.args)).toEqual([
      [OWNER, 'GET', '/api/v1/events', 'view=attention&limit=5', null, null],
      [OWNER, 'HEAD', '/api/v1/setup', '', null, null],
      [OWNER, 'POST', '/api/v1/csrf', '', null, null],
      [OWNER, 'GET', '/api/v1/nope', '', null, null],
    ]);
  });

  it('answers other /api/ paths with 404 without calling the core', async () => {
    const { env, core } = fakes({}, echo);
    for (const path of ['/api/summary', '/api/v1', '/api/v2/overview']) {
      const response = await owner(env, path);
      expect(response.status, path).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
    }
    expect(core).toHaveLength(0);
  });

  it('answers 503 unavailable with the private headers when the core cannot be reached', async () => {
    const { env } = fakes({}, () => {
      throw new Error('stub down');
    });
    const response = await owner(env, '/api/v1/overview');
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('unavailable');
    expectPrivate(response);
  });
});

describe('setup', () => {
  const coreSetup = {
    mail_source_id: 'mail-hero-personal',
    configured: { gemini_api_key: true, todoist_api_key: false, todoist_project: true },
  };

  it('merges the gateway facts with the core facts', async () => {
    const { env, core } = fakes(
      { TODOFY_HOOKS_HOSTS: 'Todofy-Hooks.localhost, daily.localhost', MAIL_WEBHOOK_TOKEN_SHA256: 'abc', ACCESS_OWNER: 'Owner@Example.com' },
      () => coreSetup,
    );
    const response = await owner(env, '/api/v1/setup');
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual({
      build: 'test',
      public_host: 'todofy.localhost',
      hooks_hosts: ['todofy-hooks.localhost', 'daily.localhost'],
      webhook_path: '/hooks/mail',
      mail_source_id: 'mail-hero-personal',
      access_owner: OWNER,
      configured: {
        mail_webhook_token: true,
        report_basic_auth: false,
        gemini_api_key: true,
        todoist_api_key: false,
        todoist_project: true,
      },
    });
    expect(core).toEqual([{ instance: 'inbox-v1', method: 'setup', args: [] }]);
  });

  it('answers 503 unavailable when the core cannot answer', async () => {
    const reply: CoreReply = () => {
      throw new Error('stub down');
    };
    const response = await owner(fakes({}, reply).env, '/api/v1/setup');
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('unavailable');
  });
});

describe('CSRF', () => {
  it('issues a signed token in the body and a strict HttpOnly cookie', async () => {
    const { env, core } = fakes({}, echo);
    const before = Math.floor(Date.now() / 1000);
    const response = await owner(env, '/api/v1/csrf');
    expect(response.status).toBe(200);
    expectPrivate(response);
    const { token } = await response.json<{ token: string }>();
    expect(response.headers.get('set-cookie')).toBe(`todofy_csrf=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
    const [payload = ''] = token.split('.');
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    expect(Object.keys(claims)).toEqual(['kind', 'owner', 'nonce', 'exp']);
    expect(claims).toMatchObject({ kind: 'csrf', owner: OWNER });
    expect(claims.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(claims.exp).toBeGreaterThanOrEqual(before + 43200);
    expect(token).not.toContain('=');

    const write = await owner(env, RECONCILE, { method: 'POST', headers: csrfHeaders(token) });
    expect(write.status).toBe(200);
    expect(core).toHaveLength(1);
  });

  it('marks the cookie Secure over HTTPS and accepts the https origin there', async () => {
    const { env, core } = fakes({}, echo);
    const issued = await send(env, 'https://todofy.localhost/api/v1/csrf');
    expect(issued.headers.get('set-cookie')).toMatch(/; Max-Age=43200; Secure$/);
    const write = await send(env, `https://todofy.localhost${RECONCILE}`, {
      method: 'POST',
      headers: csrfHeaders(await mintCsrf(), 'HTTPS://TODOFY.LOCALHOST'),
    });
    expect(write.status).toBe(200);
    expect(core).toHaveLength(1);
  });

  it('accepts a token minted by the Python code', async () => {
    const { env, core } = fakes({}, echo);
    const response = await owner(env, RECONCILE, { method: 'POST', headers: csrfHeaders(await mintCsrf()) });
    expect(response.status).toBe(200);
    expect(core).toHaveLength(1);
  });

  it('rejects cross-site and forged writes with 403 before calling the core', async () => {
    const { env, core } = fakes({}, echo);
    const token = await mintCsrf();
    const other = await mintCsrf({ nonce: 'other' });
    const [payload = ''] = token.split('.');
    const cases: Record<string, Record<string, string>> = {
      'no origin': { 'x-csrf-token': token, cookie: `todofy_csrf=${token}` },
      'cross-site origin': csrfHeaders(token, 'https://evil.example'),
      'origin on another port': csrfHeaders(token, 'http://todofy.localhost:9999'),
      'no header': { origin: ORIGIN, cookie: `todofy_csrf=${token}` },
      'no cookie': { origin: ORIGIN, 'x-csrf-token': token },
      'header differs from cookie': { origin: ORIGIN, 'x-csrf-token': token, cookie: `todofy_csrf=${other}` },
      'first cookie wins': { origin: ORIGIN, 'x-csrf-token': token, cookie: `todofy_csrf=${other}; todofy_csrf=${token}` },
      'too long': csrfHeaders(`${token}${'a'.repeat(1025 - token.length)}`),
      'no signature': csrfHeaders(payload),
      'signed with another key': csrfHeaders(await mintCsrf({}, '11'.repeat(32))),
      expired: csrfHeaders(await mintCsrf({ exp: 1 })),
      'another owner': csrfHeaders(await mintCsrf({ owner: 'owner.alias@example.net' })),
      'not a csrf token': csrfHeaders(await mintCsrf({ kind: 'confirm' })),
      'fractional exp': csrfHeaders(await mintCsrf({ exp: Math.floor(Date.now() / 1000) + 600.5 })),
      'string exp': csrfHeaders(await mintCsrf({ exp: String(Math.floor(Date.now() / 1000) + 600) })),
      'signed garbage': csrfHeaders(await mintCsrf({}, CSRF_KEY, 'not json')),
      'signed array': csrfHeaders(await mintCsrf({}, CSRF_KEY, '["csrf"]')),
    };
    for (const [name, headers] of Object.entries(cases)) {
      const response = await owner(env, RECONCILE, { method: 'POST', headers });
      expect(response.status, name).toBe(403);
      expect(await errorCode(response), name).toBe('csrf_failed');
      expectPrivate(response);
    }
    expect(core).toHaveLength(0);
  });

  it('needs a well-formed signing key for issuing and writing, not for reading', async () => {
    for (const key of [undefined, 'ab'.repeat(31), `${'ab'.repeat(31)}zz`]) {
      const { env, core } = fakes({ CSRF_SIGNING_KEY: key }, echo);
      for (const [path, init] of [
        ['/api/v1/csrf', {}],
        [RECONCILE, { method: 'POST' }],
        ['/api/v1/nope', { method: 'DELETE', headers: csrfHeaders(await mintCsrf()) }],
      ] as const) {
        const response = await owner(env, path, init);
        expect(response.status, path).toBe(503);
        expect(await errorCode(response)).toBe('not_configured');
      }
      expect((await owner(env, '/api/v1/overview')).status).toBe(200);
      expect(core).toHaveLength(1);
    }
  });

  it('accepts an uppercase signing key', async () => {
    const { env } = fakes({ CSRF_SIGNING_KEY: CSRF_KEY.toUpperCase() }, echo);
    const response = await owner(env, RECONCILE, { method: 'POST', headers: csrfHeaders(await mintCsrf()) });
    expect(response.status).toBe(200);
  });
});

describe('maintenance', () => {
  it('blocks writes after the CSRF check and keeps reads', async () => {
    const { env, core } = fakes({ MAINTENANCE_MODE: 'true' }, echo);
    const forged = await owner(env, RECONCILE, { method: 'POST' });
    expect(forged.status).toBe(403);

    const write = await owner(env, RECONCILE, { method: 'POST', headers: csrfHeaders(await mintCsrf()) });
    expect(write.status).toBe(503);
    expect(await errorCode(write)).toBe('maintenance');
    expect(write.headers.get('retry-after')).toBe('300');
    expectPrivate(write);
    expect(core).toHaveLength(0);

    expect((await owner(env, '/api/v1/overview')).status).toBe(200);
    expect((await owner(env, '/api/v1/csrf')).status).toBe(200);
    expect(core).toHaveLength(1);
  });
});
