/**
 * The types and constants of the owner API (proto/dashboard/ui/v1, docs/design-v2.md §5) that the Worker and the
 * web UI share. The UI imports this file by relative path (`../../worker/src/api-types.ts`), so it holds types and
 * plain constants only: `import type` for everything imported, erasable syntax, no Workers or DOM types, no runtime
 * imports. No hostname may appear here: URLs reach the UI only through GetRegistry (web/src/test/no-external.test.ts,
 * web/scripts/check-dist.mjs).
 *
 * Every message type is the generated wire JSON type of dashboard.ui.v1 (proto/tools/gen_wire_ts.py): the JSON
 * HomeState writes and the UI reads, field for field. This file only names them for the code (aliases and the
 * parts of a message a builder fills in), and adds what the IDL does not describe:
 *
 * - the transport outside the service: GET /api/csrf (CsrfResponse), GET /health (HealthResponse), and the error
 *   envelope of the retired /api/v2 routes, which answer 410 with a reload message for one release (LegacyApiError);
 * - OpsApp, the apps this build binds (the IDL's list is open: an app may join within ops-v1);
 * - the constants of the dashboard's rules (thresholds, budgets, bounds), which are behaviour, not wire.
 *
 * The value lists of the IDL's enums and allowed lists are read from the descriptors where code needs them
 * (`wireEnum`, `fieldRules` in @ziyixi/proto/wire-json), never copied here.
 *
 * Routes (DashboardUiService; Access + owner check, private no-store headers, google.rpc.Status errors):
 *
 * | Method                | HTTP                                  | Served by      | Budget per call                |
 * | --------------------- | ------------------------------------- | -------------- | ------------------------------ |
 * | GetRegistry           | GET  /api/v1/registry                 | Worker (no DO) | ≤ 14 KiB; ETag "<build>" → 304 |
 * | GetHomeView           | GET  /api/v1/homeView                 | DO, 1 call     | ≤ 10 KiB; ≤ 28 rows read       |
 * | GetFlowsView          | GET  /api/v1/flowsView                | DO, 1 call     | ≤ 20 KiB; ≤ 28 rows read       |
 * | GetCloudflareView     | GET  /api/v1/cloudflareView           | DO, 1 call     | ≤ 16 KiB; ≤ 30 rows read       |
 * | GetOpsView            | GET  /api/v1/opsView                  | DO, 1 call     | ≤ 24 KiB; ≤ 28 rows read       |
 * | RefreshHomeView       | POST /api/v1/homeView:refresh         | DO             | CSRF + Origin; once a minute   |
 * | RefreshCloudflareView | POST /api/v1/cloudflareView:refresh   | DO             | CSRF + Origin; once a minute   |
 * | OverrideGuard         | POST /api/v1/guard:override           | DO             | CSRF + Origin; request_id      |
 * | RunCanary             | POST /api/v1/canaries/mail-todofy:run | DO             | CSRF + Origin; request_id      |
 *
 * The views carry `ETag: "<rev>-<hash>"` (the hash covers the body except generated_at) and answer 304 to a matching
 * If-None-Match; sizes are a normal day's (VIEW_BODY_BUDGET, VIEW_BODY_MAX for a bad day), rows are VIEW_ROWS_READ
 * (measured in workerd).
 */
import type {
  Attention,
  AttentionItem,
  Badges,
  HeldItem,
  Level,
  Refresh,
  Target,
  View,
} from '@ziyixi/proto/dashboard/ui/v1/attention_wire';
import type {
  CanaryKind,
  CanaryOutcome,
  CanaryPhase,
  CanaryRun,
  CanaryRunConsumer,
  CanaryRunDelivery,
  CanaryStage,
  CanaryView,
  FlowCanaryView,
} from '@ziyixi/proto/dashboard/ui/v1/canary_wire';
import type {
  CloudflareView,
  Drift,
  Drift_State,
  DriftCategory,
  DriftCounts,
  DriftFinding,
  ResourceRow,
  WorkerRow,
} from '@ziyixi/proto/dashboard/ui/v1/cloudflare_view_wire';
import type { OverrideGuardRequest, OverrideGuardResponse, RunCanaryRequest, RunCanaryResponse } from '@ziyixi/proto/dashboard/ui/v1/dashboard_ui_service_wire';
import type {
  CanaryBadge,
  FlowState,
  FlowsView,
  StageAnalytics,
  StageCounter,
  StageProbe,
  StageSignal,
  StageState,
  UnclassifiedSignal,
} from '@ziyixi/proto/dashboard/ui/v1/flows_view_wire';
import type { GuardAppView, GuardDesired, GuardOverride, GuardSource, GuardThresholds, GuardView } from '@ziyixi/proto/dashboard/ui/v1/guard_wire';
import type {
  CloudflareSummary,
  Coverage,
  EntryState,
  FirstIssue,
  FlowSummary,
  Freshness,
  HomeDigest,
  HomeView,
  TileMetric,
  TopSignal,
} from '@ziyixi/proto/dashboard/ui/v1/home_view_wire';
import type { AppDetail, Digest, OpsView } from '@ziyixi/proto/dashboard/ui/v1/ops_view_wire';
import type {
  CanaryDef,
  CanaryStageMap,
  EntryGroup,
  Flow,
  FlowGroup,
  Registry,
  RegistryEntry,
  RegistryResource,
  RegistryWorker,
  Stage,
  TileMetricDef,
  TileMetricKind,
} from '@ziyixi/proto/dashboard/ui/v1/registry_wire';
import type { QuotaBreakdownItem, QuotaPeriod, QuotaResource, QuotaRow, QuotaUnit, StorageKind, Usage, Usage_State } from '@ziyixi/proto/dashboard/ui/v1/usage_wire';
import type { GuardLevel, GuardState, OpsReportItem, OpsReportReceipt, OpsStatus, Severity, Signal } from '@ziyixi/proto/ops/v1/ops_wire';

