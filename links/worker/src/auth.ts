/**
 * The links app's adapter of packages/edge-auth (its SPEC §5.4; the dashboard's and FlowDay's parameters):
 * Cloudflare Access for the owner, and Origin plus the signed double-submit CSRF token for every mutation.
 *
 * Two places ask for the owner. Under /_/ (the launcher and its API, behind the path-scoped Access application)
 * every request must be the owner. On a short link (/<key>, outside the Access application) a request is the
 * owner only when it carries an Access token that verifies (the CF_Authorization cookie Access set for this host,
 * or the header); any failure there just makes it anonymous, so a private link answers like an unknown key.
 */
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_HEADER,
  asciiLowerCase,
  createAccessVerifier,
  importHmacKeyHex,
  readCookie,
  verifyCsrf,
  type AccessFailure,
  type AccessPolicy,
} from '@ziyixi/edge-auth';
import { publicHost, type Env } from './env.ts';

export const CSRF_COOKIE = 'links_csrf';
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

/** The owner of a request under /_/, or why not (the caller maps the failure to its answer). */
export async function authenticate(request: Request, env: Env): Promise<Authenticated> {
  const result = await verifier.verify(request, accessPolicy(env));
  return result.ok ? { ok: true, owner: result.owner, bypassed: result.bypassed } : { ok: false, failure: result.failure };
}

/** Whether a request carries an Access token at all (a non-empty header, or the cookie). */
export function hasAccessToken(request: Request): boolean {
  return (request.headers.get(ACCESS_TOKEN_HEADER) ?? '').trim() !== '' || readCookie(request, ACCESS_TOKEN_COOKIE, 'last') !== null;
}

/**
 * Whether a short-link request is the owner's: only a request with an Access token is checked (an anonymous one
 * costs no verification and no key fetch), and any failure (no such login, an expired token, the keys unavailable,
 * the Access settings incomplete) reads as anonymous. Under the local dev bypass any token counts.
 */
export async function isOwner(request: Request, env: Env): Promise<boolean> {
  if (!hasAccessToken(request)) return false;
  return (await verifier.verify(request, accessPolicy(env))).ok;
}

export async function csrfKey(env: Env): Promise<CryptoKey | null> {
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
