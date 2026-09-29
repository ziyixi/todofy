import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorCode, fakes, hooks, send, type CoreCall, type Vars } from './helpers.ts';

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const TOKEN = 'webhook-token';
const PREVIOUS = 'previous-token';
const EVENT = JSON.stringify({ event_id: '0b8f5a4e-3c1d-4c52-9f0e-2d7c8b6a5f41', type: 'mail.received.v1' });

async function webhookVars(extra: Vars = {}): Promise<Vars> {
  return {
    MAIL_WEBHOOK_TOKEN_SHA256: (await sha256(TOKEN)).toUpperCase(),
    MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS: ` ${await sha256(PREVIOUS)} `,
    ...extra,
  };
}

function post(headers: Record<string, string>, body: string | null = EVENT): RequestInit & { headers: Record<string, string> } {
  return { method: 'POST', headers, body };
}

const JSON_BEARER = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

describe('POST /hooks/mail', () => {
  it('streams the unread body to the core with only the allowed headers', async () => {
    let received = '';
    const { env, core } = fakes(await webhookVars(), async (call: CoreCall) => {
      received = await new Response(call.body).text();
      return new Response(null, { status: 204 });
    });
    const request = new Request('http://todofy-hooks.localhost/hooks/mail', {
      method: 'POST',
      body: EVENT,
      headers: {
        ...JSON_BEARER,
        'content-type': 'Application/JSON; charset=utf-8',
        'idempotency-key': '0b8f5a4e-3c1d-4c52-9f0e-2d7c8b6a5f41',
        'x-todofy-owner': 'intruder@example.com',
        'x-todofy-internal': '0',
        'x-todofy-request-id': 'ffffffffffffffff',
        cookie: 'CF_Authorization=abc',
      },
    });
    const { default: worker } = await import('../src/index.ts');
    const response = await worker.fetch(request as never, env);
    expect(response.status).toBe(204);
    expect(core).toHaveLength(1);
    const [ingest] = core;
    expect(ingest?.url.href).toBe('https://coordinator/ingest');
    expect(ingest?.method).toBe('POST');
    expect(ingest?.body).toBe(request.body);
    expect(received).toBe(EVENT);
    expect(Object.fromEntries(ingest?.headers ?? [])).toEqual({
      'content-type': 'application/json',
      'idempotency-key': '0b8f5a4e-3c1d-4c52-9f0e-2d7c8b6a5f41',
      'x-todofy-internal': '1',
      'x-todofy-request-id': expect.stringMatching(/^[0-9a-f]{16}$/) as string,
    });
    expect(ingest?.headers.get('x-todofy-request-id')).not.toBe('ffffffffffffffff');
  });

  it('accepts the previous token while rotating and copies an empty idempotency key', async () => {
    const { env, core } = fakes(await webhookVars());
    const response = await hooks(env, '/hooks/mail', post({ ...JSON_BEARER, authorization: `Bearer ${PREVIOUS}`, 'idempotency-key': '' }));
    expect(response.status).toBe(204);
    expect(core[0]?.headers.get('idempotency-key')).toBe('');
  });

  it('passes the core answer through unchanged', async () => {
    const conflict = new Response('{"error":{}}', { status: 409, headers: { 'content-type': 'application/json', 'x-core': '1' } });
    const { env } = fakes(await webhookVars(), () => conflict);
    const response = await hooks(env, '/hooks/mail', post(JSON_BEARER));
    expect(response).toBe(conflict);
  });

  it('forwards a body without Content-Length for the core to cap', async () => {
    const { env, core } = fakes(await webhookVars());
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(EVENT));
        controller.close();
      },
    });
    const response = await hooks(env, '/hooks/mail', { ...post(JSON_BEARER, null), body: chunked, duplex: 'half' } as RequestInit & { headers: Record<string, string> });
    expect(response.status).toBe(204);
    expect(core[0]?.headers.has('content-length')).toBe(false);
  });

  it('rejects in the documented order without calling the core', async () => {
    const vars = await webhookVars();
    const cases: [string, Vars, Record<string, string>, number, string][] = [
      ['no digest', { MAIL_WEBHOOK_TOKEN_SHA256: ' ', MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS: undefined }, JSON_BEARER, 503, 'not_configured'],
      ['missing token', vars, { 'content-type': 'application/json' }, 401, 'unauthorized'],
      ['wrong token', vars, { ...JSON_BEARER, authorization: 'Bearer nope' }, 401, 'unauthorized'],
      ['lowercase scheme', vars, { ...JSON_BEARER, authorization: `bearer ${TOKEN}` }, 401, 'unauthorized'],
      ['double space', vars, { ...JSON_BEARER, authorization: `Bearer  ${TOKEN}` }, 401, 'unauthorized'],
      ['token with a space', vars, { ...JSON_BEARER, authorization: `Bearer ${TOKEN} x` }, 401, 'unauthorized'],
      ['digest as token', vars, { ...JSON_BEARER, authorization: `Bearer ${await sha256(TOKEN)}` }, 401, 'unauthorized'],
      ['maintenance before 415', { ...vars, MAINTENANCE_MODE: 'true' }, { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' }, 503, 'maintenance'],
      ['wrong media type', vars, { ...JSON_BEARER, 'content-type': 'application/jsonx' }, 415, 'unsupported_media_type'],
      ['no media type', vars, { authorization: `Bearer ${TOKEN}` }, 415, 'unsupported_media_type'],
      ['declared too large', vars, { ...JSON_BEARER, 'content-length': '1048577' }, 413, 'payload_too_large'],
    ];
    for (const [name, caseVars, headers, status, code] of cases) {
      const { env, core } = fakes(caseVars);
      const response = await hooks(env, '/hooks/mail', post(headers, null));
      expect(response.status, name).toBe(status);
      expect(await errorCode(response), name).toBe(code);
      expect(response.headers.get('www-authenticate'), name).toBeNull();
      expect(core, name).toHaveLength(0);
    }
  });

  it('asks Mail Hero to come back after one cron interval during maintenance', async () => {
    const { env } = fakes(await webhookVars({ MAINTENANCE_MODE: ' true ' }));
    const response = await hooks(env, '/hooks/mail', post(JSON_BEARER, null));
    expect(response.headers.get('retry-after')).toBe('600');
  });

  it('forwards a body of exactly 1 MiB', async () => {
    const { env, core } = fakes(await webhookVars());
    const response = await hooks(env, '/hooks/mail', post({ ...JSON_BEARER, 'content-length': '1048576' }, null));
    expect(response.status).toBe(204);
    expect(core).toHaveLength(1);
  });

  it('answers 503 unavailable when the core cannot be reached', async () => {
    const { env } = fakes(await webhookVars(), () => {
      throw new Error('stub down');
    });
    const response = await hooks(env, '/hooks/mail', post(JSON_BEARER));
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('unavailable');
  });
});

