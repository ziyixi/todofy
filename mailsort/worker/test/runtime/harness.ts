/**
 * workerd harness (../../../docs/design.md §11): bundles src/index.ts with esbuild and runs it in Miniflare as the Worker
 * "mailsort" with a real SQLite MailsortState, next to
 *   - "probe": calls MailsortState.step(now), setClock(now), alarmAt() and sqlForTests() over the object binding, and the
 *     named entrypoint Ops of "mailsort" over a service binding (ops-v1, as the dashboard does);
 *   - the outbound service: every request the Worker makes goes to FakeUpstream (../fakes/upstream.ts), the fake Gmail,
 *     Google token endpoint and Workers AI, in this Node process; nothing leaves it.
 * DEV_MANUAL_ALARMS=true: no alarm is ever armed and the tests drive the passes with explicit clocks; the owner is
 * signed in over loopback http by the dev bypass. All data is synthetic.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHttpClient, type HttpCall, type HttpClient } from '@ziyixi/proto/http-client';
import type { ShapeOf } from '@ziyixi/proto/http-transcoder';
import { MailsortUiService } from '@ziyixi/proto/mailsort/ui/v1/mailsort_ui_service_pb';
import { FakeUpstream } from '../fakes/upstream.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const ORIGIN = 'http://127.0.0.1';
export const OBJECT_WORKER = 'mailsort-object';
export const PUBLIC_HOST = 'sort.example.com';
/** 2026-10-01T00:00:00Z: the tests' first clock. */
export const T0 = Date.parse('2026-10-01T00:00:00Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const REFRESH_TOKEN = 'synthetic-refresh-token';
export const SCOPE_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
export const SCOPE_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  PUBLIC_HOST,
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'b'.repeat(64),
  BUILD_SHA: 'test',
  MODE: 'live',
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: '',
  CSRF_SIGNING_KEY: 'cd'.repeat(32),
  DEV_AUTH_BYPASS: 'true',
  DEV_MANUAL_ALARMS: 'true',
  // Any loopback origin: the outbound service answers every request, whatever its address.
  DEV_FAKE_UPSTREAM: 'http://127.0.0.1:9',
  GMAIL_CLIENT_ID: 'synthetic-client.apps.example.com',
  GMAIL_CLIENT_SECRET: 'synthetic-secret',
  GMAIL_REFRESH_TOKEN: REFRESH_TOKEN,
};

export const TEST_PAGE = '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="app"></div></body></html>';

