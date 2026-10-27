/**
 * workerd harness (../../../docs/design.md §17): bundles src/index.ts with esbuild (as wrangler does: the browser field
 * of the Anthropic SDK, the content-config texts as strings) and runs it in Miniflare as the Worker "brief" with a real
 * SQLite BriefState, a fake ASSETS binding, Workers AI bound to a fake entrypoint (test/fakes/ai-entrypoint.ts), and
 * every outbound request answered in this Node process: the synthetic web, the fake Claude API and the fake Resend
 * (test/fakes/upstream.ts). Nothing leaves the machine. "probe" calls BriefState's test hooks over the object binding
 * and the named entrypoint Ops of "brief" over a service binding (ops-v1, as the dashboard does).
 *
 * DEV_MANUAL_ALARMS=true: no alarm is ever armed, the object reads the clock the tests set, a host's spacing advances
 * that clock instead of sleeping, and the tests drive the alarms. The owner is signed in over loopback http by the dev
 * bypass. All data is synthetic; the Claude key is a synthetic string the fake never checks.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { BriefUiService } from '@ziyixi/proto/brief/ui/v1/brief_ui_service_pb';
import { createHttpClient, type HttpCall, type HttpClient } from '@ziyixi/proto/http-client';
import type { ShapeOf } from '@ziyixi/proto/http-transcoder';
import { FakeClaude, SyntheticWeb, SYNTHETIC_REGISTRY } from '../fakes/upstream.ts';
import { GenerateRequestSchema, EmbeddingSchema, ListModelsResponseSchema } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { create } from '@ziyixi/proto/protobuf';
import { fakeVector } from '../fakes/ai.ts';
import { estimateTokens } from '../../src/prices.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const QUOTA_RATE = 0.001075;

export const ORIGIN = 'http://127.0.0.1';
export const PUBLIC_HOST = 'brief.example.org';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const COMPATIBILITY_DATE = '2026-09-08';
export const FEEDBACK_KEY = 'ef'.repeat(32);
/** The Worker BriefState runs in when HarnessOptions.splitObject is set. */
export const OBJECT_WORKER = 'brief-object';

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  PUBLIC_HOST,
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'b'.repeat(64),
  BUILD_SHA: 'test',
  MODE: 'live',
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: '',
  CSRF_SIGNING_KEY: 'cd'.repeat(32),
  FEEDBACK_SIGNING_KEY: FEEDBACK_KEY,
  RESEND_API_KEY: 're_synthetic_test_key',
  MAIL_FROM: 'Brief <brief@example.com>',
  MAIL_TO: 'owner@example.com',
  DEV_AUTH_BYPASS: 'true',
  DEV_MANUAL_ALARMS: 'true',
};

const TEST_PAGE = '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="app"></div></body></html>';

