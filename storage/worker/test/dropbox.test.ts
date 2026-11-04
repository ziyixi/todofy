import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dropbox, endpoints, spaceAnswer } from '../src/dropbox.ts';
import type { Connection } from '../src/store.ts';

class Memory {
  readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key) ?? null; }
  set(key: string, value: unknown): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
  connection(): Connection | null { return this.get('connection') as Connection | null; }
}

const connection: Connection = { appKey: 'syntheticappkey', refreshToken: 'synthetic-refresh-private', generation: 'synthetic-generation' };

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('separate Dropbox authorization', () => {
  it('requests offline S256, consumes state once and stores the refresh token without returning it', async () => {
    const store = new Memory();
    const provider = new Dropbox(store, {});
    const authorize = new URL(await provider.connect('syntheticappkey', 'https://storage.example.test/api/dropbox/callback'));
    expect(authorize.origin).toBe('https://www.dropbox.com');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('token_access_type')).toBe('offline');
    expect(authorize.searchParams.get('scope')).toBe('account_info.read files.metadata.read files.content.read files.content.write');
    store.set('space', { state: 'scope_missing', used: 0, allocated: 0, time: 1 });
    const requests: URLSearchParams[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      requests.push(new URLSearchParams(init.body as string));
      return Promise.resolve(Response.json({ access_token: 'synthetic-access-private', refresh_token: 'synthetic-refresh-private', expires_in: 3600 }));
    }));
    const search = new URLSearchParams({ state: authorize.searchParams.get('state') ?? '', code: 'synthetic-code' });
    await provider.callback(search);
    expect(store.connection()?.refreshToken).toBe('synthetic-refresh-private');
    // A new connection reads its own space.
    expect(store.get('space')).toBeNull();
    expect(requests[0]?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(requests[0]?.has('client_secret')).toBe(false);
    await expect(provider.callback(search)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it('refreshes concurrently only once, retains a nonrotated refresh token, and refreshes on expiry', async () => {
    vi.useFakeTimers();
    const store = new Memory();
    store.set('connection', connection);
    const calls: URLSearchParams[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      calls.push(new URLSearchParams(init.body as string));
      return Promise.resolve(Response.json({ access_token: 'synthetic-access-' + String(calls.length), expires_in: 3600 }));
    }));
    const provider = new Dropbox(store, {});
    const tokens = await Promise.all([provider.token(), provider.token()]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.get('grant_type')).toBe('refresh_token');
    expect(calls[0]?.has('code_verifier')).toBe(false);
    expect(store.connection()).toEqual(connection);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(await provider.token()).toBe('synthetic-access-2');
    expect(calls).toHaveLength(2);
  });

  it('cannot reinstall a refresh session after the owner disconnects it during a refresh', async () => {
    const store = new Memory();
    store.set('connection', connection);
    let answer: ((value: Response) => void) | undefined;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { answer = resolve; }));
    const pending = new Dropbox(store, {}).token();
    store.delete('connection');
    answer?.(Response.json({ access_token: 'synthetic-access-private', expires_in: 3600 }));
    await expect(pending).rejects.toThrow();
    expect(store.connection()).toBeNull();
  });

  it('ignores a fake provider origin when the explicit local bypass is absent', () => {
    expect(endpoints({ DEV_DROPBOX_ORIGIN: 'http://127.0.0.1:12345' }).api).toBe('https://api.dropboxapi.com');
    expect(endpoints({ DEV_AUTH_BYPASS: 'true', DEV_DROPBOX_ORIGIN: 'https://evil.example.test' }).api).toBe('https://api.dropboxapi.com');
  });

  it('does not complete an authorization exchange after the owner cancelled the pending connection', async () => {
    const store = new Memory();
    const provider = new Dropbox(store, {});
    const authorize = new URL(await provider.connect('syntheticappkey', 'https://storage.example.test/api/dropbox/callback'));
    let answer: ((value: Response) => void) | undefined;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { answer = resolve; }));
    const pending = provider.callback(new URLSearchParams({ state: authorize.searchParams.get('state') ?? '', code: 'synthetic-code' }));
    await provider.disconnect();
    answer?.(Response.json({ refresh_token: 'synthetic-private-refresh', access_token: 'synthetic-private-access', expires_in: 3600 }));
    await expect(pending).rejects.toMatchObject({ reason: 'REVISION_CONFLICT' });
    expect(store.connection()).toBeNull();
  });
});

