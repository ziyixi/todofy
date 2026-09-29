# `packages/edge-auth`: specification

Status: design, written before any code. Both implementations were read at `bf7a769`
(`origin/docs-mail-hero-integration`) line by line, and the consumption mechanism was tried in a
throwaway copy (§6). Nothing here is implemented or deployed yet.

What the owner asked for: one auth package, maintained once, compiled into every Worker in this
repository (the Todofy gateway and Mail Hero now, a dashboard later). It is a TypeScript source
package with no runtime dependencies (Web Crypto only). It is **not** a separate auth Worker: there is
no service binding, no extra hop and no extra deploy. Each app keeps its current external behaviour:
cookie names, CSRF token formats and key derivations (tokens already in browsers stay valid across the
deploy), error codes, statuses and messages, and headers. Mail Hero drops `jose`, and the replacement
must not weaken any of its checks.

Sources read:

| App | Files |
| --- | --- |
| Mail Hero | `mail-hero/cloudflare/src/native/security.ts` (whole file), `index.ts`, `api.ts`, `types.ts`, `backup.ts` (its own Bearer check), `api-settings.ts` and `api-common.ts` (other users of the signing key and the owner), `test/native-api.test.mjs`, `test/native-runtime.test.mjs`, `web/src/api/client.ts`, `jose@6.2.12` `dist/webapi` (`jwt/verify.js`, `lib/jws_verify.js`, `lib/jwt_claims_set.js`, `lib/validate.js`, `lib/key.js`, `jwks/local.js`, `jwks/remote.js`), `deploy/generate-ci-config.mjs` |
| Todofy | `todofy/gateway/src/access.ts`, `csrf.ts`, `http.ts`, `owner.ts`, `crypto.ts`, `env.ts`, `index.ts`, `test/access.test.ts`, `test/owner.test.ts`, `test/helpers.ts`, `test/setup.ts`, `wrangler.toml`, `wrangler.test-auth.toml`, `tests/runtime/test_access.py` and its `harness.py` `AccessIssuer`, `web/src/api/client.ts`, `deploy/generate_ci_config.py`, `docs/gateway-contract.md` §2.2–2.5, `docs/dev-notes.md` |
| Repository | root `AGENTS.md`, `README.md`, `.github/workflows/ci.yml`, `.github/scripts/ci_changes.py`, `test_ci_changes.py` |

## 1. Decisions in one screen

- **Location and form.** `packages/edge-auth/`: TypeScript source, `"type": "module"`,
  `"exports": {".": "./src/index.ts"}`, `"private": true`, no `dependencies`. The name is
  `@ziyixi/edge-auth`. Only a `file:` spec ever points at it, so npm never asks a registry for it.
