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
