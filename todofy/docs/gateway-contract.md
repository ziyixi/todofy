# Gateway contract: `todofy` (TypeScript) ↔ `todofy-core` (Python Durable Object)

Status: as built. First derived from the single Python Worker at `c0d80c6` (its `hooks.py`,
`owner.py`, `csrf.py` and `access_jwt.py` are now `gateway/src`) and `api/owner-api-v1.openapi.yaml`,
then updated to match the code after review. Where this file and the code disagree, fix one of them
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
| Vars | `TODOFY_PUBLIC_HOST`, `TODOFY_HOOKS_HOSTS`, `BUILD_SHA`, `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `MAINTENANCE_MODE`; dev/test only: `DEV_AUTH_BYPASS`, `DEV_ACCESS_LOOPBACK_ISSUER`, `JWKS_REFRESH_COOLDOWN_MS` | `BUILD_SHA`, `MAINTENANCE_MODE`, `TODOFY_PUBLIC_HOST` (the reminder's link), `PROCESSING_PAUSED`, `FORCE_PAUSE_TODOIST`, `REMINDER_ENABLED`, `MAIL_SOURCE_ID`, `GEMINI_API_BASE`, `GEMINI_MODELS`, `GEMINI_TIMEOUT_MS`, `GEMINI_DAILY_TOKEN_BUDGET`, `TODOIST_API_BASE`, `TODOIST_DEFAULT_PROJECT_ID`, `TODOIST_ATTEMPT_TIMEOUT_MS`, `LOOKUP_DELAY_MS`, `BACKOFF_BASE_MS`, `WATCHDOG_MS`, `REPORT_DEFAULT_TOP`, `REPORT_PRECOMPUTE_UTC`, `LEGACY_TEXT_RETENTION_DAYS` |
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

Gate order for every request, assets included (owner.py):

1. Access JWT (§2.4). Failure → its status/code.
2. Path starts with `/api/`:
   - method not `GET`/`HEAD` → CSRF verify (§2.5), then `MAINTENANCE_MODE` → 503 `maintenance` +
     `retry-after: 300`;
   - route: `GET /api/v1/csrf` → gateway issues (§2.5); `GET /api/v1/setup` → gateway composes (§3.6);
     any other path under `/api/v1/` → DO `owner_api` with the method, path, query and body unchanged;
     other `/api/*` → 404 `not_found` without a DO call. Call throws → 503 `unavailable`.
3. Otherwise `env.ASSETS.fetch(request)` (SPA fallback via `not_found_handling`; a POST gets the asset
   server's 405).
4. Every response (errors, assets, DO answers) leaves with the private headers (§2.3).

The gateway does not read or size-check owner request bodies: the DO keeps today's `api._json_body`
rule (declared `Content-Length`, passed as an argument, non-numeric or > 16 KiB, or a body > 16 KiB →
400 `invalid_request`).
The brief's "JSON ≤ 64 KiB" would change behaviour and the 404-before-400 order, so the 16 KiB rule
stays where it is. The DO reads the body with `interop.read_capped` and stops after 16 KiB, so a
chunked body (no `Content-Length`) is never buffered whole in the object that also runs ingest and the
alarm loop (`tests/runtime/test_owner_body_limit.py`).

### 2.3 Private headers (owner host)

Copy the response (`new Response(body, response)`) and set: `cache-control: no-store`,
`x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY`,
`content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'` (http.py `PRIVATE_HEADERS`, byte-identical).

The one exception: a path under `/assets/` served by `ASSETS` with status 200 and a `content-type` that
is not `text/html` gets `cache-control: private, max-age=31536000, immutable` in place of `no-store`.
A missing `/assets/x.js` falls back to `index.html` (200, `text/html`) and keeps `no-store`. The
other four headers apply unchanged.

### 2.4 Access JWT (`access.ts`; the Python `access_jwt.py` rules plus Mail Hero's `nbf`/`sub` checks)

- Dev bypass: `DEV_AUTH_BYPASS == "true"` and `TODOFY_PUBLIC_HOST` ends with `.localhost` and the request
  has no `cf-ray` header → owner = `ACCESS_OWNER` lowercased. Otherwise the flag is ignored.
- Issuer: `ACCESS_ISSUER` without a trailing `/`, matching `^https://[a-z0-9-]+\.cloudflareaccess\.com$`;
  or, only under the same `.localhost` rule with `DEV_ACCESS_LOOPBACK_ISSUER == "true"`,
  `^http://127\.0\.0\.1:\d{1,5}$`. Otherwise 503 `access_not_configured`. Empty `ACCESS_AUDIENCE` or
  `ACCESS_OWNER` → 503 `access_not_configured`. `ACCESS_OWNER_ALIASES` longer than 2048 characters or
  with more than 8 entries → 503 `access_not_configured`.
- Token: `cf-access-jwt-assertion` header, else the `CF_Authorization` cookie; missing or longer than
  16,000 characters → 401 `unauthorized`. Three base64url parts; header `alg == "RS256"`, JSON objects,
  else 401.
- Keys: per-isolate cache `issuer → (fetched_at, {kid: CryptoKey})` from `<issuer>/cdn-cgi/access/certs`
  (5 s timeout; RSA keys with a `kid` only; `RSASSA-PKCS1-v1_5`/`SHA-256`). Use the cache for 1 h; an
  unknown kid refetches at most once per `JWKS_REFRESH_COOLDOWN_MS` (default 60,000). Certs fetch
  non-200 or failing → 503 `unavailable`. Unknown kid after that → 401.
- Claims: `iss` equal to the issuer; `aud` (string or array) contains `ACCESS_AUDIENCE`; numeric `exp` >
  now; numeric `iat` < now + 60 s; `nbf` absent or numeric ≤ now + 60 s; `sub` a non-empty string;
  string `email` whose lowercase is `ACCESS_OWNER` or one of the aliases (all lowercased,
  comma-separated). Any failure → 401. The result is always `ACCESS_OWNER` lowercased (the canonical
  owner).
- Compared with Mail Hero's `security.ts` (jose `jwtVerify` with `requiredClaims: exp, iat, sub,
  email`): the same claims are required and a future `nbf` is refused. Differences: email matching is
  case-insensitive here (exact in Mail Hero); `nbf` gets 60 s of clock skew (jose: none); `iat` must
  also not be in the future (jose only checks that it is a number); an empty `sub` is refused here
  (jose accepts it).

### 2.5 CSRF (port of `csrf.py`)

- Key: `CSRF_SIGNING_KEY` must match `^[0-9a-fA-F]{64}$`, used as 32 raw bytes for HMAC-SHA256. Missing
  or malformed → 503 `not_configured` on `GET /api/v1/csrf` and on every write, checked before
  anything else (reads keep working).
- Issue (`GET /api/v1/csrf`): claims `{"kind":"csrf","owner":<owner>,"nonce":<16 random bytes
  base64url>,"exp":<now s + 43200>}` as compact JSON in that key order; token =
  `b64url(claims) "." b64url(HMAC(key, b64url(claims)))`, no padding. Body `{"token": token}`; header
  `set-cookie: todofy_csrf=<token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` plus `; Secure`
  when the request URL is `https:`.
- Verify (every non-GET/HEAD under `/api/`): `origin` lowercased must be `https://<TODOFY_PUBLIC_HOST
  lowercased>`, or under the `.localhost` rule also `http://<request URL host:port lowercased>`;
  `x-csrf-token` non-empty, ≤ 1024 characters, equal to the `todofy_csrf` cookie value; signature
  equal to the recomputed one; payload is a JSON object with `kind == "csrf"`, `owner` equal to the
  canonical owner and an integer `exp` > now. Any failure → 403 `csrf_failed`. Constant-time compares
  (length check first, then `crypto.subtle.timingSafeEqual`). Tokens minted by the Python code (and
  by the tests' `mint_csrf`) must verify unchanged.

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
helpers; only the gateway binds the class and it calls only the six below. `alarm` is reserved and
cannot be called.

`MAINTENANCE_MODE` in the DO (defence in depth; the gateway refuses first with a `retry-after`):
`ingest` and every `owner_api` call with method `POST` → 503 `maintenance` without `retry_after`; a
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

### 3.5 `owner_api(owner, method, path, query, content_length, body) -> CoreResult`
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
gateway answers `GET /api/v1/setup` with the OpenAPI `Setup` body: `build` (gateway `BUILD_SHA` or
`unknown`), `public_host` (lowercased), `hooks_hosts` (csv lowercased), `webhook_path: "/hooks/mail"`,
`mail_source_id` (DO), `access_owner` (canonical owner), `configured` = `{mail_webhook_token:
MAIL_WEBHOOK_TOKEN_SHA256 non-empty, report_basic_auth: REPORT_BASIC_AUTH_SHA256 non-empty}` merged with
the DO's `configured`. Call throws → 503 `unavailable`.

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

### 6.1 `gateway/wrangler.toml` (base/local; tests: `gateway/wrangler.test.toml`, `gateway/wrangler.test-auth.toml`)
```toml
name = "todofy"
main = "src/index.ts"
compatibility_date = "2026-09-08"
workers_dev = false
preview_urls = false

[assets]
directory = "../uiassets/dist"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"

[[durable_objects.bindings]]
name = "COORDINATOR"
class_name = "TodofyCore"
script_name = "todofy-core"

# Script "todofy" history: v1 created the Python class; v2 deleted it once the gateway replaced it.
[[migrations]]
tag = "v1"
new_sqlite_classes = ["TodofyCoordinator"]

[[migrations]]
tag = "v2"
deleted_classes = ["TodofyCoordinator"]

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "todofy_metrics"

[triggers]
crons = ["*/10 * * * *"]

