# Home dashboard: design

The Worker `home` on `home.ziyixi.science` is the owner's single ops view for Mail Hero and Todofy,
and it runs three jobs: a daily end-to-end canary with a unified ops digest, quota guardrails, and the
cross-app contract tests of `contracts/ops-v1`. It talks to the apps only through their `Ops`
entrypoints (service bindings) and never imports `mail-hero/` or `todofy/` code. Mail Hero's
`AGENTS.md` rules apply here too: Workers Free, bounded reads and calls, no mail content anywhere,
synthetic test data only, no secrets in logs.

Status: the Worker, its tests and the config generator are implemented (the UI, CI jobs and production
checks are separate steps). Nothing is deployed; see `verification.md` once it exists.

## 1. Layout and ownership

| Path | Owner (build step) | Contents |
| --- | --- | --- |
| `worker/` | worker | TypeScript Worker + SQLite Durable Object; `package.json`/lockfile, `tsconfig.json` (Todofy gateway flags + `erasableSyntaxOnly`), `eslint.config.js` (strictTypeChecked), `wrangler.toml` (base/local shape), `vitest.config.ts` (Node unit tests), `vitest.runtime.config.ts` (workerd suite) |
| `worker/src/api-types.ts` | worker (shared) | Owner API types and constants; the UI imports it by relative path. Change it only together with the UI |
| `worker/test/runtime/` | worker | Miniflare harness (`harness.ts`, own `tsconfig.json` with Node types), stub apps from `test/stubs/ops-stub.js` |
| `deploy/` | worker | `generate-ci-config.mjs` and `test/*.test.mjs` (`node --test`) |
| `web/` | web | React 19 + Vite 7 + TypeScript UI (Chinese), vitest + testing-library, builds `web/dist` (served by `ASSETS`) |
| `docs/` | docs | `design.md` (this), `setup.md`, `limits.md` (or §7 here), `verification.md` |
| `.github/`, root docs, `packages/edge-auth/SPEC.md` | integration | CI jobs (§10), root README/AGENTS, the SPEC condensation |

Toolchain versions are Todofy's: Node 26, TypeScript 5.9.3, vitest 4.1.11, eslint 10.11.0,
typescript-eslint 8.71.0, `@cloudflare/workers-types` 5.20260929.1, wrangler 4.142.0 (its own
miniflare 5.20260926.0-alpha and esbuild 0.28.1 are pinned as direct dev dependencies for the harness),
React 19.3.0, Vite 7.3.6, `@tanstack/react-query` 5.104.0, `lucide-react` 1.48.0. `@ziyixi/edge-auth`
is `file:../../packages/edge-auth`. `contracts/ops-v1/ops-v1.ts` is imported by relative path
(`../../../contracts/ops-v1/ops-v1.ts` from `worker/src`), `validate.mjs` only in tests.

Worker modules (the worker builder may merge or split, keeping pure logic separate from I/O):

| File | Responsibility |
| --- | --- |
| `src/index.ts` | `export default { fetch, scheduled }`, `export { HomeState }`. No business logic |
| `src/env.ts` | `Env` (§2) |
| `src/http.ts` | routing, edge-auth adapter (Access, CSRF, private headers), error envelopes, request IDs |
| `src/state.ts` | `HomeState` (RPC methods §4), SQL schema (§3), the mutex, persistence |
| `src/ops-client.ts` | one wrapper per `Ops` method: timeout, error-code mapping, shape guard (§5.1) |
| `src/usage.ts` | the GraphQL query (verbatim §7.2), fetch, parse, `QuotaRow` building, projection |
| `src/limits.ts` | Free allowances with doc URLs (§7.1) |
| `src/guard.ts`, `src/canary.ts`, `src/digest.ts` | pure decision functions taking `now` and prior state |
| `src/time.ts` | UTC day/month helpers, next midnight |

## 2. Configuration

Bindings: `MAIL_HERO` = service `mail-hero`, entrypoint `Ops`; `TODOFY` = service `todofy`, entrypoint
`Ops`; `HOME` = Durable Object class `HomeState` (migration `v1`, `new_sqlite_classes`); `ASSETS`
(`../web/dist`, `run_worker_first = true`, SPA fallback). `workers_dev = false`, `preview_urls = false`,
route `home.ziyixi.science` with `custom_domain = true` (production config only). One cron
`*/30 * * * *` (the account uses 1 of its 5 Free cron triggers today).

| Name | Kind | Value / rule |
| --- | --- | --- |
| `PUBLIC_HOST` | var | the dashboard host; CSRF origin `https://<host>` and the digest's `dashboard_url` |
| `ACCESS_ISSUER`, `ACCESS_AUDIENCE` | var | the Access app "Home" (issuer `https://<team>.cloudflareaccess.com`, AUD 64 hex) |
| `ACCOUNT_ID` | var | 32 hex, the GraphQL `accountTag` |
| `MAIL_HERO_URL`, `TODOFY_URL` | var | `https://<host>/` links to the app UIs (from the existing `MAIL_HERO_PUBLIC_HOST`, `TODOFY_PUBLIC_HOST`) |
| `CANARY_UTC_HOUR` | var | integer 0–23, default 16; invalid → 16 |
| `BUILD_SHA` | var | the deployed commit (`dev` locally) |
| `ACCESS_OWNER`, `ACCESS_OWNER_ALIASES` | secret | printable-ASCII emails, ≤ 8 aliases, ≤ 2048 chars; empty aliases uploaded as `" "` |
| `CSRF_SIGNING_KEY` | secret | `^[0-9a-fA-F]{64}$` |
| `CF_ANALYTICS_TOKEN` | secret | API token used **only** as `Authorization: Bearer` on `POST https://api.cloudflare.com/client/v4/graphql` (URL is a constant, not config). Never logged, stored, echoed or sent elsewhere. Today a broader token is reused; replace it with an "Account Analytics: Read" token (setup.md) |
| `DEV_AUTH_BYPASS` | local only | `true` enables the loopback bypass; the generator never emits it |

