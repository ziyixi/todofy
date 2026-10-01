/**
 * Request plumbing shared by the routes: the error envelope, Access (edge-auth) and the signed double-submit CSRF
 * plus Origin check on every mutation, and bounded JSON bodies (../../docs/design.md "Security").
 */
import { asciiLowerCase, createAccessVerifier, importHmacKeyHex, issueCsrf, verifyCsrf, type AccessPolicy } from '@ziyixi/edge-auth';
import type { ApiError, CsrfResponse } from './api-types.ts';
import type { Env } from './env.ts';

export const CSRF_COOKIE = 'flowday_csrf';
/** Request bodies: a day's flow, a note (markdown) or a settings change; nothing larger. */
export const MAX_BODY_BYTES = 256 * 1024;
export const JWKS_TTL_MS = 600_000;
export const JWKS_REFRESH_COOLDOWN_MS = 60_000;
export const NBF_LEEWAY_SECONDS = 60;

export type ApiErrorCode =
  | 'unauthorized'
  | 'access_not_configured'
  | 'not_configured'
  | 'csrf_failed'
  | 'bad_request'
  | 'not_found'
  | 'method_not_allowed'
  | 'unavailable'
  | 'no_todoist_key'
  | 'todoist_key_unreadable'
  | 'todoist_unauthorized'
  | 'todoist_unavailable';

export const MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  unauthorized: 'Not signed in, or the sign-in is no longer valid.',
  access_not_configured: 'Cloudflare Access is not fully configured.',
  not_configured: 'A required secret is not configured.',
  csrf_failed: 'The page security token expired. Reload and try again.',
  bad_request: 'The request is not valid.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  unavailable: 'The service is temporarily unavailable. Try again shortly.',
  no_todoist_key: 'No Todoist API key configured. Add one in Settings.',
  todoist_key_unreadable: 'The stored Todoist API key cannot be read. Enter it again in Settings.',
  todoist_unauthorized: 'Todoist rejected the API key. Check it in Settings.',
  todoist_unavailable: 'Todoist could not be reached. FlowDay will try again later.',
};

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /** A more specific message than MESSAGES[code] (validation details; never request data). */
  readonly detail: string | null;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, code: ApiErrorCode, detail: string | null = null, headers: Readonly<Record<string, string>> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}

export function bad(detail: string | null = null): never {
  throw new HttpError(400, 'bad_request', detail);
}

export function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, 'method_not_allowed', null, { allow });
}

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function errorResponse(requestId: string, error: HttpError): Response {
  const body: ApiError = { error: { code: error.code, message: error.detail ?? MESSAGES[error.code], request_id: requestId } };
  const response = jsonResponse(body, error.status);
  for (const [name, value] of Object.entries(error.headers)) response.headers.set(name, value);
  return response;
}

// ---- Access ------------------------------------------------------------------------------------------------------

const verifier = createAccessVerifier();

export function accessPolicy(env: Env): AccessPolicy {
  return {
    issuer: env.ACCESS_ISSUER,
    audience: env.ACCESS_AUDIENCE,
    owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: NBF_LEEWAY_SECONDS,
    tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
    jwks: { ttlMs: JWKS_TTL_MS, refreshCooldownMs: JWKS_REFRESH_COOLDOWN_MS },
    devBypass: {
      enabled: env.DEV_AUTH_BYPASS === 'true',
      hosts: 'loopback-http',
      principal: asciiLowerCase((env.ACCESS_OWNER ?? '').trim()),
      whenNotLocal: 'refuse',
    },
  };
}

export interface Principal {
  readonly owner: string;
  /** The loopback dev bypass signed the owner in (local development and the test suites only). */
  readonly bypassed: boolean;
}

export async function authenticate(request: Request, env: Env): Promise<Principal> {
  const result = await verifier.verify(request, accessPolicy(env));
  if (result.ok) return { owner: result.owner, bypassed: result.bypassed };
  switch (result.failure) {
    case 'not_configured':
    case 'dev_bypass_refused':
      throw new HttpError(503, 'access_not_configured');
    case 'keys_unavailable':
      throw new HttpError(503, 'unavailable');
    case 'missing_token':
    case 'invalid_token':
      throw new HttpError(401, 'unauthorized');
  }
}

// ---- CSRF --------------------------------------------------------------------------------------------------------

async function csrfKey(env: Env): Promise<CryptoKey> {
  const key = await importHmacKeyHex((env.CSRF_SIGNING_KEY ?? '').trim());
  if (key === null) throw new HttpError(503, 'not_configured');
  return key;
}

/** The public host's origin, plus the request's own loopback origin when the dev bypass is active. */
export function allowedOrigins(env: Env, url: URL, bypassed: boolean): string[] {
  const host = (env.PUBLIC_HOST ?? '').trim().toLowerCase();
  const origins = /^[a-z0-9.-]+$/.test(host) && host !== '' ? [`https://${host}`] : [];
  if (bypassed) origins.push(url.origin.toLowerCase());
  return origins;
}

export async function checkCsrf(request: Request, env: Env, principal: Principal): Promise<void> {
  const key = await csrfKey(env);
  const result = await verifyCsrf(request, principal.owner, {
    cookieName: CSRF_COOKIE,
    key,
    allowedOrigins: allowedOrigins(env, new URL(request.url), principal.bypassed),
  });
  if (!result.ok) throw new HttpError(403, 'csrf_failed');
}

export async function csrfResponse(request: Request, env: Env, principal: Principal): Promise<Response> {
  const key = await csrfKey(env);
  const issued = await issueCsrf(request, principal.owner, { cookieName: CSRF_COOKIE, key });
  const body: CsrfResponse = { token: issued.token };
  const response = jsonResponse(body);
  response.headers.set('set-cookie', issued.setCookie);
  return response;
}

// ---- bodies ------------------------------------------------------------------------------------------------------

/** The body's bytes, at most `limit` (a larger declared or streamed body is refused). */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  const header = request.headers.get('content-length');
  if (header !== null && !(/^[0-9]{1,10}$/.test(header.trim()) && Number(header.trim()) <= limit)) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type Body = Record<string, unknown>;

/** A JSON object body (an empty body reads as {}). */
export async function readBody(request: Request): Promise<Body> {
  const bytes = await readLimited(request, MAX_BODY_BYTES);
  if (bytes === null) bad('The request body is too large.');
  if (bytes.byteLength === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    bad('The request body is not valid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad('The request body must be a JSON object.');
  return value as Body;
}
