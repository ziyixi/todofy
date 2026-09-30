/**
 * HomeState: the one SQLite-backed Durable Object ("home-v1") that does all real work
 * (docs/design.md §3–§5): status polling, the GraphQL usage query, guard, canary, digest and the
 * overview assembled from its tables. The fetch and scheduled handlers only call these RPC methods.
 *
 * Bounds: every tick makes at most 8 outbound calls (2 status, ≤ 2 setGuard, ≤ 2 canary calls,
 * ≤ 1 reportOps, 1 GraphQL) and writes a few dozen rows; the overview reads about 30 rows.
 */
import { DurableObject } from 'cloudflare:workers';
import { OPS_APPS, OPS_LIMITS, type GuardLevel, type GuardState, type OpsApp, type OpsReportItem, type OpsReportReceipt, type OpsStatus, type SetGuardInput } from '../../../contracts/ops-v1/ops-v1.ts';
import {
  API_VERSION,
  CANARY_MANUAL_PER_DAY,
  CANARY_RECENT_RUNS,
  GUARD_CLEAR_PERCENT,
  GUARD_SHED_PERCENT,
  REFRESH_MIN_INTERVAL_SECONDS,
  type AppCard,
  type AppErrorCode,
  type CanaryRun,
  type CanaryView,
  type DigestView,
  type GuardAppView,
  type GuardView,
  type OverviewResponse,
  type QuotaRow,
  type UsageView,
} from './api-types.ts';
import {
  CANARY_RETENTION_MS,
  applyDeadline,
  applyDelivery,
  applyResult,
  applyStart,
  finish,
  manualRunId,
  newRun,
  nextScheduledAt,
  runView,
  scheduledRunId,
  startPrecondition,
  waitForStatus,
  type CanaryRecord,
} from './canary.ts';
import { analyticsConfigured, buildSha, canaryHour, dashboardUrl } from './config.ts';
import { buildReport, candidates, digestKey, finalizeItems, itemKey, overallLevel, shouldSend, DIGEST_REFRESH_MS } from './digest.ts';
import type { Env } from './env.ts';
import {
  AUTO_NORMAL,
  NO_APPLIED,
  activeOverride,
  desiredGuard,
  evaluateAuto,
  guardInput,
  needsApply,
  ownerOverride,
  usageFresh,
  type AppliedGuard,
  type AutoGuard,
  type DesiredGuard,
  type GuardOverrideDoc,
} from './guard.ts';
import { opsCanaryDelivery, opsCanaryResult, opsReportOps, opsSetGuard, opsStartCanary, opsStatus } from './ops-client.ts';
import { MINUTE_MS, iso, isoOrNull, utcDay, utcMonthStart } from './time.ts';
import { fetchUsage, type UsageErrorCode } from './usage.ts';

/** Name of the single object instance. */
export const HOME_OBJECT = 'home-v1';

/** A cron event within this of the last completed tick is a retry and is skipped. */
export const TICK_DEDUP_MS = 10 * MINUTE_MS;
/** Owner refreshes poll an app's status() only when its last attempt is at least this old. */
export const STATUS_REFRESH_MS = OPS_LIMITS.statusMinIntervalSeconds * 1000;
const REFRESH_MIN_MS = REFRESH_MIN_INTERVAL_SECONDS * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    doc TEXT NOT NULL CHECK (length(doc) <= 65536),
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS guard_applied (
    app TEXT PRIMARY KEY CHECK (app IN ('mail-hero', 'todofy')),
    input TEXT,
    state TEXT,
    last_call_at INTEGER,
    last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS canary_runs (
    run_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'manual')),
    day TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('starting', 'delivering', 'consuming', 'done')),
    outcome TEXT CHECK (outcome IN ('ok', 'failed', 'skipped')),
    stage TEXT CHECK (stage IN ('start', 'delivery', 'consumer')),
    code TEXT,
    event_id TEXT,
    created_at INTEGER NOT NULL,
    queued_at INTEGER, delivered_at INTEGER, completed_at INTEGER, finished_at INTEGER,
    deadline_at INTEGER NOT NULL,
    doc TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS canary_runs_by_created ON canary_runs (created_at)',
  'CREATE INDEX IF NOT EXISTS canary_runs_by_day ON canary_runs (day, kind)',
  'CREATE INDEX IF NOT EXISTS canary_runs_by_finished ON canary_runs (finished_at)',
  'CREATE TABLE IF NOT EXISTS item_since (key TEXT PRIMARY KEY, since INTEGER NOT NULL)',
];