let bundle: Promise<string> | null = null;
export function workerBundle(): Promise<string> {
  bundle ??= build({
    entryPoints: [join(ROOT, 'src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2024',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'import'],
    external: ['cloudflare:workers'],
    write: false,
    logLevel: 'silent',
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw new Error('esbuild produced no output');
    return output.text;
  });
  return bundle;
}

export interface HarnessOptions {
  readonly bindings?: Record<string, string | undefined>;
  /** Extra outbound routes by URL (the Access certs endpoint), before the fakes. */
  readonly routes?: Map<string, () => Response>;
  readonly inspectorPort?: number;
  /** Runs MailsortState in a Worker of its own, as Cloudflare runs a Durable Object apart from its caller. */
  readonly splitObject?: boolean;
}

export type StepResult = { next: number; mode?: string; synced?: number; decided?: number; applied?: number; deferred?: number; code: string };

export interface Harness {
  readonly mf: Miniflare;
  readonly up: FakeUpstream;
  readonly logs: string[];
  opsStatus(): Promise<Record<string, unknown>>;
  opsSetGuard(input: unknown): Promise<unknown>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  readonly api: HttpClient<ShapeOf<typeof MailsortUiService>>;
  mutate(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Response>;
  clock(now: number): Promise<void>;
  step(now: number): Promise<StepResult>;
  sql<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): Promise<T[]>;
  rows(): Promise<{ read: number; written: number }>;
  dispose(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = await mkdtemp(join(tmpdir(), 'mailsort-runtime-'));
  const script = await workerBundle();
  const up = new FakeUpstream();
  up.gmail.grants.set(REFRESH_TOKEN, SCOPE_MODIFY);
  up.gmail.clock = () => T0;
  const logs: string[] = [];
  const outbound = async (request: Request) => options.routes?.get(request.url)?.() ?? up.handle(request);
  const bindings = Object.fromEntries(Object.entries({ ...SYNTHETIC_BINDINGS, ...options.bindings }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const mailsort = (name: string, split: boolean) => ({
    name,
    modules: true,
    script,
    compatibilityDate: '2026-09-08',
    durableObjects: { MAILSORT: { className: 'MailsortState', useSQLite: true, ...(split ? { scriptName: OBJECT_WORKER } : {}) } },
    serviceBindings: { ASSETS: () => new Response(TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
    bindings,
    outboundService: outbound,
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      handleStructuredLogs: ({ level, message }) => {
        logs.push(message);
        if (level === 'warn' || level === 'error') process.stderr.write(`${message}\n`);
      },
      host: '127.0.0.1',
      port: 0,
      resourcePersistencePath: temp,
      ...(options.inspectorPort === undefined ? {} : { inspectorPort: options.inspectorPort }),
      workers: [
        mailsort('mailsort', options.splitObject === true),
        ...(options.splitObject === true ? [{ ...mailsort(OBJECT_WORKER, false) }] : []),
        {
          name: 'probe',
          modules: true,
          compatibilityDate: '2026-09-08',
          durableObjects: { MAILSORT: { className: 'MailsortState', scriptName: options.splitObject === true ? OBJECT_WORKER : 'mailsort', useSQLite: true } },
          // The dashboard's view: the named entrypoint Ops of "mailsort" (ops-v1), as dashboard/wrangler.toml binds it.
          serviceBindings: { OPS: { name: 'mailsort', entrypoint: 'Ops' } },
          script: `export default { async fetch(request, env) {
            const { op, args } = await request.json()
            const stub = env.MAILSORT.get(env.MAILSORT.idFromName('mailsort-v1'))
            try {
              if (op === 'step') return Response.json({ ok: await stub.step(args[0]) })
              if (op === 'clock') return Response.json({ ok: await stub.setClock(args[0]) ?? null })
              if (op === 'sql') return Response.json({ ok: await stub.sqlForTests(...args) })
              if (op === 'meter') return Response.json({ ok: await stub.takeRowMeter() })
              if (op === 'ops_status') return Response.json({ ok: await env.OPS.status() })
              if (op === 'ops_direct') return Response.json({ ok: await stub.opsStatus() })
              if (op === 'ops_guard') return Response.json({ ok: await env.OPS.setGuard(args[0]) })
              return Response.json({ error: 'unknown op' })
            } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'not_an_error' }) }
          } }`,
        },
      ],
    }),
  );
  await mf.ready;
  const probe = async (op: string, args: unknown[]): Promise<unknown> => {
    const worker = await mf.getWorker('probe');
    const response = await worker.fetch('http://probe/', { method: 'POST', body: JSON.stringify({ op, args }) });
    const result = (await response.json()) as { ok?: unknown; error?: string };
    if (result.error !== undefined) throw new Error(`${op}: ${result.error}`);
    return result.ok;
  };
  const fetchSort = (path: string, init?: RequestInit) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init } as never) as unknown as Promise<Response>;
  let csrf: { token: string; cookie: string } | undefined;
  const csrfToken = async () => {
    if (csrf === undefined) {
      const response = await fetchSort('/api/csrf');
      const { token } = (await response.json()) as { token: string };
      csrf = { token, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
    }
    return csrf;
  };
  const send = async (call: HttpCall) => {
    const headers: Record<string, string> = {};
    if (call.httpMethod !== 'GET') {
      const { token, cookie } = await csrfToken();
      Object.assign(headers, { origin: ORIGIN, 'x-csrf-token': token, cookie });
    }
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    return fetchSort(call.url, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) });
  };
  const harness: Harness = {
    mf,
    up,
    logs,
    fetch: fetchSort,
    opsStatus: async () => (await probe('ops_status', [])) as Record<string, unknown>,
    opsSetGuard: (input) => probe('ops_guard', [input]),
    api: createHttpClient(MailsortUiService, send),
    async mutate(method, path, body) {
      const { token, cookie } = await csrfToken();
      const headers: Record<string, string> = { origin: ORIGIN, 'x-csrf-token': token, cookie };
      if (body !== undefined) headers['content-type'] = 'application/json';
      return fetchSort(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    async clock(now) {
      up.gmail.clock = () => now;
      await probe('clock', [now]);
    },
    async step(now) {
      up.gmail.clock = () => now;
      return (await probe('step', [now])) as StepResult;
    },
    async sql<T>(query: string, ...params: (string | number | null)[]) {
      return (await probe('sql', [query, ...params])) as T[];
    },
    async rows() {
      return (await probe('meter', [])) as { read: number; written: number };
    },
    async dispose() {
      await mf.dispose();
      await rm(temp, { recursive: true, force: true });
    },
  };
  await harness.clock(T0);
  return harness;
}

/** A fresh AIP-155 request ID. */
export function op(): string {
  return crypto.randomUUID();
}

/** The ErrorInfo reason of a thrown RpcStatusError. */
export function reasonOf(error: unknown): string | undefined {
  return (error as { status?: { reason?: string } }).status?.reason;
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}
