/**
 * Worker auto-discovery (docs/design-v2.md §4 "Discovery"): the per-script rows of each GraphQL answer
 * are merged into one remembered `cf_scripts` document, because the dataset only returns scripts that
 * ran in the window (an idle cron Worker would vanish at 00:00 UTC) and the Analytics token cannot list
 * scripts. Pure functions, `now` passed in; the registry only names what was found.
 */
import { CF_SCRIPTS_MAX, CF_SCRIPTS_RETENTION_DAYS, ERROR_RATE_CRITICAL_PERCENT, ERROR_RATE_MIN_REQUESTS, ERROR_RATE_WARN_PERCENT, type Level, type ResourceRow, type WorkerRow } from './api-types.ts';
import type { RegistryDef } from './registry-types.ts';
import type { QuotaRow } from './api-types.ts';
import { REGISTRY, entryOfScript, resourceByMatch } from './registry.ts';
import { DAY_MS, HOUR_MS, isoOrNull, round1, utcDay } from './time.ts';
import { BREAKDOWN_RESOURCE_KIND, UNKNOWN_DIMENSION, type ResourceUsage, type ScriptUsage } from './usage.ts';

export type ScriptToday = Omit<ScriptUsage, 'script'>;

export const NO_TRAFFIC: ScriptToday = {
  requests: 0,
  errors: 0,
  subrequests: 0,
  cpu_p50_us: null,
  cpu_p99_us: null,
  do_requests: null,
  do_errors: null,
};

export interface ScriptRecord {
  readonly script: string;
  readonly first_seen_day: string;
  readonly last_seen_day: string;
  /** Start of the hour (epoch ms) of the last observation window in which the script's count grew. */
  readonly last_active_hour: number | null;
  /** UTC day `today` belongs to. */
  readonly day: string;
  readonly today: ScriptToday;
}

/** State doc `cf_scripts` (≤ CF_SCRIPTS_MAX records, ~25 KiB at most, under the 64 KiB row cap). */
export interface CfScriptsDoc {
  /** Current script identities from the successful REST inventory, independent of traffic. */
  readonly live?: readonly string[];
  /** When discovery started (the idle rule never judges a script seen for less time than this). */
  readonly since: number;
  /** The GraphQL answer the records describe. */
  readonly observed_at: number;
  readonly day: string;
  /** `workers` returned WORKERS_QUERY_LIMIT rows. */
  readonly truncated: boolean;
  readonly scripts: readonly ScriptRecord[];
}

/** Worker + Durable Object invocations: what "had a request" means for the activity rule. */
function activity(today: ScriptToday): number {
  return today.requests + (today.do_requests ?? 0);
}

/**
 * The remembered set after one successful GraphQL answer at `now`. A script's `last_active_hour` moves
 * to the hour of `now - 1 ms` when its day count grew since the previous answer (tick precision: the
 * requests happened between the two answers, shown as "今天 06 时", never "N 分钟前"). Records not seen
 * for CF_SCRIPTS_RETENTION_DAYS UTC days are dropped, and at most CF_SCRIPTS_MAX are kept (the most
 * recently seen).
 */
