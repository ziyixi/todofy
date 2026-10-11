/**
 * BriefState (../../docs/design.md §1, §14): the single SQLite-backed Durable Object "brief-v1". It holds the sources'
 * and hosts' state, the items, embeddings and clusters, the issues and their items, every model call, the send ledger,
 * the votes and weights; it makes every external request (feeds, pages, Workers AI, Claude, Resend), and it serves the
 * owner API through the shared transcoder after the Worker (http.ts) authenticated the owner and checked CSRF.
 *
 * The alarm chain (no cron): each alarm does one step, then sets the next alarm (a second later while work is left, else
 * the next slot of the schedule):
 *
 * 1. first it settles what a previous invocation left: a model call left open (a deploy's: not counted; a crash's: one
 *    attempt), a send left `submitting` (unknown: never sent again), a step or a round left open (a crash counts, a
 *    deploy does not; STEP_CRASHES_MAX gives up);
 * 2. then the first of: the oldest unfinished issue's step (pipeline.ts) when it is due, or at once when its day is
 *    over (a run never makes a model call past its send cutoff, so an earlier day's run ends in a few steps and never
 *    holds up the next day's); the current fetch round (collect.ts) until it is done; the creation of the day's issue
 *    after its cutoff round; the Sunday learning (learn.ts); the daily prune.
 *
 * Each step has its own budgets (budget.ts): ALARM_SUBREQUESTS subrequests and STEP_WALL_MS of wall time with its own
 * AbortSignal for the fetching steps, and an Opus call starts only as the first thing of its alarm with MODEL_MIN_LEFT_MS
 * of the 15 minutes left, its stream bounded by its own deadline. An alarm that throws is caught, logged as a code and
 * re-armed ALARM_ERROR_RETRY_MS later; every API call and every status() arm one when none is set.
 *
 * Tests and local development: with DEV_MANUAL_ALARMS=true the object never arms an alarm and reads a clock the tests
 * set (`setClock`), which a host's spacing advances instead of sleeping; `step(now)` runs one alarm at that clock. The
 * test hooks (`sqlForTests`, `takeRowMeter`, `setRegistryForTests`) answer only in that mode.
 */
import { DurableObject } from 'cloudflare:workers';
import { BriefUiService } from '@ziyixi/proto/brief/ui/v1/brief_ui_service_pb';
import { HttpTranscoder } from '@ziyixi/proto/http-transcoder';
import type * as opsWire from '@ziyixi/proto/ops/v1/ops_wire';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { handlers, recordVote, type ApiContext } from './api.ts';
import { sleep, StepBudget } from './budget.ts';
import { settleOpenCalls, type CallContext } from './claude.ts';
import { collectStep, type CollectResult } from './collect.ts';
import { aiRunner, anthropicKey, buildSha, mode, publicHost, REQUEST_ID_HEADER, upstreamFetch, type Env } from './env.ts';
import type { VoteName } from './feedback.ts';
import { Hosts, type Clock } from './fetch/hosts.ts';
import type { FetchFn } from './fetch/net.ts';
import { ownSuffixes } from './fetch/policy.ts';
import { learn } from './learn.ts';
import {
  ALARM_ERROR_RETRY_MS,
  ALARM_NEXT_MS,
  ALARM_SUBREQUESTS,
  ALARM_WALL_MS,
  CLUSTERS_KEPT_MS,
  DAY,
  EMBEDDINGS_KEPT_MS,
  HOUR,
  ISSUES_KEPT_MS,
  ITEMS_KEPT_MS,
  LEDGER_KEPT_MS,
  MAX_BODY_BYTES,
  MENTION_WINDOW_MS,
  PRUNE_BATCH,
  REQUEST_ID_TTL_MS,
  STEP_CRASHES_MAX,
  STEP_WALL_MS,
  TEXT_KEPT_MS,
  VOTED_EMBEDDINGS_KEPT_MS,
  WAKE_MS,
} from './limits.ts';
import { activeShed, briefStatus, setGuard, type GuardOutcome } from './ops-status.ts';
import { giveUp, issueStep, openStep, settleOpenStep, type PipelineEnv, type StepResult } from './pipeline.ts';
import { API_DOMAIN, localize, REASONS } from './reasons.ts';
import { bundled, loadRegistry, type Registry, type Topic } from './registry.ts';
import { addDays, currentRound, cutoffOf, issueKind, lastLearnSlot, localDate, nextScheduled, type Round } from './schedule.ts';
import { settleSubmitting } from './send.ts';
import { readSettings } from './settings.ts';
import { Store, type RowMeter, type RunRow } from './store.ts';

