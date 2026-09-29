/** Cloudflare Access JWT verification (RS256 via WebCrypto) for every owner-host request. */
import { base64UrlDecode, decodeJsonSegment, isJsonObject, utf8, type JsonObject } from './crypto.ts';
import { csv, flag, integer, localDev, variable, type Env } from './env.ts';
import { cookieValues, HttpError, nowSeconds } from './http.ts';

const ACCESS_ISSUER = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const LOOPBACK_ISSUER = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const MAX_TOKEN_CHARS = 16_000;
const JWKS_TTL_MS = 3_600_000;
// An unknown kid refetches the certs (Access signs new tokens with a new key right after a
// rotation), at most once per this period per isolate.
const JWKS_REFRESH_COOLDOWN_MS = 60_000;
const JWKS_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_S = 60;
const MAX_ALIASES = 8;
const MAX_ALIASES_CHARS = 2048;
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

interface KeySet {
  readonly fetchedAt: number;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

/** Per-isolate cache: issuer → signing keys by kid. */
const keySets = new Map<string, KeySet>();

function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized');
}

function issuer(env: Env): string {
  const value = variable(env, 'ACCESS_ISSUER').replace(/\/+$/, '');
  if (ACCESS_ISSUER.test(value)) return value;
  if (localDev(env) && flag(env, 'DEV_ACCESS_LOOPBACK_ISSUER') && LOOPBACK_ISSUER.test(value)) {
    return value;
  }
  throw new HttpError(503, 'access_not_configured');
}

/** ACCESS_OWNER plus its verified aliases: other logins of the same person, not other users. */
function ownerEmails(env: Env, owner: string): ReadonlySet<string> {
  const aliases = csv(env, 'ACCESS_OWNER_ALIASES');
  if (variable(env, 'ACCESS_OWNER_ALIASES').length > MAX_ALIASES_CHARS || aliases.length > MAX_ALIASES) {
    throw new HttpError(503, 'access_not_configured');
  }
  return new Set([owner, ...aliases]);
}

function token(request: Request): string {
  const value =
    request.headers.get('cf-access-jwt-assertion') || cookieValues(request, 'CF_Authorization').at(-1);
  if (!value || value.length > MAX_TOKEN_CHARS) throw unauthorized();
  return value;
}

async function fetchKeys(issuerUrl: string): Promise<Map<string, CryptoKey>> {
  let body: unknown;
  try {
    const response = await fetch(`${issuerUrl}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
    });
    if (response.status !== 200) throw new Error('certs');
    body = await response.json();
  } catch {
    throw new HttpError(503, 'unavailable');
  }
  const keys = new Map<string, CryptoKey>();
  const jwks = isJsonObject(body) && Array.isArray(body.keys) ? (body.keys as unknown[]) : [];
  for (const jwk of jwks) {
    if (!isJsonObject(jwk) || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
    try {
      const key = { kty: 'RSA', n: jwk.n, e: jwk.e } as JsonWebKey;
      keys.set(jwk.kid, await crypto.subtle.importKey('jwk', key, RS256, false, ['verify']));
    } catch {
      // A key WebCrypto cannot use can never verify a token; leave it out.
    }
  }
  return keys;
}

/**
 * The CryptoKey for `kid`, or null. Cached keys are used for JWKS_TTL_MS; a kid the cache does not
 * know triggers one refetch per cooldown, so a key rotation does not lock the owner out.
 */
async function signingKey(issuerUrl: string, kid: unknown, cooldownMs: number): Promise<CryptoKey | null> {
  if (typeof kid !== 'string') return null;
  const cached = keySets.get(issuerUrl);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (age < JWKS_TTL_MS && (cached.keys.has(kid) || age < cooldownMs)) return cached.keys.get(kid) ?? null;
  }
  const keys = await fetchKeys(issuerUrl);
  keySets.set(issuerUrl, { fetchedAt: Date.now(), keys });
  return keys.get(kid) ?? null;
}

function claimsValid(claims: JsonObject, issuerUrl: string, audience: string, emails: ReadonlySet<string>): boolean {
  const now = nowSeconds();
  const audiences = Array.isArray(claims.aud) ? (claims.aud as unknown[]) : [claims.aud];
  return (
    claims.iss === issuerUrl &&
    audiences.includes(audience) &&
    typeof claims.exp === 'number' &&
    claims.exp > now &&
    typeof claims.iat === 'number' &&
    claims.iat < now + CLOCK_SKEW_S &&
    (claims.nbf === undefined || (typeof claims.nbf === 'number' && claims.nbf <= now + CLOCK_SKEW_S)) &&
    typeof claims.sub === 'string' &&
    claims.sub !== '' &&
    typeof claims.email === 'string' &&
    emails.has(claims.email.toLowerCase())
  );
}

/** ACCESS_OWNER (lowercased) for a valid Access login (an alias maps to it); otherwise throws HttpError. */
export async function authenticate(request: Request, env: Env): Promise<string> {
  const owner = variable(env, 'ACCESS_OWNER').toLowerCase();
  // Only for local dev: a request that came through Cloudflare's edge carries cf-ray.
  if (localDev(env) && flag(env, 'DEV_AUTH_BYPASS') && !request.headers.has('cf-ray')) return owner;
  const issuerUrl = issuer(env);
  const audience = variable(env, 'ACCESS_AUDIENCE');
  if (!audience || !owner) throw new HttpError(503, 'access_not_configured');
  const emails = ownerEmails(env, owner);

  const parts = token(request).split('.');
  if (parts.length !== 3) throw unauthorized();
  const [headerPart = '', payloadPart = '', signaturePart = ''] = parts;
  const header = decodeJsonSegment(headerPart);
  const claims = decodeJsonSegment(payloadPart);
  const signature = base64UrlDecode(signaturePart);
  if (!isJsonObject(header) || header.alg !== 'RS256' || !isJsonObject(claims) || signature === null) {
    throw unauthorized();
  }

  const cooldownMs = integer(env, 'JWKS_REFRESH_COOLDOWN_MS', JWKS_REFRESH_COOLDOWN_MS);
  const key = await signingKey(issuerUrl, header.kid, cooldownMs);
  const signed = utf8(`${headerPart}.${payloadPart}`);
  if (key === null || !(await crypto.subtle.verify(RS256.name, key, signature, signed))) {
    throw unauthorized();
  }
  if (!claimsValid(claims, issuerUrl, audience, emails)) throw unauthorized();
  return owner;
}