export function mergeScripts(previous: CfScriptsDoc | null, observed: readonly ScriptUsage[], truncated: boolean, now: number): CfScriptsDoc {
  const day = utcDay(now);
  const activeHour = Math.floor((now - 1) / HOUR_MS) * HOUR_MS;
  const byScript = new Map((previous?.scripts ?? []).map((record) => [record.script, record]));
  const seen = new Set<string>();
  for (const usage of observed) {
    const { script, ...today } = usage;
    if (seen.has(script)) continue;
    seen.add(script);
    const before = byScript.get(script);
    const beforeToday = before !== undefined && before.day === day ? activity(before.today) : 0;
    const grew = activity(today) > beforeToday;
    byScript.set(script, {
      script,
      first_seen_day: before?.first_seen_day ?? day,
      last_seen_day: day,
      last_active_hour: grew ? activeHour : (before?.last_active_hour ?? null),
      day,
      today,
    });
  }
  const cutoff = utcDay(now - CF_SCRIPTS_RETENTION_DAYS * DAY_MS);
  const live = new Set(previous?.live ?? []);
  const scripts = [...byScript.values()]
    // A script missing from today's answer keeps what it had today (a truncated answer may leave it
    // out); numbers of an earlier day are not today's.
    .map((record) => (seen.has(record.script) || record.day === day ? record : { ...record, day, today: NO_TRAFFIC }))
    .filter((record) => live.has(record.script) || record.last_seen_day > cutoff)
    .sort((a, b) => Number(live.has(b.script)) - Number(live.has(a.script)) || b.last_seen_day.localeCompare(a.last_seen_day) || a.script.localeCompare(b.script))
    .slice(0, CF_SCRIPTS_MAX)
    .sort((a, b) => a.script.localeCompare(b.script));
  return { ...(previous?.live === undefined ? {} : { live: previous.live }), since: previous?.since ?? now, observed_at: now, day, truncated, scripts };
}

/** A script's numbers for the UTC day of `now` (zero when the record describes an earlier day). */
export function todayOf(record: ScriptRecord, now: number): ScriptToday {
  return record.day === utcDay(now) ? record.today : NO_TRAFFIC;
}

/** errors / requests × 100 (one decimal), or null below ERROR_RATE_MIN_REQUESTS (样本太少，不判定). */
export function errorPercent(requests: number, errors: number): number | null {
  return requests >= ERROR_RATE_MIN_REQUESTS && requests > 0 ? round1((errors / requests) * 100) : null;
}

/** The error-rate rule: ≥ 20 % critical, ≥ 5 % warning (only with enough requests), else ok. */
export function errorLevel(requests: number, errors: number): 'ok' | 'warning' | 'critical' {
  if (requests < ERROR_RATE_MIN_REQUESTS || requests <= 0) return 'ok';
  const share = (errors * 100) / requests;
  if (share >= ERROR_RATE_CRITICAL_PERCENT) return 'critical';
  if (share >= ERROR_RATE_WARN_PERCENT) return 'warning';
  return 'ok';
}

/** The Worker table (design-v2 §4): errors first, then requests, then name. */
export function workerRows(doc: CfScriptsDoc | null, now: number, registry: RegistryDef = REGISTRY): WorkerRow[] {
  if (doc === null) return [];
  return doc.scripts
    .filter((record) => record.script !== UNKNOWN_DIMENSION && (doc.live === undefined || doc.live.includes(record.script)))
    .map((record): WorkerRow => {
      const today = todayOf(record, now);
      const level: Level = errorLevel(today.requests, today.errors);
      return {
        script: record.script,
        entry: entryOfScript(record.script, registry) ?? null,
        requests: today.requests,
        errors: today.errors,
        error_percent: errorPercent(today.requests, today.errors),
        level,
        subrequests: today.subrequests,
        cpu_p50_us: today.cpu_p50_us,
        cpu_p99_us: today.cpu_p99_us,
        do_requests: today.do_requests,
        do_errors: today.do_errors,
        first_seen_day: record.first_seen_day,
        last_seen_day: record.last_seen_day,
        last_active_hour: isoOrNull(record.last_active_hour),
      };
    })
    .sort((a, b) => b.errors - a.errors || b.requests - a.requests || (b.do_requests ?? 0) - (a.do_requests ?? 0) || a.script.localeCompare(b.script));
}

/**
 * The resource table: every D1 database, DO namespace and R2 bucket of the answer, joined with the
 * registry by its GraphQL identifier; an unmapped one keeps `resource: null` (未登记 + raw ID). A DO
 * namespace's requests come from its defining script's doInv row (registry `script`), so only mapped
 * namespaces have them.
 */
