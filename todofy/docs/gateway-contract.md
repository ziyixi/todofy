# Gateway contract: `todofy` (TypeScript) ↔ `todofy-core` (Python Durable Object)

Status: as built. First derived from the single Python Worker at `c0d80c6` (its `hooks.py`,
`owner.py`, `csrf.py` and `access_jwt.py` are now `gateway/src`) and the OpenAPI document of that time,
then updated to match the code after review. Since 2026-10-02 the owner API is todofy.ui.v1
(`proto/todofy/ui/v1`, §2.2 and §3.5) and `api/machine-api-v1.openapi.yaml` describes the machine routes only. Where this file and the code disagree, fix one of them
in the same change.

Why the split: on Workers Free a plain Worker invocation has 10 ms of CPU and Pyodide alone costs 5–9 ms
per request, while a Durable Object invocation (fetch or alarm) has 30 s. The gateway does only cheap edge
work (~1 ms); everything that touches D1, parses mail or calls Gemini/Todoist runs in the DO.

Public behaviour does not change: status codes, error envelopes, bodies, headers, the OpenAPI contract,
Mail Hero and newsletter compatibility and the UI stay as they are. The runtime scenarios in
`tests/runtime` are the parity oracle and run through the gateway. Intended public changes: the
long-lived cache header on hashed assets (§2.3, with its own runtime test), two Access claims the
Python check did not require (`nbf`, `sub`; §2.4), which real Access tokens always carry, and the DO's
error envelopes, now built by the gateway (§3): the same fields and values, serialised compactly
(`{"error":{"code":…}}`) instead of with Python's `", "`/`": "` separators. Success bodies keep the
DO's bytes.

## 1. The two Workers

