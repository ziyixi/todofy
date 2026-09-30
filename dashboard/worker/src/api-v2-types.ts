/**
 * The owner API v2 of the Worker "home" (docs/design-v2.md) and the types of the registry
 * (src/registry.ts). Shared by the Worker and the web UI, which imports this file by relative path
 * (`../../worker/src/api-v2-types.ts`). Same rules as api-types.ts, because both toolchains compile it:
 * types and plain constants only, `import type` for everything imported, erasable syntax, no Workers
 * or DOM types, no runtime imports. No hostname may appear here: URLs reach the UI only through
 * `GET /api/v2/registry` (web/src/test/no-external.test.ts, web/scripts/check-dist.mjs).
 *
 * Every timestamp is RFC 3339 UTC; the UI shows it in the browser's time zone. Every `code` is a
 * machine code; the UI maps known codes to Chinese labels and shows unknown ones as they are. No
 * response carries mail content, addresses, tokens or remote response text.
 *
 * Endpoints (all under /api/v2/, Access + owner check, private no-store headers, ApiError envelope):
 *
 * | Route                          | Served by              | Body                  | Budget per call                 |
 * | ------------------------------ | ---------------------- | --------------------- | ------------------------------- |
 * | GET  registry                  | Worker (no DO)         | RegistryResponse      | ≤ 12 KiB; ETag "<build>" → 304  |
 * | GET  csrf                      | Worker                 | CsrfResponse          | as v1                           |
 * | GET  home[?refresh=1]          | DO, 1 call             | HomeResponse          | ≤ 10 KiB; ≤ 24 rows read        |
 * | GET  flows                     | DO, 1 call             | FlowsResponse         | ≤ 16 KiB; ≤ 24 rows read        |
 * | GET  cloudflare[?refresh=1]    | DO, 1 call             | CloudflareResponse    | ≤ 16 KiB; ≤ 10 rows read        |
 * | GET  ops                       | DO, 1 call             | OpsResponse           | ≤ 24 KiB; ≤ 24 rows read        |
 * | POST guard {level}             | DO                     | GuardResponseV2       | as v1 (CSRF + Origin)           |
 * | POST canary {canary_id}        | DO                     | CanaryStartResponse   | as v1 (CSRF + Origin)           |
 *
 * Dynamic views carry `ETag: "<rev>-<hash>"` (the hash covers the body except generated_at) and answer
 * 304 to a matching If-None-Match; sizes are a normal day's (V2_BODY_BUDGET, V2_BODY_MAX for a bad
 * day), rows are V2_ROWS_READ (measured in workerd).
 */
import type {
  AppCard,
  CanaryView,
  DigestView,
  GuardAppView,
  GuardView,
  Iso,
  OpsReportItem,
  OpsSeverity,
  OverallLevel,
  QuotaResourceId,
  QuotaRow,
  UsageView,
} from './api-types.ts';

export type { CanaryStartResponse, CsrfResponse, GuardRequest } from './api-types.ts';

export const API_V2_VERSION = 'home-v2';

// ---------------------------------------------------------------------------------------------------
// Constants shared by the Worker (evaluation) and the UI (explanations).

/**
 * Response size budgets (bytes of the JSON body) of a normal day (test/views-v2.test.ts: the mockup
 * day, and the Cloudflare view with 20 Workers). A bad day may exceed them: the attention strip repeats
 * up to 20 items in every view and the canary strip can hold 14 failed runs; V2_BODY_MAX bounds that
 * case (20 alarms, 16 signals per app, 14 failed runs, 20 Workers; measured 8–25 KiB). HomeState logs
 * `over_budget` when a body passes its budget.
 */
export const V2_BODY_MAX = 32 * 1024;
export const V2_BODY_BUDGET = {
  registry: 12 * 1024,
  home: 10 * 1024,
  flows: 16 * 1024,
  cloudflare: 16 * 1024,
  ops: 24 * 1024,
} as const;

/**
 * Durable Object rows one view may read (SqlStorageCursor.rowsRead per call; the workerd suite asserts
 * it with a full 14-run canary history and 20 Workers, measured 22 / 22 / 7 / 20). Every view reads the
 * shared shell (meta, digest, the two guard docs, both statuses); home, flows and ops add the 14 recent
 * canary runs, cloudflare the usage and cf_scripts documents. Each document is read once per build.
 */
