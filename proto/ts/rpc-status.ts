/**
 * Errors as google.rpc.Status (AIP-193) in Google's HTTP JSON form, shared by the HTTP transcoder (the
 * server, http-transcoder.ts) and the HTTP client (http-client.ts):
 *
 *   {"error": {"code": 409, "message": "...", "status": "ABORTED", "details": [
 *     {"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "ETAG_MISMATCH", "domain": "watch.ziyixi.science"},
 *     {"@type": "type.googleapis.com/google.rpc.LocalizedMessage", "locale": "zh-CN", "message": "..."},
 *     {"@type": "type.googleapis.com/google.rpc.RequestInfo", "request_id": "..."},
 *     {"@type": "type.googleapis.com/watch.ui.v1.Watch", ...the message in the wire JSON profile}]}}
 *
 * `code` is the HTTP status and `status` the google.rpc.Code name, as Google's APIs answer over HTTP. The
 * details are google.rpc messages (ErrorInfo always, RequestInfo and LocalizedMessage when given) plus any
 * message an API adds, each written in the wire JSON profile (snake_case, like the rest of the body) with
 * its `@type`. The google.rpc shapes are written here by hand: they are fixed, and this keeps their
 * descriptors out of every Worker (test/rpc-status.test.ts checks the tables against googleapis'
 * generated descriptors).
 *
 * Messages are developer-facing English (AIP-193); what the user reads is the LocalizedMessage or the UI's
 * own copy for the reason. Nothing from the request is ever echoed into an error.
 */
import type { DescMessage, JsonObject, JsonValue, MessageShape } from '@bufbuild/protobuf';
import { fromWire, toWire } from './wire-json.ts';

/** google.rpc.Code (google/rpc/code.proto). */
export const Code = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;
export type Code = (typeof Code)[keyof typeof Code];
export type CodeName = keyof typeof Code;

/** The HTTP status of each code ("HTTP Mapping" in google/rpc/code.proto). */
export const HTTP_STATUS: Readonly<Record<CodeName, number>> = {
  OK: 200,
  CANCELLED: 499,
  UNKNOWN: 500,
  INVALID_ARGUMENT: 400,
  DEADLINE_EXCEEDED: 504,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PERMISSION_DENIED: 403,
  RESOURCE_EXHAUSTED: 429,
  FAILED_PRECONDITION: 400,
  ABORTED: 409,
  OUT_OF_RANGE: 400,
  UNIMPLEMENTED: 501,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DATA_LOSS: 500,
  UNAUTHENTICATED: 401,
};

const NAMES = new Map(Object.entries(Code).map(([name, value]) => [value as number, name as CodeName]));

export function codeName(code: Code): CodeName {
  const name = NAMES.get(code);
  if (name === undefined) throw new TypeError(`not a google.rpc.Code: ${String(code)}`);
  return name;
}

export const TYPE_URL_PREFIX = 'type.googleapis.com/';
export const ERROR_INFO = 'google.rpc.ErrorInfo';
export const REQUEST_INFO = 'google.rpc.RequestInfo';
export const LOCALIZED_MESSAGE = 'google.rpc.LocalizedMessage';

/** AIP-193: an ErrorInfo reason is UPPER_SNAKE_CASE, at most 63 characters. */
const REASON = /^[A-Z][A-Z0-9_]{0,61}[A-Z0-9]$/;
/** AIP-193: the domain is the service's DNS-like name. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A typed detail an API adds to an error (written in the wire JSON profile with its `@type`). */
export interface ErrorDetail {
  readonly schema: DescMessage;
  readonly message: unknown;
}

export function errorDetail<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): ErrorDetail {
  return { schema, message };
}

export interface RpcErrorInit {
  /** ErrorInfo.metadata: codes and counts only, never request data. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Typed details after the google.rpc ones. */
  readonly details?: readonly ErrorDetail[];
  /** Extra response headers (Allow on a 405, Retry-After). */
  readonly headers?: Readonly<Record<string, string>>;
  /** The HTTP status when it is not the code's mapping (405 for a known path with another method). */
  readonly httpStatus?: number;
}

/** An error a handler (or the transcoder) answers with. */
export class RpcError extends Error {
  readonly code: Code;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly details: readonly ErrorDetail[];
  readonly headers: Readonly<Record<string, string>>;
  readonly httpStatus: number;

