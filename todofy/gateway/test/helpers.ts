import { expect, vi } from 'vitest';
import type { CoreResult, UiOk, UiRefusal } from '../src/coordinator.ts';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';

export const OWNER_HOST = 'todofy.localhost';
export const HOOKS_HOST = 'todofy-hooks.localhost';
export const OWNER = 'owner@example.com';
export const CSRF_KEY = 'ab'.repeat(32);

const CORE_METHODS = [
  'ingest',
  'wake',
  'newsletter',
  'newsletter_auth_failure',
  'owner_ui',
  'setup',
  'ops_status',
  'ops_set_guard',
  'ops_canary_result',
  'ops_report',
  'task_intent_propose',
  'task_intent_status',
] as const;

/** One RPC call the gateway made on the TodofyCore stub. */
export interface CoreCall {
  readonly instance: string;
  readonly method: (typeof CORE_METHODS)[number];
  readonly args: readonly unknown[];
}

/** The fake core's answer: a CoreResult, the setup facts, or nothing for wake. */
export type CoreReply = (call: CoreCall) => unknown;

export const NO_CONTENT: CoreResult = { status: 204, body: null, error: null, retry_after: null };

/** A 200 whose JSON text is `text` (the core serialises with Python's separators). */
export function ok(data: unknown, text = JSON.stringify(data)): CoreResult {
  return { status: 200, body: text, error: null, retry_after: null };
}

/** TodofyCore's owner_ui answer of a message (its wire JSON) and the next page's cursor. */
export function uiOk(message: unknown, nextCursor: unknown = null): UiOk {
  return { ok: JSON.stringify(message), next_cursor: nextCursor === null ? null : JSON.stringify(nextCursor) };
}

/** TodofyCore's owner_ui refusal: a reason, an optional MailEvent detail (wire JSON) and Retry-After seconds. */
export function uiRefusal(reason: string, detail: unknown = null, retryAfter: number | null = null): UiRefusal {
  return { error: reason, detail: detail === null ? null : JSON.stringify(detail), retry_after: retryAfter };
}

export function failure(status: number, code: string, retryAfter: number | null = null): CoreResult {
  return { status, body: null, error: { code, message: `core: ${code}` }, retry_after: retryAfter };
}

/** The ReadableStream argument of an ingest or owner_api call, as text. */
export function bodyText(call: CoreCall | undefined): Promise<string> {
  return new Response(call?.args.at(-1) as ReadableStream | null).text();
}

export interface Fakes {
  readonly env: Env;
  readonly core: CoreCall[];
  readonly assets: Request[];
}

function coreStub(calls: CoreCall[], reply: CoreReply): Env['COORDINATOR'] {
  return {
    getByName: (instance: string) =>
      Object.fromEntries(
        CORE_METHODS.map((method) => [
          method,
          (...args: unknown[]) => {
            const call: CoreCall = { instance, method, args };
            calls.push(call);
            return Promise.resolve(reply(call));
          },
        ]),
      ),
  } as unknown as Env['COORDINATOR'];
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

export type Vars = { [Name in Exclude<keyof Env, 'ASSETS' | 'COORDINATOR' | 'METRICS'>]?: string | undefined };

/** A gateway env with fake bindings; the core answers 204 unless `reply` says otherwise. */
export function fakes(vars: Vars = {}, reply: CoreReply = () => NO_CONTENT): Fakes {
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

/** A google.rpc.Status body (the owner API's errors). */
export interface StatusBody {
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly status: string;
    readonly details: readonly ({ readonly '@type': string } & Record<string, unknown>)[];
  };
}

/** Assert a google.rpc.Status body with the JSON headers and the request ID; returns its ErrorInfo reason. */
export async function statusReason(response: Response): Promise<string> {
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const body = await response.json<StatusBody>();
  expect(body.error.code).toBe(response.status);
  const info = body.error.details.find((detail) => detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
  const request = body.error.details.find((detail) => detail['@type'] === 'type.googleapis.com/google.rpc.RequestInfo');
  expect(info?.['domain']).toBe('todofy.ziyixi.science');
  expect(request?.['request_id']).toMatch(/^[0-9a-f]{16}$/);
  return String(info?.['reason']);
}

/** The JSON lines the gateway logged. */
export function logged(): unknown[] {
  return vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
}
