/**
 * Helpers of the workerd flow tests: a Miniflare harness whose outbound fetch plays the GraphQL API
 * (with scriptable usage or failures) and the Access certs endpoint, owner API calls through the
 * loopback dev bypass at a pinned instant (DEV_NOW), and stub answers built from contract fixtures and
 * validated against the schema.
 *
 * Time never comes from the wall clock: cron ticks run at the instants a test passes to tick(), and owner
 * requests (views, refreshes, manual canary, guard override) at DEV_NOW, which is NOW unless a test's
 * bindings set another. The eslint config keeps Date.now() and an argument-less new Date() out of test/runtime.
 */
import { expect } from 'vitest';
import type { GuardState, OpsStatus } from '@ziyixi/proto/ops/v1/ops_wire';
import type { CanaryRun, CsrfResponse, OverallLevel, Usage, ViewId } from '../../src/api-types.ts';
import type { AppDetail, CloudflareView, OpsView } from '../../src/api-types.ts';
import { DESIRED } from '../../src/drift.ts';
import { fakeCloudflare, type LiveTweaks } from '../drift-fixture.ts';
import { graphqlBody, type SyntheticUsage } from '../graphql-fixture.ts';
import { contractErrors, type ContractName } from '../contract.ts';
import { expectWire, VIEW_SCHEMAS } from '../wire-conformance.ts';
import { fixture, startHarness, SYNTHETIC_BINDINGS, type Harness, type StubApp } from './harness.ts';

export const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
/**
 * The owner requests' instant (DEV_NOW) unless a test binds another: noon UTC, hours away from midnight and
 * from the canary hours most tests configure (16, the default, and 23), so a tick a few hours before it is on
 * the same UTC day and starts no scheduled canary.
 */
export const NOW = Date.parse('2026-10-01T12:00:00Z');
/** The registry's public_http probes by entry (the only public GETs the Worker makes; v2.test.ts keeps them in step). */
export const PROBES = {
  website: 'https://www.ziyixi.science/build-info.json',
  flowday: 'https://flowday.ziyixi.science/pwa/manifest.webmanifest',
  links: 'https://s.ziyixi.science/robots.txt',
} as const;
export const WEBSITE_PROBE = PROBES.website;

