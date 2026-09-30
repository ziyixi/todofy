/**
 * Shared parts of the owner API of the Worker "home" (docs/design.md §6): errors, CSRF, usage, guard,
 * canary and digest views, which the v2 responses (api-v2-types.ts, docs/design-v2.md §5) embed. The
 * v1 routes and their overview response are retired. Shared by the Worker and the web UI, which
 * imports this file by relative path (`../../worker/src/api-types.ts`). Rules, because both toolchains
 * compile it: types and plain constants only, `import type` for everything imported, erasable syntax,
 * no Workers or DOM types, no runtime imports.
 *
 * Every timestamp is RFC 3339 UTC (`2026-09-29T16:00:00.000Z`); the UI shows it in the browser's time
 * zone. Every `code` is a machine code (`^[a-z][a-z0-9_]{0,47}$`); the UI maps known codes to Chinese
 * labels and shows unknown ones as they are. No response carries mail content, addresses, tokens or
 * remote response text.
 */
import type {
  CanaryDelivery,
  CanaryResult,
  GuardLevel,
  GuardState,
  OpsApp,
  OpsReportItem,
  OpsReportReceipt,
  OpsSeverity,
  OpsStatus,
} from '../../../contracts/ops-v1/ops-v1.ts';

export type { OpsApp, OpsSeverity, OpsStatus, GuardLevel, GuardState, OpsReportItem, OpsReportReceipt };

/** RFC 3339 UTC. */
export type Iso = string;

/** Guard thresholds (percent of a Free allowance, actual usage). */
export const GUARD_SHED_PERCENT = 80;
export const GUARD_CLEAR_PERCENT = 70;
/** Quota items become critical at this percent (warning from GUARD_SHED_PERCENT). */
export const QUOTA_CRITICAL_PERCENT = 95;
/** Manual canary runs per UTC day. */
export const CANARY_MANUAL_PER_DAY = 3;
/** Canary runs shown in the flows and ops views (newest first). */
export const CANARY_RECENT_RUNS = 14;
/**
 * The info item the attention strip shows while CANARY_ENABLED=false. Page only: the digest carries
 * warning and critical items, so it never reaches Todofy's reportOps.
 */
export const CANARY_DISABLED_ITEM = { source: 'dashboard', code: 'canary_disabled', severity: 'info' } as const;
/** Minimum seconds between two owner refreshes of the home scope (`GET /api/v2/home?refresh=1`). */
export const REFRESH_MIN_INTERVAL_SECONDS = 60;

// ---------------------------------------------------------------------------------------------------
// Errors: every non-2xx API response has this body (plus private headers and no-store).

export type ApiErrorCode =
  | 'unauthorized' // 401: no or invalid Access token, or not the owner
  | 'access_not_configured' // 503: ACCESS_* configuration invalid
  | 'not_configured' // 503: CSRF_SIGNING_KEY missing or invalid
  | 'csrf_failed' // 403: Origin, header/cookie or signature check failed
  | 'bad_request' // 400: body not JSON, wrong shape
  | 'not_found' // 404: unknown /api/ path
  | 'method_not_allowed' // 405
  | 'canary_active' // 409: a canary run is still in progress
  | 'canary_disabled' // 409: CANARY_ENABLED=false (DASHBOARD_CANARY_ENABLED); no run may start
  | 'canary_limit' // 429: CANARY_MANUAL_PER_DAY manual runs already started today
  | 'unavailable'; // 503: the Durable Object or an internal call failed

export interface ApiError {
  readonly error: {
    readonly code: ApiErrorCode;
    /** Short Chinese message for the UI; never contains request data. */
    readonly message: string;
    /** 16 lowercase hex characters, also in the Worker's single log line for this error. */
    readonly request_id: string;
  };
}

// ---------------------------------------------------------------------------------------------------
// GET /api/v2/csrf -> 200 CsrfResponse, plus `Set-Cookie: home_csrf=<token>; Path=/; HttpOnly;
// SameSite=Strict; Max-Age=43200; Secure`. Mutations send the token as `X-CSRF-Token`.

export interface CsrfResponse {
  readonly token: string;
}

// ---------------------------------------------------------------------------------------------------
// Parts of the v2 views.

/** Worst of the attention items (ok, warning, critical), `unknown` before anything ran. */
export type OverallLevel = 'ok' | 'warning' | 'critical' | 'unknown';

export type AppErrorCode = 'unavailable' | 'busy' | 'invalid_input' | 'timeout' | 'invalid_output' | 'not_configured';

