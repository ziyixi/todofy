/**
 * MailsortState (../../docs/design.md §3): the single SQLite-backed Durable Object "mailsort-v1". It holds every label,
 * decision, example and ledger entry, schedules itself with setAlarm (no cron trigger), makes every request to
 * Gmail (gmail.ts) and Workers AI, and serves the owner API (api.ts) through the shared transcoder: the Worker (http.ts)
 * authenticates the owner and checks CSRF, then forwards /api/v2/* here, so the Worker's own request stays far below
 * Workers Free's 10 ms of CPU, and the Gmail and model calls get the object's 30 s.
 *
 * Scheduling: `alarm()` runs one pass (pipeline.ts) and arms the next alarm (soon while a backlog waits, else five
 * minutes); an error is caught, logged as a code and re-armed after ALARM_ERROR_RETRY_MS. Every API call and every
 * status() arms an alarm when none is set (the fallback for a lost one).
 *
 * Tests and local development: with DEV_MANUAL_ALARMS=true the object never arms an alarm and reads a clock the tests
 * set (`setClock`); `step(now)` runs one pass at that clock. `sqlForTests` and `takeRowMeter` exist for the workerd
 * suite only (never reachable over HTTP).
 */
import { DurableObject } from 'cloudflare:workers';
import { HttpTranscoder } from '@ziyixi/proto/http-transcoder';
import { MailsortUiService } from '@ziyixi/proto/mailsort/ui/v2/mailsort_ui_service_pb';
import type * as opsWire from '@ziyixi/proto/ops/v1/ops_wire';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { handlers, type ApiContext } from './api.ts';
import { aiRunner, buildSha, modeCeiling, REQUEST_ID_HEADER, upstreamFetch, type Env } from './env.ts';
import type { AccessToken } from './gmail.ts';
import { ALARM_ERROR_RETRY_MS, ALARM_SUBREQUESTS, MAX_BODY_BYTES, WAKE_MS } from './limits.ts';
import { activeShed, setGuard, sortStatus, type GuardOutcome } from './ops-status.ts';
import { runPass, type PassResult } from './pipeline.ts';
import { API_DOMAIN, localize, REASONS } from './reasons.ts';
import { Budget, noteTokenOk, openSession } from './session.ts';
import { senderHashesToBackfill, Store, type RowMeter } from './store.ts';

/**
 * The transcoder's authorize hook: nothing left to check. Only the Worker's fetch handler reaches this object, after it
 * verified the owner's Access JWT and, for every method but GET, HEAD and OPTIONS, Origin and the CSRF token.
 */
function authorize(): void {
  // Checked by http.ts before forwarding.
}

const api = new HttpTranscoder(MailsortUiService, handlers, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  authorize,
  localize,
  onUnexpected: () => new RpcError(REASONS.INTERNAL.code, 'INTERNAL', REASONS.INTERNAL.message),
});

export class MailsortState extends DurableObject<Env> {
  private readonly store: Store;
  private chain: Promise<unknown> = Promise.resolve();
  private testClock: number | null = null;
  /** The Gmail access token, cached in memory only (never stored): a new isolate refreshes it once. */
  private token: AccessToken | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    // The sender hashes a migration to version 5 needs are computed first (hashing is asynchronous); the migration
    // itself is one transaction.
    void ctx.blockConcurrencyWhile(async () => {
      const hashes = await senderHashesToBackfill(this.store);
      this.store.migrate(this.transact, hashes);
    });
  }

  private manual(): boolean {
    return this.env.DEV_MANUAL_ALARMS === 'true';
  }

  private now(): number {
    return this.manual() && this.testClock !== null ? this.testClock : Date.now();
  }

  private transact = <T>(fn: () => T): T => this.ctx.storage.transactionSync(fn);

  // ---- scheduling -------------------------------------------------------------------------------------------------

  private async ensureAlarm(): Promise<void> {
    if (this.manual()) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + WAKE_MS);
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

  /** One pass at `now`, then the next alarm (one pass at a time). */
  async step(now: number): Promise<PassResult | { next: number; code: string }> {
    const run = this.chain.then(async () => {
      if (this.manual()) this.testClock = now;
      let result: PassResult | { next: number; code: string };
      let pass: PassResult;
      try {
        pass = await runPass({
          store: this.store,
          env: this.env,
          fetch: upstreamFetch(this.env),
          ai: aiRunner(this.env),
          now: () => this.now(),
          transact: this.transact,
          token: this.token,
          saveToken: (token) => {
            this.token = token;
          },
          shed: activeShed(this.store, this.now()) !== null,
        });
        // Counts and codes only: never a subject, a sender or a label name.
        console.log(JSON.stringify({ event: 'alarm', mode: pass.mode, synced: pass.synced, decided: pass.decided, applied: pass.applied, deferred: pass.deferred, code: pass.code }));
        result = pass;
      } catch {
        console.log(JSON.stringify({ event: 'alarm_failed', code: 'pass_error' }));
        result = { next: now + ALARM_ERROR_RETRY_MS, code: 'pass_error' };
      }
      if (!this.manual()) await this.ctx.storage.setAlarm(Math.max(result.next, Date.now() + WAKE_MS));
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Test hook: the clock API calls and passes read (DEV_MANUAL_ALARMS only). */
  setClock(now: number): void {
    if (this.manual()) this.testClock = now;
  }

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

  // ---- ops-v1 (ops.ts, the dashboard's service binding) ---------------------------------------------------------------

  /** status(): counts and codes (ops-status.ts). Its one write: an alarm when none is set. */
  async opsStatus(): Promise<opsWire.OpsStatus> {
    await this.ensureAlarm();
    return sortStatus(this.store, this.env, this.now());
  }

  opsSetGuard(input: unknown): GuardOutcome {
    return this.transact(() => setGuard(this.store, input, this.now()));
  }

  // ---- the owner API --------------------------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    await this.ensureAlarm();
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? '';
    const now = this.now();
    const budget = new Budget(ALARM_SUBREQUESTS);
    const ctx: ApiContext = {
      store: this.store,
      now,
      build: buildSha(this.env),
      ceiling: modeCeiling(this.env),
      env: this.env,
      transact: this.transact,
      wake: () => this.wake(),
      alarmAt: () => this.ctx.storage.getAlarm(),
      budget,
      shed: activeShed(this.store, now) !== null,
      gmail: async () => {
        const session = await openSession({ store: this.store, env: this.env, fetch: upstreamFetch(this.env), now: () => this.now(), budget, token: this.token });
        if ('reason' in session) return session.reason;
        const fresh = this.token === null;
        const token = await session.client.ensureToken().catch(() => null);
        if (token !== null) {
          this.token = token;
          if (fresh) this.transact(() => { noteTokenOk(this.store, token); });
        }
        return session.client;
      },
    };
    const result = await api.handle(request, ctx, requestId);
    if (result === null) return api.errorResponse(new RpcError(REASONS.NOT_FOUND.code, 'NOT_FOUND', REASONS.NOT_FOUND.message), requestId, request.method === 'HEAD');
    if (result.error !== undefined) {
      // One line per refused request: the request ID, status and reason only (never a path, query or body).
      console.log(JSON.stringify({ request_id: requestId, status: result.response.status, reason: result.error.reason }));
    }
    return result.response;
  }
}