// 41 bytes, so its base64 ends with one '='.
const REPORT_CREDENTIAL = 'newsletter:correct-horse-battery-staple-1';
const basic = (credential: string): string => `Basic ${btoa(credential)}`;

describe('newsletter reports', () => {
  // A fresh module per test: the lockout hour is per isolate.
  let lockedCalls = 0;
  const reply = (call: CoreCall): Response => {
    if (call.url.pathname === '/newsletter/auth-failure') {
      lockedCalls += 1;
      return lockedCalls > 2
        ? new Response('{}', { status: 429, headers: { 'retry-after': '120' } })
        : new Response('{}', { status: 401, headers: { 'www-authenticate': 'Basic realm="todofy"' } });
    }
    return Response.json({ status: 'ok' });
  };

  beforeEach(() => {
    lockedCalls = 0;
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T12:58:20Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function reportVars(): Promise<Vars> {
    return { REPORT_BASIC_AUTH_SHA256: `${await sha256('old:rotated-out')}, ${(await sha256(REPORT_CREDENTIAL)).toUpperCase()}` };
  }

  async function get(env: Parameters<typeof send>[0], path: string, authorization?: string): Promise<Response> {
    const { default: worker } = await import('../src/index.ts');
    const request = new Request(`http://daily.localhost${path}`, authorization ? { headers: { authorization } } : {});
    return worker.fetch(request as never, env);
  }

  it('serves a correct credential from the core with the original query and never counts it', async () => {
    const { env, core } = fakes(await reportVars(), reply);
    const summary = await get(env, '/api/summary', basic(REPORT_CREDENTIAL));
    expect(summary.status).toBe(200);
    const recommendation = await get(env, '/api/recommendation?top=5&x=%20y', `basic   ${btoa(REPORT_CREDENTIAL)}  `);
    expect(recommendation.status).toBe(200);
    expect(core.map((call) => call.url.href)).toEqual([
      'https://coordinator/newsletter/summary',
      'https://coordinator/newsletter/recommendation?top=5&x=%20y',
    ]);
    expect(core.every((call) => call.method === 'GET' && call.headers.get('x-todofy-internal') === '1')).toBe(true);
    expect(core[0]?.headers.has('authorization')).toBe(false);
  });

  it('counts a failure in the core and returns its answer', async () => {
    const { env, core } = fakes(await reportVars(), reply);
    const response = await get(env, '/api/summary', basic('newsletter:wrong'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="todofy"');
    expect(core.map((call) => [call.method, call.url.pathname])).toEqual([['POST', '/newsletter/auth-failure']]);
    expect(core[0]?.body).toBeNull();
  });

  it('decodes Basic strictly, as base64.b64decode(validate=True)', async () => {
    const { env, core } = fakes(await reportVars(), reply);
    const encoded = btoa(REPORT_CREDENTIAL);
    for (const header of [
      `Bearer ${encoded}`,
      `Basic ${encoded.replace(/=+$/, '')}`,
      `Basic ${encoded}=`,
      `Basic ${encoded.slice(0, 4)} ${encoded.slice(4)}`,
      'Basic',
      '',
    ]) {
      expect((await get(env, '/api/summary', header || undefined)).status, header).not.toBe(200);
    }
    expect(core.every((call) => call.url.pathname === '/newsletter/auth-failure')).toBe(true);
  });

  it('keeps answering 429 without the core once locked, but still serves the correct credential', async () => {
    const { env, core } = fakes(await reportVars(), reply);
    expect((await get(env, '/api/summary', basic('x:1'))).status).toBe(401);
    expect((await get(env, '/api/summary', basic('x:2'))).status).toBe(401);
    const locked = await get(env, '/api/summary', basic('x:3'));
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('120');
    expect(core).toHaveLength(3);

    const local = await get(env, '/api/recommendation', basic('x:4'));
    expect(local.status).toBe(429);
    expect(await errorCode(local)).toBe('rate_limited');
    expect(local.headers.get('retry-after')).toBe('100');
    expect(core).toHaveLength(3);

    expect((await get(env, '/api/summary', basic(REPORT_CREDENTIAL))).status).toBe(200);
    expect(core).toHaveLength(4);

    vi.setSystemTime(new Date('2026-09-29T13:00:00Z'));
    lockedCalls = 0;
    expect((await get(env, '/api/summary', basic('x:5'))).status).toBe(401);
    expect(core).toHaveLength(5);
  });

  it('answers 503 when no credential is configured or the core is down', async () => {
    const unconfigured = fakes({ REPORT_BASIC_AUTH_SHA256: ' , ' }, reply);
    const response = await get(unconfigured.env, '/api/summary', basic(REPORT_CREDENTIAL));
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('not_configured');
    expect(unconfigured.core).toHaveLength(0);

    const down = fakes(await reportVars(), () => {
      throw new Error('stub down');
    });
    for (const credential of [REPORT_CREDENTIAL, 'x:wrong']) {
      const failed = await get(down.env, '/api/summary', basic(credential));
      expect(failed.status).toBe(503);
      expect(await errorCode(failed)).toBe('unavailable');
    }
  });
});
