/**
 * Cloudflare Access JWT verification: RS256 only, via Web Crypto, with the issuer's signing keys
 * fetched from `<issuer>/cdn-cgi/access/certs` and cached per verifier (one per isolate).
 *
 * `verify` never throws. It returns the canonical owner, or a typed failure the app maps to its own
 * status, code and message. Every behaviour an app can observe is a policy parameter (SPEC.md §4);
 * everything else is the stricter of the two apps' former rules.
 */
import { base64UrlDecode, decodeJsonSegment, isJsonObject, nowSeconds, utf8, type JsonObject } from './bytes.ts';
import { readCookie } from './cookies.ts';

export type AccessFailure =
  /** issuer, audience, owner, aliases or a numeric policy value invalid (checked before the token) */
  | 'not_configured'
  /** devBypass.enabled, the request is not local, and whenNotLocal is 'refuse' */
  | 'dev_bypass_refused'
  /** no token, an empty token, or one longer than ACCESS_MAX_TOKEN_CHARS */
  | 'missing_token'
  /** shape, header, unknown kid, signature, claims, or not the owner */
  | 'invalid_token'
  /** the certs fetch failed: network error, timeout, a status other than 200, or a body that is not JSON */
  | 'keys_unavailable';

export type AccessResult =
  | { readonly ok: true; readonly owner: string; readonly bypassed: boolean }
  | { readonly ok: false; readonly failure: AccessFailure };

export interface DevBypassPolicy {
  /** The app's own flag rule (for example DEV_AUTH_BYPASS === 'true'). */
  readonly enabled: boolean;
  /**
   * `loopback-http`: an http: request URL whose hostname is localhost, 127.0.0.1 or [::1].
   * `dot-localhost`: a request URL hostname ending in `.localhost` (any scheme).
   * Either way, a request carrying `cf-ray` (it came through Cloudflare's edge) is never local.
   */
  readonly hosts: 'loopback-http' | 'dot-localhost';
  /** The owner returned for a bypassed request. */
  readonly principal: string;
  /** Enabled but not local: refuse with `dev_bypass_refused`, or fall through to normal verification. */
  readonly whenNotLocal: 'refuse' | 'verify';
}

export interface AccessPolicy {
  /** Raw configuration values; the package trims and validates them and fails closed. */
  readonly issuer: string | undefined;
  readonly audience: string | undefined;
  readonly owner: string | undefined;
  /** Comma-separated verified logins of the same owner; each maps to the canonical owner. */
  readonly aliases: string | undefined;
  /** `exact`: case-sensitive, owner kept as configured. `case-insensitive`: owner and aliases lowercased. */
  readonly emailMatch: 'exact' | 'case-insensitive';
  /** Tolerance for `nbf` in the future, 0–300 seconds. */
  readonly nbfLeewaySeconds: number;
  readonly tokenSource: {
    /** A present but empty header: `missing`, or fall back to the cookie (`use-cookie`). */
    readonly emptyHeader: 'missing' | 'use-cookie';
    /** Which CF_Authorization cookie to use when several are sent. */
    readonly cookie: 'first' | 'last';
  };
  /** Key cache: max age (default 600,000 ms) and the minimum age before an unknown kid refetches (default 60,000 ms). */
  readonly jwks?: { readonly ttlMs?: number; readonly refreshCooldownMs?: number };
  /** Also accept `http://127.0.0.1:<port>` as the issuer (local runtime tests only). */
  readonly loopbackIssuer?: boolean;
  readonly devBypass?: DevBypassPolicy;
}

export interface AccessVerifier {
  verify(request: Request, policy: AccessPolicy): Promise<AccessResult>;
}