const bundles = new Map<string, Promise<string>>();
export function workerBundle(entry = 'src/index.ts'): Promise<string> {
  const cached = bundles.get(entry);
  if (cached !== undefined) return cached;
  const bundle = build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    // As wrangler: the browser field (the SDK's Node-only modules swapped for their browser versions).
    platform: 'browser',
    target: 'es2024',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:workers'],
    loader: { '.md': 'text', '.yaml': 'text' },
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

export interface SentMail {
  readonly key: string | null;
  readonly body: { from: string; to: string[]; subject: string; html: string; text: string };
}

export interface HarnessOptions {
  readonly modelConfigured?: boolean;
  readonly bindings?: Record<string, string | undefined>;
  readonly inspectorPort?: number;
  /** Runs BriefState in a Worker of its own, as Cloudflare runs a Durable Object apart from its caller. */
  readonly splitObject?: boolean;
  /** Extra outbound routes by URL (the Access certs endpoint). */
  readonly routes?: Map<string, () => Response>;
  /** Keep the bundled registry instead of the synthetic one. */
  readonly bundledRegistry?: boolean;
  /** Another registry instead of the synthetic one (the bulk suites' 40 feeds). */
  readonly registry?: string;
  /**
   * The directory of the object's storage, kept after dispose: a second harness over it is the same BriefState after a
   * deploy (other bindings, another BUILD_SHA).
   */
  readonly persist?: string;
}

export interface AlarmResult {
  readonly job: string;
  readonly code: string;
  readonly next: number;
  readonly step?: string;
}

export interface Harness {
  readonly mf: Miniflare;
  readonly logs: string[];
  readonly web: SyntheticWeb;
  readonly claude: FakeClaude;
  readonly sent: SentMail[];
  /** Resend's next answers (status and body), first in first out; then 200 with an ID. */
  readonly resend: { status: number; body: unknown }[];
  fetch(path: string, init?: RequestInit): Promise<Response>;
  readonly api: HttpClient<ShapeOf<typeof BriefUiService>>;
  clock(now: number): Promise<void>;
  /** The object's clock as it is now (a host's spacing advances it). */
  now(): number;
  step(now: number): Promise<AlarmResult>;
  /** Runs alarms from `from`, each at its own next time, until `until` (or `max` alarms); answers them. */
  runUntil(from: number, until: number, max?: number): Promise<AlarmResult[]>;
  sql<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): Promise<T[]>;
  rows(): Promise<{ read: number; written: number }>;
  opsStatus(): Promise<Record<string, unknown>>;
  opsSetGuard(input: unknown): Promise<unknown>;
  aiQuota(on: boolean): Promise<void>;
  dispose(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = options.persist ?? (await mkdtemp(join(tmpdir(), 'brief-runtime-')));
  const script = await workerBundle();
  let quota = false;
  const logs: string[] = [];
  let clockNow = 0;
  const web = new SyntheticWeb({ now: () => clockNow });
  const claude = new FakeClaude();
  const sent: SentMail[] = [];
  const resend: { status: number; body: unknown }[] = [];
  const outbound = async (request: Request): Promise<Response> => {
    const url = request.url;
    const route = options.routes?.get(url);
    if (route !== undefined) return route();
    if (url === 'https://api.resend.com/emails') {
      sent.push({ key: request.headers.get('idempotency-key'), body: await request.json<SentMail['body']>() });
      const next = resend.shift() ?? { status: 200, body: { id: `msg-synthetic-${String(sent.length)}` } };
      return Response.json(next.body, { status: next.status });
    }
    return web.answer(url) ?? new Response('no network in tests', { status: 599 });
  };
  const bindings = Object.fromEntries(Object.entries({ ...SYNTHETIC_BINDINGS, ...options.bindings }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const objectWorker = OBJECT_WORKER;
  const brief = (name: string, split: boolean) => ({
    name,
    modules: true,
    script,
    compatibilityDate: COMPATIBILITY_DATE,
    durableObjects: { BRIEF: { className: 'BriefState', useSQLite: true, ...(split ? { scriptName: objectWorker } : {}) } },
    serviceBindings: {
      ASSETS: () => new Response(TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      MODEL_ROUTER: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === '/api/model/v1/models') return Response.json(toWire(ListModelsResponseSchema, create(ListModelsResponseSchema, { models: [
          { name: 'models/claude-opus-5-5', configured: options.modelConfigured !== false, connectionRevision: 'synthetic-connection', reservationInputMicrousdPerToken: 5, reservationOutputMicrousdPerToken: 25 },
          { name: 'models/claude-haiku-5-5', configured: options.modelConfigured !== false, connectionRevision: 'synthetic-connection', reservationInputMicrousdPerToken: 0.5, reservationOutputMicrousdPerToken: 2.5 },
          { name: 'models/bge-m3', configured: true, embeddings: true, dimensions: 1024, reservationQuotaUnitsPerToken: QUOTA_RATE },
        ] })));
        if (path === '/api/model/v1/embeddings:embed') {
          const input = await request.json<{ request_id: string; inputs: string[] }>();
          return Response.json(toWire(EmbeddingSchema, create(EmbeddingSchema, { name: `requests/${input.request_id}`, model: 'models/bge-m3', dimensions: 1024,
            usage: { available: false, billingKind: 'platform_quota', estimatedQuotaUnits: input.inputs.reduce((sum, text) => sum + estimateTokens(text), 0) * QUOTA_RATE },
            ...(quota ? { error: { code: 8, reason: 'MODEL_QUOTA', message: 'Synthetic quota.' } } : { vectors: input.inputs.map(text => ({ values: fakeVector(text) })) }) })));
        }
        if (path === '/api/model/v1/generations:generate') return claude.answer(fromWire(GenerateRequestSchema, await request.json()).message);
        return new Response('unexpected model route', { status: 404 });
      },
    },
    bindings,
    outboundService: outbound,
  });
  const split = options.splitObject === true;
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
        brief('brief', split),
        ...(split ? [brief(objectWorker, false)] : []),
        {
          name: 'probe',
          modules: true,
          compatibilityDate: COMPATIBILITY_DATE,
          durableObjects: { BRIEF: { className: 'BriefState', scriptName: split ? objectWorker : 'brief', useSQLite: true } },
          serviceBindings: { OPS: { name: 'brief', entrypoint: 'Ops' } },
          script: `export default { async fetch(request, env) {
            const { op, args } = await request.json()
            const stub = env.BRIEF.get(env.BRIEF.idFromName('brief-v1'))
            try {
              if (op === 'step') return Response.json({ ok: await stub.step(args[0]) })
              if (op === 'clock') return Response.json({ ok: await stub.setClock(args[0]) ?? null })
              if (op === 'registry') return Response.json({ ok: await stub.setRegistryForTests(args[0]) })
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
  const fetchBrief = (path: string, init?: RequestInit) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init } as never) as unknown as Promise<Response>;
  let csrf: { token: string; cookie: string } | undefined;
  const csrfToken = async () => {
    if (csrf === undefined) {
      const response = await fetchBrief('/api/csrf');
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
    return fetchBrief(call.url, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) });
  };
  const harness: Harness = {
    mf,
    logs,
    web,
    claude,
    sent,
    resend,
    fetch: fetchBrief,
    api: createHttpClient(BriefUiService, send),
    async clock(now) {
      clockNow = now;
      await probe('clock', [now]);
    },
    now: () => clockNow,
    async step(now) {
      clockNow = now;
      return (await probe('step', [now])) as AlarmResult;
    },
    async runUntil(from, until, max = 400) {
      const results: AlarmResult[] = [];
      let at = from;
      for (let i = 0; i < max && at <= until; i++) {
        const result = await harness.step(at);
        results.push(result);
        // A host's spacing may have advanced the object's clock: the next alarm is never before it.
        at = Math.max(result.next, at + SECOND);
      }
      return results;
    },
    async sql<T>(query: string, ...params: (string | number | null)[]) {
      return (await probe('sql', [query, ...params])) as T[];
    },
    async rows() {
      return (await probe('meter', [])) as { read: number; written: number };
    },
    opsStatus: async () => (await probe('ops_status', [])) as Record<string, unknown>,
    opsSetGuard: (input) => probe('ops_guard', [input]),
    aiQuota(on) {
      quota = on;
      return Promise.resolve();
    },
    async dispose() {
      await mf.dispose();
      if (options.persist === undefined) await rm(temp, { recursive: true, force: true });
    },
  };
  if (options.bundledRegistry !== true) await probe('registry', [options.registry ?? SYNTHETIC_REGISTRY]);
  return harness;
}

/** The local instant of a date and time in America/Los_Angeles (PDT in October 2026: UTC-7). */
export function la(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00-07:00`);
}

/** A fresh AIP-155 request ID. */
export function op(): string {
  return crypto.randomUUID();
}

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
