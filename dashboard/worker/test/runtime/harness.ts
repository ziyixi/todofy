/**
 * workerd harness (docs/design.md §9): bundles src/index.ts with esbuild and runs it in Miniflare as
 * the Worker "home" with a real SQLite HomeState, next to stub "mail-hero", "todofy", "watch", "fleet", "newsletter",
 * "notion-publish" (and the other ops-v1 apps') Workers whose `Ops` entrypoints answer with contracts/ops-v1 fixtures,
 * the "tasks" stub's TaskInbox as TASK_INBOX (the digest's daily task), and an outbound fetch handler that plays the
 * Cloudflare GraphQL API and the Access certs endpoint. All data is synthetic.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { OpsApp } from '../../src/api-types.ts';
import { declaredMethods } from '../contract.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CONTRACT = resolve(ROOT, '../../contracts/ops-v1');

export type StubApp = OpsApp;

/** What the "tasks" stub's TaskInbox answers by default: a created task. */
export const SYNTHETIC_TASK = { task_id: '00000000-0000-4000-8000-0000000000aa', subtask_ids: [], replayed: false } as const;

/** What the "notion-publish" stub's WebsiteSync answers by default: one unchanged daily check. */
export const SYNTHETIC_SYNC = {
  observed_at: '2026-10-01T14:00:00Z',
  next_check_at: '2026-10-02T14:00:00Z',
  last_check: { checked_at: '2026-10-01T14:00:00Z', decision: 'unchanged', run_id: '12001', run_url: 'https://github.com/example/cloud/actions/runs/12001' },
} as const;

/** The methods of `app`'s Ops entrypoint (the generated services it implements): the stubs expose exactly these. */
export function declaredMethodsOf(app: StubApp): string[] {
  return declaredMethods(app);
}

export async function fixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(CONTRACT, 'fixtures', path), 'utf8')) as unknown;
}

/** Default answers of each stub: healthy apps, a queued/delivered/ok canary, a created digest task. */
async function defaults(app: StubApp): Promise<Record<string, unknown>> {
  if (app === 'mail-hero') {
    return {
      status: await fixture('OpsStatus/mail-hero-ok.json'),
      setGuard: await fixture('GuardState/normal.json'),
      startCanary: await fixture('StartCanaryResult/queued.json'),
      canaryDelivery: await fixture('CanaryDelivery/delivered.json'),
    };
  }
  if (app === 'notion-publish') return { status: await fixture('OpsStatus/notion-publish-ok.json'), getSyncStatus: SYNTHETIC_SYNC };
  // recall has no guard: its setGuard always refuses, and Home never calls it.
  if (app === 'tasks') return { status: await fixture('OpsStatus/tasks-ok.json'), createInboxTask: SYNTHETIC_TASK };
  if (app === 'model-router') return { status: JSON.parse(await readFile(join(ROOT, 'test/fixtures/model-router-ok.json'), 'utf8')) as unknown };
  if (app === 'personal-mcp') return { status: JSON.parse(await readFile(join(ROOT, 'test/fixtures/personal-mcp-ok.json'), 'utf8')) as unknown };
  if (app === 'recall') return { status: await fixture('OpsStatus/recall-ok.json') };
  // The links app has no guard either: its setGuard always refuses.
  if (app === 'links') return { status: await fixture('OpsStatus/links-ok.json') };
  if (app === 'fleet' || app === 'newsletter' || app === 'codex-gateway') {
    return { status: await fixture(`OpsStatus/${app}-ok.json`), setGuard: await fixture('GuardState/normal.json') };
  }
  if (app === 'watch' || app === 'mailsort') {
    return { status: await fixture(`OpsStatus/${app}-ok.json`), setGuard: await fixture('GuardState/normal.json') };
  }
  return {
    status: await fixture('OpsStatus/todofy-ok.json'),
    setGuard: await fixture('GuardState/normal.json'),
    canaryResult: await fixture('CanaryResult/ok.json'),
  };
}