// ---- the messages of dashboard.ui.v1 (generated) -------------------------------------------------------------

export type {
  AppDetail,
  Attention,
  AttentionItem,
  Badges,
  CanaryBadge,
  CanaryDef,
  CanaryKind,
  CanaryOutcome,
  CanaryPhase,
  CanaryRun,
  CanaryRunConsumer,
  CanaryRunDelivery,
  CanaryStage,
  CanaryStageMap,
  CanaryView,
  CloudflareSummary,
  CloudflareView,
  Coverage,
  Digest,
  Drift,
  DriftCategory,
  DriftCounts,
  DriftFinding,
  EntryGroup,
  EntryState,
  FirstIssue,
  Flow,
  FlowCanaryView,
  FlowGroup,
  FlowState,
  FlowSummary,
  FlowsView,
  Freshness,
  GuardAppView,
  GuardDesired,
  GuardOverride,
  GuardSource,
  GuardThresholds,
  GuardView,
  HeldItem,
  HomeDigest,
  HomeView,
  Level,
  OpsView,
  OverrideGuardRequest,
  OverrideGuardResponse,
  QuotaBreakdownItem,
  QuotaPeriod,
  QuotaResource,
  QuotaRow,
  QuotaUnit,
  Refresh,
  Registry,
  RegistryEntry,
  RegistryResource,
  RegistryWorker,
  ResourceRow,
  RunCanaryRequest,
  RunCanaryResponse,
  Stage,
  StageAnalytics,
  StageCounter,
  StageProbe,
  StageSignal,
  StageState,
  StorageKind,
  Target,
  TileMetric,
  TileMetricDef,
  TileMetricKind,
  TopSignal,
  UnclassifiedSignal,
  Usage,
  WorkerRow,
};
export type { GuardLevel, GuardState, OpsReportItem, OpsReportReceipt, OpsStatus };

/** The state of the usage read (Usage.State). */
export type UsageState = Usage_State;
/** The state of the drift check (Drift.State). */
export type DriftState = Drift_State;
/** A view (a tab of the UI). */
export type ViewId = View;
/** The strip's level: the worst of its items (Attention.level's allowed list). */
export type OverallLevel = Attention['level'];
/** The levels that take part in a roll-up; `link` and `unmonitored` never do. */
export type RollupLevel = Exclude<Level, 'link' | 'unmonitored'>;
/** A signal's or a report item's severity (ops-v1). */
export type OpsSeverity = Severity;
/** One active condition of an app's status (ops-v1). */
export type OpsSignal = Signal;
/** An ops-v1 rejection code (invalid_input, busy, unavailable), or what the dashboard observed itself. */
export type AppErrorCode = NonNullable<AppDetail['error']>;
/** RFC 3339 UTC (the format `Timestamp` of dashboard.ui.v1 and ops-v1). */
export type Iso = string;
/** The parts of a registry entry the IDL restricts. */
export type IconKey = RegistryEntry['icon'];
export type Accent = RegistryEntry['accent'];
export type EntryGroupId = EntryGroup['id'];
export type FlowGroupId = FlowGroup['id'];
export type StatusSourceType = RegistryEntry['status_type'];

/** The fields every view shares, as HomeState's shell() fills them in (each view adds its `name` first). */
export type ShellFields = Pick<HomeView, 'generated_at' | 'rev' | 'build' | 'attention' | 'badges' | 'refresh'>;
/** An app's status as HomeState keeps it (AppDetail without the entry it belongs to). */
export type AppStatusView = Omit<AppDetail, 'entry'>;
/** The canary as HomeState builds it, before a view adds its ID (CanaryView without `id`). */
export type CanaryState = Omit<CanaryView, 'id'>;

