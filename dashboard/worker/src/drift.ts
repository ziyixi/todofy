/**
 * Configuration drift (docs/design-v2.md §10): the live Cloudflare account compared with the desired state
 * generated from every committed wrangler.toml and deploy wrapper (src/drift-desired.json, made by
 * .github/scripts/drift_desired.py and checked against a fresh generation in CI).
 *
 * Once per UTC day, across ticks, at most DRIFT_CALLS_PER_TICK read-only GETs to fixed paths under
 * CF_API_BASE, with CF_ANALYTICS_TOKEN as the bearer token (the same token as the GraphQL query; never
 * logged, stored or sent elsewhere). Every answer is reduced at once to names, types and flags: a binding
 * keeps only its name and type, so a plain_text value (or any other field) never leaves the parser, and
 * remote text never leaves this module (failures become codes). Findings are names only.
 */
import {
  DRIFT_CALLS_PER_TICK,
  DRIFT_CATEGORIES,
  DRIFT_FINDINGS_MAX,
  DRIFT_MAX_ATTEMPTS,
  DRIFT_UTC_HOUR,
  DRIFT_VIEW_FINDINGS_MAX,
  type DriftCategory,
  type DriftFinding,
  type DriftView,
} from './api-v2-types.ts';
import desiredJson from './drift-desired.json';
import { isoOrNull, utcDay } from './time.ts';

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
export const DRIFT_TIMEOUT_MS = 15_000;
export const DRIFT_MAX_BYTES = 1_000_000;
/** Bounds of what one check keeps (the account has 10 Workers). */
export const DRIFT_SCRIPTS_MAX = 100;
export const DRIFT_DOMAINS_MAX = 100;
export const DRIFT_ROUTES_MAX = 100;
export const DRIFT_BINDINGS_MAX = 100;
export const DRIFT_CRONS_MAX = 10;
/** Calls of the account step (scripts, domains, then one routes list per zone) and of each Worker's step. */
export const SCRIPT_STEP_CALLS = 3;

// ---- the desired state ----------------------------------------------------------------------------

export interface DesiredBinding {
  readonly name: string;
  readonly type: string;
  readonly source: string;
  readonly optional?: boolean;
}

export interface DesiredWorker {
  readonly config: string;
  readonly workers_dev: boolean;
  readonly preview_urls: boolean;
  readonly custom_domains: readonly string[];
  readonly routes: readonly string[];
  readonly crons: readonly string[];
  readonly bindings: readonly DesiredBinding[];
  readonly personal: readonly string[];
}

export interface DesiredState {
  readonly version: number;
  readonly zones: readonly string[];
  readonly workers: Readonly<Record<string, DesiredWorker>>;
}

export const DESIRED: DesiredState = desiredJson;

export function accountStepCalls(desired: DesiredState = DESIRED): number {
  return 2 + desired.zones.length;
}

// ---- the live state, as kept between ticks (names, types and flags only) --------------------------

export interface LiveBinding {
  readonly name: string;
  readonly type: string;
}

export interface LiveScript {
  readonly crons: readonly string[];
  readonly bindings: readonly LiveBinding[];
  readonly workers_dev: boolean | null;
  readonly preview_urls: boolean | null;
}

export interface LiveAccount {
  readonly scripts: readonly string[];
  readonly domains: readonly { readonly hostname: string; readonly service: string }[];
  readonly routes: readonly { readonly pattern: string; readonly script: string }[];
  readonly zones_unchecked: number;
  readonly truncated: boolean;
}

/** `drift_run`: today's check while it runs across ticks. */
export interface DriftRunDoc {
  readonly day: string;
  readonly started_at: number;
  readonly account: LiveAccount | null;
  /** Desired Workers that exist live and still need their step; null before the account step. */
  readonly pending: readonly string[] | null;
  readonly scripts: Readonly<Record<string, LiveScript>>;
  readonly attempts: number;
}

/** `drift`: the last completed check, and how the latest attempts went. */
export interface DriftDoc {
  readonly checked_at: number | null;
  readonly desired_workers: number;
  readonly counts: Readonly<Record<DriftCategory, number>>;
  readonly findings: readonly DriftFinding[];
  readonly zones_unchecked: number;
  readonly truncated: boolean;
  /** The UTC day whose check completed or gave up (no new check that day). */
  readonly last_run_day: string | null;
  /** The UTC day of a check in progress (so a view needs no second document). */
  readonly running_day: string | null;
  readonly last_error: DriftErrorCode | null;
  readonly last_error_step: DriftStep | null;
  readonly last_error_at: number | null;
  readonly consecutive_failed_days: number;
}