export const V2_ROWS_READ: Readonly<Record<ViewId, number>> = { home: 24, flows: 24, cloudflare: 10, ops: 24 };

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
/** GET /cloudflare?refresh=1 re-queries GraphQL at most this often (the v1 value). */
export const CLOUDFLARE_REFRESH_MIN_SECONDS = 60;

// ---------------------------------------------------------------------------------------------------
// Levels (docs/design-v2.md §2). Status is always shape + word, never colour alone.

/**
 * ok 正常 ●, held 已暂停 ‖, warning 需关注 ▲, critical 故障 ■, unknown 未知 ◆,
 * link 仅链接 (no dot, shows the host), unmonitored 未接入 ○.
 */
export type Level = 'ok' | 'held' | 'warning' | 'critical' | 'unknown' | 'link' | 'unmonitored';
/** The levels that take part in a roll-up; `link` and `unmonitored` never do. */
export type RollupLevel = 'ok' | 'held' | 'warning' | 'critical' | 'unknown';

/** Worst wins: critical > unknown > warning > held > ok (a silent check is never shown healthy). */
export const LEVEL_RANK: Readonly<Record<RollupLevel, number>> = { ok: 0, held: 1, warning: 2, unknown: 3, critical: 4 };

// ---------------------------------------------------------------------------------------------------
// Registry definitions (the data lives in src/registry.ts, compiled into the Worker).

export const ICON_KEYS = [
  'mail',
  'list-checks',
  'calendar-clock',
  'notebook-pen',
  'globe',
  'upload-cloud',
  'newspaper',
  'gauge',
  'server',
  'database',
  'link',
] as const;
export type IconKey = (typeof ICON_KEYS)[number];

/** Tile accents; each has light and dark tokens in web/src/styles (≥ 3:1 non-text contrast). */
export const ACCENTS = ['blue', 'green', 'teal', 'rose', 'violet', 'amber', 'slate'] as const;
export type Accent = (typeof ACCENTS)[number];

/** Launcher groups (by kind) on 首页. `hidden` entries have no tile (the dashboard itself). */
export type EntryGroupId = 'apps' | 'sites' | 'services' | 'hidden';
/** Business groups on 业务流程. */
export type FlowGroupId = 'mail' | 'content' | 'platform';

export interface GroupDef<Id extends string> {
  readonly id: Id;
  /** 中文, ≤ 12 characters. */
  readonly name: string;
  readonly order: number;
}

/** Where an entry's own health comes from (docs/design-v2.md §3). */
export type StatusSource =
  /** contracts/ops-v1 `Ops.status()` over the named service binding (as in v1); guard: receives setGuard. */
  | { readonly type: 'ops_v1'; readonly binding: 'MAIL_HERO' | 'TODOFY'; readonly guard: boolean }
  /**
   * One GET per tick from the Durable Object to a public (not Access-protected) URL: status code and
   * latency only, `redirect: 'manual'`, body cancelled unread. `enabled: false` shows 未接入 instead.
   */
  | { readonly type: 'public_http'; readonly url: string; readonly expect: readonly number[]; readonly enabled: boolean }
  /** From the tick's GraphQL data of the entry's workers: error rate and hours since the last request. */
  | { readonly type: 'analytics'; readonly max_idle_hours: number }
  /** The dashboard's own tick freshness (tick_stale). */
  | { readonly type: 'self' }
  /** Access-protected or private: a link, never probed (an anonymous probe sees only Access). */
  | { readonly type: 'link_only' }
  /** Not monitored yet (未接入). */
  | { readonly type: 'none' };
export type StatusSourceType = StatusSource['type'];

/** The one number a tile may show next to its level. */
export type TileMetricDef =
  | { readonly kind: 'counter'; readonly name: string }
  | { readonly kind: 'latency' }
  | { readonly kind: 'last_active' };

/** Something the owner can open, or a background service with a status line (首页 tiles). */
export interface EntryDef {
  /** `^[a-z][a-z0-9-]{0,31}$`; ops_v1 entries use their OpsApp id and OpsReportItem.source. */
  readonly id: string;
  readonly name: string;
  /** 中文 one line, ≤ 40 characters. */
  readonly description: string;
  readonly group: EntryGroupId;
  readonly icon: IconKey;
  readonly accent: Accent;
  /** `https://<host>/`; null for a background service without a page (its row opens a view here). */
  readonly url: string | null;
  /** Access protects `url` (tile lock, informational). */
  readonly access: boolean;
  readonly status: StatusSource;
  readonly tile_metric: TileMetricDef | null;
  /** Signals of this entry shown only on its detail, claimed by no flow stage. */
  readonly app_only_signals: readonly string[];
  /** Within the group; tiles never reorder by status. */
  readonly order: number;
}

