/**
 * workerd harness (../../../docs/design.md §10): bundles src/index.ts with esbuild and runs it in Miniflare as the Worker
 * "recall" with a real SQLite RecallState and a real (local) R2 bucket, next to "probe", which calls RecallState's test
 * hooks over the object binding and the named entrypoint Ops of "recall" over a service binding (ops-v1, as the
 * dashboard does). DEV_MANUAL_ALARMS=true: no alarm is ever armed, the object reads the clock the tests set, and the
 * tests drive the alarm passes. The owner is signed in over loopback http by the dev bypass; the machine routes use
 * synthetic tokens whose digests the harness configures. All data is synthetic.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHttpClient, type HttpCall, type HttpClient } from '@ziyixi/proto/http-client';
import type { ShapeOf } from '@ziyixi/proto/http-transcoder';
import { RecallUiService } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const ORIGIN = 'http://127.0.0.1';
export const OBJECT_WORKER = 'recall-object';
export const PUBLIC_HOST = 'recall.example.com';
/** 2026-10-10T02:10:00Z: the tests' first clock. */
export const T0 = Date.parse('2026-10-10T02:10:00Z');
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Synthetic machine tokens (the shape mint-tokens.mjs makes), and their digests as the Worker holds them. */
export const INGEST_TOKEN = `recall_ingest_${'S'.repeat(20)}ynthetic${'I'.repeat(15)}`;
export const EXPORT_TOKEN = `recall_export_${'S'.repeat(20)}ynthetic${'E'.repeat(15)}`;
export const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  PUBLIC_HOST,
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'b'.repeat(64),
  BUILD_SHA: 'test',
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: '',
  CSRF_SIGNING_KEY: 'cd'.repeat(32),
  INGEST_TOKEN_SHA256: sha256(INGEST_TOKEN),
  EXPORT_TOKEN_SHA256: sha256(EXPORT_TOKEN),
  DEV_AUTH_BYPASS: 'true',
  DEV_MANUAL_ALARMS: 'true',
};

export const TEST_PAGE = '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="app"></div></body></html>';
export const COMPATIBILITY_DATE = '2026-09-08';