export interface AccessVerifierOptions {
  /** Default: `globalThis.fetch`, looked up at call time (tests may stub it after import). */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export const ACCESS_MAX_TOKEN_CHARS = 16_000;
export const ACCESS_MAX_ALIASES = 8;
export const ACCESS_MAX_ALIASES_CHARS = 2048;
export const ACCESS_TOKEN_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_TOKEN_COOKIE = 'CF_Authorization';

const ACCESS_ISSUER = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const LOOPBACK_ISSUER = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const IAT_SKEW_SECONDS = 60;
const MAX_NBF_LEEWAY_SECONDS = 300;
const MAX_JWKS_MS = 86_400_000;
const DEFAULT_TTL_MS = 600_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const CERTS_TIMEOUT_MS = 5_000;
const MAX_CERTS_CHARS = 1_000_000;
/** Only the first members of `keys` are considered (Access publishes two or three). */
const MAX_JWKS_MEMBERS = 16;
const MIN_MODULUS_BITS = 2048;
const MAX_CACHED_ISSUERS = 8;

interface Config {
  readonly issuer: string;
  readonly audience: string;
  readonly owner: string;
  readonly emails: ReadonlySet<string>;
  readonly caseInsensitive: boolean;
  readonly nbfLeeway: number;
  readonly ttlMs: number;
  readonly cooldownMs: number;
}

interface KeySet {
  readonly fetchedAt: number;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

const fail = (failure: AccessFailure): AccessResult => ({ ok: false, failure });

function requestUrl(request: Request): URL | null {
  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

/** The package's own invariant, whatever the app's flag says. */
function isLocal(request: Request, hosts: DevBypassPolicy['hosts']): boolean {
  if (request.headers.has('cf-ray')) return false;
  const url = requestUrl(request);
  if (url === null) return false;
  if (hosts === 'loopback-http') return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (hosts === 'dot-localhost') return url.hostname.endsWith('.localhost') && url.hostname.length > '.localhost'.length;
  return false;
}

function inRange(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normaliseConfig(policy: AccessPolicy): Config | null {
  const caseInsensitive = policy.emailMatch === 'case-insensitive';
  if (!caseInsensitive && policy.emailMatch !== 'exact') return null;
  const fold = (email: string): string => (caseInsensitive ? email.toLowerCase() : email);

  const issuer = trimmed(policy.issuer).replace(/\/+$/, '');
  if (!ACCESS_ISSUER.test(issuer) && !(policy.loopbackIssuer === true && LOOPBACK_ISSUER.test(issuer))) return null;

  const audience = trimmed(policy.audience);
  const owner = fold(trimmed(policy.owner));
  if (audience === '' || !EMAIL.test(owner)) return null;

  const rawAliases = trimmed(policy.aliases);
  if (rawAliases.length > ACCESS_MAX_ALIASES_CHARS) return null;
  const aliases = rawAliases
    .split(',')
    .map((alias) => fold(alias.trim()))
    .filter((alias) => alias !== '');
  if (aliases.length > ACCESS_MAX_ALIASES || !aliases.every((alias) => EMAIL.test(alias))) return null;

  const ttlMs = policy.jwks?.ttlMs ?? DEFAULT_TTL_MS;
  const cooldownMs = policy.jwks?.refreshCooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (!inRange(policy.nbfLeewaySeconds, MAX_NBF_LEEWAY_SECONDS) || !inRange(ttlMs, MAX_JWKS_MS) || !inRange(cooldownMs, MAX_JWKS_MS)) {
    return null;
  }
  const { emptyHeader, cookie } = policy.tokenSource ?? {};
  if ((emptyHeader !== 'missing' && emptyHeader !== 'use-cookie') || (cookie !== 'first' && cookie !== 'last')) return null;

  return {
    issuer,
    audience,
    owner,
    emails: new Set([owner, ...aliases]),
    caseInsensitive,
    nbfLeeway: policy.nbfLeewaySeconds,
    ttlMs,
    cooldownMs,
  };
}

function readToken(request: Request, source: AccessPolicy['tokenSource']): string | null {
  const header = request.headers.get(ACCESS_TOKEN_HEADER);
  const token =
    header !== null && (header !== '' || source.emptyHeader === 'missing')
      ? header
      : readCookie(request, ACCESS_TOKEN_COOKIE, source.cookie);
  if (!token || token.length > ACCESS_MAX_TOKEN_CHARS) return null;
  return token;
}

interface ParsedToken {
  readonly kid: string;
  readonly claims: JsonObject;
  readonly signature: Uint8Array<ArrayBuffer>;
  readonly signed: Uint8Array<ArrayBuffer>;
}

function parseToken(token: string): ParsedToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart = '', payloadPart = '', signaturePart = ''] = parts;
  const header = decodeJsonSegment(headerPart);
  const claims = decodeJsonSegment(payloadPart);
  const signature = base64UrlDecode(signaturePart);
  if (!isJsonObject(header) || !isJsonObject(claims) || signature === null) return null;
  // RS256 is the only algorithm; no `crit` extension is understood, so any `crit` is refused.
  if (header.alg !== 'RS256' || Object.hasOwn(header, 'crit')) return null;
  if (typeof header.kid !== 'string' || header.kid === '') return null;
  return { kid: header.kid, claims, signature, signed: utf8(`${headerPart}.${payloadPart}`) };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function claimsValid(claims: JsonObject, config: Config): boolean {
  const now = nowSeconds();
  const { aud, exp, iat, nbf, sub, email } = claims;
  const audienceOk = typeof aud === 'string' ? aud === config.audience : Array.isArray(aud) && aud.includes(config.audience);
  return (
    claims.iss === config.issuer &&
    audienceOk &&
    finite(exp) &&
    exp > now &&
    finite(iat) &&
    iat < now + IAT_SKEW_SECONDS &&
    (!Object.hasOwn(claims, 'nbf') || (finite(nbf) && nbf <= now + config.nbfLeeway)) &&
    typeof sub === 'string' &&
    sub !== '' &&
    typeof email === 'string' &&
    config.emails.has(config.caseInsensitive ? email.toLowerCase() : email)
  );
}

/** A JWK member that may be imported: RSA, a kid, and nothing restricting it away from RS256 verification. */
function usableJwk(jwk: JsonObject): jwk is JsonObject & { kid: string; n: string; e: string } {
  const ops = jwk.key_ops;
  return (
    jwk.kty === 'RSA' &&
    typeof jwk.kid === 'string' &&
    jwk.kid !== '' &&
    (jwk.use === undefined || jwk.use === 'sig') &&
    (jwk.alg === undefined || jwk.alg === 'RS256') &&
    (ops === undefined || (Array.isArray(ops) && ops.includes('verify'))) &&
    typeof jwk.n === 'string' &&
    typeof jwk.e === 'string'
  );
}

async function importJwk(jwk: { n: string; e: string }): Promise<CryptoKey | null> {
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e }, RS256, false, ['verify']);
    const bits = (key.algorithm as { modulusLength?: unknown }).modulusLength;
    return typeof bits === 'number' && bits >= MIN_MODULUS_BITS ? key : null;
  } catch {
    return null;
  }
}