/** A Cloudflare Worker script (GraphQL `scriptName`) that belongs to an entry. */
export interface WorkerDef {
  /** The wrangler `name`, `^[a-z0-9][a-z0-9_-]{0,62}$`; each script belongs to one entry. */
  readonly script: string;
  readonly entry: string;
  /** 中文, ≤ 24 characters, e.g. "网关与 UI". */
  readonly role: string;
}

export type ResourceKind = 'd1' | 'do' | 'r2';

/**
 * A storage resource and its owner. GraphQL names D1 by `databaseId` (UUID), DO periodic data by
 * `namespaceId` (32 hex) and R2 by `bucketName`. `match` is that identifier; null is a TODO
 * placeholder (the value lives in a GitHub variable, not in the repo): such a resource matches
 * nothing, and the account's row stays 未登记 with its raw ID until `match` is filled in.
 */
export interface ResourceDef {
  /** Registry id, `^[a-z][a-z0-9-]{0,47}$`. */
  readonly id: string;
  readonly kind: ResourceKind;
  /** Display name, e.g. "mail-hero 主库", "MailCoordinator". */
  readonly name: string;
  readonly entry: string;
  readonly match: string | null;
  /** DO only: the script that defines the class (its doInv requests are this namespace's). */
  readonly script?: string;
  /** Where `match` comes from while it is null. */
  readonly todo?: string;
}

export interface StageDef {
  /** `^[a-z][a-z0-9_]{0,31}$`, unique within the flow. */
  readonly id: string;
  /** 中文, ≤ 12 characters. */
  readonly name: string;
  /** null: outside what the dashboard sees (source mailbox forwarding, Notion) → 未接入. */
  readonly entry: string | null;
  /** The entry's workers this stage runs on (worker-row flow tags, analytics); default: all of them. */
  readonly workers?: readonly string[];
  /** Signals of the entry that describe this stage; each code at most once per flow. */
  readonly signals: readonly string[];
  /** Of those, the ones meaning "held by a switch": shown 已暂停, not as a fault. */
  readonly hold_signals?: readonly string[];
  /** Counters of the entry shown on the stage (display only, never thresholds). */
  readonly counters?: readonly string[];
  /** Include the workers' error rate in the stage level. */
  readonly analytics?: boolean;
  /** 中文 one line shown while the stage is 未接入 (why the dashboard cannot see it). */
  readonly note?: string;
}

/** An implemented canary runner bound to a flow; the registry cannot invent one. */
export interface CanaryDef {
  readonly id: 'mail-todofy';
  readonly runner: 'mail_todofy_v1';
  /** Runner stage (CanaryStage) → flow stage id. */
  readonly stage_map: { readonly delivery: string; readonly consumer: string };
  /** A finished ok run verifies the mapped stages for this long, then 未验证. */
  readonly fresh_hours: number;
  /** What the canary does NOT prove, shown verbatim (honesty rule). */
  readonly scope_note: string;
}

export interface FlowDef {
  /** `^[a-z][a-z0-9-]{0,31}$`; also the hash route `#/flows/<id>`. */
  readonly id: string;
  readonly name: string;
  readonly group: FlowGroupId;
  readonly description: string;
  /** Ordered, 2..8. */
  readonly stages: readonly StageDef[];
  readonly canary: CanaryDef | null;
  readonly order: number;
}

export interface Registry {
  readonly entry_groups: readonly GroupDef<EntryGroupId>[];
  readonly flow_groups: readonly GroupDef<FlowGroupId>[];
  readonly entries: readonly EntryDef[];
  readonly workers: readonly WorkerDef[];
  readonly resources: readonly ResourceDef[];
  readonly flows: readonly FlowDef[];
}

// ---------------------------------------------------------------------------------------------------
// GET /api/v2/registry -> 200 RegistryResponse (or 304 for If-None-Match "<build>").
// Static per build: serialized once at module load. The public view leaves out how a status is
// obtained (binding names, probe URLs); `status_type` is enough for the UI.

