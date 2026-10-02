/**
 * workerd harness (../../../docs/design.md "Tests"): bundles src/index.ts with esbuild and runs it in Miniflare as
 * the Worker "flowday" with a real D1 database (../../../migrations applied), a fake ASSETS binding and an outbound
 * handler that plays the Todoist Sync API (FakeTodoist). The dev bypass signs the owner in over loopback http.
 * Store-level tests use the same D1 database from Node through Miniflare's binding proxy (harness.db()).
 * All data is synthetic; nothing leaves the process.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlowDayUiService } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { createHttpClient, RpcStatusError, type HttpCall, type HttpClient } from '@ziyixi/proto/http-client';
import type { ShapeOf } from '@ziyixi/proto/http-transcoder';
import type { Status } from '@ziyixi/proto/rpc-status';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { importCredentialKey, sealCredential } from '../../src/credentials.ts';
import { Meter, openDb, type Db } from '../../src/db.ts';
import { setSetting } from '../../src/store/settings.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP = resolve(ROOT, '..');

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'b'.repeat(64),
  BUILD_SHA: 'test',
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: '',
  CSRF_SIGNING_KEY: 'cd'.repeat(32),
  CREDENTIAL_KEY: 'ef'.repeat(32),
  DEV_AUTH_BYPASS: 'true',
};

/** Stores a Todoist key the way Settings does: sealed under the synthetic CREDENTIAL_KEY. */
export async function storeTodoistKey(db: Db, token: string): Promise<void> {
  const key = await importCredentialKey(SYNTHETIC_BINDINGS['CREDENTIAL_KEY']);
  if (key === null) throw new Error('no synthetic credential key');
  await setSetting(db, 'todoist_api_key', await sealCredential(key, 'todoist_api_key', token));
}

export const TABLES = ['flow_task_notes', 'completed_flow_tasks', 'flow_tasks', 'time_entries', 'tasks', 'settings', 'active_timer_session'] as const;

/** The page the fake ASSETS serves at /: two inline scripts (hashed into the CSP) and one external script. */
export const TEST_PAGE =
  '<!doctype html><html><head><script>window.a=1</script><script src="/_next/static/chunks/app.js"></script></head>' +
  '<body><script>self.__next_f=[]</script></body></html>';

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

// ---- the fake Todoist Sync API -------------------------------------------------------------------------------------

export interface FakeItem {
  id: string;
  content: string;
  description?: string;
  project_id: string;
  priority?: number;
  labels?: string[];
  due?: { date: string } | null;
  duration?: { amount: number; unit: string } | null;
  added_at?: string;
  completed_at?: string | null;
  checked?: boolean;
  is_deleted?: boolean;
}

export interface FakeProject {
  id: string;
  name: string;
  color: string;
  is_deleted?: boolean;
  is_archived?: boolean;
}

export interface TodoistRequest {
  url: string;
  method: string;
  authorization: string | null;
  /** The form fields of the request body. */
  form: Record<string, string>;
}

/**
 * A Todoist account with a revision counter: every change bumps it, the sync token is the revision, and an
 * incremental read returns the items and projects changed after the token's revision (completed and deleted ones
 * flagged). A full read ("*") returns every active item and every project.
 */
export class FakeTodoist {
  revision = 1;
  status = 200;
  /** When set, the next answers are full syncs even for a stored token (Todoist resets tokens sometimes). */
  forceFull = false;
  readonly requests: TodoistRequest[] = [];
  private readonly items = new Map<string, { item: FakeItem; revision: number }>();
  private readonly projects = new Map<string, { project: FakeProject; revision: number }>();

  setProjects(projects: FakeProject[]): void {
    this.revision += 1;
    for (const project of projects) this.projects.set(project.id, { project: { ...project }, revision: this.revision });
  }

  setItems(items: FakeItem[]): void {
    this.revision += 1;
    for (const item of items) this.items.set(item.id, { item: { ...item }, revision: this.revision });
  }

  update(id: string, patch: Partial<FakeItem>): void {
    const current = this.items.get(id);
    if (current === undefined) throw new Error(`no fake item ${id}`);
    this.revision += 1;
    this.items.set(id, { item: { ...current.item, ...patch }, revision: this.revision });
  }

  complete(id: string): void {
    this.update(id, { checked: true, completed_at: '2026-04-13T12:00:00.000000Z' });
  }

  remove(id: string): void {
    this.update(id, { is_deleted: true });
  }

