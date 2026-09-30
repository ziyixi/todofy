/**
 * Helpers of the workerd flow tests: a Miniflare harness whose outbound fetch plays the GraphQL API
 * (with scriptable usage or failures) and the Access certs endpoint, owner API calls through the
 * loopback dev bypass, and stub answers built from contract fixtures and validated against the schema.
 */
import { expect } from 'vitest';
import { validate } from '../../../../contracts/ops-v1/validate.mjs';
import type { GuardState, OpsStatus } from '../../../../contracts/ops-v1/ops-v1.ts';
import type { CanaryRun, CsrfResponse, OverviewResponse } from '../../src/api-types.ts';
import { graphqlBody, type SyntheticUsage } from '../graphql-fixture.ts';
import { contractSchema, fixture, startHarness, SYNTHETIC_BINDINGS, type Harness, type StubApp } from './harness.ts';

export const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

export interface Analytics {
  /** What the next GraphQL requests answer: usage numbers, or a Response (errors, statuses). */
  answer: SyntheticUsage | (() => Response);
  /** Every request's Authorization header and variables. */
  readonly requests: { authorization: string | null; variables: Record<string, string> }[];
}

export interface FlowHarness extends Harness {
  readonly analytics: Analytics;
  /** Extra outbound answers (e.g. the Access certs) by exact URL. */
  readonly routes: Map<string, () => Response>;
  /** Owner API through the loopback dev bypass (DEV_AUTH_BYPASS=true in these harnesses). */
  overview(refresh?: boolean): Promise<OverviewResponse>;
  post(path: string, body: unknown): Promise<Response>;
  /** Drains both stubs' call logs as `app.method` strings. */
  called(): Promise<string[]>;
  /** Drains and returns the calls of one method. */
  callsOf(app: StubApp, method: string): Promise<unknown[][]>;
  tick(at: string | number): Promise<void>;
  /** Sets (or with undefined, resets to the fixture default) one stub method's answer. */
  answer(app: StubApp, method: string, entry: StubAnswer | undefined): Promise<void>;
}

/** A stub answer: a value, an error code thrown, or a sequence of them (the last one repeats). */
export type StubAnswer = { value: unknown } | { throw: string } | { sequence: ({ value: unknown } | { throw: string })[] };

export async function startFlows(options: { bindings?: Record<string, string>; usage?: SyntheticUsage } = {}): Promise<FlowHarness> {
  const analytics: Analytics = { answer: options.usage ?? {}, requests: [] };
  const routes = new Map<string, () => Response>();
  const harness = await startHarness({
    bindings: { DEV_AUTH_BYPASS: 'true', ...options.bindings },
    async outbound(request) {
      if (request.url === GRAPHQL) {
        const body = (await request.json()) as { variables: Record<string, string> };
        analytics.requests.push({ authorization: request.headers.get('authorization'), variables: body.variables });
        const answer = analytics.answer;
        return typeof answer === 'function' ? answer() : Response.json(graphqlBody(answer));
      }
      const route = routes.get(request.url);
      return route ? route() : new Response('no outbound fetch expected', { status: 599 });
    },
  });
  let csrf: { token: string; cookie: string } | null = null;
  const pending: Record<StubApp, { app: StubApp; method: string; args: unknown[] }[]> = { 'mail-hero': [], todofy: [] };
  const drain = async (app: StubApp) => {
    pending[app].push(...(await harness.calls(app)));
    return pending[app].splice(0);
  };
  const scenarios: Record<StubApp, Record<string, StubAnswer>> = { 'mail-hero': {}, todofy: {} };
  const flows: FlowHarness = {
    ...harness,
    analytics,
    routes,
    async overview(refresh = false) {
      const response = await harness.fetch(`/api/v1/overview${refresh ? '?refresh=1' : ''}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return (await response.json()) as OverviewResponse;
    },
    async post(path, body) {
      if (csrf === null) {
        const response = await harness.fetch('/api/v1/csrf');
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
  };
  return flows;
}

/** A status built from the app's `-ok` fixture with `patch`, validated as OpsStatus before use. */
export async function status(app: StubApp, patch: Partial<OpsStatus> = {}): Promise<OpsStatus> {
  const base = (await fixture(`OpsStatus/${app}-ok.json`)) as OpsStatus;
  const value = { ...base, ...patch };
  expect(validate(await contractSchema(), 'OpsStatus', value)).toEqual([]);
  return value;
}

/** A GuardState validated against the schema. */
export async function guardState(value: GuardState): Promise<GuardState> {
  expect(validate(await contractSchema(), 'GuardState', value)).toEqual([]);
  return value;
}

/** The shed GuardState an app returns for `input`. */
export async function shedState(until: string, reason: string, setAt: string): Promise<GuardState> {
  return guardState({ level: 'shed', reason, until, set_at: setAt, deferred: ['raw_reconcile'] });
}

export async function expectValid(name: string, value: unknown): Promise<void> {
  expect(validate(await contractSchema(), name, value)).toEqual([]);
}

export function latest(overview: OverviewResponse): CanaryRun {
  const run = overview.canary.recent[0];
  if (run === undefined) throw new Error('no canary run');
  return run;
}

/** Usage at `percent` of the D1 rows-read allowance (5,000,000/day). */
export function d1Reads(percent: number): SyntheticUsage {
  return { d1RowsRead: Math.round(50_000 * percent) };
}

export { SYNTHETIC_BINDINGS };