/**
 * An app of ops-v1 that this dashboard calls: OpsStatus.app's allowed list in proto/ops/v1/ops.proto (OPS_APPS reads
 * it; ops-client.test.ts holds the two equal). The list is open on the wire (an app may join within ops-v1), so the
 * generated type of `app` is a string; this dashboard knows exactly the apps it binds.
 */
export type OpsApp = 'mail-hero' | 'todofy' | 'lab' | 'watch' | 'fleet' | 'newsletter';

// ---- transport outside the service --------------------------------------------------------------------------

/**
 * GET /api/csrf -> 200, plus `Set-Cookie: home_csrf=<token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200;
 * Secure`. Mutations send the token as `X-CSRF-Token`. Transport, not part of DashboardUiService (as Lab's and the
 * watch app's).
 */
export interface CsrfResponse {
  readonly token: string;
}

/** GET /health (no app auth; Access still guards the host) -> 200. */
export interface HealthResponse {
  readonly service: 'home';
  readonly status: 'ok';
  readonly build: string;
}

/**
 * The error envelope of the retired /api/v2 routes, which answer 410 with the reload message until 2026-11-02 (one
 * release), under the code `not_found`: the old UI shows the message only for a code it knows (http.ts LEGACY_CODES),
 * so a tab still running it tells the owner to reload. An authentication failure there keeps the old code
 * (`unauthorized`, ...; a bug is `unavailable`). Every other error is a google.rpc.Status
 * (proto/dashboard/ui/v1/errors.proto).
 */
export interface LegacyApiError {
  readonly error: {
    readonly code: string;
    /** Short Chinese message; never contains request data. */
    readonly message: string;
    /** 16 lowercase hex characters, also in the Worker's single log line for this error. */
    readonly request_id: string;
  };
}

// ---- constants shared by the Worker (evaluation) and the UI (explanations) ------------------------------------

/** Guard thresholds (percent of a Free allowance, actual usage). */
export const GUARD_SHED_PERCENT = 80;
export const GUARD_CLEAR_PERCENT = 70;
/** Quota items become critical at this percent (warning from GUARD_SHED_PERCENT). */
export const QUOTA_CRITICAL_PERCENT = 95;
/** Manual canary runs per UTC day. */
export const CANARY_MANUAL_PER_DAY = 3;
/**
 * The info item the attention strip shows while CANARY_ENABLED=false. Page only: the digest carries warning and
 * critical items, so it never reaches Todofy's reportOps.
 */
export const CANARY_DISABLED_ITEM = { source: 'dashboard', code: 'canary_disabled', severity: 'info' } as const;
/** Minimum seconds between two owner refreshes of the home scope (RefreshHomeView). */
export const REFRESH_MIN_INTERVAL_SECONDS = 60;

/**
 * Rows whose remaining allowance the UI states in words ("剩余 9,700"). Workers AI: on Workers Free calls above
 * 10,000 neurons a day fail until 00:00 UTC, and the guard does not act on it (it does not trigger shed,
 * docs/limits.md §1), so the headroom left today is the number that matters.
 */
export const QUOTA_SHOW_REMAINING: readonly QuotaResource[] = ['ai_neurons'];

/**
 * The breakdown key of a measured row without its dimension (no scriptName, databaseId, namespaceId, bucketName or
 * modelId). On a D1/DO/R2 item (`kind` set) the page reads it as 未归类 (R2: 未归类操作, like the resource table),
 * never as an ID.
 */
export const BREAKDOWN_UNCLASSIFIED = 'unknown';

/**
 * Response size budgets (bytes of the JSON body) of a normal day (test/views.test.ts: the mockup day, and the
 * Cloudflare view with 20 Workers). A bad day may exceed them: the attention strip repeats up to 20 items in every
 * view and the canary strip can hold 14 failed runs; VIEW_BODY_MAX bounds that case (20 alarms, 16 signals per app,
 * 14 failed runs, and the Cloudflare view at its row cap of idl.ts CF_VIEW_WORKERS_MAX Workers out of CF_SCRIPTS_MAX
 * remembered; all tested). HomeState logs `over_budget` when a body passes its budget.
 */
export const VIEW_BODY_MAX = 32 * 1024;
export const VIEW_BODY_BUDGET = {
  registry: 14 * 1024,
  home: 10 * 1024,
  // Six flows since the GTD loop and Paper Radar (2026-09-30): 16.1 KB on the mockup day, 17.4 KB in the
  // workerd suite's full canary history with 20 Workers.
  flows: 20 * 1024,
  cloudflare: 16 * 1024,
  ops: 24 * 1024,
} as const;