  /**
   * Archives or unarchives a project. Only the project is reported as changed (its items are not), the least
   * helpful way Todoist may report it; a full read leaves out archived projects and their items.
   */
  archiveProject(id: string, archived = true): void {
    const current = this.projects.get(id);
    if (current === undefined) throw new Error(`no fake project ${id}`);
    this.revision += 1;
    this.projects.set(id, { project: { ...current.project, is_archived: archived }, revision: this.revision });
  }

  /** Ids of the items Todoist lists as active (neither completed nor deleted). */
  activeIds(): string[] {
    return [...this.items.values()].filter(({ item }) => item.checked !== true && item.is_deleted !== true).map(({ item }) => item.id);
  }

  /** A fetch that answers like Todoist's Sync API (for runSync called from Node). */
  readonly fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    return this.answer(request, await request.text());
  };

  answer(request: Request, body: string): Response {
    const form = Object.fromEntries(new URLSearchParams(body));
    this.requests.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization'), form });
    if (this.status !== 200) return new Response('{"error":"synthetic"}', { status: this.status });
    const token = form['sync_token'] ?? '*';
    const full = token === '*' || this.forceFull;
    const since = full ? 0 : Number(token);
    const archived = new Set([...this.projects.values()].filter(({ project }) => project.is_archived === true).map(({ project }) => project.id));
    // Every field of a Todoist API v1 item, so the answer has a real answer's size and parse cost.
    const items = [...this.items.values()]
      .filter(({ item, revision }) =>
        full ? item.checked !== true && item.is_deleted !== true && !archived.has(item.project_id) : revision > since,
      )
      .map(({ item }, index) => ({
        user_id: '2671355',
        section_id: index % 3 === 0 ? `s-${item.project_id}` : null,
        parent_id: null,
        added_by_uid: '2671355',
        assigned_by_uid: null,
        responsible_uid: null,
        description: '',
        priority: 1,
        labels: [],
        due: null,
        deadline: null,
        duration: null,
        child_order: index,
        day_order: -1,
        is_collapsed: false,
        note_count: 0,
        added_at: '2026-04-01T00:00:00.000000Z',
        updated_at: '2026-04-02T08:15:30.000000Z',
        completed_at: null,
        checked: false,
        is_deleted: false,
        ...item,
        ...(item.due ? { due: { timezone: null, string: 'every weekday', lang: 'en', is_recurring: false, ...item.due } } : {}),
      }));
    const projects = [...this.projects.values()]
      .filter(({ project, revision }) => (full ? project.is_deleted !== true && project.is_archived !== true : revision > since))
      .map(({ project }) => ({ is_deleted: false, is_archived: false, ...project }));
    return Response.json({ sync_token: String(this.revision), full_sync: full, items, projects, user: {} });
  }
}

// ---- the harness -------------------------------------------------------------------------------------------------------

/** FlowDayUiService's typed client (proto/ts/http-client.ts), as the UI calls it. */
export type Api = HttpClient<ShapeOf<typeof FlowDayUiService>>;

/** What one owner API call did: its answer or its google.rpc.Status, and the D1 rows it wrote. */
export interface Call<T> {
  readonly value: T | undefined;
  readonly status: Status | undefined;
  readonly rowsWritten: number;
}

