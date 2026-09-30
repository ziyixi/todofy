/**
 * workerd harness (docs/design.md §9): bundles src/index.ts with esbuild and runs it in Miniflare as
 * the Worker "home" with a real SQLite HomeState, next to stub "mail-hero" and "todofy" Workers whose
 * `Ops` entrypoints answer with contracts/ops-v1 fixtures, and an outbound fetch handler that plays the
 * Cloudflare GraphQL API and the Access certs endpoint. All data is synthetic.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CONTRACT = resolve(ROOT, '../../contracts/ops-v1');

/** Methods ops-v1.ts declares per app (test/ops-surface checks this list against the file). */
export const DECLARED_METHODS = {
  'mail-hero': ['status', 'setGuard', 'startCanary', 'canaryDelivery'],
  todofy: ['status', 'setGuard', 'canaryResult', 'reportOps'],
} as const;
export type StubApp = keyof typeof DECLARED_METHODS;

export async function fixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(CONTRACT, 'fixtures', path), 'utf8')) as unknown;
}

export async function contractSchema(): Promise<{ $defs: Record<string, unknown> }> {
  return JSON.parse(await readFile(join(CONTRACT, 'ops-v1.schema.json'), 'utf8')) as { $defs: Record<string, unknown> };
}

/** Default answers of each stub: healthy apps, a queued/delivered/ok canary, a stored report. */
async function defaults(app: StubApp): Promise<Record<string, unknown>> {
  if (app === 'mail-hero') {
    return {
      status: await fixture('OpsStatus/mail-hero-ok.json'),
      setGuard: await fixture('GuardState/normal.json'),
      startCanary: await fixture('StartCanaryResult/queued.json'),
      canaryDelivery: await fixture('CanaryDelivery/delivered.json'),
    };
  }
  return {
    status: await fixture('OpsStatus/todofy-ok.json'),
    setGuard: await fixture('GuardState/normal.json'),
    canaryResult: await fixture('CanaryResult/ok.json'),
    reportOps: await fixture('OpsReportReceipt/stored.json'),
  };
}

async function stubScript(app: StubApp): Promise<string> {
  const template = await readFile(join(ROOT, 'test/stubs/ops-stub.js'), 'utf8');
  return template
    .replace('const APP = __APP__', `const APP = ${JSON.stringify(app)}`)
    .replace('const METHODS = __METHODS__', `const METHODS = ${JSON.stringify(DECLARED_METHODS[app])}`)
    .replace('const DEFAULTS = __DEFAULTS__', `const DEFAULTS = ${JSON.stringify(await defaults(app))}`);
}

let bundled: Promise<string> | undefined;
/** The real Worker, bundled once per test file. */
export function bundle(): Promise<string> {
  bundled ??= build({
    entryPoints: [join(ROOT, 'src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2024',
    external: ['cloudflare:workers'],
    write: false,
    logLevel: 'silent',
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw new Error('esbuild produced no output');
    return output.text;
  });
  return bundled;
}

export type Outbound = (request: Request) => Response | Promise<Response>;

export interface HarnessOptions {
  /** Vars and secrets of "home" on top of the synthetic defaults. */
  readonly bindings?: Record<string, string>;
  /** Every outbound fetch of "home" (GraphQL, Access certs); default: 599 so nothing leaves the test. */
  readonly outbound?: Outbound;
}

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  PUBLIC_HOST: 'home.example.com',
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'a'.repeat(64),
  ACCOUNT_ID: '0'.repeat(32),
  MAIL_HERO_URL: 'https://mail.example.com/',
  TODOFY_URL: 'https://todofy.example.com/',
  CANARY_UTC_HOUR: '16',
  BUILD_SHA: 'test',
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: '',
  CSRF_SIGNING_KEY: 'ab'.repeat(32),
  CF_ANALYTICS_TOKEN: 'synthetic-analytics-token-000000000000',
};

export interface Harness {
  readonly mf: Miniflare;
  /** A request to "home" (the first worker). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Runs the cron handler of "home" with this scheduled time. */
  scheduled(at: Date): Promise<void>;
  /** Sets a stub's scenario (see test/stubs/ops-stub.js). */
  scenario(app: StubApp, value: Record<string, unknown>): Promise<void>;
  /** Calls `method` on a stub's Ops entrypoint through a service binding: the value or the rejection message. */
  rpc(app: StubApp, method: string, ...args: unknown[]): Promise<{ ok?: unknown; error?: string }>;
  /** Drains the stub's call log. */
  calls(app: StubApp): Promise<{ app: StubApp; method: string; args: unknown[] }[]>;
  dispose(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = await mkdtemp(join(tmpdir(), 'home-dashboard-'));
  const outbound: Outbound = options.outbound ?? (() => new Response('no outbound fetch expected', { status: 599 }));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: 0,
      durableObjectsPersist: join(temp, 'do'),
      workers: [
        {
          name: 'home',
          modules: true,
          script: await bundle(),
          compatibilityDate: '2026-09-08',
          durableObjects: { HOME: { className: 'HomeState', useSQLite: true } },
          serviceBindings: {
            MAIL_HERO: { name: 'mail-hero', entrypoint: 'Ops' },
            TODOFY: { name: 'todofy', entrypoint: 'Ops' },
            ASSETS: () => new Response('<!doctype html><title>home</title>', { headers: { 'content-type': 'text/html' } }),
          },
          bindings: { ...SYNTHETIC_BINDINGS, ...options.bindings },
          outboundService: (request: Request) => outbound(request),
        },
        { name: 'mail-hero', modules: true, script: await stubScript('mail-hero'), compatibilityDate: '2026-09-08' },
        { name: 'todofy', modules: true, script: await stubScript('todofy'), compatibilityDate: '2026-09-08' },
        // Calls a stub's Ops method over the same kind of binding "home" has (tests of the stubs).
        {
          name: 'ops-probe',
          modules: true,
          compatibilityDate: '2026-09-08',
          script: `export default { async fetch(request, env) {
            const { app, method, args } = await request.json()
            const target = app === 'mail-hero' ? env.MAIL_HERO : env.TODOFY
            try { return Response.json({ ok: await target[method](...args) }) }
            catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'not_an_error' }) }
          } }`,
          serviceBindings: {
            MAIL_HERO: { name: 'mail-hero', entrypoint: 'Ops' },
            TODOFY: { name: 'todofy', entrypoint: 'Ops' },
          },
        },
      ],
    }),
  );
  await mf.ready;
  const stub = (app: StubApp) => mf.getWorker(app);
  return {
    mf,
    fetch: (path, init) => mf.dispatchFetch(`http://127.0.0.1${path}`, init as never) as unknown as Promise<Response>,
    async scheduled(at) {
      const home = await mf.getWorker('home');
      await home.scheduled({ scheduledTime: at, cron: '*/30 * * * *' });
    },
    async scenario(app, value) {
      const response = await (await stub(app)).fetch('http://stub/__scenario', { method: 'POST', body: JSON.stringify(value) });
      if (response.status !== 204) throw new Error(`scenario ${app}: ${String(response.status)}`);
    },
    async rpc(app, method, ...args) {
      const probe = await mf.getWorker('ops-probe');
      const response = await probe.fetch('http://probe/', { method: 'POST', body: JSON.stringify({ app, method, args }) });
      return (await response.json()) as { ok?: unknown; error?: string };
    },
    async calls(app) {
      const response = await (await stub(app)).fetch('http://stub/__calls');
      return (await response.json()) as { app: StubApp; method: string; args: unknown[] }[];
    },
    async dispose() {
      await mf.dispose();
      await rm(temp, { recursive: true, force: true });
    },
  };
}
