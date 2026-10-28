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
 * Backup and restore (../../docs/backup.md): while a restore runs (restore.ts) or a backup job copies the store
 * (backup.ts), each alarm runs one of its steps instead of a pass, and every owner write is refused (RESTORE_RUNNING,
 * BACKUP_RUNNING), so the copy is one consistent point and a restore's rows are never mixed with new ones. An object
 * the Worker no longer addresses (WATCH_OBJECT moved to a new, empty object for a restore) keeps its data and stops:
 * its alarm is not armed again.
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
import { backupDue, backupRunning, runBackup } from './backup.ts';
import { puppeteerRenderer, type BrowserRenderer } from './browser.ts';
import { buildSha, devFetch, publicHost, PRIVATE_API_HEADER, REQUEST_ID_HEADER, WATCH_OBJECT, type Env } from './env.ts';
import { cleanEvidence } from './evidence.ts';
import { supportedSelector } from './extract/html.ts';
import type { FetchFn } from './fetcher.ts';
import { NO_JUDGE } from './judge.ts';
import { ALARM_ERROR_RETRY_MS, ALARM_IDLE_MS, FETCH_MAX_BYTES, FETCH_TIMEOUT_MS, MAX_BODY_BYTES, WAKE_MS } from './limits.ts';
import { PreviewCache, preview } from './preview.ts';
import { API_DOMAIN, localize, REASONS, watchError } from './reasons.ts';
import { restoreBlocking, runRestore, startRestore, type RestoreDeps } from './restore.ts';
import { errorCode, runAlarm, type AlarmResult } from './scheduler.ts';
import { HostLocks } from './host-locks.ts';
import { Store, type RowMeter } from './store.ts';
import { TasksSink } from './tasks.ts';
import type { NotificationSink } from './notify.ts';
import { setGuard, watchStatus, type GuardOutcome } from './ops-status.ts';
import type * as opsWire from '@ziyixi/proto/ops/v1/ops_wire';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';


/**
 * Public requests were authenticated by http.ts; the private feed additionally requires WatchApi, and a restore is the
 * owner's alone (never the private binding's).
 */
function authorize(_request: Request, route: { method: { localName: string } }, ctx: ApiContext): void {
  if (route.method.localName === 'pollWatchEvents' && !ctx.privateApi) {
    throw new RpcError(Code.PERMISSION_DENIED, 'FORBIDDEN', 'The Watch event feed requires a private service binding');
  }
  if (route.method.localName === 'restoreBackup' && ctx.privateApi === true) {
    throw new RpcError(Code.PERMISSION_DENIED, 'FORBIDDEN', 'A restore is the owner\'s alone');
  }
}