/** The last ops-v1 status() attempt of an app and its last successful answer (ops view). */
export interface AppStatusView {
  /** Result of the last status() attempt. */
  readonly reachable: boolean | null;
  readonly checked_at: Iso | null;
  /** Error code of the last failed attempt, null when it succeeded. */
  readonly error: AppErrorCode | null;
  readonly consecutive_failures: number;
  /** Last successful status() (may be older than checked_at when the last attempt failed). */
  readonly status: OpsStatus | null;
  readonly status_at: Iso | null;
}

// ---- usage and quota ------------------------------------------------------------------------------

export type QuotaResourceId =
  | 'workers_requests'
  | 'd1_rows_read'
  | 'd1_rows_written'
  | 'do_requests'
  | 'do_duration'
  | 'do_rows_read'
  | 'do_rows_written'
  | 'r2_class_a'
  | 'r2_class_b'
  | 'd1_storage'
  | 'd1_database_max'
  | 'do_storage'
  | 'r2_storage';

export const QUOTA_RESOURCES: readonly QuotaResourceId[] = [
  'workers_requests',
  'd1_rows_read',
  'd1_rows_written',
  'do_requests',
  'do_duration',
  'do_rows_read',
  'do_rows_written',
  'r2_class_a',
  'r2_class_b',
  'd1_storage',
  'd1_database_max',
  'do_storage',
  'r2_storage',
];

/** daily: resets 00:00 UTC; monthly: UTC calendar month to date; storage: current size. */
export type QuotaPeriod = 'daily' | 'monthly' | 'storage';
export type QuotaUnit = 'requests' | 'rows' | 'gb_seconds' | 'operations' | 'bytes';

export interface QuotaRow {
  readonly id: QuotaResourceId;
  readonly period: QuotaPeriod;
  readonly unit: QuotaUnit;
  /** Account-wide usage in `unit`; null when the dataset returned no data. */
  readonly used: number | null;
  /** The Workers Free allowance in `unit` (docs/design.md §7). */
  readonly limit: number;
  /** used / limit x 100, one decimal; null when used is null. */
  readonly percent: number | null;
  /** Linear end-of-period projection; null for storage and when too little of the period has passed. */
  readonly projected: number | null;
  readonly projected_percent: number | null;
  /** Counts for the guard rule (daily resources and R2 operations; never storage). */
  readonly guard_trigger: boolean;
  /** The dataset returned as many rows as the query's limit: `used` is a lower bound. */
  readonly truncated: boolean;
  /** Largest contributors, at most 5: script name, D1 database ID, DO namespace ID or bucket name. */
  readonly breakdown: readonly { readonly name: string; readonly value: number }[];
  /** Cloudflare documentation URL of the limit. */
  readonly source: string;
}

export type UsageStatus = 'ok' | 'stale' | 'unavailable' | 'not_configured';

export interface UsageView {
  /** ok: fetched for the current UTC day within 90 min; stale: older; unavailable: never fetched. */
  readonly status: UsageStatus;
  readonly fetched_at: Iso | null;
  /** UTC day (YYYY-MM-DD) and month start (YYYY-MM-01) the rows describe. */
  readonly day: string | null;
  readonly month: string | null;
  /** http_<status>, graphql_error, network_error, timeout, invalid_response, not_configured. */
  readonly last_error: string | null;
  readonly last_error_at: Iso | null;
  readonly consecutive_failures: number;
  readonly rows: readonly QuotaRow[];
  /** R2 operations whose actionType is in neither documented class; counted as Class A. */
  readonly unclassified_r2_operations: number;
}

// ---- guard ----------------------------------------------------------------------------------------

export type GuardSource = 'auto' | 'owner' | 'none';

export interface GuardOverride {
  /** shed: forced shed; normal: auto-shed suppressed. */
  readonly level: GuardLevel;
  readonly until: Iso;
  readonly set_at: Iso;
}

export interface GuardAppView {
  /** The app's effective guard as last seen (setGuard result, or status().guard if newer). */
  readonly state: GuardState | null;
  readonly last_call_at: Iso | null;
  /** Error code of the last failed setGuard call, null after a success. */
  readonly last_error: AppErrorCode | null;
}

export interface GuardView {
  /** What the dashboard wants both apps to have now. */
  readonly desired: {
    readonly level: GuardLevel;
    readonly reason: string | null;
    readonly until: Iso | null;
    readonly source: GuardSource;
  };
  readonly override: GuardOverride | null;
  readonly thresholds: { readonly shed_percent: number; readonly clear_percent: number };
  readonly apps: { readonly 'mail-hero': GuardAppView; readonly todofy: GuardAppView };
}