[vars]
TODOFY_PUBLIC_HOST = "todofy.localhost"
TODOFY_HOOKS_HOSTS = "todofy-hooks.localhost"
BUILD_SHA = "dev"
```
Test variants add the gateway test vars (`DEV_AUTH_BYPASS`, `ACCESS_OWNER`, `ACCESS_AUDIENCE`,
`DEV_ACCESS_LOOPBACK_ISSUER`, `ACCESS_OWNER_ALIASES`, `JWKS_REFRESH_COOLDOWN_MS`) and keep
`script_name = "todofy-core"`.

### 6.2 Root `wrangler.toml` = `todofy-core` (tests: root `wrangler.test.toml`, also named `todofy-core`)

The core has one test config: the two gateway test configs differ only in gateway vars (Access
bypass vs. loopback issuer), so both pair with root `wrangler.test.toml` (short timings, fake
upstream placeholders, `REMINDER_ENABLED = "false"`, `REPORT_PRECOMPUTE_UTC = "off"`). The old root
`wrangler.test-auth.toml` is gone.
```toml
name = "todofy-core"
main = "worker/todofy/runtime/entry.py"
base_dir = "worker"
compatibility_date = "2026-09-08"
compatibility_flags = ["python_workers"]
workers_dev = false
preview_urls = false

