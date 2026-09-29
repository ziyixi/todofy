/**
 * @ziyixi/edge-auth: the auth code compiled into every Worker in this repository (SPEC.md).
 * Web Crypto only; no runtime dependencies; never reads env, logs or builds response bodies.
 */
export {
  ACCESS_MAX_ALIASES,
  ACCESS_MAX_ALIASES_CHARS,
  ACCESS_MAX_TOKEN_CHARS,
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_HEADER,
  asciiLowerCase,
  createAccessVerifier,
  type AccessFailure,
  type AccessPolicy,
  type AccessResult,
  type AccessVerifier,
  type AccessVerifierOptions,
  type DevBypassPolicy,
} from './access.ts';
export {
  CSRF_DEFAULT_TTL_SECONDS,
  CSRF_HEADER,
  CSRF_MAX_TOKEN_CHARS,
  issueCsrf,
  verifyCsrf,
  type CsrfFailure,
  type CsrfIssuePolicy,
  type CsrfPolicy,
  type CsrfResult,
  type IssuedCsrf,
} from './csrf.ts';
export { SIGNED_TOKEN_MAX_CHARS, signClaims, verifySignedClaims } from './tokens.ts';
export { deriveHmacKeyHkdf, importHmacKeyHex, type HmacKey } from './keys.ts';
export { STRICT_CSP, privateHeaders, withPrivateHeaders, type PrivateHeaderOptions } from './headers.ts';
export { readCookie } from './cookies.ts';
export { base64UrlDecode, base64UrlEncode, constantTimeEqual } from './bytes.ts';
