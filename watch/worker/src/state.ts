/**
 * WatchState (../../docs/design.md §6): the single SQLite-backed Durable Object "watch-v1". It holds every watch,
 * snapshot and change, schedules itself with setAlarm (no cron trigger), makes every request to a watched site, and
 * serves the owner API (api.ts) through the shared transcoder: the Worker (http.ts) authenticates the owner and checks
 * CSRF, then forwards /api/v1/* here, so the Worker's own request stays far below Workers Free's 10 ms of CPU.
 *
 * Scheduling: `alarm()` runs one scheduler pass (scheduler.ts) and arms the next alarm; an error is caught, logged as a
 * code and re-armed after ALARM_ERROR_RETRY_MS. Every API call arms an alarm when none is set (a fallback for a lost
 * one), and writes that need a check soon bring it forward.
 *
 * Tests and local development: with DEV_MANUAL_ALARMS=true the object never arms an alarm and reads a clock the tests
 * set (`setClock`). A pass of `step(now)` reads its own clock, starting at `now`; a `setClock` during the pass moves
 * it too (a test's fake site may, while a request is out). The workerd suite calls `step(now)`, `sqlForTests` and
 * `takeRowMeter` through the binding (never reachable over HTTP).
 */
import { DurableObject } from 'cloudflare:workers';
import { HttpTranscoder } from '@ziyixi/proto/http-transcoder';
import { WatchUiService } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb';
import { handlers, type ApiContext } from './api.ts';
import { quickActionRenderer, type BrowserRenderer } from './browser.ts';
import { buildSha, devFetch, publicHost, REQUEST_ID_HEADER, type Env } from './env.ts';
import { supportedSelector } from './extract/html.ts';
import type { FetchFn } from './fetcher.ts';
import { NO_JUDGE } from './judge.ts';
import { ALARM_ERROR_RETRY_MS, FETCH_MAX_BYTES, FETCH_TIMEOUT_MS, MAX_BODY_BYTES, WAKE_MS } from './limits.ts';
import { PreviewCache, preview } from './preview.ts';
import { API_DOMAIN, localize, REASONS } from './reasons.ts';
import { errorCode, runAlarm, type AlarmResult } from './scheduler.ts';
import { HostLocks } from './host-locks.ts';
import { Store, type RowMeter } from './store.ts';
import { TodofySink } from './todofy.ts';
import type { NotificationSink } from './notify.ts';
import { setGuard, watchStatus, type GuardOutcome } from './ops-status.ts';
import type * as opsWire from '@ziyixi/proto/ops/v1/ops_wire';
import { RpcError } from '@ziyixi/proto/rpc-status';


/**
 * The transcoder's authorize hook: nothing left to check. Only the Worker's fetch handler reaches this object, after it
 * verified the owner's Access JWT and, for every method but GET, HEAD and OPTIONS, Origin and the CSRF token.
 */
function authorize(): void {
  // Checked by http.ts before forwarding.
}

const api = new HttpTranscoder(WatchUiService, handlers, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  authorize,
  localize,
  onUnexpected: () => new RpcError(REASONS.INTERNAL.code, 'INTERNAL', REASONS.INTERNAL.message),
});

export class WatchState extends DurableObject<Env> {
  private readonly store: Store;
  private readonly cache: PreviewCache;
  /** One request at a time per host, for the alarm and the owner API alike. */
  private readonly hosts = new HostLocks();
  private chain: Promise<unknown> = Promise.resolve();
  private testClock: number | null = null;
  /** The clock of the scheduler pass in progress under DEV_MANUAL_ALARMS (null between passes). */
  private passClock: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    this.cache = new PreviewCache(this.store);
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

  private fetchFn(): FetchFn {
    return devFetch(this.env) ?? ((request) => fetch(request));
  }

  private timeoutMs(): number {
    const override = Number(this.env.DEV_FETCH_TIMEOUT_MS ?? '');
    return this.manual() && Number.isInteger(override) && override > 0 ? override : FETCH_TIMEOUT_MS;
  }

  private browser(): BrowserRenderer | null {
    return this.env.BROWSER === undefined ? null : quickActionRenderer(this.env.BROWSER, FETCH_MAX_BYTES);
  }

  private transact = <T>(fn: () => T): T => this.ctx.storage.transactionSync(fn);

  /**
   * The notification sink: Todofy over the TODOFY binding, with links to this app's host (the only host Todofy allows
   * for this source). Without either (local development, most tests) the outbox only fills.
   */
  private sink(): NotificationSink | null {
    const host = publicHost(this.env);
    return this.env.TODOFY === undefined || host === null ? null : new TodofySink(this.store, this.env.TODOFY, host);
  }

  // ---- scheduling -------------------------------------------------------------------------------------------------

