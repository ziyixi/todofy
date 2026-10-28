/**
 * workerd harness (../../../docs/design.md §11): bundles src/index.ts with esbuild and runs it in Miniflare as the Worker
 * "mailsort" with a real SQLite MailsortState, next to
 *   - "probe": calls MailsortState.step(now), tick(now), setClock(now), alarmAt(), sqlForTests() and kvForTests() over the
 *     object binding, and the named entrypoint Ops of "mailsort" over a service binding (ops-v1, as the dashboard does);
 *   - the outbound service: every request the Worker makes goes to FakeUpstream (../fakes/upstream.ts), the fake Gmail
 *     and Google token endpoint, in this Node process; nothing leaves it. MODEL_ROUTER is bound to the same fake.
 * DEV_MANUAL_ALARMS=true: no alarm is ever armed and the tests drive the passes with explicit clocks; the owner is
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
import { MailsortUiService } from '@ziyixi/proto/mailsort/ui/v2/mailsort_ui_service_pb';
import { FakeUpstream } from '../fakes/upstream.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const ORIGIN = 'http://127.0.0.1';
export const OBJECT_WORKER = 'mailsort-object';
export const PUBLIC_HOST = 'sort.example.com';
/** 2026-10-01T00:00:00Z: the tests' first clock. */
export const T0 = Date.parse('2026-10-01T00:00:00Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const REFRESH_TOKEN = 'synthetic-refresh-token';
export const SCOPE_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
export const SCOPE_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

export const SYNTHETIC_BINDINGS: Readonly<Record<string, string>> = {
  PUBLIC_HOST,
  ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'b'.repeat(64),
  BUILD_SHA: 'test',
  MODE: 'live',
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: '',
  DEV_AUTH_BYPASS: 'true',
  DEV_MANUAL_ALARMS: 'true',
  // Any loopback origin: the outbound service answers every request, whatever its address.
  DEV_FAKE_UPSTREAM: 'http://127.0.0.1:9',
  GMAIL_CLIENT_ID: 'synthetic-client.apps.example.com',
  GMAIL_CLIENT_SECRET: 'synthetic-secret',
  GMAIL_REFRESH_TOKEN: REFRESH_TOKEN,
};

export const TEST_PAGE = '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="app"></div></body></html>';

const bundles = new Map<string, Promise<string>>();
export function workerBundle(entry = 'src/index.ts'): Promise<string> {
  const cached = bundles.get(entry);
  if (cached !== undefined) return cached;
  const bundle = build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    loader: { '.txt': 'text' },
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
  bundles.set(entry, bundle);
  return bundle;
}

export interface HarnessOptions {
  readonly bindings?: Record<string, string | undefined>;
  /** Extra outbound routes by URL (the Access certs endpoint), before the fakes. */
  readonly routes?: Map<string, () => Response>;
  readonly inspectorPort?: number;
  /** Runs MailsortState in a Worker of its own, as Cloudflare runs a Durable Object apart from its caller. */
  readonly splitObject?: boolean;
  /** `none` leaves the settings row unwritten (the Codex default); otherwise the owner chose Claude. */
  readonly provider?: 'claude' | 'none';
  /** Binds the daily backup's bucket (BACKUPS); unbound, so no backup runs, by default. */
  readonly backups?: boolean;
}

export type StepResult = { next: number; mode?: string; synced?: number; decided?: number; applied?: number; deferred?: number; code: string };

export interface Harness {
  readonly mf: Miniflare;
  readonly up: FakeUpstream;
  readonly logs: string[];
  opsStatus(): Promise<Record<string, unknown>>;
  opsSetGuard(input: unknown): Promise<unknown>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  readonly api: HttpClient<ShapeOf<typeof MailsortUiService>>;
  mutate(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Response>;
  clock(now: number): Promise<void>;
  step(now: number): Promise<StepResult>;
  /** What an alarm at `now` does: a restore or backup step, or a pass when one is due. */
  tick(now: number): Promise<StepResult>;
  kv(key: string): Promise<unknown>;
  /** What an alarm at `now` does in the object named `name`; and whether a pass ran there. */
  tickOf(name: string, now: number): Promise<{ result: StepResult; passed: boolean }>;
  /** wrangler's `--persist-to` for this Miniflare's local R2 (tools/backup-restore.ts). */
  readonly persistTo: string;
  sql<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): Promise<T[]>;
  rows(): Promise<{ read: number; written: number }>;
  dispose(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = await mkdtemp(join(tmpdir(), 'mailsort-runtime-'));
  const script = await workerBundle();
  const up = new FakeUpstream();
  up.gmail.grants.set(REFRESH_TOKEN, SCOPE_MODIFY);
  up.gmail.clock = () => T0;
  const logs: string[] = [];
  const outbound = async (request: Request) => options.routes?.get(request.url)?.() ?? up.handle(request);
  const bindings = Object.fromEntries(Object.entries({ ...SYNTHETIC_BINDINGS, ...options.bindings }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const mailsort = (name: string, split: boolean) => ({
    name,
    modules: true,
    script,
    compatibilityDate: '2026-09-08',
    durableObjects: { MAILSORT: { className: 'MailsortState', useSQLite: true, ...(split ? { scriptName: OBJECT_WORKER } : {}) } },
    ...(options.backups === true ? { r2Buckets: { BACKUPS: 'mailsort-backups' } } : {}),
    serviceBindings: {
      ASSETS: () => new Response(TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      MODEL_ROUTER: (request: Request) => up.handle(request),
    },
    bindings,
    outboundService: outbound,
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      handleStructuredLogs: ({ level, message }) => {
        logs.push(message);
        if (level === 'warn' || level === 'error') process.stderr.write(`${message}\n`);
      },
      host: '127.0.0.1',
      port: 0,
      // wrangler's own layout, so `--local --persist-to <temp>` reads the same R2 (tools/backup-restore.ts).
      resourcePersistencePath: join(temp, 'v3'),
      ...(options.inspectorPort === undefined ? {} : { inspectorPort: options.inspectorPort }),
      workers: [
        mailsort('mailsort', options.splitObject === true),
        ...(options.splitObject === true ? [{ ...mailsort(OBJECT_WORKER, false) }] : []),
        {
          name: 'probe',
          modules: true,
          compatibilityDate: '2026-09-08',
          durableObjects: { MAILSORT: { className: 'MailsortState', scriptName: options.splitObject === true ? OBJECT_WORKER : 'mailsort', useSQLite: true } },
          // The dashboard's view: the named entrypoint Ops of "mailsort" (ops-v1), as dashboard/wrangler.toml binds it.
          serviceBindings: { OPS: { name: 'mailsort', entrypoint: 'Ops' } },
          script: `export default { async fetch(request, env) {
            const { op, args } = await request.json()
            const stub = env.MAILSORT.get(env.MAILSORT.idFromName('mailsort-v1'))
            try {
              if (op === 'step') return Response.json({ ok: await stub.step(args[0]) })
              if (op === 'tick') return Response.json({ ok: await stub.tick(args[0]) })
              if (op === 'kv') return Response.json({ ok: await stub.kvForTests(args[0]) })
              if (op === 'tick_of') {
                const other = env.MAILSORT.get(env.MAILSORT.idFromName(args[0]))
                const result = await other.tick(args[1])
                return Response.json({ ok: { result, rows: await other.sqlForTests("SELECT count(*) AS n FROM meta WHERE key = 'last_alarm_at'") } })
              }
              if (op === 'clock') return Response.json({ ok: await stub.setClock(args[0]) ?? null })
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
  up.plannedPaths = async () => ((await probe('sql', ['SELECT display_name FROM labels'])) as { display_name: string }[]).map((row) => row.display_name);
  up.priorityDeletes = async () => {
    const rows = await probe('sql', ["SELECT value FROM meta WHERE key = 'priority_setup'"]) as { value: string }[];
    const setup = JSON.parse(rows[0]?.value ?? 'null') as { remaining?: unknown } | null;
    return Array.isArray(setup?.remaining) ? setup.remaining.filter((id): id is string => typeof id === 'string') : [];
  };
  up.ledgerRows = async (messageId) => {
    const priorities = await probe('sql', ["SELECT gmail_id FROM labels WHERE id IN ('p1', 'p2', 'p3', 'p4') AND gmail_id IS NOT NULL"]) as { gmail_id: string }[];
    const ids = new Set(priorities.map(row => row.gmail_id));
    const rows = await probe('sql', ['SELECT gmail_label_id, state, archived, base_labels, base_inbox FROM ledger WHERE message_id = ?', messageId]) as { gmail_label_id: string; state: string; archived: number; base_labels: string; base_inbox: number }[];
    return rows.map(row => ({ labelId: row.gmail_label_id, state: row.state, archived: row.archived === 1, baseInbox: row.base_inbox === 1, replaceLabels: (JSON.parse(row.base_labels) as string[]).filter(id => id !== row.gmail_label_id && ids.has(id)) }));
  };
  const fetchSort = (path: string, init?: RequestInit) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init } as never) as unknown as Promise<Response>;
  const send = async (call: HttpCall) => {
    const headers: Record<string, string> = {};
    if (call.httpMethod !== 'GET') {
      Object.assign(headers, { origin: ORIGIN, 'x-csrf-token': '1', 'content-type': 'application/json' });
    }
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    return fetchSort(call.url, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) });
  };
  const harness: Harness = {
    mf,
    up,
    logs,
    fetch: fetchSort,
    opsStatus: async () => (await probe('ops_status', [])) as Record<string, unknown>,
    opsSetGuard: (input) => probe('ops_guard', [input]),
    api: createHttpClient(MailsortUiService, send),
    async mutate(method, path, body) {
      const headers: Record<string, string> = { origin: ORIGIN, 'x-csrf-token': '1', 'content-type': 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      return fetchSort(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    async clock(now) {
      up.gmail.clock = () => now;
      await probe('clock', [now]);
    },
    async step(now) {
      up.gmail.clock = () => now;
      return (await probe('step', [now])) as StepResult;
    },
    async tick(now) {
      up.gmail.clock = () => now;
      return (await probe('tick', [now])) as StepResult;
    },
    kv: (key) => probe('kv', [key]),
    async tickOf(name, now) {
      const answer = (await probe('tick_of', [name, now])) as { result: StepResult; rows: { n: number }[] };
      return { result: answer.result, passed: answer.rows[0]?.n === 1 };
    },
    persistTo: temp,
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
  // Most suites exercise the owner's explicit Claude choice; Codex suites select it through the API.
  if (options.provider !== 'none') await harness.sql(`INSERT INTO meta (key, value) VALUES ('settings', ?)`, JSON.stringify({ classificationProvider: 'claude', classificationIntervalMinutes: 15 }));
  return harness;
}

/** A fresh AIP-155 request ID. */
export function op(): string {
  return crypto.randomUUID();
}

/** The ErrorInfo reason of a thrown RpcStatusError. */
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