export type DriftStep = 'account' | 'script';
export type DriftErrorCode = `http_${string}` | 'network_error' | 'timeout' | 'invalid_response' | 'api_error' | 'incomplete' | 'bad_account' | 'too_large';

/** A `drift_run` document larger than this ends the day's check (`too_large`): the state table's rows hold ≤ 64 KiB. */
export const DRIFT_RUN_MAX_BYTES = 60_000;

export function runTooLarge(run: DriftRunDoc): boolean {
  return new TextEncoder().encode(JSON.stringify(run)).byteLength > DRIFT_RUN_MAX_BYTES;
}

export const NO_COUNTS: Readonly<Record<DriftCategory, number>> = Object.fromEntries(DRIFT_CATEGORIES.map((c) => [c, 0])) as Record<DriftCategory, number>;

export const NO_DRIFT: DriftDoc = {
  checked_at: null,
  desired_workers: 0,
  counts: NO_COUNTS,
  findings: [],
  zones_unchecked: 0,
  truncated: false,
  last_run_day: null,
  running_day: null,
  last_error: null,
  last_error_step: null,
  last_error_at: null,
  consecutive_failed_days: 0,
};

// ---- reading the API ------------------------------------------------------------------------------

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ApiResult = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly code: DriftErrorCode; readonly http_status: number | null };

const HEX32 = /^[0-9a-f]{32}$/;
const SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TYPE = /^[a-z][a-z0-9_]{0,39}$/;
const HOST = /^[a-z0-9*.-]{1,253}$/;

