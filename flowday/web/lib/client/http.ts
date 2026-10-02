/**
 * The only module that calls fetch() (eslint.config.mjs forbids it anywhere else): the transport of FlowDay's owner
 * API client (./flowday-api.ts, the shared typed client of proto/ts/http-client.ts over flowday.ui.v1), and the
 * error handling every call shares.
 *
 * - Every request is same-origin, no-store, and never follows a redirect.
 * - Writes (every method but GET) also carry the CSRF token (X-CSRF-Token; the Worker sets its signed cookie when the
 *   token is fetched from /api/csrf). A 403 CSRF_FAILED (the 12-hour token expired in a long-lived tab or PWA window)
 *   fetches a new token and sends the write once more.
 * - When the Cloudflare Access session has expired, Access answers with a redirect to its login page: the request
 *   fails as `session` (never retried) and the app shows "Reload to sign in again".
 * - A write that fails is reported to the API status store, which shows a banner; nothing is swallowed silently. The
 *   local, optimistic state is kept, so a reload after signing in loses at most that one write.
 * - Errors are google.rpc.Status bodies: the banner shows their LocalizedMessage, and code branches on the ErrorInfo
 *   reason (ApiError.reason).
 */
import { HttpEncodeError, HttpResponseError, RpcStatusError, type HttpCall } from "@ziyixi/proto/http-client";
import { parseStatus } from "@ziyixi/proto/rpc-status";
import { useApiStatus } from "./api-status";

export type ApiFailureKind = "session" | "network" | "http";

export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly status: number;
  /** The ErrorInfo reason (flowday.ui.v1.ErrorReason or common.errors.v1.CommonReason), or null without a Status. */
  readonly reason: string | null;

  constructor(kind: ApiFailureKind, status: number, reason: string | null, message: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

const CSRF_HEADER = "X-CSRF-Token";
let csrfToken: string | null = null;
let csrfRequest: Promise<string> | null = null;

/** Sets (or, with null, forgets) the CSRF token without asking the Worker (tests). */
export function setCsrfTokenForTests(token: string | null): void {
  csrfToken = token;
  csrfRequest = null;
}

function isJson(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

function sessionExpired(status: number): ApiError {
  return new ApiError("session", status, "UNAUTHORIZED", "Your sign-in has expired. Reload FlowDay to sign in again.");
}

const NETWORK_MESSAGE = "FlowDay could not reach the server. Check the connection and try again.";

async function request(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", redirect: "manual" });
  } catch {
    throw new ApiError("network", 0, null, NETWORK_MESSAGE);
  }
  // An Access login redirect (opaque with redirect: "manual"), or a login page served in place of JSON.
  const loginPage = !isJson(response) && (response.ok || response.status === 401 || response.status === 403);
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) || loginPage) {
    throw sessionExpired(response.status);
  }
  // The Worker's own 401: the Access token it received is missing or no longer valid.
  if (response.status === 401) throw sessionExpired(401);
  return response;
}

/**
 * Fetches the CSRF token ahead of the first write (the app calls it on start), so a write made just before the page
 * unloads goes out at once instead of waiting for the token first.
 */
export function prefetchCsrf(): void {
  if (csrfToken === null) void csrf(false).catch(() => {});
}

async function csrf(refresh: boolean): Promise<string> {
  if (!refresh && csrfToken !== null) return csrfToken;
  if (refresh) csrfToken = null;
  csrfRequest ??= (async () => {
    try {
      const response = await request("/api/csrf", { method: "GET" });
      const token = response.ok && isJson(response) ? ((await response.json()) as { token?: unknown }).token : undefined;
      if (typeof token !== "string" || token === "") {
        throw new ApiError("http", response.status, null, "FlowDay could not get the page security token. Reload and try again.");
      }
      csrfToken = token;
      return token;
    } finally {
      csrfRequest = null;
    }
  })();
  return csrfRequest;
}

/** Writes this small may outlive the page (keepalive), so a save made while navigating away still arrives. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

function sendOnce(call: HttpCall, refresh: boolean): Promise<Response> {
  if (call.httpMethod === "GET") return request(call.url, { method: "GET", headers: { Accept: "application/json" } });
  const withToken = (token: string) =>
    request(call.url, {
      method: call.httpMethod,
      headers: { Accept: "application/json", ...(call.body === undefined ? {} : { "Content-Type": "application/json" }), [CSRF_HEADER]: token },
      body: call.body,
      keepalive: (call.body?.length ?? 0) <= KEEPALIVE_MAX_BYTES,
    });
  // With a token at hand the request starts synchronously, so writes leave in the order they were made.
  if (!refresh && csrfToken !== null) return withToken(csrfToken);
  return csrf(refresh).then(withToken);
}

/** The transport of the typed client: one retry with a fresh token when a write's token was refused (CSRF_FAILED). */
export async function send(call: HttpCall): Promise<Response> {
  const response = await sendOnce(call, false);
  if (response.status !== 403 || call.httpMethod === "GET") return response;
  let reason: string | undefined;
  try {
    reason = parseStatus(403, await response.clone().json())?.reason;
  } catch {
    // Not a Status: answer it as it is.
  }
  return reason === "CSRF_FAILED" ? sendOnce(call, true) : response;
}

/** Any failure of a call as an ApiError (with the message the banner shows). */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof RpcStatusError) {
    const { status } = error;
    const message = status.localizedMessage?.message ?? `The request failed (HTTP ${String(status.httpStatus)}).`;
    return new ApiError("http", status.httpStatus, status.reason ?? null, message);
  }
  // Nothing was sent: the same input fails the same way.
  if (error instanceof HttpEncodeError) return new ApiError("http", 400, "BAD_REQUEST", "The request is not valid.");
  if (error instanceof HttpResponseError) {
    return new ApiError("http", error.httpStatus, null, `The server answered HTTP ${String(error.httpStatus)}. Try again shortly.`);
  }
  return new ApiError("network", 0, null, "The change could not be saved.");
}

export interface ReadOptions {
  /** Show any failure on the banner (a read the user asked for, such as an export); a session expiry always shows. */
  report?: boolean;
}

/** A read: its answer, or an ApiError thrown after the banner shows a session expiry (or, with `report`, any failure). */
export async function read<T>(run: () => Promise<T>, options: ReadOptions = {}): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.kind === "session" || options.report === true) useApiStatus.getState().report(apiError);
    throw apiError;
  }
}

/** A read whose failure the next refresh repairs: its answer, or null on any failure (a session expiry still shows). */
export async function readOrNull<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await read(run);
  } catch {
    return null;
  }
}

export interface WriteOptions {
  /** Do not show the banner for an HTTP or network failure (automatic background calls); a session expiry still shows. */
  quiet?: boolean;
}

/** A write: its answer, or an ApiError thrown after the banner shows it. */
export async function write<T>(run: () => Promise<T>, options: WriteOptions = {}): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.kind === "session" || options.quiet !== true) useApiStatus.getState().report(apiError);
    throw apiError;
  }
}

/** A write whose failure the banner already shows: true when it was saved. */
export async function writeOk(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await write(run);
    return true;
  } catch {
    return false;
  }
}
