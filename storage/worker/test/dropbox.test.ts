import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dropbox, endpoints } from '../src/dropbox.ts';
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
    expect(authorize.searchParams.get('scope')).toBe('files.metadata.read files.content.read files.content.write');
    const requests: URLSearchParams[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      requests.push(new URLSearchParams(init.body as string));
      return Promise.resolve(Response.json({ access_token: 'synthetic-access-private', refresh_token: 'synthetic-refresh-private', expires_in: 3600 }));
    }));
    const search = new URLSearchParams({ state: authorize.searchParams.get('state') ?? '', code: 'synthetic-code' });
    await provider.callback(search);
    expect(store.connection()?.refreshToken).toBe('synthetic-refresh-private');
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

  it('writes a repeated reason at most once a minute and a new reason at once', async () => {
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
    await vi.advanceTimersByTimeAsync(59_000);
    await refused('UNAVAILABLE');
    expect(recorded()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await refused('UNAVAILABLE');
    expect(recorded()).toHaveLength(2);
    answer = () => new Response(null, { status: 400 });
    await refused('BAD_REQUEST');
    expect(recorded()).toHaveLength(3);
    expect(store.get('provider_error')).toEqual({ reason: 'BAD_REQUEST', time: Date.now() });
    answer = () => new Response('null');
    await provider.disconnect();
    answer = () => new Response(null, { status: 400 });
    store.set('connection', connection);
    await refused('BAD_REQUEST');
    expect(store.get('provider_error')).toMatchObject({ reason: 'BAD_REQUEST' });
  });
});