| | `todofy` (gateway) | `todofy-core` |
|---|---|---|
| Language | TypeScript (strict, ES modules), `gateway/` | Python (Pyodide), `worker/`, pywrangler |
| Public entry | custom domains: owner host + every `TODOFY_HOOKS_HOSTS` name; cron `*/10 * * * *` | none (`workers_dev = false`, `preview_urls = false`, no routes); the object's RPC methods (§3) for the gateway's binding; every `fetch` answers 404 `not_found` (for the RPC release only, the previous gateway's calls get 503, §6.4) |
| Bindings | `ASSETS` (`uiassets/dist`), `COORDINATOR` → class `TodofyCore` in script `todofy-core`, `METRICS` (Analytics Engine `todofy_metrics`, one point per request and cron; dev-notes.md §6) | `DB` (D1 `todofy`), `BACKUPS` (private R2 bucket `todofy-backups`, weekly D1 backups; it holds mail content), `METRICS` (the same dataset, one point per upstream step). No DO binding: nothing in core calls the DO through a stub any more |
| Vars | `TODOFY_PUBLIC_HOST`, `TODOFY_HOOKS_HOSTS`, `BUILD_SHA`, `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `MAINTENANCE_MODE`; dev/test only: `DEV_AUTH_BYPASS`, `DEV_ACCESS_LOOPBACK_ISSUER`, `JWKS_REFRESH_COOLDOWN_MS` | `BUILD_SHA`, `MAINTENANCE_MODE`, `TODOFY_PUBLIC_HOST` (the reminder's link), `PROCESSING_PAUSED`, `FORCE_PAUSE_TODOIST`, `REMINDER_ENABLED`, `GTD_REVIEW_ENABLED`, `MAIL_SOURCE_ID`, `GEMINI_API_BASE`, `GEMINI_MODELS`, `GEMINI_TIMEOUT_MS`, `GEMINI_DAILY_TOKEN_BUDGET`, `TODOIST_API_BASE`, `TODOIST_DEFAULT_PROJECT_ID`, `TODOIST_OPS_PROJECT_ID` and `TODOIST_REVIEW_PROJECT_ID` (optional), `TODOIST_ATTEMPT_TIMEOUT_MS`, `LOOKUP_DELAY_MS`, `BACKOFF_BASE_MS`, `WATCHDOG_MS`, `REPORT_DEFAULT_TOP`, `REPORT_PRECOMPUTE_UTC`, `REPORT_CARRYOVER_DAYS`, `GTD_COLLECT_UTC`, `GTD_PAGE_TIMEOUT_MS` (tests), `LEGACY_TEXT_RETENTION_DAYS`; optional, unset in production: `TASK_INTENT_SOURCES` (§3.8) |
| Secrets | `MAIL_WEBHOOK_TOKEN_SHA256`, `MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS`, `REPORT_BASIC_AUTH_SHA256`, `CSRF_SIGNING_KEY`, `ACCESS_OWNER`, `ACCESS_OWNER_ALIASES` (the last two from `--secrets-file` on every deploy) | `GEMINI_API_KEY`, `TODOIST_API_KEY` |
| DO class | none: migration `v2` deleted the Python-era `TodofyCoordinator` in a gateway-only release (§6.6) | `TodofyCore` (renamed from `TodofyCoordinator` by core migration `v2`), instance name `inbox-v1`, SQLite-backed |

`BUILD_SHA` and `MAINTENANCE_MODE` are set on both from the same deploy value. The gateway never binds
or queries D1. `gateway/package.json` has its own lockfile with `typescript` and
`@cloudflare/workers-types` (plus a test runner if unit tests are added); it does not pin its own
wrangler: the root wrangler 4.142.0 bundles and deploys both Workers, so one wrangler version serves
both configs.

## 2. Public routes: who does what

Every gateway request first gets a request ID (§4). Unknown host → 404 `not_found` (plain JSON headers,
no DO call). Host matching is on `new URL(request.url).hostname` lowercased; the public host is checked
before the hooks hosts. After routing, a request body that nothing read (an answer given on the headers
alone: 401, 403, 404, 413, 415, 503) is cancelled; a body passed to the DO or to `ASSETS` is locked by
then and left alone. Found by the runtime suite: `wrangler dev` holds such an answer until the body is
consumed, so the headers-only 413 never arrived.

Gateway JSON responses use exactly these headers: `content-type: application/json; charset=utf-8`,
`cache-control: no-store`, `x-content-type-options: nosniff`. Every error body, the DO's included, is
`{"error": {"code", "message", "request_id"}}` built by the gateway with its request ID; the message is
the DO's for DO errors and from the gateway's copy of `core/api_errors.MESSAGES` for its own codes (a
unit test compares the copy with the Python table).

### 2.1 Hooks hosts (`TODOFY_HOOKS_HOSTS`, no Access)

| Request | Gateway | DO |
|---|---|---|
| `GET /health` | `200 {"build": BUILD_SHA or "unknown", "service": "todofy", "status": "healthy", "timestamp": "YYYY-MM-DDTHH:MM:SSZ"}`. Never calls the DO (the newsletter preflight reads `service`/`status`) | — |
| `POST /hooks/mail` | in this order: no digest configured → 503 `not_configured`; Bearer check → 401 `unauthorized` (no `www-authenticate`); `MAINTENANCE_MODE` → 503 `maintenance` + `retry-after: 600`; media type ≠ `application/json` → 415 `unsupported_media_type`; declared `Content-Length` all digits and > 1,048,576 → 413 `payload_too_large`; then pass the unread body stream to DO `ingest`. Call throws → 503 `unavailable` | `ingest` (§3.1) |
| `GET /api/summary`, `GET /api/recommendation` | `REPORT_BASIC_AUTH_SHA256` empty → 503 `not_configured`; Basic check fails → §5; passes → DO `newsletter(kind, query)` with the original query string. Call throws → 503 `unavailable` | `newsletter` (§3.3) |
| anything else (incl. `HEAD`) | 404 `not_found` | — |

Bearer check (hooks.py `_bearer_ok`): digests = trimmed, lowercased, non-empty values of
`MAIL_WEBHOOK_TOKEN_SHA256` and `..._PREVIOUS`. Split `authorization` at the first space; scheme must be
exactly `Bearer`, token non-empty with no space. SHA-256 hex of the token's UTF-8 bytes, compared in
constant time with every digest (never short-circuit on the first match). Media type =
`content-type` before `;`, trimmed, lowercased.

Basic check (reports.py `_basic_ok`): digests = `REPORT_BASIC_AUTH_SHA256` split on `,`, trimmed,
lowercased, empties dropped. Split `authorization` at the first space; scheme compared
case-insensitively with `basic`; the rest trimmed and strictly base64-decoded (standard alphabet,
correct padding, anything else is a failure); SHA-256 hex of the decoded bytes, constant-time against
every digest.

### 2.2 Owner host (`TODOFY_PUBLIC_HOST`, behind Access)

Gate order for every request, assets included (`gateway/src/owner.ts`):

1. Access JWT (§2.4). Failure → a google.rpc.Status (`UNAUTHORIZED`, `UNAVAILABLE` or
   `ACCESS_NOT_CONFIGURED`), or the old envelope on a path of the old owner API (below).
2. A path of the owner API before todofy.ui.v1 (`/api/v1/overview`, `/api/v1/events[/{id}[/reconcile]]`,
   `/api/v1/csrf`, `/api/v1/setup`, `/api/v1/reminders`, `/api/v1/reports/{latest,recompute}`,
   `/api/v1/metrics/daily`, `/api/v1/gtd/daily`, `/api/v1/legacy_text/{id}`) → 410 `reload_required` in the old
   envelope (`{"error":{"code","message","request_id"}}`, "Todofy 已更新，请刷新页面"), any method, so a tab still
   running the previous UI tells the owner to reload. For this release only; the next one answers them 404 like
   any other path.
3. `/api/csrf`: `GET` → the gateway issues (§2.5); any other method → 405 `METHOD_NOT_ALLOWED` with `allow: GET`.
   It is the API's transport, not a method of the service.
4. `/api/v1/*`: the owner API, TodofyUiService (`proto/todofy/ui/v1`, `gateway/src/ui.ts`), served by the shared
   transcoder (`proto/ts/http-transcoder.ts`) from the generated descriptors' `google.api.http` bindings.
   For every method but `GET` its `authorize` hook runs before the body is read: CSRF verify (§2.5), then
   `MAINTENANCE_MODE` → 503 `MAINTENANCE` with `retry-after: 300`. The transcoder refuses a body over 16 KiB
   (`MAX_BODY_BYTES`) and reads every request strictly; each rpc is one DO `owner_ui` call (§3.5), but
   `GetIntegration`, which the gateway composes from its vars and the DO's `setup()` (§3.6). A path or method
   no binding matches → 404 `NOT_FOUND` (405 for a known path with another method). A throwing call → 503
   `UNAVAILABLE`.
5. Other `/api/*` → 404 `NOT_FOUND` without a DO call.
6. Otherwise `env.ASSETS.fetch(request)` (SPA fallback via `not_found_handling`; a POST gets the asset
   server's 405).
7. Every response (errors, assets, DO answers) leaves with the private headers (§2.3).

Errors of the API are google.rpc.Status bodies (`ErrorInfo` with the reason and the domain
`todofy.ziyixi.science`, `RequestInfo` with the gateway's request ID, `LocalizedMessage` zh-CN), logged as one
line of request ID, status and reason. Its own reasons are `proto/todofy/ui/v1/errors.proto`'s (`ETAG_MISMATCH`,
`ACTION_NOT_ALLOWED`, `REQUEST_ID_REUSED`, `RATE_LIMITED`, `MAINTENANCE`); the rest are `common.errors.v1`'s.

The previous gateway's `owner_api` path (§3.5) still reads its bodies with the old rule (declared
`Content-Length` non-numeric or > 16 KiB, or a body > 16 KiB → 400 `invalid_request`, read with
`interop.read_capped`, `tests/runtime/test_owner_body_limit.py`) until it is removed next release.

### 2.3 Private headers (owner host)

Implemented by the shared package `packages/edge-auth` (`withPrivateHeaders` with its `STRICT_CSP`,
which is Todofy's string byte for byte); `gateway/src/http.ts` only decides the cache exception.

Copy the response (`new Response(body, response)`) and set: `cache-control: no-store`,
`x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY`,
`content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'` (http.py `PRIVATE_HEADERS`, byte-identical; `gateway/test/owner.test.ts` pins
the bytes).

The one exception: a path under `/assets/` served by `ASSETS` with status 200 and a `content-type` that
is not `text/html` gets `cache-control: private, max-age=31536000, immutable` in place of `no-store`.
A missing `/assets/x.js` falls back to `index.html` (200, `text/html`) and keeps `no-store`. The
other four headers apply unchanged.

### 2.4 Access JWT (`access.ts` → `packages/edge-auth`)

The verification is the shared package's `createAccessVerifier` (`packages/edge-auth/SPEC.md` §5.1),
compiled into this Worker through the `file:../../packages/edge-auth` dependency; it is never a
separate Worker. `access.ts` holds one verifier per isolate, passes Todofy's policy values and maps
the package's failure reasons to Todofy's codes. Todofy's values:

| Parameter | Todofy's value |
| --- | --- |
| `emailMatch` | `case-insensitive`: the owner and aliases are lowercased, and so is the token's `email`, ASCII letters only (`asciiLowerCase`); a non-ASCII owner or alias is `not_configured`, a non-ASCII token `email` is refused |
| `nbfLeewaySeconds` | 60 |
| `tokenSource` | header, or when it is absent or empty the **last** `CF_Authorization` cookie |
| `jwks` | TTL 1 h; unknown-kid refetch cooldown `JWKS_REFRESH_COOLDOWN_MS` (default 60,000; a value at or above the TTL is capped to it, which behaves the same) |
| `loopbackIssuer` | `TODOFY_PUBLIC_HOST` ends with `.localhost` and `DEV_ACCESS_LOOPBACK_ISSUER == "true"` |
| `devBypass` | enabled when `TODOFY_PUBLIC_HOST` ends with `.localhost` and `DEV_AUTH_BYPASS == "true"`; hosts `*.localhost`; principal `ACCESS_OWNER` ASCII-lowercased (`asciiLowerCase`, the verifier's fold); not local (a `cf-ray` header) → normal verification |

| Package result | Todofy answer |
| --- | --- |
| owner | the canonical owner, `ACCESS_OWNER` trimmed and lowercased (an alias maps to it) |
| `not_configured` | 503 `access_not_configured` |
| `keys_unavailable` | 503 `unavailable` |
| `missing_token`, `invalid_token` | 401 `unauthorized` |

The rules, as the package applies them with these values:

- Dev bypass: the flag rule above and no `cf-ray` header → owner = `ACCESS_OWNER` ASCII-lowercased. Otherwise
  the flag is ignored.
- Configuration: `ACCESS_ISSUER` trimmed, without trailing `/`, matching
  `^https://[a-z0-9-]+\.cloudflareaccess\.com$`; or, only under the loopback rule above,
  `^http://127\.0\.0\.1:\d{1,5}$`. `ACCESS_AUDIENCE` non-empty. `ACCESS_OWNER` and every
  `ACCESS_OWNER_ALIASES` entry an e-mail address (`^[^\s@]+@[^\s@]+\.[^\s@]+$`, as
  `deploy/deploy_vars.py` requires at deploy) of printable ASCII only; aliases at most 2048 characters and 8 entries. Otherwise 503
  `access_not_configured`, before the token is read.
- Token: `cf-access-jwt-assertion` header, else the last `CF_Authorization` cookie; missing or longer
  than 16,000 characters → 401 `unauthorized`. Three base64url parts, header and payload JSON objects;
  header `alg == "RS256"`, `kid` a non-empty string and no `crit` member; else 401.
- Keys: per-isolate cache `issuer → (fetched_at, {kid: CryptoKey})` from `<issuer>/cdn-cgi/access/certs`
  (`GET`, 5 s timeout, redirects **not** followed). Only RSA members with a `kid`, `use` absent or
  `sig`, `alg` absent or `RS256`, `key_ops` absent or containing `verify`, imported as
  `RSASSA-PKCS1-v1_5`/`SHA-256` with a modulus of at least 2048 bits; a kid listed twice is dropped;
  a non-object member is skipped. Use the cache for 1 h; an unknown kid refetches at most once per
  cooldown. Certs fetch non-200 (a redirect included), failing or not JSON → 503 `unavailable`.
  Unknown kid after that → 401.
- Claims: `iss` equal to the issuer; `aud` (string or array) contains `ACCESS_AUDIENCE`; finite numeric
  `exp` > now; finite numeric `iat` < now + 60 s; `nbf` absent or finite numeric ≤ now + 60 s; `sub` a
  non-empty string; string `email` whose lowercase is `ACCESS_OWNER` or one of the aliases. Any
  failure → 401.
- What the shared package tightened when Todofy adopted it (none of it changes a real Access token's
  outcome: Access signs RS256 with a `kid`, publishes `use: sig`/`alg: RS256` 2048-bit keys once each
  and answers the certs with a 200): a `crit` header is refused, the JWK filters and the 2048-bit
  minimum above, a duplicate kid is dropped rather than the last one winning, the certs redirect is no
  longer followed (503), numeric claims must be finite, and owner/aliases must be e-mail addresses.
  A `CF_Authorization` pair without `=` in a hand-built `Cookie` header is ignored rather than read as
  an empty value.
- Mail Hero uses the same package with its own values (exact e-mail match, `nbf` without leeway, the
  first cookie, a 10-minute cache); `packages/edge-auth/SPEC.md` §4 lists every parameter and why.

### 2.5 CSRF (`csrf.ts` → `packages/edge-auth`)

`csrf.ts` resolves the key and the allowed origins and calls the package's `issueCsrf`/`verifyCsrf`
(SPEC §5.2) with the cookie name `todofy_csrf` and the package's default nonce and TTL. The token
format, key and cookie are unchanged, so tokens already in browsers stay valid
(`gateway/test/owner.test.ts` accepts the golden tokens from SPEC §3.1).

- Key: `CSRF_SIGNING_KEY` trimmed must match `^[0-9a-fA-F]{64}$`, used as 32 raw bytes for HMAC-SHA256
  (`importHmacKeyHex`). Missing or malformed → 503 `NOT_CONFIGURED` on `GET /api/csrf` and on every
  write, checked before anything else (reads keep working).
- Issue (`GET /api/csrf`; `GET /api/v1/csrf` until todofy.ui.v1): claims `{"kind":"csrf","owner":<owner>,"nonce":<16 random bytes
  base64url>,"exp":<now s + 43200>}` as compact JSON in that key order; token =
  `b64url(claims) "." b64url(HMAC(key, b64url(claims)))`, no padding. Body `{"token": token}`; header
  `set-cookie: todofy_csrf=<token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` plus `; Secure`
  when the request URL is `https:`.
- Verify (every method of the owner API but `GET`, in the transcoder's `authorize` hook): `origin` lowercased must be `https://<TODOFY_PUBLIC_HOST
  lowercased>`, or under the `.localhost` rule also `http://<request URL host:port lowercased>`;
  `x-csrf-token` non-empty, ≤ 1024 characters, equal to the first `todofy_csrf` cookie value;
  signature text equal to the recomputed canonical one; payload a fatal-UTF-8 JSON object with
  `kind == "csrf"`, `owner` equal to the canonical owner and an integer `exp` > now. Any failure →
  403 `csrf_failed`. Compares are constant-time over the UTF-8 bytes (the package's own XOR loop;
  only the length can leak). Tokens minted by the Python code (and by the tests' `mint_csrf`) verify
  unchanged. A failure is 403 `CSRF_FAILED` on the owner API (the UI renews its token once on it).

## 3. The DO's RPC methods

The gateway calls methods of `TodofyCore` over JS RPC on `env.COORDINATOR.getByName("inbox-v1")`
(`gateway/src/coordinator.ts`, `worker/todofy/runtime/coordinator.py`). The object has no HTTP routes:
its `fetch`, like the `Default` entrypoint's, answers 404 `not_found` to every request. Arguments are
chosen by the gateway, so client headers (`x-todofy-*`, `cookie`, `authorization`,
`cf-access-jwt-assertion`, `origin`, `x-csrf-token`) never reach the DO. Nothing generates the TS
interface `Coordinator` from the Python class; the two are kept in step by hand, and the runtime
scenarios in `tests/runtime` run the real pair.

Every method that answers a request returns one result type, `http.Result.wire()` in Python and
`CoreResult` in TS:

```
{"status": int,
 "body": str | null,                         # the JSON text of a 200, serialised by the DO
 "error": {"code": str, "message": str} | null,  # set exactly when status >= 400
 "retry_after": int | null}                  # seconds, for a 429
```

The gateway turns it into the response: an error becomes the standard envelope with the gateway's
request ID (`errorEnvelope`, which also logs it) plus `retry-after` when set; a 200 keeps the DO's JSON
text byte for byte (Python's `json.dumps(..., ensure_ascii=False)` separators) with the JSON headers;
a 204 has no body and no headers. Why a value and not an exception: a Python exception reaches TS only
as `Error{name: "PythonError", message: <traceback>}`, with any `status` or `code` attribute lost. So
every expected outcome is a result, and a thrown call (stub failure, a storage failure in `wake`, a
bug) is the gateway's 503 `unavailable`. A D1/storage `JsException` inside a method that returns a
`CoreResult` is a 503 `unavailable` result (today's `except JsException`).

Python exposes every method of the class over RPC, including `_`-prefixed helpers and the budget
helpers; only the gateway binds the class and it calls only the methods below (`owner_api` only the gateway
before todofy.ui.v1) and the four `ops_*` methods of §3.7. `alarm` is reserved and
cannot be called.

`MAINTENANCE_MODE` in the DO (defence in depth; the gateway refuses first with a `retry-after`):
`ingest`, every `owner_api` call with method `POST` → 503 `maintenance` without `retry_after`, and every
`owner_ui` write (`ReconcileMailEvent`, `RecomputeReport`) → `MAINTENANCE`; a
newsletter request that needs an on-demand computation → 503 `maintenance` (today's DO `/report`
guard). The alarm loop's maintenance check is unchanged.

### 3.1 `ingest(idempotency_key: str | null, body: ReadableStream) -> CoreResult`
`idempotency_key` is the `Idempotency-Key` header verbatim, null when absent (repeated headers arrive
joined with `, ` and fail the UUID match). `body` is the original request stream, unread; the DO stops
reading at 1 MiB for chunked bodies. Results as today: 204 (stored or same bytes; a new event wakes the
loop), 400 `invalid_payload` (contract, or key ≠ `event_id`), 409 `event_conflict`, 413
`payload_too_large`, 503 `maintenance`/`unavailable`.

### 3.2 `wake() -> None`
From `scheduled()`. The gateway awaits it; an exception fails the cron invocation (visible in Workers
Logs), as today.

### 3.3 `newsletter(kind: "summary" | "recommendation", query: str) -> CoreResult`
Called only after the gateway accepted the Basic credential; `query` is the original query string
without `?`. Another `kind` → 404 `not_found`. The DO runs today's `reports.serve` minus the auth part:
parse `top` (recommendation only; `parse_top_n`) → 400 `invalid_request`; a stored report computed since
the latest precompute time with status `ok`/`empty_window` → 200 with its stored JSON; otherwise compute
on demand in-process (40 s budget, hourly cap) → 200, 429 `rate_limited` with `retry_after` = seconds to
the next UTC hour, or 503 `unavailable`/`maintenance`; a computed payload whose status is not servable
→ 503 `unavailable`.

### 3.4 `newsletter_auth_failure() -> CoreResult`
Called by the gateway only after a failed Basic check (§5). The DO reads `auth_failures` for the current
UTC hour: count ≥ 20 → 429 `rate_limited` with `retry_after` = seconds to the next UTC hour (no write);
else increment and → 401 `unauthorized`, to which the gateway adds `www-authenticate: Basic
realm="todofy"`.

### 3.5 `owner_ui(owner, method, request, cursor) -> {"ok", "next_cursor"} | {"error", "detail", "retry_after"}`
The owner API todofy.ui.v1 (`worker/todofy/runtime/owner_ui.py`, the mapping to the generated messages in
`core/owner_ui.py`). `owner` is the canonical owner after Access (not an address → `UNAUTHORIZED`); `method`
the rpc's name (`ListMailEvents`); `request` the decoded request as wire JSON text, which the DO reads strictly
again with the generated Python code (it trusts no field the gateway passes); `cursor` the JSON text of the
cursor the gateway took from the request's page token, or null. The gateway owns the page tokens (AIP-158:
`proto/ts/page-token.ts`, bound to the request's other fields, so a token reused with another filter is
`BAD_REQUEST`), and makes up a `request_id` for a write that lacks one (AIP-155; the UI always sends one).
The answer is a plain object, never an exception for an expected outcome:

```
{"ok": <the response message as wire JSON text>, "next_cursor": <JSON text> | null}
{"error": <ErrorInfo reason>, "detail": <a MailEvent as wire JSON text> | null, "retry_after": int | null}
```

The gateway reads `ok` leniently with the generated TypeScript code and writes the response; a refusal becomes
the Status of its reason (`INTERNAL` for one the gateway does not know), with the event as a detail
(`ETAG_MISMATCH` and `ACTION_NOT_ALLOWED` answer the event as it is now) and `retry-after`. D1 or storage
failures (a `JsException`) are `UNAVAILABLE`, which the UI may repeat with the same `request_id`; so is a write
while a backup holds the ledger (`backup.holds_ledger`). Any other Python exception, including an answer the
codec refuses to write, is a bug: `owner_ui` answers `INTERNAL` (500, never repeated by a client) and logs only
the rpc's name and the exception's type. Only a failed RPC call itself (the object down, a deploy in progress)
reaches the gateway as an exception, answered 503 `UNAVAILABLE`.

| rpc (`google.api.http`) | The DO's work |
|---|---|
| `GetServiceStatus` `GET /api/v1/serviceStatus` | D1 counts + DO budgets, in-process (the old overview) |
| `ListMailEvents` `GET /api/v1/mailEvents?page_size&page_token&filter` | 50 by default, at most 100; `filter` is one AIP-160 restriction, `state = TODO_UNKNOWN` (newest first) or `attention = true` (oldest first), parsed by `core/owner_ui.event_filter` |
| `GetMailEvent` `GET /api/v1/mailEvents/{id}` | the event, its transitions and allowed actions; a name that is not a UUID → `NOT_FOUND` |
| `ReconcileMailEvent` `POST /api/v1/mailEvents/{id}:reconcile` | `etag` is the event's version; replays and conflicts via `owner_actions` keyed by `request_id` (`REQUEST_ID_REUSED`) |
| `ListDailyReminders` `GET /api/v1/dailyReminders` | 50 by default, at most 100 |
| `GetLatestReports` `GET /api/v1/latestReports` | the stored reports, read leniently (one the codec cannot read is left out and logged) |
| `RecomputeReport` `POST /api/v1/latestReports:recompute` | `RATE_LIMITED` with `retry_after`; a computed report replays via `owner_actions`, a failure releases the claim so the same `request_id` computes again |
| `ListMetricDays` `GET /api/v1/metricDays` | newest first, 30 by default, at most 90 |
| `ListGtdDays` `GET /api/v1/gtdDays` | newest first, 30 by default, at most 120 |
| `ListGtdReviews` `GET /api/v1/gtdReviews` | the last 12 weeks, newest first |
| `GetLegacyText` `GET /api/v1/legacyTexts/{id}` | an event's or an imported cache row's text (up to about 1.9 MB) |

### 3.5.1 `owner_api(owner, method, path, query, content_length, body) -> CoreResult` (previous gateway only)
The owner API before todofy.ui.v1, kept for one release so that the previous gateway keeps working while CI
deploys this core before the new gateway (§6.4); the next release removes it with `runtime/api.py`'s routes.
`owner` is the canonical owner after Access (not an address: `@` missing or over 254 characters → 401
`unauthorized`); `method` and `path` as received (`HEAD` included); `query` without `?`;
`content_length` the declared header or null (`api._json_body` checks it before reading); `body` the
unread stream of a write, null for `GET`/`HEAD`. The DO serves exactly today's `api._route`:

| Method, path | Result |
|---|---|
| `GET /api/v1/overview` | Overview (D1 counts + DO budgets, in-process) |
| `GET /api/v1/events?view&state&limit&cursor` | EventPage; 400 `invalid_request` |
| `GET /api/v1/events/{id}` | EventDetail; 404 |
| `POST /api/v1/events/{id}/reconcile` | EventDetail; 400/404/409 (`version_conflict`, `action_not_allowed`, `action_request_conflict`) |
| `GET /api/v1/reminders?limit&cursor` | ReminderPage; 400 |
| `GET /api/v1/reports/latest` | ReportsLatest |
| `POST /api/v1/reports/recompute` | report; 400/409/429 (`retry_after`)/503; replays via `owner_actions` |
| `GET /api/v1/legacy_text/{id}` | LegacyText; 404 |
| anything else, incl. `/api/v1/csrf`, `/api/v1/setup`, `HEAD` | 404 `not_found` |

### 3.6 `setup() -> {"mail_source_id": str, "configured": {"gemini_api_key": bool, "todoist_api_key": bool, "todoist_project": bool}}`
Core-side facts, never values; a plain object, not a `CoreResult`. Not blocked by maintenance. The
gateway answers `GetIntegration` (`GET /api/v1/integration`) with the `Integration` message (fields named the same): `build` (gateway `BUILD_SHA` or
`unknown`), `public_host` (lowercased), `hooks_hosts` (csv lowercased), `webhook_path: "/hooks/mail"`,
`mail_source_id` (DO), `access_owner` (canonical owner), `configured` = `{mail_webhook_token:
MAIL_WEBHOOK_TOKEN_SHA256 non-empty, report_basic_auth: REPORT_BASIC_AUTH_SHA256 non-empty}` merged with
the DO's `configured`. Call throws → 503 `UNAVAILABLE`.

### 3.7 The `Ops` entrypoint and the `ops_*` methods (contracts/ops-v1)
`gateway/src/index.ts` also exports the named `WorkerEntrypoint` class `Ops` (`gateway/src/ops.ts`),
which a dashboard Worker in the same account binds with `[[services]] service = "todofy" entrypoint =
"Ops"`. It is not an HTTP route and has no Access check: only a Worker deployed in this account can
create the binding. The default `fetch`/`scheduled` handlers are unchanged. Each `Ops` method calls one
object method; structured inputs travel as JSON text, and the object answers `{"ok": value}` or
`{"error": "invalid_input" | "busy" | "unavailable"}` (never an exception), which `Ops` returns or
rejects as `new Error(code)`. A thrown call (object down, Python exception) rejects `unavailable`.

| `Ops` method | Object method | Gateway checks first |
|---|---|---|
| `status()` | `ops_status()` | – |
| `setGuard(input)` | `ops_set_guard(json)` | input JSON-serialisable |
| `canaryResult(eventId)` | `ops_canary_result(event_id)` | a string |
| `reportOps(report)` | `ops_report(json)` | compact JSON ≤ 8 KiB |

The object validates everything against the contract's rules (`core/ops.py`) and serves these in
maintenance mode too. Vitest runs `Ops` in Node through a stand-in for `cloudflare:workers`
(`gateway/test/cloudflare-workers.ts`, aliased in `vitest.config.ts`); `tests/runtime/test_ops.py`
calls the real entrypoint over a service binding (`tests/runtime/ops_support.py`). The root CI's
`Contracts` job runs `test/ops.test.ts` next to both apps' ops-v1 schema checks, so a change under
`contracts/` re-checks this forwarding; the runtime test runs in the `Todofy runtime` shards.

### 3.8 task-intent-v1 on the same entrypoint (contracts/task-intent-v1)
`Ops` also implements `WireService<typeof TaskIntentService>`, the generated service of
`proto/todofy/taskintent/v1/task_intent.proto` as Workers RPC methods (types only: the gateway bundles none of
the generated code and passes the wire JSON through): another app in the account (today only Lab, binding `TODOFY` →
`todofy`/`Ops`) proposes Todoist tasks, and Todofy stays the only Todoist writer. Same forwarding, same
error codes, same trust boundary as §3.7.

| `Ops` method | Object method | Gateway checks first |
|---|---|---|
| `proposeTasks(intent)` | `task_intent_propose(json)` | input JSON-serialisable, compact JSON ≤ 64 KiB |
| `taskIntentStatus(ref)` | `task_intent_status(json)` | input JSON-serialisable, compact JSON ≤ 64 KiB |

The same two methods, and nothing else, are on a second named entrypoint, `Intents` (`gateway/src/ops.ts`,
exported next to `Ops`). A binding names its one source in `props` (`entrypoint = "Intents"`, `props = { source =
"watch" }`, the watch app's), and `Intents` rejects `invalid_input` before the object wakes when the input's
`source` differs or the binding has no such prop. So a proposer bound to it can use only its own source's URL
allow-list and daily quota and cannot reach `status()`, `setGuard()`, `canaryResult()` or `reportOps()`. Lab
still binds `Ops`. The runtime suite's probe binds both (`tests/runtime/ops_support.py`).

The object (`runtime/intents.py`, rules in `core/intents.py`) reads the input strictly with the wire JSON
codec and checks the schema's value rules (`invalid_input` otherwise), records a new intent in D1 (`task_intents`, `task_intent_tasks`,
migration `0005_task_intents.sql`) and answers `pending`; its alarm creates the tasks through the
same Todoist client, gate and 15-minute window as mail. Every expected outcome is a `TaskIntentResult`
value (`created`, `duplicate`, `paused`, `failed`, `rejected`, `not_found`), never an exception.
`test/ops.test.ts` covers the forwarding and the 64 KiB bound; `tests/runtime/test_task_intents.py` calls
the real entrypoint over a service binding with the fake Todoist.

## 4. Trust and request IDs

The object is reachable only through a Durable Object binding, and only the gateway binds the class;
there is no marker header or owner header to forge. The owner is an argument the gateway takes from
Access (§2.4).

Request ID: the gateway makes one per incoming request (8 bytes from `crypto.getRandomValues`, lowercase
hex, so it matches `[0-9a-f]{16}`), puts it in every error envelope, the DO's included, and logs
`{"request_id","status","code"}` once for each error it returns (nothing else). The DO does not see the
ID: it builds no envelopes, and its own log lines stay the ID/state/code lines of `_log` (e.g. why an
ingest was rejected), which Workers Logs show for the same moment. The DO's own `fetch` answers (the 404,
and the transition 503 of §6.4) make a fresh ID and log it (`http.error_response`).

Responses: the gateway builds every response from the DO's result (§3); on the owner host it then adds
the private headers.

## 5. Basic-auth failure counting across the boundary

- A correct credential never touches the counter: it goes straight to `newsletter(kind, query)`, which
  never reads `auth_failures`, so no number of attacker failures can block the newsletter.
- A failed credential → DO `newsletter_auth_failure()` → 401 (counted) or 429 (locked, not counted),
  i.e. at most 20 D1 writes per UTC hour, exactly as today.
- The gateway keeps a per-isolate `lockedHour` (UTC `YYYY-MM-DDTHH`): once the DO answers 429 for a
  failure, later failures in that isolate and hour get 429 `rate_limited` with `retry-after: <s to next
  UTC hour>` without a DO call. This keeps a guessing flood from spending DO requests; the observable
  answer (429 after 20 failures in the hour) is the same.
- Call failure while counting → 503 `unavailable` (today's `hooks._report`).

## 6. Wrangler configs and deploy

Both production configs are committed and are the single source of truth; the top level is production
(no `[env.*]`, no `keep_vars`). Every static value is in them (account, D1, hosts, Access, limits); what
is never committed is added at deploy by `deploy/deploy_vars.py` (§6.3). Read the files themselves rather
than a copy here.

### 6.1 `gateway/wrangler.toml` = the gateway `todofy` (tests: `gateway/wrangler.test.toml`, `gateway/wrangler.test-auth.toml`)

`main = "src/index.ts"`, assets `../uiassets/dist` (`run_worker_first`, SPA fallback), `routes` = a Custom
Domain for the public host and then one per hooks host, the `COORDINATOR` binding to `TodofyCore` with
`script_name = "todofy-core"`, its migration history (`v1` new `TodofyCoordinator`, `v2` deleted, §6.6), the
`METRICS` dataset, the `*/10 * * * *` cron and the vars `TODOFY_PUBLIC_HOST`, `TODOFY_HOOKS_HOSTS`,
`ACCESS_ISSUER`, `ACCESS_AUDIENCE`. Test variants use `.localhost` hosts, add the gateway test vars
(`DEV_AUTH_BYPASS`, `ACCESS_OWNER`, `ACCESS_AUDIENCE`, `DEV_ACCESS_LOOPBACK_ISSUER`,
`ACCESS_OWNER_ALIASES`, `JWKS_REFRESH_COOLDOWN_MS`) and keep `script_name = "todofy-core"`.

### 6.2 Root `wrangler.toml` = `todofy-core` (tests: root `wrangler.test.toml`, also named `todofy-core`)

The core has one test config: the two gateway test configs differ only in gateway vars (Access
bypass vs. loopback issuer), so both pair with root `wrangler.test.toml` (short timings, fake
upstream placeholders, `REMINDER_ENABLED = "false"`, `REPORT_PRECOMPUTE_UTC = "off"`, `GTD_COLLECT_UTC =
"off"`, `GTD_REVIEW_ENABLED = "false"`). The old root
`wrangler.test-auth.toml` is gone.

`main = "worker/todofy/runtime/entry.py"`, `base_dir = "worker"`, `compatibility_flags =
["python_workers"]`, D1 `DB` (`migrations_dir = "migrations"`), the `BACKUPS` bucket, both of its
migrations (`v1` new `TodofyCoordinator`, `v2` renamed to `TodofyCore`), the `METRICS` dataset and its
vars: the fixed upstreams `GEMINI_API_BASE`/`TODOIST_API_BASE`, `TODOFY_PUBLIC_HOST` (`reminder.py`
puts `https://<TODOFY_PUBLIC_HOST>/attention` into the daily reminder, so the core needs the public host
too), `MAIL_SOURCE_ID`, `GEMINI_MODELS`, `GEMINI_DAILY_TOKEN_BUDGET`, `LOOKUP_DELAY_MS`, `REPORT_*`,
`GTD_COLLECT_UTC`, `LEGACY_TEXT_RETENTION_DAYS`. Test-only timing knobs (`GEMINI_TIMEOUT_MS`, ...) keep their code defaults.
It keeps its name and place: pywrangler reads the Python version only from the root `wrangler.toml`, and
a Python config must sit next to `python_modules/` (a core config elsewhere fails with
`ModuleNotFoundError: No module named 'workers'`, verified). No assets, cron, routes or DO binding.
`entry.py` keeps a `Default` whose `fetch` returns 404 `not_found` and re-exports `TodofyCore`.

