import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let script: Promise<string> | undefined;
function bundle() {
  script ??= build({
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
  }).then((r) => {
    const output = r.outputFiles[0];
    if (!output) throw new Error('Missing bundle');
    return output.text;
  });
  return script;
}
const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};
async function asset(request: Request): Promise<Response> {
  const root = resolve(ROOT, '../web/dist');
  const candidate = resolve(root, `.${new URL(request.url).pathname}`);
  if (!candidate.startsWith(`${root}/`) && candidate !== root) return new Response(null, { status: 404 });
  try {
    return new Response(await readFile(candidate), {
      headers: {
        'content-type': mime[extname(candidate)] ?? 'application/octet-stream',
      },
    });
  } catch {
    try {
      return new Response(await readFile(join(root, 'index.html')), {
        headers: { 'content-type': 'text/html' },
      });
    } catch {
      return new Response('Synthetic Tasks assets', {
        headers: { 'content-type': 'text/plain' },
      });
    }
  }
}
export async function startHarness(
  options: { port?: number; bypass?: boolean; inspectorPort?: number; jwks?: unknown; ownerToken?: string; planning?: (request: Request) => Promise<Response> } = {},
) {
  const temp = await mkdtemp(join(tmpdir(), 'tasks-d1-'));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: options.port ?? 0,
      resourcePersistencePath: temp,
      ...(options.inspectorPort === undefined ? {} : { inspectorPort: options.inspectorPort }),
      workers: [
        {
          name: 'tasks',
          modules: true,
          script: await bundle(),
          compatibilityDate: '2026-09-08',
          d1Databases: { DB: 'tasks-test' },
          serviceBindings: { ASSETS: asset, ...(options.planning ? { PLANNING: options.planning } : {}) },
          bindings: {
            PUBLIC_HOST: 'tasks.example.test',
            TIME_ZONE: 'America/Los_Angeles',
            ACCESS_OWNER: 'owner@example.test',
            ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
            ACCESS_AUDIENCE: 'b'.repeat(64),
            CSRF_SIGNING_KEY: 'cd'.repeat(32),
            DEV_AUTH_BYPASS: options.bypass === false ? 'false' : 'true',
          },
          outboundService: (request: Request) =>
            options.jwks && request.url === 'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs'
              ? Response.json(options.jwks)
              : new Response('No external requests allowed', { status: 599 }),
        },
        {
          name: 'tasks-ops',
          modules: true,
          compatibilityDate: '2026-09-08',
          script: `export default {async fetch(request,env){try{return Response.json(await (new URL(request.url).pathname==='/guard'?env.OPS.setGuard({level:'shed'}):env.OPS.status()));}catch(error){return Response.json({error:error.message},{status:400});}}}`,
          serviceBindings: { OPS: { name: 'tasks', entrypoint: 'Ops' } },
        },
        ...['read-write', 'read', 'unknown'].map((access) => ({
          name: `tasks-${access}`,
          modules: true,
          compatibilityDate: '2026-09-08',
          script: `export default {async fetch(request,env){const path=new URL(request.url).pathname;if(path==='/rpc'){const data=await request.json();return Response.json(await env.TASKS.call(data.method,data.body));}if(path==='/backup')return Response.json(await env.TASKS.exportBackup(await request.text()));return env.TASKS.fetch(request);}}`,
          serviceBindings: { TASKS: { name: 'tasks', entrypoint: 'TasksApi', props: { access } } },
        })),
      ],
    }),
  );
  const url = await mf.ready;
  const db = await mf.getD1Database('DB', 'tasks');
  const migrations = resolve(ROOT, '../migrations');
  // wrangler's own record of the applied migrations, which the backup plan reads.
  await db
    .prepare(
      'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    )
    .run();
  for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(join(migrations, file), 'utf8')).replace(/--[^\n]*/g, '');
    // A seed INSERT starts its own line; the INSERTs in trigger bodies are indented and stay in their trigger.
    for (const statement of sql.split(/;\s*(?=(?:ALTER|CREATE|DROP|PRAGMA)\b)|;\s*\n(?=INSERT\b)/i))
      if (statement.trim()) await db.prepare(statement).run();
    await db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(file).run();
  }
  const fetch = (path: string, init?: RequestInit) =>
    mf.dispatchFetch(new URL(path, url).href, {
      ...init,
      headers: {
        ...(options.ownerToken ? { 'cf-access-jwt-assertion': options.ownerToken } : {}),
        ...Object.fromEntries(new Headers(init?.headers).entries()),
      },
    } as never) as unknown as Promise<Response>;
  let csrf: { token: string; cookie: string } | undefined;
  async function mutate(method: string, path: string, body?: unknown) {
    if (!csrf) {
      const response = await fetch('/api/tasks/csrf');
      const data = await response.json<{ token: string }>();
      csrf = {
        token: data.token,
        cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      };
    }
    return fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: url.origin,
        'x-csrf-token': csrf.token,
        cookie: csrf.cookie,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  return {
    mf,
    db,
    url,
    fetch,
    mutate,
    async dispose() {
      await mf.dispose();
      await rm(temp, { recursive: true, force: true });
    },
  };
}
export type Harness = Awaited<ReturnType<typeof startHarness>>;

/** The receipt hash releases before the wire form stored: SHA-256 of the decoded input object's JSON. */
export async function objectReceiptHash(method: string, input: unknown): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([method, input]))),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** D1's own row metrics, including first() and each statement executed by batch(). */
export function measuredReads(binding: D1Database) {
  const metrics = { statements: 0, rowsRead: 0, rowsWritten: 0 };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function record<T>(result: D1Result<T>): D1Result<T> {
    metrics.statements++;
    metrics.rowsRead += result.meta.rows_read;
    metrics.rowsWritten += result.meta.rows_written;
    return result;
  }
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    const counted = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async <T>() => record(await statement.all<T>()),
      first: async <T>(column?: string) => {
        const result = record(await statement.all());
        const row = result.results[0];
        return (column ? (row?.[column] ?? null) : (row ?? null)) as T | null;
      },
    } as unknown as D1PreparedStatement;
    originals.set(counted, statement);
    return counted;
  }
  const db = {
    prepare: (sql: string) => wrap(binding.prepare(sql)),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const results = await binding.batch<T>(
        statements.map((statement) => originals.get(statement) ?? statement),
      );
      return results.map(record);
    },
  } as unknown as D1Database;
  return { db, metrics };
}