interface StatusDoc {
  readonly checked_at: number | null;
  readonly ok: boolean | null;
  readonly error: AppErrorCode | null;
  readonly consecutive_failures: number;
  readonly status: OpsStatus | null;
  readonly status_at: number | null;
}

interface UsageDoc {
  readonly fetched_at: number | null;
  readonly day: string | null;
  readonly month: string | null;
  readonly rows: QuotaRow[];
  readonly unclassified_r2_operations: number;
  readonly last_error: UsageErrorCode | null;
  readonly last_error_at: number | null;
  readonly last_http_status: number | null;
  readonly consecutive_failures: number;
  readonly last_attempt_at: number | null;
}

interface DigestDoc {
  readonly items: OpsReportItem[];
  readonly last_key: string | null;
  readonly last_sent_at: number | null;
  readonly last_generated_at: number | null;
  readonly last_receipt: OpsReportReceipt | null;
  readonly last_error: AppErrorCode | null;
  readonly last_attempt_at: number | null;
}

interface MetaDoc {
  readonly last_tick_at: number | null;
  readonly last_tick_scheduled: number | null;
  readonly last_refresh_at: number | null;
}

const NO_STATUS: StatusDoc = { checked_at: null, ok: null, error: null, consecutive_failures: 0, status: null, status_at: null };
const NO_USAGE: UsageDoc = {
  fetched_at: null,
  day: null,
  month: null,
  rows: [],
  unclassified_r2_operations: 0,
  last_error: null,
  last_error_at: null,
  last_http_status: null,
  consecutive_failures: 0,
  last_attempt_at: null,
};
const NO_DIGEST: DigestDoc = {
  items: [],
  last_key: null,
  last_sent_at: null,
  last_generated_at: null,
  last_receipt: null,
  last_error: null,
  last_attempt_at: null,
};
const NO_META: MetaDoc = { last_tick_at: null, last_tick_scheduled: null, last_refresh_at: null };

export type StartCanaryOutcome = { readonly ok: true; readonly run: CanaryRun } | { readonly ok: false; readonly code: 'canary_active' | 'canary_limit' | 'unavailable' };
export type GuardOverrideOutcome = { readonly ok: true; readonly guard: GuardView } | { readonly ok: false; readonly code: 'unavailable' };

interface CanaryRow extends Record<string, SqlStorageValue> {
  run_id: string;
  kind: string;
  day: string;
  phase: string;
  outcome: string | null;
  stage: string | null;
  code: string | null;
  event_id: string | null;
  created_at: number;
  queued_at: number | null;
  delivered_at: number | null;
  completed_at: number | null;
  finished_at: number | null;
  deadline_at: number;
  doc: string;
}

interface AppliedRow extends Record<string, SqlStorageValue> {
  app: string;
  input: string | null;
  state: string | null;
  last_call_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
}