## 3. Durable Object storage (`HomeState`, instance `home-v1`)

Created with `CREATE TABLE IF NOT EXISTS` in the constructor (inside `blockConcurrencyWhile`).
Times are epoch milliseconds.

```sql
-- Snapshots and small state documents (JSON). Keys:
--   status:mail-hero, status:todofy  {checked_at, ok, error, consecutive_failures, status, status_at}
--   usage       {fetched_at, day, month, rows[], unclassified_r2_operations, last_error, last_error_at,
--                consecutive_failures, last_attempt_at}
--   guard       {level, reason, until, entered_day, entered_at}        -- the auto decision (§5.3)
--   guard_override {level, until, set_at}
--   digest      {last_key, last_sent_at, last_generated_at, last_receipt, last_error, items[]}
--   meta        {last_tick_at, last_tick_scheduled, last_refresh_at}
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  doc TEXT NOT NULL CHECK (length(doc) <= 65536),
  updated_at INTEGER NOT NULL
);
-- What the dashboard last asked each app for and got back.
CREATE TABLE IF NOT EXISTS guard_applied (
  app TEXT PRIMARY KEY CHECK (app IN ('mail-hero', 'todofy')),
  input TEXT,                 -- last SetGuardInput sent (JSON)
  state TEXT,                 -- GuardState of the last success (JSON)
  last_call_at INTEGER,
  last_error TEXT,            -- AppErrorCode of the last failure, NULL after a success
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS canary_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'manual')),
  day TEXT NOT NULL,          -- UTC YYYY-MM-DD
  phase TEXT NOT NULL CHECK (phase IN ('starting', 'delivering', 'consuming', 'done')),
  outcome TEXT CHECK (outcome IN ('ok', 'failed', 'skipped')),
  stage TEXT CHECK (stage IN ('start', 'delivery', 'consumer')),
  code TEXT,
  event_id TEXT,
  created_at INTEGER NOT NULL,
  queued_at INTEGER, delivered_at INTEGER, completed_at INTEGER, finished_at INTEGER,
  deadline_at INTEGER NOT NULL,
  doc TEXT NOT NULL           -- {delivery:{...}, consumer:{...}, polls}
);
CREATE INDEX IF NOT EXISTS canary_runs_by_created ON canary_runs (created_at);
CREATE INDEX IF NOT EXISTS canary_runs_by_day ON canary_runs (day, kind);
-- First time each digest item key (source:code) was seen in the current episode.
CREATE TABLE IF NOT EXISTS item_since (key TEXT PRIMARY KEY, since INTEGER NOT NULL);
```

Bounds: `state` ≤ 8 rows; `guard_applied` 2 rows; `canary_runs` ≤ 4 per day (1 scheduled + 3 manual),
deleted after 60 days (`DELETE ... WHERE created_at < now - 60 d` every tick, index-driven);
`item_since` ≤ 40 rows, rows of inactive keys deleted every tick. No per-tick history is kept (the
GraphQL API has the history). Each tick writes about 10–40 rows; the page reads ≤ 30 rows per call.

## 4. Handlers and `HomeState` RPC

The fetch and scheduled handlers stay within Free's 10 ms CPU: they authenticate, route and call
`env.HOME.get(env.HOME.idFromName('home-v1'))`. All work runs in `HomeState` (30 s CPU per invocation).
RPC results are values, never thrown errors:

```ts
class HomeState extends DurableObject<Env> {
  tick(scheduledTime: number): Promise<{ ran: boolean }>;                      // cron
  overview(refresh: boolean): Promise<OverviewResponse>;                      // GET /api/v1/overview
  startCanary(): Promise<{ ok: true; run: CanaryRun } | { ok: false; code: 'canary_active' | 'canary_limit' | 'unavailable' }>;
  setGuardOverride(level: GuardLevel): Promise<{ ok: true; guard: GuardView } | { ok: false; code: 'unavailable' }>;
}
```

- `scheduled` **awaits** `tick(controller.scheduledTime)` (not `waitUntil`, whose 30 s tail could cut a
  slow tick; a cron invocation may run 15 min wall time). A tick whose `scheduledTime` is within 10 min
  of the last completed tick is skipped (`ran: false`), so a retried cron event is harmless.
- `tick`, a refreshing `overview`, `startCanary` and `setGuardOverride` run one at a time through an
  in-memory promise chain (service calls await, so input gates alone would interleave them). A plain
  `overview(false)` only reads `state`/`canary_runs` and is not serialized.
- Every decision function takes `now` explicitly: the tick passes `scheduledTime`, the API paths
  `Date.now()`. The runtime tests drive time through `scheduledTime`.
- Log one JSON line per tick and per API error: codes, counts and durations only (never the token,
  owner, JWTs or app response text).

## 5. The tick

Order: (1) status, (2) usage, (3) guard, (4) canary, (5) digest, (6) cleanup and persist. Every
service call has a 10 s timeout; the GraphQL call 15 s; the tick makes at most 8 outbound calls
(2 `status`, ≤ 2 `setGuard`, ≤ 2 canary calls, ≤ 1 `reportOps`, 1 GraphQL), well under Free's 50
subrequests and 32 Worker invocations per request.

