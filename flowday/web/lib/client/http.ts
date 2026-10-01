/**
 * The only module that calls fetch() (eslint.config.mjs forbids it anywhere else). Every request to the Worker
 * goes through here:
 *
 * - Reads (`apiGet`, `apiGetOrNull`) are same-origin, no-store, and never follow redirects.
 * - Writes (`apiSend`) also carry the CSRF token (X-CSRF-Token; the Worker sets its signed cookie when the token
 *   is fetched from /api/csrf). A `403 csrf_failed` (the 12-hour token expired in a long-lived tab or PWA window)
 *   fetches a new token and retries the write once.
 * - When the Cloudflare Access session has expired, Access answers with a redirect to its login page: the request
 *   fails as `session` (never retried) and the app shows "Reload to sign in again".
 * - A write that fails is reported to the API status store, which shows a banner; nothing is swallowed silently.
 *   The local, optimistic state is kept, so a reload after signing in loses at most that one write.
 */
import { useApiStatus } from "./api-status";

export type ApiFailureKind = "session" | "network" | "http";

export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly status: number;
  readonly code: string | null;

  constructor(kind: ApiFailureKind, status: number, code: string | null, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export type Method = "POST" | "PUT" | "PATCH" | "DELETE";

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

async function request(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store", redirect: "manual" });
  } catch {
    throw new ApiError("network", 0, null, "FlowDay could not reach the server. Check the connection and try again.");
  }
  // An Access login redirect (opaque with redirect: "manual"), or a login page served in place of JSON.
  const loginPage = !isJson(response) && (response.ok || response.status === 401 || response.status === 403);
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) || loginPage) {
    throw sessionExpired(response.status);
  }
  if (!isJson(response)) {
    throw new ApiError("http", response.status, null, `The server answered HTTP ${String(response.status)}. Try again shortly.`);
  }
  return response;
}

function sessionExpired(status: number): ApiError {
  return new ApiError("session", status, "unauthorized", "Your sign-in has expired. Reload FlowDay to sign in again.");
}

async function failure(response: Response): Promise<ApiError> {
  let code: string | null = null;
  let message = `The request failed (HTTP ${String(response.status)}).`;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Keep the generic message.
  }
  // The Worker's own 401: the Access token it received is missing or no longer valid.
  if (response.status === 401) return sessionExpired(401);
  return new ApiError("http", response.status, code, message);
}

/**
 * GET a JSON answer; throws ApiError. A session failure is always reported; other failures only with `report`
 * (a read the user asked for, such as an export).
 */
export async function apiGet<T>(path: string, options: { report?: boolean } = {}): Promise<T> {
  try {
    const response = await request(path, { method: "GET" });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError && (error.kind === "session" || options.report === true)) {
      useApiStatus.getState().report(error);
    }
    throw error;
  }
}

/** GET a JSON answer, or null on any failure (reads that the next refresh repairs). */
export async function apiGetOrNull<T>(path: string): Promise<T | null> {
  try {
    return await apiGet<T>(path);
  } catch {
    return null;
  }
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
      if (!response.ok) throw await failure(response);
      const { token } = (await response.json()) as { token: string };
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

function send(method: Method, path: string, body: unknown, refresh: boolean): Promise<Response> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const withToken = (token: string) =>
    request(path, {
      method,
      headers: { "Content-Type": "application/json", [CSRF_HEADER]: token },
      body: text,
      keepalive: (text?.length ?? 0) <= KEEPALIVE_MAX_BYTES,
    });
  // With a token at hand the request starts synchronously, so writes leave in the order they were made.
  if (!refresh && csrfToken !== null) return withToken(csrfToken);
  return csrf(refresh).then(withToken);
}

export interface SendOptions {
  /** Do not show the banner for an HTTP or network failure (automatic background calls); a session expiry still shows. */
  quiet?: boolean;
}

/** A write with CSRF; retries once with a fresh token on csrf_failed. Throws ApiError after reporting it. */
export async function apiSend<T = unknown>(method: Method, path: string, body?: unknown, options: SendOptions = {}): Promise<T> {
  try {
    let response = await send(method, path, body, false);
    if (response.status === 403) {
      const first = await failure(response.clone());
      if (first.code === "csrf_failed") response = await send(method, path, body, true);
    }
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError("network", 0, null, "The change could not be saved.");
    if (apiError.kind === "session" || options.quiet !== true) useApiStatus.getState().report(apiError);
    throw apiError;
  }
}

/** A write whose failure is already reported to the banner: true when it was saved. */
export async function apiSendOk(method: Method, path: string, body?: unknown): Promise<boolean> {
  try {
    await apiSend(method, path, body);
    return true;
  } catch {
    return false;
  }
}
