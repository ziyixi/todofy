/**
 * Account-wide Workers Free usage from the Cloudflare GraphQL Analytics API (docs/design.md §5.2, §7).
 *
 * CF_ANALYTICS_TOKEN is used here only as the bearer token of one POST to GRAPHQL_URL (a constant,
 * not configuration); its only other use is the drift check's read-only GETs (drift.ts). It is never
 * logged, stored, echoed or sent anywhere else, and remote response text never leaves this module:
 * failures become codes.
 */
import { BREAKDOWN_UNCLASSIFIED, type QuotaResource, type QuotaRow } from './api-types.ts';
import { WORKERS_QUERY_LIMIT, type StorageKind } from './api-types.ts';
import { QUOTA_BREAKDOWN_MAX } from './idl.ts';
import { ALLOWANCES, DO_DURATION_GB } from './limits.ts';
import { DAY_MS, HOUR_MS, daysInUtcMonth, isoSeconds, round1, startOfUtcDay, startOfUtcMonth, utcDay, utcMonthStart } from './time.ts';

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
export const GRAPHQL_TIMEOUT_MS = 15_000;
export const GRAPHQL_MAX_BYTES = 1_000_000;

/**
 * Verbatim copy of the query verified against the live account on 2026-09-29 (design.md §7.2); v2 only
 * raised the `workers` limit from 20 to 50 (design-v2.md §4) and parses the per-script fields it always
 * returned (errors, subrequests, CPU quantiles, DO requests per script) and the per-resource rows. The
 * `ai` dataset (Workers AI neurons by model, same day window as `workers`) was added on 2026-09-30 after
 * the owner checked `aiInferenceAdaptiveGroups` with these filters and fields on the live account: it is
 * part of this one request, so a tick still makes a single GraphQL call.
 */
export const USAGE_QUERY = `query($a: string!, $day: Date!, $start: Time!, $end: Time!, $month: Date!) { viewer { accounts(filter: {accountTag: $a}) {
  workers: workersInvocationsAdaptive(limit: 50, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests errors subrequests } dimensions { scriptName } quantiles { cpuTimeP50 cpuTimeP99 } }
  d1: d1AnalyticsAdaptiveGroups(limit: 10, filter: {date: $day}) { sum { rowsRead rowsWritten readQueries writeQueries } dimensions { databaseId } }
  d1s: d1StorageAdaptiveGroups(limit: 10, filter: {date: $day}) { max { databaseSizeBytes } dimensions { databaseId } }
  doInv: durableObjectsInvocationsAdaptiveGroups(limit: 10, filter: {date: $day}) { sum { requests errors } dimensions { scriptName } }
  doPer: durableObjectsPeriodicGroups(limit: 10, filter: {date: $day}) { sum { activeTime rowsRead rowsWritten cpuTime storageDeletes storageReadUnits storageWriteUnits } dimensions { namespaceId } }
  doSto: durableObjectsStorageGroups(limit: 5, filter: {date: $day}) { max { storedBytes } }
  r2ops: r2OperationsAdaptiveGroups(limit: 50, filter: {date_geq: $month, date_leq: $day}) { sum { requests } dimensions { actionType bucketName } }
  r2sto: r2StorageAdaptiveGroups(limit: 10, filter: {date: $day}) { max { payloadSize metadataSize objectCount } dimensions { bucketName } }
  ai: aiInferenceAdaptiveGroups(limit: 20, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { totalNeurons } dimensions { modelId } }
} } }`;

/** The `limit` of each dataset in USAGE_QUERY: a dataset returning this many rows is truncated. */
const DATASET_LIMITS = { workers: WORKERS_QUERY_LIMIT, d1: 10, d1s: 10, doInv: 10, doPer: 10, doSto: 5, r2ops: 50, r2sto: 10, ai: 20 } as const;
type Dataset = keyof typeof DATASET_LIMITS;
/**
 * Datasets whose absence (not an array), or whose own GraphQL error (an `errors` entry whose path is
 * that dataset, see withoutFailedOptionalDatasets), leaves only their own rows without data instead of
 * refusing the whole answer: Workers AI does not gate the guard, so it must never cost the other rows.
 */
const OPTIONAL_DATASETS: ReadonlySet<Dataset> = new Set<Dataset>(['ai']);

