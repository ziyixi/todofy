import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/http.ts';
import type { Env } from '../src/env.ts';
import { PAGE, SCRIPT } from '../src/ui.ts';

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

describe('machine gate', () => {
  it('answers malformed application keys at the edge without waking the Durable Object', async () => {
    const { env, get } = environment();
    for (const authorization of [null, '', 'Bearer', 'Basic ' + 'a'.repeat(47), 'Bearer sto_' + 'a'.repeat(42), 'Bearer sto_' + 'a'.repeat(44), 'bearer sto_' + 'a'.repeat(43)]) {
      const request = new Request('https://storage.example.test/api/storage/v1/stat', {
        method: 'POST', headers: authorization === null ? {} : { authorization },
      });
      Object.defineProperty(request, 'body', { get() { throw new Error('body was observed before the key format check'); } });
      const response = await handleRequest(request, env);
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await response.text()).toContain('UNAUTHORIZED');
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('forwards a well-formed key for the object to authenticate', async () => {
    const { env, get } = environment();
    const forwarded = vi.fn(() => Promise.resolve(Response.json({}, { status: 401 })));
    get.mockReturnValue({ fetch: forwarded });
    const response = await handleRequest(new Request('https://storage.example.test/api/storage/v1/stat', {
      method: 'POST', headers: { authorization: 'Bearer sto_' + 'a'.repeat(43) },
    }), env);
    expect(response.status).toBe(401);
    expect(forwarded).toHaveBeenCalledOnce();
  });
});

describe('owner console', () => {
  it('ships a script that parses, reads only the overview and never polls', () => {
    expect(() => new Script(SCRIPT)).not.toThrow();
    for (const tab of ['#overview', '#keys', '#activity']) expect(PAGE).toContain('href="' + tab + '"');
    expect(SCRIPT.match(/api\('[a-z]+'\)/g)).toEqual(["api('overview')"]);
    expect(SCRIPT).not.toMatch(/setInterval|setTimeout/);
    // Revoking and disconnecting each need a second, explicit confirmation.
    expect(SCRIPT).toContain('确认撤销');
    expect(SCRIPT).toContain('立即收到 401');
    expect(SCRIPT).toContain('确认断开');
    // A full Dropbox is judged against the last successful write; counts say they are by UTC day.
    expect(SCRIPT).toContain('last_write_success_time');
    expect(SCRIPT).not.toContain('今日');
  });
});
