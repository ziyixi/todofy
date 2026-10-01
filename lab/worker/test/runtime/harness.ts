/**
 * workerd harness (docs/design.md §12): bundles src/index.ts with esbuild and runs it in Miniflare as the
 * Worker "lab" with a real D1 database (migrations/ applied) and a real SQLite LabState, next to
 *   - "todofy": a stub whose `Ops` entrypoint answers task-intent-v1 (test/stubs/todofy-stub.ts),
 *   - "fake-ai": the AI binding (test/stubs/fake-ai.ts),
 *   - "probe": calls LabState.step(now), reads LabState.alarmAt() and calls Lab's own Ops entrypoint over
 *     real bindings,
 * and an outbound handler that plays rss.arxiv.org and export.arxiv.org. DEV_MANUAL_ALARMS=true: the tests
 * drive the pipeline with explicit clocks. All data is synthetic; nothing leaves the process.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LAB = resolve(ROOT, '..');
const CONTRACTS = resolve(LAB, '../contracts');

export const LAB_TEST_HOST = 'lab.example.com';

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  PUBLIC_HOST: LAB_TEST_HOST,
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'b'.repeat(64),
  LAB_DAILY_NEURONS: '5000',
  LAB_FETCH_UTC_HOUR: '6',
  BUILD_SHA: 'test',
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: '',
  CSRF_SIGNING_KEY: 'cd'.repeat(32),
  DEV_AUTH_BYPASS: 'true',
  DEV_MANUAL_ALARMS: 'true',
};

async function bundleFile(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2024',
    external: ['cloudflare:workers'],
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`esbuild produced no output for ${entry}`);
  return output.text;
}

let scripts: Promise<{ lab: string; todofy: string; ai: string }> | undefined;
function bundles(): Promise<{ lab: string; todofy: string; ai: string }> {
  scripts ??= Promise.all([bundleFile('src/index.ts'), bundleFile('test/stubs/todofy-stub.ts'), bundleFile('test/stubs/fake-ai.ts')]).then(([lab, todofy, ai]) => ({ lab, todofy, ai }));
  return scripts;
}

/** The D1 migrations as single statements (comments removed). */
export async function migrationStatements(): Promise<string[]> {
  const dir = join(LAB, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out: string[] = [];
  for (const file of files) {
    const text = (await readFile(join(dir, file), 'utf8'))
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    for (const statement of text.split(/;\s*(?:\n|$)/)) if (statement.trim() !== '') out.push(statement.trim());
  }
  return out;
}

export async function contractSchema(name: 'ops-v1' | 'task-intent-v1'): Promise<{ $defs: Record<string, unknown> }> {
  return JSON.parse(await readFile(join(CONTRACTS, name, `${name}.schema.json`), 'utf8')) as { $defs: Record<string, unknown> };
}

/** What the fake arXiv answers; tests change it between steps. */
export interface ArxivScenario {
  feed: { status: number; body: string; etag?: string };
  /** Atom entries by bare ID for export.arxiv.org. */
  atom: Map<string, { title: string; abstract: string }>;
}

export interface ArxivRequest {
  readonly url: string;
  readonly userAgent: string | null;
  readonly ifNoneMatch: string | null;
}

export interface HarnessOptions {
  readonly bindings?: Record<string, string>;
  /** Extra outbound routes (e.g. the Access certs endpoint), by URL. */
  readonly routes?: Map<string, () => Response>;
  /** Opens workerd's DevTools inspector on this port (the CPU profile of ./cpu.test.ts). */
  readonly inspectorPort?: number;
}

export interface Harness {
  readonly mf: Miniflare;
  readonly arxiv: ArxivScenario;
  readonly requests: ArxivRequest[];
  /** A request to "lab" over loopback http (the dev bypass signs in the owner). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** JSON of a GET, asserting 200. */
  get<T>(path: string): Promise<T>;
  /** A mutation with a fresh CSRF token and the loopback Origin; returns status and JSON. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the answer's shape
  mutate<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown): Promise<{ status: number; body: T }>;
  /** One LabState pipeline slice at `now`. */
  step(now: number): Promise<{ next: number }>;
  /** The time of LabState's armed alarm, or null when none is set. */
  alarmAt(): Promise<number | null>;
  /** Steps from `now` until nothing is left to do soon (next alarm more than a minute away); returns the last clock. */
  run(now: number, max?: number): Promise<number>;
  /** Calls a method of Lab's own Ops entrypoint: the value or the rejection message. */
  ops(method: string, ...args: unknown[]): Promise<{ ok?: unknown; error?: string }>;
  todofy(scenario: Record<string, unknown>): Promise<void>;
  todofyState(): Promise<{ invalid: number; calls: { method: string; intent_id: string }[]; intents: { id: string; total: number; created: number; intent: { items: { title: string; url?: string }[]; parent: { title: string }; mode: string } }[] }>;
  ai(scenario: Record<string, unknown>): Promise<void>;
  aiCalls(): Promise<{ model: string; count: number }[]>;
  sql<T>(query: string, ...params: unknown[]): Promise<T[]>;
  dispose(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = await mkdtemp(join(tmpdir(), 'lab-runtime-'));
  const code = await bundles();
  const arxiv: ArxivScenario = { feed: { status: 503, body: '' }, atom: new Map() };
  const requests: ArxivRequest[] = [];
  const outbound = (request: Request): Response => {
    const url = new URL(request.url);
    const extra = options.routes?.get(request.url);
    if (extra) return extra();
    if (url.hostname === 'rss.arxiv.org' || url.hostname === 'export.arxiv.org') {
      requests.push({ url: request.url, userAgent: request.headers.get('user-agent'), ifNoneMatch: request.headers.get('if-none-match') });
    }
    if (url.hostname === 'rss.arxiv.org') {
      const { status, body, etag } = arxiv.feed;
      if (etag !== undefined && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
      return new Response(status === 200 ? body : 'unavailable', { status, headers: etag === undefined ? {} : { etag } });
    }
    if (url.hostname === 'export.arxiv.org') {
      const ids = (url.searchParams.get('id_list') ?? '').split(',');
      const entries = ids.flatMap((id) => {
        const e = arxiv.atom.get(id);
        return e === undefined
          ? []
          : [
              `<entry><id>http://arxiv.org/abs/${id}v1</id><published>2026-08-01T00:00:00Z</published><title>${e.title}</title><summary>${e.abstract}</summary><author><name>Seed Author</name></author><arxiv:primary_category term="cs.IR"/><category term="cs.IR"/></entry>`,
            ];
      });
      return new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`, { status: 200 });
    }
    return new Response('no outbound fetch expected', { status: 599 });
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: 0,
      resourcePersistencePath: temp,
      ...(options.inspectorPort === undefined ? {} : { inspectorPort: options.inspectorPort }),
      workers: [
        {
          name: 'lab',
          modules: true,
          script: code.lab,
          compatibilityDate: '2026-09-08',
          durableObjects: { LAB: { className: 'LabState', useSQLite: true } },
          d1Databases: { DB: 'lab-test' },
          serviceBindings: {
            TODOFY: { name: 'todofy', entrypoint: 'Ops' },
            AI: { name: 'fake-ai', entrypoint: 'FakeAi' },
            ASSETS: () => new Response('<!doctype html><title>lab</title>', { headers: { 'content-type': 'text/html' } }),
          },
          bindings: { ...SYNTHETIC_BINDINGS, ...options.bindings },
          outboundService: (request: Request) => outbound(request),
        },
        { name: 'todofy', modules: true, script: code.todofy, compatibilityDate: '2026-09-08' },
        { name: 'fake-ai', modules: true, script: code.ai, compatibilityDate: '2026-09-08' },
        {
          name: 'probe',
          modules: true,
          compatibilityDate: '2026-09-08',
          durableObjects: { LAB: { className: 'LabState', scriptName: 'lab', useSQLite: true } },
          serviceBindings: { OPS: { name: 'lab', entrypoint: 'Ops' } },
          script: `export default { async fetch(request, env) {
            const { op, args } = await request.json()
            try {
              if (op === 'step') return Response.json({ ok: await env.LAB.get(env.LAB.idFromName('lab-v1')).step(args[0]) })
              if (op === 'alarm') return Response.json({ ok: await env.LAB.get(env.LAB.idFromName('lab-v1')).alarmAt() })
              return Response.json({ ok: await env.OPS[args[0]](...args.slice(1)) })
            } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'not_an_error' }) }
          } }`,
        },
      ],
    }),
  );
  await mf.ready;
  const db = await mf.getD1Database('DB', 'lab');
  for (const statement of await migrationStatements()) await db.prepare(statement).run();

  const fetchLab = (path: string, init?: RequestInit) => mf.dispatchFetch(`http://127.0.0.1${path}`, init as never) as unknown as Promise<Response>;
  const probe = async (op: string, args: unknown[]) => {
    const worker = await mf.getWorker('probe');
    const response = await worker.fetch('http://probe/', { method: 'POST', body: JSON.stringify({ op, args }) });
    return (await response.json()) as { ok?: unknown; error?: string };
  };
  const harness: Harness = {
    mf,
    arxiv,
    requests,
    fetch: fetchLab,
    async get<T>(path: string) {
      const response = await fetchLab(path);
      if (response.status !== 200) throw new Error(`GET ${path}: ${String(response.status)} ${await response.text()}`);
      return (await response.json()) as T;
    },
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the answer's shape
    async mutate<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown) {
      const csrf = await fetchLab('/api/csrf');
      const { token } = (await csrf.json()) as { token: string };
      const cookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const response = await fetchLab(path, {
        method,
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1', 'x-csrf-token': token, cookie },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as T };
    },
    async step(now: number) {
      const result = await probe('step', [now]);
      if (result.error !== undefined) throw new Error(`step: ${result.error}`);
      return result.ok as { next: number };
    },
    async alarmAt() {
      const result = await probe('alarm', []);
      if (result.error !== undefined) throw new Error(`alarm: ${result.error}`);
      return result.ok as number | null;
    },
    async run(now: number, max = 60) {
      // Like the alarm: each slice runs at the time the previous one asked for, while that is within a minute.
      let at = now;
      for (let steps = 0; steps < max; steps++) {
        const { next } = await harness.step(at);
        if (next - at > 60_000) return at;
        at = Math.max(at, next);
      }
      throw new Error(`pipeline still busy after ${String(max)} slices`);
    },
    ops: (method, ...args) => probe('ops', [method, ...args]),
    async todofy(scenario) {
      const response = await (await mf.getWorker('todofy')).fetch('http://stub/__scenario', { method: 'POST', body: JSON.stringify(scenario) });
      if (response.status !== 204) throw new Error('todofy scenario');
    },
    async todofyState() {
      const response = await (await mf.getWorker('todofy')).fetch('http://stub/__state');
      return (await response.json()) as Awaited<ReturnType<Harness['todofyState']>>;
    },
    async ai(scenario) {
      const response = await (await mf.getWorker('fake-ai')).fetch('http://stub/__scenario', { method: 'POST', body: JSON.stringify(scenario) });
      if (response.status !== 204) throw new Error('ai scenario');
    },
    async aiCalls() {
      const response = await (await mf.getWorker('fake-ai')).fetch('http://stub/__calls');
      return (await response.json()) as { model: string; count: number }[];
    },
    async sql<T>(query: string, ...params: unknown[]) {
      const { results } = await db.prepare(query).bind(...params).all();
      return results as T[];
    },
    async dispose() {
      await mf.dispose();
      await rm(temp, { recursive: true, force: true });
    },
  };
  return harness;
}

/** A fresh UUID v4 for an op_id. */
export function op(): string {
  return crypto.randomUUID();
}
