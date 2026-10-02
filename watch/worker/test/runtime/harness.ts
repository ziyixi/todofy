/**
 * workerd harness (../../../docs/design.md §10): bundles src/index.ts with esbuild and runs it in Miniflare as the Worker
 * "watch" with a real SQLite WatchState, next to
 *   - "probe": calls WatchState.step(now), setClock(now), alarmAt() and sqlForTests() over the object binding;
 *   - the outbound service "fake-net": every request the Worker makes goes to FakeSites (../fake-sites.ts), the
 *     synthetic websites, through ./fake-net.ts, which streams each body to the reader as it reads (never ahead of it);
 *     nothing leaves the process tree;
 *   - a fake ASSETS binding (the UI's page) and, when asked, a fake BROWSER binding (Browser Run's `content` action),
 *     through fake-net too.
 * DEV_MANUAL_ALARMS=true: no alarm is ever armed and the tests drive the scheduler with explicit clocks; the owner is
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
import { WatchUiService } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb';
import { FakeSites } from '../fake-sites.ts';
import { FakeNet } from './fake-net.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const ORIGIN = 'http://127.0.0.1';
/** The Worker that runs WatchState when HarnessOptions.splitObject. */
export const OBJECT_WORKER = 'watch-object';
/** The proxy Workers of ./fake-net.ts: the outbound service, and the fake BROWSER binding. */
const FAKE_NET_WORKER = 'fake-net';
const FAKE_BROWSER_WORKER = 'fake-browser';
export const PUBLIC_HOST = 'watch.example.com';
/** 2026-10-01T00:00:00Z: the tests' first clock. */
export const T0 = Date.parse('2026-10-01T00:00:00Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  PUBLIC_HOST,
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'b'.repeat(64),
  BUILD_SHA: 'test',
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: '',
  CSRF_SIGNING_KEY: 'cd'.repeat(32),
  DEV_AUTH_BYPASS: 'true',
  DEV_MANUAL_ALARMS: 'true',
  DEV_FETCH_TIMEOUT_MS: '500',
};

/** The page the fake ASSETS serves for every path (the real one is web/dist/index.html). */
export const TEST_PAGE = '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="app"></div></body></html>';