export function resourceRows(usage: ResourceUsage | undefined, scripts: CfScriptsDoc | null, now: number, registry: RegistryDef = REGISTRY): ResourceRow[] {
  if (usage === undefined) return [];
  const doRequests = (script: string | undefined): number | null => {
    if (script === undefined || scripts === null) return null;
    const record = scripts.scripts.find((r) => r.script === script);
    return record === undefined ? null : todayOf(record, now).do_requests;
  };
  const rows: ResourceRow[] = [];
  for (const d1 of usage.d1) {
    const def = resourceByMatch('d1', d1.id, registry);
    // Field order and nulls as dashboard.ui.v1.ResourceRow writes them: each kind writes size_bytes and requests,
    // null where the kind has none (test/wire-conformance.test.ts).
    rows.push({ kind: 'd1', id: d1.id, resource: def?.id ?? null, entry: def?.entry ?? null, size_bytes: d1.size_bytes, requests: null, rows_read: d1.rows_read, rows_written: d1.rows_written });
  }
  for (const ns of usage.do) {
    const def = resourceByMatch('do', ns.id, registry);
    rows.push({
      kind: 'do',
      id: ns.id,
      resource: def?.id ?? null,
      entry: def?.entry ?? null,
      size_bytes: null,
      requests: def === undefined ? null : doRequests(def.script),
      rows_read: ns.rows_read,
      rows_written: ns.rows_written,
    });
  }
  for (const bucket of usage.r2) {
    const def = bucket.id === 'unclassified' ? undefined : resourceByMatch('r2', bucket.id, registry);
    rows.push({ kind: 'r2', id: bucket.id, resource: def?.id ?? null, entry: def?.entry ?? null, size_bytes: bucket.size_bytes, requests: null, class_a: bucket.class_a, class_b: bucket.class_b });
  }
  return rows;
}

/**
 * The quota rows with each D1/DO/R2 breakdown item joined to the registry like the resource table
 * (resourceByMatch): `kind` and `resource` (null → 未登记), so the page names "MailCoordinator ·
 * Mail Hero" instead of a namespace ID. Done when the view is built, never stored: snapshots from
 * before this field get it too, and a registry change applies at once. An unregistered item gets `kind`
 * without `resource` (the page reads 未登记), and so does an item without the dimension (未归类); script and
 * model items are left as they are.
 */
export function withBreakdownResources(rows: readonly QuotaRow[], registry: RegistryDef = REGISTRY): QuotaRow[] {
  return rows.map((row) => {
    const kind = BREAKDOWN_RESOURCE_KIND[row.id];
    if (kind === undefined || row.breakdown.length === 0) return row;
    return {
      ...row,
      breakdown: row.breakdown.map(({ name, value }) => {
        // Without the dimension: still marked with its kind (the page reads 未归类), never matched.
        const resource = name === UNKNOWN_DIMENSION ? undefined : resourceByMatch(kind, name, registry)?.id;
        return resource === undefined ? { name, value, kind } : { name, value, kind, resource };
      }),
    };
  });
}

/** Remember idle live Workers and keep retired analytics only as history. */
export function withLiveInventory(doc: CfScriptsDoc | null, live: readonly string[], now: number): CfScriptsDoc {
  const current = doc ?? mergeScripts(null, [], false, now);
  const names = new Set(current.scripts.map((item) => item.script));
  const idle = live.filter((script) => !names.has(script)).map((script): ScriptRecord => ({
    script, first_seen_day: utcDay(now), last_seen_day: utcDay(now), last_active_hour: null,
    day: utcDay(now), today: NO_TRAFFIC,
  }));
  const liveNames = new Set(live);
  const records = [...current.scripts, ...idle].filter(item => item.script !== UNKNOWN_DIMENSION);
  const scripts = [
    ...records.filter(item => liveNames.has(item.script)),
    ...records.filter(item => !liveNames.has(item.script)),
  ].slice(0, CF_SCRIPTS_MAX);
  return { ...current, live: [...live].slice(0, CF_SCRIPTS_MAX), scripts };
}

export function historicalWorkerRows(doc: CfScriptsDoc | null, now: number, registry: RegistryDef = REGISTRY): WorkerRow[] {
  if (!doc?.live) return [];
  const historical = doc.scripts.filter((item) => !doc.live?.includes(item.script));
  const rest = { ...doc };
  delete rest.live;
  return workerRows({ ...rest, scripts: historical }, now, registry);
}
