/**
 * Request plumbing shared by the routes (../../docs/design.md "Security"): Access (edge-auth), the signed
 * double-submit CSRF plus Origin check on every mutation, the CSRF token route, and the plain JSON of the transport
 * routes outside flowday.ui.v1 (/health, /api/csrf, the E2E routes). Failures are RpcErrors with the reasons of
 * ./errors.ts.
 */
import { asciiLowerCase, createAccessVerifier, importHmacKeyHex, issueCsrf, verifyCsrf, type AccessPolicy } from '@ziyixi/edge-auth';
import { RpcError } from '@ziyixi/proto/rpc-status';
import type { Env } from './env.ts';
import { flowdayError } from './errors.ts';
import { MAX_BODY_BYTES } from './limits.ts';

export const CSRF_COOKIE = 'flowday_csrf';
export const JWKS_TTL_MS = 600_000;
export const JWKS_REFRESH_COOLDOWN_MS = 60_000;
export const NBF_LEEWAY_SECONDS = 60;

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
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

/** The owner, or an RpcError: UNAUTHORIZED, ACCESS_NOT_CONFIGURED, or UNAVAILABLE when Access's keys failed. */
export async function authenticate(request: Request, env: Env): Promise<Principal> {
  const result = await verifier.verify(request, accessPolicy(env));
  if (result.ok) return { owner: result.owner, bypassed: result.bypassed };
  switch (result.failure) {
    case 'not_configured':
    case 'dev_bypass_refused':
      throw flowdayError('ACCESS_NOT_CONFIGURED');
    case 'keys_unavailable':
      throw flowdayError('UNAVAILABLE');
    case 'missing_token':
    case 'invalid_token':
      throw flowdayError('UNAUTHORIZED');
  }
}

// ---- CSRF --------------------------------------------------------------------------------------------------------

async function csrfKey(env: Env): Promise<CryptoKey> {
  const key = await importHmacKeyHex((env.CSRF_SIGNING_KEY ?? '').trim());
  if (key === null) throw flowdayError('NOT_CONFIGURED');
  return key;
}

/** The public host's origin, plus the request's own loopback origin when the dev bypass is active. */
export function allowedOrigins(env: Env, url: URL, bypassed: boolean): string[] {
  const host = (env.PUBLIC_HOST ?? '').trim().toLowerCase();
  const origins = /^[a-z0-9.-]+$/.test(host) && host !== '' ? [`https://${host}`] : [];
  if (bypassed) origins.push(url.origin.toLowerCase());
  return origins;
}

/** Refuses a mutation without this owner's CSRF token and an allowed Origin (CSRF_FAILED, or NOT_CONFIGURED). */
export async function checkCsrf(request: Request, env: Env, principal: Principal): Promise<void> {
  const key = await csrfKey(env);
  const result = await verifyCsrf(request, principal.owner, {
    cookieName: CSRF_COOKIE,
    key,
    allowedOrigins: allowedOrigins(env, new URL(request.url), principal.bypassed),
  });
  if (!result.ok) throw flowdayError('CSRF_FAILED');
}

/** GET /api/csrf: `{"token": ...}` and the signed cookie (12-hour validity). */
export async function csrfResponse(request: Request, env: Env, principal: Principal): Promise<Response> {
  const key = await csrfKey(env);
  const issued = await issueCsrf(request, principal.owner, { cookieName: CSRF_COOKIE, key });
  const response = jsonResponse({ token: issued.token });
  response.headers.set('set-cookie', issued.setCookie);
  return response;
}

// ---- bodies of the E2E routes (the owner API's bodies are read by the transcoder) --------------------------------

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

/** A JSON object body (an empty body reads as {}); BAD_REQUEST otherwise. */
export async function readBody(request: Request): Promise<Body> {
  const bytes = await readLimited(request, MAX_BODY_BYTES);
  if (bytes === null) throw flowdayError('BAD_REQUEST');
  if (bytes.byteLength === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw flowdayError('BAD_REQUEST');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw flowdayError('BAD_REQUEST');
  return value as Body;
}

/** The 405 of a transport route (/health, /api/csrf, the UI's files), with Allow. */
export function methodNotAllowed(allow: string): RpcError {
  return flowdayError('METHOD_NOT_ALLOWED', [], { allow }, 405);
}
