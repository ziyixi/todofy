/**
 * Account-wide Workers Free usage from the Cloudflare GraphQL Analytics API (docs/design.md §5.2, §7).
 *
 * CF_ANALYTICS_TOKEN is used only here, only as the bearer token of one POST to GRAPHQL_URL (a
 * constant, not configuration). It is never logged, stored, echoed or sent anywhere else, and remote
 * response text never leaves this module: failures become codes.
 */
import type { QuotaResourceId, QuotaRow } from './api-types.ts';
import { ALLOWANCES, DO_DURATION_GB } from './limits.ts';
import { DAY_MS, HOUR_MS, daysInUtcMonth, isoSeconds, round1, startOfUtcDay, startOfUtcMonth, utcDay, utcMonthStart } from './time.ts';

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
export const GRAPHQL_TIMEOUT_MS = 15_000;
export const GRAPHQL_MAX_BYTES = 1_000_000;

/** Verbatim copy of the query verified against the live account on 2026-09-29 (design.md §7.2). */
export const USAGE_QUERY = `query($a: string!, $day: Date!, $start: Time!, $end: Time!, $month: Date!) { viewer { accounts(filter: {accountTag: $a}) {
  workers: workersInvocationsAdaptive(limit: 20, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests errors subrequests } dimensions { scriptName } quantiles { cpuTimeP50 cpuTimeP99 } }
  d1: d1AnalyticsAdaptiveGroups(limit: 10, filter: {date: $day}) { sum { rowsRead rowsWritten readQueries writeQueries } dimensions { databaseId } }
  d1s: d1StorageAdaptiveGroups(limit: 10, filter: {date: $day}) { max { databaseSizeBytes } dimensions { databaseId } }
  doInv: durableObjectsInvocationsAdaptiveGroups(limit: 10, filter: {date: $day}) { sum { requests errors } dimensions { scriptName } }
  doPer: durableObjectsPeriodicGroups(limit: 10, filter: {date: $day}) { sum { activeTime rowsRead rowsWritten cpuTime storageDeletes storageReadUnits storageWriteUnits } dimensions { namespaceId } }
  doSto: durableObjectsStorageGroups(limit: 5, filter: {date: $day}) { max { storedBytes } }
  r2ops: r2OperationsAdaptiveGroups(limit: 50, filter: {date_geq: $month, date_leq: $day}) { sum { requests } dimensions { actionType bucketName } }
  r2sto: r2StorageAdaptiveGroups(limit: 10, filter: {date: $day}) { max { payloadSize metadataSize objectCount } dimensions { bucketName } }
} } }`;

/** The `limit` of each dataset in USAGE_QUERY: a dataset returning this many rows is truncated. */
const DATASET_LIMITS = { workers: 20, d1: 10, d1s: 10, doInv: 10, doPer: 10, doSto: 5, r2ops: 50, r2sto: 10 } as const;
type Dataset = keyof typeof DATASET_LIMITS;

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

export type UsageErrorCode = `http_${string}` | 'graphql_error' | 'network_error' | 'timeout' | 'invalid_response' | 'not_configured';

export interface UsageData {
  readonly rows: QuotaRow[];
  readonly unclassified_r2_operations: number;
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
    return { ok: false, code: 'graphql_error', http_status: 200 };
  }
  const data = parseUsage(body, now);
  return data === null ? { ok: false, code: 'invalid_response', http_status: 200 } : { ok: true, data };
}

type JsonObject = Record<string, unknown>;

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

function dimension(row: unknown, name: string): string {
  if (!isObject(row) || !isObject(row.dimensions)) return 'unknown';
  const value = row.dimensions[name];
  // Script names, database/namespace IDs and bucket names only; bounded for storage.
  return typeof value === 'string' && value !== '' ? value.slice(0, 80) : 'unknown';
}

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

function quotaRow(id: QuotaResourceId, measured: Measured, now: number): QuotaRow {
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
      .slice(0, 5)
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
  for (const name of Object.keys(DATASET_LIMITS) as Dataset[]) {
    const value = account[name];
    if (!Array.isArray(value)) return null;
    sets[name] = value as unknown[];
  }

  const measured = new Map<QuotaResourceId, Measured>();
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
    if (typeof action !== 'string' || !R2_CLASS_A.has(action)) unclassified += requests;
    sumA += requests;
    classA.set(name, (classA.get(name) ?? 0) + requests);
  }
  const r2Truncated = sets.r2ops.length >= DATASET_LIMITS.r2ops;
  measured.set('r2_class_a', { used: sumA, truncated: r2Truncated, breakdown: classA });
  measured.set('r2_class_b', { used: sumB, truncated: r2Truncated, breakdown: classB });
  const r2Storage = sumBy(sets.r2sto, 'r2sto', (r) => field(r, 'max', 'payloadSize') + field(r, 'max', 'metadataSize'), bucket);
  measured.set('r2_storage', storageEmpty(r2Storage, sets.r2sto));

  const order: readonly QuotaResourceId[] = [
    'workers_requests', 'd1_rows_read', 'd1_rows_written', 'do_requests', 'do_duration', 'do_rows_read',
    'do_rows_written', 'r2_class_a', 'r2_class_b', 'd1_storage', 'd1_database_max', 'do_storage', 'r2_storage',
  ];
  const rows = order.map((id) => {
    const m = measured.get(id);
    return quotaRow(id, m ?? { used: null, truncated: false, breakdown: new Map() }, now);
  });
  return { rows, unclassified_r2_operations: round1(unclassified) };
}