  constructor(code: Code, reason: string, message: string, init: RpcErrorInit = {}) {
    super(message);
    if (code === Code.OK) throw new TypeError('an RpcError cannot be OK');
    if (!REASON.test(reason)) throw new TypeError(`not an AIP-193 reason: ${reason}`);
    this.name = 'RpcError';
    this.code = code;
    this.reason = reason;
    this.metadata = init.metadata ?? {};
    this.details = init.details ?? [];
    this.headers = init.headers ?? {};
    this.httpStatus = init.httpStatus ?? HTTP_STATUS[codeName(code)];
  }
}

export interface StatusOptions {
  /** ErrorInfo.domain: the service's name, e.g. `watch.ziyixi.science`. */
  readonly domain: string;
  /** RequestInfo.request_id, when the server logs one. */
  readonly requestId?: string | undefined;
  /** The user-facing message (LocalizedMessage), when the API has one for this reason. */
  readonly localized?: { readonly locale: string; readonly message: string } | undefined;
}

/** The JSON body of `error` ({"error": {...}}); JSON.stringify gives the bytes. */
export function statusBody(error: RpcError, options: StatusOptions): JsonObject {
  if (!DOMAIN.test(options.domain)) throw new TypeError(`not a service domain: ${options.domain}`);
  const info: JsonObject = { '@type': TYPE_URL_PREFIX + ERROR_INFO, reason: error.reason, domain: options.domain };
  const metadata = Object.entries(error.metadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (metadata.length > 0) info['metadata'] = Object.fromEntries(metadata);
  const details: JsonValue[] = [info];
  if (options.localized !== undefined) {
    details.push({ '@type': TYPE_URL_PREFIX + LOCALIZED_MESSAGE, locale: options.localized.locale, message: options.localized.message });
  }
  if (options.requestId !== undefined) details.push({ '@type': TYPE_URL_PREFIX + REQUEST_INFO, request_id: options.requestId });
  for (const detail of error.details) {
    details.push({ '@type': TYPE_URL_PREFIX + detail.schema.typeName, ...toWire(detail.schema, detail.message as never) });
  }
  return { error: { code: error.httpStatus, message: error.message, status: codeName(error.code), details } };
}

/** An error body as a client reads it. Every field is optional: a proxy may answer with anything. */
export interface Status {
  /** The HTTP status of the response (not the body's copy). */
  readonly httpStatus: number;
  /** The google.rpc.Code name, e.g. `ABORTED`; undefined when the body has none this build knows. */
  readonly status: CodeName | undefined;
  readonly message: string;
  /** ErrorInfo. */
  readonly reason: string | undefined;
  readonly domain: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  /** RequestInfo.request_id. */
  readonly requestId: string | undefined;
  /** LocalizedMessage. */
  readonly localizedMessage: { readonly locale: string; readonly message: string } | undefined;
  /** Every detail as sent (`@type` included), for readDetail. */
  readonly details: readonly JsonObject[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Reads an error body; null when it is not one (an HTML page from a proxy, a login redirect's body). */
export function parseStatus(httpStatus: number, json: unknown): Status | null {
  if (!isObject(json) || !isObject(json['error'])) return null;
  const error = json['error'];
  const details = Array.isArray(error['details']) ? error['details'].filter(isObject) : [];
  const find = (type: string) => details.find((d) => d['@type'] === TYPE_URL_PREFIX + type);
  const info = find(ERROR_INFO);
  const request = find(REQUEST_INFO);
  const localized = find(LOCALIZED_MESSAGE);
  const metadata = isObject(info?.['metadata'])
    ? Object.fromEntries(Object.entries(info['metadata']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {};
  const status = text(error['status']);
  const localizedText = text(localized?.['message']);
  return {
    httpStatus,
    status: status !== undefined && Object.hasOwn(Code, status) ? (status as CodeName) : undefined,
    message: text(error['message']) ?? '',
    reason: text(info?.['reason']),
    domain: text(info?.['domain']),
    metadata,
    requestId: text(request?.['request_id']),
    localizedMessage: localizedText === undefined ? undefined : { locale: text(localized?.['locale']) ?? '', message: localizedText },
    details,
  };
}

/** The first detail of type `schema`, read leniently (an output); undefined when absent or unreadable. */
export function readDetail<Desc extends DescMessage>(status: Status, schema: Desc): MessageShape<Desc> | undefined {
  const found = status.details.find((d) => d['@type'] === TYPE_URL_PREFIX + schema.typeName);
  if (found === undefined) return undefined;
  const { '@type': _type, ...fields } = found;
  try {
    return fromWire(schema, fields).message;
  } catch {
    return undefined;
  }
}
