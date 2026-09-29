import { expect, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';

export const OWNER_HOST = 'todofy.localhost';
export const HOOKS_HOST = 'todofy-hooks.localhost';
export const OWNER = 'owner@example.com';
export const CSRF_KEY = 'ab'.repeat(32);

/** One request the gateway sent to the TodofyCore stub. */
export interface CoreCall {
  readonly name: string;
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: ReadableStream | null;
}

export type CoreReply = (call: CoreCall) => Response | Promise<Response>;

export interface Fakes {
  readonly env: Env;
  readonly core: CoreCall[];
  readonly assets: Request[];
}

function coreStub(calls: CoreCall[], reply: CoreReply): DurableObjectNamespace {
  return {
    getByName: (name: string) => ({
      fetch: async (url: string, init: RequestInit) => {
        const call: CoreCall = {
          name,
          url: new URL(url),
          method: init.method ?? 'GET',
          headers: new Headers(init.headers),
          body: (init.body ?? null) as ReadableStream | null,
        };
        calls.push(call);
        return reply(call);
      },
    }),
  } as unknown as DurableObjectNamespace;
}

/** An asset server with the SPA fallback: unknown paths answer index.html. */
export function spaAssets(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  if (path === '/assets/app-1a2b3c.js') {
    return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } });
  }
  return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
}

export type Vars = { [Name in Exclude<keyof Env, 'ASSETS' | 'COORDINATOR'>]?: string | undefined };

/** A gateway env with fake bindings; the core answers 204 unless `reply` says otherwise. */
export function fakes(
  vars: Vars = {},
  reply: CoreReply = () => new Response(null, { status: 204 }),
): Fakes {
  const core: CoreCall[] = [];
  const assets: Request[] = [];
  const env = {
    TODOFY_PUBLIC_HOST: OWNER_HOST,
    TODOFY_HOOKS_HOSTS: `${HOOKS_HOST},daily.localhost`,
    BUILD_SHA: 'test',
    ACCESS_OWNER: OWNER,
    DEV_AUTH_BYPASS: 'true',
    CSRF_SIGNING_KEY: CSRF_KEY,
    ...vars,
    COORDINATOR: coreStub(core, reply),
    ASSETS: {
      fetch: (input: Request) => {
        assets.push(input);
        return Promise.resolve(spaAssets(input));
      },
    } as unknown as Fetcher,
  } as Env;
  return { env, core, assets };
}

type Init = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

export function send(env: Env, url: string, init: Init = {}): Promise<Response> {
  const request = new Request(url, init);
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], env);
}

export function hooks(env: Env, path: string, init: Init = {}): Promise<Response> {
  return send(env, `http://${HOOKS_HOST}${path}`, init);
}

export function owner(env: Env, path: string, init: Init = {}): Promise<Response> {
  return send(env, `http://${OWNER_HOST}:8787${path}`, init);
}

export interface Envelope {
  readonly error: { readonly code: string; readonly message: string; readonly request_id: string };
}

/** Assert the standard error envelope and its JSON headers; returns the code. */
export async function errorCode(response: Response): Promise<string> {
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const body = await response.json<Envelope>();
  expect(body.error.request_id).toMatch(/^[0-9a-f]{16}$/);
  expect(body.error.message).not.toBe('');
  return body.error.code;
}

/** The JSON lines the gateway logged. */
export function logged(): unknown[] {
  return vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
}