### 6.3 What the deploy adds (`deploy/deploy_vars.py`)
`exec core|gateway -- <deploy command>` appends `--var` flags (plain_text vars, exactly like `[vars]`;
wrangler prints them as `(hidden)`): `BUILD_SHA` (the commit) and `MAINTENANCE_MODE` on both Workers;
`REMINDER_ENABLED`, `PROCESSING_PAUSED`, `FORCE_PAUSE_TODOIST` and `GTD_REVIEW_ENABLED` on the core.
`secrets core <path>` and `secrets gateway <path>` write each Worker's owner-only secrets file for
`--secrets-file` (Worker secrets, hidden in the Cloudflare dashboard and API): the core's
`TODOIST_DEFAULT_PROJECT_ID`, `TODOIST_OPS_PROJECT_ID` and `TODOIST_REVIEW_PROJECT_ID`, the gateway's
`ACCESS_OWNER` and `ACCESS_OWNER_ALIASES`. An unset optional project and an emptied alias list are uploaded
as one space, which the Workers read as unset (a deploy keeps every secret it does not upload). The core's
`GEMINI_API_KEY` and `TODOIST_API_KEY` are set by the owner. A missing or invalid value fails the deploy by
name, because a deploy without a var deletes it; a deploy without exactly one valid secrets file of that
Worker, `--env`, `--keep-vars`, the caller's own `--var` and any other config are refused. `deploy/test_wrangler_configs.py` checks the committed values the retired generator validated
(host lists, UUID, model list, bounds, the core/gateway pairing).

