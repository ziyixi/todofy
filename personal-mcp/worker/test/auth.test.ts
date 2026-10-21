import { expect, it } from 'vitest';
import { authenticate } from '../src/auth.ts';
import type { Env } from '../src/env.ts';

const env = {
  ACCESS_ISSUER: 'https://test.cloudflareaccess.com', ACCESS_AUDIENCE: 'test-aud',
  ACCESS_OWNER: 'owner@example.org', PUBLIC_HOST: 'mcp.example.org', CALLBACK_HOSTS: '',
} as Env;

it('requires the Access assertion instead of a browser cookie', async () => {
  const reply = await authenticate(new Request('https://mcp.example.org/mcp', { headers: { cookie: 'CF_Authorization=browser-cookie' } }), env);
  expect(reply).toEqual({ ok: false, failure: 'missing_token' });
});

it('allows local tests without enabling a public bypass', async () => {
  const local = { ...env, DEV_AUTH_BYPASS: 'true' };
  expect((await authenticate(new Request('http://127.0.0.1/mcp'), local)).ok).toBe(true);
  expect((await authenticate(new Request('https://mcp.example.org/mcp'), local)).ok).toBe(false);
});

it('leaves the MCP request body readable after authentication', async () => {
  const request = new Request('http://127.0.0.1/mcp', { method: 'POST', body: '{"jsonrpc":"2.0"}' });
  await authenticate(request, { ...env, DEV_AUTH_BYPASS: 'true' });
  expect(await request.text()).toBe('{"jsonrpc":"2.0"}');
});