// ---- canary ---------------------------------------------------------------------------------------

export type CanaryKind = 'scheduled' | 'manual';
export type CanaryPhase = 'starting' | 'delivering' | 'consuming' | 'done';
export type CanaryOutcome = 'ok' | 'failed' | 'skipped';
export type CanaryStage = 'start' | 'delivery' | 'consumer';

export interface CanaryRun {
  /** `canary-YYYY-MM-DD` (scheduled) or `canary-manual-YYYYMMDDTHHMMSSZ`. */
  readonly run_id: string;
  readonly kind: CanaryKind;
  /** UTC day the run belongs to. */
  readonly day: string;
  readonly phase: CanaryPhase;
  /** Null while phase is not `done`. */
  readonly outcome: CanaryOutcome | null;
  /** Where a failed or skipped run stopped. */
  readonly stage: CanaryStage | null;
  /** Failure or skip code: an app code (http_503, llm_quota, send_paused, processing_paused, ...) or
   * a dashboard code (timeout, not_seen, unknown_event, unreachable, canary_consumer_missing, ...). */
  readonly code: string | null;
  readonly event_id: string | null;
  readonly created_at: Iso;
  readonly queued_at: Iso | null;
  readonly delivered_at: Iso | null;
  readonly completed_at: Iso | null;
  readonly finished_at: Iso | null;
  /** Start phase: created_at + 2 h; after queuing: queued_at + 2 h. */
  readonly deadline_at: Iso;
  readonly delivery: {
    readonly state: CanaryDelivery['state'] | null;
    readonly attempts: number;
    readonly last_http_status: number | null;
    readonly error_code: string | null;
  };
  readonly consumer: {
    readonly state: CanaryResult['state'] | null;
    readonly waiting_code: string | null;
    readonly error_code: string | null;
  };
  /** Ticks (and the manual start) that called an app for this run. */
  readonly polls: number;
  /**
   * While `starting`: why Mail Hero has not queued it yet — its paused/unavailable reason
   * (send_paused, no_endpoint, ...), a call error (unavailable, busy, timeout, ...) or
   * `status_unavailable`; null once queued.
   */
  readonly start_code: string | null;
  /** Error of the last delivery/result call that failed (the next tick retries), null after an answer. */
  readonly last_call_error: AppErrorCode | null;
}

export interface CanaryView {
  /**
   * CANARY_ENABLED (GitHub variable DASHBOARD_CANARY_ENABLED). False: no scheduled or manual run
   * starts; a run already in progress is still polled to its end.
   */
  readonly enabled: boolean;
  readonly hour_utc: number;
  /**
   * Next scheduled start (first tick at or after hour_utc on a day without a scheduled run); null while
   * the canary is disabled.
   */
  readonly next_scheduled_at: Iso | null;
  /** The most recent run of the current UTC day (scheduled or manual), if any. */
  readonly today: CanaryRun | null;
  /** The run in progress, if any (at most one at a time). */
  readonly active: CanaryRun | null;
  /** At most CANARY_RECENT_RUNS, newest first. */
  readonly recent: readonly CanaryRun[];
  readonly manual_today: number;
  readonly manual_limit: number;
}

// ---- digest ---------------------------------------------------------------------------------------

export interface DigestView {
  /** The report of the last tick: warning and critical items only, at most 20, critical first. */
  readonly items: readonly OpsReportItem[];
  /** Todofy advertises `ops_digest` (last status); reports are sent only then. */
  readonly enabled: boolean;
  readonly last_sent_at: Iso | null;
  /** generated_at of the last report Todofy accepted. */
  readonly last_generated_at: Iso | null;
  readonly last_receipt: OpsReportReceipt | null;
  readonly last_error: AppErrorCode | null;
  /** Latest time the next report goes out even without a change (last_sent_at + 6 h). */
  readonly next_due_at: Iso | null;
}

// ---------------------------------------------------------------------------------------------------
// POST /api/v2/canary -> 202 CanaryStartResponse; POST /api/v2/guard {level} (GuardRequest): `shed`
// forces shed on both apps for 24 h (until cleared), `normal` ends a forced shed and suppresses the
// automatic shed until the next UTC midnight (request and errors: api-v2-types.ts).

export interface CanaryStartResponse {
  readonly run: CanaryRun;
}

export interface GuardRequest {
  readonly level: GuardLevel;
}

// ---------------------------------------------------------------------------------------------------
// GET /health (no app auth; Access still guards the host) -> 200 HealthResponse

export interface HealthResponse {
  readonly service: 'home';
  readonly status: 'ok';
  readonly build: string;
}