describe('connections Dropbox already revoked', () => {
  function provider(token: number, revoke = 200): { readonly store: Memory; readonly dropbox: Dropbox; readonly paths: string[] } {
    const store = new Memory();
    store.set('connection', connection);
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith('/oauth2/token')) return Promise.resolve(token === 200 ? Response.json({ access_token: 'synthetic-access-private', expires_in: 3600 }) : new Response(null, { status: token }));
      return Promise.resolve(new Response(revoke === 200 ? 'null' : null, { status: revoke }));
    }));
    return { store, dropbox: new Dropbox(store, {}), paths };
  }

  it('disconnects without a revoke call when Dropbox refuses the refresh token', async () => {
    for (const status of [400, 401, 403]) {
      const { store, dropbox, paths } = provider(status);
      await dropbox.disconnect();
      expect(store.connection()).toBeNull();
      expect(paths).toEqual(['/oauth2/token']);
    }
  });

  it('treats a refused revoke as already revoked and keeps the connection after a transient failure', async () => {
    for (const status of [400, 401, 403]) {
      const { store, dropbox, paths } = provider(200, status);
      await dropbox.disconnect();
      expect(store.connection()).toBeNull();
      expect(paths).toEqual(['/oauth2/token', '/2/auth/token/revoke']);
    }
    for (const [token, revoke] of [[200, 503], [200, 429], [503, 200]] as const) {
      const { store, dropbox } = provider(token, revoke);
      await expect(dropbox.disconnect()).rejects.toMatchObject({ code: 14 });
      expect(store.connection()).toEqual(connection);
    }
  });

  it('reconnects only after Dropbox refused the installed authorization', async () => {
    const valid = provider(200);
    await expect(valid.dropbox.connect('syntheticappkey', 'https://storage.example.test/api/dropbox/callback')).rejects.toMatchObject({ code: 6 });
    expect(valid.store.connection()).toEqual(connection);
    expect(valid.store.get('pending')).toBeNull();
    const revoked = provider(400);
    const authorize = new URL(await revoked.dropbox.connect('syntheticappkey', 'https://storage.example.test/api/dropbox/callback'));
    expect(revoked.store.connection()).toBeNull();
    expect((revoked.store.get('pending') as { state: string } | null)?.state).toBe(authorize.searchParams.get('state'));
  });
});

