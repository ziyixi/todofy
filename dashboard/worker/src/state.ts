/**
 * HomeState: the one SQLite-backed Durable Object ("home-v1") that does all real work
 * (docs/design.md §3–§5, docs/design-v2.md §4–§6): status polling, the public_http probes, the GraphQL usage
 * query and Worker discovery, guard, canary, digest, and the v2 views assembled from its tables. The
 * fetch and scheduled handlers only call these RPC methods.
 *
 * Bounds: every tick makes at most outboundPerTick() = 30 outbound calls (7 status, 3 probes, 1 GraphQL,
 * ≤ 4 setGuard, ≤ 2 canary calls, ≤ 1 reportOps, ≤ DRIFT_CALLS_PER_TICK = 12 read-only drift calls) and
 * writes a few dozen rows; a v2 view reads at most VIEW_ROWS_READ[view] rows (api-types.ts; tested in
 * workerd).
 */
import { DurableObject } from 'cloudflare:workers';
import type { GuardLevel, GuardState, OpsReportItem, OpsStatus, SetGuardInput } from '@ziyixi/proto/ops/v1/ops_wire';
import { OPS_LIMITS } from '../../../contracts/ops-v1/ops-v1.ts';
import { CANARY_MANUAL_PER_DAY, GUARD_CLEAR_PERCENT, GUARD_SHED_PERCENT, REFRESH_MIN_INTERVAL_SECONDS, type AppErrorCode, type CanaryRun, type OpsApp, type CanaryState, type Digest, type GuardAppView, type GuardView, type Usage } from './api-types.ts';
import { CLOUDFLARE_REFRESH_MIN_SECONDS, PROBE_MIN_INTERVAL_SECONDS, VIEW_BODY_BUDGET, type ShellFields, type ViewId } from './api-types.ts';
import { CANARY_RECENT_RUNS } from './idl.ts';
import {
  CANARY_RETENTION_MS,
  applyDeadline,
  applyDelivery,
  applyResult,
  applyStart,
  finish,
  holdWhenDisabled,
  manualRunId,
  newRun,
  nextScheduledAt,
  runView,
  scheduledRunId,
  startPrecondition,
  waitForStatus,
  type CanaryRecord,
} from './canary.ts';
import { analyticsConfigured, buildSha, canaryEnabled, canaryHour, dashboardUrl } from './config.ts';
import { buildReport, candidates, digestKey, finalizeItems, itemKey, shouldSend, DIGEST_REFRESH_MS, type Candidate } from './digest.ts';
import { NO_DIGEST, NO_META, NO_STATUS, NO_USAGE, type DigestDoc, type MetaDoc, type ProbeDoc, type StatusDoc, type UsageDoc } from './docs.ts';
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
  settled,
  usageFresh,
  type AppliedGuard,
  type AutoGuard,
  type DesiredGuard,
  type GuardOverrideDoc,
} from './guard.ts';
import { mergeScripts, workerRows, withLiveInventory, type CfScriptsDoc } from './discovery.ts';
import {
  NO_DRIFT,
  advanceRun,
  attemptsExhausted,
  completedDoc,
  driftPlan,
  driftView,
  failedDoc,
  newDriftRun,
  runComplete,
  runTooLarge,
  totalFindings,
  type DriftDoc,
  type DriftRunDoc,
} from './drift.ts';
import { attentionView, freshStatus, targetOf, type EvalInput } from './evaluate.ts';
import { ATTENTION_ROW_LIMIT, ATTENTION_SCHEMA, AttentionState, type AttentionCondition } from './attention-state.ts';
import type { Attention, AttentionItem, Badges } from './api-types.ts';
import { OPS_APPS, opsCanaryDelivery, opsCanaryResult, opsReportOps, opsSetGuard, opsStartCanary, opsStatus } from './ops-client.ts';
import { callWebsiteRequest, unconfirmedWebsiteRequest } from './website-sync.ts';
import type { WebsiteSyncRequestResult } from './api-types.ts';
import { nextProbeDoc, probeDue, probeUrl, type ProbeTarget } from './probe.ts';
import { REGISTRY } from './registry.ts';
import { HOUR_MS, MINUTE_MS, iso, isoOrNull, utcDay, utcMonthStart } from './time.ts';
import { fetchUsage, type UsageErrorCode } from './usage.ts';
import type { ViewBody } from './view-body.ts';
import { cloudflareResponse, flowsResponse, homeResponse, opsResponse, serializeView, shell } from './views.ts';

/** Name of the single object instance. */
export const HOME_OBJECT = 'home-v1';

/** One value per ops-v1 app (OPS_APPS), so a new app cannot be forgotten in a literal. */
export function perApp<T>(value: (app: OpsApp) => T): Record<OpsApp, T> {
  return Object.fromEntries(OPS_APPS.map((app) => [app, value(app)])) as Record<OpsApp, T>;
}

/** guard_applied's CHECK: exactly the ops-v1 apps this dashboard calls (OPS_APPS). */
const GUARD_APPS_CHECK = `CHECK (app IN (${OPS_APPS.map((app) => `'${app}'`).join(', ')}))`;

/**
 * guard_applied's CHECK lists the apps; SQLite cannot alter a CHECK, so a store created before an app joined ops-v1
 * (Lab on 2026-09-30, the watch app on 2026-10-01) is rebuilt once, rows kept: new table, copy, drop, rename, in one
 * transaction.
 */
export function migrateGuardApplied(storage: DurableObjectStorage): void {
  const sql = storage.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'guard_applied'").toArray()[0]?.sql ?? '';
  if (sql === '' || sql.includes(GUARD_APPS_CHECK)) return;
  storage.transactionSync(() => {
    storage.sql.exec(
      `CREATE TABLE guard_applied_v2 (
        app TEXT PRIMARY KEY ${GUARD_APPS_CHECK},
        input TEXT,
        state TEXT,
        last_call_at INTEGER,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      )`,
    );
    storage.sql.exec(
      'INSERT INTO guard_applied_v2 (app, input, state, last_call_at, last_error, consecutive_failures) SELECT app, input, state, last_call_at, last_error, consecutive_failures FROM guard_applied',
    );
    storage.sql.exec('DROP TABLE guard_applied');
    storage.sql.exec('ALTER TABLE guard_applied_v2 RENAME TO guard_applied');
  });
}