/** What each app's own Worker answers to its probe (synthetic bodies; only the status and the media type count). */
export function healthyProbe(entry: keyof typeof PROBES): Response {
  switch (entry) {
    case 'website':
      return Response.json({ build: 'synthetic' }, { headers: { 'cache-control': 'no-store' } });
    case 'flowday':
      return new Response('{"name":"FlowDay"}', { headers: { 'content-type': 'application/manifest+json' } });
    case 'links':
      return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

/** Every probe of `harness` answers as its healthy app would. */
export function answerProbes(harness: FlowHarness): void {
  for (const entry of Object.keys(PROBES) as (keyof typeof PROBES)[]) harness.routes.set(PROBES[entry], () => healthyProbe(entry));
}

/** The owner API's paths (DashboardUiService and the transport's CSRF route). */
export const PATHS = {
  registry: '/api/v1/registry',
  home: '/api/v1/homeView',
  flows: '/api/v1/flowsView',
  cloudflare: '/api/v1/cloudflareView',
  ops: '/api/v1/opsView',
  refreshHome: '/api/v1/homeView:refresh',
  refreshCloudflare: '/api/v1/cloudflareView:refresh',
  guard: '/api/v1/guard:override',
  canary: '/api/v1/canaries/mail-todofy:run',
  csrf: '/api/csrf',
} as const;

/** A view's answer: status, ETag and the parsed body (null for 304). */
export interface ViewAnswer<T> {
  readonly status: number;
  readonly etag: string | null;
  readonly body: T | null;
  readonly bytes: number;
}

/**
 * What the flow tests read, assembled from GetOpsView (guard, canary, digest, app details, the shared
 * shell) and GetCloudflareView (usage). `overall` is the attention strip as v1's banner
 * was: the digest's warning/critical items worst first, then the page-only info items, as {source,
 * code, severity}, with their level; `observed` lists the strip's observed items (tiles, stages,
 * Workers no digest item explains) apart, so the flow tests keep checking the unchanged item set.
 */
export interface Snapshot {
  readonly ops: OpsView;
  readonly overall: { readonly level: OverallLevel; readonly items: readonly { source: string; code: string; severity: string }[] };
  readonly observed: readonly { source: string; code: string; level: string }[];
  readonly apps: Readonly<Record<StubApp, AppDetail>>;
  readonly usage: Usage;
  readonly guard: OpsView['guard'];
  readonly canary: OpsView['canary'];
  readonly digest: OpsView['digest'];
  readonly refresh: OpsView['refresh'];
}

export interface Analytics {
  /** What the next GraphQL requests answer: usage numbers, or a Response (errors, statuses). */
  answer: SyntheticUsage | (() => Response);
  /** Every request's Authorization header and variables. */
  readonly requests: { authorization: string | null; variables: Record<string, string> }[];
}

/** The fake Cloudflare API of the drift check: the bundled desired state, changed by `tweaks`. */
export interface CloudflareApi {
  tweaks: LiveTweaks;
  /** Every drift request's URL and Authorization header. */
  readonly requests: { url: string; method: string; authorization: string | null }[];
}

export interface FlowHarness extends Harness {
  readonly analytics: Analytics;
  readonly cloudflare: CloudflareApi;
  /** Extra outbound answers (e.g. the Access certs) by exact URL. */
  readonly routes: Map<string, () => Response>;
  /** The ops and cloudflare views through the loopback dev bypass (DEV_AUTH_BYPASS=true in these harnesses). */
  snapshot(): Promise<Snapshot>;
  /**
   * GET a view (or the registry) through the dev bypass, optionally conditional; every 200 body is checked against
   * dashboard.ui.v1 byte for byte (test/wire-conformance.ts).
   */
  view<T>(name: ViewId | 'registry', etag?: string | null): Promise<ViewAnswer<T>>;
  /** POST a view's refresh (RefreshHomeView, RefreshCloudflareView) with CSRF; the body checked like view()'s. */
  refresh<T>(name: 'home' | 'cloudflare'): Promise<ViewAnswer<T>>;
  /** Rows the Durable Object read for its last v2 view (HomeState.lastRowsRead over RPC). */
  lastRowsRead(): Promise<number>;
  /** Every outbound request "home" made (URL only), GraphQL and probes included. */
  readonly outboundLog: string[];
  post(path: string, body: unknown): Promise<Response>;
  /** Drains both stubs' call logs as `app.method` strings. */
  called(): Promise<string[]>;
  /** Drains and returns the calls of one method. */
  callsOf(app: StubApp, method: string): Promise<unknown[][]>;
  tick(at: string | number): Promise<void>;
  /** Sets (or with undefined, resets to the fixture default) one stub method's answer. */
  answer(app: StubApp, method: string, entry: StubAnswer | undefined): Promise<void>;
  /** Redeploys "home" with these vars, keeping its storage, pending call logs and the stub scenarios. */
  redeploy(bindings: Record<string, string>): Promise<void>;
}

/** A stub answer: a value, an error code thrown, or a sequence of them (the last one repeats). */
export type StubAnswer = { value: unknown } | { throw: string } | { sequence: ({ value: unknown } | { throw: string })[] };

/** A view's answer, its body checked against its message when it has one. */
async function answerOf<T>(name: ViewId | 'registry', response: Response): Promise<ViewAnswer<T>> {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text();
  if (response.status === 200) expectWire(VIEW_SCHEMAS[name], text);
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    body: response.status === 200 ? (JSON.parse(text) as T) : null,
    bytes: new TextEncoder().encode(text).byteLength,
  };
}

export async function startFlows(
  options: { bindings?: Record<string, string>; usage?: SyntheticUsage; persist?: string; inspectorPort?: number } = {},
): Promise<FlowHarness> {
  const analytics: Analytics = { answer: options.usage ?? {}, requests: [] };
  const cloudflare: CloudflareApi = { tweaks: {}, requests: [] };
  const routes = new Map<string, () => Response>();
  const outboundLog: string[] = [];
  const harness = await startHarness({
    bindings: { DEV_AUTH_BYPASS: 'true', DEV_NOW: new Date(NOW).toISOString(), ...options.bindings },
    ...(options.persist === undefined ? {} : { persist: options.persist }),
    ...(options.inspectorPort === undefined ? {} : { inspectorPort: options.inspectorPort }),
    async outbound(request) {
      outboundLog.push(request.url);
      if (request.url === GRAPHQL) {
        const body = (await request.json()) as { variables: Record<string, string> };
        analytics.requests.push({ authorization: request.headers.get('authorization'), variables: body.variables });
        const answer = analytics.answer;
        return typeof answer === 'function' ? answer() : Response.json(graphqlBody(answer));
      }
      const route = routes.get(request.url);
      if (route) return route();
      const fake = fakeCloudflare(request.url, cloudflare.tweaks, DESIRED);
      if (fake !== null) cloudflare.requests.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization') });
      return fake ?? new Response('no outbound fetch expected', { status: 599 });
    },
  });
  let csrf: { token: string; cookie: string } | null = null;
  const pending: Record<StubApp, { app: StubApp; method: string; args: unknown[] }[]> = { 'mail-hero': [], todofy: [], lab: [], watch: [], fleet: [], newsletter: [], 'notion-publish': [] };
  const drain = async (app: StubApp) => {
    pending[app].push(...(await harness.calls(app)));
    return pending[app].splice(0);
  };
  const scenarios: Record<StubApp, Record<string, StubAnswer>> = { 'mail-hero': {}, todofy: {}, lab: {}, watch: {}, fleet: {}, newsletter: {}, 'notion-publish': {} };
  const flows: FlowHarness = {
    ...harness,
    analytics,
    cloudflare,
    routes,
    outboundLog,
    async view<T>(name: ViewId | 'registry', etag: string | null = null): Promise<ViewAnswer<T>> {
      const response = await harness.fetch(PATHS[name], etag === null ? {} : { headers: { 'if-none-match': etag } });
      return answerOf<T>(name, response);
    },
    async refresh<T>(name: 'home' | 'cloudflare'): Promise<ViewAnswer<T>> {
      const response = await flows.post(name === 'home' ? PATHS.refreshHome : PATHS.refreshCloudflare, {});
      return answerOf<T>(name, response);
    },
    async lastRowsRead() {
      const ns = await harness.mf.getDurableObjectNamespace('HOME', 'home');
      const stub = ns.get(ns.idFromName('home-v1')) as unknown as { lastRowsRead(): Promise<number> };
      return stub.lastRowsRead();
    },
    async snapshot() {
      const read = async <T>(name: 'ops' | 'cloudflare'): Promise<T> => {
        const answer = await flows.view<T>(name);
        expect(answer.status).toBe(200);
        if (answer.body === null) throw new Error(`no ${name} view`);
        return answer.body;
      };
      const ops = await read<OpsView>('ops');
      const cloudflare = await read<CloudflareView>('cloudflare');
      const app = (id: StubApp): AppDetail => {
        const detail = ops.apps.find((entry) => entry.entry === id);
        if (detail === undefined) throw new Error(`no app detail for ${id}`);
        return detail;
      };
      const digestItems = ops.attention.items.filter((item) => item.observed === undefined);
      const level: OverallLevel = digestItems.some((item) => item.severity === 'critical')
        ? 'critical'
        : digestItems.some((item) => item.severity === 'warning')
          ? 'warning'
          : ops.attention.level === 'unknown' && ops.attention.items.length === 0
            ? 'unknown'
            : 'ok';
      return {
        ops,
        overall: {
          level,
          items: [...digestItems, ...ops.attention.info].map(({ source, code, severity }) => ({ source, code, severity })),
        },
        observed: ops.attention.items.flatMap((item) => (item.observed === undefined ? [] : [{ source: item.source, code: item.code, level: item.observed }])),
        apps: { 'mail-hero': app('mail-hero'), todofy: app('todofy'), lab: app('lab'), watch: app('watch'), fleet: app('fleet'), newsletter: app('newsletter'), 'notion-publish': app('notion-publish') },
        usage: cloudflare.usage,
        guard: ops.guard,
        canary: ops.canary,
        digest: ops.digest,
        refresh: ops.refresh,
      };
    },
    async post(path, body) {
      if (csrf === null) {
        const response = await harness.fetch(PATHS.csrf);
        expect(response.status).toBe(200);
        const token = ((await response.json()) as CsrfResponse).token;
        csrf = { token, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
      }
      return harness.fetch(path, {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1', 'x-csrf-token': csrf.token, cookie: csrf.cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
    async called() {
      const calls = [...(await drain('mail-hero')), ...(await drain('todofy'))];
      return calls.map((call) => `${call.app}.${call.method}`);
    },
    async callsOf(app, method) {
      const calls = await drain(app);
      const matching = calls.filter((call) => call.method === method);
      pending[app].push(...calls.filter((call) => call.method !== method));
      return matching.map((call) => call.args);
    },
    tick: (at) => harness.scheduled(new Date(at)),
    async answer(app, method, entry) {
      const rest = Object.fromEntries(Object.entries(scenarios[app]).filter(([name]) => name !== method));
      scenarios[app] = entry === undefined ? rest : { ...rest, [method]: entry };
      await harness.scenario(app, scenarios[app]);
    },
    async redeploy(bindings) {
      for (const app of Object.keys(scenarios) as StubApp[]) pending[app].push(...(await harness.calls(app)));
      await harness.rebind(bindings);
      for (const app of Object.keys(scenarios) as StubApp[]) await harness.scenario(app, scenarios[app]);
    },
  };
  return flows;
}

/** A status built from the app's `-ok` fixture with `patch`, checked with the contract's rules before use. */
export async function status(app: StubApp, patch: Partial<OpsStatus> = {}): Promise<OpsStatus> {
  const base = (await fixture(`OpsStatus/${app}-ok.json`)) as OpsStatus;
  const value = { ...base, ...patch };
  expect(contractErrors('OpsStatus', value)).toEqual([]);
  return value;
}

/** A GuardState checked with the contract's rules. */
export function guardState(value: GuardState): GuardState {
  expect(contractErrors('GuardState', value)).toEqual([]);
  return value;
}

/** The shed GuardState an app returns for `input`. */
export function shedState(until: string, reason: string, setAt: string): GuardState {
  return guardState({ level: 'shed', reason, until, set_at: setAt, deferred: ['raw_reconcile'] });
}

export function expectValid(name: ContractName, value: unknown): void {
  expect(contractErrors(name, value)).toEqual([]);
}

export function latest(snapshot: Snapshot): CanaryRun {
  const run = snapshot.canary.recent[0];
  if (run === undefined) throw new Error('no canary run');
  return run;
}

/** Usage at `percent` of the D1 rows-read allowance (5,000,000/day). */
export function d1Reads(percent: number): SyntheticUsage {
  return { d1RowsRead: Math.round(50_000 * percent) };
}

export { SYNTHETIC_BINDINGS };
