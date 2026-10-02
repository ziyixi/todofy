/**
 * The value lists and list bounds of dashboard.ui.v1 (proto/dashboard/ui/v1) as the Worker needs them, read from the
 * generated descriptors instead of copied: the IDL is their one definition, so a value added there reaches the
 * registry check, the drift check and the usage read, and a bound changed there reaches the code that cuts a list,
 * without a second edit (HomeState's views are passed through unread, so a list longer than its `max_items` would
 * reach the UI, whose client refuses it as `bad_response`).
 */
import { CanaryViewSchema } from '@ziyixi/proto/dashboard/ui/v1/canary_pb';
import { CloudflareViewSchema, DriftCategory, DriftCategorySchema, DriftSchema } from '@ziyixi/proto/dashboard/ui/v1/cloudflare_view_pb';
import { CloudflareSummarySchema, EntryStateSchema } from '@ziyixi/proto/dashboard/ui/v1/home_view_pb';
import { DigestSchema } from '@ziyixi/proto/dashboard/ui/v1/ops_view_pb';
import { FlowSchema, RegistryEntrySchema } from '@ziyixi/proto/dashboard/ui/v1/registry_pb';
import { QuotaResource, QuotaResourceSchema, QuotaRowSchema } from '@ziyixi/proto/dashboard/ui/v1/usage_pb';
import { fieldRules, wireEnum } from '@ziyixi/proto/wire-json';
import type { Accent, DriftCategory as DriftCategoryName, IconKey, QuotaResource as QuotaResourceName } from './api-types.ts';

/**
 * What the drift check compares, per Worker, in the IDL's order: the Worker set, Custom Domains, zone routes, cron
 * schedules, binding names and types (secrets by name), the workers.dev / preview URL flags, and whether each
 * personal value is a secret.
 */
export const DRIFT_CATEGORIES: readonly DriftCategoryName[] = wireEnum(DriftCategorySchema, DriftCategory).names;

/** Every quota the dashboard tracks, in the IDL's order (the order of Usage.rows). */
export const QUOTA_RESOURCES: readonly QuotaResourceName[] = wireEnum(QuotaResourceSchema, QuotaResource).names;

/** The icons a registry entry may name (the UI bundles exactly these). */
export const ICON_KEYS = fieldRules(RegistryEntrySchema.field.icon).allowed as readonly IconKey[];

/**
 * Tile accents; each has light and dark tokens in web/src/styles (≥ 3:1 non-text contrast). Rose sits next to the
 * danger colour (--danger-*), so no tile with a health level uses it (test/registry.test.ts).
 */
export const ACCENTS = fieldRules(RegistryEntrySchema.field.accent).allowed as readonly Accent[];

/** A repeated field's `max_items`; every bound below has one (a missing bound is a broken IDL, not a default). */
function maxItems(field: Parameters<typeof fieldRules>[0]): number {
  const max = fieldRules(field).maxItems;
  if (max <= 0) throw new Error(`${field.parent.typeName}.${field.name} has no max_items`);
  return max;
}

/** Canary runs shown in the flows and ops views, newest first (CanaryView.recent, FlowCanaryView.recent). */
export const CANARY_RECENT_RUNS = maxItems(CanaryViewSchema.field.recent);
/**
 * Rows the Cloudflare view lists at most, ≈ 300 B each (CloudflareView.workers). Scripts active today come first,
 * then the most recently seen; the rest is counted in `workers_omitted`, so the body stays under VIEW_BODY_MAX even
 * with CF_SCRIPTS_MAX remembered scripts.
 */
export const CF_VIEW_WORKERS_MAX = maxItems(CloudflareViewSchema.field.workers);
/** Drift findings the Cloudflare view lists (Drift.findings; DRIFT_FINDINGS_MAX are kept, the counts stay complete). */
export const DRIFT_VIEW_FINDINGS_MAX = maxItems(DriftSchema.field.findings);
/** The worst signals a tile names (EntryState.top_signals). */
export const TOP_SIGNALS_MAX = maxItems(EntryStateSchema.field.topSignals);
/** The largest contributors a quota row names (QuotaRow.breakdown). */
export const QUOTA_BREAKDOWN_MAX = maxItems(QuotaRowSchema.field.breakdown);
/** Stages of a registry flow, at most (Flow.stages; the registry check also wants at least 2). */
export const FLOW_STAGES_MAX = maxItems(FlowSchema.field.stages);
/** Items of the ops view's digest (Digest.items); the digest itself keeps ops.v1's REPORT_MAX_ITEMS (equal, tested). */
export const DIGEST_ITEMS_MAX = maxItems(DigestSchema.field.items);
/** The mini quota bars of 首页 (CloudflareSummary.quota): HOME_QUOTA_IDS has exactly this many (tested). */
export const HOME_QUOTA_MAX = maxItems(CloudflareSummarySchema.field.quota);
