# `packages/edge-auth`: design

The auth code compiled into every Worker in this repository: the Todofy gateway, Mail Hero, the
home dashboard and the apps added after it (§5.4). This document is the design to maintain against: the rules every app gets (§2), the
formats that must never change (§3), why each difference between the apps is a parameter or was
unified (§4), the API (§5) with each app's values (§5.4), and how the package is consumed, checked and
rolled out (§6–§9). Section numbers are referenced from the apps' code and docs; keep them.

Status: implemented in `src/` with its vitest suite in `test/`, and used by every TypeScript app through
their adapters (§5.4). What has been verified in production is recorded per app (Mail Hero
`docs/verification-native.md`, Todofy `docs/verification.md`, dashboard `docs/verification.md`);
the one check that needs a real login is in §9.

## 1. Scope and form

- **Form.** `@ziyixi/edge-auth`: TypeScript source, `"type": "module"`, `"private": true`,
  `"exports": {".": "./src/index.ts"}`, no `dependencies` (Web Crypto only). It is **not** a Worker: no
  service binding, no extra hop, no deploy of its own. Each app compiles it in through a `workspace:`
  dependency (§6), so npm never asks a registry for it.
- **What it owns.** Access JWT verification (JWKS fetch and cache), same-origin JSON mutation checks, the private-response header helper, and the primitives these need: HMAC key import and
  HKDF derivation, base64url, cookie reading, a constant-time compare.
- **What stays in each app.** Its `HttpError`, error envelopes, statuses, codes and messages; gate
  order, maintenance handling and routes; its CSP string (an input); and its own credentials (Mail
  Hero's backup Bearer, AES-GCM webhook credentials, preview tokens and `actionHash`; Todofy's hooks
  Bearer and newsletter Basic). The package returns a typed failure; each app maps it (§5.4).
- **It never** reads `env`, logs, or builds a response body.
- **How differences are decided** (§4). Anything a real browser, a real Access token or a persisted
  value can observe is a **parameter**, and each app passes its own value. Everything else takes the
  **stricter** behaviour. A new rule for any app becomes a new parameter, reviewed against §4;
  changing a value an app passes changes that app's behaviour.

## 2. Security rules (every app, not parameters)

- **Algorithm.** The JWT header `alg` must be exactly `RS256`; the only keys imported are
  `RSASSA-PKCS1-v1_5`/`SHA-256` with usage `verify`, and HMAC keys never touch the JWT path, so there
  is no algorithm confusion. `kid` is a required non-empty string; any `crit` member is refused.
