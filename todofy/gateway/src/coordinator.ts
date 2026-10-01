/**
 * The TodofyCore object in todofy-core, called over JS RPC (docs/gateway-contract.md §3).
 *
 * Nothing generates these types from the Python class: keep `Coordinator` in step with the RPC
 * methods of worker/todofy/runtime/coordinator.py and `CoreResult` with `http.Result.wire()`.
 */
import type {
  CanaryResult,
  GuardState,
  OpsErrorCode,
  OpsReportReceipt,
  TodofyStatus,
} from '../../../contracts/ops-v1/ops-v1.ts';
import type { WireObject } from '@ziyixi/proto/wire-json';
import type { Env } from './env.ts';
import { errorEnvelope, errorResponse, jsonText, type Context } from './http.ts';

const INSTANCE = 'inbox-v1';

/**
 * How the core answers a request. A Python exception reaches the gateway only as an opaque error
 * with a traceback, so every expected outcome, errors included, comes back as this value.
 */
export interface CoreResult {
  readonly status: number;
  /** The JSON text of a 200, exactly as the core serialised it; null for 204 and errors. */
  readonly body: string | null;
  /** Set exactly when status >= 400; the gateway adds the request ID to the envelope. */
  readonly error: { readonly code: string; readonly message: string } | null;
  /** Seconds until a 429 may be retried, sent as Retry-After. */
  readonly retry_after: number | null;
}

/** The core's facts for GET /api/v1/setup: whether each core secret is set, never its value. */
export interface CoreSetup {
  readonly mail_source_id: string;
  readonly configured: Readonly<Record<string, boolean>>;
}

export type ReportKind = 'summary' | 'recommendation';

/** How an ops-v1 method of the core answers (contracts/ops-v1): a value, or an OpsErrorCode. */
export type OpsAnswer<T> = { readonly ok: T; readonly error?: undefined } | { readonly error: OpsErrorCode };

/** Arguments come only from the gateway, so client headers never reach the object. */
export interface Coordinator extends Rpc.DurableObjectBranded {
  /** The Idempotency-Key header (null when absent) and the unread webhook body. */
  ingest(idempotencyKey: string | null, body: ReadableStream | null): Promise<CoreResult>;
  /** Run the alarm loop now (the cron). */
  wake(): Promise<void>;
  /** A report for a request whose Basic credential the gateway accepted; `query` has no "?". */
  newsletter(kind: ReportKind, query: string): Promise<CoreResult>;
  /** Count a failed Basic credential: 401, or 429 once the hour's failures are used up. */
  newsletter_auth_failure(): Promise<CoreResult>;
  /** One /api/v1 request for the canonical Access owner; the core checks the declared length. */
  owner_api(
    owner: string,
    method: string,
    path: string,
    query: string,
    contentLength: string | null,
    body: ReadableStream | null,
  ): Promise<CoreResult>;
  setup(): Promise<CoreSetup>;
  // ops-v1 (the Ops entrypoint, src/ops.ts). Structured inputs travel as JSON text.
  ops_status(): Promise<OpsAnswer<TodofyStatus>>;
  ops_set_guard(input: string): Promise<OpsAnswer<GuardState>>;
  ops_canary_result(eventId: string): Promise<OpsAnswer<CanaryResult>>;
  ops_report(report: string): Promise<OpsAnswer<OpsReportReceipt>>;
  // task-intent-v1 (the same Ops entrypoint): a TaskIntent / TaskIntentRef as JSON text; the answer is a
  // TaskIntentResult in wire JSON (worker/todofy/core/intents.py writes it with the wire JSON profile).
  task_intent_propose(intent: string): Promise<OpsAnswer<WireObject>>;
  task_intent_status(ref: string): Promise<OpsAnswer<WireObject>>;
}

export function coordinator(env: Env): DurableObjectStub<Coordinator> {
  return env.COORDINATOR.getByName(INSTANCE);
}

function toResponse(requestId: string, result: CoreResult): Response {
  const headers: Record<string, string> =
    result.retry_after === null ? {} : { 'retry-after': String(result.retry_after) };
  if (result.error !== null) {
    return errorEnvelope(requestId, result.status, result.error.code, result.error.message, headers);
  }
  return result.body === null ? new Response(null, { status: result.status }) : jsonText(result.body, result.status);
}

/** One core call as an HTTP response; a failed call (stub down, Python exception) is 503 `unavailable`. */
export async function answer(
  ctx: Context,
  call: (core: DurableObjectStub<Coordinator>) => Promise<CoreResult>,
): Promise<Response> {
  let result: CoreResult;
  try {
    result = await call(coordinator(ctx.env));
  } catch {
    return errorResponse(ctx.requestId, 503, 'unavailable');
  }
  return toResponse(ctx.requestId, result);
}
