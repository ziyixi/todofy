/**
 * The watch app's adapter of packages/edge-auth (its SPEC §5.4: the dashboard's, FlowDay's and the links app's
 * parameters): Cloudflare Access for the owner on every path but /health, and Origin plus the signed double-submit
 * CSRF token (cookie `watch_csrf`) for every mutation.
 */
import { asciiLowerCase, createAccessVerifier, importHmacKeyHex, verifyCsrf, type AccessFailure, type AccessPolicy } from '@ziyixi/edge-auth';
import { publicHost, type Env } from './env.ts';

export const CSRF_COOKIE = 'watch_csrf';
export const JWKS_TTL_MS = 600_000;
export const JWKS_REFRESH_COOLDOWN_MS = 60_000;
export const NBF_LEEWAY_SECONDS = 60;

/** One verifier per isolate: it caches the issuer's signing keys (JWKS_TTL_MS). */
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

export type Authenticated = { readonly ok: true; readonly owner: string; readonly bypassed: boolean } | { readonly ok: false; readonly failure: AccessFailure };

/** The owner of a request, or why not. */
export async function authenticate(request: Request, env: Env): Promise<Authenticated> {
  const result = await verifier.verify(request, accessPolicy(env));
  return result.ok ? { ok: true, owner: result.owner, bypassed: result.bypassed } : { ok: false, failure: result.failure };
}

export function csrfKey(env: Env): Promise<CryptoKey | null> {
  return importHmacKeyHex((env.CSRF_SIGNING_KEY ?? '').trim());
}

/** The origins a mutation may come from: the public host, plus the request's own when the dev bypass let it in. */
export function allowedOrigins(env: Env, url: URL, bypassed: boolean): string[] {
  const host = publicHost(env);
  const origins = host === null ? [] : [`https://${host}`];
  if (bypassed) origins.push(url.origin.toLowerCase());
  return origins;
}

/** Whether a mutation carries the same-origin Origin and this owner's CSRF token ('no_key': the secret is missing). */
export async function checkCsrf(request: Request, env: Env, owner: string, bypassed: boolean): Promise<'ok' | 'failed' | 'no_key'> {
  const key = await csrfKey(env);
  if (key === null) return 'no_key';
  const result = await verifyCsrf(request, owner, { cookieName: CSRF_COOKIE, key, allowedOrigins: allowedOrigins(env, new URL(request.url), bypassed) });
  return result.ok ? 'ok' : 'failed';
}
