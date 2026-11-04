import { RpcError } from '@ziyixi/proto/rpc-status';
import { UsageCount_Operation, UsageCount_OperationSchema, UsageCount_Outcome, UsageCount_OutcomeSchema } from '@ziyixi/proto/storage/ui/v1/overview_pb';
import { wireEnum, type WireName } from '@ziyixi/proto/wire-json';
import type { Failure, Store, UsageCell } from './store.ts';

export type Operation = WireName<typeof UsageCount_Operation>;
export type Outcome = WireName<typeof UsageCount_Outcome>;
export const OPERATIONS = wireEnum(UsageCount_OperationSchema, UsageCount_Operation);
export const OUTCOMES = wireEnum(UsageCount_OutcomeSchema, UsageCount_Outcome);

/** The first counted request after a flush schedules the next one this much later: at most 2,880 a UTC day. */
export const FLUSH_DELAY_MS = 30_000;
export const DAY_MS = 86_400_000;
const KEEP_DAYS = 90;
const FAILURE_INTERVAL_MS = 60_000;

export const utcDay = (time: number): string => new Date(time).toISOString().slice(0, 10);

export interface Amounts {
  readonly objects?: number;
  readonly uploadBytes?: number;
  readonly downloadBytes?: number;
}

/** Absent objects and create conflicts are ordinary answers; 429 is a rate limit; anything else failed. */
export function outcomeOf(error: unknown): Outcome {
  if (error instanceof RpcError) {
    if (error.reason === 'NOT_FOUND') return 'not_found';
    if (error.reason === 'REVISION_CONFLICT') return 'conflict';
    if (error.httpStatus === 429) return 'rate_limited';
  }
  return 'failed';
}

/** Request counters kept in memory between flushes; the request path never touches SQLite. */
export class Usage {
  private cells = new Map<string, UsageCell>();
  private lastUse = new Map<string, number>();
  private failures: Failure[] = [];
  private readonly failureSeen = new Map<string, number>();
  private success = 0;
  private prunedDay = '';

  /** Every counted request adds to a cell, so cells alone tell whether anything is pending. */
  get dirty(): boolean { return this.cells.size > 0; }

  succeeded(client: string, operation: Operation, amounts: Amounts = {}, now = Date.now()): void {
    this.count(client, operation, 'ok', amounts, now);
  }

  failed(client: string, operation: Operation, error: unknown, now = Date.now()): void {
    const outcome = outcomeOf(error);
    this.count(client, operation, outcome, {}, now);
    if (outcome === 'not_found' || outcome === 'conflict') return;
    // Like the provider error row, one entry a minute for each credential, operation and reason.
    const reason = error instanceof RpcError ? error.reason : 'INTERNAL';
    const seen = client + '|' + operation + '|' + reason;
    if (now - (this.failureSeen.get(seen) ?? 0) < FAILURE_INTERVAL_MS) return;
    this.failureSeen.set(seen, now);
    const retryAfter = error instanceof RpcError ? Number(error.headers['retry-after'] ?? 0) : 0;
    this.failures.push({
      time: now, client_id: client, operation, reason,
      http_status: error instanceof RpcError ? error.httpStatus : 500, retry_after: Number.isSafeInteger(retryAfter) ? retryAfter : 0,
    });
  }

  private count(client: string, operation: Operation, outcome: Outcome, amounts: Amounts, now: number): void {
    const day = utcDay(now);
    const key = day + '|' + client + '|' + operation + '|' + outcome;
    let cell = this.cells.get(key);
    if (cell === undefined) {
      cell = { day, client_id: client, operation, outcome, requests: 0, objects: 0, upload_bytes: 0, download_bytes: 0, max_batch: 0 };
      this.cells.set(key, cell);
    }
    cell.requests++;
    cell.objects += amounts.objects ?? 0;
    cell.upload_bytes += amounts.uploadBytes ?? 0;
    cell.download_bytes += amounts.downloadBytes ?? 0;
    if (operation === 'batch_create') cell.max_batch = Math.max(cell.max_batch, amounts.objects ?? 0);
    this.lastUse.set(client, now);
    if (outcome === 'ok' || outcome === 'not_found' || outcome === 'conflict') this.success = now;
  }

  /** Writes every pending count in one transaction, then forgets them; a failed write keeps them for the next flush. */
  flush(store: Store, transaction: (write: () => void) => void, now = Date.now()): void {
    if (!this.dirty) return;
    const today = utcDay(now);
    const pruneBefore = this.prunedDay === today ? '' : utcDay(now - KEEP_DAYS * DAY_MS);
    transaction(() => {
      store.addUsage({ cells: [...this.cells.values()], lastUse: this.lastUse, failures: this.failures, success: this.success, pruneBefore });
    });
    this.prunedDay = today;
    this.cells = new Map();
    this.lastUse = new Map();
    this.failures = [];
    this.success = 0;
    for (const [seen, time] of this.failureSeen) if (now - time >= FAILURE_INTERVAL_MS) this.failureSeen.delete(seen);
  }
}