### 6.4 Deploy order (CI, from one verified commit)
```sh
npx --no-install wrangler d1 migrations apply DB --remote --config wrangler.toml
uv run python deploy/deploy_vars.py exec core -- uv run pywrangler deploy \
  --config wrangler.toml --secrets-file "$RUNNER_TEMP/todofy-core-secrets.json"     # todofy-core first
uv run python deploy/deploy_vars.py exec gateway -- npx --no-install wrangler deploy \
  --config gateway/wrangler.toml --secrets-file "$RUNNER_TEMP/todofy-gateway-secrets.json"  # then the gateway
```
Core always deploys first, so the methods a new gateway calls exist before it calls them; a core change
must keep serving the previous gateway's calls until the gateway deploy finishes. Adding a method or a
trailing argument with a Python default is safe; renaming or removing one needs two releases.

The todofy.ui.v1 release (2026-10-02) is such a pair. Its core adds `owner_ui` and keeps `owner_api` (§3.5.1),
so the previous gateway serves the previous UI until the new gateway is live; its gateway calls `owner_ui`
only and answers the old owner paths 410 `reload_required`, which an open tab of the previous UI shows as
"Todofy 已更新，请刷新页面" (a reload loads the new UI from the same deploy's assets). No D1 migration, no Durable
Object migration and no change on the hooks hosts. A failed gateway step leaves the previous pair's behaviour
in place (the old gateway on the new core, `owner_api`). Rollback: revert on `main` and let CI redeploy both;
the core of the revert lacks `owner_ui`, so between its deploy and the gateway's the new gateway's owner API
answers 503 `UNAVAILABLE` (the hooks hosts are unaffected). The next release removes `owner_api`,
`runtime/api.py`'s routes and the 410 paths.

The one release that switches from the old internal fetch routes (`x-todofy-internal`, `/ingest`,
`/newsletter/*`, `/api/v1/*` on `https://coordinator`) to RPC breaks that rule once, on purpose, and
failed retryably (history; the shim was removed in the release after the class delete): the new core's `fetch` answered every request marked `x-todofy-internal: 1` with 503
`unavailable` and `retry-after: 60` (any other fetch stays 404) and reads or writes nothing. The previous
gateway passes that through until the gateway step finishes, or for as long as a failed gateway step is
not rerun. Mail Hero treats it like any 5xx (backoff that honours `Retry-After`, no revision block; a 404
would block the revision after 30 minutes); a newsletter read or owner API call gets 503 (the newsletter
fails for that run); the old gateway turns the core's `/setup` 503 into its own 503; the old cron's
`/wake` is ignored, and the object's own alarm keeps running. The shim is gone now: `fetch` answers 404 to
everything, and a gateway older than the RPC release can no longer be paired with this core.

This release (RPC, backup and metrics) changes no Durable Object migration on either Worker: the core
stays at `v1`/`v2`, the gateway at `v1` with the empty `TodofyCoordinator` still exported. The gateway
step therefore cannot hit the 10061 refusal, and D1 `0002` is additive. So:

- A failed gateway step leaves the previous gateway in front of the RPC core (503 above). Rerun the
  job once: that fixes a transient failure (network, API hiccup). If the rerun fails the same way, do
  not keep rerunning: roll the core alone back to its previous version, which pairs the previous
  gateway with the previous core again, then fix forward on `main`:
  `npx wrangler deployments list --name todofy-core` (note the previous version ID), then
  `npx wrangler rollback <previous version id> --name todofy-core --message "gateway step failed"`.
  This is the one single-Worker rollback allowed, and only in this state (gateway step of this release
  failed, previous gateway still live): it recreates a matching pair, without backups or metrics until
  the fix ships (D1 `0002` stays; the older code ignores it). The next push to `main` deploys both
  Workers again, which is how the fix (or a revert) ships.
- Otherwise roll back only both Workers together: revert the commit on `main` and let CI redeploy both.
  Never `wrangler rollback` (or a dashboard rollback of) one Worker across this release in any other
  state: the RPC gateway against the older core gets "Method … does not exist" on every call (503
  `unavailable` on every core-backed route, seen in local runs of both pairings), and the older gateway
  against the RPC core gets the 503 above. A revert redeploys the core first, so the RPC gateway meets the
  older core (503) until the gateway step finishes. Once the class-delete release (§6.6) is live, a revert
  of any older release must keep that release's gateway migrations (§6.6, "Reverting past it").

First cutover only (owner steps, cannot be done by CI because CI never sees these values):
1. Before merging the split to `main` (CI deploys core and gateway back to back, so there is no pause
   between them for a manual step): `npx wrangler secret put GEMINI_API_KEY --name todofy-core` and the
   same for `TODOIST_API_KEY`. `todofy-core` does not exist yet; wrangler 4.142.0 then asks to create it
   and uploads an empty placeholder script (`export default { fetch() {} }`, no migrations) holding only
   the secrets (`createDraftWorker` in its bundled source; not tried against the account). The first
   deploy replaces the code, applies `v1` and keeps the secrets. Without this the new object would run
   the report precompute without keys as soon as the gateway's first cron wakes it.
2. The gateway deploy replaces the Python script `todofy` in place (secrets on `todofy` persist). The
   old object stays as the empty exported `TodofyCoordinator` with its storage unused; `v2` in a
   gateway-only release of its own (§6.6) deletes it. What the new object starts without, and why that is acceptable:
   the day's Gemini token/call counters (the budget may be spent up to twice that day), the Todoist
   auth block time (a still-bad key is retried once and blocked again), report failure counts and the
   `control` tick times (they default to "due now"; the reminder day claim lives in D1, so no duplicate
   reminder). Ledger rows left mid-step by the old object are recovered by `recover_interrupted`
   (`summarizing` → `pending`, `todo_sending` → `todo_unknown` with a footer lookup first, so no blind
   Todoist resend).
3. Then remove the now-unused secrets from the gateway:
   `npx wrangler secret delete GEMINI_API_KEY --name todofy` and `... TODOIST_API_KEY --name todofy`.
4. CI checks both paths after every deploy: `/health` must report the commit (gateway only), then
   one `GET /api/summary` with a wrong Basic credential must get 401 or 429, which only the object's
   `newsletter_auth_failure()` (D1 read and write) can answer; a broken core, binding or D1 gives 503 and
   fails the job. The probe spends one of the hour's 20 failure slots and never blocks the correct
   credential (§5). Opening the owner UI overview proves the Access → owner API path.

A first deploy of `todofy` on a new account (or after the script was deleted) gets every configured
migration step, because wrangler sends every step when the script has no tag (`getMigrationsToUpload`
in wrangler 4.142.0). While the gateway carries only `v1` and exports the retired class, that creates
an empty class and is harmless. After the class-delete release (§6.6) remove the `[[migrations]]`
blocks before such a deploy.

### 6.5 Rolling back to the single Python Worker

The ledger assumes one writer per D1 database: `ledger.recover_interrupted` runs at the start of every
alarm and treats every `summarizing`/`todo_sending` row as abandoned (`core/sql/ledger.py`, the
`INTERRUPTED` comment). Two coordinators on the same database would reset each other's in-flight
summaries (towards `processing_interrupted_limit`), turn each other's Todoist calls into
`todo_unknown`, repeat Gemini calls and each keep their own daily token budget. `todofy-core`'s object
re-arms its own alarm on every run, so it keeps running after a rollback unless it is stopped. Never let
two coordinators run against the same database, in either direction.

1. Set `TODOFY_MAINTENANCE_MODE=true` and redeploy the current `main`: the gateway refuses webhooks
   (503 with `Retry-After`, Mail Hero retries) and owner writes, and the core's alarm only re-arms a
   one-day alarm with no ledger, report or Gemini work.
2. If cutover step 3 removed them, put `GEMINI_API_KEY` and `TODOIST_API_KEY` back on `todofy`.
3. Deploy the last pre-split commit. Before the class-delete release (§6.6) `todofy` is still at tag
   `v1` with the class `TodofyCoordinator`, so the pre-split config (only `v1`) sends no migration and the
   Python code takes that class back; its storage is the old object's, which the retired class's alarm may
   have cleared (counters and tick times only; they default safely). After the class-delete release,
   extend its `wrangler.toml` migrations to the full history of the script: `v1` `new_sqlite_classes`,
   `v2` `deleted_classes`, `v3` `new_sqlite_classes`, all `TodofyCoordinator`. wrangler then sends only
   `v3` (old tag `v2`). A plain pre-split config (only `v1`) is not refused by wrangler 4.142.0 then: it
   warns that the published tag `v2` is not in the config and sends every configured step as `v2` →
   `v1`. Whether Cloudflare accepts that is unverified, so do not rely on it. The pre-split code has the
   D1 binding and all secrets it reads; it deploys in maintenance because the GitHub variable is still
   `true`.
4. Delete the core: `npx wrangler delete --name todofy-core`. No gateway binds its class any more, so
   this removes the script, its object (counters only, the same kind the cutover drops) and its alarm.
   A later forward cutover must put `GEMINI_API_KEY`/`TODOIST_API_KEY` on `todofy-core` again and give
   the gateway the next free tag with `deleted_classes` (`v2` before the class-delete release, else `v4`),
   in a release of its own as in §6.6.
   Nothing rotates the bucket `todofy-backups` any more, and it holds mail content (summaries, todo
   bodies, payloads of unfinished events, the imported legacy text). Delete its objects and the bucket
   (dashboard, or `npx wrangler r2 bucket delete todofy-backups` once it is empty), or keep it on
   purpose and note that its copies no longer follow D1 retention.
5. Set `TODOFY_MAINTENANCE_MODE=false` and redeploy.


> Class name: the core class is `TodofyCore`. Cloudflare refuses a `deleted_classes` migration while any
> binding names a class of the same name, even in another script (error 10061), so the gateway could not
> delete its old `TodofyCoordinator` while binding `todofy-core`'s `TodofyCoordinator`. The core renames its
> class in migration `v2` (`renamed_classes`); the gateway binds `TodofyCore`.
>
> The delete still failed with 10061 because the live Python version of `todofy` bound its own
> `TodofyCoordinator`. So the first gateway release (`bc7b89e`) applied no migration and exported an empty
> `TodofyCoordinator` (`gateway/src/retired.ts`). That release replaced the Python version, so no live
> version binds the class any more. The RPC, backup and metrics release keeps `retired.ts` and `v1`
> only as well: the delete has been refused twice for a reason that was understood only afterwards, so
> it ships alone (§6.6), where a refusal cannot take any other change down with it.

### 6.6 Release notes: deleting the retired class (gateway-only release)

> Shipped 2026-09-29 as its own release after the RPC, backup and metrics release; kept here as the record.

Ship this only after the RPC, backup and metrics release is live and checked (CI's `/health` and core
probes passed, the owner UI overview loads, a webhook reached `complete`). The commit changes nothing
but the gateway's class history:

1. Delete `gateway/src/retired.ts` and its re-export `export { TodofyCoordinator } from './retired.ts';`
   in `gateway/src/index.ts`.
2. Add to `gateway/wrangler.toml`, `gateway/wrangler.test.toml` and `gateway/wrangler.test-auth.toml`,
   after `v1`:
   ```toml
   [[migrations]]
   tag = "v2"
   deleted_classes = ["TodofyCoordinator"]
   ```
   and update their history comment.
3. Expect `v1` + `v2` in `tests/runtime/test_configs.py` (`GATEWAY["migrations"]`) and
   `deploy/test_wrangler_configs.py` (`GATEWAY["migrations"]`); update §1's table and §6.1.

What it does: wrangler sees the published tag `v1` and sends only `v2`; Cloudflare deletes the old
object and its storage (counters of the Python era, nothing the ledger needs). The core deploy step of
that run redeploys unchanged code.

Not verified locally (needs the account): that Cloudflare accepts it. The working theory for the two
10061 refusals (on `2dec605` and `a8e8f4f`) is "a live version still binds the class"; since `bc7b89e`
no live version does, but the same kind of reasoning failed once before. `--dry-run` never computes
migrations against the account.

If the gateway step fails with 10061: nothing else changed, the RPC gateway from the previous release
keeps serving, and the core step only redeployed the same code. A rerun fails the same way. Revert the
commit on `main` (back to `v1` + `retired.ts`, which matches the live tag) and investigate; do not
rerun.

Reverting past it: once `todofy` is at `v2`, any later revert of an older release must keep the
gateway's `[[migrations]]` at `v1` + `v2` in all three gateway tomls (and the tests' expectations) and
must not bring back the `retired.ts` export. Revert the code but keep the gateway tomls; wrangler then
finds the published `v2` as the last configured step and sends nothing. A plain revert would send every
configured step as `v2` → `v1` (wrangler 4.142.0 only warns), and Cloudflare's answer to re-creating a
deleted class that way is unverified; if a revert's gateway step fails on the migration, the core has
already been reverted and every core-backed route answers 503: restore `v2` in the gateway tomls (or
revert the revert) and rerun. If the class is ever needed again, add a new tag `v3` with
`new_sqlite_classes`.

