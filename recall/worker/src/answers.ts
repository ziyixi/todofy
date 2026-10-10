/**
 * The answers of the machine routes (/api/machine/v1/*, ../../docs/design.md §2.1, §4, §7): google.rpc.Status bodies
 * in Google's HTTP JSON form, as contracts/recall-archive-v1 states (a consumer branches on the HTTP status only), with
 * reasons of their own: these routes are not part of the owner API. RecallState answers its routes as a MachineAnswer
 * (a plain object over RPC) that the Worker turns into a Response without reading it.
 */
import { Code, RpcError, statusBody } from '@ziyixi/proto/rpc-status';
import { API_DOMAIN } from './reasons.ts';

export const MACHINE_REASONS = {
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid' },
  UNAUTHORIZED: { code: Code.UNAUTHENTICATED, message: 'no valid token for this route' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such route' },
  METHOD_NOT_ALLOWED: { code: Code.UNIMPLEMENTED, message: 'this method is not allowed on this path', httpStatus: 405 },
  NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'this route has no token configured' },
  PAYLOAD_TOO_LARGE: { code: Code.INVALID_ARGUMENT, message: 'the request body is too large', httpStatus: 413 },
  UPLOAD_OVER_BUDGET: { code: Code.RESOURCE_EXHAUSTED, message: "today's write budget is used up; retry after Retry-After" },
  FEED_OVER_BUDGET: { code: Code.RESOURCE_EXHAUSTED, message: "today's read budget for the feed is used up; retry after Retry-After" },
  CURSOR_AHEAD: { code: Code.FAILED_PRECONDITION, message: 'after is above the head of the feed', httpStatus: 409 },
  CURSOR_EXPIRED: { code: Code.FAILED_PRECONDITION, message: 'after is below the oldest kept tombstone', httpStatus: 410 },
  BLOB_DELETED: { code: Code.NOT_FOUND, message: 'no live record holds this blob', httpStatus: 410 },
  BLOB_MISSING: { code: Code.DATA_LOSS, message: 'a live record holds this blob but the store has no object' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'a dependency failed; retry after Retry-After' },
  INTERNAL: { code: Code.INTERNAL, message: 'internal error' },
} as const satisfies Record<string, { code: Code; message: string; httpStatus?: number }>;

export type MachineReason = keyof typeof MACHINE_REASONS;

/** An answer of a machine route as RecallState hands it to the Worker. */
export interface MachineAnswer {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The reason of a refusal (for the Worker's log line), absent on success. */
  readonly reason?: string;
}

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;

/** A refusal: its Status body, with extra headers (Allow, Retry-After). */
export function machineError(reason: MachineReason, requestId: string, headers: Readonly<Record<string, string>> = {}): MachineAnswer {
  const entry: { code: Code; message: string; httpStatus?: number } = MACHINE_REASONS[reason];
  const error = new RpcError(entry.code, reason, entry.message, entry.httpStatus === undefined ? {} : { httpStatus: entry.httpStatus });
  return { status: error.httpStatus, body: JSON.stringify(statusBody(error, { domain: API_DOMAIN, requestId })), headers: { ...JSON_HEADERS, ...headers }, reason };
}

/** A JSON answer (200). */
export function machineJson(body: string): MachineAnswer {
  return { status: 200, body, headers: JSON_HEADERS };
}

export function toResponse(answer: MachineAnswer, head = false): Response {
  return new Response(head ? null : answer.body, { status: answer.status, headers: answer.headers });
}
