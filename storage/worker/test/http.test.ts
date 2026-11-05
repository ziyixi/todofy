import { Script } from 'node:vm';
import { encodePageToken } from '@ziyixi/proto/page-token';
import { Code } from '@ziyixi/proto/rpc-status';
import { Client_Access } from '@ziyixi/proto/storage/ui/v1/client_pb';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { errorResponse, failure, readJson } from '../src/errors.ts';
import { handleRequest } from '../src/http.ts';
import { handlers, type OwnerContext } from '../src/owner.ts';
import type { Store } from '../src/store.ts';
import { PAGE, SCRIPT } from '../src/ui.ts';
import { seedNamespaceAndKey, setupConnected, sqliteStore, TEST_ENV } from './sqlite.ts';

function environment() {
  const get = vi.fn();
  const env: Env = {
    ...TEST_ENV,
    STORAGE: { idFromName: vi.fn(), get } as unknown as Env['STORAGE'],
  };
  return { env, get };
}

function ownerContext(store: Store): OwnerContext {
  return {
    store,
    dropbox: setupConnected(store).provider,
    redirectUri: 'https://storage.example.test/api/dropbox/callback',
    flushUsage: vi.fn(),
    buildSha: 'synthetic',
    stateSizeBytes: () => 0,
    scheduleScan: () => Promise.resolve(),
  };
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

  it('serves health, console HTML and script on GET/HEAD, blocks cf-ray local bypass, and answers 503 when unconfigured', async () => {
    const fixture = environment();
    const health = await handleRequest(new Request('https://storage.example.test/health'), { ...fixture.env, BUILD_SHA: 'synthetic-sha' });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, build_sha: 'synthetic-sha' });

    const devEnv: Env = { ...fixture.env, DEV_AUTH_BYPASS: 'true' };
    const spoofed = await handleRequest(new Request('http://127.0.0.1/', { headers: { 'cf-ray': 'synthetic-ray' } }), devEnv);
    expect(spoofed.status).toBe(404);

    const getPage = await handleRequest(new Request('http://127.0.0.1/'), devEnv);
    expect(getPage.status).toBe(200);
    expect(getPage.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await getPage.text()).toBe(PAGE);

    const headPage = await handleRequest(new Request('http://127.0.0.1/', { method: 'HEAD' }), devEnv);
    expect(headPage.status).toBe(200);
    expect(await headPage.text()).toBe('');

    const getScript = await handleRequest(new Request('http://127.0.0.1/assets/storage.js'), devEnv);
    expect(getScript.status).toBe(200);
    expect(getScript.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await getScript.text()).toBe(SCRIPT);

    const headScript = await handleRequest(new Request('http://127.0.0.1/assets/storage.js', { method: 'HEAD' }), devEnv);
    expect(headScript.status).toBe(200);
    expect(await headScript.text()).toBe('');

    const unconfigured = await handleRequest(new Request('https://storage.example.test/api/v1/settings'), { ...fixture.env, ACCESS_ISSUER: '' });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.text()).toContain('UNAVAILABLE');
  });
});

describe('error responses and bounded JSON reads', () => {
  it('omits the error body on HEAD and maps unexpected errors to 500 INTERNAL', async () => {
    const headResponse = errorResponse(failure(Code.NOT_FOUND, 'NOT_FOUND'), 'synthetic-req', true);
    expect(headResponse.status).toBe(404);
    expect(await headResponse.text()).toBe('');

    const internalResponse = errorResponse(new Error('synthetic crash'), 'synthetic-req', false);
    expect(internalResponse.status).toBe(500);
    expect(await internalResponse.text()).toContain('INTERNAL');
  });

  it('rejects null, oversized, or malformed JSON bodies', async () => {
    await expect(readJson(new Response(null))).rejects.toMatchObject({ reason: 'BAD_REQUEST' });
    await expect(readJson(new Response(JSON.stringify({ key: 'a'.repeat(64) })), 16)).rejects.toMatchObject({ reason: 'BAD_REQUEST' });
    await expect(readJson(new Response('{invalid-json'))).rejects.toMatchObject({ reason: 'BAD_REQUEST' });
    await expect(readJson(new Response('{"ok":true}'), 32)).resolves.toEqual({ ok: true });
  });
});