After it is live: the `[[migrations]]` blocks may be removed from the three gateway tomls (make
`deploy/test_wrangler_configs.py` assert no gateway migrations); wrangler sends nothing for an empty
list, which is right for the live `todofy` and for a fresh account.

## 7. Local dev and runtime tests

One process runs both Workers (verified, §8):

```sh
uv run pywrangler dev -c gateway/wrangler.toml -c wrangler.toml \
  --port 8787 --local-upstream todofy.localhost:8787 \
  --var TODOFY_PUBLIC_HOST:todofy.localhost --var TODOFY_HOOKS_HOSTS:todofy-hooks.localhost \
  --var BUILD_SHA:dev                                                # from todofy/, local bindings only
```
Both configs are the production ones, so the local hosts come in with `--var` (docs/dev-notes.md §1).
Without `--local-upstream`, wrangler dev makes the first production route every request's URL, whatever
the Host header, and no request reaches a local host; `--local-upstream` picks the one host a run serves.
The first `-c` is the primary: it owns the port, `--var`, `--env-file`, the cron trigger
(`/cdn-cgi/local/scheduled`) and the assets. `--var`/`--env-file` do **not** reach the second config;
core vars come from its config, and local core secrets from `.dev.vars` next to the root
`wrangler.toml` (gitignored). D1 and the DO share the `--persist-to` directory; the object's storage
is `<persist>/v3/do/todofy-core-TodofyCore/` (so `crash_and_restart`'s `v3/do` glob still works),
and `wrangler d1 migrations apply DB --local --persist-to <dir> --config wrangler.toml` writes the
same database the core reads.

Runtime harness (`tests/runtime/harness.py`, as built: `start_gateway(state, variables, config,
core=True)`; the test-only probes still use `start_worker` with a single config):
- Split the test variables by name: gateway-only = `TODOFY_HOOKS_HOSTS`,
  `ACCESS_*`, `CSRF_SIGNING_KEY`, `MAIL_WEBHOOK_TOKEN_SHA256*`, `REPORT_BASIC_AUTH_SHA256`, `DEV_*`,
  `JWKS_REFRESH_COOLDOWN_MS`; both = `MAINTENANCE_MODE`, `BUILD_SHA`, `TODOFY_PUBLIC_HOST`; everything
  else is core.
- Core vars go into a generated `wrangler.test-run-<uuid>.json` at the repo root (the core test toml
  plus the per-test vars), deleted when the Worker stops. Gateway vars stay `--var`.
- Start: `python -m pywrangler dev -c gateway/wrangler.test.toml -c wrangler.test-run-<uuid>.json --ip
  127.0.0.1 --port <p> --persist-to <dir> --show-interactive-dev-session=false --var ...`, with
  `MINIFLARE_WORKERD_PATH` as today. Migrations and `Worker.d1()` use the generated core config.
- Every process gets its own `WRANGLER_REGISTRY_PATH` under its persist directory, so a gateway's
  `todofy-core` binding can never reach another test server's core; `core=False` starts the gateway
  alone (every RPC call then throws, which the gateway answers with 503 `unavailable`).
- Everything else (ports, host-header clients, `trigger_cron`, `headers_only_status`, the
  answer-before-body quirk) is unchanged.
- `tests/runtime/test_gateway_boundary.py` covers the boundary itself: a test-only JS primary in front of
  the real core sends the old internal fetch routes (503 with `retry-after: 60` when marked
  `x-todofy-internal: 1`, 404 otherwise; nothing written) and calls the RPC methods
  directly (result shape, owner check; §3, §4), forged client `x-todofy-*` headers through the gateway,
  the hashed-asset cache header and the SPA fallback guard (§2.3), and `/health` from a gateway started
  without the core.

Rejected alternative (also works, verified): separate `wrangler dev` processes for gateway and core
through the dev registry. It needs a distinct `--inspector-port` per process (the second process died
with `bind(): Address already in use` otherwise), a private `WRANGLER_REGISTRY_PATH` per worker pair
(the registry is keyed by script name, so parallel test workers would collide), start ordering, and a
crash test would have to kill two processes.

## 8. Experiments behind this contract (wrangler 4.142.0, workers-py 1.17.4, cached workerd)

### CPU

The owner API's CPU in the gateway (a plain Worker request: 10 ms on Workers Free) is measured by
`gateway/test/runtime/cpu.test.ts` (`npm run test:runtime`) with the shared meter `tools/workerd-cpu`: a sampled
DevTools CPU profile of the gateway's isolate around each request in workerd, Access verified as in production,
one RPC to a stand-in TodofyCore answering the largest answers the DO gives, in milliseconds of the reference
machine (Apple M1 Max), each number the median of three fresh isolates. Measured 2026-10-02, before (the OpenAPI
routes through `owner_api`, which passed the DO's JSON through) → after (todofy.ui.v1: the transcoder's decode, the
lenient read of the DO's answer with the generated code and the transcoder's write):

| Request | First run | Warm median | Bound |
|---|---|---|---|
| The isolate's first API request (the service status; first RS256 verification and key import) | 3.2 → 4.2-5.2 (single isolates 3.9-8.6 on a busy machine) | | 8 |
| Service status | 0.4 → 0.8 | 0.4 → 0.7 | 6 / 4 |
| 100 mail events | 0.4-0.5 → 3.2 | 0.4 → 2.2 | 6 / 4 |
| The next page (its token) | → 2.0 | → 2.0 | 6 / 4 |
| An event's detail | 0.7 → 2.0 | 0.7 → 1.7 | 6 / 4 |
| 90 metric days | 0.4-0.5 → 2.8 | 0.4-0.6 → 1.6 | 6 / 4 |
| 120 GTD days | 0.3-0.4 → 3.2 | 0.4-0.5 → 2.9 | 6 / 4 |
| 100 reminders | 0.4 → 2.0 | 0.4 → 1.4 | 6 / 4 |
| A reconcile (CSRF verify included) | 1.0 → 2.1 | 0.7 → 1.6 | 6 / 4 |
| A 1.9 MB legacy text | 2.0-2.1 → 4.4 | 2.4 → 3.8 | 8 |
| Every stored report at the newsletter's limits | 1.1-1.3 → 5.2 | 1.2-1.3 → 5.0 | 8 |

The cost is the generated code reading and writing every answer again: a few tenths of a millisecond per
small message, about 2 ms for a page of 100 events, and the codec's text rules over a report's 230,000
characters. `src/warm.ts` runs the codec once over synthetic messages at global scope (startup, outside every
request's limit), which took the isolate's first API request from 7.4-8.2 to 4.2-5.2 ms. The DO's own CPU (30 s
per invocation) is not measured here: it builds the same dicts as before and maps them to the generated
dataclasses; todofy-core's upload grew 554.1 → 627.3 KiB (gzip 153.6 → 166.6 KiB). The gateway's bundle, `deploy/bundle-size.mjs` (budget 86 KiB gzip): 39.7 → 290.6 KiB raw, 11.8 →
71.7 KiB gzip (the protobuf-es runtime, the codec, the transcoder and the descriptors of `todofy.ui.v1`,
`todofy.report.v1`, `google/api` and `common/errors`); the UI's JavaScript, `web/scripts/js-budget.mjs` (budget
208 KiB gzip): 131.9 → 172.3 KiB gzip.