async function stubScript(app: StubApp): Promise<string> {
  const template = await readFile(join(ROOT, 'test/stubs/ops-stub.js'), 'utf8');
  return template
    .replace('const APP = __APP__', `const APP = ${JSON.stringify(app)}`)
    .replace('const METHODS = __METHODS__', `const METHODS = ${JSON.stringify(declaredMethodsOf(app))}`)
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
  /** Directory of the Durable Object storage, kept after dispose (a later harness reopens it); default: a temp dir removed on dispose. */
  readonly persist?: string;
  /** workerd's DevTools inspector on this port (the CPU test, tools/workerd-cpu); default: none. */
  readonly inspectorPort?: number;
}

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  PUBLIC_HOST: 'home.example.com',
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'a'.repeat(64),
  ACCOUNT_ID: '0'.repeat(32),
  CANARY_UTC_HOUR: '16',
  BUILD_SHA: 'test',
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: '',
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
  /**
   * Redeploys "home" with these vars on top of the synthetic defaults (and the harness's own), keeping
   * its Durable Object storage: a config change such as CANARY_ENABLED=false between ticks. Every worker
   * restarts, so the stubs lose their scenarios and call logs (drain and set them again).
   */
  rebind(bindings: Record<string, string>): Promise<void>;
  dispose(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = options.persist ?? (await mkdtemp(join(tmpdir(), 'home-dashboard-')));
  const outbound: Outbound = options.outbound ?? (() => new Response('no outbound fetch expected', { status: 599 }));
  const scripts = { home: await bundle(), 'mail-hero': await stubScript('mail-hero'), todofy: await stubScript('todofy'), watch: await stubScript('watch'), fleet: await stubScript('fleet'), newsletter: await stubScript('newsletter'), 'codex-gateway': await stubScript('codex-gateway'), 'notion-publish': await stubScript('notion-publish'), mailsort: await stubScript('mailsort'), recall: await stubScript('recall'), tasks: await stubScript('tasks'), 'personal-mcp': await stubScript('personal-mcp'), 'model-router': await stubScript('model-router'), links: await stubScript('links') };
  const configure = (bindings: Record<string, string>): ConstructorParameters<typeof Miniflare>[0] =>
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: 0,
      ...(options.inspectorPort === undefined ? {} : { inspectorPort: options.inspectorPort }),
      // Durable Object storage (SQLite files) under temp/do/, kept across rebind() and, with `persist`, across harnesses.
      resourcePersistencePath: temp,
      workers: [
        {
          name: 'home',
          modules: true,
          script: scripts.home,
          compatibilityDate: '2026-09-08',
          durableObjects: { HOME: { className: 'HomeState', useSQLite: true } },
          serviceBindings: {
            MAIL_HERO: { name: 'mail-hero', entrypoint: 'Ops' },
            TODOFY: { name: 'todofy', entrypoint: 'Ops' },
            WATCH: { name: 'watch', entrypoint: 'Ops' },
            FLEET: { name: 'fleet', entrypoint: 'Ops' },
            NEWSLETTER: { name: 'newsletter', entrypoint: 'Ops' },
            CODEX_GATEWAY: { name: 'codex-gateway', entrypoint: 'Ops' },
            NOTION_PUBLISH: { name: 'notion-publish', entrypoint: 'Ops' },
            WEBSITE_SYNC: { name: 'notion-publish', entrypoint: 'WebsiteSync' },
            MAILSORT: { name: 'mailsort', entrypoint: 'Ops' },
            RECALL: { name: 'recall', entrypoint: 'Ops' },
            TASKS: { name: 'tasks', entrypoint: 'Ops' },
            PERSONAL_MCP: { name: 'personal-mcp', entrypoint: 'Ops' },
            MODEL_ROUTER: { name: 'model-router', entrypoint: 'Ops' },
            LINKS: { name: 'links', entrypoint: 'Ops' },
            // As dashboard/wrangler.toml binds it: Tasks' TaskInbox for source home.
            TASK_INBOX: { name: 'tasks', entrypoint: 'TaskInbox', props: { source: 'home' } },
            ASSETS: () => new Response('<!doctype html><title>home</title>', { headers: { 'content-type': 'text/html' } }),
          },
          bindings,
          outboundService: (request: Request) => outbound(request),
        },
        { name: 'mail-hero', modules: true, script: scripts['mail-hero'], compatibilityDate: '2026-09-08' },
        { name: 'todofy', modules: true, script: scripts.todofy, compatibilityDate: '2026-09-08' },
        { name: 'watch', modules: true, script: scripts.watch, compatibilityDate: '2026-09-08' },
        { name: 'fleet', modules: true, script: scripts.fleet, compatibilityDate: '2026-09-08' },
        { name: 'newsletter', modules: true, script: scripts.newsletter, compatibilityDate: '2026-09-08' },
        { name: 'codex-gateway', modules: true, script: scripts['codex-gateway'], compatibilityDate: '2026-09-08' },
        { name: 'notion-publish', modules: true, script: scripts['notion-publish'], compatibilityDate: '2026-09-08' },
        { name: 'mailsort', modules: true, script: scripts.mailsort, compatibilityDate: '2026-09-08' },
        { name: 'recall', modules: true, script: scripts.recall, compatibilityDate: '2026-09-08' },
        { name: 'tasks', modules: true, script: scripts.tasks, compatibilityDate: '2026-09-08' },
        { name: 'personal-mcp', modules: true, script: scripts['personal-mcp'], compatibilityDate: '2026-09-08' },
        { name: 'model-router', modules: true, script: scripts['model-router'], compatibilityDate: '2026-09-08' },
        { name: 'links', modules: true, script: scripts.links, compatibilityDate: '2026-09-08' },
        // Calls a stub's Ops method over the same kind of binding "home" has (tests of the stubs).
        {
          name: 'ops-probe',
          modules: true,
          compatibilityDate: '2026-09-08',
          script: `export default { async fetch(request, env) {
            const { app, method, args } = await request.json()
            const target = app === 'mail-hero' ? env.MAIL_HERO : app === 'watch' ? env.WATCH : app === 'fleet' ? env.FLEET : app === 'newsletter' ? env.NEWSLETTER : app === 'codex-gateway' ? env.CODEX_GATEWAY : app === 'notion-publish' ? (['getSyncStatus', 'requestSync', 'getSyncRequest'].includes(method) ? env.WEBSITE_SYNC : env.NOTION_PUBLISH) : app === 'mailsort' ? env.MAILSORT : app === 'recall' ? env.RECALL : app === 'tasks' ? env.TASKS : app === 'personal-mcp' ? env.PERSONAL_MCP : app === 'model-router' ? env.MODEL_ROUTER : app === 'links' ? env.LINKS : env.TODOFY
            try { return Response.json({ ok: await target[method](...args) }) }
            catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'not_an_error' }) }
          } }`,
          serviceBindings: {
            MAIL_HERO: { name: 'mail-hero', entrypoint: 'Ops' },
            TODOFY: { name: 'todofy', entrypoint: 'Ops' },
            WATCH: { name: 'watch', entrypoint: 'Ops' },
            FLEET: { name: 'fleet', entrypoint: 'Ops' },
            NEWSLETTER: { name: 'newsletter', entrypoint: 'Ops' },
            CODEX_GATEWAY: { name: 'codex-gateway', entrypoint: 'Ops' },
            NOTION_PUBLISH: { name: 'notion-publish', entrypoint: 'Ops' },
            WEBSITE_SYNC: { name: 'notion-publish', entrypoint: 'WebsiteSync' },
            MAILSORT: { name: 'mailsort', entrypoint: 'Ops' },
            RECALL: { name: 'recall', entrypoint: 'Ops' },
            TASKS: { name: 'tasks', entrypoint: 'Ops' },
            PERSONAL_MCP: { name: 'personal-mcp', entrypoint: 'Ops' },
            MODEL_ROUTER: { name: 'model-router', entrypoint: 'Ops' },
            LINKS: { name: 'links', entrypoint: 'Ops' },
          },
        },
      ],
    });
  const base = { ...SYNTHETIC_BINDINGS, ...options.bindings };
  const mf = new Miniflare(configure(base));
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
    async rebind(bindings) {
      await mf.setOptions(configure({ ...base, ...bindings }));
      await mf.ready;
    },
    async dispose() {
      await mf.dispose();
      if (options.persist === undefined) await rm(temp, { recursive: true, force: true });
    },
  };
}