/** R2 operation classes (R2 pricing). Any other actionType counts as Class A (cautious). */
export const R2_CLASS_A: ReadonlySet<string> = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload',
  'CreateMultipartUpload', 'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart',
  'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);
export const R2_CLASS_B: ReadonlySet<string> = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation',
  'GetBucketCors', 'GetBucketLifecycleConfiguration',
]);
export const R2_FREE: ReadonlySet<string> = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);
/**
 * Seen on the live account (2026-09-30) but on neither class list of the R2 pricing page: the bulk
 * delete (`DeleteObjects`, a Worker's `bucket.delete([...])`). Counted as Class A on purpose (cautious;
 * the page names only the single `DeleteObject` as free), so it is not reported as unclassified.
 */
export const R2_ASSUMED_CLASS_A: ReadonlySet<string> = new Set(['DeleteObjects']);

export type UsageErrorCode = `http_${string}` | 'graphql_error' | 'network_error' | 'timeout' | 'invalid_response' | 'not_configured';

/** One script's day so far (UTC), from `workers` and `doInv` (design-v2.md §4 "Discovery"). */
export interface ScriptUsage {
  readonly script: string;
  readonly requests: number;
  readonly errors: number;
  readonly subrequests: number;
  /** Microseconds (rounded); null when the dataset reported no quantile for the script. */
  readonly cpu_p50_us: number | null;
  readonly cpu_p99_us: number | null;
  /** From `doInv` by scriptName; null when the script had no Durable Object invocations. */
  readonly do_requests: number | null;
  readonly do_errors: number | null;
}

/** Per-resource rows of the same response, keyed by the GraphQL identifier. */
export interface ResourceUsage {
  readonly d1: readonly { readonly id: string; readonly size_bytes: number | null; readonly rows_read: number; readonly rows_written: number }[];
  readonly do: readonly { readonly id: string; readonly rows_read: number; readonly rows_written: number }[];
  /** `unclassified`: R2 operations without a bucket name. */
  readonly r2: readonly { readonly id: string; readonly size_bytes: number | null; readonly class_a: number; readonly class_b: number }[];
}

export interface UsageData {
  readonly rows: QuotaRow[];
  readonly unclassified_r2_operations: number;
  /** Scripts of `workers` or `doInv`, most requests first (at most WORKERS_QUERY_LIMIT + doInv's 10). */
  readonly scripts: ScriptUsage[];
  /** `workers` returned WORKERS_QUERY_LIMIT rows: more scripts may have run. */
  readonly workers_truncated: boolean;
  readonly resources: ResourceUsage;
}

export type UsageFetchResult =
  | { readonly ok: true; readonly data: UsageData }
  | { readonly ok: false; readonly code: UsageErrorCode; readonly http_status: number | null };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** GraphQL variables for a query at `now`: the UTC day so far and the UTC month to date. */
export function usageVariables(accountId: string, now: number): Record<string, string> {
  const day = utcDay(now);
  return { a: accountId, day, start: `${day}T00:00:00Z`, end: isoSeconds(now), month: utcMonthStart(now) };
}

/** One GraphQL request; never throws. */
export async function fetchUsage(
  token: string | undefined,
  accountId: string,
  now: number,
  fetcher: FetchLike = (url, init) => globalThis.fetch(url, init),
): Promise<UsageFetchResult> {
  const bearer = (token ?? '').trim();
  if (bearer === '') return { ok: false, code: 'not_configured', http_status: null };
  let response: Response;
  try {
    response = await fetcher(GRAPHQL_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: USAGE_QUERY, variables: usageVariables(accountId, now) }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
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
  if (Number.isFinite(declared) && declared > GRAPHQL_MAX_BYTES) {
    await response.body?.cancel();
    return { ok: false, code: 'invalid_response', http_status: 200 };
  }
  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > GRAPHQL_MAX_BYTES) return { ok: false, code: 'invalid_response', http_status: 200 };
    body = JSON.parse(text);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, code: timedOut ? 'timeout' : 'invalid_response', http_status: 200 };
  }
  if (isObject(body) && Array.isArray(body.errors) && body.errors.length > 0) {
    const partial = withoutFailedOptionalDatasets(body, body.errors);
    if (partial === null) return { ok: false, code: 'graphql_error', http_status: 200 };
    body = partial;
  }
  const data = parseUsage(body, now);
  return data === null ? { ok: false, code: 'invalid_response', http_status: 200 } : { ok: true, data };
}