Run in `scratchpad/tmp/contract/repo` with a minimal TS gateway and a minimal Python DO:

| Check | Result |
|---|---|
| `wrangler dev -c gateway/wrangler.toml -c wrangler.toml` (TS primary + Python DO) | gateway → DO fetch works; DO reads D1 and its SQLite storage |
| same through `python -m pywrangler dev -c … -c …` | works; pywrangler syncs from the root config, then proxies |
| cron via `/cdn-cgi/local/scheduled` on the combined process | reaches the gateway's `scheduled()`, which woke the DO |
| SPA fallback with `run_worker_first` on the primary | `GET /some/spa/path` (navigate) → `index.html` |
| 1.5 MB chunked body streamed gateway → DO | DO read all 1,500,000 bytes |
| explicit `content-length` forwarded with a stream body | DO sees it; without it the DO sees `transfer-encoding: chunked` |
| client `x-todofy-*` header when the gateway builds headers from scratch | not visible in the DO |
| `--var` / `--env-file` on the combined process | reach only the primary (gateway) |
| `.dev.vars` next to the core config; generated core JSON at the repo root | both reach the core |
| core config outside the repo root | core fails to start: `No module named 'workers'` |
| gateway config with `v1` new + `v2 deleted_classes` and a binding with `script_name` (the §6.6 shape; the shipped gateway still has `v1` only) | local dev works; `wrangler deploy --dry-run` passes for both configs |
| core config without any DO binding (class only in its migration) | local dev works; dry-run passes |
| separate processes via `WRANGLER_REGISTRY_PATH` | works once each has its own inspector port; binding shows `[connected]` |