/**
 * Durable Object rows one view may read (SqlStorageCursor.rowsRead per call; the workerd suite asserts it with a
 * full 14-run canary history and 20 Workers). Every view reads the shared shell (meta, digest, the guard docs, one
 * status per ops_v1 entry) and, for the strip's observed items, what the evaluation reads (one probe document per
 * public_http entry, cf_scripts, the 14 recent canary runs); cloudflare adds the usage and drift documents. Each
 * document is read once per build (HomeState's read cache). Measured 28 / 28 / 29 / 28 (home / flows / cloudflare /
 * ops) with six ops_v1 apps and three public probes. Each additional status entry adds a row; the real workerd
 * regression test must continue to pass when the catalog grows.
 */
export const VIEW_ROWS_READ: Readonly<Record<ViewId, number>> = { home: 28, flows: 28, cloudflare: 30, ops: 28 };

/** Outbound calls one tick may make, computed from the registry (tested). Free: 50 subrequests. */
export const MAX_OUTBOUND_PER_TICK = 30;
/** Outbound calls one owner refresh may make (tested). */
export const MAX_OUTBOUND_PER_REFRESH = 20;

/** A Worker's error rate is judged only with at least this many requests today (UTC). */
export const ERROR_RATE_MIN_REQUESTS = 20;
/** errors / requests × 100 at or above: warning / critical. */
export const ERROR_RATE_WARN_PERCENT = 5;
export const ERROR_RATE_CRITICAL_PERCENT = 20;
/** Workers Free CPU per plain invocation, and the hint threshold (information only, never an alarm). */
export const CPU_LIMIT_US = 10_000;
export const CPU_HINT_US = 8_000;

/** workersInvocationsAdaptive `limit` (was 20 in v1); a dataset returning this many rows is truncated. */
export const WORKERS_QUERY_LIMIT = 50;
/** Scripts not seen for this many UTC days leave the remembered `cf_scripts` set; at most this many kept. */
export const CF_SCRIPTS_RETENTION_DAYS = 30;
export const CF_SCRIPTS_MAX = 100;

/** A public_http probe runs at most once per tick, and an owner refresh re-probes only after this. */
export const PROBE_MIN_INTERVAL_SECONDS = 600;
export const PROBE_TIMEOUT_MS = 10_000;

/** The attention strip shows at most this many items (worst first), then "还有 N 项". */
export const ATTENTION_SHOWN = 3;
/** RefreshCloudflareView re-queries GraphQL at most this often (the v1 value). */
export const CLOUDFLARE_REFRESH_MIN_SECONDS = 60;

/**
 * Configuration drift (docs/design-v2.md §10): once per UTC day, starting with the first tick at or after this hour,
 * the Worker compares the live account with the desired state generated from the committed configs
 * (src/drift-desired.json), at most DRIFT_CALLS_PER_TICK read-only API calls per tick.
 */
export const DRIFT_UTC_HOUR = 2;
export const DRIFT_CALLS_PER_TICK = 12;
/** A day's check stops after this many failed attempts (one per tick); the next day starts over. */
export const DRIFT_MAX_ATTEMPTS = 3;
/** Findings kept per check (the Cloudflare view lists idl.ts DRIFT_VIEW_FINDINGS_MAX of them; the counts stay complete). */
export const DRIFT_FINDINGS_MAX = 50;
/** Failed check days in a row before the digest reports `drift_unavailable`. */
export const DRIFT_UNAVAILABLE_AFTER_DAYS = 2;

/** Worst wins: critical > unknown > warning > held > ok (a silent check is never shown healthy). */
export const LEVEL_RANK: Readonly<Record<RollupLevel, number>> = { ok: 0, held: 1, warning: 2, unknown: 3, critical: 4 };

/**
 * The four mini bars of 首页 (Q3 keeps four, next to the four flow lines). `ai_neurons` replaced `do_requests` on
 * 2026-09-30 as the least informative of the four: the same 100,000-a-day allowance as `workers_requests` and driven
 * by the same app traffic, while the Workers AI headroom (a hard daily cap the guard does not act on) was otherwise
 * only on the Cloudflare view, where DO requests stay.
 */
export const HOME_QUOTA_IDS: readonly QuotaResource[] = ['workers_requests', 'd1_rows_read', 'ai_neurons', 'r2_storage'];
// HOME_QUOTA_IDS.length is CloudflareSummary.quota's max_items (idl.ts HOME_QUOTA_MAX; test/idl.test.ts).

/** The strip level of an item: the observed level, else the digest severity. */
export function attentionLevel(item: Pick<AttentionItem, 'severity' | 'observed'>): 'info' | 'warning' | 'critical' | 'unknown' {
  return item.observed ?? item.severity;
}