type JsonObject = Record<string, unknown>;
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One GET of `path` under CF_API_BASE; never throws, never returns remote text. */
export async function cfGet(token: string, path: string, fetcher: FetchLike): Promise<ApiResult> {
  let response: Response;
  try {
    response = await fetcher(`${CF_API_BASE}${path}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(DRIFT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, code: timedOut ? 'timeout' : 'network_error', http_status: null };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { ok: false, code: `http_${String(response.status)}`, http_status: response.status };
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > DRIFT_MAX_BYTES) {
    await response.body?.cancel();
    return { ok: false, code: 'invalid_response', http_status: 200 };
  }
  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > DRIFT_MAX_BYTES) return { ok: false, code: 'invalid_response', http_status: 200 };
    body = JSON.parse(text);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, code: timedOut ? 'timeout' : 'invalid_response', http_status: 200 };
  }
  if (!isObject(body) || typeof body.success !== 'boolean') return { ok: false, code: 'invalid_response', http_status: 200 };
  if (!body.success) return { ok: false, code: 'api_error', http_status: 200 };
  return { ok: true, result: body.result };
}

/** Script names of `GET /accounts/{a}/workers/scripts` (the `id` of each). */
export function parseScripts(result: unknown): { names: string[]; truncated: boolean } | null {
  if (!Array.isArray(result)) return null;
  const names: string[] = [];
  for (const item of result as unknown[]) {
    if (!isObject(item) || typeof item.id !== 'string' || !SCRIPT.test(item.id)) return null;
    names.push(item.id);
  }
  return { names: [...new Set(names)].sort().slice(0, DRIFT_SCRIPTS_MAX), truncated: names.length > DRIFT_SCRIPTS_MAX };
}

/** Custom Domains of `GET /accounts/{a}/workers/domains`, and the zone ids they name (used at once, never kept). */
export function parseDomains(result: unknown): { domains: { hostname: string; service: string }[]; zones: Map<string, string>; truncated: boolean } | null {
  if (!Array.isArray(result)) return null;
  const domains: { hostname: string; service: string }[] = [];
  const zones = new Map<string, string>();
  for (const item of result as unknown[]) {
    if (!isObject(item) || typeof item.hostname !== 'string' || typeof item.service !== 'string') return null;
    const hostname = item.hostname.toLowerCase();
    if (!HOST.test(hostname) || !SCRIPT.test(item.service)) return null;
    domains.push({ hostname, service: item.service });
    if (typeof item.zone_name === 'string' && typeof item.zone_id === 'string' && HEX32.test(item.zone_id)) zones.set(item.zone_name.toLowerCase(), item.zone_id);
  }
  domains.sort((a, b) => a.hostname.localeCompare(b.hostname) || a.service.localeCompare(b.service));
  return { domains: domains.slice(0, DRIFT_DOMAINS_MAX), zones, truncated: domains.length > DRIFT_DOMAINS_MAX };
}

/** Zone routes of `GET /zones/{z}/workers/routes`: pattern and Worker (`(none)` for a route without one). */
export function parseRoutes(result: unknown): { pattern: string; script: string }[] | null {
  if (!Array.isArray(result)) return null;
  const routes: { pattern: string; script: string }[] = [];
  for (const item of result as unknown[]) {
    if (!isObject(item) || typeof item.pattern !== 'string' || item.pattern.length > 300) return null;
    const script = typeof item.script === 'string' && SCRIPT.test(item.script) ? item.script : NO_SCRIPT;
    routes.push({ pattern: item.pattern, script });
  }
  return routes;
}

export const NO_SCRIPT = '(none)';

/** Cron expressions of `GET .../scripts/{s}/schedules` (`{ schedules: [{ cron }] }`). */
export function parseSchedules(result: unknown): string[] | null {
  const list: unknown = isObject(result) ? result.schedules : result;
  if (!Array.isArray(list)) return null;
  const crons: string[] = [];
  for (const item of list as unknown[]) {
    if (!isObject(item) || typeof item.cron !== 'string' || item.cron.length > 100) return null;
    crons.push(item.cron.trim());
  }
  return crons.sort().slice(0, DRIFT_CRONS_MAX);
}

/**
 * Binding names and types of `GET .../scripts/{s}/settings`. Everything else in the answer (a
 * plain_text binding's `text`, a json binding's value, ids, observability, ...) is dropped here.
 */
export function parseSettings(result: unknown): LiveBinding[] | null {
  if (!isObject(result) || !Array.isArray(result.bindings)) return null;
  const bindings: LiveBinding[] = [];
  for (const item of result.bindings as unknown[]) {
    if (!isObject(item) || typeof item.name !== 'string' || typeof item.type !== 'string') return null;
    if (!NAME.test(item.name) || !TYPE.test(item.type)) return null;
    bindings.push({ name: item.name, type: item.type });
  }
  return bindings.sort((a, b) => a.name.localeCompare(b.name)).slice(0, DRIFT_BINDINGS_MAX);
}

/** `GET .../scripts/{s}/subdomain`: `{ enabled, previews_enabled }`. */
export function parseSubdomain(result: unknown): { workers_dev: boolean; preview_urls: boolean | null } | null {
  if (!isObject(result) || typeof result.enabled !== 'boolean') return null;
  return { workers_dev: result.enabled, preview_urls: typeof result.previews_enabled === 'boolean' ? result.previews_enabled : null };
}

export type StepOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: DriftErrorCode; readonly step: DriftStep; readonly http_status: number | null };

function failed(step: DriftStep, result: { code: DriftErrorCode; http_status: number | null }): { ok: false; code: DriftErrorCode; step: DriftStep; http_status: number | null } {
  return { ok: false, code: result.code, step, http_status: result.http_status };
}

const INVALID = { code: 'invalid_response', http_status: 200 } as const;

/** The account step: scripts and Custom Domains in parallel, then each desired zone's routes. */
export async function fetchAccount(token: string, accountId: string, fetcher: FetchLike, desired: DesiredState = DESIRED): Promise<StepOutcome<LiveAccount>> {
  if (!HEX32.test(accountId)) return { ok: false, code: 'bad_account', step: 'account', http_status: null };
  const base = `/accounts/${accountId}/workers`;
  const [scriptsAnswer, domainsAnswer] = await Promise.all([cfGet(token, `${base}/scripts`, fetcher), cfGet(token, `${base}/domains`, fetcher)]);
  if (!scriptsAnswer.ok) return failed('account', scriptsAnswer);
  if (!domainsAnswer.ok) return failed('account', domainsAnswer);
  const scripts = parseScripts(scriptsAnswer.result);
  const domains = parseDomains(domainsAnswer.result);
  if (scripts === null || domains === null) return failed('account', INVALID);
  const routes: { pattern: string; script: string }[] = [];
  let unchecked = 0;
  for (const zone of desired.zones) {
    const zoneId = domains.zones.get(zone);
    if (zoneId === undefined) {
      unchecked++;
      continue;
    }
    const answer = await cfGet(token, `/zones/${zoneId}/workers/routes`, fetcher);
    if (!answer.ok) return failed('account', answer);
    const parsed = parseRoutes(answer.result);
    if (parsed === null) return failed('account', INVALID);
    routes.push(...parsed);
  }
  routes.sort((a, b) => a.pattern.localeCompare(b.pattern) || a.script.localeCompare(b.script));
  return {
    ok: true,
    value: {
      scripts: scripts.names,
      domains: domains.domains,
      routes: routes.slice(0, DRIFT_ROUTES_MAX),
      zones_unchecked: unchecked,
      truncated: scripts.truncated || domains.truncated || routes.length > DRIFT_ROUTES_MAX,
    },
  };
}

/** One Worker's step: schedules, settings (binding names and types) and subdomain flags, in parallel. */
export async function fetchScript(token: string, accountId: string, script: string, fetcher: FetchLike): Promise<StepOutcome<LiveScript>> {
  if (!HEX32.test(accountId)) return { ok: false, code: 'bad_account', step: 'script', http_status: null };
  if (!SCRIPT.test(script)) return failed('script', INVALID);
  const base = `/accounts/${accountId}/workers/scripts/${script}`;
  const [schedules, settings, subdomain] = await Promise.all([
    cfGet(token, `${base}/schedules`, fetcher),
    cfGet(token, `${base}/settings`, fetcher),
    cfGet(token, `${base}/subdomain`, fetcher),
  ]);
  for (const answer of [schedules, settings, subdomain]) if (!answer.ok) return failed('script', answer);
  if (!schedules.ok || !settings.ok || !subdomain.ok) return failed('script', INVALID);
  const crons = parseSchedules(schedules.result);
  const bindings = parseSettings(settings.result);
  const flags = parseSubdomain(subdomain.result);
  if (crons === null || bindings === null || flags === null) return failed('script', INVALID);
  return { ok: true, value: { crons, bindings, workers_dev: flags.workers_dev, preview_urls: flags.preview_urls } };
}

// ---- scheduling -------------------------------------------------------------------------------------

export type DriftPlan =
  | { readonly kind: 'idle' }
  /** A run of an earlier day never finished: record it as a failed day (then maybe start today's). */
  | { readonly kind: 'abandon'; readonly run: DriftRunDoc }
  | { readonly kind: 'start' }
  | { readonly kind: 'continue'; readonly run: DriftRunDoc };

/** What a tick at `now` does about drift (a run is only ever advanced by ticks). */
export function driftPlan(now: number, run: DriftRunDoc | null, doc: DriftDoc, configured: boolean): DriftPlan {
  const day = utcDay(now);
  if (run !== null && run.day !== day) return { kind: 'abandon', run };
  if (!configured) return { kind: 'idle' };
  if (run !== null) return { kind: 'continue', run };
  if (new Date(now).getUTCHours() < DRIFT_UTC_HOUR || doc.last_run_day === day) return { kind: 'idle' };
  return { kind: 'start' };
}

export function newDriftRun(now: number): DriftRunDoc {
  return { day: utcDay(now), started_at: now, account: null, pending: null, scripts: {}, attempts: 0 };
}

export interface AdvanceResult {
  readonly run: DriftRunDoc;
  readonly calls: number;
  readonly error: { readonly code: DriftErrorCode; readonly step: DriftStep; readonly http_status: number | null } | null;
}

/**
 * Advances a run by as many steps as fit in DRIFT_CALLS_PER_TICK calls, stopping at the first failure
 * (the failed step is retried by the next tick). `run.pending` empty afterwards means complete.
 */
export async function advanceRun(run: DriftRunDoc, token: string, accountId: string, fetcher: FetchLike, desired: DesiredState = DESIRED): Promise<AdvanceResult> {
  let current = run;
  let calls = 0;
  const counted: FetchLike = (url, init) => {
    calls++;
    return fetcher(url, init);
  };
  if (current.account === null) {
    const account = await fetchAccount(token, accountId, counted, desired);
    if (!account.ok) return { run: { ...current, attempts: current.attempts + 1 }, calls, error: account };
    const live = new Set(account.value.scripts);
    current = { ...current, account: account.value, pending: Object.keys(desired.workers).filter((name) => live.has(name)).sort() };
  }
  const pending = [...(current.pending ?? [])];
  // The account step made at most accountStepCalls() calls; each Worker's step makes SCRIPT_STEP_CALLS.
  const room = Math.max(0, Math.floor((DRIFT_CALLS_PER_TICK - calls) / SCRIPT_STEP_CALLS));
  const batch = pending.slice(0, room);
  const results = await Promise.all(batch.map(async (script) => [script, await fetchScript(token, accountId, script, counted)] as const));
  const scripts: Record<string, LiveScript> = { ...current.scripts };
  let error: AdvanceResult['error'] = null;
  for (const [script, result] of results) {
    if (result.ok) scripts[script] = result.value;
    else error ??= result;
  }
  const remaining = pending.filter((script) => scripts[script] === undefined);
  return {
    run: { ...current, scripts, pending: remaining, attempts: error === null ? current.attempts : current.attempts + 1 },
    calls,
    error,
  };
}

export function runComplete(run: DriftRunDoc): boolean {
  return run.account !== null && run.pending !== null && run.pending.length === 0;
}

export function attemptsExhausted(run: DriftRunDoc): boolean {
  return run.attempts >= DRIFT_MAX_ATTEMPTS;
}

// ---- comparison --------------------------------------------------------------------------------------

function setDiff(category: DriftCategory, script: string, desired: readonly string[], live: readonly string[]): DriftFinding[] {
  const want = new Set(desired);
  const have = new Set(live);
  return [
    ...[...want].filter((name) => !have.has(name)).sort().map((name): DriftFinding => ({ category, script, name, kind: 'missing' })),
    ...[...have].filter((name) => !want.has(name)).sort().map((name): DriftFinding => ({ category, script, name, kind: 'extra' })),
  ];
}

/** Every difference between the desired state and a completed run's live state (pure; names only). */
export function compareDrift(desired: DesiredState, account: LiveAccount, scripts: Readonly<Record<string, LiveScript>>): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const workers = Object.keys(desired.workers).sort();
  const live = new Set(account.scripts);
  for (const finding of setDiff('scripts', '', workers, account.scripts)) findings.push({ ...finding, script: finding.name });

  // Custom Domains and zone routes, by the Worker they serve (a live one of an unknown Worker is extra).
  const domainServices = new Set([...workers, ...account.domains.map((d) => d.service)]);
  for (const service of [...domainServices].sort()) {
    const want = desired.workers[service]?.custom_domains ?? [];
    const have = account.domains.filter((d) => d.service === service).map((d) => d.hostname);
    findings.push(...setDiff('custom_domains', service, want, have));
  }
  const routeScripts = new Set([...workers, ...account.routes.map((r) => r.script)]);
  for (const script of [...routeScripts].sort()) {
    const want = desired.workers[script]?.routes ?? [];
    const have = account.routes.filter((r) => r.script === script).map((r) => r.pattern);
    findings.push(...setDiff('routes', script, want, have));
  }

  for (const name of workers) {
    const want = desired.workers[name];
    const have = scripts[name];
    if (want === undefined || !live.has(name) || have === undefined) continue;
    findings.push(...setDiff('crons', name, want.crons, have.crons));

    const liveTypes = new Map(have.bindings.map((b) => [b.name, b.type]));
    const wanted = new Map(want.bindings.map((b) => [b.name, b]));
    for (const binding of want.bindings) {
      const type = liveTypes.get(binding.name);
      if (type === undefined) {
        if (binding.optional !== true) findings.push({ category: 'bindings', script: name, name: binding.name, kind: 'missing', expected: binding.type });
      } else if (type !== binding.type && !(type === 'secret_text' && want.personal.includes(binding.name))) {
        // (A personal value that is already a secret is the wanted end state; the `personal` category
        // reports the other direction.)
        findings.push({ category: 'bindings', script: name, name: binding.name, kind: 'changed', expected: binding.type, actual: type });
      }
    }
    for (const binding of have.bindings) {
      if (!wanted.has(binding.name)) findings.push({ category: 'bindings', script: name, name: binding.name, kind: 'extra', actual: binding.type });
    }

    if (have.workers_dev !== null && have.workers_dev !== want.workers_dev) {
      findings.push({ category: 'workers_dev', script: name, name: 'workers_dev', kind: 'changed', expected: String(want.workers_dev), actual: String(have.workers_dev) });
    }
    if (have.preview_urls !== null && have.preview_urls !== want.preview_urls) {
      findings.push({ category: 'workers_dev', script: name, name: 'preview_urls', kind: 'changed', expected: String(want.preview_urls), actual: String(have.preview_urls) });
    }

    // A personal value must be a Worker secret, whatever the committed wrapper sends today.
    for (const personal of want.personal) {
      const type = liveTypes.get(personal);
      if (type !== undefined && type !== 'secret_text') {
        findings.push({ category: 'personal', script: name, name: personal, kind: 'changed', expected: 'secret_text', actual: type });
      }
    }
  }
  const order = new Map(DRIFT_CATEGORIES.map((category, index) => [category, index]));
  return findings.sort((a, b) => (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0));
}

export function countFindings(findings: readonly DriftFinding[]): Record<DriftCategory, number> {
  const counts = { ...NO_COUNTS } as Record<DriftCategory, number>;
  for (const finding of findings) counts[finding.category] += 1;
  return counts;
}

export function totalFindings(counts: Readonly<Record<DriftCategory, number>>): number {
  return DRIFT_CATEGORIES.reduce((sum, category) => sum + counts[category], 0);
}

// ---- documents and the view -----------------------------------------------------------------------

/** The `drift` document after a completed run. */
export function completedDoc(previous: DriftDoc, run: DriftRunDoc, now: number, desired: DesiredState = DESIRED): DriftDoc {
  const account = run.account ?? { scripts: [], domains: [], routes: [], zones_unchecked: 0, truncated: false };
  const findings = compareDrift(desired, account, run.scripts);
  return {
    ...previous,
    checked_at: now,
    desired_workers: Object.keys(desired.workers).length,
    counts: countFindings(findings),
    findings: findings.slice(0, DRIFT_FINDINGS_MAX),
    zones_unchecked: account.zones_unchecked,
    truncated: account.truncated,
    last_run_day: run.day,
    running_day: null,
    last_error: null,
    last_error_step: null,
    last_error_at: null,
    consecutive_failed_days: 0,
  };
}

/** The `drift` document after a failed attempt; `gaveUp` ends the day (no further attempt today). */
export function failedDoc(previous: DriftDoc, run: DriftRunDoc, error: { code: DriftErrorCode; step: DriftStep }, now: number, gaveUp: boolean): DriftDoc {
  return {
    ...previous,
    last_error: error.code,
    last_error_step: error.step,
    last_error_at: now,
    running_day: gaveUp ? null : run.day,
    last_run_day: gaveUp ? run.day : previous.last_run_day,
    consecutive_failed_days: gaveUp ? previous.consecutive_failed_days + 1 : previous.consecutive_failed_days,
  };
}

export function driftView(doc: DriftDoc, configured: boolean, now: number): DriftView {
  const total = totalFindings(doc.counts);
  const status: DriftView['status'] = !configured
    ? 'not_configured'
    : doc.checked_at === null
      ? doc.consecutive_failed_days > 0
        ? 'failing'
        : 'never_checked'
      : total > 0
        ? 'drift'
        : 'ok';
  const findings = doc.findings.slice(0, DRIFT_VIEW_FINDINGS_MAX);
  return {
    status,
    checked_at: isoOrNull(doc.checked_at),
    in_progress: configured && doc.running_day === utcDay(now),
    desired_workers: doc.desired_workers > 0 ? doc.desired_workers : Object.keys(DESIRED.workers).length,
    counts: doc.counts,
    findings,
    findings_omitted: total - findings.length,
    zones_unchecked: doc.zones_unchecked,
    truncated: doc.truncated,
    last_error: doc.last_error,
    last_error_step: doc.last_error_step,
    last_error_at: isoOrNull(doc.last_error_at),
    consecutive_failed_days: doc.consecutive_failed_days,
  };
}
