/**
 * Signed double-submit CSRF. `issueCsrf` mints `{kind:'csrf', owner, nonce, exp}` in the shared token
 * format; the browser keeps it in an HttpOnly SameSite=Strict cookie and repeats it in `X-CSRF-Token`
 * on every write. `verifyCsrf` requires an allowed Origin, header equal to the first cookie, a valid
 * signature, the same owner and an unexpired integer `exp`.
 *
 * The app chooses the cookie name, key source, nonce style and allowed origins, so each app's
 * existing tokens and cookies keep working. Status codes and messages stay in the app.
 */
import { base64UrlEncode, constantTimeEqual, nowSeconds } from './bytes.ts';
import { readCookie } from './cookies.ts';
import { resolveHmacKey, type HmacKey } from './keys.ts';
import { signClaims, verifySignedClaims } from './tokens.ts';

export const CSRF_HEADER = 'X-CSRF-Token';
export const CSRF_MAX_TOKEN_CHARS = 1024;
export const CSRF_DEFAULT_TTL_SECONDS = 43_200;

export interface CsrfIssuePolicy {
  /** The cookie that holds the token (`mail_hero_csrf`, `todofy_csrf`). */
  readonly cookieName: string;
  readonly key: HmacKey;
  /** Default: 16 random bytes as unpadded base64url (22 characters). */
  readonly nonce?: () => string;
  /** Default 43200 (12 hours); also the cookie's Max-Age. */
  readonly ttlSeconds?: number;
}

export interface CsrfPolicy extends CsrfIssuePolicy {
  /** Exact origins (scheme://host[:port]); compared case-insensitively. */
  readonly allowedOrigins: readonly string[];
}

export interface IssuedCsrf {
  readonly token: string;
  /** The full `Set-Cookie` value. */
  readonly setCookie: string;
}

/** `origin`: Origin not allowed. `token`: header, cookie, signature or claims. `key_unavailable`: the key function threw. */
export type CsrfFailure = 'origin' | 'token' | 'key_unavailable';
export type CsrfResult = { readonly ok: true } | { readonly ok: false; readonly failure: CsrfFailure };

// RFC 6265 cookie-name token characters.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_TTL_SECONDS = 30 * 86_400;

function cookieName(policy: CsrfIssuePolicy): string {
  if (typeof policy.cookieName !== 'string' || !COOKIE_NAME.test(policy.cookieName)) {
    throw new TypeError('edge-auth: invalid CSRF cookie name');
  }
  return policy.cookieName;
}

function ttlSeconds(policy: CsrfIssuePolicy): number {
  const ttl = policy.ttlSeconds ?? CSRF_DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new TypeError('edge-auth: invalid CSRF ttlSeconds');
  }
  return ttl;
}

function defaultNonce(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * A fresh token for `owner` and its `Set-Cookie` value (`; Secure` only for an https: request URL).
 * Throws when the key cannot be resolved (the app maps that as it does today), when the policy is
 * invalid, or if the token would exceed CSRF_MAX_TOKEN_CHARS, so it never issues a token that
 * `verifyCsrf` would refuse.
 */
export async function issueCsrf(request: Request, owner: string, policy: CsrfIssuePolicy): Promise<IssuedCsrf> {
  const name = cookieName(policy);
  const ttl = ttlSeconds(policy);
  const key = await resolveHmacKey(policy.key);
  const nonce = (policy.nonce ?? defaultNonce)();
  if (typeof owner !== 'string' || typeof nonce !== 'string') throw new TypeError('edge-auth: invalid CSRF claims');
  const token = await signClaims(key, { kind: 'csrf', owner, nonce, exp: nowSeconds() + ttl });
  if (token.length > CSRF_MAX_TOKEN_CHARS) throw new Error('edge-auth: CSRF token too long');
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return {
    token,
    setCookie: `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(ttl)}${secure}`,
  };
}

/**
 * Checks, in order: the lowercased Origin is one of `allowedOrigins`; `X-CSRF-Token` is non-empty,
 * at most 1024 characters and constant-time equal to the first cookie; the key resolves; the
 * signature is the canonical HMAC; the claims are `kind === 'csrf'`, `owner === owner` and an
 * integer `exp` after now. Throws only for an invalid cookie name (a programming error).
 */
export async function verifyCsrf(request: Request, owner: string, policy: CsrfPolicy): Promise<CsrfResult> {
  const name = cookieName(policy);
  const origin = (request.headers.get('origin') ?? '').toLowerCase();
  const allowed = policy.allowedOrigins.filter((value) => typeof value === 'string' && value !== '');
  if (origin === '' || !allowed.some((value) => value.toLowerCase() === origin)) {
    return { ok: false, failure: 'origin' };
  }

  const provided = request.headers.get(CSRF_HEADER) ?? '';
  const cookie = readCookie(request, name, 'first') ?? '';
  if (provided === '' || provided.length > CSRF_MAX_TOKEN_CHARS || !constantTimeEqual(provided, cookie)) {
    return { ok: false, failure: 'token' };
  }

  let key: CryptoKey;
  try {
    key = await resolveHmacKey(policy.key);
  } catch {
    return { ok: false, failure: 'key_unavailable' };
  }

  const claims = await verifySignedClaims(key, provided, CSRF_MAX_TOKEN_CHARS);
  if (
    claims === null ||
    claims.kind !== 'csrf' ||
    typeof owner !== 'string' ||
    claims.owner !== owner ||
    typeof claims.exp !== 'number' ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= nowSeconds()
  ) {
    return { ok: false, failure: 'token' };
  }
  return { ok: true };
}