/** What a step of the alarm did: a scheduler pass, a backup's or a restore's step, or a caught failure. */
export type StepResult = AlarmResult | { next: number; error: string } | { next: number; job: 'backup' | 'restore' };

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

  /** Browser Run through the official client (the workerd tests override this with a synthetic launcher). */
  protected browser(): BrowserRenderer | null {
    return this.env.BROWSER === undefined ? null : puppeteerRenderer(this.env.BROWSER, FETCH_MAX_BYTES);
  }

  private transact = <T>(fn: () => T): T => this.ctx.storage.transactionSync(fn);

  /** Why an owner write must wait now (a restore not finished, a backup copying the store), or null. */
  private writeBlock(): 'RESTORE_RUNNING' | 'BACKUP_RUNNING' | null {
    if (restoreBlocking(this.store)) return 'RESTORE_RUNNING';
    return backupRunning(this.store) ? 'BACKUP_RUNNING' : null;
  }

  private restoreDeps(): RestoreDeps {
    return { store: this.store, backups: this.env.BACKUPS, evidence: this.env.EVIDENCE_STORE, transact: this.transact };
  }

  /** An object the Worker no longer addresses (its name is not WATCH_OBJECT): it keeps its data and stops. */
  private retired(): boolean {
    const name = this.ctx.id.name;
    return name !== undefined && name !== WATCH_OBJECT;
  }

  /**
   * The notification sink: Tasks over the TASKS binding (its TaskInbox), with links to this app's host. Without either
   * (local development, most tests) the outbox only fills.
   */
  private sink(): NotificationSink | null {
    const host = publicHost(this.env);
    if (this.env.TASKS === undefined || host === null) return null;
    return new TasksSink(this.store, this.env.TASKS, host);
  }

  // ---- scheduling -------------------------------------------------------------------------------------------------

  /**
   * Arms the alarm when none is set (every API call: the fallback for a lost alarm), and brings it forward to a backup
   * due sooner (the first one after the release that bound the bucket starts at once).
   */
  private async ensureAlarm(): Promise<void> {
    if (this.manual()) return;
    const now = Date.now();
    const at = await this.ctx.storage.getAlarm();
    const backup = this.env.BACKUPS === undefined ? Infinity : Math.max(backupDue(this.store, now), now + WAKE_MS);
    if (at === null) await this.ctx.storage.setAlarm(now + WAKE_MS);
    else if (at > backup) await this.ctx.storage.setAlarm(backup);
  }

  /** Brings the alarm forward to a second from now. */
  private async wake(): Promise<void> {
    if (this.manual()) return;
    const at = await this.ctx.storage.getAlarm();
    const soon = Date.now() + WAKE_MS;
    if (at === null || at > soon) await this.ctx.storage.setAlarm(soon);
  }

  override async alarm(): Promise<void> {
    if (this.retired()) {
      // Not armed again: an old object never checks, notifies or backs up next to the one the Worker addresses.
      console.log(JSON.stringify({ event: 'retired' }));
      return;
    }
    await this.step(Date.now());
  }

  /**
   * One step at `now`, then the next alarm (one at a time): a restore's step while one runs (nothing else while one
   * failed), else a backup's step while a job runs or is due, else a scheduler pass.
   */
  async step(now: number): Promise<StepResult> {
    const run = this.chain.then(async () => {
      let result: StepResult;
      if (this.manual()) this.passClock = now;
      try {
        const restoring = await runRestore(this.restoreDeps(), now);
        const backup = restoring === null && !restoreBlocking(this.store) && this.env.BACKUPS !== undefined
          ? await runBackup({ store: this.store, bucket: this.env.BACKUPS, evidence: this.env.EVIDENCE_STORE }, now)
          : null;
        if (restoring !== null) result = { next: restoring, job: 'restore' };
        // A failed restore: writes, checks and backups wait for a repeated RestoreBackup.
        else if (restoreBlocking(this.store)) result = { next: now + ALARM_IDLE_MS, job: 'restore' };
        else if (backup?.ran === true) result = { next: backup.next, job: 'backup' };
        else result = await this.pass(now, backup?.next ?? Infinity);
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

  /** A scheduler pass at `now` (scheduler.ts); its next alarm no later than `backupAt`, when the backup is due. */
  private async pass(now: number, backupAt: number): Promise<AlarmResult> {
    if (this.env.EVIDENCE_STORE) {
      try { await cleanEvidence(this.store, this.env.EVIDENCE_STORE); }
      catch { console.warn(JSON.stringify({ event: 'evidence_cleanup', error_code: 'UNAVAILABLE' })); }
    }
    const result = await runAlarm(
      {
        store: this.store,
        fetch: this.fetchFn(),
        browser: this.browser(),
        timeoutMs: this.timeoutMs(),
        now: () => (this.manual() ? (this.passClock ?? now) : Date.now()),
        hosts: this.hosts,
        transact: this.transact,
        judge: NO_JUDGE,
        evidenceStore: this.env.EVIDENCE_STORE,
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
    return { ...result, next: Math.min(result.next, Math.max(backupAt, now + WAKE_MS)) };
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
    const writable = () => {
      const block = this.writeBlock();
      if (block !== null) throw watchError(block);
    };
    const ctx: ApiContext = {
      privateApi: request.headers.get(PRIVATE_API_HEADER) === 'true',
      evidenceStore: this.env.EVIDENCE_STORE,
      store: this.store,
      now,
      configEnv: { selectorOk: supportedSelector, browserEnabled: this.env.BROWSER !== undefined },
      build: buildSha(this.env),
      // Every owner write: refused while a restore is not finished or a backup copies the store.
      transact: (fn) => this.transact(() => {
        writable();
        return fn();
      }),
      writable,
      backups: this.env.BACKUPS !== undefined,
      restore: (backup) => startRestore(this.restoreDeps(), backup, now),
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