let bundle: Promise<string> | undefined;
function workerBundle(): Promise<string> {
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

/** What the fake browser answers: the HTML of a URL, the milliseconds it reports, where it ended up, or a 429. */
export interface FakeBrowser {
  pages: Map<string, string>;
  /** The URL the render ended on (`x-final-url`), when it is not the one asked for. */
  finalUrls: Map<string, string>;
  msUsed: number;
  quota: boolean;
  calls: string[];
}

export interface HarnessOptions {
  readonly bindings?: Record<string, string>;
  /** Bind a fake BROWSER (Browser Run's content action). */
  readonly browser?: boolean;
  /** Extra outbound routes by URL (the Access certs endpoint), before FakeSites. */
  readonly routes?: Map<string, () => Response>;
  /** Opens workerd's DevTools inspector on this port (./cpu.test.ts). */
  readonly inspectorPort?: number;
  /**
   * Runs WatchState in a Worker of its own ("watch-object", the same bundle), as Cloudflare runs a Durable Object apart
   * from the Worker that calls it: the CPU test then measures the fetch handler and the object in separate isolates.
   */
  readonly splitObject?: boolean;
}

export interface Harness {
  readonly mf: Miniflare;
  readonly sites: FakeSites;
  readonly browser: FakeBrowser;
  /** The Worker's log lines (console output). */
  readonly logs: string[];
  /** A request to "watch" over loopback http. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** WatchUiService through the shared typed client, exactly as the UI calls it (CSRF and Origin on mutations). */
  readonly api: HttpClient<ShapeOf<typeof WatchUiService>>;
  /** A raw request with the CSRF token and the loopback Origin. */
  mutate(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Response>;
  /** Sets the clock the owner API reads. */
  clock(now: number): Promise<void>;
  /** One scheduler pass at `now`. */
  step(now: number): Promise<{ next: number; outcomes?: Record<string, number>; requests?: number; left?: number; error?: string }>;
  /** Steps from `now` while the next pass is due within `horizon` (a minute: what a budget left); returns the last clock. */
  run(now: number, horizon?: number, max?: number): Promise<number>;
  alarmAt(): Promise<number | null>;
  sql<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): Promise<T[]>;
  /** The SQLite rows WatchState read and wrote since the last call (`sql` itself not counted). */
  rows(): Promise<{ read: number; written: number }>;
  dispose(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = await mkdtemp(join(tmpdir(), 'watch-runtime-'));
  const script = await workerBundle();
  const sites = new FakeSites();
  const browser: FakeBrowser = { pages: new Map(), finalUrls: new Map(), msUsed: 20_000, quota: false, calls: [] };
  const logs: string[] = [];
  const outbound = new FakeNet(async (request) => options.routes?.get(request.url)?.() ?? sites.handle(request));
  const fakeBrowser = new FakeNet(async (request) => {
    const { url } = await request.json<{ url: string }>();
    browser.calls.push(url);
    if (browser.quota) return new Response('rate limited', { status: 429 });
    const html = browser.pages.get(url);
    if (html === undefined) return new Response('', { status: 200, headers: { 'x-page-status': '404', 'x-browser-ms-used': String(browser.msUsed) } });
    const finalUrl = browser.finalUrls.get(url);
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-page-status': '200', 'x-browser-ms-used': String(browser.msUsed), ...(finalUrl === undefined ? {} : { 'x-final-url': finalUrl }) },
    });
  });
  const bindings = { ...SYNTHETIC_BINDINGS, ...options.bindings };
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
        {
          name: 'watch',
          modules: true,
          script,
          compatibilityDate: '2026-09-08',
          durableObjects: { WATCH: { className: 'WatchState', useSQLite: true, ...(options.splitObject === true ? { scriptName: OBJECT_WORKER } : {}) } },
          serviceBindings: {
            ASSETS: () => new Response(TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
            ...(options.browser === true ? { BROWSER: FAKE_BROWSER_WORKER } : {}),
          },
          bindings,
          outboundService: FAKE_NET_WORKER,
        },
        ...(options.splitObject === true
          ? [
              {
                name: OBJECT_WORKER,
                modules: true,
                script,
                compatibilityDate: '2026-09-08',
                durableObjects: { WATCH: { className: 'WatchState', useSQLite: true } },
                serviceBindings: { ASSETS: () => new Response('', { status: 404 }) },
                bindings,
                outboundService: FAKE_NET_WORKER,
              },
            ]
          : []),
        outbound.worker(FAKE_NET_WORKER),
        ...(options.browser === true ? [fakeBrowser.worker(FAKE_BROWSER_WORKER)] : []),
        {
          name: 'probe',
          modules: true,
          compatibilityDate: '2026-09-08',
          durableObjects: { WATCH: { className: 'WatchState', scriptName: options.splitObject === true ? OBJECT_WORKER : 'watch', useSQLite: true } },
          script: `export default { async fetch(request, env) {
            const { op, args } = await request.json()
            const stub = env.WATCH.get(env.WATCH.idFromName('watch-v1'))
            try {
              if (op === 'step') return Response.json({ ok: await stub.step(args[0]) })
              if (op === 'clock') return Response.json({ ok: await stub.setClock(args[0]) ?? null })
              if (op === 'alarm') return Response.json({ ok: await stub.alarmAt() })
              if (op === 'sql') return Response.json({ ok: await stub.sqlForTests(...args) })
              if (op === 'meter') return Response.json({ ok: await stub.takeRowMeter() })
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
  const fetchWatch = (path: string, init?: RequestInit) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init } as never) as unknown as Promise<Response>;
  let csrf: { token: string; cookie: string } | undefined;
  const csrfToken = async () => {
    if (csrf === undefined) {
      const response = await fetchWatch('/api/csrf');
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
    return fetchWatch(call.url, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) });
  };
  const harness: Harness = {
    mf,
    sites,
    browser,
    logs,
    fetch: fetchWatch,
    api: createHttpClient(WatchUiService, send),
    async mutate(method, path, body) {
      const { token, cookie } = await csrfToken();
      const headers: Record<string, string> = { origin: ORIGIN, 'x-csrf-token': token, cookie };
      if (body !== undefined) headers['content-type'] = 'application/json';
      return fetchWatch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    async clock(now) {
      await probe('clock', [now]);
    },
    async step(now) {
      return (await probe('step', [now])) as Awaited<ReturnType<Harness['step']>>;
    },
    async run(now, horizon = MINUTE, max = 50) {
      let at = now;
      for (let steps = 0; steps < max; steps++) {
        const { next } = await harness.step(at);
        if (next - at > horizon) return at;
        at = Math.max(at, next);
      }
      throw new Error(`scheduler still busy after ${String(max)} passes`);
    },
    async alarmAt() {
      return (await probe('alarm', [])) as number | null;
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

/** The ErrorInfo reason of a thrown RpcStatusError or a Status body. */
export function reasonOf(error: unknown): string | undefined {
  const status = (error as { status?: { reason?: string } }).status;
  if (status?.reason !== undefined) return status.reason;
  const details = (error as { error?: { details?: { '@type': string; reason?: string }[] } }).error?.details ?? [];
  return details.find((detail) => detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')?.reason;
}

/** The rejection of `promise` (a test fails when it resolves). */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** Deletes every watch (between tests that share a harness) and forgets the fake sites' routes and requests. */
export async function resetWatches(h: Harness): Promise<void> {
  const { watches } = await h.api.listWatches({});
  for (const watch of watches) await h.api.deleteWatch({ name: watch.name, requestId: op() });
  h.sites.reset();
}

/** The watch's row in WatchState's SQLite (scheduler state the API does not show). */
export async function watchRow(h: Harness, id: string): Promise<Record<string, unknown>> {
  const [row] = await h.sql('SELECT * FROM watches WHERE id = ?', id);
  if (row === undefined) throw new Error(`no watch ${id}`);
  return row;
}
