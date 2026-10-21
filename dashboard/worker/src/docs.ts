/**
 * The JSON documents HomeState keeps in its `state` table (docs/design.md §3, docs/design-v2.md §6),
 * with their empty values. One writer per key (HomeState); the pure view builders (views.ts,
 * evaluate.ts) read them through a Snapshot. Times are epoch milliseconds.
 */
import type { OpsReportItem, OpsReportReceipt, OpsStatus } from '@ziyixi/proto/ops/v1/ops_wire';
import type { CreateInboxTaskRequest } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_wire';
import type { AppErrorCode, QuotaRow } from './api-types.ts';
import type { ResourceUsage, UsageErrorCode } from './usage.ts';

/** `status:<entry>`: the last status() attempt of an ops_v1 entry (the entry id is its OpsApp). */
export interface StatusDoc {
  readonly checked_at: number | null;
  readonly ok: boolean | null;
  readonly error: AppErrorCode | null;
  readonly consecutive_failures: number;
  readonly status: OpsStatus | null;
  readonly status_at: number | null;
}

/** `usage`: the last GraphQL answer (quota rows and, since v2, the per-resource rows). */
export interface UsageDoc {
  readonly fetched_at: number | null;
  readonly day: string | null;
  readonly month: string | null;
  readonly rows: QuotaRow[];
  readonly unclassified_r2_operations: number;
  /** Absent in documents written before v2. */
  readonly resources?: ResourceUsage;
  readonly last_error: UsageErrorCode | null;
  readonly last_error_at: number | null;
  readonly last_http_status: number | null;
  readonly consecutive_failures: number;
  readonly last_attempt_at: number | null;
}

/** The day's task (digest.ts): `skipped` only for the first day of the release that brought it. */
export type DigestTaskState = 'skipped' | 'pending' | 'created' | 'failed';

/**
 * `digest`: the last tick's items and the day's task in Tasks. The task fields are absent in a document written
 * before 2026-10-21 (when Todofy's reminder carried the digest).
 */
export interface DigestDoc {
  readonly items: OpsReportItem[];
  /** The last UTC day handled (`YYYY-MM-DD`). */
  readonly day?: string;
  readonly state?: DigestTaskState;
  /** The frozen request while it is `pending`; null otherwise. */
  readonly request?: CreateInboxTaskRequest | null;
  /** The items the request lists and when they were frozen. */
  readonly item_count?: number;
  readonly claimed_at?: number;
  /** Calls made for the day's task. */
  readonly attempts?: number;
  readonly task_id?: string | null;
  /** When the last day's task was created, and when its items were frozen. */
  readonly last_sent_at: number | null;
  readonly last_generated_at: number | null;
  readonly last_receipt: OpsReportReceipt | null;
  readonly last_error: AppErrorCode | null;
  readonly last_attempt_at: number | null;
}

export interface MetaDoc {
  readonly last_tick_at: number | null;
  readonly last_tick_scheduled: number | null;
  /** The last v1 overview refresh that fetched. */
  readonly last_refresh_at: number | null;
  /** v2: bumped by every tick, refresh that fetched, guard override and manual canary start. */
  readonly rev?: number;
  /** v2 refresh scopes (docs/design-v2.md §5): statuses + probes, and GraphQL. */
  readonly last_refresh_home_at?: number | null;
  readonly last_refresh_cloudflare_at?: number | null;
}

/** `probe:<entry>`: the last public_http probe of an entry (status code, outcome and latency only). */
export interface ProbeDoc {
  readonly checked_at: number;
  readonly ok: boolean;
  /** Null when no response arrived (timeout, network error). */
  readonly http_status: number | null;
  readonly latency_ms: number | null;
  /**
   * `timeout`, `network_error`, `http_status` (an unexpected code), `content_type` (an expected code with
   * another media type than the registry's `content_type`), or null when ok.
   */
  readonly error: 'timeout' | 'network_error' | 'http_status' | 'content_type' | null;
  readonly consecutive_failures: number;
}

export const NO_STATUS: StatusDoc = { checked_at: null, ok: null, error: null, consecutive_failures: 0, status: null, status_at: null };
export const NO_USAGE: UsageDoc = {
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
export const NO_DIGEST: DigestDoc = {
  items: [],
  last_sent_at: null,
  last_generated_at: null,
  last_receipt: null,
  last_error: null,
  last_attempt_at: null,
};
export const NO_META: MetaDoc = { last_tick_at: null, last_tick_scheduled: null, last_refresh_at: null };