The RPC boundary (§3) rests on a later spike in `scratchpad/tmp/spike/repo` (same versions, workers-runtime-sdk
1.9.0, one `pywrangler dev` process):

| Check | Result |
|---|---|
| TS → Python DO RPC: `str`, `null`/`undefined`, objects, `ReadableStream` arguments | arrive as `str`, `None`, `JsDict`, a JsProxy readable with `getReader()`; missing trailing arguments take the Python defaults |
| Python return values | dict → plain Object, `None` → null, `bytes` → Uint8Array; a tuple is refused; a `memoryview` return costs about 1.5 s per MiB |
| Python exception | `Error{name: "PythonError", message: <traceback>}`; `status`/`code` attributes are lost; the stub keeps working |
| exposure | every Python method is callable, `_`-prefixed ones included; `alarm` is reserved |
| RPC calls during a running alarm | interleave at every `await`, like fetch |
| 500 calls from the gateway | RPC 0.52–0.58 ms, fetch 0.66–0.73 ms each (wall time; local traces carry no CPU time) |
| 3.5 MB stream as an RPC argument vs a fetch body | about 1.06 s vs 1.07 s |
| hand-written `interface … extends Rpc.DurableObjectBranded` with `DurableObjectNamespace<T>` | passes strict `tsc` |