/** The usable keys of a certs document. A kid listed more than once is dropped entirely (fail closed). */
async function keysFromCerts(body: unknown): Promise<Map<string, CryptoKey>> {
  const members = isJsonObject(body) && Array.isArray(body.keys) ? (body.keys as unknown[]).slice(0, MAX_JWKS_MEMBERS) : [];
  const counts = new Map<string, number>();
  for (const member of members) {
    if (isJsonObject(member) && typeof member.kid === 'string') counts.set(member.kid, (counts.get(member.kid) ?? 0) + 1);
  }
  const keys = new Map<string, CryptoKey>();
  for (const member of members) {
    if (!isJsonObject(member) || !usableJwk(member) || counts.get(member.kid) !== 1) continue;
    const key = await importJwk(member);
    if (key !== null) keys.set(member.kid, key);
  }
  return keys;
}

/** A verifier with its own key cache. Create one per app module (per isolate), not per request. */
export function createAccessVerifier(options: AccessVerifierOptions = {}): AccessVerifier {
  const cache = new Map<string, KeySet>();
  const inflight = new Map<string, Promise<KeySet | null>>();

  async function download(issuer: string): Promise<KeySet | null> {
    let body: unknown;
    try {
      const fetcher = options.fetch ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
      const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(CERTS_TIMEOUT_MS),
      });
      if (response.status !== 200) return null;
      const text = await response.text();
      if (text.length > MAX_CERTS_CHARS) return null;
      body = JSON.parse(text);
    } catch {
      return null;
    }
    const set: KeySet = { fetchedAt: Date.now(), keys: await keysFromCerts(body) };
    if (!cache.has(issuer) && cache.size >= MAX_CACHED_ISSUERS) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(issuer, set);
    return set;
  }

  /** One certs request per issuer at a time; concurrent callers share its result. */
  function refresh(issuer: string): Promise<KeySet | null> {
    const pending = inflight.get(issuer);
    if (pending) return pending;
    const request = download(issuer).finally(() => inflight.delete(issuer));
    inflight.set(issuer, request);
    return request;
  }

  /** The key for `kid`, null for an unknown kid, or 'unavailable' when the certs could not be fetched. */
  async function signingKey(config: Config, kid: string): Promise<CryptoKey | null | 'unavailable'> {
    const cached = cache.get(config.issuer);
    if (cached) {
      const age = Date.now() - cached.fetchedAt;
      if (age < config.ttlMs && (cached.keys.has(kid) || age < config.cooldownMs)) return cached.keys.get(kid) ?? null;
    }
    const fresh = await refresh(config.issuer);
    if (fresh === null) return 'unavailable';
    return fresh.keys.get(kid) ?? null;
  }

  async function verify(request: Request, policy: AccessPolicy): Promise<AccessResult> {
    const bypass = (policy as AccessPolicy | null | undefined)?.devBypass;
    if (bypass?.enabled === true) {
      if (isLocal(request, bypass.hosts)) {
        return typeof bypass.principal === 'string' ? { ok: true, owner: bypass.principal, bypassed: true } : fail('not_configured');
      }
      if (bypass.whenNotLocal !== 'verify') return fail('dev_bypass_refused');
    }

    let config: Config | null;
    try {
      config = normaliseConfig(policy);
    } catch {
      config = null;
    }
    if (config === null) return fail('not_configured');

    const token = readToken(request, policy.tokenSource);
    if (token === null) return fail('missing_token');
    const parsed = parseToken(token);
    if (parsed === null) return fail('invalid_token');

    const key = await signingKey(config, parsed.kid);
    if (key === 'unavailable') return fail('keys_unavailable');
    if (key === null) return fail('invalid_token');
    let valid: boolean;
    try {
      valid = await crypto.subtle.verify(RS256.name, key, parsed.signature, parsed.signed);
    } catch {
      valid = false;
    }
    if (!valid || !claimsValid(parsed.claims, config)) return fail('invalid_token');
    return { ok: true, owner: config.owner, bypassed: false };
  }

  return {
    async verify(request, policy) {
      try {
        return await verify(request, policy);
      } catch {
        return fail('invalid_token');
      }
    },
  };
}