const bundles = new Map<string, Promise<string>>();
export function workerBundle(entry = 'src/index.ts'): Promise<string> {
  const cached = bundles.get(entry);
  if (cached !== undefined) return cached;
  const bundle = build({
    entryPoints: [join(ROOT, entry)],
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
  bundles.set(entry, bundle);
  return bundle;
}

export interface HarnessOptions {
  readonly bindings?: Record<string, string | undefined>;
  /** Extra outbound routes by URL (the Access certs endpoint). */
  readonly routes?: Map<string, () => Response>;
  readonly inspectorPort?: number;
  /** Runs RecallState in a Worker of its own, as Cloudflare runs a Durable Object apart from its caller. */
  readonly splitObject?: boolean;
}

export interface StepResult {
  readonly next: number;
  readonly purging: boolean;
  readonly demoting: boolean;
  readonly deferred: boolean;
  readonly code: string;
}

export interface Harness {
  readonly mf: Miniflare;
  readonly logs: string[];
  fetch(path: string, init?: RequestInit): Promise<Response>;
  readonly api: HttpClient<ShapeOf<typeof RecallUiService>>;
  /** POST /api/machine/v1/batches with the ingest token: `body` is gzipped JSON unless it is bytes already. */
  upload(body: unknown, init?: { token?: string | null; contentType?: string }): Promise<Response>;
  /** GET /api/machine/v1/changes with the export token. */
  changes(query?: string, token?: string | null): Promise<Response>;
  /** GET /api/machine/v1/blobs/<path> with the export token. */
  blob(path: string, token?: string | null): Promise<Response>;
  clock(now: number): Promise<void>;
  step(now: number): Promise<StepResult>;
  failNextCommit(): Promise<void>;
  sql<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): Promise<T[]>;
  rows(): Promise<{ read: number; written: number }>;
  opsStatus(): Promise<Record<string, unknown>>;
  opsSetGuard(input: unknown): Promise<unknown>;
  r2(): Promise<R2Bucket>;
  dispose(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = await mkdtemp(join(tmpdir(), 'recall-runtime-'));
  const script = await workerBundle();
  const logs: string[] = [];
  const outbound = (request: Request) => options.routes?.get(request.url)?.() ?? new Response('no network in tests', { status: 599 });
  const bindings = Object.fromEntries(Object.entries({ ...SYNTHETIC_BINDINGS, ...options.bindings }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const recall = (name: string, split: boolean) => ({
    name,
    modules: true,
    script,
    compatibilityDate: COMPATIBILITY_DATE,
    durableObjects: { RECALL: { className: 'RecallState', useSQLite: true, ...(split ? { scriptName: OBJECT_WORKER } : {}) } },
    r2Buckets: { STORE: 'recall-store' },
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
        recall('recall', options.splitObject === true),
        ...(options.splitObject === true ? [recall(OBJECT_WORKER, false)] : []),
        {
          name: 'probe',
          modules: true,
          compatibilityDate: COMPATIBILITY_DATE,
          durableObjects: { RECALL: { className: 'RecallState', scriptName: options.splitObject === true ? OBJECT_WORKER : 'recall', useSQLite: true } },
          // The dashboard's view: the named entrypoint Ops of "recall" (ops-v1).
          serviceBindings: { OPS: { name: 'recall', entrypoint: 'Ops' } },
          script: `export default { async fetch(request, env) {
            const { op, args } = await request.json()
            const stub = env.RECALL.get(env.RECALL.idFromName('recall-v1'))
            try {
              if (op === 'step') return Response.json({ ok: await stub.step(args[0]) })
              if (op === 'clock') return Response.json({ ok: await stub.setClock(args[0]) ?? null })
              if (op === 'crash') return Response.json({ ok: await stub.failNextCommit() ?? null })
              if (op === 'sql') return Response.json({ ok: await stub.sqlForTests(...args) })
              if (op === 'meter') return Response.json({ ok: await stub.takeRowMeter() })
              if (op === 'ops_status') return Response.json({ ok: await env.OPS.status() })
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
  const fetchRecall = (path: string, init?: RequestInit) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init } as never) as unknown as Promise<Response>;
  let csrf: { token: string; cookie: string } | undefined;
  const csrfToken = async () => {
    if (csrf === undefined) {
      const response = await fetchRecall('/api/csrf');
      const { token } = await response.json<{ token: string }>();
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
    return fetchRecall(call.url, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) });
  };
  const bearer = (token: string | null | undefined, fallback: string): Record<string, string> => {
    const value = token === undefined ? fallback : token;
    return value === null ? {} : { authorization: `Bearer ${value}` };
  };
  const harness: Harness = {
    mf,
    logs,
    fetch: fetchRecall,
    api: createHttpClient(RecallUiService, send),
    upload(body, init = {}) {
      const bytes = body instanceof Uint8Array ? body : gzipSync(JSON.stringify(body));
      return fetchRecall('/api/machine/v1/batches', {
        method: 'POST',
        headers: { 'content-type': init.contentType ?? 'application/gzip', ...bearer(init.token, INGEST_TOKEN) },
        body: bytes,
      });
    },
    changes(query = '', token) {
      return fetchRecall(`/api/machine/v1/changes${query}`, { headers: bearer(token, EXPORT_TOKEN) });
    },
    blob(path, token) {
      return fetchRecall(`/api/machine/v1/blobs/${path}`, { headers: bearer(token, EXPORT_TOKEN) });
    },
    async clock(now) {
      await probe('clock', [now]);
    },
    async step(now) {
      return (await probe('step', [now])) as StepResult;
    },
    async failNextCommit() {
      await probe('crash', []);
    },
    async sql<T>(query: string, ...params: (string | number | null)[]) {
      return (await probe('sql', [query, ...params])) as T[];
    },
    async rows() {
      return (await probe('meter', [])) as { read: number; written: number };
    },
    opsStatus: async () => (await probe('ops_status', [])) as Record<string, unknown>,
    opsSetGuard: (input) => probe('ops_guard', [input]),
    r2: () => mf.getR2Bucket('STORE') as unknown as Promise<R2Bucket>,
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

/** The reason of a machine route's Status body. */
export async function machineReason(response: Response): Promise<string | undefined> {
  const body = await response.json<{ error?: { details?: { reason?: string }[] } }>();
  return body.error?.details?.[0]?.reason;
}