/** A cron event within this of the last completed tick is a retry and is skipped. */
export const TICK_DEDUP_MS = 10 * MINUTE_MS;
/** Ticks, owner refreshes and manual starts poll an app's status() only when its last attempt is at least this old. */
export const STATUS_REFRESH_MS = OPS_LIMITS.statusMinIntervalSeconds * 1000;
const REFRESH_MIN_MS = REFRESH_MIN_INTERVAL_SECONDS * 1000;
const PROBE_MIN_MS = PROBE_MIN_INTERVAL_SECONDS * 1000;
const CLOUDFLARE_REFRESH_MIN_MS = CLOUDFLARE_REFRESH_MIN_SECONDS * 1000;

/** The public_http entries the tick probes (at most one GET each per tick). */
const PROBED: readonly (ProbeTarget & { readonly id: string })[] = REGISTRY.entries.flatMap((entry) => {
  const status = entry.status;
  if (status.type !== 'public_http' || !status.enabled) return [];
  const { url, expect, content_type } = status;
  return [content_type === undefined ? { id: entry.id, url, expect } : { id: entry.id, url, expect, content_type }];
});

/** Whether an app's status() may be polled at `now`: never polled, or the last attempt is at least 10 minutes old (or from a later clock). */
function statusDue(doc: { readonly checked_at: number | null }, now: number): boolean {
  return doc.checked_at === null || now - doc.checked_at >= STATUS_REFRESH_MS || now < doc.checked_at;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    doc TEXT NOT NULL CHECK (length(doc) <= 65536),
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS guard_applied (
    app TEXT PRIMARY KEY ${GUARD_APPS_CHECK},
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
  // The run in progress (at most one) without scanning the 60-day history (rows read by every tick and view).
  "CREATE INDEX IF NOT EXISTS canary_runs_active ON canary_runs (created_at) WHERE phase != 'done'",
  `CREATE TABLE IF NOT EXISTS website_sync_requests (
    request_id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    answer TEXT NOT NULL CHECK (length(answer) <= 4096)
  )`,
  'CREATE TABLE IF NOT EXISTS item_since (key TEXT PRIMARY KEY, since INTEGER NOT NULL)',
  ATTENTION_SCHEMA,
];

/**
 * A failure of the call itself (the Durable Object) is an exception, which the Worker maps to 503 UNAVAILABLE.
 * `request_id_reused`: the request's AIP-155 request_id answered another method (BAD_REQUEST).
 */
export type StartCanaryOutcome =
  | { readonly ok: true; readonly run: CanaryRun }
  | { readonly ok: false; readonly code: 'canary_disabled' | 'canary_active' | 'canary_limit' | 'request_id_reused' };
export type GuardOverrideOutcome = { readonly ok: true; readonly guard: GuardView } | { readonly ok: false; readonly code: 'request_id_reused' | 'guard_unavailable' };
export type WebsiteSyncOutcome = { readonly ok: true; readonly request: WebsiteSyncRequestResult } | { readonly ok: false; readonly code: 'request_id_reused' };
export type AttentionMutationOutcome = { readonly ok: true; readonly item: AttentionItem }
  | { readonly ok: false; readonly code: 'request_id_reused' | 'attention_changed' };

/**
 * AIP-155: the answers of the owner's mutations by request_id (RunCanary, OverrideGuard), so a repeated request
 * (the UI retries a lost response with the same ID) answers the first response and changes nothing. Kept 24 hours,
 * at most REQUEST_LOG_MAX entries (a few hundred bytes each), in one `state` document. Only a success is kept: a
 * refused request changed nothing, so its repeat is decided again. Website dispatch receipts use a separate
 * permanent SQLite row, including uncertain answers, because an expired receipt must never re-dispatch.
 */
export const REQUEST_LOG_KEY = 'request_log';
export const REQUEST_LOG_MAX = 16;
export const REQUEST_LOG_TTL_MS = 24 * 60 * MINUTE_MS;
type RequestMethod = 'run_canary' | 'override_guard' | 'dismiss_attention' | 'restore_attention' | 'website_sync';
interface RequestLogEntry {
  readonly id: string;
  readonly method: RequestMethod;
  readonly at: number;
  readonly answer: unknown;
  readonly input_key?: string;
}

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
  /** Rows read by the current v2 view build (SqlStorageCursor.rowsRead). */
  private rowsRead = 0;
  /** While a view is built: documents already read (each key once per build). */
  private readCache: Map<string, unknown> | null = null;
  private readonly attentionState: AttentionState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.attentionState = new AttentionState(ctx.storage, <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) => this.rows<T>(query, ...bindings));
    void ctx.blockConcurrencyWhile(() => {
      for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
      // v2 (design-v2.md §6): runs belong to a canary of the registry; existing rows are mail-todofy.
      const columns = ctx.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('canary_runs')").toArray();
      if (!columns.some((column) => column.name === 'canary_id')) {
        ctx.storage.sql.exec("ALTER TABLE canary_runs ADD COLUMN canary_id TEXT NOT NULL DEFAULT 'mail-todofy'");
      }
      migrateGuardApplied(ctx.storage);
      const scripts = this.doc<CfScriptsDoc>('cf_scripts');
      const drift = this.doc<DriftDoc>('drift');
      if (scripts && scripts.live === undefined && drift?.last_run_day) this.putDoc('drift', { ...drift, last_run_day: null }, Date.now());
      const legacy = this.doc<GuardOverrideDoc>('guard_override');
      if (legacy !== null) {
        for (const app of OPS_APPS) {
          const entry = REGISTRY.entries.find((item) => item.id === app);
          if (entry?.status.type === 'ops_v1' && entry.status.guard) this.putDoc(`guard_override:${app}`, legacy, Date.now());
        }
        this.deleteDoc('guard_override');
      }
      return Promise.resolve();
    });
  }

  // ---- RPC ----------------------------------------------------------------------------------------

  /** One cron tick at `scheduledTime` (§5): status and probes, usage, guard, canary, digest, cleanup. */
  tick(scheduledTime: number): Promise<{ ran: boolean }> {
    return this.serialize(async () => {
      const now = scheduledTime;
      const meta = this.doc<MetaDoc>('meta') ?? NO_META;
      if (meta.last_tick_scheduled !== null && Math.abs(now - meta.last_tick_scheduled) < TICK_DEDUP_MS) {
        console.log(JSON.stringify({ event: 'tick', ran: false }));
        return { ran: false };
      }
      const started = Date.now();
      // status() at most every 10 minutes per app (OPS_LIMITS.statusMinIntervalSeconds), counting the
      // polls of owner refreshes and manual canary starts: a recent answer stands in for this tick's.
      const due = OPS_APPS.filter((app) => statusDue(this.statusDoc(app), now));
      const [polled, probes] = await Promise.all([this.pollStatuses(now, due), this.pollProbes(now)]);
      const observed = perApp<OpsStatus | null>(() => null);
      for (const app of OPS_APPS) {
        const doc = this.statusDoc(app);
        observed[app] = due.includes(app) ? polled[app] : doc.ok === true ? doc.status : null;
      }
      const usage = await this.pollUsage(now);
      const drift = await this.runDrift(now).catch(() => {
        // Never expected (every remote failure is a code); the rest of the tick must still run.
        console.log(JSON.stringify({ event: 'drift', outcome: 'exception' }));
        return { outcome: 'exception', calls: 0 };
      });
      const guard = await this.runGuard(now, observed);
      const canary = await this.runCanary(now, true);
      const digest = await this.runDigest(now, true, now);
      this.ctx.storage.sql.exec('DELETE FROM canary_runs WHERE created_at < ?', now - CANARY_RETENTION_MS);
      this.dropOrphanProbes();
      this.putDoc('meta', { ...meta, last_tick_at: now, last_tick_scheduled: now, rev: (meta.rev ?? 0) + 1 }, now);
      console.log(
        JSON.stringify({
          event: 'tick',
          ran: true,
          duration_ms: Date.now() - started,
          status: Object.fromEntries(OPS_APPS.map((app) => [app, !due.includes(app) ? 'recent' : observed[app] === null ? 'failed' : 'ok'])),
          probes,
          usage: usage ?? 'ok',
          drift: drift.outcome,
          drift_calls: drift.calls,
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

  /**
   * A view of the owner API (GetHomeView, ...; docs/design-v2.md §5): built from the tables and serialized here, with
   * ETag `"<rev>-<hash>"` (views.ts); `body: null` when `ifNoneMatch` names it (the Worker answers
   * 304). `refresh` only for home (due statuses and probes) and cloudflare (GraphQL), each scope at most
   * once per minute; statuses keep their 10 minutes, probes PROBE_MIN_INTERVAL_SECONDS.
   *
   * `at`, here and on the other API methods: the request's instant when the Worker pins one (DEV_NOW
   * under the loopback dev bypass, http.ts authenticate); null, always in production, reads Date.now().
   */
  async view(view: ViewId, refresh: boolean, ifNoneMatch: string | null, at: number | null = null): Promise<ViewBody> {
    const refreshed = refresh && (view === 'home' || view === 'cloudflare') ? await this.serialize(() => this.refreshScope(view, at ?? Date.now())) : false;
    const now = at ?? Date.now();
    this.rowsRead = 0;
    const result = serializeView(this.buildView(view, now, refreshed), ifNoneMatch);
    console.log(
      JSON.stringify({
        event: 'v2_view',
        view,
        refreshed,
        status: result.body === null ? 304 : 200,
        bytes: result.bytes,
        over_budget: result.bytes > VIEW_BODY_BUDGET[view],
        rows_read: this.rowsRead,
      }),
    );
    return { etag: result.etag, body: result.body };
  }

  /**
   * Rows the last v2 view build read (workerd tests: stays within VIEW_ROWS_READ). Diagnostic only; the
   * Worker never calls it.
   */
  lastRowsRead(): number {
    return this.rowsRead;
  }

  /**
   * RunCanary: a manual run with its first start attempt; later steps happen on ticks. With a `requestId` already
   * answered (AIP-155), the first answer again.
   */
  startCanary(at: number | null = null, requestId: string | null = null): Promise<StartCanaryOutcome> {
    return this.serialize(async (): Promise<StartCanaryOutcome> => {
      const now = at ?? Date.now();
      const replay = this.replay(requestId, 'run_canary', now);
      if (replay === 'reused') return { ok: false, code: 'request_id_reused' };
      if (replay !== null) return { ok: true, run: replay as CanaryRun };
      // Switched off: refused before anything is read or called.
      if (!canaryEnabled(this.env)) return { ok: false, code: 'canary_disabled' };
      if (this.activeRun() !== null) return { ok: false, code: 'canary_active' };
      if (this.manualCount(utcDay(now)) >= CANARY_MANUAL_PER_DAY) return { ok: false, code: 'canary_limit' };
      const stale = OPS_APPS.filter((app) => statusDue(this.statusDoc(app), now));
      if (stale.length > 0) await this.pollStatuses(now, stale);
      // Run IDs have one-second resolution and Mail Hero is idempotent per run_id: never reuse one.
      let runId = manualRunId(now);
      for (let k = 1; this.runExists(runId); k++) runId = manualRunId(now + k * 1000);
      const run = await this.advance(newRun(runId, 'manual', now), now);
      this.saveRun(run);
      this.bumpRev(now);
      console.log(JSON.stringify({ event: 'canary_manual', phase: run.phase, outcome: run.outcome, code: run.code }));
      const view = runView(run);
      this.remember(requestId, 'run_canary', view, now);
      return { ok: true, run: view };
    });
  }

  /**
   * OverrideGuard: force shed for 24 h, or clear and suppress the automatic shed until 00:00 UTC. With a `requestId`
   * already answered (AIP-155), the first answer again.
   */
  setGuardOverride(level: GuardLevel, at: number | null = null, requestId: string | null = null, app: OpsApp | null = null): Promise<GuardOverrideOutcome> {
    return this.serialize(async (): Promise<GuardOverrideOutcome> => {
      const now = at ?? Date.now();
      const inputKey = JSON.stringify([app, level]);
      const replay = this.replay(requestId, 'override_guard', now, inputKey);
      if (replay === 'reused') return { ok: false, code: 'request_id_reused' };
      if (replay !== null) return { ok: true, guard: replay as GuardView };
      if (app !== null && this.statusDoc(app).status?.capabilities.includes('guard') !== true) return { ok: false, code: 'guard_unavailable' };
      this.putDoc(app === null ? 'guard_override' : `guard_override:${app}`, ownerOverride(level, now), now);
      // A cleared episode must not come back when the override ends (the auto shed's own until).
      if (level === 'normal' && app === null) this.putDoc('guard', AUTO_NORMAL, now);
      const desired = this.currentDesired(now);
      const calls = await this.applyGuard(now, desired, perApp((id) => this.statusDoc(id).status?.guard ?? null), app);
      await this.runDigest(now, false, (this.doc<MetaDoc>('meta') ?? NO_META).last_tick_at);
      this.bumpRev(now);
      console.log(JSON.stringify({ event: 'guard_override', level, guard_calls: calls }));
      const guard = this.guardView(now);
      this.remember(requestId, 'override_guard', guard, now, inputKey);
      return { ok: true, guard };
    });
  }

  /** Website receipts persist across all retries; other mutation answers expire after 24 h. */
  private replay(requestId: string | null, method: RequestMethod, now: number, inputKey?: string): unknown {
    if (requestId === null) return null;
    const website = this.ctx.storage.sql.exec<{ answer: string }>('SELECT answer FROM website_sync_requests WHERE request_id = ?', requestId).toArray()[0];
    if (website !== undefined) return method === 'website_sync' ? JSON.parse(website.answer) as WebsiteSyncRequestResult : 'reused';
    const entry = (this.doc<{ entries: RequestLogEntry[] }>(REQUEST_LOG_KEY)?.entries ?? []).find((e) => e.id === requestId && now - e.at < REQUEST_LOG_TTL_MS);
    if (entry === undefined) return null;
    return entry.method === method && (inputKey === undefined || entry.input_key === inputKey) ? entry.answer : 'reused';
  }

  /** Keeps a success's answer under its request_id: the newest REQUEST_LOG_MAX of the last 24 hours. */
  private remember(requestId: string | null, method: RequestMethod, answer: unknown, now: number, inputKey?: string): void {
    if (requestId === null) return;
    if (method === 'website_sync') {
      // Website receipts cannot be evicted by the ordinary mutation log's sixteen-entry bound.
      this.ctx.storage.sql.exec('INSERT INTO website_sync_requests (request_id, at, answer) VALUES (?, ?, ?) ON CONFLICT (request_id) DO UPDATE SET answer = excluded.answer', requestId, now, JSON.stringify(answer));
      return;
    }
    const kept = (this.doc<{ entries: RequestLogEntry[] }>(REQUEST_LOG_KEY)?.entries ?? []).filter((e) => e.id !== requestId && now - e.at < REQUEST_LOG_TTL_MS);
    this.putDoc(REQUEST_LOG_KEY, { entries: [{ id: requestId, method, at: now, answer, ...(inputKey === undefined ? {} : { input_key: inputKey }) }, ...kept].slice(0, REQUEST_LOG_MAX) }, now);
  }

  /** Persist uncertainty before dispatch: loss of the external response can never cause a second POST. */
  requestWebsiteSync(requestId: string, at: number | null = null): Promise<WebsiteSyncOutcome> {
    return this.serialize(async () => {
      const now = at ?? Date.now();
      const replay = this.replay(requestId, 'website_sync', now);
      if (replay === 'reused') return { ok: false, code: 'request_id_reused' };
      if (replay !== null && (replay as WebsiteSyncRequestResult).state !== 'unconfirmed') {
        return { ok: true, request: replay as WebsiteSyncRequestResult };
      }
      if (replay === null) this.remember(requestId, 'website_sync', unconfirmedWebsiteRequest(requestId), now);
      const result = await callWebsiteRequest(this.env, requestId, replay !== null);
      const request = result.ok ? result.value : (replay as WebsiteSyncRequestResult | null) ?? unconfirmedWebsiteRequest(requestId, result.code);
      this.remember(requestId, 'website_sync', request, now);
      this.bumpRev(now);
      return { ok: true, request };
    });
  }

  dismissAttention(name: string, etag: string, requestId: string, at: number | null = null): Promise<AttentionMutationOutcome> {
    return this.changeAttention(name, etag, requestId, true, at);
  }
  restoreAttention(name: string, etag: string, requestId: string, at: number | null = null): Promise<AttentionMutationOutcome> {
    return this.changeAttention(name, etag, requestId, false, at);
  }
  private changeAttention(name: string, etag: string, requestId: string, dismiss: boolean, at: number | null): Promise<AttentionMutationOutcome> {
    return this.serialize((): Promise<AttentionMutationOutcome> => {
      const now = at ?? Date.now(), method = dismiss ? 'dismiss_attention' : 'restore_attention';
      const inputKey = JSON.stringify([name, etag]);
      const replay = this.replay(requestId, method, now, inputKey);
      if (replay === 'reused') return Promise.resolve({ ok: false, code: 'request_id_reused' });
      if (replay !== null) return Promise.resolve({ ok: true, item: replay as AttentionItem });
      this.projectAttention(now);
      const item = this.attentionState.change(name, etag, dismiss, now);
      if (item === null) return Promise.resolve({ ok: false, code: 'attention_changed' });
      // Publish only from the next normal scheduled digest, never from an owner action.
      this.putDoc('attention_report_pending', { at: now }, now);
      this.bumpRev(now);
      this.remember(requestId, method, item, now, inputKey);
      return Promise.resolve({ ok: true, item });
    });
  }

  // ---- the tick's steps -------------------------------------------------------------------------

  /** status() of the given apps in parallel; returns the statuses this call obtained (null on failure). */
  private async pollStatuses(now: number, apps: readonly OpsApp[]): Promise<Record<OpsApp, OpsStatus | null>> {
    const observed = perApp<OpsStatus | null>(() => null);
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
        resources: result.data.resources,
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
    if (result.ok) {
      // Worker discovery (design-v2.md §4): one document, rewritten with each successful answer.
      const scripts = mergeScripts(this.doc<CfScriptsDoc>('cf_scripts'), result.data.scripts, result.data.workers_truncated, now);
      this.putDoc('cf_scripts', scripts, now);
    }
    return result.ok ? null : result.code;
  }

  /**
   * The day's drift check (drift.ts, design-v2.md §10): started by the first tick at or after
   * DRIFT_UTC_HOUR, advanced by each tick (≤ DRIFT_CALLS_PER_TICK read-only GETs) until complete or
   * DRIFT_MAX_ATTEMPTS attempts failed. Logs carry the outcome code and counts only.
   */
  private async runDrift(now: number): Promise<{ outcome: string; calls: number }> {
    const configured = analyticsConfigured(this.env);
    let doc = this.doc<DriftDoc>('drift') ?? NO_DRIFT;
    let plan = driftPlan(now, this.doc<DriftRunDoc>('drift_run'), doc, configured);
    if (plan.kind === 'abandon') {
      // A run of an earlier day did not finish: that day failed.
      doc = failedDoc(doc, plan.run, { code: 'incomplete', step: plan.run.account === null ? 'account' : 'script' }, now, true);
      this.putDoc('drift', doc, now);
      this.deleteDoc('drift_run');
      plan = driftPlan(now, null, doc, configured);
    }
    if (plan.kind !== 'start' && plan.kind !== 'continue') return { outcome: 'idle', calls: 0 };
    const run = plan.kind === 'start' ? newDriftRun(now) : plan.run;
    const result = await advanceRun(run, (this.env.CF_ANALYTICS_TOKEN ?? '').trim(), this.env.ACCOUNT_ID, (url, init) => globalThis.fetch(url, init));
    if (result.run.account !== null && (run.account === null || runComplete(result.run))) {
      this.putDoc('cf_scripts', withLiveInventory(this.doc<CfScriptsDoc>('cf_scripts'), result.run.account.scripts, now), now);
    }
    let outcome: string;
    if (runComplete(result.run)) {
      doc = completedDoc(doc, result.run, now);
      this.deleteDoc('drift_run');
      outcome = totalFindings(doc.counts) === 0 ? 'ok' : 'drift';
    } else if (result.error !== null && attemptsExhausted(result.run)) {
      doc = failedDoc(doc, result.run, result.error, now, true);
      this.deleteDoc('drift_run');
      outcome = result.error.code;
    } else if (runTooLarge(result.run)) {
      // More live names than one state row holds (far beyond this account): give the day up.
      doc = failedDoc(doc, result.run, { code: 'too_large', step: 'script' }, now, true);
      this.deleteDoc('drift_run');
      outcome = 'too_large';
    } else {
      doc = result.error === null ? { ...doc, running_day: result.run.day } : failedDoc(doc, result.run, result.error, now, false);
      this.putDoc('drift_run', result.run, now);
      outcome = result.error === null ? 'running' : `retry:${result.error.code}`;
    }
    this.putDoc('drift', doc, now);
    console.log(JSON.stringify({ event: 'drift', outcome, calls: result.calls, findings: totalFindings(doc.counts), failed_days: doc.consecutive_failed_days }));
    return { outcome, calls: result.calls };
  }

  /** Aggregate only the actual per-service targets; normal owner overrides can suppress every shed. */
  private summaryDesired(now: number): DesiredGuard {
    const targets = OPS_APPS.filter((app) => {
      const entry = REGISTRY.entries.find(item => item.id === app);
      return entry?.status.type === 'ops_v1' && entry.status.guard
        && this.statusDoc(app).status?.capabilities.includes('guard') !== false;
    }).map(app => this.currentDesired(now, app));
    return targets.find(target => target.level === 'shed' && target.source === 'auto')
      ?? targets.find(target => target.level === 'shed')
      ?? { ...this.currentDesired(now), level: 'normal', until: null };
  }

  private currentDesired(now: number, app: OpsApp | null = null): DesiredGuard {
    const override = activeOverride(this.doc<GuardOverrideDoc>(app === null ? 'guard_override' : `guard_override:${app}`), now)
      ?? activeOverride(this.doc<GuardOverrideDoc>('guard_override'), now);
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
    const calls = await this.applyGuard(
      now,
      desired,
      perApp((app) => observed[app]?.guard ?? null),
    );
    return { desired, calls };
  }

  /** setGuard on each app that supports it and needs it (§5.3 "Applying"), in parallel. */
  private async applyGuard(now: number, desired: DesiredGuard, observed: Record<OpsApp, GuardState | null>, only: OpsApp | null = null): Promise<number> {
    const inputs = perApp((app) => guardInput(this.doc(`guard_override:${app}`) === null ? desired : this.currentDesired(now, app), now));
    const targets = OPS_APPS.filter((app) => {
      const status = this.statusDoc(app).status;
      return (only === null || only === app) && status !== null && status.capabilities.includes('guard') && needsApply(inputs[app], this.applied(app), observed[app]);
    });
    // An app that needs no call has nothing pending: earlier failures (for a level no longer wanted,
    // or already in place) stop counting.
    for (const app of OPS_APPS) {
      if (targets.includes(app) || (only !== null && app !== only)) continue;
      const applied = this.applied(app);
      const next = settled(applied);
      if (next !== applied) this.saveApplied(app, next);
    }
    const results = await Promise.all(targets.map(async (app) => [app, await opsSetGuard(this.env, app, inputs[app])] as const));
    for (const [app, result] of results) {
      const previous = this.applied(app);
      this.saveApplied(
        app,
        result.ok
          ? { input: inputs[app], state: result.value, last_call_at: now, last_error: null, consecutive_failures: 0 }
          : { ...previous, last_call_at: now, last_error: result.code, consecutive_failures: previous.consecutive_failures + 1 },
      );
    }
    return targets.length;
  }

  /**
   * Advances the active run, or starts the day's scheduled run when due (§5.4). While the canary is
   * switched off, a queued run is still polled to its verdict (so a Todofy rollback can wait for it),
   * a run not yet queued ends without another start call, and no new run starts.
   */
  private async runCanary(now: number, scheduled: boolean): Promise<string> {
    const found = this.activeRun();
    const active = found !== null && !canaryEnabled(this.env) ? holdWhenDisabled(found, now) : found;
    if (active !== null) {
      const run = await this.advance(active, now);
      this.saveRun(run);
      return run.phase === 'done' ? `${run.outcome ?? 'done'}:${run.code ?? ''}` : run.phase;
    }
    if (!canaryEnabled(this.env)) return 'disabled';
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

  private digestCandidates(now: number, lastTickAt: number | null): Candidate[] {
    const usage = this.doc<UsageDoc>('usage') ?? NO_USAGE;
    return candidates({
      now,
      usage: {
        configured: analyticsConfigured(this.env),
        fresh: usageFresh(usage, now),
        rows: usage.rows,
        fetched_at: usage.fetched_at,
        consecutive_failures: usage.consecutive_failures,
        last_http_status: usage.last_http_status,
      },
      desired: this.summaryDesired(now),
      guardFailures: perApp((app) => this.applied(app).consecutive_failures),
      latestFinished: this.latestFinished(),
      lastTickAt,
      apps: perApp((app) => this.statusDoc(app)),
      drift: { configured: analyticsConfigured(this.env), doc: this.doc<DriftDoc>('drift') ?? NO_DRIFT },
    });
  }
  /** Builds raw facts, then applies Home's reminder disposition before the scheduled report. */
  private async runDigest(now: number, send: boolean, lastTickAt: number | null): Promise<{ sent: string; items: number }> {
    const list = this.digestCandidates(now, lastTickAt);
    const firstSeen = this.syncSince(list.map(itemKey), now);
    const rawItems = finalizeItems(list, firstSeen, now, ATTENTION_ROW_LIMIT);
    const projected = this.projectAttention(now, rawItems, lastTickAt);
    const items = rawItems.filter((item) => !this.attentionState.isDismissed({ ...item, target: targetOf(item.source, item.code) }));
    const previous = this.doc<DigestDoc>('digest') ?? NO_DIGEST;
    let doc: DigestDoc = { ...previous, items: rawItems };
    let sent = 'none';
    const enabled = this.statusDoc('todofy').status?.capabilities.includes('ops_digest') === true;
    const identities = projected.attention.items.filter((item) => item.observed === undefined).map((item) => `${item.name ?? ''}:${item.etag ?? ''}`).sort().join(',');
    const key = `${digestKey(items)}|${identities}`;
    if (send && enabled && shouldSend(key, previous, now)) {
      const report = buildReport(items, now, dashboardUrl(this.env));
      const result = await opsReportOps(this.env, report);
      doc = result.ok
        ? { ...doc, last_key: key, last_sent_at: now, last_generated_at: now, last_receipt: result.value, last_error: null, last_attempt_at: now }
        : { ...doc, last_error: result.code, last_attempt_at: now };
      sent = result.ok ? 'sent' : result.code;
      if (result.ok) this.deleteDoc('attention_report_pending');
    }
    if (send && key === previous.last_key) this.deleteDoc('attention_report_pending');
    this.putDoc('digest', doc, now);
    return { sent, items: items.length };
  }

  /**
   * The public_http probes that are due (design-v2.md §3), in parallel: one GET each at most, never
   * more often than PROBE_MIN_INTERVAL_SECONDS (a refresh's probe stands in for the tick's).
   */
  private async pollProbes(now: number): Promise<Record<string, string>> {
    const due = PROBED.filter((probe) => probeDue(this.doc<ProbeDoc>(`probe:${probe.id}`), now));
    const results = await Promise.all(due.map(async (probe) => [probe, await probeUrl(probe)] as const));
    const summary: Record<string, string> = {};
    for (const [probe, result] of results) {
      this.putDoc(`probe:${probe.id}`, nextProbeDoc(this.doc<ProbeDoc>(`probe:${probe.id}`), result, now), now);
      summary[probe.id] = result.ok ? 'ok' : (result.error ?? 'failed');
    }
    return summary;
  }

  /** Probe documents of entries that are no longer probed (registry change, `enabled: false`). */
  private dropOrphanProbes(): void {
    const keep = new Set(PROBED.map((probe) => `probe:${probe.id}`));
    const keys = this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM state WHERE key >= 'probe:' AND key < 'probe;'").toArray();
    for (const { key } of keys) if (!keep.has(key)) this.deleteDoc(key);
  }

  private bumpRev(now: number): void {
    const meta = this.doc<MetaDoc>('meta') ?? NO_META;
    this.putDoc('meta', { ...meta, rev: (meta.rev ?? 0) + 1 }, now);
  }

  /**
   * A refresh of a scope (RefreshHomeView, RefreshCloudflareView); true when something was fetched. home: due statuses (10 min each) and
   * probes; cloudflare: GraphQL (60 s). Each scope at most once per minute; the digest items are
   * rebuilt from the new data (a report is sent only by a tick).
   */
  private async refreshScope(scope: 'home' | 'cloudflare', now: number): Promise<boolean> {
    const meta = this.doc<MetaDoc>('meta') ?? NO_META;
    const last = scope === 'home' ? meta.last_refresh_home_at : meta.last_refresh_cloudflare_at;
    const min = scope === 'home' ? REFRESH_MIN_MS : CLOUDFLARE_REFRESH_MIN_MS;
    if (last != null && now - last < min && now >= last) return false;
    if (scope === 'home') {
      const statuses = OPS_APPS.filter((app) => statusDue(this.statusDoc(app), now));
      const probes = PROBED.filter((probe) => probeDue(this.doc<ProbeDoc>(`probe:${probe.id}`), now));
      if (statuses.length === 0 && probes.length === 0) return false;
      await Promise.all([statuses.length > 0 ? this.pollStatuses(now, statuses) : Promise.resolve(), probes.length > 0 ? this.pollProbes(now) : Promise.resolve()]);
    } else {
      const usage = this.doc<UsageDoc>('usage') ?? NO_USAGE;
      const due = analyticsConfigured(this.env) && (usage.last_attempt_at === null || now - usage.last_attempt_at >= CLOUDFLARE_REFRESH_MIN_MS || now < usage.last_attempt_at);
      if (!due) return false;
      await this.pollUsage(now);
    }
    await this.runDigest(now, false, meta.last_tick_at);
    const current = this.doc<MetaDoc>('meta') ?? NO_META;
    const stamp = scope === 'home' ? { last_refresh_home_at: now } : { last_refresh_cloudflare_at: now };
    this.putDoc('meta', { ...current, ...stamp, rev: (current.rev ?? 0) + 1 }, now);
    console.log(JSON.stringify({ event: 'v2_refresh', scope }));
    return true;
  }

  // ---- v2 views -----------------------------------------------------------------------------------

  /** Everything the evaluation reads (evaluate.ts), from the tables. */
  private evalInput(now: number): EvalInput {
    const meta = this.doc<MetaDoc>('meta') ?? NO_META;
    return {
      now,
      lastTickAt: meta.last_tick_at,
      analyticsConfigured: analyticsConfigured(this.env),
      statuses: this.statusDocs(),
      probes: Object.fromEntries(PROBED.flatMap((probe) => {
        const doc = this.doc<ProbeDoc>(`probe:${probe.id}`);
        return doc === null ? [] : [[probe.id, doc] as const];
      })),
      scripts: this.doc<CfScriptsDoc>('cf_scripts'),
      digest: this.doc<DigestDoc>('digest') ?? NO_DIGEST,
      canaryRecent: this.recentRuns(),
    };
  }

  private statusDocs(): Record<string, StatusDoc> {
    return Object.fromEntries(OPS_APPS.map((app) => [app, this.statusDoc(app)]));
  }

  /** Full cached conditions before the outbound report's 20-item bound. No provider call. */
  private currentItems(now: number, lastTickAt: number | null): OpsReportItem[] {
    const list = this.digestCandidates(now, lastTickAt);
    const cached = this.readCache?.get('#attention_since') as Map<string, number> | undefined;
    const since = cached ?? new Map(this.rows<{ key: string; since: number }>('SELECT key,since FROM item_since').map((row) => [row.key, row.since]));
    this.readCache?.set('#attention_since', since);
    return finalizeItems(list, since, now, ATTENTION_ROW_LIMIT);
  }

  /** Build all raw explanations first; filtering sooner would recreate a dismissed item as "observed". */
  private projectAttention(now: number, supplied?: readonly OpsReportItem[], lastTickAt?: number | null, neverRan = false): { attention: Attention; badges: Badges } {
    const tickAt = lastTickAt === undefined ? (this.doc<MetaDoc>('meta') ?? NO_META).last_tick_at : lastTickAt;
    const items = neverRan ? [] : supplied ?? this.currentItems(now, tickAt);
    const evaluation = this.evalInput(now);
    const raw = attentionView({ now, neverRan, items, canaryEnabled: canaryEnabled(this.env), desired: this.summaryDesired(now),
      ownerShedApps: OPS_APPS.filter(app => {
        const entry = REGISTRY.entries.find(item => item.id === app);
        const target = this.currentDesired(now, app);
        return entry?.status.type === 'ops_v1' && entry.status.guard
          && this.statusDoc(app).status?.capabilities.includes('guard') !== false
          && target.level === 'shed' && target.source === 'owner';
      }),
      statuses: evaluation.statuses, ...(neverRan ? {} : { evaluation }) });
    const candidatesNow = this.digestCandidates(now, tickAt);
    const active = new Set([...candidatesNow.map(itemKey), ...raw.attention.items.map(itemKey)]);
    const result = this.attentionState.project(raw.attention, now, (condition) => this.attentionResolved(condition, now, tickAt, active, evaluation));
    return result;
  }

  /** A missing/unavailable source is not evidence that its prior business condition recovered. */
  private attentionResolved(condition: AttentionCondition, now: number, tickAt: number | null, active: ReadonlySet<string>, evaluation: EvalInput): boolean {
    const code = condition.code === 'unreachable' ? 'app_unreachable' : condition.code;
    const scriptsFresh = evaluation.scripts !== null && usageFresh({ fetched_at: evaluation.scripts.observed_at, day: evaluation.scripts.day, rows: [] }, now);
    if (condition.target.script !== undefined) {
      return scriptsFresh && workerRows(evaluation.scripts, now).some((row) => row.script === condition.target.script && row.level === 'ok');
    }
    if (active.has(`${condition.source}:${code}`)) return false;
    if (OPS_APPS.includes(condition.source as OpsApp)) {
      const app = condition.source as OpsApp, doc = evaluation.statuses[app], status = freshStatus(doc, now);
      if (doc?.ok !== true || status === null) return false;
      // Stable batches retain their disposition even through a temporary zero count.
      if (condition.code === 'newsletter_unknown') return status.counters.unknown_revision === undefined && status.counters.unknown_count === 0;
      if (condition.code === 'guard_apply_failed') return this.applied(app).last_call_at !== null && this.applied(app).consecutive_failures === 0;
      if (status.health === 'down' || status.signals.some((signal) => signal.code.endsWith('_unavailable') || ['host_never_seen', 'host_stale', 'host_missing'].includes(signal.code))) return false;
      return true;
    }
    if (condition.code === 'error_rate') return scriptsFresh;
    if (condition.code.startsWith('drift_') || condition.code === 'config_drift') {
      const drift = this.doc<DriftDoc>('drift') ?? NO_DRIFT;
      const fresh = drift.checked_at !== null && now - drift.checked_at <= 48 * HOUR_MS && drift.last_error === null;
      return fresh && (condition.code === 'config_drift' ? totalFindings(drift.counts) === 0 : drift.consecutive_failed_days === 0);
    }
    if (condition.source === 'cloudflare' || condition.code.startsWith('usage_')) {
      const usage = this.doc<UsageDoc>('usage') ?? NO_USAGE;
      return usage.consecutive_failures === 0 && usageFresh(usage, now);
    }
    if (condition.source === 'dashboard') return tickAt !== null && now - tickAt <= 75 * MINUTE_MS;
    const probe = evaluation.probes[condition.source];
    return probe?.ok === true && now - probe.checked_at <= 60 * MINUTE_MS;
  }

  /** The shared part of every view: attention strip, badges, freshness and this scope's refresh times. */
  private shellFor(view: ViewId, now: number, refreshed: boolean): ShellFields {
    const meta = this.doc<MetaDoc>('meta') ?? NO_META;
    const digest = this.doc<DigestDoc>('digest') ?? NO_DIGEST;
    const homeAt = meta.last_refresh_home_at ?? null;
    const cloudflareAt = meta.last_refresh_cloudflare_at ?? null;
    const neverRan = meta.last_tick_at === null && digest.last_attempt_at === null && meta.last_refresh_at === null && homeAt === null && cloudflareAt === null;
    const { attention, badges } = this.projectAttention(now, neverRan ? [] : undefined, meta.last_tick_at, neverRan);
    let lastRefreshAt: number | null;
    let nextRefreshAt: number;
    if (view === 'home') {
      lastRefreshAt = homeAt;
      const dues = [
        ...OPS_APPS.map((app) => {
          const checked = this.statusDoc(app).checked_at;
          return checked === null ? now : checked + STATUS_REFRESH_MS;
        }),
        ...PROBED.map((probe) => {
          const checked = this.doc<ProbeDoc>(`probe:${probe.id}`)?.checked_at;
          return checked === undefined ? now : checked + PROBE_MIN_MS;
        }),
      ];
      nextRefreshAt = Math.max(Math.min(...dues), homeAt === null ? now : homeAt + REFRESH_MIN_MS);
    } else if (view === 'cloudflare') {
      lastRefreshAt = cloudflareAt;
      const attempt = (this.doc<UsageDoc>('usage') ?? NO_USAGE).last_attempt_at;
      nextRefreshAt = Math.max(attempt === null ? now : attempt + CLOUDFLARE_REFRESH_MIN_MS, cloudflareAt === null ? now : cloudflareAt + CLOUDFLARE_REFRESH_MIN_MS);
    } else {
      lastRefreshAt = homeAt === null ? cloudflareAt : cloudflareAt === null ? homeAt : Math.max(homeAt, cloudflareAt);
      nextRefreshAt = now;
    }
    return shell({
      now,
      rev: meta.rev ?? 0,
      build: buildSha(this.env),
      attention,
      badges,
      lastTickAt: meta.last_tick_at,
      lastRefreshAt,
      nextRefreshAt,
      refreshed,
    });
  }

  /** One v2 view from the tables (synchronous: no call interleaves while it reads). */
  private buildView(view: ViewId, now: number, refreshed: boolean): ShellFields {
    this.readCache = new Map();
    try {
      const base = this.shellFor(view, now, refreshed);
      switch (view) {
        case 'home':
          return homeResponse(base, this.evalInput(now), this.usageView(now), this.summaryDesired(now));
        case 'flows':
          return flowsResponse(base, this.evalInput(now), this.canaryView(now));
        case 'cloudflare':
          return cloudflareResponse(
            base,
            now,
            this.usageView(now),
            this.doc<UsageDoc>('usage') ?? NO_USAGE,
            this.doc<CfScriptsDoc>('cf_scripts'),
            this.guardView(now),
            driftView(this.doc<DriftDoc>('drift') ?? NO_DRIFT, analyticsConfigured(this.env), now),
          );
        case 'ops': {
          const digest = this.doc<DigestDoc>('digest') ?? NO_DIGEST;
          const todofy = this.statusDoc('todofy');
          return opsResponse(base, this.guardView(now), this.canaryView(now), this.digestView(digest, todofy.status?.capabilities.includes('ops_digest') === true), this.statusDocs());
        }
      }
    } finally {
      this.readCache = null;
    }
  }

  // ---- parts of the v2 views ----------------------------------------------------------------------

  private usageView(now: number): Usage {
    const usage = this.doc<UsageDoc>('usage') ?? NO_USAGE;
    const status: Usage['status'] = !analyticsConfigured(this.env)
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
      const owner = activeOverride(this.doc<GuardOverrideDoc>(`guard_override:${app}`), now);
      const wanted = this.currentDesired(now, app);
      return {
        state: fromStatus ? seen.guard : applied.state,
        last_call_at: isoOrNull(applied.last_call_at),
        last_error: applied.last_error,
        desired: { level: wanted.level, reason: wanted.reason, until: isoOrNull(wanted.until), source: wanted.source },
        ...(owner === null ? {} : { override: { level: owner.level, until: iso(owner.until), set_at: iso(owner.set_at) } }),
      };
    };
    return {
      desired: { level: desired.level, reason: desired.reason, until: isoOrNull(desired.until), source: desired.source },
      override: override === null ? null : { level: override.level, until: iso(override.until), set_at: iso(override.set_at) },
      thresholds: { shed_percent: GUARD_SHED_PERCENT, clear_percent: GUARD_CLEAR_PERCENT },
      apps: Object.fromEntries(OPS_APPS.filter((app) => {
        const entry = REGISTRY.entries.find((item) => item.id === app);
        return entry?.status.type === 'ops_v1' && entry.status.guard
          && this.statusDoc(app).status?.capabilities.includes('guard') !== false;
      }).map((app) => [app, appView(app)])),
    };
  }

  private canaryView(now: number): CanaryState {
    const day = utcDay(now);
    const recent = this.recentRuns();
    const active = this.activeRun();
    const today = recent.find((run) => run.day === day) ?? null;
    const hour = canaryHour(this.env);
    const enabled = canaryEnabled(this.env);
    return {
      enabled,
      hour_utc: hour,
      next_scheduled_at: enabled ? iso(nextScheduledAt(now, hour, this.scheduledExists(day))) : null,
      today: today === null ? null : runView(today),
      active: active === null ? null : runView(active),
      recent: recent.map(runView),
      manual_today: this.manualCount(day),
      manual_limit: CANARY_MANUAL_PER_DAY,
    };
  }

  private digestView(digest: DigestDoc, enabled: boolean): Digest {
    return {
      items: digest.items
        .filter((item) => !this.attentionState.isDismissed({ ...item, target: targetOf(item.source, item.code) })).slice(0, 20),
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
    if (this.readCache?.has(key) === true) return this.readCache.get(key) as T | null;
    const row = this.rows<{ doc: string }>('SELECT doc FROM state WHERE key = ?', key)[0];
    const value = row === undefined ? null : (JSON.parse(row.doc) as T);
    this.readCache?.set(key, value);
    return value;
  }

  /** A query's rows, counted in `rowsRead` (the v2 views' read budget). */
  private rows<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.rowsRead += cursor.rowsRead;
    return rows;
  }

  /** The newest CANARY_RECENT_RUNS runs (once per view build). */
  private recentRuns(): CanaryRecord[] {
    const cached = this.readCache?.get('#recent_runs') as CanaryRecord[] | undefined;
    if (cached !== undefined) return cached;
    const runs = this.rows<CanaryRow>('SELECT * FROM canary_runs ORDER BY created_at DESC LIMIT ?', CANARY_RECENT_RUNS).map(fromRow);
    this.readCache?.set('#recent_runs', runs);
    return runs;
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
    const row = this.rows<AppliedRow>('SELECT * FROM guard_applied WHERE app = ?', app)[0];
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
    const row = this.rows<CanaryRow>("SELECT * FROM canary_runs WHERE phase != 'done' ORDER BY created_at DESC LIMIT 1")[0];
    return row === undefined ? null : fromRow(row);
  }

  private latestFinished(): CanaryRecord | null {
    const row = this.ctx.storage.sql
      .exec<CanaryRow>('SELECT * FROM canary_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1')
      .toArray()[0];
    return row === undefined ? null : fromRow(row);
  }

  private manualCount(day: string): number {
    const row = this.rows<{ n: number }>("SELECT count(*) AS n FROM canary_runs WHERE day = ? AND kind = 'manual'", day)[0];
    return row?.n ?? 0;
  }

  private scheduledExists(day: string): boolean {
    return this.rows("SELECT 1 AS found FROM canary_runs WHERE day = ? AND kind = 'scheduled' LIMIT 1", day).length > 0;
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
