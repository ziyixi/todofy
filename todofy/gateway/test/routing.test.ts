import { describe, expect, it } from 'vitest';
import apiErrors from '../../worker/todofy/core/api_errors.py?raw';
import { MESSAGES } from '../src/http.ts';
import worker from '../src/index.ts';
import { bodyText, errorCode, fakes, hooks, logged, NO_CONTENT, owner, send } from './helpers.ts';

describe('host routing', () => {
  it('answers an unknown host with 404 and never calls the core', async () => {
    const { env, core, assets } = fakes();
    const response = await send(env, 'http://elsewhere.example/health');
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(core).toHaveLength(0);
    expect(assets).toHaveLength(0);
  });


  it('matches hosts case-insensitively and serves every hooks host', async () => {
    const { env } = fakes({ TODOFY_HOOKS_HOSTS: ' Todofy-Hooks.localhost , DAILY.localhost ' });
    expect((await send(env, 'http://TODOFY-HOOKS.localhost/health')).status).toBe(200);
    expect((await send(env, 'http://daily.localhost/health')).status).toBe(200);
    expect((await send(env, 'http://TODOFY.LOCALHOST/')).headers.get('content-type')).toBe('text/html');
  });

  it('checks the public host before the hooks hosts', async () => {
    const { env } = fakes({ TODOFY_HOOKS_HOSTS: 'todofy.localhost' });
    const response = await owner(env, '/health');
    expect(response.headers.get('content-type')).toBe('text/html');
  });

  it('logs only the request ID, status and code of an error it emits', async () => {
    const { env } = fakes();
    const response = await send(env, 'http://elsewhere.example/?secret=1', {
      headers: { authorization: 'Bearer secret-token' },
    });
    const body = await response.json<{ error: { request_id: string } }>();
    expect(logged()).toEqual([{ request_id: body.error.request_id, status: 404, code: 'not_found' }]);
  });

  it('gives every request its own ID', async () => {
    const { env } = fakes();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const body = await (await send(env, 'http://elsewhere.example/')).json<{ error: { request_id: string } }>();
      ids.add(body.error.request_id);
    }
    expect(ids.size).toBe(5);
  });
});

describe('unread uploads', () => {
  /** A request body that records whether the gateway cancelled it. */
  function upload(): {
    request: (url: string, headers?: Record<string, string>) => Request;
    cancelled: () => boolean;
  } {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return {
      request: (url, headers = {}) =>
        new Request(url, { method: 'POST', body: stream, headers, duplex: 'half' } as RequestInit),
      cancelled: () => cancelled,
    };
  }

  it('discards the body of a request answered on its headers alone', async () => {
    const { env, core } = fakes({ MAIL_WEBHOOK_TOKEN_SHA256: 'ab'.repeat(32) });
    const answers: [string, number][] = [
      ['http://todofy-hooks.localhost/hooks/mail', 401],
      ['http://elsewhere.example/', 404],
      ['http://todofy.localhost/api/v1/mailEvents/x:reconcile', 403],
    ];
    for (const [url, status] of answers) {
      const body = upload();
      const request = body.request(url, { authorization: 'Bearer wrong' });
      expect((await worker.fetch(request as never, env)).status).toBe(status);
      expect(body.cancelled()).toBe(true);
    }
    expect(core).toHaveLength(0);
  });

  it('leaves a body the core took alone', async () => {
    const token = 'webhook-token';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const { env, core } = fakes({ MAIL_WEBHOOK_TOKEN_SHA256: hex }, async (call) => {
      await bodyText(call);
      return NO_CONTENT;
    });
    const body = upload();
    const request = body.request('http://todofy-hooks.localhost/hooks/mail', {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    });
    expect((await worker.fetch(request as never, env)).status).toBe(204);
    expect(core).toHaveLength(1);
    expect(body.cancelled()).toBe(false);
  });
});

describe('health', () => {
  it('has the Go service shape the newsletter preflight reads, without calling the core', async () => {
    const { env, core } = fakes();
    const response = await hooks(env, '/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json<Record<string, string>>();
    expect(Object.keys(body)).toEqual(['build', 'service', 'status', 'timestamp']);
    expect(body).toMatchObject({ build: 'test', service: 'todofy', status: 'healthy' });
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(core).toHaveLength(0);
  });

  it('reports "unknown" only when BUILD_SHA is not set', async () => {
    const unset = await (await hooks(fakes({ BUILD_SHA: undefined }).env, '/health')).json<{ build: string }>();
    expect(unset.build).toBe('unknown');
    const empty = await (await hooks(fakes({ BUILD_SHA: '' }).env, '/health')).json<{ build: string }>();
    expect(empty.build).toBe('');
  });

  it('answers only the four hooks routes and their methods', async () => {
    const { env, core } = fakes();
    for (const [method, path] of [
      ['HEAD', '/health'],
      ['POST', '/health'],
      ['GET', '/hooks/mail'],
      ['POST', '/api/summary'],
      ['GET', '/api/v1/overview'],
      ['GET', '/'],
    ] as const) {
      const response = await hooks(env, path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(core).toHaveLength(0);
  });
});

describe('cron', () => {
  it('wakes the coordinator', async () => {
    const { env, core } = fakes({}, () => undefined);
    await worker.scheduled(
      { cron: '*/10 * * * *', scheduledTime: 0, noRetry: () => undefined },
      env,
    );
    expect(core).toEqual([{ instance: 'inbox-v1', method: 'wake', args: [] }]);
  });

  it('fails the invocation when the coordinator cannot be reached', async () => {
    const { env } = fakes({}, () => {
      throw new Error('stub down');
    });
    await expect(
      worker.scheduled({ cron: '*/10 * * * *' } as ScheduledController, env),
    ).rejects.toThrow('stub down');
  });
});

describe('error messages', () => {
  it('match the Python ApiError table', () => {
    const names = new Map([...apiErrors.matchAll(/^ {4}([A-Z_]+) = "([a-z_]+)"$/gm)].map((m) => [m[1], m[2]]));
    const python = new Map(
      [...apiErrors.matchAll(/^ {4}ApiError\.([A-Z_]+): "(.+)",$/gm)].map((m) => [names.get(m[1] ?? ''), m[2]]),
    );
    expect(python.size).toBeGreaterThanOrEqual(Object.keys(MESSAGES).length);
    for (const [code, message] of Object.entries(MESSAGES)) expect(python.get(code), code).toBe(message);
  });
});