/**
 * The transcoder's authorize hook: nothing left to check. Only the Worker's fetch handler reaches this object, after it
 * verified the owner's Access JWT and, for every method but GET, HEAD and OPTIONS, Origin and the CSRF token.
 */
function authorize(): void {
  // Checked by http.ts before forwarding.
}

const api = new HttpTranscoder(BriefUiService, handlers, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  authorize,
  localize,
  onUnexpected: () => new RpcError(REASONS.INTERNAL.code, 'INTERNAL', REASONS.INTERNAL.message),
});

/** The day's issue waits this long past its cutoff for the cutoff round to finish, then starts anyway. */
const CUTOFF_ROUND_WAIT_MS = 2 * HOUR;

export interface AlarmResult {
  readonly job: 'issue' | 'collect' | 'create' | 'learn' | 'idle' | 'error';
  readonly code: string;
  readonly next: number;
  readonly step?: string;
}

export class BriefState extends DurableObject<Env> {
  private readonly store: Store;
  private chain: Promise<unknown> = Promise.resolve();
  private testClock: number | null = null;
  private testRegistry: Registry | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    void ctx.blockConcurrencyWhile(() => {
      this.store.migrate();
      return Promise.resolve();
    });
  }

  private manual(): boolean {
    return this.env.DEV_MANUAL_ALARMS === 'true';
  }

  private now(): number {
    return this.manual() && this.testClock !== null ? this.testClock : Date.now();
  }

  /** The fetchers' clock: in manual mode a host's spacing advances the test clock instead of sleeping. */
  private clock(): Clock {
    if (!this.manual()) return { now: () => Date.now(), sleep };
    return {
      now: () => this.now(),
      sleep: (ms, signal) => {
        if (signal.aborted) return Promise.resolve(false);
        this.testClock = this.now() + ms;
        return Promise.resolve(true);
      },
    };
  }

  private transact = <T>(fn: () => T): T => this.ctx.storage.transactionSync(fn);

  private registry(): Registry {
    return this.testRegistry ?? bundled().registry;
  }

  private topics(): readonly Topic[] {
    return bundled().topics;
  }

  private fetcher(): FetchFn {
    const base = upstreamFetch(this.env);
    return (request) => base(request);
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---- scheduling -------------------------------------------------------------------------------------------------

  private async ensureAlarm(): Promise<void> {
    if (this.manual()) return;
    const at = await this.ctx.storage.getAlarm();
    const stale = Number(this.store.getMeta('last_alarm_ms') ?? '0');
    // A lost alarm (or one that has not run for half a day) is armed again.
    if (at === null || (stale > 0 && Date.now() - stale > 12 * HOUR && at > Date.now() + HOUR)) await this.ctx.storage.setAlarm(Date.now() + WAKE_MS);
  }

  private async wake(): Promise<void> {
    if (this.manual()) return;
    const at = await this.ctx.storage.getAlarm();
    const soon = Date.now() + WAKE_MS;
    if (at === null || at > soon) await this.ctx.storage.setAlarm(soon);
  }

  override async alarm(): Promise<void> {
    await this.step(Date.now());
  }

  /** One alarm at `now`, then the next alarm (one at a time). */
  step(now: number): Promise<AlarmResult> {
    return this.serially(async () => {
      if (this.manual()) this.testClock = now;
      const started = Date.now();
      let result: AlarmResult;
      try {
        result = await this.runAlarm(started);
      } catch {
        this.transact(() => { this.store.pushError('alarm_failed'); });
        result = { job: 'error', code: 'alarm_failed', next: this.now() + ALARM_ERROR_RETRY_MS };
      }
      // Counts and codes only: never a title, a text or an address.
      console.log(JSON.stringify({ event: 'alarm', job: result.job, step: result.step ?? null, code: result.code }));
      if (!this.manual()) await this.ctx.storage.setAlarm(Math.max(result.next, Date.now() + WAKE_MS));
      return result;
    });
  }

  private async runAlarm(started: number): Promise<AlarmResult> {
    const now = this.now();
    const build = buildSha(this.env);
    const day = localDate(now);
    this.transact(() => {
      this.store.setMeta('last_alarm_ms', String(now));
      const settled = settleOpenCalls(this.store, build, now);
      if (settled.crashed > 0) this.store.pushError('call_crashed');
      settleSubmitting(this.store, now);
      if (this.store.getMeta('pruned_day') !== day) {
        this.prune(now);
        this.store.setMeta('pruned_day', day);
      }
    });
    const timeLeft = (): number => ALARM_WALL_MS - (Date.now() - started);
    // 1. The oldest unfinished issue, when its next step is due (an earlier day's at once: it only has to end).
    const run = this.store.one<RunRow>(`SELECT * FROM runs WHERE done = 0 ORDER BY issue LIMIT 1`);
    if (run !== undefined && (run.not_before_ms <= now || run.issue < day)) {
      const result = await this.issueAlarm(run, timeLeft);
      return { job: 'issue', step: run.step, code: result.code, next: this.nextAfter(result.next) };
    }
    // 2. The current fetch round.
    const round = currentRound(now);
    if ((this.store.getMeta('round_done') ?? '') < round.key) {
      const result = await this.collectAlarm(round, day, timeLeft);
      const next = result.done ? now + ALARM_NEXT_MS : result.readyAt !== null && result.polled === 0 && result.screened === 0 && result.embedded === 0 ? result.readyAt : now + ALARM_NEXT_MS;
      return { job: 'collect', code: result.code, next: Math.min(next, this.wakeFor(run)) };
    }
    // 3. The day's issue, once its cutoff round is done.
    if (this.createIssue(now)) return { job: 'create', code: 'issue_created', next: now + ALARM_NEXT_MS };
    // 4. The Sunday learning (Home's guard defers it).
    const slot = lastLearnSlot(now);
    if (slot > Number(this.store.getMeta('learn_ms') ?? '0') && activeShed(this.store, now) === null) {
      const counts = this.transact(() => learn(this.store, this.registry(), this.topics(), now));
      return { job: 'learn', code: `learned_${String(counts.topics)}`, next: now + ALARM_NEXT_MS };
    }
    return { job: 'idle', code: 'ok', next: Math.min(nextScheduled(now), this.wakeFor(run)) };
  }

  /** When a waiting run wants its next step (Infinity without one). */
  private wakeFor(run: RunRow | undefined): number {
    return run === undefined ? Infinity : Math.max(run.not_before_ms, this.now() + ALARM_NEXT_MS);
  }

  private nextAfter(next: number): number {
    const now = this.now();
    if (next < 0) return Math.min(now + ALARM_NEXT_MS, nextScheduled(now));
    if (next === 0) return now + ALARM_NEXT_MS;
    return Math.min(next, nextScheduled(now));
  }

  private claudeContext(budget: number, timeLeft: () => number): CallContext {
    return {
      store: this.store,
      env: this.env,
      fetch: (input, init) => upstreamFetch(this.env)(input, init),
      now: () => this.now(),
      transact: this.transact,
      timeLeft,
      budgetUsd: budget,
      mode: mode(this.env),
    };
  }

  private async issueAlarm(run: RunRow, timeLeft: () => number): Promise<StepResult> {
    const build = buildSha(this.env);
    const settled = this.transact(() => settleOpenStep(this.store, run, build));
    const settings = readSettings(this.store);
    const budget = new StepBudget(ALARM_SUBREQUESTS, STEP_WALL_MS, () => Date.now());
    const clock = this.clock();
    const fetchFn = this.fetcher();
    const own = ownSuffixes(publicHost(this.env));
    const claude = this.claudeContext(settings.monthlyBudgetUsd, timeLeft);
    const env: PipelineEnv = {
      store: this.store,
      registry: this.registry(),
      topics: this.topics(),
      env: this.env,
      budget,
      clock,
      hosts: new Hosts(this.store, budget, clock, fetchFn, own),
      fetchFn,
      own,
      transact: this.transact,
      claude,
      build,
      publicHost: publicHost(this.env) ?? 'brief.ziyixi.science',
      mode: mode(this.env),
      paused: settings.paused,
      timeLeft,
    };
    try {
      if (settled.gaveUp) return giveUp(env, settled.run);
      this.transact(() => { openStep(this.store, settled.run, build, this.now()); });
      const result = await issueStep(env, settled.run);
      // A step that returned without saving clears its open marker here (it committed nothing half-done).
      this.transact(() => this.store.run(`UPDATE runs SET open_build = NULL, open_ms = NULL WHERE issue = ? AND open_build IS NOT NULL`, run.issue));
      return result;
    } finally {
      budget.close();
    }
  }

  private async collectAlarm(round: Round, day: string, timeLeft: () => number): Promise<CollectResult> {
    const build = buildSha(this.env);
    const now = this.now();
    // A round left open by this build's crash counts; STEP_CRASHES_MAX crashes end the round.
    const open = this.store.getJson<{ round: string; build: string } | null>('collect_open', null);
    if (open !== null && open.round === round.key && open.build === build) {
      const crashes = Number(this.store.getMeta('collect_crashes') ?? '0') + 1;
      this.transact(() => {
        this.store.setMeta('collect_crashes', String(crashes));
        this.store.pushError('collect_crashed');
      });
      if (crashes >= STEP_CRASHES_MAX) {
        this.transact(() => {
          this.store.setMeta('round_done', round.key);
          this.store.deleteMeta('collect_open', 'collect_crashes');
        });
        return { done: true, readyAt: null, polled: 0, newItems: 0, embedded: 0, screened: 0, code: 'collect_crashed' };
      }
    } else if (open === null || open.round !== round.key) this.transact(() => { this.store.deleteMeta('collect_crashes'); });
    const settings = readSettings(this.store);
    const deployment = mode(this.env);
    const shed = activeShed(this.store, now) !== null;
    const budget = new StepBudget(ALARM_SUBREQUESTS, STEP_WALL_MS, () => Date.now());
    const clock = this.clock();
    const fetchFn = this.fetcher();
    const own = ownSuffixes(publicHost(this.env));
    const gate = deployment !== 'off' && !settings.paused && anthropicKey(this.env) !== null;
    try {
      this.transact(() => { this.store.setJson('collect_open', { round: round.key, build }); });
      const result = await collectStep({
        store: this.store,
        registry: this.registry(),
        topics: this.topics(),
        budget,
        clock,
        hosts: new Hosts(this.store, budget, clock, fetchFn, own),
        fetchFn,
        own,
        ai: shed ? null : aiRunner(this.env),
        claude: gate ? this.claudeContext(settings.monthlyBudgetUsd, timeLeft) : null,
        transact: this.transact,
        round,
        day,
        shed,
      });
      this.transact(() => {
        this.store.deleteMeta('collect_open');
        if (result.done) this.store.setMeta('round_done', round.key);
      });
      return result;
    } finally {
      budget.close();
    }
  }

  /** Creates the day's run after its cutoff round (or two hours after the cutoff), unless the brief may not make one. */
  private createIssue(now: number): boolean {
    const date = localDate(now);
    const kind = issueKind(date);
    if (kind === null || now < cutoffOf(date)) return false;
    if (mode(this.env) === 'off' || anthropicKey(this.env) === null || readSettings(this.store).paused) return false;
    if (this.store.one(`SELECT 1 AS x FROM runs WHERE issue = ?`, date) !== undefined) return false;
    const cutoffKey = `${date}T03:30`;
    if ((this.store.getMeta('round_done') ?? '') < cutoffKey && now < cutoffOf(date) + CUTOFF_ROUND_WAIT_MS) return false;
    this.transact(() => { this.store.insert('runs', { issue: date, kind, step: kind === 'weekday' ? 'pick' : 'thread', created_ms: now, updated_ms: now }); });
    return true;
  }

  /** The daily prune (bounded per table): what each table keeps (design §14). */
  private prune(now: number): void {
    const day = localDate(now);
    const batch = (table: string, where: string, ...params: (string | number)[]): void => {
      this.store.run(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${String(PRUNE_BATCH)})`, ...params);
    };
    batch('items', 'fetched_ms < ?', now - ITEMS_KEPT_MS);
    batch('embeddings', '(voted = 0 AND ms < ?) OR ms < ?', now - EMBEDDINGS_KEPT_MS, now - VOTED_EMBEDDINGS_KEPT_MS);
    batch('clusters', 'updated_ms < ?', now - CLUSTERS_KEPT_MS);
    this.store.run(`DELETE FROM texts WHERE issue < ?`, addDays(day, -Math.round(TEXT_KEPT_MS / DAY)));
    batch('calls', 'started_ms < ?', now - LEDGER_KEPT_MS);
    this.store.run(`UPDATE calls SET answer = '' WHERE answer != '' AND started_ms < ?`, now - 7 * DAY);
    batch('sends', 'created_ms < ?', now - LEDGER_KEPT_MS);
    batch('sent_keys', 'ms < ?', now - LEDGER_KEPT_MS);
    this.store.run(`DELETE FROM pending_mentions WHERE ms < ?`, now - MENTION_WINDOW_MS);
    this.store.run(`DELETE FROM votes WHERE ms < ?`, now - LEDGER_KEPT_MS);
    this.store.run(`DELETE FROM issue_items WHERE issue < ?`, addDays(day, -Math.round(ISSUES_KEPT_MS / DAY)));
    this.store.run(`DELETE FROM issues WHERE issue < ?`, addDays(day, -Math.round(ISSUES_KEPT_MS / DAY)));
    this.store.run(`DELETE FROM runs WHERE issue < ? AND done = 1`, addDays(day, -14));
    this.store.run(`DELETE FROM usage WHERE day < ?`, addDays(day, -400));
    this.store.run(`DELETE FROM requests WHERE time_ms < ?`, now - REQUEST_ID_TTL_MS);
  }

  // ---- the feedback route (the Worker verified the token) ------------------------------------------------------------

  /** The title of an item a feedback link names, or null. */
  async feedbackTitle(issue: string, item: string): Promise<string | null> {
    await this.ensureAlarm();
    return this.store.one<{ title: string }>(`SELECT title FROM issue_items WHERE issue = ? AND id = ?`, issue, item)?.title ?? null;
  }

  /** Records a vote from a feedback link (origin owner, replacing an earlier one); the item's title, or null. */
  async recordFeedback(issue: string, item: string, vote: VoteName): Promise<string | null> {
    await this.ensureAlarm();
    const row = this.transact(() => recordVote(this.store, issue, item, vote, this.now()));
    return row?.title ?? null;
  }

  // ---- ops-v1 (ops.ts, Home's service binding) ------------------------------------------------------------------------

  /** status(): counts and codes. Its one write: an alarm when none is set. */
  async opsStatus(): Promise<opsWire.OpsStatus> {
    await this.ensureAlarm();
    return briefStatus(this.store, this.registry(), this.env, this.now());
  }

  opsSetGuard(input: unknown): GuardOutcome {
    return this.transact(() => setGuard(this.store, input, this.now()));
  }

  // ---- the owner API --------------------------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    await this.ensureAlarm();
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? '';
    const ctx: ApiContext = {
      store: this.store,
      registry: this.registry(),
      topics: this.topics(),
      env: this.env,
      now: this.now(),
      build: buildSha(this.env),
      transact: this.transact,
      wake: () => this.wake(),
      alarmAt: () => this.ctx.storage.getAlarm(),
    };
    const result = await api.handle(request, ctx, requestId);
    if (result === null) return api.errorResponse(new RpcError(REASONS.NOT_FOUND.code, 'NOT_FOUND', REASONS.NOT_FOUND.message), requestId, request.method === 'HEAD');
    if (result.error !== undefined) console.log(JSON.stringify({ request_id: requestId, status: result.response.status, reason: result.error.reason }));
    return result.response;
  }

  // ---- test hooks (DEV_MANUAL_ALARMS only; never reachable over HTTP) -------------------------------------------------

  setClock(now: number): void {
    if (this.manual()) this.testClock = now;
  }

  alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** Replaces the bundled registry with a synthetic one (the workerd suite's fake sources). */
  setRegistryForTests(yaml: string): number {
    if (!this.manual()) throw new Error('not_available');
    this.testRegistry = loadRegistry(yaml);
    return this.testRegistry.sources.length;
  }

  sqlForTests(query: string, ...params: (string | number | null)[]): Record<string, SqlStorageValue>[] {
    if (!this.manual()) throw new Error('not_available');
    return this.store.unmetered(() => this.store.all(query, ...params));
  }

  takeRowMeter(): RowMeter {
    if (!this.manual()) throw new Error('not_available');
    return this.store.takeMeter();
  }
}
