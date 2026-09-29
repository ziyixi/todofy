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
long-lived cache header on hashed assets (§2.3, with its own runtime test), and two Access claims the
Python check did not require (`nbf`, `sub`; §2.4), which real Access tokens always carry.

## 1. The two Workers

| | `todofy` (gateway) | `todofy-core` |
|---|---|---|
| Language | TypeScript (strict, ES modules), `gateway/` | Python (Pyodide), `worker/`, pywrangler |
| Public entry | custom domains: owner host + every `TODOFY_HOOKS_HOSTS` name; cron `*/10 * * * *` | none (`workers_dev = false`, `preview_urls = false`, no routes); `fetch` answers 404 `not_found` |
| Bindings | `ASSETS` (`uiassets/dist`), `COORDINATOR` → class `TodofyCore` in script `todofy-core` | `DB` (D1 `todofy`). No DO binding: nothing in core calls the DO through a stub any more |
| Vars | `TODOFY_PUBLIC_HOST`, `TODOFY_HOOKS_HOSTS`, `BUILD_SHA`, `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `MAINTENANCE_MODE`; dev/test only: `DEV_AUTH_BYPASS`, `DEV_ACCESS_LOOPBACK_ISSUER`, `JWKS_REFRESH_COOLDOWN_MS` | `BUILD_SHA`, `MAINTENANCE_MODE`, `TODOFY_PUBLIC_HOST` (the reminder's link), `PROCESSING_PAUSED`, `FORCE_PAUSE_TODOIST`, `REMINDER_ENABLED`, `MAIL_SOURCE_ID`, `GEMINI_API_BASE`, `GEMINI_MODELS`, `GEMINI_TIMEOUT_MS`, `GEMINI_DAILY_TOKEN_BUDGET`, `TODOIST_API_BASE`, `TODOIST_DEFAULT_PROJECT_ID`, `TODOIST_ATTEMPT_TIMEOUT_MS`, `LOOKUP_DELAY_MS`, `BACKOFF_BASE_MS`, `WATCHDOG_MS`, `REPORT_DEFAULT_TOP`, `REPORT_PRECOMPUTE_UTC`, `LEGACY_TEXT_RETENTION_DAYS` |
| Secrets | `MAIL_WEBHOOK_TOKEN_SHA256`, `MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS`, `REPORT_BASIC_AUTH_SHA256`, `CSRF_SIGNING_KEY`, `ACCESS_OWNER`, `ACCESS_OWNER_ALIASES` (the last two from `--secrets-file` on every deploy) | `GEMINI_API_KEY`, `TODOIST_API_KEY` |
| DO class | none (migration `v2` deletes the old one) | `TodofyCore` (renamed from `TodofyCoordinator` by core migration `v2`), instance name `inbox-v1`, SQLite-backed |

`BUILD_SHA` and `MAINTENANCE_MODE` are set on both from the same deploy value. The gateway never binds
or queries D1. `gateway/package.json` has its own lockfile with `typescript` and
`@cloudflare/workers-types` (plus a test runner if unit tests are added); it does not pin its own
wrangler: the root wrangler 4.142.0 bundles and deploys both Workers, so one wrangler version serves
both configs.

## 2. Public routes: who does what

Every gateway request first gets a request ID (§4). Unknown host → 404 `not_found` (plain JSON headers,
no DO call). Host matching is on `new URL(request.url).hostname` lowercased; the public host is checked
before the hooks hosts. After routing, a request body that nothing read (an answer given on the headers
alone: 401, 403, 404, 413, 415, 503) is cancelled; a body handed to the DO or to `ASSETS` is locked by
then and left alone. Found by the runtime suite: `wrangler dev` holds such an answer until the body is
consumed, so the headers-only 413 never arrived.

Gateway JSON responses use exactly `http.json_response`'s headers: `content-type: application/json;
charset=utf-8`, `cache-control: no-store`, `x-content-type-options: nosniff`, and the body
`{"error": {"code", "message", "request_id"}}` with the message from `core/api_errors.MESSAGES` (the
gateway keeps a copy of the codes it emits; a unit test compares it with the Python table).

### 2.1 Hooks hosts (`TODOFY_HOOKS_HOSTS`, no Access)

| Request | Gateway | DO |
|---|---|---|
| `GET /health` | `200 {"build": BUILD_SHA or "unknown", "service": "todofy", "status": "healthy", "timestamp": "YYYY-MM-DDTHH:MM:SSZ"}`. Never calls the DO (the newsletter preflight reads `service`/`status`) | — |
| `POST /hooks/mail` | in this order: no digest configured → 503 `not_configured`; Bearer check → 401 `unauthorized` (no `www-authenticate`); `MAINTENANCE_MODE` → 503 `maintenance` + `retry-after: 600`; media type ≠ `application/json` → 415 `unsupported_media_type`; declared `Content-Length` all digits and > 1,048,576 → 413 `payload_too_large`; then stream the body to DO `POST /ingest`. Stub throws → 503 `unavailable` | `/ingest` (§3) |
| `GET /api/summary`, `GET /api/recommendation` | `REPORT_BASIC_AUTH_SHA256` empty → 503 `not_configured`; Basic check fails → §5; passes → DO `GET /newsletter/<kind>` with the original query string. Stub throws → 503 `unavailable` | `/newsletter/*` |
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
     any other path under `/api/v1/` → forwarded to the DO unchanged (method, path, query, body);
     other `/api/*` → 404 `not_found` without a DO call. Stub throws → 503 `unavailable`.
3. Otherwise `env.ASSETS.fetch(request)` (SPA fallback via `not_found_handling`; a POST gets the asset
   server's 405).
4. Every response (errors, assets, DO answers) leaves with the private headers (§2.3).

The gateway does not read or size-check owner request bodies: the DO keeps today's `api._json_body`
rule (declared `Content-Length` non-numeric or > 16 KiB, or a body > 16 KiB → 400 `invalid_request`).
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

## 3. Internal DO routes

Stub: `env.COORDINATOR.getByName("inbox-v1")`; URL base `https://coordinator`. The gateway builds each
internal request from scratch: only the headers listed here are sent, so client-supplied `x-todofy-*`,
`cookie`, `authorization`, `cf-access-jwt-assertion`, `origin` and `x-csrf-token` never reach the DO.

Required on every request (§4): `x-todofy-internal: 1`, `x-todofy-request-id: <16 hex>`. The DO answers
404 `not_found` to any request without `x-todofy-internal: 1`. Every DO error uses the standard
envelope. D1/storage failures inside a route stay 503 `unavailable` (today's `except JsException`).
DO responses are passed through unchanged, then (owner host only) get the private headers.

`MAINTENANCE_MODE` in the DO (defence in depth; the gateway refuses first with a `retry-after`):
`POST /ingest` and every `POST /api/v1/*` → 503 `maintenance` without `retry-after`; a newsletter
request that needs an on-demand computation → 503 `maintenance` (today's DO `/report` guard). The alarm
loop's maintenance check is unchanged.

### 3.1 `POST /ingest`
Headers: `content-type: application/json` (normalised), `idempotency-key` copied verbatim when present
(repeated headers arrive joined with `, ` and fail the UUID match). Body: the original request stream,
unread. Responses as today: 204 (stored or same bytes; a new event wakes the loop), 400
`invalid_payload` (contract or key ≠ `event_id`), 409 `event_conflict`, 413 `payload_too_large` (DO stops
reading at 1 MiB for chunked bodies), 503 `maintenance`/`unavailable`.

### 3.2 `POST /wake`
From `scheduled()`. No body (the old `{"cron"}` body was never read). → 204. The gateway awaits it;
an exception fails the cron invocation (visible in Workers Logs), as today.

### 3.3 `GET /newsletter/summary`, `GET /newsletter/recommendation[?<original query>]`
Sent only after the gateway accepted the Basic credential. The DO runs today's `reports.serve` minus the
auth part: parse `top` (recommendation only; `parse_top_n`) → 400 `invalid_request`; a stored report
computed since the latest precompute time with status `ok`/`empty_window` → 200 with its stored JSON;
otherwise compute on demand in-process (no stub call; 40 s budget, hourly cap) → 200, 429
`rate_limited` + `retry-after: <s to next UTC hour>`, or 503 `unavailable`/`maintenance`; a computed
payload whose status is not servable → 503 `unavailable`.

### 3.4 `POST /newsletter/auth-failure`
No body. Called by the gateway only after a failed Basic check (§5). The DO reads `auth_failures` for
the current UTC hour: count ≥ 20 → 429 `rate_limited` + `retry-after: <s to next UTC hour>` (no write);
else increment and → 401 `unauthorized` + `www-authenticate: Basic realm="todofy"`.

### 3.5 `GET|HEAD|POST /api/v1/<rest>[?query]` (owner API)
Extra headers: `x-todofy-owner: <canonical owner>` (required; missing, empty, over 254 characters or
without `@` → 401 `unauthorized`), plus `content-type` and `content-length` copied when present (the
body stream is forwarded unread; `api._json_body` checks the declared length before reading). The DO
serves exactly today's `api._route` for these paths, with `owner` from the header:

| Method, path | Result |
|---|---|
| `GET /api/v1/overview` | Overview (D1 counts + DO budgets, now in-process) |
| `GET /api/v1/events?view&state&limit&cursor` | EventPage; 400 `invalid_request` |
| `GET /api/v1/events/{id}` | EventDetail; 404 |
| `POST /api/v1/events/{id}/reconcile` | EventDetail; 400/404/409 (`version_conflict`, `action_not_allowed`, `action_request_conflict`) |
| `GET /api/v1/reminders?limit&cursor` | ReminderPage; 400 |
| `GET /api/v1/reports/latest` | ReportsLatest |
| `POST /api/v1/reports/recompute` | report; 400/409/429 (+`retry-after`)/503; replays via `owner_actions` |
| `GET /api/v1/legacy_text/{id}` | LegacyText; 404 |
| anything else, incl. `/api/v1/csrf`, `/api/v1/setup`, `HEAD` | 404 `not_found` |

The old JSON-command routes `/reconcile`, `/report`, `/event/<id>`, `/legacy_text/<k>` and `/state`
disappear: their callers now run inside the DO and call the methods directly.

### 3.6 `GET /setup`
→ 200 `{"mail_source_id": str, "configured": {"gemini_api_key": bool, "todoist_api_key": bool,
"todoist_project": bool}}` (core-side facts; never values). Not blocked by maintenance. The gateway
answers `GET /api/v1/setup` with the OpenAPI `Setup` body: `build` (gateway `BUILD_SHA` or `unknown`),
`public_host` (lowercased), `hooks_hosts` (csv lowercased), `webhook_path: "/hooks/mail"`,
`mail_source_id` (DO), `access_owner` (canonical owner), `configured` = `{mail_webhook_token:
MAIL_WEBHOOK_TOKEN_SHA256 non-empty, report_basic_auth: REPORT_BASIC_AUTH_SHA256 non-empty}` merged with
the DO's `configured`. DO non-200 or stub failure → 503 `unavailable`.

## 4. Internal headers, trust and request IDs

| Header | Set by | Meaning |
|---|---|---|
| `x-todofy-internal: 1` | gateway, every DO request | marker; the DO is reachable only through the binding, so this is not a credential, it only makes a request that did not come from the gateway's request builder fail closed |
| `x-todofy-request-id` | gateway, every DO request | the request's ID; DO accepts `^[0-9a-f]{16}$`, else generates its own |
| `x-todofy-owner` | gateway, `/api/v1/*` only | canonical owner after Access; trusted because the gateway always overwrites it |

Request ID: the gateway makes one per incoming request (8 bytes from `crypto.getRandomValues`, lowercase
hex, so it still matches `[0-9a-f]{16}`), uses it in its own envelopes and logs
`{"request_id","status","code"}` for each error it emits (nothing else). The DO sets it in a
`contextvars.ContextVar` at the top of `fetch()`; `http.error()` uses the context value when set and
`secrets.token_hex(8)` otherwise (alarms, missing header). DO logs stay `{request_id, status, code}` for
errors and the existing ID/state/code lines.

Responses: the gateway does not copy or strip DO response headers; it only adds the private headers on
the owner host. Hooks-host responses from the DO (`/ingest`, `/newsletter/*`) are returned as they are.

## 5. Basic-auth failure counting across the boundary

- A correct credential never touches the counter: it goes straight to `/newsletter/<kind>`, which never
  reads `auth_failures`, so no number of attacker failures can block the newsletter.
- A failed credential → DO `POST /newsletter/auth-failure` → 401 (counted) or 429 (locked, not counted),
  i.e. at most 20 D1 writes per UTC hour, exactly as today.
- The gateway keeps a per-isolate `lockedHour` (UTC `YYYY-MM-DDTHH`): once the DO answers 429 for a
  failure, later failures in that isolate and hour get 429 `rate_limited` with `retry-after: <s to next
  UTC hour>` without a DO call. This keeps a guessing flood from spending DO requests; the observable
  answer (429 after 20 failures in the hour) is the same.
- Stub failure while counting → 503 `unavailable` (today's `hooks._report`).

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

# Script "todofy" history: v1 created the Python class; v2 deletes it (its state was only counters).
[[migrations]]
tag = "v1"
new_sqlite_classes = ["TodofyCoordinator"]

[[migrations]]
tag = "v2"
deleted_classes = ["TodofyCoordinator"]

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

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TodofyCoordinator"]

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
DO binding with `script_name`, both migrations, the cron and its vars; core gets D1, its migration and
its vars (the current `FIXED_VARS`, `MAIL_SOURCE_ID`, `GEMINI_*`, `TODOIST_DEFAULT_PROJECT_ID`,
`LOOKUP_DELAY_MS`, `REPORT_*`, `LEGACY_TEXT_RETENTION_DAYS`, the four switches); both get
`account_id`, `workers_dev: false`, `preview_urls: false`, `observability.enabled`, `BUILD_SHA`,
`MAINTENANCE_MODE` and `TODOFY_PUBLIC_HOST`. The core needs the public host too (deviation from §1's
table, found while writing the generator): `reminder.py` puts `https://<TODOFY_PUBLIC_HOST>/attention`
into the daily reminder body, and `tests/runtime/test_reminder_daily.py` checks it, so the core's test
vars need it as well. The shape of each config is copied from its checked-in toml by an explicit key
list (core: `name`, `main`, `base_dir`, `compatibility_date`, `compatibility_flags`, `migrations`;
gateway: `name`, `main`, `compatibility_date`, `assets`, `durable_objects`, `migrations`, `triggers`);
a unit test fails when either toml gains a key the generator neither copies nor replaces.
`.gitignore` adds the gateway files (`wrangler.test-run-*.json` belongs to the harness change, §7).

### 6.4 Deploy order (CI, from one verified commit)
```sh
npx --no-install wrangler d1 migrations apply DB --remote --config wrangler.production.ci.json
uv run pywrangler deploy --config wrangler.production.ci.json                       # todofy-core first
npx --no-install wrangler deploy --config gateway/wrangler.production.ci.json \
  --secrets-file gateway/wrangler.production.secrets.json                           # then the gateway
```
Core always deploys first, so the routes a new gateway calls exist before it calls them; a core change
must keep serving the previous gateway's requests until the gateway deploy finishes.

First cutover only (owner steps, cannot be done by CI because CI never sees these values):
1. Before merging the split to `main` (CI deploys core and gateway back to back, so there is no pause
   between them for a manual step): `npx wrangler secret put GEMINI_API_KEY --name todofy-core` and the
   same for `TODOIST_API_KEY`. `todofy-core` does not exist yet; wrangler 4.142.0 then asks to create it
   and uploads an empty placeholder script (`export default { fetch() {} }`, no migrations) holding only
   the secrets (`createDraftWorker` in its bundled source; not tried against the account). The first
   deploy replaces the code, applies `v1` and keeps the secrets. Without this the new object would run
   the report precompute without keys as soon as the gateway's first cron wakes it.
2. The gateway deploy replaces the Python script `todofy` in place (secrets on `todofy` persist) and
   applies `v2`, deleting the old object and its counters. What is lost and why that is acceptable:
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
   `/newsletter/auth-failure` (D1 read and write) can answer; a broken core, binding or D1 gives 503 and
   fails the job. The probe spends one of the hour's 20 failure slots and never blocks the correct
   credential (§5). Opening the owner UI overview proves the Access → owner API path.

Not verified locally (needs the account): that Cloudflare accepts `v2 deleted_classes` on `todofy` in
the same deploy that binds `TodofyCore` from `todofy-core`. Both configs pass
`wrangler deploy --dry-run`, which never computes migrations against the account.

After the cutover (`todofy` at tag `v2`): remove both `[[migrations]]` blocks from
`gateway/wrangler.toml` and the two gateway test tomls, and make `deploy/test_generate_ci_config.py`
assert that the gateway emits no migrations. wrangler sends no migrations for an empty list, which is
right for the existing `todofy` and for a fresh account. Until then a first deploy of `todofy` on a new
account (or after the script was deleted) would upload `v1 new_sqlite_classes` for a class the TS
script does not export, because wrangler sends every step when the script has no tag
(`getMigrationsToUpload` in wrangler 4.142.0); drop the two blocks before such a deploy.

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
3. Deploy the last pre-split commit with its `wrangler.toml` migrations extended to the full history of
   the script: `v1` `new_sqlite_classes`, `v2` `deleted_classes`, `v3` `new_sqlite_classes`, all
   `TodofyCoordinator`. wrangler then sends only `v3` (old tag `v2`). A plain revert (only `v1`) is not
   refused by wrangler 4.142.0: it warns that the published tag `v2` is not in the config and sends every
   configured step as `v2` → `v1`. Whether Cloudflare accepts that is unverified, so do not rely on it.
   The pre-split code has the D1 binding and all secrets it reads; it deploys in maintenance because the
   GitHub variable is still `true`.
4. Delete the core: `npx wrangler delete --name todofy-core`. No gateway binds its class any more, so
   this removes the script, its object (counters only, the same kind the cutover drops) and its alarm.
   A later forward cutover must put `GEMINI_API_KEY`/`TODOIST_API_KEY` on `todofy-core` again and give
   the gateway a new tag `v4` with `deleted_classes`.
5. Set `TODOFY_MAINTENANCE_MODE=false` and redeploy.


> Class name: the core class is `TodofyCore`. Cloudflare refuses a `deleted_classes` migration while any
> binding names a class of the same name, even in another script (error 10061), so the gateway could not
> delete its old `TodofyCoordinator` while binding `todofy-core`'s `TodofyCoordinator`. The core renames its
> class in migration `v2` (`renamed_classes`); the gateway binds `TodofyCore` and keeps its own `v1`/`v2` history.

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
  alone (wrangler then answers every DO call with a plain-text 503 `Worker "todofy-core" not found`).
- Everything else (ports, host-header clients, `trigger_cron`, `headers_only_status`, the
  answer-before-body quirk) is unchanged.
- `tests/runtime/test_gateway_boundary.py` covers the boundary itself: a test-only JS primary in front of
  the real core sends requests without the gateway's headers (§3, §4), forged client `x-todofy-*`
  headers through the gateway, the hashed-asset cache header and the SPA fallback guard (§2.3), and
  `/health` from a gateway started without the core.

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
| gateway config with `v1` new + `v2 deleted_classes` and a binding with `script_name` | local dev works; `wrangler deploy --dry-run` passes for both configs |
| core config without any DO binding (class only in its migration) | local dev works; dry-run passes |
| separate processes via `WRANGLER_REGISTRY_PATH` | works once each has its own inspector port; binding shows `[connected]` |