[[d1_databases]]
binding = "DB"
database_name = "todofy"
database_id = "00000000-0000-4000-8000-000000000000"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "BACKUPS"
bucket_name = "todofy-backups"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TodofyCoordinator"]

[[migrations]]
tag = "v2"
renamed_classes = [{ from = "TodofyCoordinator", to = "TodofyCore" }]

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "todofy_metrics"

[vars]
TODOFY_PUBLIC_HOST = "todofy.localhost"
BUILD_SHA = "dev"
GEMINI_API_BASE = "https://generativelanguage.googleapis.com"
GEMINI_TIMEOUT_MS = "60000"
TODOIST_API_BASE = "https://api.todoist.com"
```
It stays at the repo root: pywrangler reads the Python version from the root `wrangler.toml`, and a
Python config must sit next to `python_modules/` (a core config elsewhere fails with
`ModuleNotFoundError: No module named 'workers'`, verified). No assets, cron, routes or DO binding.
`entry.py` keeps a `Default` whose `fetch` returns 404 `not_found` and re-exports `TodofyCore`.

### 6.3 Production generation (`deploy/generate_ci_config.py`)
Writes three owner-only files, never overwriting: `wrangler.production.ci.json` (core, next to
`python_modules/`), `gateway/wrangler.production.ci.json`, `gateway/wrangler.production.secrets.json`
(`ACCESS_OWNER`, `ACCESS_OWNER_ALIASES`), and no core secrets file (the core's secrets are set by the
owner). Gateway gets `routes` (custom domains for the public host and every hooks host), assets, the
DO binding with `script_name`, its migration history (`v1` only until §6.6), the `METRICS` dataset, the cron and its vars; core gets
D1, the `BACKUPS` bucket, the `METRICS` dataset, both of its migrations and its vars (the current `FIXED_VARS`, `MAIL_SOURCE_ID`, `GEMINI_*`, `TODOIST_DEFAULT_PROJECT_ID`,
`LOOKUP_DELAY_MS`, `REPORT_*`, `LEGACY_TEXT_RETENTION_DAYS`, the four switches); both get
`account_id`, `workers_dev: false`, `preview_urls: false`, `observability.enabled`, `BUILD_SHA`,
`MAINTENANCE_MODE` and `TODOFY_PUBLIC_HOST`. The core needs the public host too (deviation from §1's
table, found while writing the generator): `reminder.py` puts `https://<TODOFY_PUBLIC_HOST>/attention`
into the daily reminder body, and `tests/runtime/test_reminder_daily.py` checks it, so the core's test
vars need it as well. The shape of each config is copied from its checked-in toml by an explicit key
list (core: `name`, `main`, `base_dir`, `compatibility_date`, `compatibility_flags`, `migrations`,
`r2_buckets`, `analytics_engine_datasets`; gateway: `name`, `main`, `compatibility_date`, `assets`, `durable_objects`,
`migrations`, `triggers`, `analytics_engine_datasets`);
a unit test fails when either toml gains a key the generator neither copies nor replaces.
`.gitignore` adds the gateway files (`wrangler.test-run-*.json` belongs to the harness change, §7).

### 6.4 Deploy order (CI, from one verified commit)
```sh
npx --no-install wrangler d1 migrations apply DB --remote --config wrangler.production.ci.json
uv run pywrangler deploy --config wrangler.production.ci.json                       # todofy-core first
npx --no-install wrangler deploy --config gateway/wrangler.production.ci.json \
  --secrets-file gateway/wrangler.production.secrets.json                           # then the gateway
```
Core always deploys first, so the methods a new gateway calls exist before it calls them; a core change
must keep serving the previous gateway's calls until the gateway deploy finishes. Adding a method or a
trailing argument with a Python default is safe; renaming or removing one needs two releases.

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
   `deploy/test_generate_ci_config.py` (`gateway["migrations"]`); update §1's table and §6.1.

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
`deploy/test_generate_ci_config.py` assert no gateway migrations); wrangler sends nothing for an empty
list, which is right for the live `todofy` and for a fresh account.

## 7. Local dev and runtime tests

One process runs both Workers (verified, §8):

```sh
uv run pywrangler dev -c gateway/wrangler.toml -c wrangler.toml     # from the repo root
```
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
