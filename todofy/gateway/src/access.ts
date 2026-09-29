/**
 * Cloudflare Access for every owner-host request, verified by the shared `@ziyixi/edge-auth`
 * package (packages/edge-auth, SPEC.md). This file only supplies Todofy's policy values and maps
 * the package's failure reasons to Todofy's error codes.
 */
import { createAccessVerifier, type AccessPolicy } from '@ziyixi/edge-auth';
import { flag, integer, localDev, variable, type Env } from './env.ts';
import { HttpError } from './http.ts';

// Cached signing keys are used for an hour.
const JWKS_TTL_MS = 3_600_000;
// An unknown kid refetches the certs (Access signs new tokens with a new key right after a
// rotation), at most once per this period per isolate.
const JWKS_REFRESH_COOLDOWN_MS = 60_000;
// Access may be a little ahead of this isolate's clock.
const NBF_LEEWAY_S = 60;

/** One verifier per isolate: it owns the per-issuer key cache. */
const verifier = createAccessVerifier();

function policy(env: Env): AccessPolicy {
  const local = localDev(env);
  return {
    issuer: env.ACCESS_ISSUER,
    audience: env.ACCESS_AUDIENCE,
    owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: NBF_LEEWAY_S,
    // The header Access injects; without it (or when it is empty) the last CF_Authorization cookie.
    tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
    jwks: {
      ttlMs: JWKS_TTL_MS,
      // A cooldown at or above the TTL behaves exactly like the TTL, so any larger value is capped.
      refreshCooldownMs: Math.min(integer(env, 'JWKS_REFRESH_COOLDOWN_MS', JWKS_REFRESH_COOLDOWN_MS), JWKS_TTL_MS),
    },
    loopbackIssuer: local && flag(env, 'DEV_ACCESS_LOOPBACK_ISSUER'),
    // Only for local dev (a *.localhost public host); a request that came through Cloudflare's
    // edge carries cf-ray and is verified normally.
    devBypass: {
      enabled: local && flag(env, 'DEV_AUTH_BYPASS'),
      hosts: 'dot-localhost',
      principal: variable(env, 'ACCESS_OWNER').toLowerCase(),
      whenNotLocal: 'verify',
    },
  };
}

/** ACCESS_OWNER (lowercased) for a valid Access login (an alias maps to it); otherwise throws HttpError. */
export async function authenticate(request: Request, env: Env): Promise<string> {
  const result = await verifier.verify(request, policy(env));
  if (result.ok) return result.owner;
  switch (result.failure) {
    case 'keys_unavailable':
      throw new HttpError(503, 'unavailable');
    case 'not_configured':
      throw new HttpError(503, 'access_not_configured');
    // dev_bypass_refused cannot occur with whenNotLocal 'verify'; missing and invalid tokens alike.
    case 'dev_bypass_refused':
    case 'missing_token':
    case 'invalid_token':
      throw new HttpError(401, 'unauthorized');
  }
}