export interface RegistryEntryView extends Omit<EntryDef, 'status'> {
  readonly status_type: StatusSourceType;
  /** Lowercase host of `url` (shown on link-only tiles and in accessible names); null without url. */
  readonly host: string | null;
  /** Scripts of this entry (from `workers`). */
  readonly scripts: readonly string[];
}

export interface RegistryResponse {
  readonly version: typeof API_V2_VERSION;
  readonly build: string;
  readonly entry_groups: readonly GroupDef<EntryGroupId>[];
  readonly flow_groups: readonly GroupDef<FlowGroupId>[];
  readonly entries: readonly RegistryEntryView[];
  readonly workers: readonly (WorkerDef & { readonly flows: readonly string[] })[];
  readonly resources: readonly Omit<ResourceDef, 'match' | 'todo'>[];
  readonly flows: readonly FlowDef[];
}

// ---------------------------------------------------------------------------------------------------
// Shared parts of every dynamic response (attention strip, tab badges, freshness).

export type ViewId = 'home' | 'flows' | 'cloudflare' | 'ops';

/** Where an attention item links to; the UI builds the hash route from it. */
export interface Target {
  readonly view: ViewId;
  readonly flow?: string;
  readonly stage?: string;
  readonly entry?: string;
  readonly script?: string;
}

/** A digest/banner item (unchanged set, docs/design-v2.md §4) plus where it is shown. */
export interface AttentionItem extends Omit<OpsReportItem, 'since'> {
  /** Null for page-only items without an episode start (canary_disabled). */
  readonly since: Iso | null;
  readonly target: Target;
}

/** A switch that holds work (maintenance, force-paused delivery, owner shed): shown, never alarmed. */
export interface HeldItem {
  readonly entry: string;
  readonly code: string;
  readonly target: Target;
}

export interface AttentionView {
  /** Worst of `items` (unknown before anything ran), as v1's overall.level. */
  readonly level: OverallLevel;
  /** All warning/critical items, worst first (at most 20); the strip shows ATTENTION_SHOWN of them. */
  readonly items: readonly AttentionItem[];
  /** Info items shown on the page only (canary_disabled). */
  readonly info: readonly AttentionItem[];
  readonly held: readonly HeldItem[];
}

/** Warning + critical items per view, for the tab badges (held and info never count). */
export type Badges = Readonly<Record<ViewId, number>>;

export interface RefreshV2 {
  readonly last_tick_at: Iso | null;
  /** Next cron tick (every :00 and :30 UTC). */
  readonly next_tick_at: Iso;
  /** The last owner refresh of this response's scope that actually fetched. */
  readonly last_refresh_at: Iso | null;
  /** Earliest time `?refresh=1` of this scope fetches again. */
  readonly next_refresh_at: Iso;
  /** True when this request performed a refresh. */
  readonly refreshed: boolean;
}

export interface ShellFields {
  readonly version: typeof API_V2_VERSION;
  readonly generated_at: Iso;
  /**
   * Bumped by every tick, refresh that fetched, guard override and manual canary start. The response's
   * ETag is `"<rev>-<hash>"`: levels also change with time alone (a status goes stale), so the hash of
   * the body (without generated_at) decides whether a 304 is right.
   */
  readonly rev: number;
  readonly build: string;
  readonly attention: AttentionView;
  readonly badges: Badges;
  readonly refresh: RefreshV2;
}

// ---------------------------------------------------------------------------------------------------
// GET /api/v2/home[?refresh=1] -> 200 HomeResponse. `refresh=1` polls due ops-v1 statuses (≥ 10 min
// each) and due probes (≥ PROBE_MIN_INTERVAL_SECONDS), at most once per minute.

export type TileMetric =
  | { readonly kind: 'counter'; readonly name: string; readonly value: number }
  | { readonly kind: 'latency'; readonly ms: number }
  /** Hour precision (the tick runs every 30 min): `2026-09-29T06:00:00Z`. */
  | { readonly kind: 'last_active'; readonly hour: Iso };