describe('provider errors for the owner console', () => {
  it('records only errors Dropbox answered, as a Storage reason and time', async () => {
    const store = new Memory();
    store.set('connection', connection);
    const provider = new Dropbox(store, {});
    let answer: () => Response = () => Response.json({ error_summary: 'path/not_found/..' }, { status: 409 });
    vi.stubGlobal('fetch', (url: string) => url.endsWith('/oauth2/token')
      ? Promise.resolve(Response.json({ access_token: 'synthetic-access-private', expires_in: 3600 })) : Promise.resolve(answer()));
    const upload = () => provider.upload({ path: '/namespaces/synthetic/file.bin' }, new Blob(['abc']).stream());
    await expect(provider.json('files/get_metadata', {})).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    answer = () => Response.json({ error_summary: 'path/conflict/file/..' }, { status: 409 });
    await expect(upload()).rejects.toMatchObject({ reason: 'REVISION_CONFLICT' });
    expect(store.get('provider_error')).toBeNull();
    answer = () => Response.json({ error_summary: 'path/insufficient_space/synthetic-private-detail' }, { status: 409 });
    await expect(upload()).rejects.toMatchObject({ reason: 'INSUFFICIENT_SPACE', httpStatus: 507 });
    expect(store.get('provider_error')).toEqual({ reason: 'INSUFFICIENT_SPACE', time: expect.any(Number) as number });
    answer = () => { throw new TypeError('synthetic network failure'); };
    await expect(provider.json('files/get_metadata', {})).rejects.toMatchObject({ reason: 'UNAVAILABLE' });
    expect(store.get('provider_error')).toMatchObject({ reason: 'INSUFFICIENT_SPACE' });
    answer = () => new Response('synthetic-private-body', { status: 503 });
    await expect(provider.json('files/get_metadata', {})).rejects.toMatchObject({ reason: 'UNAVAILABLE' });
    expect(store.get('provider_error')).toMatchObject({ reason: 'UNAVAILABLE' });
    expect(JSON.stringify(store.get('provider_error'))).not.toContain('synthetic-private');
    answer = () => new Response('null');
    await provider.disconnect();
    expect(store.get('provider_error')).toBeNull();
  });

  it('writes a repeated reason at most once a minute, its newest time with the counters, and a new reason at once', async () => {
    vi.useFakeTimers();
    const store = new Memory();
    store.set('connection', connection);
    const writes = vi.spyOn(store, 'set');
    const provider = new Dropbox(store, {});
    let answer: () => Response = () => new Response(null, { status: 429 });
    vi.stubGlobal('fetch', (url: string) => url.endsWith('/oauth2/token')
      ? Promise.resolve(Response.json({ access_token: 'synthetic-access-private', expires_in: 3600 })) : Promise.resolve(answer()));
    const refused = async (reason: string) => { await expect(provider.json('files/get_metadata', {})).rejects.toMatchObject({ reason }); };
    const recorded = () => writes.mock.calls.filter(([key]) => key === 'provider_error').map(([, value]) => value);
    await refused('UNAVAILABLE');
    const first = Date.now();
    await vi.advanceTimersByTimeAsync(59_000);
    await refused('UNAVAILABLE');
    expect(recorded()).toHaveLength(1);
    // The counter flush writes the repeat's time, so it stays newer than any success in between.
    provider.flushRepeatedFailure();
    provider.flushRepeatedFailure();
    expect(recorded()).toEqual([{ reason: 'UNAVAILABLE', time: first }, { reason: 'UNAVAILABLE', time: first + 59_000 }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await refused('UNAVAILABLE');
    expect(recorded()).toHaveLength(3);
    await refused('UNAVAILABLE');
    answer = () => new Response(null, { status: 400 });
    await refused('BAD_REQUEST');
    // A new reason replaces the pending repeat of the old one.
    provider.flushRepeatedFailure();
    expect(recorded()).toHaveLength(4);
    expect(store.get('provider_error')).toEqual({ reason: 'BAD_REQUEST', time: Date.now() });
    await refused('BAD_REQUEST');
    answer = () => new Response('null');
    await provider.disconnect();
    // Disconnecting forgets a pending repeat with the error.
    provider.flushRepeatedFailure();
    expect(store.get('provider_error')).toBeNull();
    answer = () => new Response(null, { status: 400 });
    store.set('connection', connection);
    await refused('BAD_REQUEST');
    expect(store.get('provider_error')).toMatchObject({ reason: 'BAD_REQUEST' });
  });
});

describe('Dropbox space for the owner console', () => {
  function provider(): { readonly store: Memory; readonly dropbox: Dropbox; readonly reads: () => number; answer: () => Response } {
    const store = new Memory();
    store.set('connection', connection);
    let reads = 0;
    const result = {
      store, dropbox: new Dropbox(store, {}), reads: () => reads,
      answer: (): Response => Response.json({ used: 300, allocation: { '.tag': 'individual', allocated: 1000 } }),
    };
    vi.stubGlobal('fetch', (url: string) => {
      if (url.endsWith('/oauth2/token')) return Promise.resolve(Response.json({ access_token: 'synthetic-access-private', expires_in: 3600 }));
      if (!url.endsWith('/2/users/get_space_usage')) throw new Error('unexpected synthetic Dropbox call');
      reads++;
      return Promise.resolve(result.answer());
    });
    return result;
  }

  it('reads the whole account at most once in ten minutes', async () => {
    vi.useFakeTimers();
    const { dropbox, reads } = provider();
    const first = Date.now();
    expect(await dropbox.space()).toEqual({ state: 'observed', used: 300, allocated: 1000, time: first });
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(await dropbox.space()).toMatchObject({ time: first });
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await dropbox.space()).toMatchObject({ time: first + 10 * 60_000 });
    expect(reads()).toBe(2);
  });

  it('reports a token without account_info.read calmly and never as a provider error', async () => {
    vi.useFakeTimers();
    const context = provider();
    context.answer = () => Response.json({ error_summary: 'missing_scope/..', error: { '.tag': 'missing_scope', required_scope: 'account_info.read' } }, { status: 401 });
    expect(await context.dropbox.space()).toEqual({ state: 'scope_missing', used: 0, allocated: 0, time: Date.now() });
    await context.dropbox.space();
    expect(context.reads()).toBe(1);
    expect(context.store.get('provider_error')).toBeNull();
    // Any other refusal is an unavailable reading, not the connection's error either.
    const other = provider();
    other.answer = () => Response.json({ error_summary: 'invalid_access_token/..' }, { status: 401 });
    expect(await other.dropbox.space()).toMatchObject({ state: 'unavailable', time: 0 });
    expect(other.store.get('provider_error')).toBeNull();
    expect(other.store.get('space')).toBeNull();
  });

  it('keeps the earlier answer when a later read fails and forgets it with the connection', async () => {
    vi.useFakeTimers();
    const context = provider();
    const first = Date.now();
    await context.dropbox.space();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    context.answer = () => new Response('synthetic-private-body', { status: 503 });
    expect(await context.dropbox.space()).toEqual({ state: 'observed', used: 300, allocated: 1000, time: first });
    context.answer = () => { throw new TypeError('synthetic network failure'); };
    expect(await context.dropbox.space()).toMatchObject({ time: first });
    expect(context.reads()).toBe(3);
    expect(context.store.get('provider_error')).toBeNull();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('null')));
    await context.dropbox.disconnect();
    expect(context.store.get('space')).toBeNull();
  });

  it('does not keep an answer for a connection that changed while it was read', async () => {
    const store = new Memory();
    store.set('connection', connection);
    let answer: ((value: Response) => void) | undefined;
    vi.stubGlobal('fetch', (url: string) => url.endsWith('/oauth2/token')
      ? Promise.resolve(Response.json({ access_token: 'synthetic-access-private', expires_in: 3600 }))
      : new Promise<Response>((resolve) => { answer = resolve; }));
    const pending = new Dropbox(store, {}).space();
    await vi.waitFor(() => { expect(answer).toBeDefined(); });
    store.set('connection', { ...connection, generation: 'synthetic-other' });
    answer?.(Response.json({ used: 1, allocation: { '.tag': 'individual', allocated: 2 } }));
    expect(await pending).toMatchObject({ state: 'observed', used: 1 });
    expect(store.get('space')).toBeNull();
  });

  it('maps team allocations and refuses malformed answers', () => {
    expect(spaceAnswer(200, { used: 5, allocation: { '.tag': 'team', used: 50, allocated: 100 } }, 1)).toEqual({ state: 'observed', used: 50, allocated: 100, time: 1 });
    for (const body of [{ used: -1, allocation: { allocated: 9 } }, { used: 1 }, { used: 1.5, allocation: { allocated: 9 } }, null, 'synthetic']) {
      expect(spaceAnswer(200, body, 1)).toBeNull();
    }
    expect(spaceAnswer(500, { used: 1, allocation: { allocated: 9 } }, 1)).toBeNull();
  });
});