type JsonObject = Record<string, unknown>;

/**
 * A GraphQL answer with `errors` that all concern optional datasets of the account (each error's `path`
 * is `viewer.accounts.0.<optional dataset>...`): the same answer with those datasets removed, so only
 * their rows read "无数据" and every other row (and so the guard) still parses. When one dataset fails
 * (token scope, entitlement, a per-dataset outage), GraphQL answers it as null next to an `errors`
 * entry with its path. Any other error (no path, another dataset, the whole account) returns null:
 * the answer stays `graphql_error`, as before.
 */
function withoutFailedOptionalDatasets(body: JsonObject, errors: readonly unknown[]): JsonObject | null {
  const failed = new Set<string>();
  for (const error of errors) {
    const path: unknown = isObject(error) ? error.path : undefined;
    if (!Array.isArray(path)) return null;
    const steps = path as readonly unknown[];
    if (steps[0] !== 'viewer' || steps[1] !== 'accounts' || steps[2] !== 0) return null;
    const name = steps[3];
    if (typeof name !== 'string' || !OPTIONAL_DATASETS.has(name as Dataset)) return null;
    failed.add(name);
  }
  if (!isObject(body.data) || !isObject(body.data.viewer)) return null;
  const accounts: unknown = body.data.viewer.accounts;
  if (!Array.isArray(accounts)) return null;
  const [first, ...rest] = accounts as readonly unknown[];
  if (!isObject(first)) return null;
  const account = Object.fromEntries(Object.entries(first).filter(([name]) => !failed.has(name)));
  return { data: { ...body.data, viewer: { ...body.data.viewer, accounts: [account, ...rest] } } };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-negative finite number, else 0. */
function num(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function field(row: unknown, group: string, name: string): number {
  if (!isObject(row)) return 0;
  const section = row[group];
  return isObject(section) ? num(section[name]) : 0;
}

/** The breakdown key of a row without the dimension (never a registry match). */
export const UNKNOWN_DIMENSION = BREAKDOWN_UNCLASSIFIED;

function dimension(row: unknown, name: string): string {
  if (!isObject(row) || !isObject(row.dimensions)) return UNKNOWN_DIMENSION;
  const value = row.dimensions[name];
  // Script names, database/namespace IDs, bucket names and AI model IDs only; bounded for storage.
  return typeof value === 'string' && value !== '' ? value.slice(0, 80) : UNKNOWN_DIMENSION;
}

/**
 * The quota rows whose breakdown parseUsage keys by a storage identifier (databaseId, namespaceId,
 * bucketName); the others are keyed by scriptName (workers_requests, do_requests) or modelId, and
 * do_storage has none.
 */
export const BREAKDOWN_RESOURCE_KIND: Readonly<Partial<Record<QuotaResource, StorageKind>>> = {
  d1_rows_read: 'd1',
  d1_rows_written: 'd1',
  d1_storage: 'd1',
  d1_database_max: 'd1',
  do_duration: 'do',
  do_rows_read: 'do',
  do_rows_written: 'do',
  r2_class_a: 'r2',
  r2_class_b: 'r2',
  r2_storage: 'r2',
};

interface Measured {
  readonly used: number | null;
  readonly truncated: boolean;
  readonly breakdown: Map<string, number>;
}

function sumBy(rows: readonly unknown[], dataset: Dataset, value: (row: unknown) => number, by: (row: unknown) => string): Measured {
  const breakdown = new Map<string, number>();
  let used = 0;
  for (const row of rows) {
    const v = value(row);
    used += v;
    const key = by(row);
    breakdown.set(key, (breakdown.get(key) ?? 0) + v);
  }
  return { used, truncated: rows.length >= DATASET_LIMITS[dataset], breakdown };
}

/** Daily rows are not projected in the first hours of the UTC day, where one early job dominates. */
export const DAILY_PROJECTION_AFTER_MS = 3 * HOUR_MS;

/**
 * Linear end-of-period projection (design.md §5.2): used / elapsed × period, a straight-line estimate,
 * not a forecast; null when too little of the period has passed.
 */
export function projection(period: QuotaRow['period'], used: number | null, now: number): number | null {
  if (used === null) return null;
  if (period === 'daily') {
    const elapsed = now - startOfUtcDay(now);
    return elapsed < DAILY_PROJECTION_AFTER_MS ? null : round1((used * DAY_MS) / elapsed);
  }
  if (period === 'monthly') {
    const elapsedDays = (now - startOfUtcMonth(now)) / DAY_MS;
    return elapsedDays < 1 ? null : round1((used * daysInUtcMonth(now)) / elapsedDays);
  }
  return null;
}

function quotaRow(id: QuotaResource, measured: Measured, now: number): QuotaRow {
  const allowance = ALLOWANCES[id];
  const used = measured.used === null ? null : round1(measured.used);
  const projected = projection(allowance.period, used, now);
  const percentOf = (value: number | null): number | null => (value === null ? null : round1((value / allowance.limit) * 100));
  return {
    id,
    period: allowance.period,
    unit: allowance.unit,
    used,
    limit: allowance.limit,
    percent: percentOf(used),
    projected,
    projected_percent: percentOf(projected),
    guard_trigger: allowance.guardTrigger,
    truncated: measured.truncated,
    breakdown: [...measured.breakdown]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, QUOTA_BREAKDOWN_MAX)
      .map(([name, value]) => ({ name, value: round1(value) })),
    source: allowance.source,
  };
}

/** The quota rows of a GraphQL response body (design.md §7.3); null when its shape is wrong. */
export function parseUsage(body: unknown, now: number): UsageData | null {
  if (!isObject(body) || !isObject(body.data) || !isObject(body.data.viewer)) return null;
  const accounts = body.data.viewer.accounts;
  if (!Array.isArray(accounts) || !isObject(accounts[0])) return null;
  const account = accounts[0];
  const sets = {} as Record<Dataset, unknown[]>;
  const missing = new Set<Dataset>();
  for (const name of Object.keys(DATASET_LIMITS) as Dataset[]) {
    const value = account[name];
    if (!Array.isArray(value)) {
      if (!OPTIONAL_DATASETS.has(name)) return null;
      missing.add(name);
      sets[name] = [];
      continue;
    }
    sets[name] = value as unknown[];
  }

  const measured = new Map<QuotaResource, Measured>();
  const script = (row: unknown): string => dimension(row, 'scriptName');
  const database = (row: unknown): string => dimension(row, 'databaseId');
  const namespace = (row: unknown): string => dimension(row, 'namespaceId');
  const bucket = (row: unknown): string => dimension(row, 'bucketName');

  measured.set('workers_requests', sumBy(sets.workers, 'workers', (r) => field(r, 'sum', 'requests'), script));
  measured.set('d1_rows_read', sumBy(sets.d1, 'd1', (r) => field(r, 'sum', 'rowsRead'), database));
  measured.set('d1_rows_written', sumBy(sets.d1, 'd1', (r) => field(r, 'sum', 'rowsWritten'), database));
  const d1Storage = sumBy(sets.d1s, 'd1s', (r) => field(r, 'max', 'databaseSizeBytes'), database);
  const storageEmpty = (m: Measured, rows: readonly unknown[]): Measured => (rows.length === 0 ? { ...m, used: null } : m);
  measured.set('d1_storage', storageEmpty(d1Storage, sets.d1s));
  measured.set('d1_database_max', {
    ...d1Storage,
    used: sets.d1s.length === 0 ? null : Math.max(...d1Storage.breakdown.values()),
  });
  measured.set('do_requests', sumBy(sets.doInv, 'doInv', (r) => field(r, 'sum', 'requests'), script));
  measured.set(
    'do_duration',
    sumBy(sets.doPer, 'doPer', (r) => (field(r, 'sum', 'activeTime') / 1e6) * DO_DURATION_GB, namespace),
  );
  measured.set('do_rows_read', sumBy(sets.doPer, 'doPer', (r) => field(r, 'sum', 'rowsRead'), namespace));
  measured.set('do_rows_written', sumBy(sets.doPer, 'doPer', (r) => field(r, 'sum', 'rowsWritten'), namespace));
  // An answered `[]` is a day without AI calls: 0 used, not "no data" (only a missing dataset is null).
  const ai = sumBy(sets.ai, 'ai', (r) => field(r, 'sum', 'totalNeurons'), (r) => dimension(r, 'modelId'));
  measured.set('ai_neurons', missing.has('ai') ? { ...ai, used: null } : ai);
  const doStorage = sets.doSto.map((r) => field(r, 'max', 'storedBytes'));
  measured.set('do_storage', {
    used: doStorage.length === 0 ? null : Math.max(...doStorage),
    truncated: sets.doSto.length >= DATASET_LIMITS.doSto,
    breakdown: new Map(),
  });

  let unclassified = 0;
  const classA = new Map<string, number>();
  const classB = new Map<string, number>();
  let sumA = 0;
  let sumB = 0;
  for (const row of sets.r2ops) {
    const action = isObject(row) && isObject(row.dimensions) ? row.dimensions.actionType : undefined;
    const requests = field(row, 'sum', 'requests');
    const name = bucket(row);
    if (typeof action === 'string' && R2_FREE.has(action)) continue;
    if (typeof action === 'string' && R2_CLASS_B.has(action)) {
      sumB += requests;
      classB.set(name, (classB.get(name) ?? 0) + requests);
      continue;
    }
    if (typeof action !== 'string' || !(R2_CLASS_A.has(action) || R2_ASSUMED_CLASS_A.has(action))) unclassified += requests;
    sumA += requests;
    classA.set(name, (classA.get(name) ?? 0) + requests);
  }
  const r2Truncated = sets.r2ops.length >= DATASET_LIMITS.r2ops;
  measured.set('r2_class_a', { used: sumA, truncated: r2Truncated, breakdown: classA });
  measured.set('r2_class_b', { used: sumB, truncated: r2Truncated, breakdown: classB });
  const r2Storage = sumBy(sets.r2sto, 'r2sto', (r) => field(r, 'max', 'payloadSize') + field(r, 'max', 'metadataSize'), bucket);
  measured.set('r2_storage', storageEmpty(r2Storage, sets.r2sto));

  const order: readonly QuotaResource[] = [
    'workers_requests', 'd1_rows_read', 'd1_rows_written', 'do_requests', 'do_duration', 'do_rows_read',
    'do_rows_written', 'ai_neurons', 'r2_class_a', 'r2_class_b', 'd1_storage', 'd1_database_max', 'do_storage', 'r2_storage',
  ];
  const rows = order.map((id) => {
    const m = measured.get(id);
    return quotaRow(id, m ?? { used: null, truncated: false, breakdown: new Map() }, now);
  });
  return {
    rows,
    unclassified_r2_operations: round1(unclassified),
    scripts: parseScripts(sets.workers, sets.doInv),
    workers_truncated: sets.workers.length >= DATASET_LIMITS.workers,
    resources: parseResources(sets),
  };
}

/** A non-negative finite number, else null (a quantile the dataset did not report). */
function optional(row: unknown, group: string, name: string): number | null {
  if (!isObject(row)) return null;
  const section = row[group];
  if (!isObject(section)) return null;
  const value = section[name];
  const n = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

interface ScriptAcc {
  requests: number;
  errors: number;
  subrequests: number;
  cpu_p50_us: number | null;
  cpu_p99_us: number | null;
  do_requests: number | null;
  do_errors: number | null;
}

const maxOrNull = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/**
 * Per-script rows: `workers` (one row per scriptName; a repeated name is summed, its quantiles take the
 * larger value) joined with `doInv` by scriptName. A script only in `doInv` (a class whose Worker gets
 * no requests of its own, such as todofy-core) is kept with 0 Worker requests.
 */
function parseScripts(workers: readonly unknown[], doInv: readonly unknown[]): ScriptUsage[] {
  const acc = new Map<string, ScriptAcc>();
  const get = (script: string): ScriptAcc => {
    let entry = acc.get(script);
    if (entry === undefined) {
      entry = { requests: 0, errors: 0, subrequests: 0, cpu_p50_us: null, cpu_p99_us: null, do_requests: null, do_errors: null };
      acc.set(script, entry);
    }
    return entry;
  };
  for (const row of workers) {
    const entry = get(dimension(row, 'scriptName'));
    entry.requests += field(row, 'sum', 'requests');
    entry.errors += field(row, 'sum', 'errors');
    entry.subrequests += field(row, 'sum', 'subrequests');
    entry.cpu_p50_us = maxOrNull(entry.cpu_p50_us, optional(row, 'quantiles', 'cpuTimeP50'));
    entry.cpu_p99_us = maxOrNull(entry.cpu_p99_us, optional(row, 'quantiles', 'cpuTimeP99'));
  }
  for (const row of doInv) {
    const entry = get(dimension(row, 'scriptName'));
    entry.do_requests = (entry.do_requests ?? 0) + field(row, 'sum', 'requests');
    entry.do_errors = (entry.do_errors ?? 0) + field(row, 'sum', 'errors');
  }
  return [...acc]
    .map(([script, v]) => ({ script, ...v }))
    .sort((a, b) => b.requests - a.requests || (b.do_requests ?? 0) - (a.do_requests ?? 0) || a.script.localeCompare(b.script));
}

/** D1 by databaseId (analytics ∪ storage), DO by namespaceId, R2 by bucketName (operations ∪ storage). */
function parseResources(sets: Record<Dataset, unknown[]>): ResourceUsage {
  const d1 = new Map<string, { size_bytes: number | null; rows_read: number; rows_written: number }>();
  const d1Row = (id: string) => {
    let row = d1.get(id);
    if (row === undefined) {
      row = { size_bytes: null, rows_read: 0, rows_written: 0 };
      d1.set(id, row);
    }
    return row;
  };
  for (const row of sets.d1) {
    const entry = d1Row(dimension(row, 'databaseId'));
    entry.rows_read += field(row, 'sum', 'rowsRead');
    entry.rows_written += field(row, 'sum', 'rowsWritten');
  }
  for (const row of sets.d1s) {
    const entry = d1Row(dimension(row, 'databaseId'));
    entry.size_bytes = maxOrNull(entry.size_bytes, field(row, 'max', 'databaseSizeBytes'));
  }

  const dObj = new Map<string, { rows_read: number; rows_written: number }>();
  for (const row of sets.doPer) {
    const id = dimension(row, 'namespaceId');
    const entry = dObj.get(id) ?? { rows_read: 0, rows_written: 0 };
    entry.rows_read += field(row, 'sum', 'rowsRead');
    entry.rows_written += field(row, 'sum', 'rowsWritten');
    dObj.set(id, entry);
  }

  const r2 = new Map<string, { size_bytes: number | null; class_a: number; class_b: number }>();
  const r2Row = (row: unknown) => {
    const name = isObject(row) && isObject(row.dimensions) && typeof row.dimensions.bucketName === 'string' && row.dimensions.bucketName !== ''
      ? row.dimensions.bucketName.slice(0, 80)
      : 'unclassified';
    let entry = r2.get(name);
    if (entry === undefined) {
      entry = { size_bytes: null, class_a: 0, class_b: 0 };
      r2.set(name, entry);
    }
    return entry;
  };
  for (const row of sets.r2ops) {
    const action = isObject(row) && isObject(row.dimensions) ? row.dimensions.actionType : undefined;
    if (typeof action === 'string' && R2_FREE.has(action)) continue;
    const entry = r2Row(row);
    const requests = field(row, 'sum', 'requests');
    // As the quota rows: Class B by the list, anything else (unknown included) Class A.
    if (typeof action === 'string' && R2_CLASS_B.has(action)) entry.class_b += requests;
    else entry.class_a += requests;
  }
  for (const row of sets.r2sto) {
    const entry = r2Row(row);
    entry.size_bytes = (entry.size_bytes ?? 0) + field(row, 'max', 'payloadSize') + field(row, 'max', 'metadataSize');
  }

  const bySize = <T extends { id: string; size_bytes: number | null }>(a: T, b: T): number => (b.size_bytes ?? -1) - (a.size_bytes ?? -1) || a.id.localeCompare(b.id);
  return {
    d1: [...d1].map(([id, v]) => ({ id, ...v, rows_read: round1(v.rows_read), rows_written: round1(v.rows_written) })).sort(bySize),
    do: [...dObj]
      .map(([id, v]) => ({ id, rows_read: round1(v.rows_read), rows_written: round1(v.rows_written) }))
      .sort((a, b) => b.rows_written - a.rows_written || b.rows_read - a.rows_read || a.id.localeCompare(b.id)),
    r2: [...r2].map(([id, v]) => ({ id, ...v, class_a: round1(v.class_a), class_b: round1(v.class_b) })).sort(bySize),
  };
}