export interface Harness {
  readonly mf: Miniflare;
  /** The Worker's log lines (console output), kept instead of printed; warnings and errors are also printed. */
  readonly logs: string[];
  readonly todoist: FakeTodoist;
  /** A request to "flowday" over loopback http (the dev bypass signs the owner in). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** JSON of a GET, asserting 200. */
  get<T>(path: string): Promise<T>;
  /** A mutation with a fresh CSRF token and the loopback Origin: status, JSON and the D1 rows it wrote. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the answer's shape
  mutate<T = unknown>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: T; rowsWritten: number }>;
  /** The owner API through the shared client: GETs as they are, mutations with the CSRF token and the loopback Origin. */
  readonly api: Api;
  /** Runs one owner API call: its answer, or its Status when it failed, and the D1 rows it wrote. */
  call<T>(run: (api: Api) => Promise<T>): Promise<Call<T>>;
  /** The drizzle Db over the same D1 database, metered by `meter`. */
  db(meter?: Meter): Db;
  /** The D1 binding itself (Miniflare's proxy from Node). */
  readonly binding: D1Database;
  sql<T>(query: string, ...params: unknown[]): Promise<T[]>;
  /** Deletes every row of every table and resets the fake Todoist. */
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
  const temp = await mkdtemp(join(tmpdir(), 'flowday-runtime-'));
  const script = await workerBundle();
  let todoist = new FakeTodoist();
  const outbound = async (request: Request): Promise<Response> => {
    const extra = options.routes?.get(request.url);
    if (extra) return extra();
    if (request.url === 'https://api.todoist.com/api/v1/sync') return todoist.answer(request, await request.text());
    return new Response('no outbound fetch expected', { status: 599 });
  };
  const assets = (request: Request): Response => {
    const { pathname } = new URL(request.url);
    if (pathname === '/' || pathname === '/index.html') return new Response(TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (pathname === '/pwa/sw.js') return new Response('self.addEventListener("fetch", () => {});', { headers: { 'content-type': 'text/javascript' } });
    if (pathname === '/pwa/manifest.webmanifest') return new Response('{"name":"FlowDay"}', { headers: { 'content-type': 'application/octet-stream' } });
    if (pathname.startsWith('/pwa/') || pathname.startsWith('/_next/static/')) return new Response('asset', { headers: { 'content-type': 'application/octet-stream' } });
    return new Response(TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
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
          name: 'flowday',
          modules: true,
          script,
          compatibilityDate: '2026-09-08',
          d1Databases: { DB: 'flowday-test' },
          serviceBindings: { ASSETS: (request: Request) => assets(request) },
          bindings: { ...SYNTHETIC_BINDINGS, ...options.bindings },
          outboundService: (request: Request) => outbound(request),
        },
      ],
    }),
  );
  await mf.ready;
  const binding = await mf.getD1Database('DB', 'flowday');
  for (const statement of await migrationStatements()) await binding.prepare(statement).run();

  const fetchFlowday = (path: string, init?: RequestInit) =>
    mf.dispatchFetch(`http://127.0.0.1${path}`, init as never) as unknown as Promise<Response>;
  let csrf: { token: string; cookie: string } | null = null;
  const csrfHeaders = async (): Promise<Record<string, string>> => {
    if (csrf === null) {
      const response = await fetchFlowday('/api/csrf');
      const { token } = await response.json<{ token: string }>();
      csrf = { token, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
    }
    return { origin: 'http://127.0.0.1', 'x-csrf-token': csrf.token, cookie: csrf.cookie };
  };
  let lastRowsWritten = Number.NaN;
  const send = async (call: HttpCall): Promise<Response> => {
    const headers: Record<string, string> = call.httpMethod === 'GET' ? {} : await csrfHeaders();
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetchFlowday(call.url, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) });
    lastRowsWritten = Number(response.headers.get('x-flowday-rows-written') ?? 'NaN');
    return response;
  };
  const api: Api = createHttpClient(FlowDayUiService, send);
  const harness: Harness = {
    api,
    async call<T>(run: (client: Api) => Promise<T>): Promise<Call<T>> {
      lastRowsWritten = Number.NaN;
      try {
        const value = await run(api);
        return { value, status: undefined, rowsWritten: lastRowsWritten };
      } catch (error) {
        if (error instanceof RpcStatusError) return { value: undefined, status: error.status, rowsWritten: lastRowsWritten };
        throw error;
      }
    },
    mf,
    logs,
    binding,
    get todoist() {
      return todoist;
    },
    fetch: fetchFlowday,
    async get<T>(path: string) {
      const response = await fetchFlowday(path);
      if (response.status !== 200) throw new Error(`GET ${path}: ${String(response.status)} ${await response.text()}`);
      return (await response.json()) as T;
    },
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the answer's shape
    async mutate<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
      const response = await fetchFlowday(path, {
        method,
        headers: { 'content-type': 'application/json', ...(await csrfHeaders()) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json()) as T,
        rowsWritten: Number(response.headers.get('x-flowday-rows-written') ?? 'NaN'),
      };
    },
    db(meter = new Meter()) {
      return openDb(binding, meter);
    },
    async sql<T>(query: string, ...params: unknown[]) {
      const { results } = await binding.prepare(query).bind(...params).all();
      return results as T[];
    },
    async reset() {
      await binding.batch(TABLES.map((table) => binding.prepare(`DELETE FROM ${table}`)));
      todoist = new FakeTodoist();
    },
    async dispose() {
      await mf.dispose();
      await rm(temp, { recursive: true, force: true });
    },
  };
  return harness;
}