  /** Arms the alarm when none is set (every API call: the fallback for a lost alarm). */
  private async ensureAlarm(): Promise<void> {
    if (this.manual()) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + WAKE_MS);
  }

  /** Brings the alarm forward to a second from now. */
  private async wake(): Promise<void> {
    if (this.manual()) return;
    const at = await this.ctx.storage.getAlarm();
    const soon = Date.now() + WAKE_MS;
    if (at === null || at > soon) await this.ctx.storage.setAlarm(soon);
  }

  override async alarm(): Promise<void> {
    await this.step(Date.now());
  }

  /** One scheduler pass at `now`, then the next alarm (one pass at a time). */
  async step(now: number): Promise<AlarmResult | { next: number; error: string }> {
    const run = this.chain.then(async () => {
      let result: AlarmResult | { next: number; error: string };
      if (this.manual()) this.passClock = now;
      try {
        result = await runAlarm(
          {
            store: this.store,
            fetch: this.fetchFn(),
            browser: this.browser(),
            timeoutMs: this.timeoutMs(),
            now: () => (this.manual() ? (this.passClock ?? now) : Date.now()),
            hosts: this.hosts,
            transact: this.transact,
            judge: NO_JUDGE,
            sink: this.sink(),
            elapsed: () => performance.now(),
          },
          now,
        );
        const outcomes = result.outcomes;
        // Counts only: never a watch's URL, its text or a diff.
        console.log(
          JSON.stringify({ event: 'alarm', checks: Object.values(outcomes).reduce((a, b) => a + b, 0), changed: outcomes.changed ?? 0, failed: outcomes.failed ?? 0, errors: outcomes.error ?? 0, requests: result.requests, left: result.left }),
        );
      } catch (error) {
        const code = errorCode(error);
        console.log(JSON.stringify({ event: 'alarm_failed', code }));
        result = { next: now + ALARM_ERROR_RETRY_MS, error: code };
      }
      this.passClock = null;
      if (!this.manual()) await this.ctx.storage.setAlarm(Math.max(result.next, Date.now() + WAKE_MS));
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Test hook: the clock API calls read (DEV_MANUAL_ALARMS only). */
  setClock(now: number): void {
    if (!this.manual()) return;
    this.testClock = now;
    if (this.passClock !== null) this.passClock = now;
  }

  /** The armed alarm's time, or null (tests and the status view). */
  alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** Test hook: one SQL query's rows (DEV_MANUAL_ALARMS only; never reachable over HTTP). Not metered. */
  sqlForTests(query: string, ...params: (string | number | null)[]): Record<string, SqlStorageValue>[] {
    if (!this.manual()) throw new Error('not_available');
    const meter = this.store.takeMeter();
    const rows = this.store.all(query, ...params);
    this.store.takeMeter();
    this.store.addMeter(meter);
    return rows;
  }

  /** Test hook: the rows read and written since the last call (DEV_MANUAL_ALARMS only). */
  takeRowMeter(): RowMeter {
    if (!this.manual()) throw new Error('not_available');
    return this.store.takeMeter();
  }

  // ---- ops-v1 (ops.ts, the dashboard's service binding) -------------------------------------------------------------

  /**
   * status(): counts and codes from this object's SQLite (ops-status.ts). Its one write: an alarm when none is set, so
   * the dashboard's tick (every 30 minutes) re-arms a lost alarm as every owner API call does.
   */
  async opsStatus(): Promise<opsWire.OpsStatus> {
    await this.ensureAlarm();
    return watchStatus(this.store, this.env, this.now());
  }

  /** setGuard(): shed or normal (ops-status.ts); the next alarm pass applies it. */
  opsSetGuard(input: unknown): GuardOutcome {
    return this.transact(() => setGuard(this.store, input, this.now()));
  }

  // ---- the owner API ------------------------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    await this.ensureAlarm();
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? '';
    const now = this.now();
    const ctx: ApiContext = {
      store: this.store,
      now,
      configEnv: { selectorOk: supportedSelector, browserEnabled: this.env.BROWSER !== undefined },
      build: buildSha(this.env),
      transact: this.transact,
      wake: () => this.wake(),
      alarmAt: () => this.ctx.storage.getAlarm(),
      preview: (config, refresh, comparison) =>
        preview(
          {
            store: this.store,
            fetch: this.fetchFn(),
            browser: this.browser(),
            timeoutMs: this.timeoutMs(),
            now: () => this.now(),
            hosts: this.hosts,
            sleep: (ms) => this.sleep(ms),
          },
          this.cache,
          config,
          refresh,
          comparison,
        ),
    };
    const result = await api.handle(request, ctx, requestId);
    if (result === null) return api.errorResponse(new RpcError(REASONS.NOT_FOUND.code, 'NOT_FOUND', REASONS.NOT_FOUND.message), requestId, request.method === 'HEAD');
    if (result.error !== undefined) {
      // One line per refused request: the request ID, status and reason only (never a path, query or body).
      console.log(JSON.stringify({ request_id: requestId, status: result.response.status, reason: result.error.reason }));
    }
    return result.response;
  }

  /** Waits `ms`; under the test clock the wait only moves the clock. */
  private sleep(ms: number): Promise<void> {
    if (this.manual()) {
      if (this.testClock !== null) this.testClock += ms;
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
