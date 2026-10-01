/**
 * workerd harness (../../../docs/design.md §9): bundles src/index.ts with esbuild and runs it in Miniflare as the Worker
 * "links" with a real D1 database (../../../migrations applied), a fake ASSETS binding (the launcher's page at /_/)
 * and an outbound handler for extra routes (a synthetic Access issuer's keys). With the dev bypass (the default) the
 * owner is signed in over loopback http under /_/, and on a short link only a request carrying an Access token (any
 * CF_Authorization cookie: OWNER_COOKIE) is the owner. All data is synthetic; nothing leaves the process.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP = resolve(ROOT, '..');

export const ORIGIN = 'http://127.0.0.1';
export const OWNER_COOKIE = 'CF_Authorization=synthetic-dev-token';
export const PUBLIC_HOST = 's.example.com';

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  PUBLIC_HOST,
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'b'.repeat(64),
  BUILD_SHA: 'test',
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: '',
  CSRF_SIGNING_KEY: 'cd'.repeat(32),
  DEV_AUTH_BYPASS: 'true',
};

export const TABLES = ['links', 'link_revisions', 'request_log'] as const;

/** The page the fake ASSETS serves at /_/ (the real one is web/dist/_/index.html). */
export const TEST_PAGE = '<!doctype html><html><head><script type="module" src="/_/assets/app.js"></script></head><body><div id="app"></div></body></html>';

/** A fresh AIP-155 request ID. */
export function op(): string {
  return randomUUID();
}

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
    write: false,
    logLevel: 'silent',
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw new Error('esbuild produced no output');
    return output.text;
  });
  return bundle;
}

/** The D1 migrations as single statements (comments removed). */
export async function migrationStatements(): Promise<string[]> {
  const dir = join(APP, 'migrations');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
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

/** What one API call answered. */
export interface Answer<T> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export interface Harness {
  readonly mf: Miniflare;
  /** The same D1 database from Node (Miniflare's binding proxy), for store-level tests. */
  readonly db: D1Database;
  /** The Worker's log lines (console output), kept instead of printed; warnings and errors are also printed. */
  readonly logs: string[];
  /** Requests the fake ASSETS binding received (path only). */
  readonly assetRequests: string[];
  /** A request to "links" over loopback http. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** A JSON GET of the owner API, any status. */
  get<T = unknown>(path: string): Promise<Answer<T>>;
  /** A mutation with the CSRF token (fetched once) and the loopback Origin, any status. */
  mutate<T = unknown>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Answer<T>>;
  sql<T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]>;
  /** Every row of every table, for "nothing changed" checks. */
  snapshot(): Promise<string>;
  /** Deletes every row of every table. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  readonly bindings?: Record<string, string>;
  /** Extra outbound routes (e.g. the Access certs endpoint), by URL. */
  readonly routes?: Map<string, () => Response>;
  /** Opens workerd's DevTools inspector on this port (the CPU profile of ./cpu.test.ts). */
  readonly inspectorPort?: number;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = await mkdtemp(join(tmpdir(), 'links-runtime-'));
  const script = await workerBundle();
  const outbound = (request: Request): Response => options.routes?.get(request.url)?.() ?? new Response('no outbound fetch expected', { status: 599 });
  const assetRequests: string[] = [];
  const assets = (request: Request): Response => {
    const { pathname } = new URL(request.url);
    assetRequests.push(pathname);
    if (pathname === '/_/') return new Response(TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  };
  const logs: string[] = [];
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
          name: 'links',
          modules: true,
          script,
          compatibilityDate: '2026-09-08',
          d1Databases: { DB: 'links-test' },
          serviceBindings: { ASSETS: (request: Request) => assets(request) },
          bindings: { ...SYNTHETIC_BINDINGS, ...options.bindings },
          outboundService: (request: Request) => outbound(request),
        },
      ],
    }),
  );
  await mf.ready;
  const db = await mf.getD1Database('DB', 'links');
  for (const statement of await migrationStatements()) await db.prepare(statement).run();

  const fetchLinks = (path: string, init?: RequestInit) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init } as never) as unknown as Promise<Response>;
  const json = async <T>(response: Response): Promise<Answer<T>> => {
    const text = await response.text();
    return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as T, headers: response.headers };
  };
  let csrf: { token: string; cookie: string } | null = null;
  return {
    mf,
    db,
    logs,
    assetRequests,
    fetch: fetchLinks,
    async get<T>(path: string) {
      return json<T>(await fetchLinks(path));
    },
    async mutate<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
      if (csrf === null) {
        const response = await fetchLinks('/_/api/csrf');
        const { token } = await response.json<{ token: string }>();
        csrf = { token, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
      }
      const response = await fetchLinks(path, {
        method,
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-csrf-token': csrf.token, cookie: csrf.cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return json<T>(response);
    },
    async sql<T>(query: string, ...params: unknown[]) {
      const { results } = await db.prepare(query).bind(...params).all();
      return results as T[];
    },
    async snapshot() {
      const parts: string[] = [];
      for (const table of TABLES) parts.push(JSON.stringify((await db.prepare(`SELECT * FROM ${table}`).all()).results));
      return parts.join('\n');
    },
    async reset() {
      await db.batch(TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)));
    },
    async dispose() {
      await mf.dispose();
      await rm(temp, { recursive: true, force: true });
    },
  };
}

/** A link as the API writes it (wire JSON), for creating fixtures through the API. */
export interface WireLink {
  name?: string;
  target: string;
  path_mode?: string;
  visibility?: string;
  description?: string;
  tags?: string[];
  expire_time?: string;
  etag?: string;
  revision_id?: string;
  create_time?: string;
  delete_time?: string;
  purge_time?: string;
}

/** Creates a link through the API (asserting 200) and answers it. */
export async function createLink(h: Harness, key: string, link: WireLink): Promise<WireLink> {
  const answer = await h.mutate<WireLink>('POST', `/_/api/v1/links?link_id=${key}&request_id=${op()}`, link);
  if (answer.status !== 200) throw new Error(`create ${key}: ${String(answer.status)} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** The ErrorInfo reason of a Status body. */
export function reasonOf(body: unknown): string | undefined {
  const details = (body as { error?: { details?: { '@type': string; reason?: string }[] } }).error?.details ?? [];
  return details.find((detail) => detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')?.reason;
}
