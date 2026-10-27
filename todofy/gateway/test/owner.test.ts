import { describe, expect, it } from 'vitest';
import { errorCode, fakes, logged, OWNER, owner, statusReason, uiOk, uiRefusal, type CoreCall, type CoreReply, type StatusBody } from './helpers.ts';

const ORIGIN = 'http://todofy.localhost:8787';
const EVENT = '0b8f5a4e-3c1d-4c52-9f0e-2d7c8b6a5f41';
const RECONCILE = `/api/v1/mailEvents/${EVENT}:reconcile`;
const RECONCILE_BODY = JSON.stringify({ action: 'dismiss', etag: '3', request_id: '3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11' });
const AT = '2026-09-28T08:00:00Z';

function csrfHeaders(token: string, origin = ORIGIN): Record<string, string> {
  return { origin, 'x-csrf-token': token };
}

/** A reconcile with a valid CSRF pair (or the given headers). */
async function reconcile(env: Parameters<typeof owner>[0], headers?: Record<string, string>, body = RECONCILE_BODY): Promise<Response> {
  return owner(env, RECONCILE, { method: 'POST', body, headers: { 'content-type': 'application/json', ...(headers ?? csrfHeaders('1')) } });
}

function expectPrivate(response: Response, cacheControl = 'no-store'): void {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) {
    expect(response.headers.get(name), name).toBe(name === 'cache-control' ? cacheControl : value);
  }
}

/** The owner host's headers, byte for byte (docs/gateway-contract.md §2.3). */
const PRIVATE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'",
};

const EVENT_DETAIL = { name: `mailEvents/${EVENT}`, state: 'todo_unknown', receive_time: AT, version: 3, etag: '3', allowed_actions: ['dismiss'] };
const STATUS = { name: 'serviceStatus', build: 'core', read_time: AT, attention_count: 2 };

/** TodofyCore answering every rpc with a small valid message. */
const core: CoreReply = (call) => {
  if (call.method !== 'owner_ui') return undefined;
  switch (call.args[1]) {
    case 'GetServiceStatus':
      return uiOk(STATUS);
    case 'ListMailEvents':
      return uiOk({ mail_events: [{ name: `mailEvents/${EVENT}`, state: 'pending' }] });
    default:
      return uiOk(EVENT_DETAIL);
  }
};

function request(call: CoreCall | undefined): unknown {
  return JSON.parse(String(call?.args[2]));
}

describe('private headers and assets', () => {
  it('adds the private headers to assets, the SPA fallback and API answers', async () => {
    const { env } = fakes({}, core);
    for (const path of ['/', '/events/abc', '/assets/missing-chunk.js', '/favicon.svg', '/api/v1/serviceStatus']) {
      const response = await owner(env, path);
      expect(response.status, path).toBe(200);
      expectPrivate(response);
    }
  });

  it('lets the browser cache only a real hashed file under /assets/', async () => {
    const { env } = fakes();
    const hashed = await owner(env, '/assets/app-1a2b3c.js');
    expect(hashed.headers.get('content-type')).toBe('text/javascript');
    expectPrivate(hashed, 'private, max-age=31536000, immutable');

    const fallback = await owner(env, '/assets/app-old.js');
    expect(fallback.headers.get('content-type')).toBe('text/html');
    expectPrivate(fallback);

    const post = await owner(env, '/assets/app-1a2b3c.js', { method: 'POST', headers: csrfHeaders('1') });
    expect(post.status).toBe(405);
    expectPrivate(post);
  });

  it('keeps the private headers on gate errors', async () => {
    const { env } = fakes({ DEV_AUTH_BYPASS: undefined });
    const response = await owner(env, '/');
    expect(response.status).toBe(503);
    expect(await statusReason(response)).toBe('ACCESS_NOT_CONFIGURED');
    expectPrivate(response);
  });
});