describe('owner client handlers', () => {
  it('validates pagination cursors and clamps listClients page sizes to 64', async () => {
    const { store } = sqliteStore();
    const context = ownerContext(store);
    expect(() => handlers.listClients({ pageSize: -1, pageToken: '' } as never, context)).toThrow(
      expect.objectContaining({ reason: 'BAD_REQUEST' }),
    );
    for (const pageToken of ['malformed-token', encodePageToken(123, {}), encodePageToken('not-a-uuid', {})]) {
      expect(() => handlers.listClients({ pageSize: 10, pageToken } as never, context)).toThrow(
        expect.objectContaining({ reason: 'BAD_REQUEST' }),
      );
    }

    const firstId = '00000000-0000-4000-8000-000000000001';
    const secondId = '00000000-0000-4000-8000-000000000002';
    seedNamespaceAndKey({ id: firstId, token_sha256: '1'.repeat(64) }, store);
    seedNamespaceAndKey({ id: secondId, token_sha256: '2'.repeat(64) }, store);

    const spy = vi.spyOn(store, 'clients');
    const firstPage = (await handlers.listClients({ pageSize: 1, pageToken: '' } as never, context)) as {
      clients: { name: string }[];
      nextPageToken: string;
    };
    expect(firstPage.clients).toHaveLength(1);
    expect(firstPage.nextPageToken).not.toBe('');
    const secondPage = (await handlers.listClients({ pageSize: 100, pageToken: firstPage.nextPageToken } as never, context)) as {
      clients: { name: string }[];
      nextPageToken: string;
    };
    expect(secondPage.clients.map((client) => client.name)).toEqual(['clients/' + secondId]);
    expect(secondPage.nextPageToken).toBe('');
    expect(spy).toHaveBeenLastCalledWith(firstId, 65);
  });

  it('rejects control characters, replays of revoked requestIds, and creations past the 64-client limit', async () => {
    const { store } = sqliteStore();
    const context = ownerContext(store);
    const requestId = '00000000-0000-4000-8000-000000000001';

    await expect(handlers.createClient({ requestId } as never, context)).rejects.toMatchObject({ reason: 'BAD_REQUEST' });
    for (const label of ['bad\u0007label', 'bad\u007flabel']) {
      await expect(handlers.createClient({
        requestId, client: { label, namespace: 'synthetic', access: Client_Access.READ_WRITE },
      } as never, context)).rejects.toMatchObject({ reason: 'BAD_REQUEST' });
    }
    await expect(handlers.createClient({
      requestId, client: { label: 'Synthetic', namespace: 'synthetic', access: Client_Access.UNSPECIFIED },
    } as never, context)).rejects.toMatchObject({ reason: 'BAD_REQUEST' });

    const created = (await handlers.createClient({
      requestId, client: { label: 'Synthetic', namespace: 'synthetic', access: Client_Access.READ_WRITE },
    } as never, context)) as { apiKey: string };
    expect(created.apiKey).toMatch(/^sto_/);

    const replayed = (await handlers.createClient({
      requestId, client: { label: 'Synthetic', namespace: 'synthetic', access: Client_Access.READ_WRITE },
    } as never, context)) as { apiKey: string };
    expect(replayed.apiKey).toBe('');

    await expect(handlers.createClient({
      requestId, client: { label: 'Different', namespace: 'synthetic', access: Client_Access.READ_WRITE },
    } as never, context)).rejects.toMatchObject({ reason: 'BAD_REQUEST' });

    await handlers.deleteClient({ name: 'clients/' + requestId } as never, context);
    await expect(handlers.createClient({
      requestId, client: { label: 'Synthetic', namespace: 'synthetic', access: Client_Access.READ_WRITE },
    } as never, context)).rejects.toMatchObject({ code: Code.NOT_FOUND, reason: 'NOT_FOUND' });

    for (let index = 0; index < 64; index++) {
      seedNamespaceAndKey({
        id: '00000000-0000-4000-8000-' + String(index + 10).padStart(12, '0'),
        token_sha256: String(index + 10).padStart(64, '0'),
      }, store);
    }
    await expect(handlers.createClient({
      requestId: '00000000-0000-4000-8000-000000000099',
      client: { label: 'Overflow', namespace: 'synthetic', access: Client_Access.READ_ONLY },
    } as never, context)).rejects.toMatchObject({ code: Code.RESOURCE_EXHAUSTED, reason: 'CLIENT_LIMIT' });
  });

  it('returns 400 for malformed client resource names and 404 for absent or already revoked clients', async () => {
    const { store } = sqliteStore();
    const context = ownerContext(store);
    const id = '00000000-0000-4000-8000-000000000001';
    seedNamespaceAndKey({ id }, store);

    for (const name of ['clients/not-a-uuid', 'other/' + id]) {
      expect(() => handlers.deleteClient({ name } as never, context)).toThrow(
        expect.objectContaining({ httpStatus: 400, reason: 'BAD_REQUEST' }),
      );
    }
    expect(() => handlers.deleteClient({ name: 'clients/00000000-0000-4000-8000-000000000099' } as never, context)).toThrow(
      expect.objectContaining({ httpStatus: 404, reason: 'NOT_FOUND' }),
    );

    await handlers.deleteClient({ name: 'clients/' + id } as never, context);
    expect(() => handlers.deleteClient({ name: 'clients/' + id } as never, context)).toThrow(
      expect.objectContaining({ httpStatus: 404, reason: 'NOT_FOUND' }),
    );
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

