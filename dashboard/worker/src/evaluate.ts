/**
 * Evaluation of the v2 views (docs/design-v2.md §2, §4): entry health, flow stages and the attention
 * strip, as pure functions of what HomeState stored (`now` passed in). Page requests only read: nothing
 * here calls out or writes. Flows reorganize what the ticks already know; they never add alarm items,
 * so the digest sent to Todofy is unchanged.
 */
import { CANARY_DISABLED_ITEM, type OpsSignal, type OpsStatus } from './api-types.ts';
import { LEVEL_RANK, type AttentionItem, type Attention, type Badges, type CanaryBadge, type EntryState, type FlowState, type FlowSummary, type Freshness, type HeldItem, type Level, type RollupLevel, type StageState, type Target, type TileMetric, type ViewId } from './api-types.ts';
import { TOP_SIGNALS_MAX } from './idl.ts';
import type { EntryDef, FlowDef, RegistryDef, StageDef } from './registry-types.ts';
import type { CanaryRecord } from './canary.ts';
import { rollupAttention, sortAttention } from './attention-rollup.ts';
import { TICK_STALE_MS } from './digest.ts';
import { errorLevel, errorPercent, todayOf, workerRows, type CfScriptsDoc } from './discovery.ts';
import type { DigestDoc, ProbeDoc, StatusDoc } from './docs.ts';
import { usageFresh, type DesiredGuard } from './guard.ts';
import { PLATFORM_SIGNALS, REGISTRY, stageScripts } from './registry.ts';
import { HOUR_MS, MINUTE_MS, isoOrNull } from './time.ts';

/** A status or probe older than this (two and a half ticks) no longer says anything: 未知. */
export const OBSERVATION_STALE_MS = TICK_STALE_MS;
/** Clock skew tolerated for "from the future" observations. */
const SKEW_MS = 5 * MINUTE_MS;

/** Everything the evaluation reads (HomeState builds it from its tables). */
export interface EvalInput {
  readonly now: number;
  readonly lastTickAt: number | null;
  readonly analyticsConfigured: boolean;
  /** By entry id (ops_v1 entries; the id is the OpsApp). */
  readonly statuses: Readonly<Record<string, StatusDoc>>;
  /** By entry id (public_http entries). */
  readonly probes: Readonly<Record<string, ProbeDoc>>;
  readonly scripts: CfScriptsDoc | null;
  readonly digest: DigestDoc;
  /** Newest first, at most CANARY_RECENT_RUNS. */
  readonly canaryRecent: readonly CanaryRecord[];
}

interface Verdict {
  readonly level: RollupLevel;
  readonly reason: string | null;
}

const OK: Verdict = { level: 'ok', reason: null };

/** The worse of two verdicts; on a tie the first one stays (its reason is kept). */
function worse(a: Verdict, b: Verdict): Verdict {
  return LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a;
}

function isRollup(level: Level): level is RollupLevel {
  return level in LEVEL_RANK;
}

