/**
 * RecallState (../../docs/design.md §1, §5): the single SQLite-backed Durable Object "recall-v1". It holds every page,
 * visit, captured text's metadata, the search index and the change feed; it writes and deletes the texts in R2. The
 * Worker (http.ts) checks every caller first and then makes one call here:
 *
 * - `ingest(body)`: an upload of the extension (ingest.ts), after the Worker checked the ingest token and the size;
 * - `feed(search)`: a page of the change feed (feed.ts), after the Worker checked the export token;
 * - `blobState(path)`: why R2 has no blob a consumer asked for (the Worker answers every blob R2 has by itself);
 * - `fetch(request)`: the owner API (api.ts) through the shared transcoder, after Access, Origin and CSRF;
 * - `opsStatus()`: ops-v1 for Home (ops.ts, ops-status.ts).
 *
 * Uploads and alarm runs go one at a time (they await R2 between their reads and their transaction). The alarm runs
 * once a day (ALARM_HOUR_UTC) and a minute later again while work is left (retention.ts); every call arms one when
 * none is set. Every call but ops-v1's status ends by charging the rows it read and wrote to the day's usage
 * (Store.chargeRows), which the daily budgets read.
 *
 * Tests and local development: with DEV_MANUAL_ALARMS=true the object never arms an alarm and reads a clock the tests
 * set (`setClock`); `step(now)` runs one alarm pass at that clock. `sqlForTests`, `takeRowMeter` and `failNextCommit`
 * exist for the workerd suite only (never reachable over HTTP).
 */
import { DurableObject } from 'cloudflare:workers';
import { HttpTranscoder } from '@ziyixi/proto/http-transcoder';
import type * as opsWire from '@ziyixi/proto/ops/v1/ops_wire';
import { RecallUiService } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { RECALL_HOST } from '../../shared/denylist.ts';
import { machineError, type MachineAnswer } from './answers.ts';
import { handlers, type ApiContext } from './api.ts';
import { documentIdOfPath } from './blobs.ts';
import { buildSha, publicHost, REQUEST_ID_HEADER, type Env } from './env.ts';
import { feedAnswer } from './feed.ts';
import { ingestBatch } from './ingest.ts';
import { ALARM_BACKLOG_MS, MAX_BODY_BYTES, WAKE_MS } from './limits.ts';
import { recallStatus } from './ops-status.ts';
import { API_DOMAIN, localize, REASONS } from './reasons.ts';
import { demoteStep, indexOverBudget, maintenanceAllowed, nextDailyRun, purgeStep } from './retention.ts';
import { SearchCache } from './search.ts';
import { Store, utcDay, type RowMeter } from './store.ts';

/**
 * The transcoder's authorize hook: nothing left to check. Only the Worker's fetch handler reaches this object, after it
 * verified the owner's Access JWT and, for every method but GET, HEAD and OPTIONS, Origin and the CSRF token.
 */
function authorize(): void {
  // Checked by http.ts before forwarding.
}

const api = new HttpTranscoder(RecallUiService, handlers, {
  domain: API_DOMAIN,
  maxBodyBytes: MAX_BODY_BYTES,
  authorize,
  localize,
  onUnexpected: () => new RpcError(REASONS.INTERNAL.code, 'INTERNAL', REASONS.INTERNAL.message),
});

/** What one alarm pass did. */
export interface StepResult {
  readonly next: number;
  readonly purging: boolean;
  readonly demoting: boolean;
  /** Purges or demotions are left, but today's maintenance allowance is spent: the next daily run goes on. */
  readonly deferred: boolean;
  readonly code: string;
}

export class RecallState extends DurableObject<Env> {
  private readonly store: Store;
  private readonly searches = new SearchCache();
  /** Uploads and alarm passes, one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private testClock: number | null = null;
  private crashBeforeCommit = false;

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

  private transact = <T>(fn: () => T): T => this.ctx.storage.transactionSync(fn);

  /** Charges what the call read and wrote outside a charging transaction to the day's usage. */
  private charge(): void {
    this.transact(() => {
      this.store.chargeRows(utcDay(this.now()));
    });
  }

  /** Runs `work` after every upload and alarm pass before it. */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The hosts recall never records: its own (PUBLIC_HOST) and the extension's build constant. */
  private ownHosts(): string[] {
    const host = publicHost(this.env);
    return host === null ? [RECALL_HOST] : [host, RECALL_HOST];
  }

  // ---- scheduling -------------------------------------------------------------------------------------------------

