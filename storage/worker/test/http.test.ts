import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/http.ts';
import type { Env } from '../src/env.ts';

function environment() {
  const get = vi.fn();
  const env: Env = {
    PUBLIC_HOST: 'storage.example.test', ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com', ACCESS_AUDIENCE: 'a'.repeat(64), ACCESS_OWNER: 'owner@example.test',
    STORAGE: { idFromName: vi.fn(), get } as unknown as Env['STORAGE'],
  };
  return { env, get };
}

describe('owner gates', () => {
  it('rejects missing owner authentication before observing body or calling the object', async () => {
    const { env, get } = environment();
    const request = new Request('https://storage.example.test/api/v1/clients', { method: 'POST' });
    Object.defineProperty(request, 'body', { get() { throw new Error('body was observed before authorization'); } });
    const response = await handleRequest(request, env);
    expect(response.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it('checks Origin and JSON CSRF before reading an owner mutation body', async () => {
    const fixture = environment();
    const env = { ...fixture.env, DEV_AUTH_BYPASS: 'true' };
    const request = new Request('http://127.0.0.1/api/v1/clients', { method: 'POST' });
    Object.defineProperty(request, 'body', { get() { throw new Error('body was observed before CSRF'); } });
    const response = await handleRequest(request, env);
    expect(response.status).toBe(403);
    expect(fixture.get).not.toHaveBeenCalled();
  });
});