### 5.1 Calling the apps (`ops-client.ts`)

- Only the methods of `MailHeroOps`/`TodofyOps` in `ops-v1.ts` are called (tested, §9).
- Result: `{ok: true, value}` or `{ok: false, code}`. A rejection whose `Error.message` is an
  `OpsErrorCode` (`invalid_input`, `busy`, `unavailable`) keeps that code; the timeout gives `timeout`;
  any other rejection (binding error, deploy in progress, unknown method) gives `unavailable`; a value
  that fails a minimal shape guard (discriminant fields and types the dashboard reads) gives
  `invalid_output`. All of these are "unavailable" for decisions; `invalid_input` is logged as a
  dashboard bug and never retried in a tight loop (at most once per tick).
- `status()` of each app: once per tick (every 30 min ≥ `OPS_LIMITS.statusMinIntervalSeconds`), and
  on an owner refresh only if the last attempt for that app is ≥ 10 min old. Both in parallel.
- Capabilities come from the last successful status of that app: `guard` gates `setGuard`;
  `canary_producer` (Mail Hero) and `canary_consumer` (Todofy) gate the canary; `ops_digest` (Todofy)
  gates `reportOps`.

### 5.2 Usage (`usage.ts`)

One GraphQL request per tick (and at most one per 60 s for owner refreshes; the API allows 300 per
5 min). Variables: `a` = `ACCOUNT_ID`, `day` = tick's UTC date, `start` = `<day>T00:00:00Z`, `end` =
tick time (seconds, `Z`), `month` = `<YYYY-MM>-01`. `fetch` with `redirect: 'manual'`, JSON body,
bearer token; a response over 1 MB, a non-200 status (`http_<n>`), an `errors` array
(`graphql_error`), a missing `data.viewer.accounts[0]` (`invalid_response`), a network error
(`network_error`) or timeout (`timeout`) is a failure that keeps the previous rows and increments
`consecutive_failures`. No token → `not_configured` without a request. The status of the view:
`ok` when fetched for the current UTC day within the last 90 min, else `stale`, `unavailable` before
the first success, `not_configured` without a token. Rows and conversion: §7.

Projection: daily `used × 86400 / elapsed_seconds` of the UTC day (null while elapsed < 1 h); monthly
`used × days_in_month / elapsed_days` (elapsed in fractional days since 00:00 UTC on the 1st, null
while < 1 day); storage none. Percent values keep one decimal.

### 5.3 Guard (`guard.ts`)

Trigger resources (`guard_trigger: true`): the seven daily ones and `r2_class_a`, `r2_class_b`. Storage
never triggers (shed defers cleanup, which would make storage worse).

Desired state, evaluated each tick in this order:

1. **Owner override** (§6 `POST /api/v1/guard`) while `now < override.until`:
   `shed` → `{level: 'shed', reason: 'owner_shed', until: override.until}` (until = set time + 24 h);
   `normal` → `{level: 'normal', reason: 'owner_clear'}`, which suppresses the automatic shed until the
   next UTC midnight (the override's `until`). While a `normal` override is in force the automatic
   decision is held at normal (setting it also resets an automatic shed), so a cleared episode cannot
   come back through the old shed's own `until` when the override ends. An expired override is deleted.
2. **Fresh usage** (fetched for the tick's UTC day, ≤ 90 min old):
   - enter shed when any trigger resource has `percent ≥ 80`. `reason` = `quota_<resource id>` of the
     highest percent (e.g. `quota_d1_rows_read`), `until` = next UTC midnight + 10 min (always ≤ 24 h
     10 min ahead, inside the contract's 36 h). `entered_day` = today;
   - stay shed while the auto guard's `entered_day` is today and the highest trigger percent is ≥ 70
     (hysteresis); reason and `entered_day` stay, `until` is recomputed (same value within a day);
   - otherwise normal (`reason: 'quota_normal'`). A new UTC day therefore starts normal and re-enters
     shed only at ≥ 80 % of that day's usage (monthly R2 operations can re-enter at the first tick of a
     new day; that renewal is the new day's `until`).
3. **No fresh usage**: keep an auto shed until its `until` without renewing it (it then lapses to
   normal, the safe default); never enter shed without data.

Applying (per app, only if its last status lists `guard`):

- Input: shed → `{level: 'shed', reason, until}`; normal → `{level: 'normal', reason, until: null}`.
- Call `setGuard` only when the input differs from `guard_applied.input` of the last success, or the
  app's status of this tick shows a different effective guard (its state was lost, or it expired),
  or the last attempt failed. Normal is sent only if the app is (or was last left) shed. So a steady
  state makes no calls; a day with an 80 % breach makes at most one shed call and one clear call per
  app plus retries. An `invalid_input` answer (e.g. clock skew beyond 36 h) is recorded and retried at
  most once per tick.
- Both apps are called in parallel; each result updates `guard_applied`.

### 5.4 Canary (`canary.ts`)

At most one active run (phase ≠ `done`) at a time.

- **Scheduled start**: at the first tick with UTC hour ≥ `CANARY_UTC_HOUR` on a day without a
  scheduled run (and no active run), create `canary-YYYY-MM-DD` (`kind: scheduled`, `deadline_at` =
  created + 2 h) and make the first start attempt in the same tick. A manual run in progress delays it
  to the next tick after it ends (still that day).
- **Manual start** (`POST /api/v1/canary`): refused with `canary_active` while a run is active and
  `canary_limit` after 3 manual runs this UTC day; run ID `canary-manual-YYYYMMDDTHHMMSSZ` (UTC, fits
  `RunId`; a run ID is never reused, because Mail Hero is idempotent per `run_id`: a collision within
  the same second takes the next free second); first start attempt at once, after polling any
  `status()` whose last attempt is ≥ 10 min old; later steps on ticks.
- **Start attempt** (phase `starting`, at most one `startCanary` per tick):
  preconditions from the last successful statuses ≤ 60 min old: Mail Hero lacks `canary_producer` →
  done `skipped/start/canary_producer_missing`; Todofy lacks `canary_consumer` → done
  `skipped/start/canary_consumer_missing` (never start a canary a consumer might treat as real mail);
  no such status → wait (retry next tick). Then `MAIL_HERO.startCanary({run_id})`:
  `queued` → phase `delivering`, `event_id`, `queued_at`, `deadline_at` = queued + 2 h;
  `paused`/`unavailable` → wait (the call wrote nothing and is idempotent per `run_id`), remember the
  reason; `invalid_input` → done `failed/start/invalid_input`; other errors → wait, remember the code.
  At the deadline: done `skipped/start/<last paused or unavailable reason>` if the last answer was
  paused/unavailable, `skipped/start/status_unavailable` if statuses were missing, else
  `failed/start/<last error code>`.
- **Delivering** (one `canaryDelivery(event_id)` per tick): `delivered` → store `delivered_at`,
  phase `consuming`, and call `canaryResult` in the same tick (the deadline is not applied in that
  tick, so a delivery completing at the deadline still gets one consumer poll); `failed` → done
  `failed/delivery/<error_code>`; `unknown` → done `failed/delivery/unknown_event`; `pending`/`paused`
  → wait. At the deadline: `pending` → `failed/delivery/timeout`; `paused` → `skipped/delivery/<error_code
  or 'paused'>` (a held run is not a pipeline failure); no answer ever (every call failed) →
  `failed/delivery/unreachable`. Each phase polls first and then applies the deadline to what it saw.
- **Consuming** (one `canaryResult(event_id)` per tick): `ok` → done `ok`, `completed_at`; `failed` →
  done `failed/consumer/<error_code>`; `not_seen`/`processing` → wait. At the deadline:
  `processing` with `waiting_code` → `skipped/consumer/<waiting_code>`; `processing` without →
  `failed/consumer/timeout`; `not_seen` → `failed/consumer/not_seen`; no answer →
  `failed/consumer/unreachable`.
- Every call increments `polls` and stores `attempts`, `last_http_status`, `error_code`,
  `waiting_code`. The UI timeline uses `created_at`, `queued_at`, `delivered_at` (Mail Hero's value),
  `completed_at` (Todofy's value) and `finished_at`.
- Calls per day: about 1 start + 4 delivery/result polls per run; ≤ 4 runs a day.

### 5.5 Digest (`digest.ts`)

Items are `OpsReportItem`s (codes, numbers and times only), **warning and critical only**, deduplicated
by `source:code`, sorted critical first, then `source`, then `code`, at most 20, and trimmed from the
end until the compact JSON of the report is ≤ 8192 bytes. `since` = the app signal's `since` when
present, else the first tick the key was active (`item_since`).

| Source | Code | Severity | When | Metrics |
| --- | --- | --- | --- | --- |
| `cloudflare` | `<resource id>_high` (e.g. `d1_rows_read_high`) | warning ≥ 80 %, critical ≥ 95 % | any quota row (storage included), fresh usage | `percent`, `used`, `limit`, `projected_percent` (when known) |
| `dashboard` | `usage_unavailable` | warning | token set and no successful fetch for ≥ 2 h (or never) | `consecutive_failures`, `http_status` (0 if none) |
| `dashboard` | `usage_not_configured` | warning | no `CF_ANALYTICS_TOKEN` | – |
| `dashboard` | `guard_shed` | warning | desired guard is shed | `hours_left`, `manual` (0/1) |
| `mail-hero` / `todofy` | `guard_apply_failed` | warning | ≥ 2 consecutive `setGuard` failures | `consecutive_failures` |
| `dashboard` | `canary_start_failed` / `canary_not_delivered` / `canary_consumer_failed` | critical | the latest finished run failed at stage start / delivery / consumer | `attempts`, `last_http_status` (if any), `timed_out` (0/1) |
| `dashboard` | `canary_unsupported` | warning | the latest finished run was skipped for a missing capability | – |
| `mail-hero` / `todofy` | `app_unreachable` | critical | ≥ 2 consecutive failed `status()` calls | `consecutive_failures` |
| `mail-hero` / `todofy` | `app_down` | critical | last status `health: down` | – |
| `mail-hero` / `todofy` | each active signal's `code` | its severity | warning/critical signals of the last status (≤ 60 min old) | the signal's metrics |

Sending (`TODOFY.reportOps`, only while Todofy's last status lists `ops_digest`): the key is the sorted
list of `source:code:severity`. Send when the key differs from the last **successfully** sent key, or
the last success is ≥ 6 h old, or at the 23:30 UTC tick when the last success is ≥ 60 min old (so the
next day's reminder carries fresh metrics). Report: `{generated_at: tick time, items,
dashboard_url: 'https://<PUBLIC_HOST>/'}`; an empty `items` list is sent when the set becomes empty (it
clears Todofy's ops section). A receipt with `stored: false` counts as sent. Failures keep the old key,
so the next tick retries. This is the only way the dashboard creates Todoist tasks (through Todofy's
one-per-day reminder); Mail Hero's `ALERT_WEBHOOK_URL` stays unconfigured.

The overview banner (`overall`) is `critical` if any item is critical, else `warning` if any is
warning, else `ok`; `unknown` before the first tick. `codes` lists the item codes (≤ 20).

## 6. Owner API

All paths except `/health` go through Access (edge-auth) first; then `/api/v1/*` or assets.

| Route | Auth | Result |
| --- | --- | --- |
| `GET /health` | none (Access still fronts the host) | `HealthResponse` `{service: 'home', status: 'ok', build}`; no DO call |
| `GET /api/v1/csrf` | Access | `CsrfResponse` + `Set-Cookie: home_csrf=...` |
| `GET /api/v1/overview[?refresh=1]` | Access | `OverviewResponse` from the cached snapshot; `refresh=1` fetches usage (≥ 60 s since the last fetch attempt) and status (per app ≥ 10 min) first, else returns the cache with `refreshed: false` |
| `POST /api/v1/canary` | Access + Origin + CSRF | 202 `CanaryStartResponse`; 409 `canary_active`; 429 `canary_limit` |
| `POST /api/v1/guard` | Access + Origin + CSRF | 200 `GuardResponse`, body `GuardRequest` `{level: 'shed' \| 'normal'}` (≤ 1 KiB JSON, else 400) |
| other `/api/*` | Access | 404 `not_found`; wrong method 405 |
| anything else | Access | `ASSETS` (SPA fallback) |

The shapes are `worker/src/api-types.ts`. Details:

- **Access** (`createAccessVerifier()` at module scope), Todofy's parameters: `emailMatch:
  'case-insensitive'` (ASCII fold), owner + aliases, `nbfLeewaySeconds: 60`, `tokenSource: {emptyHeader:
  'use-cookie', cookie: 'last'}`, `jwks: {ttlMs: 600_000, refreshCooldownMs: 60_000}` (10 min TTL: the
  stricter value the SPEC recommends; this is the one deviation from Todofy's 1 h). Dev bypass:
  `{enabled: DEV_AUTH_BYPASS === 'true', hosts: 'loopback-http', principal: asciiLowerCase(owner),
  whenNotLocal: 'refuse'}` (only `http://localhost|127.0.0.1|[::1]` without `cf-ray`). Failures:
  `not_configured` → 503 `access_not_configured`; `dev_bypass_refused` → 503 `access_not_configured`;
  `missing_token`/`invalid_token` → 401 `unauthorized`; `keys_unavailable` → 503 `unavailable`.
- **CSRF**: key `importHmacKeyHex(CSRF_SIGNING_KEY)` resolved before anything else on `/api/v1/csrf`
  and mutations (null → 503 `not_configured`); `issueCsrf(request, owner, {cookieName: 'home_csrf',
  key})`; mutations `verifyCsrf(request, owner, {cookieName: 'home_csrf', key, allowedOrigins:
  ['https://' + PUBLIC_HOST] (+ the request origin when bypassed)})` → 403 `csrf_failed`. The CSRF check
  comes before reading the body.
- **Headers**: every response through `withPrivateHeaders` with `STRICT_CSP` (no remote fonts, scripts
  or connections); API and errors `cache-control: no-store`; `/assets/*` 200 non-HTML may use
  `private, max-age=31536000, immutable` like Todofy. JSON is `application/json; charset=utf-8`.
- **Errors**: `ApiError` `{error: {code, message, request_id}}` with Chinese messages; one log line
  `{request_id, status, code}`.

## 7. Limits and the usage query

### 7.1 Workers Free allowances used (checked 2026-09-29)

Account-wide: other Workers, databases and buckets in the account count too. "GB" is taken as 10⁹
bytes (the docs do not say; decimal is the smaller, more cautious limit).

| Resource id | Period | Allowance | Source |
| --- | --- | --- | --- |
| `workers_requests` | day (00:00 UTC) | 100,000 requests | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#daily-requests), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| `d1_rows_read` | day | 5,000,000 rows | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| `d1_rows_written` | day | 100,000 rows | same |
| `d1_storage` | total | 5 GB per account | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| `d1_database_max` | per database | 500 MB (largest database) | same |
| `do_requests` | day | 100,000 (HTTP, RPC sessions, alarms) | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| `do_duration` | day | 13,000 GB-s | same |
| `do_rows_read` | day | 5,000,000 rows (SQLite) | same |
| `do_rows_written` | day | 100,000 rows (SQLite; `setAlarm` counts one) | same |
| `do_storage` | total | 5 GB (SQLite) | same, [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| `r2_class_a` | month | 1,000,000 operations | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| `r2_class_b` | month | 10,000,000 operations | same |
| `r2_storage` | month (GB-month) | 10 GB-month | same |

Other limits this design relies on: 10 ms CPU per HTTP request and per cron invocation, 50
subrequests per invocation, 5 cron triggers per account, 128 MB memory
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)); 30 s CPU per Durable
Object invocation ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/));
requests to static assets are free ([pricing](https://developers.cloudflare.com/workers/platform/pricing/));
a service-binding call counts as a subrequest, at most 32 Worker invocations per request
([service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)),
and "requests made from your Worker to another worker via a Service Binding do not incur additional
request fees" (pricing); GraphQL Analytics API: 300 queries per 5 minutes
([limits](https://developers.cloudflare.com/analytics/graphql-api/limits/)). Free daily limits reset at
00:00 UTC; exceeding one fails further operations of that type (DO pricing). R2's free tier is monthly
and its GB-month averages the daily peak over the billing period; the dashboard uses the UTC calendar
month to date as the period and the current bytes against 10 GB, an approximation.

Not verified (to check in production, `verification.md`): whether an app's `Ops` calls show up in
`workersInvocationsAdaptive` for `mail-hero`/`todofy`; whether R2 `actionType` values beyond the lists
below occur; the analytics lag at a tick.

### 7.2 The query (verbatim; verified 2026-09-29 against the live account)

```graphql
query($a: string!, $day: Date!, $start: Time!, $end: Time!, $month: Date!) { viewer { accounts(filter: {accountTag: $a}) {
  workers: workersInvocationsAdaptive(limit: 20, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests errors subrequests } dimensions { scriptName } quantiles { cpuTimeP50 cpuTimeP99 } }
  d1: d1AnalyticsAdaptiveGroups(limit: 10, filter: {date: $day}) { sum { rowsRead rowsWritten readQueries writeQueries } dimensions { databaseId } }
  d1s: d1StorageAdaptiveGroups(limit: 10, filter: {date: $day}) { max { databaseSizeBytes } dimensions { databaseId } }
  doInv: durableObjectsInvocationsAdaptiveGroups(limit: 10, filter: {date: $day}) { sum { requests errors } dimensions { scriptName } }
  doPer: durableObjectsPeriodicGroups(limit: 10, filter: {date: $day}) { sum { activeTime rowsRead rowsWritten cpuTime storageDeletes storageReadUnits storageWriteUnits } dimensions { namespaceId } }
  doSto: durableObjectsStorageGroups(limit: 5, filter: {date: $day}) { max { storedBytes } }
  r2ops: r2OperationsAdaptiveGroups(limit: 50, filter: {date_geq: $month, date_leq: $day}) { sum { requests } dimensions { actionType bucketName } }
  r2sto: r2StorageAdaptiveGroups(limit: 10, filter: {date: $day}) { max { payloadSize metadataSize objectCount } dimensions { bucketName } }
} } }
```

`usage.ts` holds this text as a constant; a unit test compares it (whitespace-normalised) with the
copy above. `durableObjectsStorageGroups` returned `[]` on this account: `do_storage.used` is then
null ("无数据"), never 0.

### 7.3 Mapping

| Resource id | Field → value | Unit conversion | Breakdown by |
| --- | --- | --- | --- |
| `workers_requests` | Σ `workers[].sum.requests` | – | `scriptName` |
| `d1_rows_read` / `d1_rows_written` | Σ `d1[].sum.rowsRead` / `rowsWritten` | – | `databaseId` |
| `d1_storage` | Σ `d1s[].max.databaseSizeBytes` | bytes | `databaseId` |
| `d1_database_max` | max `d1s[].max.databaseSizeBytes` | bytes | `databaseId` |
| `do_requests` | Σ `doInv[].sum.requests` | – | `scriptName` |
| `do_duration` | Σ `doPer[].sum.activeTime` | µs → GB-s: `activeTime / 1e6 × 0.128` (128 MB / 1 GB, as DO pricing's examples compute it) | `namespaceId` |
| `do_rows_read` / `do_rows_written` | Σ `doPer[].sum.rowsRead` / `rowsWritten` | – | `namespaceId` |
| `do_storage` | max `doSto[].max.storedBytes` (null if `[]`) | bytes | – |
| `r2_class_a` | Σ `r2ops[].sum.requests` where `actionType` ∈ A, plus unclassified | – | `bucketName` |
| `r2_class_b` | Σ `r2ops[].sum.requests` where `actionType` ∈ B | – | `bucketName` |
| `r2_storage` | Σ `r2sto[].max.payloadSize + metadataSize` | bytes | `bucketName` |

Class A: `ListBuckets, PutBucket, ListObjects, PutObject, CopyObject, CompleteMultipartUpload,
CreateMultipartUpload, LifecycleStorageTierTransition, ListMultipartUploads, UploadPart, UploadPartCopy,
ListParts, PutBucketEncryption, PutBucketCors, PutBucketLifecycleConfiguration`. Class B: `HeadBucket,
HeadObject, GetObject, UsageSummary, GetBucketEncryption, GetBucketLocation, GetBucketCors,
GetBucketLifecycleConfiguration`. Free: `DeleteObject, DeleteBucket, AbortMultipartUpload`. Any other
`actionType` counts as Class A (cautious) and adds to `unclassified_r2_operations`. A dataset that
returns exactly its `limit` rows sets `truncated` on its rows (the sum is a lower bound). Worker CPU
quantiles (µs) and error counts are not quota rows; the UI may show them per script.

### 7.4 What the dashboard itself costs per day

48 cron ticks → 48 Worker requests + 48 DO requests; ≤ 96 `status()` calls (Mail Hero ≤ 6 and Todofy
≤ 5 D1 statements each); ≤ 48 GraphQL queries; a few `setGuard`/canary/`reportOps` calls; one canary a
day (one synthetic message, one Gemini call in Todofy). Owner page loads add a few Worker and DO
requests each. All far below every row above.

## 8. UI (`web/`)

One page, Chinese, mobile-first (single column < 720 px, two columns above), keyboard accessible
(native buttons, `<dialog>` confirmations with focus return, visible focus), light/dark through
`prefers-color-scheme` CSS tokens, system font stack, no remote fonts, images or requests other than
same-origin `/api/v1/*`. Times with `Intl.DateTimeFormat('zh-CN', …)` in the browser's time zone,
durations in words.

- **Banner**: `overall.level` with text (正常 / 需要关注 / 严重 / 暂无数据) and the item codes as labels.
- **App cards** (Mail Hero, Todofy): health, reachability and last check, modes, guard (level, reason,
  until, deferred jobs), active signals with plain-text labels (unknown codes shown raw), key counters,
  last backup, link to the app UI (`url`, `rel="noreferrer"`).
- **Quota**: groups 每日 / 每月 / 存储; each row a bar (`<meter>` or `role="meter"` with text) with
  used / limit / percent / projection, 80 % and 95 % marks, `truncated` and "无数据" states, the source
  link, and the account-wide note ("整个 Cloudflare 账户的用量，包括其他 Worker、数据库和存储桶").
- **Canary**: today's run with a stage timeline (创建 → 已排队 → 已投递 → Todofy 完成 → 结束), outcome and
  code, next scheduled time; table of the last 14 runs.
- **Digest**: current items, last sent time and receipt, error.
- **Actions** with confirmation text that states exactly what happens:
  - 立即运行金丝雀: "调用 Mail Hero 创建一封固定内容的合成测试邮件，经正常投递链路发给 Todofy；Todofy
    只调用一次 Gemini 并校验结果，不创建 Todoist 任务、不进入列表或提醒。今天还可手动运行 N 次。"
  - 强制降载: "立即让 Mail Hero 和 Todofy 在 24 小时内推迟可推迟的清理和安全网任务（各任务仍有自身上限）；
    收件、解析、投递、重试和真实邮件处理不受影响。可随时解除。"
  - 解除降载: "立即结束两个应用的降载，并在本 UTC 日剩余时间内暂停自动降载；次日 00:00 UTC 起恢复自动判断。"
  - 刷新: no dialog; disabled until `refresh.next_refresh_at`.
- Data: `@tanstack/react-query`; overview refetched every 5 min while the page is visible; the client
  uses `credentials: 'same-origin'`, `redirect: 'error'` (an expired Access session shows
  "登录已过期，请刷新页面"), fetches `/api/v1/csrf` once, sends `X-CSRF-Token`, and drops the token and
  retries once on 403 `csrf_failed`.
- Labels live in `src/lib/labels.ts` (signals, counters, modes, quota ids, canary codes, guard reasons,
  API errors).

## 9. Tests

Unit (`worker`, vitest in Node, `cloudflare:workers` aliased to `test/cloudflare-workers.ts`):

- `usage`: the query constant equals §7.2; mapping of a synthetic GraphQL response (units, sums, max,
  empty `doSto` → null, truncation, R2 classes and unclassified, breakdown top 5); every failure code;
  projections at period edges; the token only ever in the one header of the one URL (fetch spy).
- `guard`: decision table (enter at 80, hold ≥ 70 same day, clear < 70, new day, R2 monthly renewal,
  stale usage keeps then lapses, overrides and their expiry, until ≤ 36 h); apply rules (no call when
  unchanged, re-apply when the app lost it, capability gate).
- `canary`: every transition of §5.4 including all deadlines, idempotent start, limits of manual runs,
  run-ID format against `RunId`.
- `digest`: item table, ordering, 20 items, 8192 bytes, `since`, change key, 6 h and 23:30 rules, empty
  report; every report validated with `validate.mjs` as `OpsReport`.
- `ops-client`: **only declared methods** (a recording proxy env; the called names ⊆ the method names
  parsed from `ops-v1.ts` interfaces `MailHeroOps`/`TodofyOps`) and **every `OPS_ERROR_CODES` value**
  plus timeout, foreign rejection and invalid output, for every method.
- `http`: Access via edge-auth with a test JWKS (Web Crypto RSA keys, stubbed `fetch`), alias and case
  fold, missing/invalid token, CSRF (Origin, header/cookie, signature, key missing), private headers,
  error envelopes, 404/405, `/health` without auth, API shapes against `api-types.ts`.

Runtime (`npm run test:runtime`, Miniflare; `test/runtime/harness.ts`): the bundled Worker with the
real SQLite `HomeState`; stub `mail-hero` and `todofy` Workers exporting `Ops` with only their declared
methods, defaulting to `contracts/ops-v1` fixtures and scripted per test (`/__scenario`, `/__calls`);
an outbound handler playing GraphQL and the Access certs endpoint. Every value a stub returns is a
fixture or validated with `validate.mjs`. Flows, driven by `scheduled()` with chosen times:

- guard: 81 % → shed on both apps with the expected input; same state → no call; renew on a new day
  (R2); < 70 % → normal; the app reporting normal after losing state → re-apply; owner force/clear with
  CSRF and their expiry;
- canary: start → pending → delivered → ok (timeline stored); failed delivery; consumer failed;
  timeout at 2 h; paused/unavailable start → skipped; missing capability → skipped without a
  `startCanary` call; manual run limits and `canary_active`;
- digest: first report; unchanged items → no call; change → call; 6 h refresh; 23:30 rule; Todofy
  without `ops_digest` → no call; `reportOps` failing → retried next tick;
- an unreachable app (stub throws/unknown method) → `app_unreachable` after 2 ticks, other app still
  handled; GraphQL 401/500/errors → `usage_unavailable`, guard unchanged;
- auth end to end (JWT from the test JWKS through the outbound handler), overview shape, refresh rate
  limit, 60-day canary retention, DO rows bounded.

Web (vitest + testing-library + jsdom): rendering from a synthetic `OverviewResponse` fixture (all
sections, unknown codes, null usage, dark/light independent), times in a fixed test time zone,
confirmation dialogs and the exact requests they send (CSRF header, retry on 403), disabled refresh,
keyboard flow; `npm run build`; the built files contain no `http(s)://` origin other than inert XML
namespaces.

## 10. Deployment and CI

`deploy/generate-ci-config.mjs` (Mail Hero's style; messages name variables, never print values;
writes with `wx` and mode 0600; `node --test deploy/test/*.test.mjs`):

| Input | Rule | Output |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` (var) | `^[a-f0-9]{32}$`i | `account_id`, var `ACCOUNT_ID` |
| `DASHBOARD_PUBLIC_HOST` (var) | domain regex | route `{pattern, custom_domain: true}`, var `PUBLIC_HOST` |
| `DASHBOARD_ACCESS_ISSUER` (var) | `^https://[a-z0-9-]+\.cloudflareaccess\.com$` | var |
| `DASHBOARD_ACCESS_AUDIENCE` (var) | `^[a-f0-9]{64}$`i | var |
| `MAIL_HERO_PUBLIC_HOST`, `TODOFY_PUBLIC_HOST` (existing vars) | domain regex | vars `MAIL_HERO_URL`, `TODOFY_URL` = `https://<host>/` |
| `DASHBOARD_CANARY_UTC_HOUR` (optional var) | integer 0–23, default 16 | var `CANARY_UTC_HOUR` |
| `GITHUB_SHA` | 40 hex | var `BUILD_SHA` |
| `DASHBOARD_ACCESS_OWNER` (secret) | printable-ASCII email | secrets file `ACCESS_OWNER` |
| `DASHBOARD_ACCESS_OWNER_ALIASES` (secret) | ≤ 8, ≤ 2048 chars, unique, each printable-ASCII email | `ACCESS_OWNER_ALIASES` (`" "` when empty) |
| `DASHBOARD_CSRF_SIGNING_KEY` (secret) | `^[0-9a-fA-F]{64}$` | `CSRF_SIGNING_KEY` |
| `DASHBOARD_CF_ANALYTICS_TOKEN` (secret) | `^[A-Za-z0-9_-]{20,200}$` | `CF_ANALYTICS_TOKEN` |

It copies the shape keys of `worker/wrangler.toml` (`name, main, compatibility_date, assets,
durable_objects, migrations, services, triggers`; a test fails on an unknown key), read with the pinned
wrangler's own `experimental_readRawConfig` from `worker/node_modules` (so `npm ci` in `worker/` comes
first; Node has no TOML parser and the Python generators' `tomllib` needs Python ≥ 3.11). It refuses a
`DASHBOARD_PUBLIC_HOST` equal to either app's host, sets `workers_dev:
false`, `preview_urls: false`, `observability: {enabled: true}`, and writes
`worker/wrangler.production.ci.json` and `worker/wrangler.production.secrets.json` (both gitignored).

CI (`.github/workflows/ci.yml`, pinned action SHAs as today):

- `ci_changes.py`: keys `dashboard_check`, `dashboard_deploy`; `dashboard/` checks and deploys the
  dashboard; `PACKAGE_USERS["edge-auth"]` gains `dashboard` (the `file:` consistency test also scans
  `dashboard/`), an unmapped package counts as used by all three apps; `BUNDLED_BY_BOTH` becomes a map
  `BUNDLED_BY = {"contracts/ops-v1/ops-v1.ts": ("todofy", "mail-hero", "dashboard")}` (its test also
  scans `dashboard/worker/src` and `dashboard/web/src`); `contracts/` and `.github/` re-check the
  dashboard; dispatch input gains `dashboard` and `all` (`both` keeps meaning Todofy + Mail Hero).
- **Dashboard checks** (`needs: changes`, `if: dashboard_check`, working directory `dashboard`): `npm ci`
  in `worker` and `web`; `node --test deploy/test/*.test.mjs`; worker `lint`, `typecheck`, `test`,
  `test:runtime`; web `lint`, `typecheck`, `test`, `build`; a guard that no file under `worker/src` or
  `web/src` imports from `mail-hero/` or `todofy/`; generate a placeholder production config and
  `wrangler deploy --dry-run --config wrangler.production.ci.json --secrets-file
  wrangler.production.secrets.json --outdir "$RUNNER_TEMP/home-bundle"`; remove it (`if: always()`).
  `CI gate` needs and checks it.
- **Dashboard deploy**: `needs: [changes, dashboard-checks, gate, todofy-deploy, mail-hero-deploy]`;
  `if: !cancelled() && changes, dashboard-checks, gate == 'success' && todofy-deploy and mail-hero-deploy
  ∈ {success, skipped} && main && (push || dispatch) && dashboard_deploy` (the service bindings need
  both `Ops` entrypoints live; `test_ci_changes.py`'s shape test learns the success-or-skipped form for
  these two); `environment: production`, `concurrency: dashboard-production`; build, generate, dry-run,
  `wrangler deploy` with `CLOUDFLARE_API_TOKEN: secrets.CF_API_TOKEN`; no D1. Probe: an unauthenticated
  `GET https://<host>/` (and `/api/v1/overview`) must be a 302 whose `Location` starts with
  `ACCESS_ISSUER + '/'`; retry 10 × 15 s only while the answer is 5xx or no connection (certificate/DNS);
  any 2xx/4xx means the app answered without Access and fails the job at once.

## 11. Open items

- Production checks (verification.md): real Access login and alias; GraphQL with the replacement
  "Account Analytics: Read" token; the first real canary; whether `Ops` calls count in the apps'
  Worker request totals; the deploy probe.
- `packages/edge-auth/SPEC.md` condensation and the root README/AGENTS updates (integration step).