export interface EntryState {
  readonly id: string;
  /** link_only → link; none (or a disabled probe) → unmonitored; never a made-up ok. */
  readonly level: Level;
  /** Code explaining a non-ok level: a signal code, `unreachable`, `http_status`, `idle`, `never_checked`, `tick_stale`. */
  readonly reason: string | null;
  readonly checked_at: Iso | null;
  readonly consecutive_failures: number;
  /** At most 3, worst first (ops_v1 only). */
  readonly top_signals: readonly { readonly code: string; readonly severity: OpsSeverity; readonly since: Iso | null }[];
  readonly metric: TileMetric | null;
}

export type Freshness =
  | { readonly kind: 'canary'; readonly at: Iso | null; readonly ok_runs: number; readonly runs: number }
  | { readonly kind: 'activity'; readonly at: Iso | null }
  | { readonly kind: 'digest'; readonly at: Iso | null; readonly accepted: boolean | null }
  | { readonly kind: 'none' };

export interface FlowSummary {
  readonly id: string;
  /** Worst monitored stage; `unmonitored` when no stage is monitored. */
  readonly level: Level;
  /** Fewer than half of the stages are monitored: the title shows ○ 部分接入, never a green dot. */
  readonly partial: boolean;
  readonly coverage: { readonly monitored: number; readonly total: number };
  /** The first stage that is not ok (with its main code), for the one-line summary. */
  readonly first_issue: { readonly stage: string; readonly code: string | null } | null;
  readonly freshness: Freshness;
}

/** The four mini bars of 首页 (workers_requests, d1_rows_read, do_requests, r2_storage). */
export const HOME_QUOTA_IDS: readonly QuotaResourceId[] = ['workers_requests', 'd1_rows_read', 'do_requests', 'r2_storage'];

export interface CloudflareSummary {
  readonly usage_status: UsageView['status'];
  readonly fetched_at: Iso | null;
  readonly quota: readonly QuotaRow[];
  readonly workers: number;
  readonly errors_today: number;
  readonly guard_level: GuardView['desired']['level'];
}

export interface HomeResponse extends ShellFields {
  /** One per registry entry except group `hidden`, in registry order. */
  readonly entries: readonly EntryState[];
  readonly flows: readonly FlowSummary[];
  readonly cloudflare: CloudflareSummary;
  readonly digest: { readonly last_sent_at: Iso | null; readonly accepted: boolean | null };
}

// ---------------------------------------------------------------------------------------------------
// GET /api/v2/flows -> 200 FlowsResponse (no refresh: it reads what ticks and /home refreshes stored).

export type CanaryBadge = 'verified' | 'failed' | 'held' | 'unverified';

export interface StageState {
  readonly id: string;
  readonly level: Level;
  /**
   * Code explaining a non-ok level: a claimed signal code, `unreachable`, `stale`, `never_checked`,
   * `app_down`, `app_degraded`, `error_rate`, `idle`, `never_seen`, `http_status`, `timeout`,
   * `network_error`, `tick_stale` or `canary_failed`; null when ok or unmonitored.
   */
  readonly reason: string | null;
  /** A hold signal matched (level is `held` unless something worse applies). */
  readonly held: boolean;
  readonly signals: readonly { readonly code: string; readonly severity: OpsSeverity; readonly since: Iso | null; readonly metrics: Readonly<Record<string, number>> }[];
  readonly counters: readonly { readonly name: string; readonly value: number }[];
  /** Only on stages the canary's stage_map covers. */
  readonly canary: CanaryBadge | null;
  /** Stage with `analytics: true` (its workers, today UTC). */
  readonly analytics: {
    readonly requests: number;
    readonly errors: number;
    /** Null below ERROR_RATE_MIN_REQUESTS (样本太少，不判定). */
    readonly error_percent: number | null;
    readonly last_active_hour: Iso | null;
  } | null;
  /** Stage whose entry is probed (public_http). */
  readonly probe: { readonly checked_at: Iso | null; readonly ok: boolean | null; readonly http_status: number | null; readonly latency_ms: number | null } | null;
}

export interface FlowState extends FlowSummary {
  readonly stages: readonly StageState[];
  /** Codes of the flow's entries that no stage claims (a newer app release): never dropped. */
  readonly unclassified: readonly { readonly entry: string; readonly code: string; readonly severity: OpsSeverity }[];
  /** The bound canary (the mail flow only). */
  readonly canary: (CanaryView & { readonly id: string; readonly last_ok_at: Iso | null }) | null;
}