- **Keys.** Fetched only from `<issuer>/cdn-cgi/access/certs`, with the issuer pinned to
  `https://<team>.cloudflareaccess.com` (a loopback issuer only when the app enables it for local
  development). `redirect: 'manual'`, 5 s timeout, 200 and JSON required; body ≤ 1,000,000
  characters; at most the first 16 JWKs; RSA modulus ≥ 2048 bits; JWK filters and a duplicated `kid`
  dropped (#11, #12). No stale fallback and no negative caching.
- **Claims.** `iss` exact; `aud` equal or contained; `exp > now` (no leeway); `iat < now + 60`;
  `nbf ≤ now + leeway`; `sub` a non-empty string; numeric claims finite; `email` printable ASCII and
  equal to the owner or an alias under the app's match mode.
- **Configuration fails closed** (`not_configured`): the issuer pattern, a non-empty audience, owner
  and aliases shaped as e-mail addresses **and printable ASCII** (#36), ≤ 8 aliases, ≤ 2048
  characters, policy numbers in range.
- **Dev bypass** never applies to a request carrying `cf-ray` or to a hostname other than
  `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`.
- **Owner mutations.** Authenticate the Access JWT first. Before reading the body, require an exact
  nonempty `Origin` from the app's allow-list, a nonempty `X-CSRF-Token` header (at most 1024 characters),
  and media type `application/json` (charset parameters are allowed). Missing, `null` and foreign
  Origins fail. Clients send the fixed value `1`, including on bodyless mutations. No permissive CORS
  is added. The check uses no signing key, CSRF cookie, session token or body parsing.
- **No throw on request input.** Every decoding, import or verify exception is `invalid_token`, every
  certs-fetch exception `keys_unavailable`. `constantTimeEqual` is an XOR loop over UTF-8 bytes (only
  the length can leak) and does not use workerd's `crypto.subtle.timingSafeEqual`, which Node lacks.

## 3. Formats that must not change

### 3.1 Owner mutation compatibility

Owner JSON clients send `X-CSRF-Token: 1` directly. Authenticated compatibility GET endpoints
(`/api/csrf`, `/_/api/csrf` or `/api/tasks/csrf`; Todofy and Mail Hero serve none) may return the static value
`1` under their existing response field. They set no cookie and make no business change. Current
clients do not call them. A bounded nonempty old header remains accepted for cached clients, subject
to the same exact Origin and JSON checks; the old cookie/signature is ignored.

This deliberate keyless change supersedes the signed-CSRF rules below as of the owner's request.
Access JWT formats, Mail Hero preview/action signatures, Brief feedback signatures and encryption
keys retain their existing contracts.

### 3.2 Private headers

`withPrivateHeaders` copies the response (`new Response(body, response)`) and sets `cache-control:
no-store` (or the app's override), `x-content-type-options: nosniff`, `referrer-policy: no-referrer`,
`x-frame-options: DENY` and `content-security-policy`:

| CSP | Value |
| --- | --- |
| `STRICT_CSP` (Todofy, dashboard) | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |
| Mail Hero (its own string) | the same plus `font-src 'self'` and `frame-src 'self' about:` (its sandboxed mail HTML view) |

## 4. Decisions

The table records how the two original implementations (Mail Hero with jose 6.2.12, Todofy's own
gateway code) differed and what the package does. Verdicts: **P** = a parameter, each app passes its
own value (§5.4); **U→x** = unified to x, changed only where no real Access token, real certs response
or token the app issued could tell the difference; **App** = stays in the app.

| # | Aspect | Mail Hero (before) | Todofy (before) | Verdict and reason |
| --- | --- | --- | --- | --- |
| 1 | Email match, canonical owner | exact; case kept | case-insensitive; lowercased | **P** `emailMatch`. Observable, and the owner is persisted (Mail Hero `ui_actions.owner`, every CSRF token) |
| 2 | Dev bypass rule | `http:` + loopback names; flag elsewhere → 503 | `*.localhost`; flag elsewhere ignored | **P** `devBypass.hosts`, `devBypass.whenNotLocal`; the §2 invariant always holds |
| 3 | Bypass principal | `local-development` | lowercased owner | **P** `devBypass.principal` |
| 4 | Loopback issuer | none | `http://127.0.0.1:<port>` in local dev | **P** `loopbackIssuer` (default false) |
| 5 | `nbf` leeway | 0 s | 60 s | **P** `nbfLeewaySeconds`: 60 would weaken Mail Hero, 0 could refuse a fresh Todofy token on clock skew |
| 6 | Future `iat` | accepted | `iat < now + 60` | **U→Todofy**; Access never issues a token ≥ 60 s ahead |
| 7 | `sub` | presence only | non-empty string | **U→Todofy** |
| 8 | `kid` | optional (single-key fallback) | required | **U→Todofy**; Access tokens carry `kid`, and during a rotation the certs hold two keys anyway |
| 9 | `crit` | refused | ignored | **U→Mail Hero**; Access does not send it |
| 10 | RSA modulus | ≥ 2048 | any | **U→Mail Hero**, from `CryptoKey.algorithm.modulusLength` (present in workerd and Node) |
| 11 | JWK filter | `use`, `alg`, `key_ops`, `ext` | `kty` + `kid` | **U→Mail Hero**: `kty: RSA`, non-empty `kid`, `use` ∈ {absent, `sig`}, `alg` ∈ {absent, `RS256`}, `key_ops` absent or incl. `verify` |
| 12 | Duplicate `kid` | refused | last wins | **U→Mail Hero** (fail closed): a kid listed twice is dropped |
| 13 | Non-object in `keys` | whole set invalid | skipped | **U→Todofy**: skipped. An availability change only; no key jose refused is accepted |
| 14 | Certs redirect | refused | followed | **U→Mail Hero**: `redirect: 'manual'`; Access answers 200 directly |
| 15 | Certs failure | 401 | 503 `unavailable` | **App**: the package returns `keys_unavailable` |
| 16 | JWKS TTL / cooldown | 10 min / 30 s | 1 h / 60 s | **P** `jwks` (defaults 600,000 / 60,000). The dashboard uses 10 min; moving Todofy to 10 min changes its revocation window and belongs in its own commit |
| 17 | Token source | empty header = missing; first cookie | empty header → cookie; last cookie | **P** `tokenSource`; only reachable without the Access-injected header, but observable |
| 18 | Config normalisation | partial trim | full trim | **U→** trim everything, strip all trailing `/`, measure after trim; the deploy generators already reject any value where this differs |
| 19 | Owner/alias syntax | any non-empty | any non-empty | **U→** `^[^\s@]+@[^\s@]+\.[^\s@]+$`, else `not_configured` |
| 20 | Numeric claims | `typeof number` | same | **U→** also `Number.isFinite` |
| 21 | Failure statuses/messages | its table | its table | **App** |
| 22 | CSRF key source | HKDF from `CREDENTIAL_KEY` | raw `CSRF_SIGNING_KEY` | **Retired for CSRF.** Owner JSON mutations use no signing key; other signing/encryption uses remain unchanged. |
| 23 | CSRF key failure timing | issue 503; verify after the pre-checks → 403 | first → 503 | **Retired.** There is no CSRF key lookup or key-availability failure. |
| 24 | CSRF nonce | UUID | 16 bytes base64url | **Retired.** Clients send the fixed header value `1`. |
| 25 | CSRF cookie name | `mail_hero_csrf` | `todofy_csrf` | **Retired.** No CSRF cookie is read or issued. |
| 26 | Allowed origins | the request URL's origin | the public host (+ local dev) | **P** `allowedOrigins`, computed by the app |
| 27 | Origin case | exact | lowercased | **U→exact.** The owner authorized exact allow-listed Origin comparison for the keyless JSON API. |
| 28 | Header/cookie compare | `!==` | constant time | **Retired.** No header/cookie comparison; a nonempty custom header is required. |
| 29 | CSRF length cap | 4096 | 1024 | **U→1024.** Bound legacy header acceptance; new clients always send `1`. |
| 30 | CSRF signature check | decode + `subtle.verify` | canonical text compare | **Retired for CSRF.** General signed-claim primitives remain for their existing consumers. |
| 31 | CSRF payload decode, `exp` | lenient; fractional | fatal UTF-8; integer | **Retired for CSRF.** No CSRF claims or expiry are decoded. |
| 32 | Issue response | `Response.json` | `jsonResponse` | **App.** Compatibility routes return a static token field without `Set-Cookie`. |
| 33 | CSP | extended | strict | **P** `csp`; `STRICT_CSP` exported (§3.2) |
| 34 | Immutable asset cache | none | `/assets/` rule | **P** `cacheControl` override |
| 35 | Gate order, maintenance, 405, routes | own | own | **App** |
| 36 | Non-ASCII addresses, case folding | any characters, exact | Unicode `toLowerCase` | **U→ASCII only** (SEC-1). Owner, aliases and the token `email` must be printable ASCII (`^[\x21-\x7e]+$`); `case-insensitive` folds `A`–`Z` only (`asciiLowerCase`, exported so an app's own principal uses the same fold). Unicode lowercasing maps U+212A KELVIN SIGN to `k`, so a signed `Kate@…` matched owner `kate@…`. A non-ASCII configured owner or alias now fails closed; every deploy generator refuses one |

**Is Mail Hero weaker without jose?** No. Every jose check is kept or tightened (RS256 allow-list,
`crit`, ≥ 2048-bit keys, JWK filters, duplicate kid refused, manual redirects, required
`exp`/`iat`/`sub`/`email`, `iss`/`aud`, `nbf` and `exp` without leeway, exact email match,
fail-closed config), with additions (required `kid`, bounded future `iat`, non-empty string `sub`,
finite numbers). The one relaxation (#13) is availability on a document fetched without redirects
from the pinned issuer, not acceptance of any key jose would refuse.

## 5. API

`src/index.ts` re-exports everything. Functions are stateless except the key cache of an
`AccessVerifier`; each app creates one at module scope (one cache per isolate).

### 5.1 Access

```ts
export type AccessFailure =
  | 'not_configured'        // issuer / audience / owner / aliases / policy numbers invalid (checked before the token)
  | 'dev_bypass_refused'    // devBypass.enabled, request not local, whenNotLocal === 'refuse'
  | 'missing_token'         // no token, empty, or longer than 16,000 characters
  | 'invalid_token'         // shape, header, signature, unknown kid, claims, not the owner
  | 'keys_unavailable';     // certs: network error, timeout, non-200, body not JSON or too large

export type AccessResult =
  | { readonly ok: true; readonly owner: string; readonly bypassed: boolean }
  | { readonly ok: false; readonly failure: AccessFailure };

export interface DevBypassPolicy {
  readonly enabled: boolean;                        // the app's own flag rule
  readonly hosts: 'loopback-http' | 'dot-localhost';
  readonly principal: string;
  readonly whenNotLocal: 'refuse' | 'verify';
}

export interface AccessPolicy {
  readonly issuer: string | undefined;              // raw env values; the package normalises them
  readonly audience: string | undefined;
  readonly owner: string | undefined;
  readonly aliases: string | undefined;             // comma-separated
  readonly emailMatch: 'exact' | 'case-insensitive';
  readonly nbfLeewaySeconds: number;                // integer 0–300
  readonly tokenSource: { readonly emptyHeader: 'missing' | 'use-cookie'; readonly cookie: 'first' | 'last' };
  readonly jwks?: { readonly ttlMs?: number; readonly refreshCooldownMs?: number };  // integers 0–86,400,000
  readonly loopbackIssuer?: boolean;
  readonly devBypass?: DevBypassPolicy;
}

export function createAccessVerifier(options?: { readonly fetch?: (url: string, init: RequestInit) => Promise<Response> }): AccessVerifier;
export interface AccessVerifier { verify(request: Request, policy: AccessPolicy): Promise<AccessResult> }
export function asciiLowerCase(value: string): string;   // A–Z → a–z only (#36)
export const ACCESS_MAX_TOKEN_CHARS = 16_000, ACCESS_MAX_ALIASES = 8, ACCESS_MAX_ALIASES_CHARS = 2048;
```

`fetch` defaults to `globalThis.fetch` looked up at call time (tests stub it after import).
`verify` runs these steps and never throws:

1. **Dev bypass.** If `devBypass.enabled`, no `cf-ray`, and the host rule holds (`loopback-http`:
   `http:` and hostname `localhost`, `127.0.0.1` or `[::1]`; `dot-localhost`: hostname ends in
   `.localhost`): `{ok, owner: principal, bypassed: true}`. Enabled but not local: `refuse` →
   `dev_bypass_refused`, `verify` → continue.
2. **Config.** Issuer trimmed, trailing `/` stripped, matching `^https://[a-z0-9-]+\.cloudflareaccess\.com$`
   (or `^http://127\.0\.0\.1:\d{1,5}$` with `loopbackIssuer`); audience trimmed, non-empty; owner and
   each alias e-mail shaped and printable ASCII; aliases ≤ 2048 characters (after trim), ≤ 8 after
   split/trim/drop-empty. `case-insensitive` folds owner and aliases with `asciiLowerCase`.
3. **Token.** Header `cf-access-jwt-assertion`; if absent (or empty under `use-cookie`) the
   `CF_Authorization` cookie at the `first`/`last` occurrence. Empty or > 16,000 → `missing_token`.
4. **Parse.** Three parts; header and payload base64url (optional `=`/`==`, `[A-Za-z0-9_-]`,
   `len % 4 != 1`) decoded as fatal UTF-8 JSON objects; header `alg === 'RS256'`, non-empty `kid`, no
   `crit`.
5. **Key.** Cached per issuer (`{fetchedAt, keys}`), used while `age < ttlMs` and (`kid` known or
   `age < refreshCooldownMs`); otherwise refetched (URL passed as a string; concurrent refetches share
   one request; a failure leaves the old entry). JWKs are filtered (#11–#13) and imported from
   `{kty, n, e}`. Unknown `kid` → `invalid_token`.
6. **Signature** over the ASCII `<header>.<payload>`.
7. **Claims** as in §2; the email compared with `===` after the fold of step 2.
8. `{ok, owner: <canonical owner from step 2>, bypassed: false}`.

### 5.2 Owner mutations and signing primitives

```ts
export interface CsrfPolicy { readonly allowedOrigins: readonly string[] }
export type CsrfFailure = 'origin' | 'token' | 'content_type';
export type CsrfResult = { readonly ok: true } | { readonly ok: false; readonly failure: CsrfFailure };
export function verifyCsrf(request: Request, policy: CsrfPolicy): Promise<CsrfResult>;
export const CSRF_HEADER = 'X-CSRF-Token', CSRF_TOKEN = '1', CSRF_MAX_TOKEN_CHARS = 1024;

export type HmacKey = CryptoKey | (() => Promise<CryptoKey>);
export function signClaims(key: CryptoKey, claims: Record<string, unknown>): Promise<string>;
export function verifySignedClaims(key: CryptoKey, token: string, maxChars?: number): Promise<Record<string, unknown> | null>;
export function importHmacKeyHex(hex: string): Promise<CryptoKey | null>;
export function deriveHmacKeyHkdf(ikm: Uint8Array<ArrayBuffer>, salt: string, info: string): Promise<CryptoKey>;
```

`verifyCsrf` performs only header checks, in order: exact allowed Origin, nonempty bounded custom
header, JSON media type. It does not read the body, a cookie, an owner identity or a key. Its existing
Promise-shaped result keeps authorizer callers compatible. Access authentication is a separate,
required earlier gate. The general HMAC/signed-claim primitives retain their formats and behavior for
preview tokens, feedback and other existing consumers.

### 5.3 Headers and helpers

```ts
export const STRICT_CSP: string;
export function privateHeaders(csp?: string): Readonly<Record<string, string>>;   // the five headers, lowercase names
export function withPrivateHeaders(response: Response, options?: { readonly csp?: string; readonly cacheControl?: string }): Response;
export function readCookie(request: Request, name: string, occurrence: 'first' | 'last'): string | null;
export function constantTimeEqual(a: string, b: string): boolean;
```

Also exported: `ACCESS_TOKEN_HEADER`, `ACCESS_TOKEN_COOKIE`, `SIGNED_TOKEN_MAX_CHARS`, `CsrfResult`, `PrivateHeaderOptions`, `base64UrlEncode`, `base64UrlDecode`.
`readCookie` parses `;`-separated pairs, trims, splits at the first `=`, matches the name exactly and
ignores a pair without `=`.

### 5.4 Per-app parameters

Each app's adapter is the only place these values live: Mail Hero
`mail-hero/cloudflare/src/native/security.ts`, Todofy `todofy/gateway/src/access.ts` and `csrf.ts`
(`http.ts` for headers), the dashboard `dashboard/worker/src/http.ts`, the links app `links/worker/src/auth.ts`
(deployed since its step L2), the watch app `watch/worker/src/auth.ts` (deployed since its step W2). On a short link (outside its path-scoped Access
application) the links app verifies only a request that carries a token, and reads every failure there as anonymous;
under `/_/` it maps the failures as the table below says. The watch app verifies every path but `/health` (its whole
host is behind Access), checks CSRF in its fetch handler and forwards the owner API to its Durable Object.

| Parameter | Mail Hero | Todofy gateway | Dashboard `home` | Links `links` | Watch `watch` |
| --- | --- | --- | --- | --- | --- |
| `emailMatch` | `exact` | `case-insensitive` | `case-insensitive` | `case-insensitive` | `case-insensitive` |
| `nbfLeewaySeconds` | 0 | 60 | 60 | 60 | 60 |
| `tokenSource` | `missing`, `first` | `use-cookie`, `last` | `use-cookie`, `last` | `use-cookie`, `last` | `use-cookie`, `last` |
| `jwks` TTL / cooldown | 600,000 / 30,000 ms | 3,600,000 / 60,000 ms (cooldown from `JWKS_REFRESH_COOLDOWN_MS`, capped at the TTL) | 600,000 / 60,000 ms | 600,000 / 60,000 ms | 600,000 / 60,000 ms |
| `loopbackIssuer` | – | local dev + `DEV_ACCESS_LOOPBACK_ISSUER` | – | – | – |
| `devBypass` | `DEV_AUTH_BYPASS === 'true'`, `loopback-http`, principal `local-development`, `refuse` | local dev (`*.localhost` public host) + `DEV_AUTH_BYPASS`, `dot-localhost`, `asciiLowerCase(owner)`, `verify` | `DEV_AUTH_BYPASS === 'true'`, `loopback-http`, `asciiLowerCase(owner)`, `refuse` | same as the dashboard (`DEV_AUTH_BYPASS`; a short link only when it carries a token) | same as the dashboard |
| `allowedOrigins` | `[new URL(request.url).origin]` | `https://<TODOFY_PUBLIC_HOST>` (+ the request origin in local dev) | `https://<PUBLIC_HOST>` (+ the request origin when bypassed) | same as the dashboard | same as the dashboard |
| CSP / cache | Mail Hero CSP; always `no-store` | `STRICT_CSP`; immutable for a 200 non-HTML `ASSETS` answer under `/assets/` | same as Todofy | `STRICT_CSP`; `private, no-store` on every answer (the launcher files under `/_/assets/` bypass the Worker, `_headers`) | same as Todofy (the UI under `/assets/`) |

Failure mapping (each app's own codes and messages):

| Failure | Mail Hero | Todofy | Dashboard | Links | Watch |
| --- | --- | --- | --- | --- | --- |
| `not_configured` | 503 `access_not_configured` | 503 `access_not_configured` | 503 `access_not_configured` | 503 `access_not_configured` | 503 `access_not_configured` |
| `dev_bypass_refused` | 503 `invalid_auth_configuration` | (cannot occur) | 503 `access_not_configured` | 503 `access_not_configured` | 503 `access_not_configured` |
| `missing_token` | 401 `unauthorized` "需要通过 Cloudflare Access 登录" | 401 `unauthorized` | 401 `unauthorized` | 401 `unauthorized` | 401 `unauthorized` |
| `invalid_token` | 401 `unauthorized` "Access 登录无效或无权限" | 401 `unauthorized` | 401 `unauthorized` | 401 `unauthorized` | 401 `unauthorized` |
| `keys_unavailable` | 401, as `invalid_token` | 503 `unavailable` | 503 `unavailable` | 503 `unavailable` | 503 `unavailable` |
| CSRF failure | 403 `csrf_failed` | 403 `csrf_failed` | 403 `csrf_failed` | 403 `csrf_failed` | 403 `csrf_failed` |

The dashboard (and the links app and the watch app, which copy its adapter) also refuses non-ASCII owners in
its generator and keeps the error envelope of Todofy (`{error: {code, message, request_id}}`, one log line with ID,
status and code); the links app's and the watch app's owner APIs answer the same failures as google.rpc.Status
bodies whose ErrorInfo reason is the code in upper case (`UNAUTHORIZED`).

### 5.5 Bounds and edge cases

Not observable for real Access tokens or tokens an app issued:

- Policy values are validated and fail closed as `not_configured` (`emailMatch`, `tokenSource`
  literals; a non-string bypass `principal`).
- The certs body is capped at 1,000,000 characters and the first 16 JWKs (Access publishes two or
  three), which bounds import work under the Free plan's 10 ms CPU. A verifier caches at most 8 issuers
  (oldest dropped).
- The duplicate-kid rule counts every object member with that `kid` before the other filters.
- Mutation origin lists come only from the app's configured public host and its established local-dev rule.
  Request bodies are decoded only after JWT and mutation-header checks pass.
- The bare padding strings `=` and `==` decode to no bytes; no JSON segment can use this.

## 6. Consumption and source rules

Each app declares `"@ziyixi/edge-auth": "workspace:*"` in its own manifest. The root pnpm
workspace and single lockfile link the canonical package source; each app's bundler compiles it into
its independent Worker. tsc, esbuild, Node type stripping and vitest resolve the same source through
the standard workspace link, without tsconfig paths, bundler aliases or another service.

The package compiles under every app's toolchain, so its source:

- uses `.ts` relative imports and erasable TypeScript only (no `enum`, `namespace`, parameter
  properties; `erasableSyntaxOnly`);
- uses no DOM-only type names (`KeyUsage`, `BufferSource`), because Todofy has no DOM lib, and types
  Web Crypto byte arrays as `Uint8Array<ArrayBuffer>`, because Mail Hero's DOM lib rejects
  `ArrayBufferLike`; `pnpm run typecheck` checks both lib sets (`tsconfig.json` ES2024,
  `tsconfig.dom.json` ES2022 + DOM);
- uses no Node-only or workerd-only API (`Buffer`, `crypto.subtle.timingSafeEqual`);
- keeps state only in objects the app creates (`createAccessVerifier`).

Its dev dependencies use the same root catalog as every application.

## 7. CI

`.github/scripts/ci_changes.py` maps each package to the apps that compile it in
(`PACKAGE_USERS = {"edge-auth": ("todofy", "mail-hero", "dashboard", "links", "watch", "fleet", "mailsort", "recall", "brief", "tasks"), ...}`).
Any change inside
`packages/edge-auth/` (this file included) runs the `Shared packages` job (`pnpm install --frozen-lockfile`, `npm run
typecheck`, `pnpm test` in every `packages/*/`) and **checks and deploys** every user; an unmapped
package counts as used by every app. `test_ci_changes.py` fails until `PACKAGE_USERS` matches every
`"workspace:*"` dependency. `CI gate` requires `Shared packages` when it ran. No
production secret reaches the package job.

## 8. Tests

- **Package** (vitest; tokens signed with Web Crypto, independent of the package's decoder): each
  former behaviour under both original policies; claim edges (`exp = now`/`now+1`,
  `iat = now+59`/`now+60`, `nbf` at the leeway and one past it); `crit`, missing or empty `kid`, a
  1024-bit key, JWK `use: enc`, `alg: RS512`, `key_ops: ['sign']`, duplicate kid, non-object member;
  certs 302/500/non-JSON/throw/timeout → `keys_unavailable`; cache TTL and cooldown; token sources and
  the 16,000-character edge; config fail-closed cases including non-ASCII and the KELVIN SIGN; dev
  bypass under both host rules, with `cf-ray`, `refuse` vs `verify`; the exact Origin/custom-header/JSON matrix, missing and opaque Origins, legacy-header compatibility,
  bodyless mutations and refusal before body consumption;
  headers byte for byte.
- **Mail Hero**: `native-api.test.mjs` signs with jose (an independent implementation, now a dev
  dependency) through `createAccessVerifier({fetch})`; the owner mutation checks through `handleAPI`; the
  tightenings and the certs failure as 401; the workerd runtime tests.
- **Todofy**: `gateway/test/access.test.ts` and `owner.test.ts` (including mutation-header checks) and
  `tests/runtime/test_access.py` against workerd.
- **Dashboard**: `worker/test/http.test.ts` (a real RSA test JWKS, aliases and ASCII folding, CSRF and
  Origin, private headers) and the runtime suite's end-to-end Access check with the JWKS served
  through Miniflare's outbound handler.

## 9. Rollout, verification, rollback

- A package change redeploys every user in one CI run, each in its own concurrency group. Access
  sessions remain Cloudflare's cookies. Cached clients' nonempty old headers remain accepted with
  exact Origin and JSON checks. New clients send `1` without a token-fetch roundtrip. Remove obsolete
  Worker signing secrets only after verifying the keyless release; an older signed-CSRF revision
  would need its key restored. Mail Hero preview tokens and Brief feedback are unchanged.
- The tightenings (#6–#12, #14, #19, #20, #36) should be invisible for real Access tokens. After a
  deploy that changes them, the owner opens each UI and makes one write that passes Origin and CSRF
  (for example a Mail Hero settings save, a Todofy dismiss, a confirmed 解除降载 on the dashboard,
  which is harmless when nothing is shed; a refresh is a GET and checks neither), with the primary
  login and, where configured, an alias login. Before releasing #36, check that no configured owner or alias contains
  a non-ASCII character (the generators refuse one).
- A 401 on a real login means reverting the package commit, which redeploys every user, and comparing
  the real token's header and claims (never logged) against §2 and §5.1.
- Optional Access-policy unifications remain #16 (Todofy JWKS TTL down to 10 min) and #17 (token source).
  This mutation change does not alter them.
