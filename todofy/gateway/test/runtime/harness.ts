/**
 * workerd harness of the gateway alone: bundles src/index.ts with esbuild and runs it in Miniflare as the Worker
 * "todofy", next to a stand-in "todofy-core" whose TodofyCore object answers every RPC method from canned values
 * (the gateway cannot tell it from the Python object: it sees the same method names and answers). With it the
 * gateway's own CPU per request is measured in workerd (./cpu.test.ts), Access verified as in production (a
 * synthetic issuer whose keys the outbound handler serves), the CSRF check included. The whole pair, with the real
 * Python core, D1 and the UI, is the runtime suite in ../../../tests/runtime. All data is synthetic; nothing leaves
 * the process.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const PUBLIC_HOST = 'todofy.example.com';
export const ORIGIN = `https://${PUBLIC_HOST}`;
export const OWNER = 'owner@example.com';

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  TODOFY_PUBLIC_HOST: PUBLIC_HOST,
  TODOFY_HOOKS_HOSTS: 'todofy-hooks.example.com',
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'c'.repeat(64),
  ACCESS_OWNER: OWNER,
  ACCESS_OWNER_ALIASES: '',
  CSRF_SIGNING_KEY: 'ef'.repeat(32),
  BUILD_SHA: 'test',
  MAINTENANCE_MODE: 'false',
};

/**
 * The stand-in TodofyCore: each RPC method answers `ANSWERS[method]`, or for the owner API the answer of the
 * rpc (`owner_ui`) or the path (`owner_api`, the gateway before todofy.ui.v1). Every call is counted by method.
 */
const CORE_SCRIPT = `
import { DurableObject } from 'cloudflare:workers';
const ANSWERS = __ANSWERS__;
const calls = {};
const count = (name) => { calls[name] = (calls[name] ?? 0) + 1; };
export class TodofyCore extends DurableObject {
  owner_ui(owner, method, request, cursor) { count('owner_ui'); return ANSWERS.owner_ui[method] ?? { error: 'NOT_FOUND', detail: null, retry_after: null }; }
  owner_api(owner, method, path) { count('owner_api'); return ANSWERS.owner_api[path] ?? { status: 404, body: null, error: { code: 'not_found', message: 'x' }, retry_after: null }; }
  setup() { count('setup'); return ANSWERS.setup; }
  calls() { return calls; }
}
export default { fetch() { return new Response('not found', { status: 404 }); } };
`;

/** Canned answers of the stand-in core. */
export interface CoreAnswers {
  /** By rpc name (`ListMailEvents`): `{ok, next_cursor}` or `{error, detail, retry_after}`. */
  readonly owner_ui?: Readonly<Record<string, unknown>>;
  /** By path (`/api/v1/events`): a CoreResult. */
  readonly owner_api?: Readonly<Record<string, unknown>>;
  readonly setup?: unknown;
}

let bundle: Promise<string> | undefined;
function gatewayBundle(): Promise<string> {
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

export interface Harness {
  readonly mf: Miniflare;
  /** A request to the owner host. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  readonly answers: CoreAnswers;
  readonly bindings?: Record<string, string>;
  /** Outbound routes (the Access certs endpoint), by URL. */
  readonly routes?: Map<string, () => Response>;
  /** Opens workerd's DevTools inspector on this port (0: any free port), for the CPU profile of ./cpu.test.ts. */
  readonly inspectorPort?: number;
}

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const temp = await mkdtemp(join(tmpdir(), 'todofy-gateway-runtime-'));
  const outbound = (request: Request): Response => options.routes?.get(request.url)?.() ?? new Response('no outbound fetch expected', { status: 599 });
  const assets = (): Response => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const answers = { owner_ui: {}, owner_api: {}, setup: null, ...options.answers };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: 0,
      resourcePersistencePath: temp,
      handleStructuredLogs: ({ level, message }) => {
        if (level === 'warn' || level === 'error') process.stderr.write(`${message}\n`);
      },
      ...(options.inspectorPort === undefined ? {} : { inspectorPort: options.inspectorPort }),
      workers: [
        {
          name: 'todofy',
          modules: true,
          script: await gatewayBundle(),
          compatibilityDate: '2026-09-08',
          durableObjects: { COORDINATOR: { className: 'TodofyCore', scriptName: 'todofy-core' } },
          serviceBindings: { ASSETS: () => assets() },
          bindings: { ...SYNTHETIC_BINDINGS, ...options.bindings },
          outboundService: (request: Request) => outbound(request),
        },
        {
          name: 'todofy-core',
          modules: true,
          script: CORE_SCRIPT.replace('__ANSWERS__', JSON.stringify(answers)),
          compatibilityDate: '2026-09-08',
          durableObjects: { CORE: 'TodofyCore' },
        },
      ],
    }),
  );
  await mf.ready;
  return {
    mf,
    fetch: (path, init) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init } as never) as unknown as Promise<Response>,
    async dispose() {
      await mf.dispose();
      await rm(temp, { recursive: true, force: true });
    },
  };
}