export interface FlowsResponse extends ShellFields {
  readonly flows: readonly FlowState[];
}

// ---------------------------------------------------------------------------------------------------
// GET /api/v2/cloudflare[?refresh=1] -> 200 CloudflareResponse. `refresh=1` re-queries GraphQL at
// most every CLOUDFLARE_REFRESH_MIN_SECONDS.

export interface WorkerRow {
  readonly script: string;
  /** Registry entry; null → 未登记 (a new Worker shows up on its first request). */
  readonly entry: string | null;
  /** Today (UTC); 0 for a remembered script with no request yet today. */
  readonly requests: number;
  readonly errors: number;
  /** Null below ERROR_RATE_MIN_REQUESTS. */
  readonly error_percent: number | null;
  /** From the error rate only (warning ≥ 5 %, critical ≥ 20 %); ok otherwise. */
  readonly level: Level;
  readonly subrequests: number;
  /** Microseconds, null when not reported today. */
  readonly cpu_p50_us: number | null;
  readonly cpu_p99_us: number | null;
  /** Counted on the script that defines the DO class; null for a script that defines none. */
  readonly do_requests: number | null;
  readonly do_errors: number | null;
  readonly first_seen_day: string;
  readonly last_seen_day: string;
  /** Hour of the last tick that saw requests grow (tick precision, shown as "今天 06 时"). */
  readonly last_active_hour: Iso | null;
}

export type ResourceRow =
  | {
      readonly kind: 'd1';
      /** The account identifier (databaseId). */
      readonly id: string;
      /** Registry resource id; null → 未登记 + the first 8 characters of `id`. */
      readonly resource: string | null;
      readonly entry: string | null;
      readonly size_bytes: number | null;
      readonly rows_read: number;
      readonly rows_written: number;
    }
  | {
      readonly kind: 'do';
      /** namespaceId. */
      readonly id: string;
      readonly resource: string | null;
      readonly entry: string | null;
      /** Via the defining script's doInv row; null when the namespace is not mapped. */
      readonly requests: number | null;
      readonly rows_read: number;
      readonly rows_written: number;
    }
  | {
      readonly kind: 'r2';
      /** bucketName; `unclassified` for operations without a bucket. */
      readonly id: string;
      readonly resource: string | null;
      readonly entry: string | null;
      readonly size_bytes: number | null;
      readonly class_a: number;
      readonly class_b: number;
    };

/** v1's GuardView with apps keyed by entry id (the entries whose status is ops_v1 with guard). */
export interface GuardViewV2 extends Omit<GuardView, 'apps'> {
  readonly apps: Readonly<Record<string, GuardAppView>>;
}

export interface CloudflareResponse extends ShellFields {
  readonly usage: UsageView;
  /** Remembered scripts (≤ CF_SCRIPTS_MAX): errors first, then requests. */
  readonly workers: readonly WorkerRow[];
  /** The workers dataset returned WORKERS_QUERY_LIMIT rows: the list is a lower bound. */
  readonly workers_truncated: boolean;
  readonly resources: readonly ResourceRow[];
  /** DO storage is account-wide only (no per-namespace dimension in the query). */
  readonly do_storage_bytes: number | null;
  readonly guard: GuardViewV2;
}

// ---------------------------------------------------------------------------------------------------
// GET /api/v2/ops -> 200 OpsResponse: guard/canary actions, digest, full per-app ops-v1 details.

export interface AppDetail extends Omit<AppCard, 'app' | 'url'> {
  readonly entry: string;
}

export interface OpsResponse extends ShellFields {
  readonly guard: GuardViewV2;
  readonly canary: CanaryView & { readonly id: string };
  readonly digest: DigestView;
  /** Every ops_v1 entry, registry order. */
  readonly apps: readonly AppDetail[];
}

// ---------------------------------------------------------------------------------------------------
// POST /api/v2/guard {level} -> 200 GuardResponseV2 (as v1: force shed 24 h / clear until 00:00 UTC).
// POST /api/v2/canary {canary_id: 'mail-todofy'} -> 202 CanaryStartResponse; the v1 errors
// (409 canary_disabled, 409 canary_active, 429 canary_limit); 400 bad_request for another canary_id.

export interface CanaryStartRequestV2 {
  readonly canary_id: CanaryDef['id'];
}
export interface GuardResponseV2 {
  readonly guard: GuardViewV2;
}