/** Worst of `levels` (link and unmonitored excluded); null when none takes part. */
export function rollup(levels: readonly Level[]): RollupLevel | null {
  let best: RollupLevel | null = null;
  for (const level of levels) {
    if (!isRollup(level)) continue;
    if (best === null || LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
  }
  return best;
}

const severityLevel = (severity: OpsSignal['severity']): RollupLevel => (severity === 'critical' ? 'critical' : 'warning');

// ---- registry helpers ------------------------------------------------------------------------------

/** Flows in display order: group order, then flow order. */
export function orderedFlows(registry: RegistryDef = REGISTRY): FlowDef[] {
  const groupOrder = (flow: FlowDef): number => registry.flow_groups.find((group) => group.id === flow.group)?.order ?? 99;
  return [...registry.flows].sort((a, b) => groupOrder(a) - groupOrder(b) || a.order - b.order);
}

/** The signals of `entry` that mean "held by a switch" in some stage (shown 已暂停, never as a fault). */
export function holdCodes(entry: string, registry: RegistryDef = REGISTRY): Set<string> {
  const codes = new Set<string>();
  for (const flow of registry.flows) {
    for (const stage of flow.stages) if (stage.entry === entry) for (const code of stage.hold_signals ?? []) codes.add(code);
  }
  return codes;
}

/** Every code of `entry` some stage, the entry's detail or the platform places. */
function placedCodes(entry: EntryDef, registry: RegistryDef): Set<string> {
  const codes = new Set<string>([...entry.app_only_signals, ...PLATFORM_SIGNALS]);
  for (const flow of registry.flows) for (const stage of flow.stages) if (stage.entry === entry.id) for (const code of stage.signals) codes.add(code);
  return codes;
}

// ---- observations -----------------------------------------------------------------------------------

function recent(at: number | null, now: number): boolean {
  return at !== null && now - at <= OBSERVATION_STALE_MS && now >= at - SKEW_MS;
}

/** The status of an ops_v1 entry while it still describes the app (at most OBSERVATION_STALE_MS old). */
export function freshStatus(doc: StatusDoc | undefined, now: number): OpsStatus | null {
  return doc !== undefined && doc.status !== null && recent(doc.status_at, now) ? doc.status : null;
}

/**
 * Reachability of an ops_v1 entry: never read → unknown; 2 failed polls in a row → critical, 1 →
 * warning; no status fresher than OBSERVATION_STALE_MS → unknown (`unreachable` when the last poll
 * failed, else `stale`); health `down` → critical.
 */
function reachability(doc: StatusDoc | undefined, now: number): Verdict {
  if (doc === undefined || doc.checked_at === null) return { level: 'unknown', reason: 'never_checked' };
  let verdict: Verdict = OK;
  if (doc.consecutive_failures >= 2) verdict = { level: 'critical', reason: 'unreachable' };
  else if (doc.consecutive_failures === 1) verdict = { level: 'warning', reason: 'unreachable' };
  const status = freshStatus(doc, now);
  // No usable status: a failed last poll says more than "stale" (an app never read successfully has no old status at all).
  if (status === null) return worse(verdict, { level: 'unknown', reason: doc.consecutive_failures > 0 ? 'unreachable' : 'stale' });
  if (status.app === 'notion-publish' && status.website_sync?.error_code) {
    return worse(verdict, { level: 'unknown', reason: 'website_sync_provider_unavailable' });
  }
  if (status.health === 'down') {
    const code = status.signals.find((signal) => signal.severity === 'critical')?.code ?? 'app_down';
    verdict = worse(verdict, { level: 'critical', reason: code });
  }
  return verdict;
}

/** A signal's level: a hold signal is `held` whatever its severity; other info signals say nothing. */
function signalVerdict(signal: OpsSignal, holds: ReadonlySet<string>): Verdict | null {
  if (holds.has(signal.code)) return { level: 'held', reason: signal.code };
  if (signal.severity === 'info') return null;
  return { level: severityLevel(signal.severity), reason: signal.code };
}

function scriptsFresh(doc: CfScriptsDoc | null, now: number): doc is CfScriptsDoc {
  return doc !== null && usageFresh({ fetched_at: doc.observed_at, day: doc.day, rows: [] }, now);
}

interface Activity {
  readonly requests: number;
  readonly errors: number;
  readonly last_active_hour: number | null;
}

function activityOf(scripts: readonly string[], doc: CfScriptsDoc | null, now: number): Activity {
  let requests = 0;
  let errors = 0;
  let last: number | null = null;
  for (const record of doc?.scripts ?? []) {
    if (!scripts.includes(record.script)) continue;
    const today = todayOf(record, now);
    requests += today.requests;
    errors += today.errors;
    if (record.last_active_hour !== null && (last === null || record.last_active_hour > last)) last = record.last_active_hour;
  }
  return { requests, errors, last_active_hour: last };
}

function entryScripts(entry: string, registry: RegistryDef): string[] {
  return registry.workers.filter((worker) => worker.entry === entry).map((worker) => worker.script);
}

// ---- entries ------------------------------------------------------------------------------------------

/**
 * The entry's own level and reason (the tile; design-v2 §4, Q2: never the worst of its flows). For
 * link_only `link`, for none and a disabled probe `unmonitored`: never a made-up ok.
 */
function entryVerdict(entry: EntryDef, input: EvalInput, registry: RegistryDef): { level: Level; reason: string | null } {
  const { now } = input;
  const status = entry.status;
  switch (status.type) {
    case 'link_only':
      return { level: 'link', reason: null };
    case 'none':
      return { level: 'unmonitored', reason: null };
    case 'self': {
      if (input.lastTickAt === null) return { level: 'unknown', reason: 'never_checked' };
      return now - input.lastTickAt > TICK_STALE_MS ? { level: 'critical', reason: 'tick_stale' } : OK;
    }
    case 'public_http': {
      if (!status.enabled) return { level: 'unmonitored', reason: null };
      const probe = input.probes[entry.id];
      if (probe === undefined) return { level: 'unknown', reason: 'never_checked' };
      if (!recent(probe.checked_at, now)) return { level: 'unknown', reason: 'stale' };
      let verdict: Verdict = probe.ok ? OK : { level: probe.consecutive_failures >= 2 ? 'critical' : 'warning', reason: probe.error ?? 'http_status' };
      // The Workers' error rate adds to the probe (fresh data only; stale analytics never make the tile unknown).
      if (status.error_rate === true && scriptsFresh(input.scripts, now)) {
        const activity = activityOf(entryScripts(entry.id, registry), input.scripts, now);
        const errors = errorLevel(activity.requests, activity.errors);
        if (errors !== 'ok') verdict = worse(verdict, { level: errors, reason: 'error_rate' });
      }
      return verdict;
    }
    case 'analytics': {
      const doc = input.scripts;
      if (!input.analyticsConfigured || doc === null) return { level: 'unknown', reason: 'never_checked' };
      if (!scriptsFresh(doc, now)) return { level: 'unknown', reason: 'stale' };
      const activity = activityOf(entryScripts(entry.id, registry), doc, now);
      let verdict: Verdict = OK;
      const errors = errorLevel(activity.requests, activity.errors);
      if (errors !== 'ok') verdict = { level: errors, reason: 'error_rate' };
      const idleMs = status.max_idle_hours * HOUR_MS;
      if (activity.last_active_hour === null) {
        // Nothing seen since discovery started: judged only once discovery has watched long enough.
        verdict = worse(verdict, now - doc.since > idleMs ? { level: 'warning', reason: 'idle' } : { level: 'unknown', reason: 'never_seen' });
      } else if (now - (activity.last_active_hour + HOUR_MS) > idleMs) {
        verdict = worse(verdict, { level: 'warning', reason: 'idle' });
      }
      return verdict;
    }
    case 'ops_v1': {
      const doc = input.statuses[entry.id];
      let verdict = reachability(doc, now);
      const fresh = freshStatus(doc, now);
      if (fresh !== null) {
        const holds = holdCodes(entry.id, registry);
        let alarm = false;
        let held = false;
        for (const signal of fresh.signals) {
          const v = signalVerdict(signal, holds);
          if (v === null) continue;
          if (v.level === 'held') held = true;
          else alarm = true;
          verdict = worse(verdict, v);
        }
        // `degraded` without a signal to show (or only holds): the app still says something is off.
        if (fresh.health === 'degraded' && !alarm && !held) verdict = worse(verdict, { level: 'warning', reason: 'app_degraded' });
      }
      return verdict;
    }
  }
}

function tileMetric(entry: EntryDef, level: Level, input: EvalInput, registry: RegistryDef): TileMetric | null {
  const metric = entry.tile_metric;
  if (metric === null) return null;
  switch (metric.kind) {
    case 'counter': {
      const value = input.statuses[entry.id]?.status?.counters[metric.name];
      return typeof value === 'number' ? { kind: 'counter', name: metric.name, value } : null;
    }
    case 'latency': {
      // Only while the tile is ok: a probe that passed next to a high error rate shows that reason instead.
      const probe = input.probes[entry.id];
      return level === 'ok' && probe?.ok === true && probe.latency_ms !== null ? { kind: 'latency', ms: probe.latency_ms } : null;
    }
    case 'last_active': {
      const hour = activityOf(entryScripts(entry.id, registry), input.scripts, input.now).last_active_hour;
      return hour === null ? null : { kind: 'last_active', hour: new Date(hour).toISOString() };
    }
  }
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const;

export function entryState(entry: EntryDef, input: EvalInput, registry: RegistryDef = REGISTRY): EntryState {
  const verdict = entryVerdict(entry, input, registry);
  let checkedAt: number | null = null;
  let failures = 0;
  let topSignals: EntryState['top_signals'] = [];
  switch (entry.status.type) {
    case 'ops_v1': {
      const doc = input.statuses[entry.id];
      checkedAt = doc?.checked_at ?? null;
      failures = doc?.consecutive_failures ?? 0;
      const holds = holdCodes(entry.id, registry);
      topSignals = (freshStatus(doc, input.now)?.signals ?? [])
        .filter((signal) => signal.severity !== 'info' || holds.has(signal.code))
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
        .slice(0, TOP_SIGNALS_MAX)
        .map((signal) => ({ code: signal.code, severity: signal.severity, since: signal.since ?? null }));
      break;
    }
    case 'public_http': {
      const probe = input.probes[entry.id];
      checkedAt = probe?.checked_at ?? null;
      failures = probe?.consecutive_failures ?? 0;
      break;
    }
    case 'analytics':
      checkedAt = input.scripts?.observed_at ?? null;
      break;
    case 'self':
      checkedAt = input.lastTickAt;
      break;
    case 'link_only':
    case 'none':
      break;
  }
  return {
    id: entry.id,
    level: verdict.level,
    reason: verdict.reason,
    checked_at: isoOrNull(checkedAt),
    consecutive_failures: failures,
    top_signals: topSignals,
    metric: tileMetric(entry, verdict.level, input, registry),
  };
}

// ---- flows --------------------------------------------------------------------------------------------

interface CanaryMark {
  readonly badge: CanaryBadge;
  readonly failed: boolean;
  readonly code: string | null;
}

/** The latest finished run (by finished_at) of the recent list. */
export function latestFinishedRun(recentRuns: readonly CanaryRecord[]): CanaryRecord | null {
  let latest: CanaryRecord | null = null;
  for (const run of recentRuns) {
    if (run.phase !== 'done' || run.finished_at === null) continue;
    if (latest === null || (latest.finished_at ?? 0) < run.finished_at) latest = run;
  }
  return latest;
}

/**
 * Canary badges of the stages the runner covers (design-v2 §4): the latest finished run within
 * `fresh_hours` verifies both stages when ok; a failure marks the stage it stopped at (start counts as
 * delivery: Mail Hero could not create the event) critical and leaves the later stage 未验证; a skipped
 * run is 未验证（已暂停）; no run in the window is 未验证.
 */
function canaryMarks(flow: FlowDef, input: EvalInput): Map<string, CanaryMark> {
  const marks = new Map<string, CanaryMark>();
  const canary = flow.canary;
  if (canary === null) return marks;
  const { delivery, consumer } = canary.stage_map;
  const set = (deliver: CanaryMark, consume: CanaryMark): void => {
    marks.set(delivery, deliver);
    marks.set(consumer, consume);
  };
  const none = (badge: CanaryBadge): CanaryMark => ({ badge, failed: false, code: null });
  const run = latestFinishedRun(input.canaryRecent);
  if (run?.finished_at == null || input.now - run.finished_at > canary.fresh_hours * HOUR_MS) {
    set(none('unverified'), none('unverified'));
  } else if (run.outcome === 'ok') {
    set(none('verified'), none('verified'));
  } else if (run.outcome === 'skipped') {
    set(none('held'), none('held'));
  } else if (run.stage === 'consumer') {
    set(none('verified'), { badge: 'failed', failed: true, code: run.code });
  } else {
    set({ badge: 'failed', failed: true, code: run.code }, none('unverified'));
  }
  return marks;
}

function unmonitoredStage(stage: StageDef): StageState {
  return { id: stage.id, level: 'unmonitored', reason: null, held: false, signals: [], counters: [], canary: null, analytics: null, probe: null, checked_at: null };
}

function stageState(stage: StageDef, input: EvalInput, marks: Map<string, CanaryMark>, registry: RegistryDef): StageState {
  const { now } = input;
  const entry = stage.entry === null ? undefined : registry.entries.find((e) => e.id === stage.entry);
  if (entry === undefined) return unmonitoredStage(stage);
  const own = entryVerdict(entry, input, registry);
  if (!isRollup(own.level)) return unmonitoredStage(stage);

  let verdict: Verdict;
  let held = false;
  let signals: StageState['signals'] = [];
  let counters: StageState['counters'] = [];
  if (entry.status.type === 'ops_v1') {
    // The app's reachability, not its other stages' signals: each stage shows its own share.
    const doc = input.statuses[entry.id];
    verdict = reachability(doc, now);
    const status = freshStatus(doc, now);
    const holds = new Set(stage.hold_signals ?? []);
    const claimed = (status?.signals ?? []).filter((signal) => stage.signals.includes(signal.code));
    for (const signal of claimed) {
      const v = signalVerdict(signal, holds);
      if (v === null) continue;
      if (v.level === 'held') held = true;
      verdict = worse(verdict, v);
    }
    signals = claimed.map((signal) => ({ code: signal.code, severity: signal.severity, since: signal.since ?? null, metrics: signal.metrics }));
    counters = (stage.counters ?? []).flatMap((name) => {
      const value = status?.counters[name];
      return typeof value === 'number' ? [{ name, value }] : [];
    });
  } else {
    verdict = { level: own.level, reason: own.reason };
  }

  let analytics: StageState['analytics'] = null;
  if (stage.analytics === true) {
    const activity = activityOf(stageScripts(stage, registry), input.scripts, now);
    analytics = {
      requests: activity.requests,
      errors: activity.errors,
      error_percent: errorPercent(activity.requests, activity.errors),
      last_active_hour: isoOrNull(activity.last_active_hour),
    };
    const errors = errorLevel(activity.requests, activity.errors);
    if (scriptsFresh(input.scripts, now) && errors !== 'ok') verdict = worse(verdict, { level: errors, reason: 'error_rate' });
  }

  let probe: StageState['probe'] = null;
  if (entry.status.type === 'public_http') {
    const doc = input.probes[entry.id];
    probe = { checked_at: isoOrNull(doc?.checked_at), ok: doc?.ok ?? null, http_status: doc?.http_status ?? null, latency_ms: doc?.latency_ms ?? null };
  }

  const mark = marks.get(stage.id);
  if (mark?.failed === true) verdict = worse(verdict, { level: 'critical', reason: 'canary_failed' });

  const checkedAt = entry.status.type === 'ops_v1' ? (input.statuses[entry.id]?.checked_at ?? null) : entry.status.type === 'self' ? input.lastTickAt : null;

  return {
    id: stage.id,
    level: verdict.level,
    reason: verdict.level === 'ok' ? null : verdict.reason,
    held: held && verdict.level === 'held',
    signals,
    counters,
    canary: mark?.badge ?? null,
    analytics,
    probe,
    checked_at: isoOrNull(checkedAt),
  };
}

function freshness(flow: FlowDef, stages: readonly StageState[], input: EvalInput, registry: RegistryDef): Freshness {
  if (flow.canary !== null) {
    const done = input.canaryRecent.filter((run) => run.phase === 'done');
    const okRuns = done.filter((run) => run.outcome === 'ok');
    const lastOk = okRuns.reduce<number | null>((best, run) => (run.finished_at !== null && (best === null || run.finished_at > best) ? run.finished_at : best), null);
    return { kind: 'canary', at: isoOrNull(lastOk), ok_runs: okRuns.length, runs: done.length };
  }
  const selfStage = flow.stages.some((stage) => registry.entries.find((e) => e.id === stage.entry)?.status.type === 'self');
  if (selfStage) {
    const receipt = input.digest.last_receipt;
    const at = isoOrNull(input.digest.last_sent_at);
    // `accepted` is left out before the first receipt (Freshness.accepted).
    return receipt === null ? { kind: 'digest', at } : { kind: 'digest', at, accepted: receipt.stored };
  }
  const website = flow.stages.find(stage => stage.entry === 'notion-publish');
  if (website !== undefined) {
    return { kind: 'content_check', at: input.statuses['notion-publish']?.status?.website_sync?.last_check?.checked_at ?? null };
  }
  let last: string | null = null;
  let any = false;
  for (const stage of stages) {
    if (stage.analytics === null) continue;
    any = true;
    const hour = stage.analytics.last_active_hour;
    if (hour !== null && (last === null || hour > last)) last = hour;
  }
  return any ? { kind: 'activity', at: last } : { kind: 'none', at: null };
}

/** Every flow's state in display order (FlowsView.flows); `summary` drops the per-stage detail. */
export function flowStates(input: EvalInput, registry: RegistryDef = REGISTRY): Omit<FlowState, 'canary'>[] {
  const flows = orderedFlows(registry);
  // An unplaced code of an entry is listed once, on the first flow (display order) that has the entry.
  const firstFlowOf = new Map<string, string>();
  for (const flow of flows) for (const stage of flow.stages) if (stage.entry !== null && !firstFlowOf.has(stage.entry)) firstFlowOf.set(stage.entry, flow.id);

  return flows.map((flow) => {
    const marks = canaryMarks(flow, input);
    const stages = flow.stages.map((stage) => stageState(stage, input, marks, registry));
    const monitored = stages.filter((stage) => isRollup(stage.level));
    const level = rollup(monitored.map((stage) => stage.level)) ?? 'unmonitored';
    // The first stage at the flow's (worst) level, so a 故障 row never shows a lesser stage's reason.
    const issue = level === 'ok' ? undefined : monitored.find((stage) => stage.level === level);
    const unclassified: FlowState['unclassified'][number][] = [];
    for (const [entryId, flowId] of firstFlowOf) {
      if (flowId !== flow.id) continue;
      const entry = registry.entries.find((e) => e.id === entryId);
      if (entry?.status.type !== 'ops_v1') continue;
      const placed = placedCodes(entry, registry);
      for (const signal of freshStatus(input.statuses[entryId], input.now)?.signals ?? []) {
        if (!placed.has(signal.code)) unclassified.push({ entry: entryId, code: signal.code, severity: signal.severity });
      }
    }
    return {
      id: flow.id,
      level,
      partial: monitored.length * 2 < stages.length,
      coverage: { monitored: monitored.length, total: stages.length },
      first_issue: issue === undefined ? null : { stage: issue.id, code: issue.reason },
      freshness: freshness(flow, stages, input, registry),
      stages,
      unclassified,
    };
  });
}

export function flowSummaries(input: EvalInput, registry: RegistryDef = REGISTRY): FlowSummary[] {
  return flowStates(input, registry).map(({ id, level, partial, coverage, first_issue, freshness: fresh }) => ({
    id,
    level,
    partial,
    coverage,
    first_issue,
    freshness: fresh,
  }));
}

// ---- attention ----------------------------------------------------------------------------------------

const CANARY_ITEM_STAGE: Readonly<Record<string, 'delivery' | 'consumer' | null>> = {
  canary_start_failed: 'delivery',
  canary_not_delivered: 'delivery',
  canary_consumer_failed: 'consumer',
  canary_skipped: null,
  canary_disabled: null,
};

/** Where an item (source, code) is shown: the flow stage that claims it, else the entry or the view. */
export function targetOf(source: string, code: string, registry: RegistryDef = REGISTRY): Target {
  const flows = orderedFlows(registry);
  const entry = registry.entries.find((e) => e.id === source);
  if (entry !== undefined) {
    if (code === 'app_unreachable' || code === 'app_down' || code === 'status_unavailable') return { view: 'home', entry: entry.id };
    for (const flow of flows) {
      const stage = flow.stages.find((s) => s.entry === entry.id && s.signals.includes(code));
      if (stage !== undefined) return { view: 'flows', flow: flow.id, stage: stage.id, entry: entry.id };
    }
    return { view: 'ops', entry: entry.id };
  }
  if (source === 'cloudflare') return { view: 'cloudflare' };
  if (code in CANARY_ITEM_STAGE) {
    const flow = flows.find((f) => f.canary !== null);
    if (flow?.canary == null) return { view: 'ops' };
    const runnerStage = CANARY_ITEM_STAGE[code];
    return runnerStage == null ? { view: 'flows', flow: flow.id } : { view: 'flows', flow: flow.id, stage: flow.canary.stage_map[runnerStage] };
  }
  if (code === 'tick_stale') {
    for (const flow of flows) {
      const stage = flow.stages.find((s) => registry.entries.find((e) => e.id === s.entry)?.status.type === 'self');
      if (stage !== undefined) return { view: 'flows', flow: flow.id, stage: stage.id };
    }
    return { view: 'ops' };
  }
  if (code === 'usage_not_configured' || code === 'usage_unavailable') return { view: 'cloudflare' };
  if (code === 'config_drift' || code === 'drift_unavailable') return { view: 'cloudflare' };
  return { view: 'ops' };
}

export interface AttentionInput {
  readonly now: number;
  /** Nothing ran yet (no tick, digest or refresh): the level is unknown. */
  readonly neverRan: boolean;
  /** The stored digest items with the tick state applied (withTickState). */
  readonly items: readonly AttentionSource[];
  readonly canaryEnabled: boolean;
  readonly desired: DesiredGuard;
  readonly ownerShedApps?: readonly string[];
  readonly statuses: Readonly<Record<string, StatusDoc>>;
  /**
   * What the views evaluate (tiles, flow stages, Workers): levels worse than ok that no digest item
   * explains become observed items. Omitted (or before anything ran): digest items only.
   */
  readonly evaluation?: EvalInput;
}

type AttentionSource = Omit<AttentionItem, 'target' | 'since'> & { readonly since: string };

export const NO_BADGES: Badges = { home: 0, flows: 0, cloudflare: 0, ops: 0 };

type ObservedLevel = NonNullable<AttentionItem['observed']>;

const isObservedLevel = (level: Level): level is ObservedLevel => level === 'warning' || level === 'critical' || level === 'unknown';

/** Codes that say the same thing about an entry: the view's `unreachable` is the digest's `app_unreachable`. */
const sameCode = (a: string, b: string): boolean => a === b || (a === 'unreachable' && b === 'app_unreachable') || (a === 'app_unreachable' && b === 'unreachable');

function observedItem(source: string, code: string, level: ObservedLevel, target: Target): AttentionItem {
  return { source, code, severity: level === 'critical' ? 'critical' : 'warning', since: null, metrics: {}, target, observed: level };
}

/**
 * The observed items (design-v2 §3.1/§3.4: the strip and the badges never say less than the views):
 * one per cause, in this order, each skipped when an item already explains it —
 * 1. an entry (tile) at warning/critical/unknown, unless a digest item of that entry has the same
 *    code (its signals, app_unreachable, app_down); target: the tile;
 * 2. a flow stage at those levels whose cause is not already listed (same entry and code, or an item
 *    targeting that stage, such as a canary failure); target: the stage;
 * 3. a Worker whose error rate is warning/critical, unless its entry already has an error_rate item;
 *    target: its row on the Cloudflare view. A public_http tile with `error_rate` owns that item only while
 *    the error rate decides it; a probe failure at least as severe keeps the tile, and the row lists the rate.
 * This dashboard's own entry is left out: `tick_stale` (digest) already says the ticks stopped.
 */
function observedItems(existing: readonly AttentionItem[], evaluation: EvalInput, registry: RegistryDef): AttentionItem[] {
  const out: AttentionItem[] = [];
  const all = (): AttentionItem[] => [...existing, ...out];
  const explained = (source: string, code: string): boolean => all().some((item) => item.source === source && sameCode(item.code, code));

  for (const entry of registry.entries) {
    if (entry.status.type === 'self') continue;
    const state = entryState(entry, evaluation, registry);
    if (!isObservedLevel(state.level) || state.reason === null) continue;
    if (existing.some((item) => item.source === entry.id && sameCode(item.code, state.reason as string))) continue;
    out.push(observedItem(entry.id, state.reason, state.level, { view: 'home', entry: entry.id }));
  }

  for (const flow of flowStates(evaluation, registry)) {
    const def = registry.flows.find((f) => f.id === flow.id);
    for (const stage of flow.stages) {
      const entryId = def?.stages.find((s) => s.id === stage.id)?.entry ?? null;
      if (entryId === null || !isObservedLevel(stage.level) || stage.reason === null) continue;
      if (registry.entries.find((e) => e.id === entryId)?.status.type === 'self') continue;
      if (explained(entryId, stage.reason)) continue;
      if (all().some((item) => item.target.flow === flow.id && item.target.stage === stage.id)) continue;
      out.push(observedItem(entryId, stage.reason, stage.level, { view: 'flows', flow: flow.id, stage: stage.id, entry: entryId }));
    }
  }

  if (scriptsFresh(evaluation.scripts, evaluation.now)) {
    for (const row of workerRows(evaluation.scripts, evaluation.now, registry)) {
      if (!isObservedLevel(row.level)) continue;
      if (row.entry !== null && explained(row.entry, 'error_rate')) continue;
      out.push(observedItem(row.entry ?? 'cloudflare', 'error_rate', row.level, { view: 'cloudflare', script: row.script }));
    }
  }
  return out;
}

/**
 * The attention strip (design-v2 §1): v1's item set with a target each, plus the observed items
 * (observedItems) when `evaluation` is given. A hold signal of its entry (force-paused delivery, paused
 * processing, ...) and an owner's forced shed are shown as ‖ 已暂停 tags instead of alarms (not counted
 * in the level or the badges); maintenance stays critical. Badges count the warning, critical and
 * unknown items per target view.
 */
export function attentionView(input: AttentionInput, registry: RegistryDef = REGISTRY): { attention: Attention; badges: Badges } {
  const held: HeldItem[] = [];
  const heldKeys = new Set<string>();
  const addHeld = (entry: string, code: string, target: Target): void => {
    const key = `${entry}:${code}`;
    if (heldKeys.has(key)) return;
    heldKeys.add(key);
    held.push({ entry, code, target });
  };
  // Holds seen in the current statuses (info-severity ones are not in the digest).
  for (const entry of registry.entries) {
    if (entry.status.type !== 'ops_v1') continue;
    const holds = holdCodes(entry.id, registry);
    for (const signal of freshStatus(input.statuses[entry.id], input.now)?.signals ?? []) {
      if (holds.has(signal.code)) addHeld(entry.id, signal.code, targetOf(entry.id, signal.code, registry));
    }
  }
  const ownerShed = input.desired.level === 'shed' && input.desired.source === 'owner';
  if (input.ownerShedApps === undefined) {
    if (ownerShed) addHeld('home', 'owner_shed', { view: 'ops' });
  } else {
    for (const app of input.ownerShedApps) addHeld(app, 'owner_shed', { view: 'ops', entry: app });
  }

  const items: AttentionItem[] = [];
  for (const item of input.items) {
    if (item.severity === 'info') continue;
    const target = targetOf(item.source, item.code, registry);
    const entry = registry.entries.find((e) => e.id === item.source);
    if (entry !== undefined && holdCodes(entry.id, registry).has(item.code)) {
      addHeld(entry.id, item.code, target);
      continue;
    }
    if (ownerShed && item.source === 'dashboard' && item.code === 'guard_shed') continue;
    items.push({ ...item, target });
  }
  if (!input.neverRan && input.evaluation !== undefined) items.push(...observedItems(items, input.evaluation, registry));
  sortAttention(items);
  const info: AttentionItem[] = input.canaryEnabled
    ? []
    : [{ ...CANARY_DISABLED_ITEM, since: null, metrics: {}, target: targetOf(CANARY_DISABLED_ITEM.source, CANARY_DISABLED_ITEM.code, registry) }];
  const level = rollupAttention(items, input.neverRan);
  const badges: Record<ViewId, number> = { ...NO_BADGES };
  for (const item of items) badges[item.target.view] += 1;
  return { attention: { level, items, info, held }, badges };
}