  private async ensureAlarm(): Promise<void> {
    if (this.manual()) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(nextDailyRun(Date.now()));
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

  /** One alarm pass at `now`: a purge step, the small tables' cleanup, an index budget step; then the next alarm. */
  step(now: number): Promise<StepResult> {
    return this.serially(async () => {
      if (this.manual()) this.testClock = now;
      let result: StepResult;
      try {
        // Purges and demotions write rows: once today's allowance is spent they wait for the next day.
        const allowed = maintenanceAllowed(this.store, now);
        const purging = allowed && (await purgeStep(this.store, this.env.STORE, this.transact));
        const demoting = this.transact(() => {
          this.store.prune(now);
          const more = allowed && demoteStep(this.store, now);
          this.store.chargeRows(utcDay(now));
          return more;
        });
        const deferred = !allowed && (this.store.one(`SELECT 1 AS x FROM purges LIMIT 1`) !== undefined || indexOverBudget(this.store));
        result = { next: purging || demoting ? now + ALARM_BACKLOG_MS : nextDailyRun(now), purging, demoting, deferred, code: 'ok' };
      } catch {
        this.transact(() => {
          this.store.pushError('alarm_failed');
        });
        result = { next: now + ALARM_BACKLOG_MS, purging: false, demoting: false, deferred: false, code: 'alarm_failed' };
      }
      // Counts and codes only.
      console.log(JSON.stringify({ event: 'alarm', purging: result.purging, demoting: result.demoting, deferred: result.deferred, code: result.code }));
      if (!this.manual()) await this.ctx.storage.setAlarm(Math.max(result.next, Date.now() + WAKE_MS));
      return result;
    });
  }

  // ---- the machine routes (the Worker checked the token, the method and the size) --------------------------------------

  ingest(body: ArrayBuffer, requestId: string): Promise<MachineAnswer> {
    return this.serially(async () => {
      await this.ensureAlarm();
      try {
        return await ingestBatch(
          {
            store: this.store,
            bucket: this.env.STORE,
            now: this.now(),
            transact: this.transact,
            ownHosts: this.ownHosts(),
            requestId,
            failBeforeCommit: () => {
              const crash = this.manual() && this.crashBeforeCommit;
              this.crashBeforeCommit = false;
              return crash;
            },
          },
          body,
        );
      } catch {
        console.log(JSON.stringify({ event: 'upload', request_id: requestId, code: 'upload_failed' }));
        return machineError('INTERNAL', requestId);
      }
    });
  }

  async feed(search: string, requestId: string): Promise<MachineAnswer> {
    await this.ensureAlarm();
    const now = this.now();
    const answer = this.transact(() => {
      const page = feedAnswer(this.store, search, now, requestId);
      this.store.chargeRows(utcDay(now));
      return page;
    });
    console.log(JSON.stringify({ event: 'feed', request_id: requestId, status: answer.status, reason: answer.reason ?? null }));
    return answer;
  }

  /**
   * Why R2 has no object at a blob path: `deleted` when no live document holds it (its page was deleted: 410), else
   * `missing` (a wrong binding or a lost object: 500, logged and kept among the recent error codes).
   */
  blobState(path: string): 'deleted' | 'missing' {
    const id = documentIdOfPath(path);
    const live =
      id !== null &&
      this.store.one(`SELECT 1 AS x FROM documents d JOIN pages p ON p.rowid = d.page_rowid WHERE d.id = ? AND d.blob_path = ?`, id, path) !== undefined;
    if (!live) {
      this.charge();
      return 'deleted';
    }
    this.transact(() => {
      this.store.pushError('blob_missing');
      this.store.chargeRows(utcDay(this.now()));
    });
    console.log(JSON.stringify({ event: 'blob_missing', document: id }));
    return 'missing';
  }

  // ---- ops-v1 (ops.ts, Home's service binding) ----------------------------------------------------------------------

  /**
   * status(): counts and codes (ops-status.ts). Its one write: an alarm when none is set (ops-v1 allows no other); the
   * few rows it reads are charged to the day's usage by the next call that writes.
   */
  async opsStatus(): Promise<opsWire.OpsStatus> {
    await this.ensureAlarm();
    return recallStatus(this.store, publicHost(this.env), this.now());
  }

  // ---- the owner API --------------------------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    await this.ensureAlarm();
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? '';
    const ctx: ApiContext = {
      store: this.store,
      bucket: this.env.STORE,
      now: this.now(),
      build: buildSha(this.env),
      transact: this.transact,
      wake: () => this.wake(),
      searches: this.searches,
    };
    const result = await api.handle(request, ctx, requestId);
    // A read answers without a transaction of its own; its rows read still count.
    this.charge();
    if (result === null) return api.errorResponse(new RpcError(REASONS.NOT_FOUND.code, 'NOT_FOUND', REASONS.NOT_FOUND.message), requestId, request.method === 'HEAD');
    if (result.error !== undefined) {
      // One line per refused request: the request ID, status and reason only (never a path, query or body).
      console.log(JSON.stringify({ request_id: requestId, status: result.response.status, reason: result.error.reason }));
    }
    return result.response;
  }

  // ---- test hooks (DEV_MANUAL_ALARMS only; never reachable over HTTP) -------------------------------------------------

  /** The clock API calls, uploads and passes read. */
  setClock(now: number): void {
    if (this.manual()) this.testClock = now;
  }

  alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** One SQL query's rows, outside the meters and the write budget. */
  sqlForTests(query: string, ...params: (string | number | null)[]): Record<string, SqlStorageValue>[] {
    if (!this.manual()) throw new Error('not_available');
    return this.store.unmetered(() => this.store.all(query, ...params));
  }

  /** The rows read and written since the last call. */
  takeRowMeter(): RowMeter {
    if (!this.manual()) throw new Error('not_available');
    return this.store.takeMeter();
  }

  /** The next upload fails after its R2 writes and before its transaction (a crash between the two). */
  failNextCommit(): void {
    if (this.manual()) this.crashBeforeCommit = true;
  }
}