export class HomeState extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
      return Promise.resolve();
    });
  }

  // ---- RPC ----------------------------------------------------------------------------------------

  /** One cron tick at `scheduledTime` (§5): status, usage, guard, canary, digest, cleanup. */
  tick(scheduledTime: number): Promise<{ ran: boolean }> {
    return this.serialize(async () => {
      const now = scheduledTime;
      const meta = this.doc<MetaDoc>('meta') ?? NO_META;
      if (meta.last_tick_scheduled !== null && Math.abs(now - meta.last_tick_scheduled) < TICK_DEDUP_MS) {
        console.log(JSON.stringify({ event: 'tick', ran: false }));
        return { ran: false };
      }
      const started = Date.now();
      const observed = await this.pollStatuses(now, OPS_APPS);
      const usage = await this.pollUsage(now);
      const guard = await this.runGuard(now, observed);
      const canary = await this.runCanary(now, true);
      const digest = await this.runDigest(now, guard.desired, true);
      this.ctx.storage.sql.exec('DELETE FROM canary_runs WHERE created_at < ?', now - CANARY_RETENTION_MS);
      this.putDoc('meta', { ...meta, last_tick_at: now, last_tick_scheduled: now }, now);
      console.log(
        JSON.stringify({
          event: 'tick',
          ran: true,
          duration_ms: Date.now() - started,
          status: Object.fromEntries(OPS_APPS.map((app) => [app, observed[app] === null ? 'failed' : 'ok'])),
          usage: usage ?? 'ok',
          guard: guard.desired.level,
          guard_calls: guard.calls,
          canary: canary,
          digest: digest.sent,
          items: digest.items,
        }),
      );
      return { ran: true };
    });
  }

  /** GET /api/v1/overview; `refresh` polls what is due first (usage ≥ 60 s, status ≥ 10 min per app). */
  overview(refresh: boolean): Promise<OverviewResponse> {
    if (!refresh) return Promise.resolve(this.buildOverview(Date.now(), false));
    return this.serialize(async () => {
      const now = Date.now();
      const statuses = OPS_APPS.filter((app) => {
        const doc = this.statusDoc(app);
        return doc.checked_at === null || now - doc.checked_at >= STATUS_REFRESH_MS || now < doc.checked_at;
      });
      const usage = this.doc<UsageDoc>('usage') ?? NO_USAGE;
      const usageDue =
        analyticsConfigured(this.env) &&
        (usage.last_attempt_at === null || now - usage.last_attempt_at >= REFRESH_MIN_MS || now < usage.last_attempt_at);
      const meta = this.doc<MetaDoc>('meta') ?? NO_META;
      const refreshDue = meta.last_refresh_at === null || now - meta.last_refresh_at >= REFRESH_MIN_MS || now < meta.last_refresh_at;
      if (!refreshDue || (statuses.length === 0 && !usageDue)) return this.buildOverview(now, false);
      if (statuses.length > 0) await this.pollStatuses(now, statuses);
      if (usageDue) await this.pollUsage(now);
      const desired = this.currentDesired(now);
      await this.runDigest(now, desired, false);
      this.putDoc('meta', { ...meta, last_refresh_at: now }, now);
      return this.buildOverview(now, true);
    });
  }

  /** POST /api/v1/canary: a manual run with its first start attempt; later steps happen on ticks. */
  startCanary(): Promise<StartCanaryOutcome> {
    return this.serialize(async (): Promise<StartCanaryOutcome> => {
      const now = Date.now();
      if (this.activeRun() !== null) return { ok: false, code: 'canary_active' };
      if (this.manualCount(utcDay(now)) >= CANARY_MANUAL_PER_DAY) return { ok: false, code: 'canary_limit' };
      const stale = OPS_APPS.filter((app) => {
        const doc = this.statusDoc(app);
        return doc.checked_at === null || now - doc.checked_at >= STATUS_REFRESH_MS;
      });
      if (stale.length > 0) await this.pollStatuses(now, stale);
      // Run IDs have one-second resolution and Mail Hero is idempotent per run_id: never reuse one.
      let runId = manualRunId(now);
      for (let k = 1; this.runExists(runId); k++) runId = manualRunId(now + k * 1000);
      const run = await this.advance(newRun(runId, 'manual', now), now);
      this.saveRun(run);
      console.log(JSON.stringify({ event: 'canary_manual', phase: run.phase, outcome: run.outcome, code: run.code }));
      return { ok: true, run: runView(run) };
    });
  }

  /** POST /api/v1/guard: force shed for 24 h, or clear and suppress the automatic shed until 00:00 UTC. */
  setGuardOverride(level: GuardLevel): Promise<GuardOverrideOutcome> {
    return this.serialize(async (): Promise<GuardOverrideOutcome> => {
      const now = Date.now();
      this.putDoc('guard_override', ownerOverride(level, now), now);
      // A cleared episode must not come back when the override ends (the auto shed's own until).
      if (level === 'normal') this.putDoc('guard', AUTO_NORMAL, now);
      const desired = this.currentDesired(now);
      const calls = await this.applyGuard(now, desired, { 'mail-hero': null, todofy: null });
      console.log(JSON.stringify({ event: 'guard_override', level, guard_calls: calls }));
      return { ok: true, guard: this.guardView(now) };
    });
  }

  // ---- the tick's steps -------------------------------------------------------------------------

  /** status() of the given apps in parallel; returns the statuses this call obtained (null on failure). */
  private async pollStatuses(now: number, apps: readonly OpsApp[]): Promise<Record<OpsApp, OpsStatus | null>> {
    const observed: Record<OpsApp, OpsStatus | null> = { 'mail-hero': null, todofy: null };
    const results = await Promise.all(apps.map(async (app) => [app, await opsStatus(this.env, app)] as const));
    for (const [app, result] of results) {
      const previous = this.statusDoc(app);
      const doc: StatusDoc = result.ok
        ? { checked_at: now, ok: true, error: null, consecutive_failures: 0, status: result.value, status_at: now }
        : { ...previous, checked_at: now, ok: false, error: result.code, consecutive_failures: previous.consecutive_failures + 1 };
      this.putDoc(`status:${app}`, doc, now);
      if (result.ok) observed[app] = result.value;
    }
    return observed;
  }

  /** One GraphQL request (or none without a token); returns the error code, null on success. */
  private async pollUsage(now: number): Promise<UsageErrorCode | null> {
    const previous = this.doc<UsageDoc>('usage') ?? NO_USAGE;
    const result = await fetchUsage(this.env.CF_ANALYTICS_TOKEN, this.env.ACCOUNT_ID, now);
    let doc: UsageDoc;
    if (result.ok) {
      doc = {
        fetched_at: now,
        day: utcDay(now),
        month: utcMonthStart(now),
        rows: result.data.rows,
        unclassified_r2_operations: result.data.unclassified_r2_operations,
        last_error: null,
        last_error_at: null,
        last_http_status: 200,
        consecutive_failures: 0,
        last_attempt_at: now,
      };
    } else {
      const configured = result.code !== 'not_configured';
      doc = {
        ...previous,
        last_error: result.code,
        last_error_at: now,
        last_http_status: result.http_status,
        consecutive_failures: configured ? previous.consecutive_failures + 1 : 0,
        last_attempt_at: now,
      };
    }
    this.putDoc('usage', doc, now);
    return result.ok ? null : result.code;
  }

  private currentDesired(now: number): DesiredGuard {
    const override = activeOverride(this.doc<GuardOverrideDoc>('guard_override'), now);
    return desiredGuard(now, this.doc<AutoGuard>('guard'), override);
  }

  private async runGuard(now: number, observed: Record<OpsApp, OpsStatus | null>): Promise<{ desired: DesiredGuard; calls: number }> {
    const stored = this.doc<GuardOverrideDoc>('guard_override');
    const override = activeOverride(stored, now);
    if (stored !== null && override === null) this.deleteDoc('guard_override');
    const usage = this.doc<UsageDoc>('usage');
    // While the owner has cleared the guard, the automatic rule stays off until the override ends.
    const auto = override?.level === 'normal' ? AUTO_NORMAL : evaluateAuto(now, usage, this.doc<AutoGuard>('guard'));
    this.putDoc('guard', auto, now);
    const desired = desiredGuard(now, auto, override);
    const calls = await this.applyGuard(now, desired, {
      'mail-hero': observed['mail-hero']?.guard ?? null,
      todofy: observed.todofy?.guard ?? null,
    });
    return { desired, calls };
  }

  /** setGuard on each app that supports it and needs it (§5.3 "Applying"), in parallel. */
  private async applyGuard(now: number, desired: DesiredGuard, observed: Record<OpsApp, GuardState | null>): Promise<number> {
    const input = guardInput(desired, now);
    const targets = OPS_APPS.filter((app) => {
      const status = this.statusDoc(app).status;
      return status !== null && status.capabilities.includes('guard') && needsApply(input, this.applied(app), observed[app]);
    });
    const results = await Promise.all(targets.map(async (app) => [app, await opsSetGuard(this.env, app, input)] as const));
    for (const [app, result] of results) {
      const previous = this.applied(app);
      this.saveApplied(
        app,
        result.ok
          ? { input, state: result.value, last_call_at: now, last_error: null, consecutive_failures: 0 }
          : { ...previous, last_call_at: now, last_error: result.code, consecutive_failures: previous.consecutive_failures + 1 },
      );
    }
    return targets.length;
  }

  /** Advances the active run, or starts the day's scheduled run when due (§5.4). */
  private async runCanary(now: number, scheduled: boolean): Promise<string> {
    const active = this.activeRun();
    if (active !== null) {
      const run = await this.advance(active, now);
      this.saveRun(run);
      return run.phase === 'done' ? `${run.outcome ?? 'done'}:${run.code ?? ''}` : run.phase;
    }
    const day = utcDay(now);
    if (!scheduled || new Date(now).getUTCHours() < canaryHour(this.env) || this.scheduledExists(day)) return 'idle';
    const run = await this.advance(newRun(scheduledRunId(now), 'scheduled', now), now);
    this.saveRun(run);
    return `scheduled:${run.phase}`;
  }

  /** At most one call per phase (two when a delivery completes and the result is read at once). */
  private async advance(run: CanaryRecord, now: number): Promise<CanaryRecord> {
    switch (run.phase) {
      case 'starting': {
        const mh = this.statusDoc('mail-hero');
        const td = this.statusDoc('todofy');
        const pre = startPrecondition(mh, td, now);
        if (pre.kind === 'skip') return finish(run, 'skipped', 'start', pre.code, now);
        const next = pre.kind === 'wait' ? waitForStatus(run) : applyStart(run, await opsStartCanary(this.env, { run_id: run.run_id }), now);
        return applyDeadline(next, now);
      }
      case 'delivering': {
        const next = applyDelivery(run, await opsCanaryDelivery(this.env, run.event_id ?? ''), now);
        if (next.phase === 'consuming') return applyResult(next, await opsCanaryResult(this.env, run.event_id ?? ''), now);
        return applyDeadline(next, now);
      }
      case 'consuming':
        return applyDeadline(applyResult(run, await opsCanaryResult(this.env, run.event_id ?? ''), now), now);
      case 'done':
        return run;
    }
  }

  /** Builds this tick's items; on a tick, sends them when due (§5.5). */
  private async runDigest(now: number, desired: DesiredGuard, send: boolean): Promise<{ sent: string; items: number }> {
    const usage = this.doc<UsageDoc>('usage') ?? NO_USAGE;
    const list = candidates({
      now,
      usage: {
        configured: analyticsConfigured(this.env),
        fresh: usageFresh(usage, now),
        rows: usage.rows,
        fetched_at: usage.fetched_at,
        consecutive_failures: usage.consecutive_failures,
        last_http_status: usage.last_http_status,
      },
      desired,
      guardFailures: { 'mail-hero': this.applied('mail-hero').consecutive_failures, todofy: this.applied('todofy').consecutive_failures },
      latestFinished: this.latestFinished(),
      apps: { 'mail-hero': this.statusDoc('mail-hero'), todofy: this.statusDoc('todofy') },
    });
    const firstSeen = this.syncSince(list.map(itemKey), now);
    const items = finalizeItems(list, firstSeen, now);
    const previous = this.doc<DigestDoc>('digest') ?? NO_DIGEST;
    let doc: DigestDoc = { ...previous, items };
    let sent = 'none';
    const enabled = this.statusDoc('todofy').status?.capabilities.includes('ops_digest') === true;
    const key = digestKey(items);
    if (send && enabled && shouldSend(key, previous, now)) {
      const report = buildReport(items, now, dashboardUrl(this.env));
      const result = await opsReportOps(this.env, report);
      doc = result.ok
        ? { ...doc, last_key: key, last_sent_at: now, last_generated_at: now, last_receipt: result.value, last_error: null, last_attempt_at: now }
        : { ...doc, last_error: result.code, last_attempt_at: now };
      sent = result.ok ? 'sent' : result.code;
    }
    this.putDoc('digest', doc, now);
    return { sent, items: items.length };
  }

  // ---- overview ---------------------------------------------------------------------------------

  private buildOverview(now: number, refreshed: boolean): OverviewResponse {
    const meta = this.doc<MetaDoc>('meta') ?? NO_META;
    const digest = this.doc<DigestDoc>('digest') ?? NO_DIGEST;
    const todofy = this.statusDoc('todofy');
    const lastRefresh = meta.last_refresh_at;
    return {
      version: API_VERSION,
      generated_at: iso(now),
      overall: {
        level: meta.last_tick_at === null && digest.last_attempt_at === null && lastRefresh === null ? 'unknown' : overallLevel(digest.items),
        codes: digest.items.map((item) => item.code).slice(0, OPS_LIMITS.reportMaxItems),
      },
      apps: { 'mail-hero': this.appCard('mail-hero'), todofy: this.appCard('todofy') },
      usage: this.usageView(now),
      guard: this.guardView(now),
      canary: this.canaryView(now),
      digest: this.digestView(digest, todofy.status?.capabilities.includes('ops_digest') === true),
      refresh: {
        last_tick_at: isoOrNull(meta.last_tick_at),
        last_refresh_at: isoOrNull(lastRefresh),
        next_refresh_at: iso(lastRefresh === null ? now : Math.max(now, lastRefresh + REFRESH_MIN_MS)),
        refreshed,
      },
      build: buildSha(this.env),
    };
  }

  private appCard(app: OpsApp): AppCard {
    const doc = this.statusDoc(app);
    return {
      app,
      url: app === 'mail-hero' ? this.env.MAIL_HERO_URL : this.env.TODOFY_URL,
      reachable: doc.ok,
      checked_at: isoOrNull(doc.checked_at),
      error: doc.error,
      consecutive_failures: doc.consecutive_failures,
      status: doc.status,
      status_at: isoOrNull(doc.status_at),
    };
  }

  private usageView(now: number): UsageView {
    const usage = this.doc<UsageDoc>('usage') ?? NO_USAGE;
    const status: UsageView['status'] = !analyticsConfigured(this.env)
      ? 'not_configured'
      : usage.fetched_at === null
        ? 'unavailable'
        : usageFresh(usage, now)
          ? 'ok'
          : 'stale';
    return {
      status,
      fetched_at: isoOrNull(usage.fetched_at),
      day: usage.day,
      month: usage.month,
      last_error: usage.last_error,
      last_error_at: isoOrNull(usage.last_error_at),
      consecutive_failures: usage.consecutive_failures,
      rows: usage.rows,
      unclassified_r2_operations: usage.unclassified_r2_operations,
    };
  }

  private guardView(now: number): GuardView {
    const desired = this.currentDesired(now);
    const override = activeOverride(this.doc<GuardOverrideDoc>('guard_override'), now);
    const appView = (app: OpsApp): GuardAppView => {
      const applied = this.applied(app);
      const status = this.statusDoc(app);
      const seen = status.status;
      const fromStatus = seen !== null && status.status_at !== null && (applied.last_call_at === null || status.status_at > applied.last_call_at);
      return {
        state: fromStatus ? seen.guard : applied.state,
        last_call_at: isoOrNull(applied.last_call_at),
        last_error: applied.last_error,
      };
    };
    return {
      desired: { level: desired.level, reason: desired.reason, until: isoOrNull(desired.until), source: desired.source },
      override: override === null ? null : { level: override.level, until: iso(override.until), set_at: iso(override.set_at) },
      thresholds: { shed_percent: GUARD_SHED_PERCENT, clear_percent: GUARD_CLEAR_PERCENT },
      apps: { 'mail-hero': appView('mail-hero'), todofy: appView('todofy') },
    };
  }

  private canaryView(now: number): CanaryView {
    const day = utcDay(now);
    const recent = this.ctx.storage.sql
      .exec<CanaryRow>('SELECT * FROM canary_runs ORDER BY created_at DESC LIMIT ?', CANARY_RECENT_RUNS)
      .toArray()
      .map(fromRow);
    const active = this.activeRun();
    const today = recent.find((run) => run.day === day) ?? null;
    const hour = canaryHour(this.env);
    return {
      hour_utc: hour,
      next_scheduled_at: iso(nextScheduledAt(now, hour, this.scheduledExists(day))),
      today: today === null ? null : runView(today),
      active: active === null ? null : runView(active),
      recent: recent.map(runView),
      manual_today: this.manualCount(day),
      manual_limit: CANARY_MANUAL_PER_DAY,
    };
  }

  private digestView(digest: DigestDoc, enabled: boolean): DigestView {
    return {
      items: digest.items,
      enabled,
      last_sent_at: isoOrNull(digest.last_sent_at),
      last_generated_at: isoOrNull(digest.last_generated_at),
      last_receipt: digest.last_receipt,
      last_error: digest.last_error,
      next_due_at: digest.last_sent_at === null ? null : iso(digest.last_sent_at + DIGEST_REFRESH_MS),
    };
  }

  // ---- storage ----------------------------------------------------------------------------------

  /** Runs `fn` after every earlier serialized call (service calls await, so input gates alone would interleave). */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // The caller names the stored document's type (every key has one writer in this class).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  private doc<T>(key: string): T | null {
    const row = this.ctx.storage.sql.exec<{ doc: string }>('SELECT doc FROM state WHERE key = ?', key).toArray()[0];
    return row === undefined ? null : (JSON.parse(row.doc) as T);
  }

  private putDoc(key: string, value: unknown, now: number): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO state (key, doc, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at',
      key,
      JSON.stringify(value),
      now,
    );
  }

  private deleteDoc(key: string): void {
    this.ctx.storage.sql.exec('DELETE FROM state WHERE key = ?', key);
  }

  private statusDoc(app: OpsApp): StatusDoc {
    return this.doc<StatusDoc>(`status:${app}`) ?? NO_STATUS;
  }

  private applied(app: OpsApp): AppliedGuard {
    const row = this.ctx.storage.sql.exec<AppliedRow>('SELECT * FROM guard_applied WHERE app = ?', app).toArray()[0];
    if (row === undefined) return NO_APPLIED;
    return {
      input: row.input === null ? null : (JSON.parse(row.input) as SetGuardInput),
      state: row.state === null ? null : (JSON.parse(row.state) as GuardState),
      last_call_at: row.last_call_at,
      last_error: row.last_error as AppErrorCode | null,
      consecutive_failures: row.consecutive_failures,
    };
  }

  private saveApplied(app: OpsApp, applied: AppliedGuard): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO guard_applied (app, input, state, last_call_at, last_error, consecutive_failures) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app) DO UPDATE SET input = excluded.input, state = excluded.state, last_call_at = excluded.last_call_at,
         last_error = excluded.last_error, consecutive_failures = excluded.consecutive_failures`,
      app,
      applied.input === null ? null : JSON.stringify(applied.input),
      applied.state === null ? null : JSON.stringify(applied.state),
      applied.last_call_at,
      applied.last_error,
      applied.consecutive_failures,
    );
  }

  private activeRun(): CanaryRecord | null {
    const row = this.ctx.storage.sql
      .exec<CanaryRow>("SELECT * FROM canary_runs WHERE phase != 'done' ORDER BY created_at DESC LIMIT 1")
      .toArray()[0];
    return row === undefined ? null : fromRow(row);
  }

  private latestFinished(): CanaryRecord | null {
    const row = this.ctx.storage.sql
      .exec<CanaryRow>('SELECT * FROM canary_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1')
      .toArray()[0];
    return row === undefined ? null : fromRow(row);
  }

  private manualCount(day: string): number {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM canary_runs WHERE day = ? AND kind = 'manual'", day)
      .toArray()[0];
    return row?.n ?? 0;
  }

  private scheduledExists(day: string): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM canary_runs WHERE day = ? AND kind = 'scheduled' LIMIT 1", day).toArray().length > 0
    );
  }

  private runExists(runId: string): boolean {
    return this.ctx.storage.sql.exec('SELECT 1 FROM canary_runs WHERE run_id = ?', runId).toArray().length > 0;
  }

  private saveRun(run: CanaryRecord): void {
    const doc = {
      delivery: run.delivery,
      consumer: run.consumer,
      polls: run.polls,
      start_wait: run.start_wait,
      start_code: run.start_code,
      last_call_error: run.last_call_error,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO canary_runs (run_id, kind, day, phase, outcome, stage, code, event_id, created_at, queued_at,
         delivered_at, completed_at, finished_at, deadline_at, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET phase = excluded.phase, outcome = excluded.outcome, stage = excluded.stage,
         code = excluded.code, event_id = excluded.event_id, queued_at = excluded.queued_at,
         delivered_at = excluded.delivered_at, completed_at = excluded.completed_at, finished_at = excluded.finished_at,
         deadline_at = excluded.deadline_at, doc = excluded.doc`,
      run.run_id,
      run.kind,
      run.day,
      run.phase,
      run.outcome,
      run.stage,
      run.code,
      run.event_id,
      run.created_at,
      run.queued_at,
      run.delivered_at,
      run.completed_at,
      run.finished_at,
      run.deadline_at,
      JSON.stringify(doc),
    );
  }

  /** Keeps item_since to the active keys: new keys start now, inactive ones are forgotten. */
  private syncSince(keys: readonly string[], now: number): Map<string, number> {
    const active = new Set(keys);
    const stored = this.ctx.storage.sql.exec<{ key: string; since: number }>('SELECT key, since FROM item_since').toArray();
    const map = new Map<string, number>();
    for (const row of stored) {
      if (active.has(row.key)) map.set(row.key, row.since);
      else this.ctx.storage.sql.exec('DELETE FROM item_since WHERE key = ?', row.key);
    }
    for (const key of active) {
      if (map.has(key)) continue;
      this.ctx.storage.sql.exec('INSERT INTO item_since (key, since) VALUES (?, ?)', key, now);
      map.set(key, now);
    }
    return map;
  }
}

function fromRow(row: CanaryRow): CanaryRecord {
  const doc = JSON.parse(row.doc) as Pick<CanaryRecord, 'delivery' | 'consumer' | 'polls' | 'start_wait' | 'start_code' | 'last_call_error'>;
  return {
    run_id: row.run_id,
    kind: row.kind as CanaryRecord['kind'],
    day: row.day,
    phase: row.phase as CanaryRecord['phase'],
    outcome: row.outcome as CanaryRecord['outcome'],
    stage: row.stage as CanaryRecord['stage'],
    code: row.code,
    event_id: row.event_id,
    created_at: row.created_at,
    queued_at: row.queued_at,
    delivered_at: row.delivered_at,
    completed_at: row.completed_at,
    finished_at: row.finished_at,
    deadline_at: row.deadline_at,
    ...doc,
  };
}
