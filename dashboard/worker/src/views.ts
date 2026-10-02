/**
 * Assembly of the four views (docs/design-v2.md §5, proto/dashboard/ui/v1) from what HomeState read, and their
 * serialization with an ETag. Pure: HomeState passes the documents and the parts it already builds (usage, guard,
 * canary, digest); the fetch handler only forwards the string. Each view is the generated wire type of its message,
 * every object written in its field order, so JSON.stringify writes exactly what the wire profile would
 * (test/wire-conformance.test.ts reads every body strictly and writes it back byte for byte).
 *
 * ETag: `"<rev>-<hash>"`, where the hash covers the whole body except `generated_at`. `rev` alone is not
 * enough: levels also change with time (a status goes stale, the ticks stop), so a body built later from
 * the same rows may differ; the hash makes a 304 mean "exactly the body you have". Time-derived fields
 * are minute-rounded, so an unchanged state keeps its ETag for at least a minute.
 */
import type { CanaryState, Digest, GuardView, QuotaRow, Usage } from './api-types.ts';
import { HOME_QUOTA_IDS, type AppDetail, type Attention, type Badges, type CloudflareView, type Drift, type FlowsView, type HomeView, type OpsView, type Refresh, type ShellFields, type WorkerRow } from './api-types.ts';
import { CF_VIEW_WORKERS_MAX } from './idl.ts';
import type { RegistryDef } from './registry-types.ts';
import { resourceRows, withBreakdownResources, workerRows, type CfScriptsDoc } from './discovery.ts';
import type { StatusDoc, UsageDoc } from './docs.ts';
import { entryState, flowStates, flowSummaries, type EvalInput } from './evaluate.ts';
import type { DesiredGuard } from './guard.ts';
import { REGISTRY } from './registry.ts';
import { MINUTE_MS, iso, isoOrNull } from './time.ts';
import { etagMatches, VIEW_NAMES, type ViewBody } from './view-body.ts';

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
  readonly attention: Attention;
  readonly badges: Badges;
  readonly lastTickAt: number | null;
  readonly lastRefreshAt: number | null;
  /**
   * Earliest time a refresh of this scope fetches again; `now` or earlier (a view without a refresh, a refresh that
   * is due) is written as the current minute, so the view's ETag holds within the minute.
   */
  readonly nextRefreshAt: number;
  readonly refreshed: boolean;
}

export function shell(input: ShellInput): ShellFields {
  const refresh: Refresh = {
    last_tick_at: isoOrNull(input.lastTickAt),
    next_tick_at: iso(nextTickAt(input.now)),
    last_refresh_at: isoOrNull(input.lastRefreshAt),
    next_refresh_at: iso(input.nextRefreshAt > input.now ? input.nextRefreshAt : floorMinute(input.now)),
    refreshed: input.refreshed,
  };
  return {
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
  usage: Usage,
  desired: DesiredGuard,
  registry: RegistryDef = REGISTRY,
): HomeView {
  const workers = workerRows(input.scripts, input.now, registry);
  const quota = HOME_QUOTA_IDS.flatMap((id): QuotaRow[] => {
    const row = usage.rows.find((r) => r.id === id);
    // The mini bars show used / limit only: the contributors stay on the Cloudflare view.
    return row === undefined ? [] : [{ ...row, breakdown: [] }];
  });
  const receipt = input.digest.last_receipt;
  return {
    name: VIEW_NAMES.home,
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

export function flowsResponse(base: ShellFields, input: EvalInput, canary: CanaryState, registry: RegistryDef = REGISTRY): FlowsView {
  return {
    name: VIEW_NAMES.flows,
    ...base,
    flows: flowStates(input, registry).map((flow) => {
      const def = registry.flows.find((f) => f.id === flow.id);
      if (def?.canary == null) return { ...flow, canary: null };
      const lastOk = flow.freshness.kind === 'canary' ? flow.freshness.at : null;
      return { ...flow, canary: { ...canary, id: def.canary.id, last_ok_at: lastOk } };
    }),
  };
}

/**
 * The Worker rows the Cloudflare view lists: all of them up to `max`, else the scripts active today
 * (requests or DO requests) first, then the most recently seen, kept in table order.
 */
export function capWorkers(rows: readonly WorkerRow[], max: number = CF_VIEW_WORKERS_MAX): { rows: WorkerRow[]; omitted: number } {
  if (rows.length <= max) return { rows: [...rows], omitted: 0 };
  const active = (row: WorkerRow): number => (row.requests > 0 || (row.do_requests ?? 0) > 0 ? 1 : 0);
  const keep = new Set(
    rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => active(b.row) - active(a.row) || b.row.last_seen_day.localeCompare(a.row.last_seen_day) || a.index - b.index)
      .slice(0, max)
      .map(({ row }) => row.script),
  );
  return { rows: rows.filter((row) => keep.has(row.script)), omitted: rows.length - keep.size };
}

export function cloudflareResponse(
  base: ShellFields,
  now: number,
  usage: Usage,
  usageDoc: UsageDoc,
  scripts: CfScriptsDoc | null,
  guard: GuardView,
  drift: Drift,
  registry: RegistryDef = REGISTRY,
): CloudflareView {
  const listed = capWorkers(workerRows(scripts, now, registry));
  return {
    name: VIEW_NAMES.cloudflare,
    ...base,
    drift,
    usage: { ...usage, rows: withBreakdownResources(usage.rows, registry) },
    workers: listed.rows,
    workers_omitted: listed.omitted,
    workers_truncated: scripts?.truncated ?? false,
    resources: resourceRows(usageDoc.resources, scripts, now, registry),
    do_storage_bytes: usage.rows.find((row) => row.id === 'do_storage')?.used ?? null,
    guard,
  };
}

export function opsResponse(
  base: ShellFields,
  guard: GuardView,
  canary: CanaryState,
  digest: Digest,
  statuses: Readonly<Record<string, StatusDoc>>,
  registry: RegistryDef = REGISTRY,
): OpsView {
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
  return { name: VIEW_NAMES.ops, ...base, guard, canary: { ...canary, id: flow?.canary?.id ?? 'mail-todofy' }, digest, apps };
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
export function serializeView(body: ShellFields & { readonly name?: string }, ifNoneMatch: string | null): ViewBody & { readonly bytes: number } {
  const stable = JSON.stringify({ ...body, generated_at: null });
  const etag = `"${String(body.rev)}-${fnv1a(stable)}"`;
  if (etagMatches(ifNoneMatch, etag)) return { etag, body: null, bytes: 0 };
  const text = JSON.stringify(body);
  return { etag, body: text, bytes: new TextEncoder().encode(text).byteLength };
}
