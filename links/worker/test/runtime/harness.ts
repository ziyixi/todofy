/**
 * workerd harness (../../../docs/design.md §9): bundles src/index.ts with esbuild and runs it in Miniflare as the Worker
 * "links" with a real D1 database (../../../migrations applied and recorded in d1_migrations, as wrangler does), a fake
 * ASSETS binding (the launcher's page at /_/), the backup's LinksBackup object (BACKUP_ALARM, as in production) and on
 * request the backup bucket BACKUPS, the Worker "links-ops" that calls the Ops entrypoint as Home's binding does, the
 * Worker "links-alarm" that calls the object's arm(), and an outbound handler for extra routes (a synthetic Access
 * issuer's keys). With the dev bypass (the default) the
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
    ...(process.env.TEST_SRCDIR ? { nodePaths: [`${process.cwd()}/node_modules`] } : {}),
    entryPoints: [join(ROOT, 'src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2024',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'import'],
    external: ['cloudflare:*'],
    write: false,
    logLevel: 'silent',
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw new Error('esbuild produced no output');
    return output.text;
  });
  return bundle;
}

/** The D1 migration files, in the order wrangler applies them. */
export async function migrationFiles(): Promise<string[]> {
  return (await readdir(join(APP, 'migrations'))).filter((file) => file.endsWith('.sql')).sort();
}

/** The D1 migrations as single statements (comments removed). */
export async function migrationStatements(): Promise<string[]> {
  const dir = join(APP, 'migrations');
  const out: string[] = [];
  for (const file of await migrationFiles()) {
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
  /** The directory `wrangler ... --local --persist-to` reads the same D1 and R2 from (tools/backup-restore.ts). */
  readonly persistTo: string;
  /** LinksBackup.arm(due) on the one object backup-v1: when its Alarm fires. */
  arm(due?: boolean): Promise<number>;
  /** Waits until the object's Alarm has run `count` times in all (its one log line each), then answers that line. */
  alarmRun(count: number): Promise<{ step: string; next: number | null; error?: string }>;
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
  /** Binds the daily backup's bucket (BACKUPS); unbound, so no backup runs, by default. */
  readonly backups?: boolean;
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
      // wrangler's own layout, so `--local --persist-to <persistTo>` reads the same D1 and R2.
      resourcePersistencePath: join(temp, 'v3'),
      ...(options.inspectorPort === undefined ? {} : { inspectorPort: options.inspectorPort }),
      workers: [
        {
          name: 'links',
          modules: true,
          script,
          compatibilityDate: '2026-09-08',
          d1Databases: { DB: 'links-test' },
          durableObjects: { BACKUP_ALARM: { className: 'LinksBackup', useSQLite: true } },
          ...(options.backups ? { r2Buckets: { BACKUPS: 'links-backups' } } : {}),
          serviceBindings: { ASSETS: (request: Request) => assets(request) },
          bindings: { ...SYNTHETIC_BINDINGS, ...options.bindings },
          outboundService: (request: Request) => outbound(request),
        },
        // Home's view: GET answers Ops.status(), POST /guard its setGuard (which refuses), through the entrypoint.
        {
          name: 'links-ops',
          modules: true,
          compatibilityDate: '2026-09-08',
          script: `export default {async fetch(request,env){try{return Response.json(await (new URL(request.url).pathname==='/guard'?env.OPS.setGuard({level:'shed'}):env.OPS.status()));}catch(error){return Response.json({error:error.message},{status:400});}}}`,
          serviceBindings: { OPS: { name: 'links', entrypoint: 'Ops' } },
        },
        // The backup's object, as the Worker reaches it: GET answers arm(), with ?due arm(true).
        {
          name: 'links-alarm',
          modules: true,
          compatibilityDate: '2026-09-08',
          script: `export default {async fetch(request,env){const stub=env.BACKUP_ALARM.get(env.BACKUP_ALARM.idFromName('backup-v1'));return Response.json(await stub.arm(new URL(request.url).searchParams.has('due')));}}`,
          durableObjects: { BACKUP_ALARM: { className: 'LinksBackup', scriptName: 'links', useSQLite: true } },
        },
      ],
    }),
  );
  await mf.ready;
  const db = await mf.getD1Database('DB', 'links');
  // wrangler's own record of the applied migrations, which the backup's plan reads.
  await db
    .prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)')
    .run();
  for (const statement of await migrationStatements()) await db.prepare(statement).run();
  for (const file of await migrationFiles()) await db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(file).run();

  const fetchLinks = (path: string, init?: RequestInit) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init } as never) as unknown as Promise<Response>;
  const json = async <T>(response: Response): Promise<Answer<T>> => {
    const text = await response.text();
    return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as T, headers: response.headers };
  };
  const alarmRuns = () => logs.flatMap((line) => (line.startsWith('{"backup":{"step"') ? [(JSON.parse(line) as { backup: { step: string; next: number | null; error?: string } }).backup] : []));
  return {
    mf,
    db,
    logs,
    assetRequests,
    persistTo: temp,
    async arm(due = false) {
      const worker = await mf.getWorker('links-alarm');
      return (await (await worker.fetch(`https://links-alarm.internal/${due ? '?due' : ''}`)).json()) as number;
    },
    async alarmRun(count: number) {
      for (let waited = 0; waited < 20_000; waited += 20) {
        const runs = alarmRuns();
        if (runs.length >= count) return runs[count - 1] as { step: string; next: number | null; error?: string };
        await new Promise((done) => setTimeout(done, 20));
      }
      throw new Error(`The backup's Alarm did not run ${String(count)} times`);
    },
    fetch: fetchLinks,
    async get<T>(path: string) {
      return json<T>(await fetchLinks(path));
    },
    async mutate<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
      const response = await fetchLinks(path, {
        method,
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-csrf-token': '1' },
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

/** D1's own row metrics of every statement run through the returned binding, batches included. */
export function measuredReads(binding: D1Database): { db: D1Database; metrics: { statements: number; rowsRead: number } } {
  const metrics = { statements: 0, rowsRead: 0 };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function record<T>(result: D1Result<T>): D1Result<T> {
    metrics.statements++;
    metrics.rowsRead += result.meta.rows_read;
    return result;
  }
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    const counted = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async <T>() => record(await statement.all<T>()),
    } as unknown as D1PreparedStatement;
    originals.set(counted, statement);
    return counted;
  }
  const db = {
    prepare: (sql: string) => wrap(binding.prepare(sql)),
    batch: async <T>(statements: D1PreparedStatement[]) =>
      (await binding.batch<T>(statements.map((statement) => originals.get(statement) ?? statement))).map(record),
  } as unknown as D1Database;
  return { db, metrics };
}