- **How the apps consume it.** A `file:../../packages/edge-auth` dependency in each Worker's own
  `package.json` and `package-lock.json`. npm links it into that app's `node_modules`. tsc, esbuild
  (wrangler and Mail Hero's runtime tests), Node's type stripping (Mail Hero's `node --test`) and
  vitest (Todofy) all compile the same `.ts` source. The experiment in §6 ran every check both apps
  run, and they all passed.
- **What it owns.** Access JWT verification (with JWKS fetch and cache), signed double-submit CSRF
  (issue and verify), the private-response header helper, and the small primitives these need: HMAC
  key import and derivation, base64url, cookie reading and a constant-time compare.
- **What stays in each app.** Its `HttpError` class, error envelopes and message texts, gate order,
  maintenance handling, routes, and its CSP string (the helper takes it as input). Also each app's own
  credentials: Mail Hero's backup Bearer, AES-GCM webhook credentials, preview tokens and
  `actionHash`; Todofy's hooks Bearer and newsletter Basic. The package returns a typed failure
  reason, and each app maps it to its own status, code and message (§5.4).
- **Differences between the apps** (§4). Anything a real browser or a real Access token can observe,
  or that is persisted, is a **parameter**. The package takes the **stricter** of the two apps'
  behaviours where no real Access token, Access certs response, or token that an app issued could
  be affected. Configuration normalisation is unified because both deploy-config generators already
  reject any value on which the two apps would differ.
- **CI.** `ci_changes.py` maps `packages/edge-auth/` to both apps. A change there checks **and
  deploys** Todofy and Mail Hero and runs a new `Edge auth package` job, and `CI gate` requires that
  job (§7).

## 2. Current behaviour: Access JWT

### 2.1 Where it runs

| | Mail Hero | Todofy gateway |
| --- | --- | --- |
| Entry | `index.ts` `fetchHandler`: `/health/live` (no auth); non-GET/HEAD during `MAINTENANCE_MODE` → 503 `maintenance` "维护中，请稍后重试" **before** auth (except `/api/internal/backup/reconcile-writer`); `/api/internal/backup/*` → own Bearer check, no Access; `/api/*` → `handleAPI`; all else `authenticate` then `/health/ready`, 405 for non-GET/HEAD, then `ASSETS` | `index.ts` routes by host; owner host → `owner.ts` `handleOwner`: `authenticate` on every request, assets included; hooks hosts never use Access |
| After auth, writes | `api.ts`: non-GET/HEAD → `MAINTENANCE_MODE` 503 `maintenance` "维护模式暂不接受修改，请稍后重试" **first**, then CSRF | non-GET/HEAD under `/api/` → CSRF **first**, then `MAINTENANCE_MODE` → 503 `maintenance` + `retry-after: 300` |
| Signature | `authenticate(request, env, keyResolver?)`, where `keyResolver` is jose's `JWTVerifyGetKey` (tests only) | `authenticate(request, env)`; tests stub global `fetch` |
| Returns | `ACCESS_OWNER` trimmed, **case kept**; dev bypass returns the literal `local-development` | `ACCESS_OWNER` trimmed and **lowercased** (also for the dev bypass) |

Why the returned owner is observable: Mail Hero writes it into `ui_actions.owner` (`api-common.ts:84`)
and into CSRF and preview tokens. Todofy passes it to the core's `owner_api` and `/api/v1/setup`
`access_owner`, and puts it into CSRF tokens.

### 2.2 Behaviour matrix

"now" is `floor(Date.now()/1000)` in both apps (jose: `epoch(new Date())`).

| Step | Mail Hero (`security.ts:94-129`, jose 6.2.12) | Todofy (`access.ts`) |
| --- | --- | --- |
| Dev bypass flag | `env.DEV_AUTH_BYPASS === 'true'` (not trimmed) | `DEV_AUTH_BYPASS` trimmed `=== 'true'`, and `TODOFY_PUBLIC_HOST` ends with `.localhost` (`localDev`) |
| Dev bypass request rule | request URL `http:`, hostname exactly `localhost`, `127.0.0.1` or `[::1]`, no `CF-Ray` header | no `cf-ray` header. The request host equals the `*.localhost` public host, because owner routing matched it. Any scheme |
| Flag set, rule fails | **503 `invalid_auth_configuration`** "开发认证模式仅限本机" | flag ignored; normal Access verification follows |
| Bypass principal | `local-development` | lowercased `ACCESS_OWNER` (may be empty) |
| Issuer | `ACCESS_ISSUER` (not trimmed) minus **one** trailing `/`; must match `^https://[a-z0-9-]+\.cloudflareaccess\.com$` | trimmed, **all** trailing `/` removed; same regex, or `^http://127\.0\.0\.1:\d{1,5}$` when `localDev` and `DEV_ACCESS_LOOPBACK_ISSUER == "true"` |
| Audience | `ACCESS_AUDIENCE` truthy, **not trimmed** | trimmed, non-empty |
| Owner | trimmed, non-empty | trimmed, lowercased, non-empty |
| Aliases | raw (untrimmed) length ≤ 2048; split `,`, trim, drop empty; ≤ 8; case kept | raw **trimmed** length ≤ 2048; split, trim, **lowercase**, drop empty; ≤ 8 |
| Config failure | 503 `access_not_configured` "请先配置 Cloudflare Access" | 503 `access_not_configured` |
| Token source | `Cf-Access-Jwt-Assertion` header `??` **first** `CF_Authorization` cookie. A present but empty header gives the token `""`, i.e. missing, with no cookie fallback | header `\|\|` **last** `CF_Authorization` cookie. An empty header falls back to the cookie |
| Missing or > 16,000 chars | 401 `unauthorized` "需要通过 Cloudflare Access 登录" | 401 `unauthorized` |
| Shape | jose: exactly 3 parts; protected header is a JSON object (plain-object check); unencoded payload refused | exactly 3 parts; header and payload are JSON objects (not arrays) |
| base64url | `Uint8Array.fromBase64(…, {alphabet:'base64url'})` where available (loose: padding and ASCII whitespace accepted); invalid → 401 | own decoder: optional `=`/`==` padding, alphabet `[A-Za-z0-9_-]`, `len % 4 != 1`; invalid → 401 |
| UTF-8 / JSON | fatal `TextDecoder`, `JSON.parse` | fatal `TextDecoder` (BOM stripped), `JSON.parse` |
| `alg` | allow-list `['RS256']`; `none`, `HS256` and `RS512` are refused before any key lookup | `header.alg === 'RS256'` |
| `crit` | refused unless it only names `b64`; unknown extensions are refused (probe: 401) | ignored |
| `kid` | **optional**. With no `kid`, the one usable key in the set is used (probe: accepted), and several usable keys fail | must be a string; only exact `kid` matches |
| Key fetch | `createRemoteJWKSet(<issuer>/cdn-cgi/access/certs)`: `GET`, `redirect: 'manual'`, 5 s timeout, `accept` and `User-Agent: jose/v6.2.12` headers; status must be 200 and the body JSON | `fetch(url, {signal: timeout 5 s})`: redirects **followed**; status must be 200 and the body JSON |
| Key set validity | the body must have `keys: object[]`; any non-object member makes the **whole set** invalid | non-object members skipped; no `keys` array gives an empty set |
| Key selection | `kty` RSA; `use` absent or `sig`; `alg` absent or equal to the token's; `key_ops` absent or includes `verify`; `ext` boolean if present; imports the full JWK | `kty` RSA and non-empty string `kid`; imports only `{kty, n, e}`; import failures skipped; a later duplicate kid wins |
| RSA size | modulus ≥ 2048 bits enforced (probe: a 1024-bit key → 401) | not checked |
| Cache | per issuer, per isolate; **10 min** max age; an unknown kid refetches if the last fetch is **≥ 30 s** old; no stale fallback; no negative caching | per issuer, per isolate; **1 h** TTL; an unknown kid refetches if the last fetch is **≥ `JWKS_REFRESH_COOLDOWN_MS`** old (default 60 s; the runtime test uses 2 s); no stale fallback; no negative caching |
| Certs fetch failure (network, timeout, non-200, bad JSON) | **401** `unauthorized` "Access 登录无效或无权限": everything inside jose's `try` maps to 401 | **503 `unavailable`** |
| `iss` | `=== issuer` | `=== issuer` |
| `aud` | string equal to, or array containing, the audience | same |
| `exp` | required number; `exp > now` (tolerance 0) | number; `exp > now` |
| `iat` | required, must be a number; **future values accepted** (probe: `iat = 2100-01-01` accepted) | number, `iat < now + 60` |
| `nbf` | if present a number, `nbf ≤ now` (**0 s** leeway; probe: `now+1` → 401) | absent or number, `nbf ≤ now + 60` |
| `sub` | **presence only**: `""` and `7` are accepted (probe) | non-empty string |
| `email` | `=== owner` or `===` an alias: **exact, case-sensitive** (the test rejects `GITHUB-owner@…`) | string; its lowercase is in {owner, aliases}: **case-insensitive** (the test accepts `OWNER@example.com`) |
| Any claim or signature failure | 401 "Access 登录无效或无权限" | 401 `unauthorized` |

The Mail Hero entries marked "probe" were run against the current `security.ts` with a stubbed
certs endpoint (`scratchpad/tmp/edge-auth-vectors/jose-probe.mjs`, not committed).

## 3. Current behaviour: CSRF and private headers

### 3.1 CSRF

| | Mail Hero (`security.ts:43-66, 130-143`) | Todofy (`csrf.ts`) |
| --- | --- | --- |
| Key | `CREDENTIAL_KEY` (64 hex, either case) → HKDF-SHA-256, salt `"mail-hero"`, info `"tokens-v1"` → HMAC-SHA-256, 256 bits, `['sign','verify']`. The same key signs preview tokens (`kind: retention`/`lifecycle`) and `actionHash` | `CSRF_SIGNING_KEY` trimmed, `^[0-9a-fA-F]{64}$` → 32 raw bytes → HMAC-SHA-256, `['sign']` |
| Bad key on issue | `Error('credential_key_not_configured')` → `handleAPI` → **503 `service_unavailable`** "服务暂不可用，请稍后重试" | **503 `not_configured`**, checked first |
| Bad key on verify | checked **after** the Origin, header and cookie checks; `verifyToken` swallows the error → **403 `csrf_failed`** | checked **first** → 503 `not_configured` (reads keep working) |
| Claims | `{kind:'csrf', owner, nonce, exp}` in that key order, compact JSON; `nonce = crypto.randomUUID()`; `exp = now + 43200` | same key order and JSON; `nonce` = 16 random bytes as base64url (22 chars; a test asserts the regex) |
| Token | `b64url(JSON) "." b64url(HMAC(key, b64url(JSON)))`, unpadded | same |
| Issue response | `json({token})`: `Response.json`, `content-type: application/json`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, then the private headers | `jsonResponse({token})`: `content-type: application/json; charset=utf-8`, no-store, nosniff, then the private headers |
| Cookie | `mail_hero_csrf=<t>; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`, plus `; Secure` when the request URL is `https:` | `todofy_csrf=<t>; …` with the same attributes and the same `Secure` rule |
| Origin | `Origin` header **===** `new URL(request.url).origin` (case-sensitive; from the request URL, not config) | `Origin` **lowercased** ∈ {`https://<TODOFY_PUBLIC_HOST>`} ∪ {`http://<request host:port>` under `localDev`} |
| Header / cookie | `X-CSRF-Token` non-empty and `!==` the **first** `mail_hero_csrf` cookie (plain compare) | `x-csrf-token` non-empty, ≤ **1024** chars, constant-time equal to the **first** `todofy_csrf` cookie |
| Signature | `token.length ≤ 4096`; exactly two non-empty parts; the signature decoded by `^[a-zA-Z0-9_-]+$` + `atob` (non-canonical last characters accepted); `crypto.subtle.verify` | split at the first `.`; recompute the HMAC and constant-time compare the **canonical base64url text** |
| Payload decode | lenient `TextDecoder`; JSON object, not array | fatal `TextDecoder`; JSON object |
| `exp` | `typeof number` and `exp > Date.now()/1000` (fractions allowed) | `Number.isInteger(exp)` and `exp > now` |
| `kind`, `owner` | `kind === 'csrf'`, `owner ===` the authenticated principal | same |
| Failure | 403 `csrf_failed` "请刷新页面后再试" | 403 `csrf_failed` |
| Web client | `GET /api/v1/csrf` once, sends `X-CSRF-Token`, drops the cached token on 403, `redirect: 'error'` | same pattern |

Golden vectors, minted at `bf7a769` by the current code with far-future `exp = 4102444800`. Todofy's
two were also accepted by its current `verifyCsrf` through `worker.fetch`. The package tests and both
apps' tests must accept these exact bytes:

```text
Mail Hero, CREDENTIAL_KEY = "12"×32, owner owner@example.org, nonce 00000000-0000-4000-8000-000000000000:
eyJraW5kIjoiY3NyZiIsIm93bmVyIjoib3duZXJAZXhhbXBsZS5vcmciLCJub25jZSI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImV4cCI6NDEwMjQ0NDgwMH0.PsGfEZ9TSpWDV8E-z6nAAyrq-o4zpAHqNtPXxFlC1ac
Todofy, CSRF_SIGNING_KEY = "ab"×32, owner owner@example.com, compact JSON, nonce "A"×22:
eyJraW5kIjoiY3NyZiIsIm93bmVyIjoib3duZXJAZXhhbXBsZS5jb20iLCJub25jZSI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUEiLCJleHAiOjQxMDI0NDQ4MDB9.lfoeE-7aIjGjl7ay6lmgyn7btoKqiKIVBGkUjvNu65g
Todofy, same key, Python json.dumps separators (the old core's tokens), nonce "test":
eyJraW5kIjogImNzcmYiLCAib3duZXIiOiAib3duZXJAZXhhbXBsZS5jb20iLCAibm9uY2UiOiAidGVzdCIsICJleHAiOiA0MTAyNDQ0ODAwfQ.idEgvgFniPRSJdv7P7EcsU0evUgyoX35jRlO6dor7zA
```

### 3.2 Private headers

Both apps build a copy with `new Response(response.body, response)` and set:

| Header | Mail Hero `privateResponse` | Todofy `withPrivateHeaders` / `PRIVATE_HEADERS` |
| --- | --- | --- |
| `cache-control` | `no-store` | `no-store`, except `private, max-age=31536000, immutable` for an `ASSETS` 200 under `/assets/` that is not `text/html` |
| `x-content-type-options` | `nosniff` | `nosniff` |
| `referrer-policy` | `no-referrer` | `no-referrer` |
| `x-frame-options` | `DENY` | `DENY` |
| `content-security-policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |

Mail Hero needs `frame-src 'self' about:` for its sandboxed mail HTML view. The CSP strings differ,
so the CSP is an input (§5.3).

### 3.3 Error envelopes (stay in each app)

- Mail Hero `/api/*`: `{"error":{"code","message","request_id":<UUID>}}`. Assets and
  `/health/ready`: `{"error":{"code","message"}}` (no `request_id`). Both via `json()` (+ no-store,
  nosniff) and `privateResponse`.
- Todofy: `{"error":{"code","message","request_id":<16 hex>}}`, where the message comes from the
  `MESSAGES` table (`unauthorized` "未登录或凭据无效", `csrf_failed` "页面安全令牌已失效，请刷新后重试",
  `not_configured` "服务缺少必需的密钥配置", `access_not_configured` "Cloudflare Access 配置不完整",
  `unavailable` "依赖服务暂时不可用，请稍后再试"). `content-type: application/json; charset=utf-8`, and
  one log line `{request_id,status,code}` per error.

## 4. Differences and verdicts

Verdicts:

- **P**: the package takes a parameter, and each app passes its current value.
- **U→x**: unified to x. An app changes only where no real Access token, real Access certs response,
  or token that app issued could tell the difference.
- **App**: stays in the app and is not the package's concern.

| # | Aspect | Mail Hero | Todofy | Verdict and reason |
| --- | --- | --- | --- | --- |
| 1 | Email matching and canonical owner | exact; owner case kept | case-insensitive; owner lowercased | **P** `emailMatch: 'exact' \| 'case-insensitive'`. Observable (tests pin both). The owner is persisted in Mail Hero (`ui_actions.owner`) and in both apps' CSRF tokens |
| 2 | Dev bypass rule and outcome | `http:` + exact loopback names; flag set elsewhere → 503 | `*.localhost`; flag set elsewhere → normal verification | **P** `devBypass.hosts: 'loopback-http' \| 'dot-localhost'`, `devBypass.whenNotLocal: 'refuse' \| 'verify'`. The package's own invariant: never bypass when `cf-ray` is present, or when the request hostname is not `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`. The app computes `enabled` from its env as today |
| 3 | Bypass principal | `local-development` | lowercased owner | **P** `devBypass.principal` |
| 4 | Loopback issuer | none | `http://127.0.0.1:<port>` under the dev rule | **P** `loopbackIssuer: boolean` (app computes it; default false) |
| 5 | `nbf` leeway | 0 s | 60 s | **P** `nbfLeewaySeconds`. Unifying to 60 would weaken Mail Hero. Unifying to 0 could refuse a fresh Todofy token when the clocks are a second apart |
| 6 | `iat` in the future | accepted | `iat < now + 60` | **U→Todofy**. Tighter for Mail Hero, and Access never issues a token ≥ 60 s in the future |
| 7 | `sub` | presence only | non-empty string | **U→Todofy**. Tighter; Access tokens always carry a non-empty string `sub` |
| 8 | `kid` | optional (one-key fallback) | required string | **U→Todofy** (required, non-empty). Tighter; Access tokens carry `kid`, and the certs hold two keys around a rotation, so jose's fallback could not apply then anyway |
| 9 | `crit` header | refused | ignored | **U→Mail Hero**: any `crit` is refused. Tighter for Todofy; Access does not send it |
| 10 | RSA modulus | ≥ 2048 | any | **U→Mail Hero**: ≥ 2048. Checked from `CryptoKey.algorithm.modulusLength`, which the workerd and Node probes confirmed (§6.3) |
| 11 | JWK filter | `use`, `alg`, `key_ops`, `ext` | only `kty` + `kid` | **U→Mail Hero**: `kty === 'RSA'`, non-empty string `kid`, `use` ∈ {absent, `sig`}, `alg` ∈ {absent, `RS256`}, `key_ops` absent or includes `verify`. Access certs (and both test harnesses) carry `alg: RS256`, `use: sig` |
| 12 | Duplicate `kid` in the certs | whole match refused | last wins | **U→Mail Hero** (fail closed): a kid listed twice is dropped |
| 13 | Non-object member in `keys` | whole set invalid | skipped | **U→Todofy** (skip it). Neither app is weakened: a set without that member already verifies the same keys. Access never sends one |
| 14 | Redirects on the certs fetch | refused (`manual`) | followed | **U→Mail Hero**: `redirect: 'manual'`, so key material is never taken from another URL. Access answers 200 directly |
| 15 | Certs fetch failure | 401 "Access 登录无效或无权限" | 503 `unavailable` | **App**: the package returns `keys_unavailable`, and each app keeps its mapping |
| 16 | JWKS TTL / refetch cooldown | 10 min / 30 s | 1 h / env (60 s) | **P** `jwks: {ttlMs, refreshCooldownMs}` (defaults 600,000 / 60,000); each app passes its current values. Unifying Todofy to 10 min is a sensible follow-up, but it changes the key-revocation window, so it deserves its own commit |
| 17 | Token source | empty header = missing; first cookie | empty header → cookie; last cookie | **P** `tokenSource: {emptyHeader: 'missing' \| 'use-cookie', cookie: 'first' \| 'last'}`. Only reachable without the Access-injected header, but it is observable, so kept exact |
| 18 | Config normalisation (trim, trailing `/`, alias length measured before or after trim) | partial | full | **U→trim everything, strip all trailing `/`, measure after trim.** Both generators already reject any value on which this differs: Mail Hero `checked()` requires `value === value.trim()`, and both anchor the issuer regex and demand a 64-hex audience |
| 19 | Owner and alias syntax | any non-empty | any non-empty | **U→**each must match the generators' `^[^\s@]+@[^\s@]+\.[^\s@]+$`, or `not_configured` (fail closed). Deployed configs already pass both generators |
| 20 | Numeric claims | `typeof number` (`1e999` → `Infinity` passes) | same | **U→**`Number.isFinite` as well. Tighter; only signed tokens reach this check |
| 21 | Failure messages and statuses | its table | its table | **App** (§5.4) |
| 22 | CSRF key source | HKDF from `CREDENTIAL_KEY` | raw `CSRF_SIGNING_KEY` | **P** `key: CryptoKey \| () => Promise<CryptoKey>`, plus the helpers `deriveHmacKeyHkdf` and `importHmacKeyHex`. Key and token bytes are unchanged, so existing tokens stay valid |
| 23 | CSRF key failure timing | issue: throws (503); verify: after the pre-checks → 403 | first → 503 `not_configured` | Via #22: Mail Hero passes a lazy key. `issueCsrf` lets the error propagate, and `verifyCsrf` reports `key_unavailable` after the Origin/header/cookie checks (Mail Hero maps it to 403). Todofy resolves its key **before** calling the package, as today |
| 24 | CSRF nonce | UUID | 16 bytes base64url | **P** `nonce?: () => string` (default: 16 bytes base64url). Mail Hero passes `() => crypto.randomUUID()` |
| 25 | CSRF cookie name | `mail_hero_csrf` | `todofy_csrf` | **P** `cookieName` |
| 26 | Allowed origins | `new URL(request.url).origin` | public host (+ dev) | **P** `allowedOrigins: readonly string[]`, computed by the app |
| 27 | Origin case | exact | lowercased | **U→case-insensitive** (both sides lowercased). Browsers serialise `Origin` in lowercase (RFC 6454 §6.2), so Mail Hero's browser behaviour is identical; only a non-browser client sending an uppercase `Origin` changes from 403 to accepted, and such a client is outside the CSRF threat model. Todofy's test asserts `HTTPS://TODOFY.LOCALHOST` is accepted. **Owner decision**: if Mail Hero must stay byte-exact here, add `originCase: 'exact'` instead |
| 28 | CSRF header/cookie compare | plain `!==` | constant time | **U→constant time** (same result) |
| 29 | CSRF length cap | 4096 | 1024 | **U→1024**. Mail Hero tokens are about 190 characters (the golden vector is 187), and still < 1024 for any owner of up to 254 ASCII characters. `issueCsrf` throws if a token it builds exceeds the cap, so it cannot issue a token that `verifyCsrf` would reject |
| 30 | CSRF signature check | decode, then `subtle.verify` (non-canonical base64url accepted) | canonical text compare | **U→Todofy**. Tighter; every token either app issued is canonical |
| 31 | CSRF payload UTF-8 and `exp` | lenient decode; fractional `exp` accepted | fatal decode; integer `exp` | **U→Todofy**. Tighter; both apps issue integer `exp` (`floor(now)+43200`), and for an integer `exp`, `exp > now_frac` ⇔ `exp > floor(now)` |
| 32 | Issue response headers and body | `Response.json` | `jsonResponse` | **App**: the package returns `{token, setCookie}` and the app builds the response |
| 33 | CSP | extended | strict | **P** `csp` input; the package exports `STRICT_CSP` (= Todofy's string) as the default. Mail Hero keeps its string |
| 34 | Immutable asset cache | none | `/assets/` rule | **P** `cacheControl` override; Todofy computes it as today |
| 35 | Gate order, maintenance, 405, routes | its own | its own | **App**: unchanged |

**Is Mail Hero weakened by dropping jose?** No. Every jose check is kept or tightened: the RS256
allow-list, `crit`, ≥ 2048-bit keys, the JWK filters, refusing a duplicate kid, manual redirects, the
required `exp`/`iat`/`sub`/`email`, `iss`/`aud`, `nbf` with 0 s leeway, `exp` with 0 s leeway,
exact email matching and fail-closed config. Additions: a required `kid`, a bound on future `iat`, a
non-empty string `sub`, finite numeric claims. There is one relaxation (#13): a stray non-object
member of the certs no longer invalidates the valid keys next to it. That is an availability change
on a document fetched over manual-redirect HTTPS from the pinned issuer, not an acceptance of any
key jose would refuse. There is no alg confusion: the header `alg` must be exactly `RS256`, the only
key type imported is RSASSA-PKCS1-v1_5/SHA-256 with usage `verify`, and HMAC keys never touch the
JWT path.

## 5. Package API

`packages/edge-auth/src/index.ts` re-exports everything below. All functions are stateless, except
the key cache owned by an `AccessVerifier` instance. Each app creates one verifier at module scope,
so the cache stays per isolate. Todofy's tests call `vi.resetModules()`, which re-creates the
verifier with its app module (§6.3 also showed the linked package module itself is re-evaluated).
The package never reads `env`, never logs, and never builds a response body.

### 5.1 Access

```ts
export type AccessFailure =
  | 'not_configured'        // issuer / audience / owner / aliases invalid (checked before the token)
  | 'dev_bypass_refused'    // devBypass.enabled, request not local, whenNotLocal === 'refuse'
  | 'missing_token'         // no token, empty token, or longer than 16,000 characters
  | 'invalid_token'         // shape, header, signature, unknown kid, claims, not the owner
  | 'keys_unavailable';     // certs: network error, timeout, non-200, body not JSON

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
  readonly nbfLeewaySeconds: number;
  readonly tokenSource: { readonly emptyHeader: 'missing' | 'use-cookie'; readonly cookie: 'first' | 'last' };
  readonly jwks?: { readonly ttlMs?: number; readonly refreshCooldownMs?: number };
  readonly loopbackIssuer?: boolean;
  readonly devBypass?: DevBypassPolicy;
}

export interface AccessVerifier {
  verify(request: Request, policy: AccessPolicy): Promise<AccessResult>;
}
export interface AccessVerifierOptions {
  /** Default: globalThis.fetch looked up at call time (Todofy's tests stub it after import). */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}
export function createAccessVerifier(options?: AccessVerifierOptions): AccessVerifier;

export const ACCESS_MAX_TOKEN_CHARS = 16_000;
export const ACCESS_MAX_ALIASES = 8;
export const ACCESS_MAX_ALIASES_CHARS = 2048;
```

`verify` follows these steps in order. It returns a failure and never throws for any input: every
exception from decoding, `importKey` or `verify` becomes `invalid_token`, and every exception from
the certs fetch becomes `keys_unavailable`.

1. **Dev bypass.** If `devBypass?.enabled` and there is no `cf-ray` header and the host rule holds
   (`loopback-http`: `http:` and a hostname in {`localhost`,`127.0.0.1`,`[::1]`}; `dot-localhost`: the
   hostname ends with `.localhost`), return `{ok, owner: principal, bypassed: true}`. If
   `enabled` but not local: `refuse` → `dev_bypass_refused`, `verify` → continue.
2. **Config.** issuer = trim, strip all trailing `/`; it must match
   `^https://[a-z0-9-]+\.cloudflareaccess\.com$`, or `^http://127\.0\.0\.1:\d{1,5}$` when
   `loopbackIssuer`. Audience trimmed and non-empty. Owner trimmed and matching
   `^[^\s@]+@[^\s@]+\.[^\s@]+$`. Aliases: the trimmed raw string is ≤ 2048 characters; split on
   `,`, trim, drop empties; ≤ 8 entries, each matching the same pattern. `case-insensitive`
   lowercases the owner and the aliases. Any failure → `not_configured`.
3. **Token.** Header `cf-access-jwt-assertion`. If it is absent (or empty under `use-cookie`), read
   the `CF_Authorization` cookie at the `first`/`last` occurrence. Cookies are parsed as
   `;`-separated pairs, trimmed, split at the first `=`, exact name match. Empty or > 16,000 → `missing_token`.
4. **Parse.** Exactly three `.` parts. The header and payload are base64url (optional `=`/`==`,
   `[A-Za-z0-9_-]`, `len % 4 != 1`) decoded as fatal UTF-8 JSON **objects**, and the signature is
   base64url bytes. Header: `alg === 'RS256'`, `kid` a non-empty string, no `crit` member.
   Otherwise → `invalid_token`.
5. **Key.** The cache entry for the issuer is `{fetchedAt, keys: Map<kid, CryptoKey>}`. Use it if
   `age < ttlMs` and (`kid` is known or `age < refreshCooldownMs`); otherwise refetch. The refetch is
   `fetch('<issuer>/cdn-cgi/access/certs', {redirect: 'manual', signal: AbortSignal.timeout(5000)})`,
   and the URL is passed as a **string** (Todofy's test asserts the first argument). A status other
   than 200, a thrown error or a non-JSON body → `keys_unavailable`, leaving the old entry untouched.
   Otherwise replace the entry with the filtered keys (#11–#13): each is imported from `{kty,n,e}` as
   `RSASSA-PKCS1-v1_5`/`SHA-256` with usage `['verify']`, and dropped if it fails to import or has
   `modulusLength < 2048`. A body without a `keys` array gives an empty set. Unknown `kid` →
   `invalid_token`.
6. **Signature.** `crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, ascii("<h>.<p>"))`; false →
   `invalid_token`.
7. **Claims.** `iss === issuer`; `aud` is a string equal to the audience, or an array containing it;
   `exp` a finite number `> now`; `iat` a finite number `< now + 60`; `nbf` absent or a finite number
   `≤ now + nbfLeewaySeconds`; `sub` a non-empty string; `email` a string that matches the owner or an
   alias (`exact`: `===`; `case-insensitive`: lowercased, then `===`). Any failure → `invalid_token`.
8. Return `{ok, owner: <canonical owner from step 2>, bypassed: false}`.

### 5.2 CSRF and keys

```ts
export type HmacKey = CryptoKey | (() => Promise<CryptoKey>);

export interface CsrfIssuePolicy {
  readonly cookieName: string;
  readonly key: HmacKey;
  readonly nonce?: () => string;        // default: 16 random bytes, base64url (22 chars)
  readonly ttlSeconds?: number;         // default 43200
}
export interface CsrfPolicy extends CsrfIssuePolicy {
  readonly allowedOrigins: readonly string[];
}
export interface IssuedCsrf { readonly token: string; readonly setCookie: string }
export type CsrfFailure = 'origin' | 'token' | 'key_unavailable';

/** Claims {kind:'csrf', owner, nonce, exp: floor(now)+ttl}; key errors propagate. */
export function issueCsrf(request: Request, owner: string, policy: CsrfIssuePolicy): Promise<IssuedCsrf>;
export function verifyCsrf(request: Request, owner: string, policy: CsrfPolicy):
  Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: CsrfFailure }>;

export const CSRF_HEADER = 'X-CSRF-Token';
export const CSRF_MAX_TOKEN_CHARS = 1024;

/** Generic signed claims in the shared token format (CSRF is built on these). */
export function signClaims(key: CryptoKey, claims: Record<string, unknown>): Promise<string>;
export function verifySignedClaims(key: CryptoKey, token: string, maxChars?: number):
  Promise<Record<string, unknown> | null>;

export function importHmacKeyHex(hex: string): Promise<CryptoKey | null>;          // ^[0-9a-fA-F]{64}$, ['sign']
export function deriveHmacKeyHkdf(ikm: Uint8Array<ArrayBuffer>, salt: string, info: string):
  Promise<CryptoKey>;                                                                // HKDF-SHA-256 → HMAC-SHA-256/256, ['sign','verify']
```

- `setCookie` = `<cookieName>=<token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=<ttl>`, followed by
  `; Secure` iff `new URL(request.url).protocol === 'https:'`. `issueCsrf` throws if the token is
  longer than 1024 characters.
- `verifyCsrf` order:
  1. The lowercased `Origin` must be in the lowercased `allowedOrigins`, else `origin`.
  2. The header must be non-empty, ≤ 1024 characters, and constant-time equal to the **first**
     cookie value, else `token`.
  3. Resolve the key; a thrown error → `key_unavailable`.
  4. Split at the first `.`. The signature text must constant-time equal the canonical
     base64url HMAC of the payload text.
  5. The payload must decode as a fatal-UTF-8 JSON object with `kind === 'csrf'`,
     `owner === owner`, and an integer `exp > floor(now)`. Steps 4 and 5 fail with `token`.
- `constantTimeEqual(a, b)` compares UTF-8 bytes with an XOR loop; only the length can leak. It does
  **not** use workerd's `crypto.subtle.timingSafeEqual`, which Node lacks (§6.3), so the package runs
  unchanged in Node tests and in workerd.

### 5.3 Headers and small helpers

```ts
export const STRICT_CSP: string;   // Todofy's current string, byte for byte
export function privateHeaders(csp?: string): Readonly<Record<string, string>>;  // the five, lowercase names
export function withPrivateHeaders(response: Response,
  options?: { readonly csp?: string; readonly cacheControl?: string }): Response;
export function readCookie(request: Request, name: string, occurrence: 'first' | 'last'): string | null;
export function constantTimeEqual(a: string, b: string): boolean;
```

### 5.4 How each app uses it (adapters; exact external behaviour)

**Mail Hero `security.ts`.** jose is gone. `HttpError`, `json`, the AES credential code,
`signToken`/`verifyToken` for preview tokens, `actionHash` and `validateTarget` stay. `master(env)`
stays too, because AES-GCM also uses it.

```ts
import { createAccessVerifier, deriveHmacKeyHkdf, issueCsrf, verifyCsrf, withPrivateHeaders,
  type AccessPolicy, type AccessVerifier } from '@ziyixi/edge-auth';

const MAIL_HERO_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const access = createAccessVerifier();
const signingKey = (env: Env) => deriveHmacKeyHkdf(master(env), 'mail-hero', 'tokens-v1'); // also used by signToken/verifyToken/actionHash

function accessPolicy(env: Env): AccessPolicy {
  return { issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE, owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES, emailMatch: 'exact', nbfLeewaySeconds: 0,
    tokenSource: { emptyHeader: 'missing', cookie: 'first' }, jwks: { ttlMs: 600_000, refreshCooldownMs: 30_000 },
    devBypass: { enabled: env.DEV_AUTH_BYPASS === 'true', hosts: 'loopback-http',
      principal: 'local-development', whenNotLocal: 'refuse' } };
}
export async function authenticate(request: Request, env: Env, verifier: AccessVerifier = access): Promise<string> {
  const result = await verifier.verify(request, accessPolicy(env));
  if (result.ok) return result.owner;
  if (result.failure === 'not_configured') throw new HttpError(503, 'access_not_configured', '请先配置 Cloudflare Access');
  if (result.failure === 'dev_bypass_refused') throw new HttpError(503, 'invalid_auth_configuration', '开发认证模式仅限本机');
  if (result.failure === 'missing_token') throw new HttpError(401, 'unauthorized', '需要通过 Cloudflare Access 登录');
  throw new HttpError(401, 'unauthorized', 'Access 登录无效或无权限'); // invalid_token and keys_unavailable
}
const csrf = (request: Request, env: Env) => ({ cookieName: 'mail_hero_csrf', key: () => signingKey(env),
  nonce: () => crypto.randomUUID(), allowedOrigins: [new URL(request.url).origin] });
export async function csrfResponse(request: Request, env: Env, owner: string): Promise<Response> {
  const { token, setCookie } = await issueCsrf(request, owner, csrf(request, env)); // key error → 503 service_unavailable as today
  const response = json({ token }); response.headers.set('Set-Cookie', setCookie); return response;
}
export async function requireCSRF(request: Request, env: Env, owner: string): Promise<void> {
  if (!(await verifyCsrf(request, owner, csrf(request, env))).ok) throw new HttpError(403, 'csrf_failed', '请刷新页面后再试');
}
export const privateResponse = (response: Response): Response => withPrivateHeaders(response, { csp: MAIL_HERO_CSP });
```

**Todofy `access.ts`, `csrf.ts`, `http.ts`.** `crypto.ts` keeps the hooks helpers (`matchesAny`,
`base64DecodeStrict`, `sha256Hex`, and its `timingSafeEqual` over workerd's subtle method).

```ts
// access.ts
const verifier = createAccessVerifier();
export async function authenticate(request: Request, env: Env): Promise<string> {
  const result = await verifier.verify(request, {
    issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE, owner: env.ACCESS_OWNER, aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive', nbfLeewaySeconds: 60, tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
    jwks: { ttlMs: 3_600_000, refreshCooldownMs: integer(env, 'JWKS_REFRESH_COOLDOWN_MS', 60_000) },
    loopbackIssuer: localDev(env) && flag(env, 'DEV_ACCESS_LOOPBACK_ISSUER'),
    devBypass: { enabled: localDev(env) && flag(env, 'DEV_AUTH_BYPASS'), hosts: 'dot-localhost',
      principal: variable(env, 'ACCESS_OWNER').toLowerCase(), whenNotLocal: 'verify' },
  });
  if (result.ok) return result.owner;
  if (result.failure === 'keys_unavailable') throw new HttpError(503, 'unavailable');
  if (result.failure === 'not_configured') throw new HttpError(503, 'access_not_configured');
  throw new HttpError(401, 'unauthorized');     // dev_bypass_refused cannot occur with 'verify'
}
// csrf.ts: signingKey = importHmacKeyHex(variable(env,'CSRF_SIGNING_KEY')) ?? throw 503 not_configured, resolved FIRST
// issue: issueCsrf(ctx.request, owner, { cookieName: 'todofy_csrf', key }) → jsonResponse({token}) + set-cookie
// verify: verifyCsrf(ctx.request, owner, { cookieName: 'todofy_csrf', key, allowedOrigins: [...allowedOrigins(ctx)] }) → 403 csrf_failed
// http.ts: PRIVATE_HEADERS = privateHeaders(STRICT_CSP); withPrivateHeaders(response, asset) passes
//   cacheControl: IMMUTABLE under today's condition, else nothing
```

**A future dashboard Worker** adds the same `file:` dependency and supplies its own policy values
and error mapping. It needs no package change unless it has a genuinely new rule, and a new rule
becomes a new parameter reviewed against this table.

## 6. How the apps consume the package

### 6.1 Options considered

| Option | Verdict |
| --- | --- |
| npm **workspaces** (root `package.json` + one lockfile) | Rejected. It replaces each app's own `package-lock.json` with one root lockfile, and every CI job and deploy runs `npm ci` per directory today |
| Relative import `../../../packages/edge-auth/src/index.ts` | It works with every tool, but the path depends on each file's depth. Nothing records the dependency (no manifest or lockfile entry, invisible to `npm ls`), and nothing marks the package boundary |
| tsconfig `paths` + wrangler `alias` | Rejected. Two configs per app, and Node's test runner (Mail Hero) would not see the alias |
| **`file:../../packages/edge-auth` dependency** | **Chosen.** npm writes the dependency into each app's `package.json` and lockfile, and `npm ci` recreates a symlink. The import specifier `@ziyixi/edge-auth` is the same in every file. No tool config changes |

### 6.2 Exact edits

1. `packages/edge-auth/package.json`:

   ```json
   {
     "name": "@ziyixi/edge-auth",
     "private": true,
     "version": "0.0.0",
     "type": "module",
     "engines": { "node": ">=26" },
     "exports": { ".": "./src/index.ts" },
     "scripts": {
       "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.dom.json",
       "test": "node --test test/*.test.ts"
     },
     "devDependencies": { "@cloudflare/workers-types": "<pinned>", "typescript": "5.9.3" }
   }
   ```

   Also a `package-lock.json` for the package's own CI job. `tsconfig.json` uses Todofy's flag set
   (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnused*`,
   `verbatimModuleSyntax`, `isolatedModules`, `allowImportingTsExtensions`, lib `ES2024`, types
   `@cloudflare/workers-types`) plus `erasableSyntaxOnly: true`, which Node's type stripping needs.
   `tsconfig.dom.json` extends it with lib `["ES2022","DOM"]`, as in Mail Hero. The root
   `.gitignore` already ignores `node_modules/`.
2. `cd mail-hero/cloudflare && npm install ../../packages/edge-auth && npm uninstall jose && npm install --save-dev --save-exact jose@6.2.12`.
   `dependencies` gains `"@ziyixi/edge-auth": "file:../../packages/edge-auth"`, and jose moves to
   `devDependencies`: `native-api.test.mjs` keeps signing its test tokens with jose, an independent
   implementation. The lockfile gains exactly:

   ```json
   "../../packages/edge-auth": { "name": "@ziyixi/edge-auth", "version": "0.0.0" },
   "node_modules/@ziyixi/edge-auth": { "resolved": "../../packages/edge-auth", "link": true },
   ```

   plus the root `dependencies` entry (and jose's `dev: true`).
3. `cd todofy/gateway && npm install ../../packages/edge-auth`. It adds a `dependencies` block with
   the same spec, and the lockfile gains the same two entries.
4. Imports: `from '@ziyixi/edge-auth'`. Nothing changes in `wrangler*.toml`, `tsconfig.json`,
   `vitest.config.ts` or `eslint.config.js`. CI already runs `npm ci` in `mail-hero/cloudflare` and
   `todofy/gateway` from a full checkout, so the link target always exists.

Rules the package source must follow, because it is compiled by both apps' toolchains:

- Relative imports use `.ts` extensions (both apps set `allowImportingTsExtensions`), and the source
  uses only erasable TypeScript syntax: no `enum`, `namespace` or parameter properties.
- No DOM-only type names (`KeyUsage`, `BufferSource`): Todofy has no DOM lib. Byte arrays passed to
  Web Crypto are typed `Uint8Array<ArrayBuffer>`, because Mail Hero's DOM lib with TS 5.9 rejects
  `Uint8Array<ArrayBufferLike>`.
- No Node-only or workerd-only APIs: no `Buffer`, no `crypto.subtle.timingSafeEqual`.
- State lives only in objects the app creates (`createAccessVerifier`).

### 6.3 Experiment (throwaway copy `scratchpad/tmp/edge-auth-exp`, not committed)

A minimal package (`constantTimeEqual`, `importHmacKeyHex`) was added with the edits above. Mail Hero
used it in `requireCSRF` and Todofy in `csrf.ts` `signingKey`.

| Check | Result |
| --- | --- |
| Package `node --test test/*.test.ts` | pass |
| Mail Hero `npm run typecheck`, first try | **failed**: `Uint8Array<ArrayBufferLike>` not assignable to `BufferSource` (DOM lib) → fixed by returning `Uint8Array<ArrayBuffer>` |
| Todofy `npm run typecheck`, first try | **failed**: `Cannot find name 'KeyUsage'` (no DOM lib) → fixed with `'sign' \| 'verify'`. These two failures are why the package typechecks against both lib setups |
| Mail Hero `npm run typecheck` / `npm test` | OK / **138 of 138 pass**: Node type stripping through the symlink, and the esbuild + Miniflare workerd runtime tests, including the CSRF round trip |
| Todofy `npm run typecheck` / `npm run lint` / `npm test` | OK / OK / **70 of 70 pass** |
| `vi.resetModules()` then re-import | the linked package module is re-evaluated (a module-level UUID differed) |
| Mail Hero placeholder production config, `wrangler deploy --dry-run --outdir` | bundle contains `// ../../packages/edge-auth/src/bytes.ts` |
| Todofy `wrangler deploy --dry-run --config gateway/wrangler.toml --outdir` | bundle contains `packages/edge-auth/src/bytes.ts` and `keys.ts` |
| `rm -rf node_modules; npm ci` in both apps | recreates `node_modules/@ziyixi/edge-auth -> ../../../../packages/edge-auth` from the lockfile |
| workerd probe (Miniflare, compat 2026-09-08) | imported RSA JWK `algorithm.modulusLength = 2048`; HKDF → HMAC usages `sign,verify`; `Uint8Array.fromBase64` and `crypto.subtle.timingSafeEqual` present |
| Node 26 probe | `modulusLength` present; `crypto.subtle.timingSafeEqual` **absent** |

## 7. Repository and CI changes (for the implementation commit)

**`ci_changes.py`**

- Add the output `edge_auth_check`.
- Map each package to the apps that compile it in:
  `PACKAGES = {"edge-auth": ("todofy", "mail-hero")}`.
- `classify`: a path `packages/<name>/…` (three or more components) marks every consumer of
  `<name>` as changed, so each is **checked and deployed**, and `contracts` runs as for any app
  change.
  - An unmapped package name marks both apps (fail safe).
  - A file directly under `packages/` counts as root documentation (gate only).
  - `edge_auth_check = "edge-auth" changed or contracts/ or .github/ changed`.
- `dispatched()` and `everything()` set `edge_auth_check`.
- Docstring rule: an app's own directory, or a package it uses, checks and deploys it.

**`test_ci_changes.py`**

- Extend `expect()` with the new key.
- Add tests:
  - a package change checks and deploys both apps and runs the package job;
  - a package README change does the same (any change in the package counts);
  - an unmapped package runs both apps;
  - `packages/README.md` runs only the gate;
  - dispatch runs the package job.
- Add a consistency test. It scans every `package.json` under `todofy/` and `mail-hero/` (outside
  `node_modules`) for `file:` specs into `packages/<name>`. It asserts that the consumers equal
  `PACKAGES[name]` and that every `packages/*/` directory is mapped.

**`ci.yml`**

- `changes.outputs.edge_auth_check`.
- A new job `edge-auth` ("Edge auth package"):
  - `needs: changes`, `if: needs.changes.outputs.edge_auth_check == 'true'`;
  - checkout (`persist-credentials: false`), then `setup-node` 26 with
    `cache-dependency-path: packages/edge-auth/package-lock.json`;
  - working directory `packages/edge-auth`: `npm ci`, `npm run typecheck`, `npm test`.
- `gate.needs` adds `edge-auth`, and its result loop adds `"Edge auth package=$EDGE_AUTH"`.
- The deploy jobs' `if:` stays in the explicit shape and needs no new term, since they require
  `gate`.
- No production secret reaches the new job.

**Docs**

- Root `AGENTS.md`:
  - shared code lives only in `contracts/` and `packages/`;
  - packages never import an app, and apps never import each other;
  - packages are compiled into each Worker through `file:` and are never deployed as a Worker;
  - `packages/edge-auth` has no runtime dependencies;
  - a package change checks and deploys every app that uses it;
  - an app-visible auth behaviour is a documented parameter (this SPEC §4), and changing an app's
    value is a behaviour change in that app.
- Root `README.md`:
  - a `packages/edge-auth` row in the table;
  - the rules;
  - the CI table: the new job, the "runs when" of both check and deploy rows, and the sentence
    "a change to `packages/edge-auth/` checks and deploys both apps".
- `packages/edge-auth/README.md`: short usage notes that point here.
- Mail Hero:
  - `AGENTS.md` §4, the Access/CSRF paragraph: implemented by `packages/edge-auth` with Mail Hero's
    parameters, and the cookie and HKDF key unchanged;
  - §8 repository boundary;
  - `cloudflare/README.md` line 10;
  - `docs/verification-native.md` only after the new tests actually pass.
- Todofy:
  - `docs/gateway-contract.md` §2.3–2.5 (the adapters, the tightenings #9–#14, and a parameter table
    in place of the "Compared with Mail Hero's security.ts" paragraph);
  - `docs/dev-notes.md` lines 63, 201 and 421–427.

## 8. Tests

- **Package** (`node --test`, no dependencies; tokens signed with WebCrypto):
  - every row of §2.2 under both app policies;
  - the claim edges `exp = now` / `now+1`, `iat = now+59` / `now+60`, and `nbf` at `now + leeway`
    and `+1`;
  - `crit`, missing or empty `kid`, a 1024-bit key, and JWK `use: enc`, `alg: RS512`,
    `key_ops: ['sign']`, a duplicate kid and a non-object member;
  - certs answering 302, 500, non-JSON, a throw or a timeout → `keys_unavailable`;
  - cache TTL and cooldown with an injected fetch and a mocked `Date.now`;
  - token source: header, empty header, first/last cookie, 16,000/16,001 characters;
  - config normalisation and fail-closed cases (nine aliases, 2049 characters, non-email owner,
    issuer trailing slashes, loopback issuer only when allowed);
  - dev bypass for both host rules, with `cf-ray`, and `refuse` vs `verify`;
  - CSRF: the three golden vectors, round trips with both nonce styles, every failure case from
    both apps' tests, the Secure flag, issue with a key that throws, and `key_unavailable` ordering;
  - headers byte for byte.
- **Mail Hero:**
  - `native-api.test.mjs` passes `createAccessVerifier({ fetch })` (serving a JWKS whose JWK carries
    a `kid`) instead of jose's resolver, and signs with `setProtectedHeader({ alg: 'RS256', kid })`
    and `generateKeyPair('RS256', { extractable: true })`;
  - new assertions: future `iat`, empty `sub` and a missing `kid` → 401; certs failure → 401 with
    "Access 登录无效或无权限"; the golden vector accepted through `handleAPI`;
  - the workerd runtime tests run unchanged.
- **Todofy:**
  - `access.test.ts` and `owner.test.ts` keep every case;
  - add `crit`, a small modulus, 302 certs → 503 `unavailable`, `use: enc`, and the two golden
    vectors;
  - `tests/runtime/test_access.py` runs unchanged against workerd.

## 9. Rollout, verification, rollback

- One implementation commit (package, both adapters, CI and docs) on a branch. The branch gate runs
  the package job and both apps' checks. On `main`, `Changes` deploys both apps, each in its own
  concurrency group.
- Browser state survives the deploy. CSRF keys, formats and cookies are unchanged (the golden
  vectors are asserted by tests). Access sessions are Cloudflare's cookies and are untouched.
  Preview tokens stay on Mail Hero's own code.
- The tightenings (#6–#12, #14, #19, #20) should be invisible for real Access tokens, but this has
  not been verified here: this work had no Cloudflare access. After the deploy, the owner opens both
  UIs and makes one write in each (for example a Mail Hero settings save and a Todofy dismiss), with
  the primary login and, where configured, an alias login. A 401 on either means reverting the
  commit, which redeploys both apps, and comparing the real token's header and claims (never
  logged) against §2.2.
- Open owner decisions: #27 (Origin case for Mail Hero), and the optional later unifications #16
  (Todofy JWKS TTL down to 10 min) and #17 (token source).