describe('todofy.ui.v1 through the transcoder', () => {
  it('passes the verified owner, the rpc and the decoded request, and nothing else from the client', async () => {
    const { env, core: calls } = fakes({}, core);
    const response = await reconcile(env, {
      ...csrfHeaders('1'),
      authorization: 'Bearer x',
      'cf-access-jwt-assertion': 'jwt',
      'x-todofy-owner': 'intruder@example.com',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(EVENT_DETAIL);
    expect(calls).toEqual([
      {
        instance: 'inbox-v1',
        method: 'owner_ui',
        args: [OWNER, 'ReconcileMailEvent', JSON.stringify({ name: `mailEvents/${EVENT}`, action: 'dismiss', etag: '3', request_id: '3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11' }), null],
      },
    ]);
  });

  it('reads a GET from the path and query, strictly', async () => {
    const { env, core: calls } = fakes({}, core);
    expect((await owner(env, '/api/v1/mailEvents?page_size=5&filter=state%20%3D%20TODO_UNKNOWN')).status).toBe(200);
    // The filter's grammar is TodofyCore's (core/owner_ui.event_filter); the gateway passes the string on.
    expect(request(calls[0])).toEqual({ page_size: 5, filter: 'state = TODO_UNKNOWN' });
    for (const path of ['/api/v1/mailEvents?view=recent', '/api/v1/mailEvents?state=pending', '/api/v1/mailEvents?page_size=x']) {
      const refused = await owner(env, path);
      expect(refused.status, path).toBe(400);
      expect(await statusReason(refused)).toBe('BAD_REQUEST');
    }
    expect(calls).toHaveLength(1);
  });

  it('makes up a request_id for a mutation sent without one', async () => {
    const { env, core: calls } = fakes({}, core);
    expect((await reconcile(env, undefined, JSON.stringify({ action: 'dismiss', etag: '3' }))).status).toBe(200);
    expect((request(calls[0]) as { request_id: string }).request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('wraps the cursor TodofyCore answers in a page token bound to the list parameters', async () => {
    const { env, core: calls } = fakes({}, (call) => uiOk({ mail_events: [] }, call.args[3] === null ? { at: 1, id: EVENT } : null));
    const first = await owner(env, '/api/v1/mailEvents?filter=state%3DPENDING');
    const { next_page_token: token } = await first.json<{ next_page_token: string }>();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(calls[0]?.args)).not.toContain(token);

    const second = await owner(env, `/api/v1/mailEvents?filter=state%3DPENDING&page_size=3&page_token=${token}`);
    expect(await second.json()).toEqual({});
    expect(calls[1]?.args[3]).toBe(JSON.stringify({ at: 1, id: EVENT }));
    expect(request(calls[1])).toEqual({ page_size: 3, filter: 'state=PENDING' });

    // A token of other parameters, or no token at all, never reaches the core.
    for (const path of [`/api/v1/mailEvents?filter=attention%3Dtrue&page_token=${token}`, '/api/v1/mailEvents?page_token=x']) {
      const refused = await owner(env, path);
      expect(refused.status, path).toBe(400);
      expect(await statusReason(refused)).toBe('BAD_REQUEST');
    }
    expect(calls).toHaveLength(2);
  });

  it('maps TodofyCore refusals to their codes, with the event and Retry-After', async () => {
    const cases: [ReturnType<typeof uiRefusal>, number, string][] = [
      [uiRefusal('ETAG_MISMATCH', EVENT_DETAIL), 409, 'ABORTED'],
      [uiRefusal('ACTION_NOT_ALLOWED', EVENT_DETAIL), 400, 'FAILED_PRECONDITION'],
      [uiRefusal('BAD_REQUEST'), 400, 'INVALID_ARGUMENT'],
      [uiRefusal('NOT_FOUND'), 404, 'NOT_FOUND'],
      [uiRefusal('RATE_LIMITED', null, 42), 429, 'RESOURCE_EXHAUSTED'],
      [uiRefusal('UNAVAILABLE'), 503, 'UNAVAILABLE'],
      // A bug in TodofyCore (runtime/owner_ui.handle): never retryable.
      [uiRefusal('INTERNAL'), 500, 'INTERNAL'],
      [uiRefusal('SOMETHING_NEW'), 500, 'INTERNAL'],
    ];
    for (const [answer, status, code] of cases) {
      const { env } = fakes({}, () => answer);
      const response = await reconcile(env);
      expect(response.status, answer.error).toBe(status);
      const body = await response.clone().json<StatusBody>();
      expect(body.error.status).toBe(code);
      expect(await statusReason(response)).toBe(answer.error === 'SOMETHING_NEW' ? 'INTERNAL' : answer.error);
      expectPrivate(response);
      const event = body.error.details.find((detail) => detail['@type'] === 'type.googleapis.com/todofy.ui.v1.MailEvent');
      expect(event === undefined, answer.error).toBe(answer.detail === null);
      if (event !== undefined) expect(event).toMatchObject({ name: `mailEvents/${EVENT}`, etag: '3' });
      expect(response.headers.get('retry-after')).toBe(answer.retry_after === null ? null : String(answer.retry_after));
    }
  });

  it('localizes every reason and logs only the request ID, status and reason', async () => {
    const { env } = fakes({}, () => uiRefusal('ETAG_MISMATCH', EVENT_DETAIL));
    const response = await reconcile(env);
    const body = await response.json<StatusBody>();
    const localized = body.error.details.find((detail) => detail['@type'] === 'type.googleapis.com/google.rpc.LocalizedMessage');
    expect(localized).toEqual({ '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'zh-CN', message: '事件已被更新，请刷新后重试' });
    const [line] = logged() as { request_id: string }[];
    expect(logged()).toHaveLength(1);
    expect(line).toEqual({ request_id: line?.request_id, status: 409, reason: 'ETAG_MISMATCH' });
    expect(line?.request_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('passes an answer that is not a page through as TodofyCore wrote it', async () => {
    const text = JSON.stringify({ name: `legacyTexts/${EVENT}`, create_time: AT, text: '旧邮件 "quoted" \\ \r\n' });
    const { env, core: calls } = fakes({}, () => ({ ok: text, next_cursor: null }));
    const response = await owner(env, `/api/v1/legacyTexts/${EVENT}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expectPrivate(response);
    expect(await response.text()).toBe(text);
    expect(calls[0]?.args.slice(1)).toEqual(['GetLegacyText', JSON.stringify({ name: `legacyTexts/${EVENT}` }), null]);
  });

  it('answers UNAVAILABLE when TodofyCore cannot be reached, and INTERNAL for a page it cannot read', async () => {
    const down = await owner(fakes({}, () => {
      throw new Error('stub down');
    }).env, '/api/v1/serviceStatus');
    expect(down.status).toBe(503);
    expect(await statusReason(down)).toBe('UNAVAILABLE');
    expectPrivate(down);

    const garbled = await owner(fakes({}, () => uiOk({ mail_events: 7 })).env, '/api/v1/mailEvents');
    expect(garbled.status).toBe(500);
    expect(await statusReason(garbled)).toBe('INTERNAL');
  });

  it('answers other API paths NOT_FOUND and a known path another method 405, without calling the core', async () => {
    const { env, core: calls } = fakes({}, core);
    // The reminder and GTD lists retired on 2026-10-21 (proto/retired.json) are unknown paths too.
    const retired = ['/api/v1/dailyReminders', '/api/v1/gtdDays', '/api/v1/gtdReviews'];
    for (const path of ['/api/summary', '/api/v1', '/api/v1/nope', '/api/v2/serviceStatus', '/api', ...retired]) {
      const response = await owner(env, path);
      expect(response.status, path).toBe(404);
      expect(await statusReason(response)).toBe('NOT_FOUND');
    }
    const wrong = await owner(env, '/api/v1/serviceStatus', { method: 'DELETE', headers: csrfHeaders('1') });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(calls).toHaveLength(0);
  });
});

describe('the owner API before todofy.ui.v1', () => {
  it('answers 410 reload_required in its old envelope, for one release', async () => {
    const { env, core: calls } = fakes({}, core);
    for (const [path, method] of [
      ['/api/v1/overview', 'GET'],
      ['/api/v1/events?view=recent&limit=50', 'GET'],
      [`/api/v1/events/${EVENT}`, 'GET'],
      [`/api/v1/events/${EVENT}/reconcile`, 'POST'],
      ['/api/v1/reminders', 'GET'],
      ['/api/v1/reports/latest', 'GET'],
      ['/api/v1/reports/recompute', 'POST'],
      ['/api/v1/metrics/daily?days=30', 'GET'],
      ['/api/v1/gtd/daily', 'GET'],
      [`/api/v1/legacy_text/${EVENT}`, 'GET'],
      ['/api/v1/setup', 'GET'],
      ['/api/v1/csrf', 'GET'],
    ] as const) {
      const response = await owner(env, path, { method });
      expect(response.status, path).toBe(410);
      expect(await errorCode(response), path).toBe('reload_required');
      expectPrivate(response);
    }
    expect(calls).toHaveLength(0);
  });

  it('keeps the old envelope for a failed login there too', async () => {
    const { env } = fakes({ DEV_AUTH_BYPASS: undefined });
    const response = await owner(env, '/api/v1/overview');
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('access_not_configured');
  });
});

describe('task links', () => {
  it('redirects /task/<id> to the task in Tasks, with the private headers and without calling the core', async () => {
    const { env, core: calls } = fakes({ TASKS_PUBLIC_URL: 'https://tasks.example.test/' });
    for (const id of ['6Jf8VQXxpwv56VQ7', 't0a1b2c3-d4_e5']) {
      const response = await owner(env, `/task/${id}`);
      expect(response.status, id).toBe(302);
      expect(response.headers.get('location')).toBe(`https://tasks.example.test/?task=${id}`);
      expectPrivate(response);
    }
    expect(calls).toEqual([]);
  });

  it('refuses another ID or method, a missing Tasks URL, and anyone the Access gate does not pass', async () => {
    const { env } = fakes({ TASKS_PUBLIC_URL: 'https://tasks.example.test' });
    for (const path of ['/task/', '/task/a/b', '/task/a%2Fb', '/task/<x>', `/task/${'a'.repeat(129)}`]) {
      const response = await owner(env, path);
      expect(response.status, path).toBe(404);
      expect(await statusReason(response)).toBe('NOT_FOUND');
    }
    const post = await owner(env, '/task/abc', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(await statusReason(await owner(fakes().env, '/task/abc'))).toBe('NOT_CONFIGURED');
    const gated = await owner(fakes({ DEV_AUTH_BYPASS: undefined, TASKS_PUBLIC_URL: 'https://tasks.example.test' }).env, '/task/abc');
    expect(gated.status).toBe(503);
    expect(gated.headers.get('location')).toBeNull();
  });
});

describe('GetIntegration', () => {
  const coreSetup = {
    mail_source_id: 'mail-hero-personal',
    // A core before 2026-10-21 also answered todoist_project; Todofy files no task any more, so it is never shown.
    configured: { gemini_api_key: true, todoist_project: true },
  };

  it('merges the gateway facts with the core facts', async () => {
    const { env, core: calls } = fakes(
      { TODOFY_HOOKS_HOSTS: 'Todofy-Hooks.localhost, daily.localhost', MAIL_WEBHOOK_TOKEN_SHA256: 'abc', ACCESS_OWNER: 'Owner@Example.com' },
      () => coreSetup,
    );
    const response = await owner(env, '/api/v1/integration');
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual({
      name: 'integration',
      build: 'test',
      public_host: 'todofy.localhost',
      hooks_hosts: ['todofy-hooks.localhost', 'daily.localhost'],
      webhook_path: '/hooks/mail',
      mail_source_id: 'mail-hero-personal',
      access_owner: OWNER,
      configured: { mail_webhook_token: true, gemini_api_key: true },
    });
    expect(calls).toEqual([{ instance: 'inbox-v1', method: 'setup', args: [] }]);
  });

  it('answers UNAVAILABLE when the core cannot answer', async () => {
    const reply: CoreReply = () => {
      throw new Error('stub down');
    };
    const response = await owner(fakes({}, reply).env, '/api/v1/integration');
    expect(response.status).toBe(503);
    expect(await statusReason(response)).toBe('UNAVAILABLE');
  });
});

describe('same-origin JSON mutations', () => {
  it('returns a static compatibility header without setting a cookie or requiring a key', async () => {
    const { env, core: calls } = fakes({}, core);
    const response = await owner(env, '/api/csrf');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: '1' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expectPrivate(response);
    expect((await reconcile(env, csrfHeaders('1'))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
  it('checks exact Origin, custom header and JSON media type before malformed JSON or core calls', async () => {
    const { env, core: calls } = fakes({}, core);
    const cases: Record<string, Record<string, string>> = {
      missingOrigin: { 'x-csrf-token': '1' }, nullOrigin: csrfHeaders('1', 'null'),
      foreignOrigin: csrfHeaders('1', 'https://foreign.example.test'),
      uppercaseOrigin: csrfHeaders('1', 'HTTP://TODOFY.LOCALHOST:8787'),
      missingHeader: { origin: ORIGIN }, emptyHeader: csrfHeaders(''),
      tooLong: csrfHeaders('x'.repeat(1025)),
      form: { ...csrfHeaders('1'), 'content-type': 'application/x-www-form-urlencoded' },
      text: { ...csrfHeaders('1'), 'content-type': 'text/plain' },
      missingType: { ...csrfHeaders('1'), 'content-type': '' },
    };
    for (const [name, headers] of Object.entries(cases)) {
      const response = await reconcile(env, headers, 'not json');
      expect(response.status, name).toBe(403);
      expect(await statusReason(response), name).toBe('CSRF_FAILED');
    }
    expect(calls).toHaveLength(0);
  });
  it('accepts cached opaque headers without a cookie while preserving owner authentication', async () => {
    const { env, core: calls } = fakes({}, core);
    expect((await reconcile(env, csrfHeaders('legacy.cached.header'))).status).toBe(200);
    expect(calls[0]?.args[0]).toBe(OWNER);
    const post = await owner(env, '/api/csrf', { method: 'POST' });
    expect(post.status).toBe(405);
  });
});

describe('maintenance', () => {
  it('blocks writes after the CSRF check and keeps reads', async () => {
    const { env, core: calls } = fakes({ MAINTENANCE_MODE: 'true' }, core);
    const forged = await reconcile(env, {});
    expect(forged.status).toBe(403);

    const write = await reconcile(env);
    expect(write.status).toBe(503);
    expect(await statusReason(write)).toBe('MAINTENANCE');
    expect(write.headers.get('retry-after')).toBe('300');
    expectPrivate(write);
    expect(calls).toHaveLength(0);

    expect((await owner(env, '/api/v1/serviceStatus')).status).toBe(200);
    expect((await owner(env, '/api/csrf')).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
