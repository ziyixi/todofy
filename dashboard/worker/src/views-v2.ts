/**
 * Assembly of the four v2 responses (docs/design-v2.md §5) from what HomeState read, and their
 * serialization with an ETag. Pure: HomeState passes the documents and the v1-shaped parts it already
 * builds (usage, guard, canary, digest views); the fetch handler only forwards the string.
 *
 * ETag: `"<rev>-<hash>"`, where the hash covers the whole body except `generated_at`. `rev` alone is not
 * enough: levels also change with time (a status goes stale, the ticks stop), so a body built later from
 * the same rows may differ; the hash makes a 304 mean "exactly the body you have". Time-derived fields
 * are minute-rounded, so an unchanged state keeps its ETag for at least a minute.
 */
import type { CanaryView, DigestView, GuardView, QuotaRow, UsageView } from './api-types.ts';
import {
  API_V2_VERSION,
  HOME_QUOTA_IDS,
  type AppDetail,
  type AttentionView,
  type Badges,
  type CloudflareResponse,
  type FlowsResponse,
  type HomeResponse,
  type OpsResponse,
  type Registry,
  type RefreshV2,
  type ShellFields,
} from './api-v2-types.ts';
import { resourceRows, workerRows, type CfScriptsDoc } from './discovery.ts';
import type { StatusDoc, UsageDoc } from './docs.ts';
import { entryState, flowStates, flowSummaries, type EvalInput } from './evaluate.ts';
import type { DesiredGuard } from './guard.ts';
import { REGISTRY } from './registry.ts';
import { MINUTE_MS, iso, isoOrNull } from './time.ts';
import { etagMatches, type V2Body } from './v2-views.ts';

/** Cron ticks run at :00 and :30 UTC. */
const TICK_INTERVAL_MS = 30 * MINUTE_MS;

/** The next cron tick strictly after `now`. */
export function nextTickAt(now: number): number {
  return Math.floor(now / TICK_INTERVAL_MS) * TICK_INTERVAL_MS + TICK_INTERVAL_MS;
}

export function floorMinute(now: number): number {
  return Math.floor(now / MINUTE_MS) * MINUTE_MS;
}

export interface ShellInput {
  readonly now: number;
  readonly rev: number;
  readonly build: string;
  readonly attention: AttentionView;
  readonly badges: Badges;
  readonly lastTickAt: number | null;
  readonly lastRefreshAt: number | null;
  /** Earliest time `?refresh=1` of this scope fetches again (minute-rounded up to `now`). */
  readonly nextRefreshAt: number;
  readonly refreshed: boolean;
}

export function shell(input: ShellInput): ShellFields {
  const refresh: RefreshV2 = {
    last_tick_at: isoOrNull(input.lastTickAt),
    next_tick_at: iso(nextTickAt(input.now)),
    last_refresh_at: isoOrNull(input.lastRefreshAt),
    next_refresh_at: iso(Math.max(floorMinute(input.now), input.nextRefreshAt)),
    refreshed: input.refreshed,
  };
  return {
    version: API_V2_VERSION,
    generated_at: iso(input.now),
    rev: input.rev,
    build: input.build,
    attention: input.attention,
    badges: input.badges,
    refresh,
  };
}

// ---- views ------------------------------------------------------------------------------------------

export function homeResponse(
  base: ShellFields,
  input: EvalInput,
  usage: UsageView,
  desired: DesiredGuard,
  registry: Registry = REGISTRY,
): HomeResponse {
  const workers = workerRows(input.scripts, input.now, registry);
  const quota = HOME_QUOTA_IDS.flatMap((id): QuotaRow[] => {
    const row = usage.rows.find((r) => r.id === id);
    // The mini bars show used / limit only: the contributors stay on the Cloudflare view.
    return row === undefined ? [] : [{ ...row, breakdown: [] }];
  });
  const receipt = input.digest.last_receipt;
  return {
    ...base,
    entries: registry.entries.filter((entry) => entry.group !== 'hidden').map((entry) => entryState(entry, input, registry)),
    flows: flowSummaries(input, registry),
    cloudflare: {
      usage_status: usage.status,
      fetched_at: usage.fetched_at,
      quota,
      workers: workers.length,
      errors_today: workers.reduce((sum, row) => sum + row.errors, 0),
      guard_level: desired.level,
    },
    digest: { last_sent_at: isoOrNull(input.digest.last_sent_at), accepted: receipt === null ? null : receipt.stored },
  };
}

export function flowsResponse(base: ShellFields, input: EvalInput, canary: CanaryView, registry: Registry = REGISTRY): FlowsResponse {
  return {
    ...base,
    flows: flowStates(input, registry).map((flow) => {
      const def = registry.flows.find((f) => f.id === flow.id);
      if (def?.canary == null) return { ...flow, canary: null };
      const lastOk = flow.freshness.kind === 'canary' ? flow.freshness.at : null;
      return { ...flow, canary: { ...canary, id: def.canary.id, last_ok_at: lastOk } };
    }),
  };
}

export function cloudflareResponse(
  base: ShellFields,
  now: number,
  usage: UsageView,
  usageDoc: UsageDoc,
  scripts: CfScriptsDoc | null,
  guard: GuardView,
  registry: Registry = REGISTRY,
): CloudflareResponse {
  return {
    ...base,
    usage,
    workers: workerRows(scripts, now, registry),
    workers_truncated: scripts?.truncated ?? false,
    resources: resourceRows(usageDoc.resources, scripts, now, registry),
    do_storage_bytes: usage.rows.find((row) => row.id === 'do_storage')?.used ?? null,
    guard,
  };
}

export function opsResponse(
  base: ShellFields,
  guard: GuardView,
  canary: CanaryView,
  digest: DigestView,
  statuses: Readonly<Record<string, StatusDoc>>,
  registry: Registry = REGISTRY,
): OpsResponse {
  const flow = registry.flows.find((f) => f.canary !== null);
  const apps = registry.entries
    .filter((entry) => entry.status.type === 'ops_v1')
    .map((entry): AppDetail => {
      const doc = statuses[entry.id];
      return {
        entry: entry.id,
        reachable: doc?.ok ?? null,
        checked_at: isoOrNull(doc?.checked_at),
        error: doc?.error ?? null,
        consecutive_failures: doc?.consecutive_failures ?? 0,
        status: doc?.status ?? null,
        status_at: isoOrNull(doc?.status_at),
      };
    });
  return { ...base, guard, canary: { ...canary, id: flow?.canary?.id ?? 'mail-todofy' }, digest, apps };
}

// ---- serialization ---------------------------------------------------------------------------------

/** FNV-1a (32 bit) of a string's UTF-16 code units, as 8 hex characters: a change detector, not a MAC. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The response string and its ETag; `body: null` when `ifNoneMatch` already names this ETag (→ 304). */
export function serializeView(body: ShellFields, ifNoneMatch: string | null): V2Body & { readonly bytes: number } {
  const stable = JSON.stringify({ ...body, generated_at: null });
  const etag = `"${String(body.rev)}-${fnv1a(stable)}"`;
  if (etagMatches(ifNoneMatch, etag)) return { etag, body: null, bytes: 0 };
  const text = JSON.stringify(body);
  return { etag, body: text, bytes: new TextEncoder().encode(text).byteLength };
}
