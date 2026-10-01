# Home dashboard: design

The Worker `home` on `home.ziyixi.science` is the owner's single ops view for Mail Hero and Todofy,
and it runs three jobs: a daily delivery-and-processing canary (scope in §5.4) with a unified ops
digest, quota guardrails, and the
cross-app contract tests of `contracts/ops-v1`. It talks to the apps only through their `Ops`
entrypoints (service bindings) and never imports `mail-hero/` or `todofy/` code. Mail Hero's
`AGENTS.md` rules apply here too: Workers Free, bounded reads and calls, no mail content anywhere,
synthetic test data only, no secrets in logs.

Status: the Worker, the UI, their tests, the committed production config and the CI jobs (§10) are implemented
and pass locally with synthetic data. Nothing is deployed; [`verification.md`](verification.md) records
what was checked and what is still open in production. Setup: [`setup.md`](setup.md); limits with
sources: [`limits.md`](limits.md).

**Superseded parts (v2):** the one-page UI, `GET /api/v1/overview` and the other `/api/v1/*` routes
below were replaced by the four v2 views and `/api/v2/*` ([`design-v2.md`](design-v2.md) §5); the v1
paths now answer 404. The guard, canary and digest logic, the owner checks, CSRF and the limits in
this document are unchanged and still apply to the v2 routes (`POST /api/v2/guard`, `POST
/api/v2/canary {canary_id}`, `GET /api/v2/csrf`).

## 1. Layout and ownership

| Path | Owner (build step) | Contents |
| --- | --- | --- |
| `worker/` | worker | TypeScript Worker + SQLite Durable Object; `package.json`/lockfile, `tsconfig.json` (Todofy gateway flags + `erasableSyntaxOnly`), `eslint.config.js` (strictTypeChecked), `vitest.config.ts` (Node unit tests), `vitest.runtime.config.ts` (workerd suite) |
| `worker/src/api-types.ts` | worker (shared) | Owner API types and constants; the UI imports it by relative path. Change it only together with the UI |
| `worker/test/runtime/` | worker | Miniflare harness (`harness.ts`, own `tsconfig.json` with Node types), stub apps from `test/stubs/ops-stub.js` |
| `wrangler.toml` | worker | the production config (top level = production; run wrangler from `worker/` with `--config ../wrangler.toml`) |
| `deploy/` | worker | `deploy-vars.mjs` (what the deploy adds) and `test/*.test.mjs` (`node --test`) |
| `web/` | web | React 19 + Vite 7 + TypeScript UI (Chinese), vitest + testing-library, builds `web/dist` (served by `ASSETS`) |
| `docs/` | docs | `design.md` (this), `setup.md`, `limits.md` (allowances with sources, kept equal to `limits.ts` by `test/limits.test.ts`), `verification.md` |
| `.github/`, root docs, `packages/edge-auth/SPEC.md` | integration | CI jobs (§10), root README/AGENTS, the SPEC condensation |

Toolchain versions are Todofy's: Node 26, TypeScript 5.9.3, vitest 4.1.11, eslint 10.11.0,
typescript-eslint 8.71.0, `@cloudflare/workers-types` 5.20260929.1, wrangler 4.142.0 (its own
miniflare 5.20260926.0-alpha and esbuild 0.28.1 are pinned as direct dev dependencies for the harness),
React 19.3.0, Vite 7.3.6, `@tanstack/react-query` 5.104.0, `lucide-react` 1.48.0. `@ziyixi/edge-auth`
is `file:../../packages/edge-auth`, `@ziyixi/proto` is `file:../../proto/ts` (ops-v1's generated messages,
services and wire types, and the wire JSON codec; since 2026-10-01). `contracts/ops-v1/ops-v1.ts` (`OPS_LIMITS`)
is imported by relative path (`../../../contracts/ops-v1/ops-v1.ts` from `worker/src`).

Worker modules (the worker builder may merge or split, keeping pure logic separate from I/O):

| File | Responsibility |
| --- | --- |
| `src/index.ts` | `export default { fetch, scheduled }`, `export { HomeState }`. No business logic |
| `src/env.ts` | `Env` (§2) |
| `src/http.ts` | routing, edge-auth adapter (Access, CSRF, private headers), error envelopes, request IDs |
| `src/state.ts` | `HomeState` (RPC methods §4), SQL schema (§3), the mutex, persistence |
| `src/ops-client.ts` | one wrapper per `Ops` method: timeout, error-code mapping, contract-schema validation (§5.1) |
| `src/usage.ts` | the GraphQL query (verbatim §7.2), fetch, parse, `QuotaRow` building, projection |
| `src/limits.ts` | Free allowances with doc URLs (§7.1, `limits.md`) |
| `src/guard.ts`, `src/canary.ts`, `src/digest.ts` | pure decision functions taking `now` and prior state |
| `src/time.ts` | UTC day/month helpers, next midnight |

## 2. Configuration

Bindings: `MAIL_HERO` = service `mail-hero`, entrypoint `Ops`; `TODOFY` = service `todofy`, entrypoint
`Ops`; `HOME` = Durable Object class `HomeState` (migration `v1`, `new_sqlite_classes`); `ASSETS`
(`../web/dist`, `run_worker_first = true`, SPA fallback; every asset request therefore invokes the Worker
and counts as a Worker request, `limits.md` §2). `workers_dev = false`, `preview_urls = false`,
route `home.ziyixi.science` with `custom_domain = true`. One cron
`*/30 * * * *` (the account uses 1 of its 5 Free cron triggers today).

| Name | Kind | Value / rule |
| --- | --- | --- |
| `PUBLIC_HOST` | var | the dashboard host; CSRF origin `https://<host>` and the digest's `dashboard_url` |
| `ACCESS_ISSUER`, `ACCESS_AUDIENCE` | var | the Access app "Home" (issuer `https://<team>.cloudflareaccess.com`, AUD 64 hex) |
| `ACCOUNT_ID` | var | 32 hex, the GraphQL `accountTag` |
| `CANARY_UTC_HOUR` | var | integer 0–23, default 16; invalid → 16 |
| `CANARY_ENABLED` | var | `true` or `false` (§5.4 "Switch"); unset or empty → `true`; any other value → `false` (the switch exists to stop canaries, so an unreadable value never starts one; `deploy-vars.mjs` sends only `true`/`false`) |
| `BUILD_SHA` | var | the deployed commit (`dev` locally) |
| `ACCESS_OWNER`, `ACCESS_OWNER_ALIASES` | secret | printable-ASCII emails, ≤ 8 aliases, ≤ 2048 chars; empty aliases uploaded as `" "` |
| `CSRF_SIGNING_KEY` | secret | `^[0-9a-fA-F]{64}$` |
| `CF_ANALYTICS_TOKEN` | secret | API token used **only** as `Authorization: Bearer` on `POST https://api.cloudflare.com/client/v4/graphql` and on the drift check's read-only `GET`s under `https://api.cloudflare.com/client/v4` (design-v2.md §10; URLs are constants, not config). Never logged, stored, echoed or sent elsewhere. Today a broader token is reused; replace it with an "Account Analytics: Read" token (setup.md) |
| `DEV_AUTH_BYPASS` | local only | `true` enables the loopback bypass; never in the production config (tests check it) |

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
  v2View(view: V2View, refresh: boolean, ifNoneMatch: string | null): Promise<V2Body>; // GET /api/v2/<view> (design-v2.md §5)
  startCanary(): Promise<{ ok: true; run: CanaryRun } | { ok: false; code: 'canary_disabled' | 'canary_active' | 'canary_limit' }>;
  setGuardOverride(level: GuardLevel): Promise<{ guard: GuardView }>;
}
```

A failure of the object itself (reset, storage error) is an exception, which the Worker maps to 503
`unavailable`; per-app `setGuard` failures are inside `guard.apps`.

- `scheduled` **awaits** `tick(controller.scheduledTime)` (not `waitUntil`, whose 30 s tail could cut a
  slow tick; a cron invocation may run 15 min wall time). A tick whose `scheduledTime` is within 10 min
  of the last completed tick is skipped (`ran: false`), so a retried cron event is harmless.
- `tick`, a refreshing `v2View`, `startCanary` and `setGuardOverride` run one at a time through an
  in-memory promise chain (service calls await, so input gates alone would interleave them). A view
  without refresh is built from the tables in the same chain.
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

- Only the methods of each app's generated ops-v1 services (`proto/ops/v1/ops.proto`: `OpsService`,
  `CanaryProducerService`, `CanaryConsumerService`, `OpsDigestService`) are called (tested, §9).
- Result: `{ok: true, value}` or `{ok: false, code}`. A rejection whose `Error.message` is an
  `ErrorCode` (`invalid_input`, `busy`, `unavailable`) keeps that code; the timeout gives `timeout`;
  any other rejection (binding error, deploy in progress, unknown method) gives `unavailable`; a value
  over 32 KiB of JSON or one the contract's rules refuse gives `invalid_output`. Every answer is read
  with the wire codec (a lenient read: the contract's rules, with its consumer allowances) and kept as
  the codec writes it back, because an app can ship an additive change before this Worker is
  redeployed: fields the IDL does not declare are dropped (never stored or shown), and new codes of the
  open lists `reason` and `waiting_code` (and any `error_code` code) are kept; a new value of a closed
  enum (a state, a severity, a level) is refused. Anything else outside the closed contract (an address
  as a counter name, free text in a code, an http URL, an offset timestamp) is refused, so it never
  reaches DO storage or the page. Every input the dashboard sends goes through a strict read with the
  same rules first; one they refuse is not sent (`invalid_input`). All of these are
  "unavailable" for decisions; `invalid_input` is logged as a dashboard bug and never retried in a
  tight loop (at most once per tick).
- `status()` of each app at most every 10 min (`OPS_LIMITS.statusMinIntervalSeconds`), counting every
  path: a tick, an owner refresh and a manual canary start each poll an app only when its last attempt
  is ≥ 10 min old (or carries a later clock). A tick that skips the poll uses the stored status (if
  that attempt succeeded) as this tick's observation for the guard. Both apps in parallel.
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

Projection (a straight-line estimate, labelled "按当前速度线性估算" on the page, not a forecast): daily
`used × 86400 / elapsed_seconds` of the UTC day (null while elapsed < 3 h, so one job just after
midnight does not read as twenty times the day); monthly `used × days_in_month / elapsed_days`
(elapsed in fractional days since 00:00 UTC on the 1st, null while < 1 day); storage none. Percent
values keep one decimal.

### 5.3 Guard (`guard.ts`)

Trigger resources (`guard_trigger: true`): the seven daily Workers/D1/DO ones and `r2_class_a`,
`r2_class_b`. Storage never triggers (shed defers cleanup, which would make storage worse). Workers AI
neurons (`ai_neurons`, daily) never trigger either: shed only defers the apps' cleanup and safety nets,
none of which calls Workers AI, so it could not lower neuron use, and above the Free allocation only
AI calls fail (no bill, nothing else stops). The row is shown and reported (`ai_neurons_high`) but
does not shed ([`limits.md`](limits.md) §1).

Desired state, evaluated each tick in this order:

1. **Owner override** (§6 `POST /api/v1/guard`) while `now < override.until`:
   `shed` → `{level: 'shed', reason: 'owner_shed', until: override.until}` (until = set time + 24 h);
   `normal` → `{level: 'normal', reason: 'owner_clear'}`, which suppresses the automatic shed until the
   next UTC midnight (the override's `until`). While a `normal` override is in force the automatic
   decision is held at normal (setting it also resets an automatic shed), so a cleared episode cannot
   come back through the old shed's own `until` when the override ends. An expired override is deleted.
2. **Usable usage**: fresh usage (fetched for the tick's UTC day, ≤ 90 min old) with all trigger
   rows; or, right after midnight, a snapshot from the previous UTC day of the same month that is
   still ≤ 90 min old, with only its **monthly** rows (R2 operations do not reset at midnight, so a
   GraphQL outage at the day change must not lift a monthly shed and then shed again; daily rows never
   carry over):
   - enter shed when any trigger resource uses ≥ 80 % of its allowance, compared on the measured value
     (`used × 100 ≥ limit × 80`), never on the displayed `percent` (rounded to 0.1, so 79.95 % shows as
     80.0 and does not shed; the same holds for 70 % and the 95 % critical item). `reason` =
     `quota_<resource id>` of the highest share (e.g. `quota_d1_rows_read`), `until` = next UTC
     midnight + 60 min (always ≤ 25 h ahead, inside the contract's 36 h; the hour lets a continuing
     shed renewed at the 00:00 tick survive one failed or late `setGuard` there, retried at 00:30).
     `entered_day` = today;
   - stay shed while the auto guard's `entered_day` is today and the highest trigger percent is ≥ 70
     (hysteresis); reason and `entered_day` stay, `until` is recomputed (same value within a day);
   - otherwise normal (`reason: 'quota_normal'`). A new UTC day therefore starts normal and re-enters
     shed only at ≥ 80 % of that day's usage (monthly R2 operations can re-enter at the first tick of a
     new day; that renewal is the new day's `until`).
3. **No usable usage**: keep an auto shed until its `until` without renewing it (it then lapses to
   normal, the safe default); never enter shed without data. The normal state then carries
   `reason: 'usage_unknown'` (the page says "无最新用量，不会自动降载", not "配额正常").

Applying (per app, only if its last status lists `guard`):

- Input: shed → `{level: 'shed', reason, until}`; normal → `{level: 'normal', reason, until: null}`.
- Call `setGuard` only when the input differs from `guard_applied.input` of the last success, or the
  app's status of this tick shows a different effective guard (its state was lost, or it expired),
  or the last attempt failed. Normal is sent only if the app is (or was last left) shed. So a steady
  state makes no calls; a day with an 80 % breach makes at most one shed call and one clear call per
  app plus retries. An `invalid_input` answer (e.g. clock skew beyond 36 h) is recorded and retried at
  most once per tick.
- Both apps are called in parallel; each result updates `guard_applied`. A failure counts only while
  its call is still pending: an app that needs no call this tick (the level that failed is no longer
  wanted, or is in place) has its failure count and last error cleared, so `guard_apply_failed`
  disappears when, say, a shed that never reached Mail Hero is no longer wanted.

### 5.4 Canary (`canary.ts`)

Scope: Mail Hero's `startCanary` creates the synthetic message directly (pre-parsed, in D1 and R2
`parsed/`) and delivers it through its normal webhook path. A green run therefore covers Mail Hero
delivery → Todofy intake, Gemini summary and verification; it does **not** cover source forwarding,
Email Routing, the ingest quota, raw storage or MIME parsing. The page names the section
"投递与处理金丝雀" and states this scope.

At most one active run (phase ≠ `done`) at a time.

- **Switch** (`CANARY_ENABLED`, from the GitHub variable `DASHBOARD_CANARY_ENABLED`, required at deploy):
  with `false` no run starts. The tick still advances a queued run (`delivering`, `consuming`) to its
  verdict (so a Todofy rollback can wait for it, setup.md §7) but creates no scheduled run; a run still
  `starting` gets no further `startCanary` call and ends as `skipped/start/canary_disabled` (no event is
  created after the switch; the digest reports no item for this code); `startCanary` answers
  `canary_disabled` before any other check, reading and calling nothing. The overview reports `canary.enabled` and
  `next_scheduled_at: null`. A day without a run raises no digest item (there is no "not run today"
  item at all); the latest finished run's item (§5.5) stays as it was. Switching back on starts the
  day's scheduled run at the next tick if the hour has passed and no scheduled run exists that UTC day.
  A config change takes effect with the deploy that carries it.

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
  `waiting_code`. The API shows a waiting start's reason (`start_code`: the paused/unavailable reason,
  the call error or `status_unavailable`) and the last failed poll (`last_call_error`), so a run held
  in `starting` says why. The UI timeline uses `created_at`, `queued_at`, `delivered_at` (Mail Hero's value),
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
| `dashboard` | `config_drift` | warning | the last completed configuration drift check found differences ([`design-v2.md`](design-v2.md) §10; names stay on the Cloudflare view) | `total` and each non-zero category count (`scripts`, `custom_domains`, `routes`, `crons`, `bindings`, `workers_dev`, `personal`) |
| `dashboard` | `drift_unavailable` | warning | token set and the drift check failed on 2 UTC days in a row | `consecutive_failed_days` |
| `dashboard` | `guard_shed` | warning | desired guard is shed | `hours_left`, `manual` (0/1) |
| `mail-hero` / `todofy` | `guard_apply_failed` | warning | ≥ 2 consecutive `setGuard` failures | `consecutive_failures` |
| `dashboard` | `canary_start_failed` / `canary_not_delivered` / `canary_consumer_failed` | critical | the latest finished run failed at stage start / delivery / consumer | `attempts`, `last_http_status` (if any), `timed_out` (0/1) |
| `dashboard` | `canary_skipped` | warning | the latest finished run was skipped (paused, unavailable, a missing capability, no status, a held consumer), as contracts/ops-v1 "Daily canary" asks: reported with its reason, never as a failure | the skip code as a key with value 1, e.g. `{"no_endpoint": 1}` |
| `dashboard` | `tick_stale` | warning | no cron tick completed for 75 min, or none ever (only on refresh-built items; the overview also adds it at read time) | `minutes_since` |
| `mail-hero` / `todofy` | `app_unreachable` | critical | ≥ 2 consecutive failed `status()` calls | `consecutive_failures` |
| `mail-hero` / `todofy` | `app_down` | critical | last status `health: down` | – |
| `mail-hero` / `todofy` | each active signal's `code` | its severity | warning/critical signals of the last status (≤ 60 min old) | the signal's metrics |

Sending (`TODOFY.reportOps`, only while Todofy's last status lists `ops_digest`): the key is the sorted
list of `source:code:severity`. Send when the key differs from the last **successfully** sent key, or
the last success is ≥ 6 h old, or at the 23:30 UTC tick when the last success is ≥ 60 min old (so the
next day's reminder carries fresh metrics). Nothing is sent during the first 20 min of a UTC day while
the last success is from an earlier day (the 00:00 tick waits for 00:30): Todofy keeps only the latest
report and lists it in a day's reminder only if it was generated before that day, and its reminder
check runs every 10 min, so an 00:00 report (for example an empty one because the daily quotas reset)
would replace the 23:30 report before that day's reminder claimed it, and the breach would never be
reported. Report: `{generated_at: tick time, items,
dashboard_url: 'https://<PUBLIC_HOST>/'}`; an empty `items` list is sent when the set becomes empty (it
clears Todofy's ops section). A receipt with `stored: false` counts as sent. Failures keep the old key,
so the next tick retries. This is the only way the dashboard creates Todoist tasks (through Todofy's
one-per-day reminder); Mail Hero's `ALERT_WEBHOOK_URL` stays unconfigured.

The overview banner (`overall`) is `critical` if any item is critical, else `warning` if any is
warning, else `ok`; `unknown` before anything ran. While `CANARY_ENABLED` is `false` the banner's items
end with the info item `{source: 'dashboard', code: 'canary_disabled', severity: 'info'}` (taking the
last of the 20 places): it never changes the level and is not a digest item, so it is never sent to
Todofy (ops-v1 reports carry warning and critical items only). The stored items are as old as the last tick or
refresh, so the overview judges the ticks at read time: `tick_stale` is added when no tick completed
for 75 min (cron removed, or every tick failing), which turns a clean banner into a warning. `items`
lists `{source, code, severity}` (≤ 20), so the same code from both apps stays two entries; the UI
labels each as "<app>：<label>" and links it to the card that explains it.

## 6. Owner API

All paths except `/health` go through Access (edge-auth) first; then `/api/v2/*` or assets. The v1
routes of this table are retired (404); their v2 successors and the view endpoints are in
[`design-v2.md`](design-v2.md) §5, with the same auth, CSRF and body rules.

| Route | Auth | Result |
| --- | --- | --- |
| `GET /health` | none (Access still fronts the host) | `HealthResponse` `{service: 'home', status: 'ok', build}`; no DO call |
| `GET /api/v1/csrf` | Access | `CsrfResponse` + `Set-Cookie: home_csrf=...` |
| `GET /api/v1/overview[?refresh=1]` | Access | `OverviewResponse` from the cached snapshot; `refresh=1` fetches usage (≥ 60 s since the last fetch attempt) and status (per app ≥ 10 min) first, else returns the cache with `refreshed: false` |
| `POST /api/v1/canary` | Access + Origin + CSRF | 202 `CanaryStartResponse`; 409 `canary_disabled` ("金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）", checked first); 409 `canary_active`; 429 `canary_limit` |
| `POST /api/v1/guard` | Access + Origin + CSRF | 200 `GuardResponse`, body `GuardRequest` `{level: 'shed' \| 'normal'}` (≤ 1 KiB JSON, else 400; a body without Content-Length is read only up to 1 KiB) |
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

### 7.1 Workers Free allowances used

The allowances (resource ids, periods, values, guard triggers) and the platform limits this design
relies on, each with its Cloudflare source, are in [`limits.md`](limits.md) (checked 2026-09-29);
`src/limits.ts` holds the same values and `test/limits.test.ts` keeps the two equal. They are
account-wide. Free daily limits reset at 00:00 UTC; R2's free tier is monthly (the dashboard uses the
UTC calendar month to date). What is still unverified in production is listed in `limits.md` §4.

### 7.2 The query (verbatim; verified 2026-09-29 against the live account)

```graphql
query($a: string!, $day: Date!, $start: Time!, $end: Time!, $month: Date!) { viewer { accounts(filter: {accountTag: $a}) {
  workers: workersInvocationsAdaptive(limit: 50, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests errors subrequests } dimensions { scriptName } quantiles { cpuTimeP50 cpuTimeP99 } }
  d1: d1AnalyticsAdaptiveGroups(limit: 10, filter: {date: $day}) { sum { rowsRead rowsWritten readQueries writeQueries } dimensions { databaseId } }
  d1s: d1StorageAdaptiveGroups(limit: 10, filter: {date: $day}) { max { databaseSizeBytes } dimensions { databaseId } }
  doInv: durableObjectsInvocationsAdaptiveGroups(limit: 10, filter: {date: $day}) { sum { requests errors } dimensions { scriptName } }
  doPer: durableObjectsPeriodicGroups(limit: 10, filter: {date: $day}) { sum { activeTime rowsRead rowsWritten cpuTime storageDeletes storageReadUnits storageWriteUnits } dimensions { namespaceId } }
  doSto: durableObjectsStorageGroups(limit: 5, filter: {date: $day}) { max { storedBytes } }
  r2ops: r2OperationsAdaptiveGroups(limit: 50, filter: {date_geq: $month, date_leq: $day}) { sum { requests } dimensions { actionType bucketName } }
  r2sto: r2StorageAdaptiveGroups(limit: 10, filter: {date: $day}) { max { payloadSize metadataSize objectCount } dimensions { bucketName } }
  ai: aiInferenceAdaptiveGroups(limit: 20, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { totalNeurons } dimensions { modelId } }
} } }
```

`usage.ts` holds this text as a constant; a unit test compares it (whitespace-normalised) with the
copy above. v2 raised the `workers` row limit from the verified 20 to 50 (a row cap only; the fields
are the verified ones) and parses its per-script fields and the per-resource rows for the Worker and
resource tables ([`design-v2.md`](design-v2.md) §4). `durableObjectsStorageGroups` returned `[]` on
this account: `do_storage.used` is then null ("无数据"), never 0. The `ai` dataset (Workers AI) was
added on 2026-09-30 after the owner checked `aiInferenceAdaptiveGroups` with this filter and these
fields on the live account (it answered `[]`: no AI calls yet); it rides in the same request, so a tick
still makes one GraphQL call. Unlike storage, an answered `[]` there is a day without AI calls:
`ai_neurons.used` is 0. An answer without the `ai` field, or one whose `errors` all have a `path`
into it (`viewer.accounts.0.ai…`, what GraphQL sends when only that dataset fails: token scope,
entitlement, a per-dataset outage), leaves that one row at null ("无数据"); the other rows still parse
and the guard still sees them. Any other error (no path, another dataset, the whole account) keeps the
answer `graphql_error`, and every other dataset missing refuses it, as before.

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
| `ai_neurons` | Σ `ai[].sum.totalNeurons` (0 if `[]`) | neurons (fractional, one decimal) | `modelId` |
| `do_storage` | max `doSto[].max.storedBytes` (null if `[]`) | bytes | – |
| `r2_class_a` | Σ `r2ops[].sum.requests` where `actionType` ∈ A or `DeleteObjects`, plus unclassified | – | `bucketName` |
| `r2_class_b` | Σ `r2ops[].sum.requests` where `actionType` ∈ B | – | `bucketName` |
| `r2_storage` | Σ `r2sto[].max.payloadSize + metadataSize` | bytes | `bucketName` |

Class A: `ListBuckets, PutBucket, ListObjects, PutObject, CopyObject, CompleteMultipartUpload,
CreateMultipartUpload, LifecycleStorageTierTransition, ListMultipartUploads, UploadPart, UploadPartCopy,
ListParts, PutBucketEncryption, PutBucketCors, PutBucketLifecycleConfiguration`. Class B: `HeadBucket,
HeadObject, GetObject, UsageSummary, GetBucketEncryption, GetBucketLocation, GetBucketCors,
GetBucketLifecycleConfiguration`. Free: `DeleteObject, DeleteBucket, AbortMultipartUpload`.
`DeleteObjects` (bulk delete; returned by the live account, on neither class list of the pricing page)
counts as Class A on purpose and is not unclassified (`limits.md` §1). Any other `actionType` counts as
Class A (cautious) and adds to `unclassified_r2_operations`. A dataset that
returns exactly its `limit` rows sets `truncated` on its rows (the sum is a lower bound). Worker CPU
quantiles (µs) and error counts are not quota rows; the UI may show them per script.

### 7.4 What the dashboard itself costs per day

48 cron ticks → 48 Worker requests + 48 DO requests; ≤ 96 `status()` calls (Mail Hero ≤ 6 and Todofy
≤ 5 D1 statements each); ≤ 48 GraphQL queries; a few `setGuard`/canary/`reportOps` calls; one canary a
day (one synthetic message; normally one Gemini call in Todofy, up to 3 when a transient failure is
retried). Owner page loads add a few Worker and DO
requests each. All far below every row above.

## 8. UI (`web/`)

One page, Chinese, mobile-first (single column < 720 px, two columns above), keyboard accessible
(native buttons, confirmation modals built as a `div` with `role="dialog"`, `aria-modal`, a focus
trap and focus return, visible focus), light/dark through
`prefers-color-scheme` CSS tokens, system font stack, no remote fonts, images or requests other than
same-origin `/api/v1/*`. Times with `Intl.DateTimeFormat('zh-CN', …)` in the browser's time zone,
durations in words.

- **Banner**: `overall.level` with text (正常 / 需要关注 / 严重 / 暂无数据), a sentence when the ticks
  stopped, and each item as "<app>：<label>" linking to its section.
- **App cards** (Mail Hero, Todofy): health, reachability and last check, modes, guard (level, reason,
  until, deferred jobs), active signals with plain-text labels (unknown codes shown raw), key counters,
  last backup, link to the app UI (`url`, `rel="noreferrer"`).
- **Quota**: groups 每日 / 每月 / 存储; each row a bar (`<meter>` or `role="meter"` with text) with
  used / limit / percent / projection, 80 % and 95 % marks, `truncated` and "无数据" states, the source
  link, and the account-wide note ("整个 Cloudflare 账户的用量，包括其他 Worker、数据库和存储桶").
- **Canary** ("投递与处理金丝雀", with its scope sentence from §5.4): the current UTC day's run (labelled
  "本 UTC 日（YYYY-MM-DD）", since canary days and the manual limit count by UTC while times show in the
  browser's zone) with a stage timeline (创建 → 已排队 → 已投递 → Todofy 完成 → 结束), waiting reasons
  (`start_code`, `waiting_code`, `last_call_error`), outcome and code, the scheduled hour as
  "16:00 UTC（本地 HH:MM）", next scheduled time; table of the last 14 runs. While the switch is off: an
  info note "金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）：不会开始新的定时或手动运行；正在进行的运行仍会
  每 30 分钟检查一次，直到结束。…", "下次定时运行" reads 已关闭, and a run still in progress is shown as
  usual.
- **Digest**: current items, last sent time and receipt, error.
- **Actions** with confirmation text that states exactly what happens:
  - 立即运行金丝雀: "调用 Mail Hero 直接创建一封固定内容的合成测试邮件（不经过来源转发、Email Routing
    收件、原件保存与解析），经正常投递链路发给 Todofy；Todofy 按正常流程调用 Gemini 摘要并校验（暂时性
    失败最多尝试 3 次，计入 Gemini 预算），不创建 Todoist 任务、不进入列表或提醒。本 UTC 日还可手动运行
    N 次。" A start answered paused/unavailable reports "未能立即启动金丝雀 …：<reason>；截止前每 30 分钟
    重试一次。" While the switch is off the button is `disabled` and described by
    "金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false），不能手动运行。"; a 409 `canary_disabled` (switched off
    after the page loaded) is shown as "未能启动金丝雀：金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）…"
  - 强制降载 (the deferred jobs of contracts/ops-v1/IMPLEMENTATION.md §2.5 and §3.7): "立即让两个应用
    降载 24 小时：Mail Hero 推迟原件对账、保留期清理、金丝雀清理和告警历史清理（每项最多推迟 48 小时）；
    Todofy 推迟开始新一轮每周备份（上次完整备份超过 7.5 天仍会执行）、过期数据清理和趋势统计汇总（最多推迟
    72 小时，之后补上）。收件、解析、投递、重试、已在进行的备份和真实邮件处理不受影响。可随时解除。"
  - 解除降载: "立即结束两个应用的降载，并在本 UTC 日剩余时间内暂停自动降载；次日 00:00 UTC（本地 HH:MM）
    起恢复自动判断。"
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
- `guard`: decision table (enter at 80, hold ≥ 70 same day, clear < 70, the 79.95 % and 69.95 % edges,
  new day, R2 monthly renewal surviving a failed 00:00 call,
  stale usage keeps then lapses as `usage_unknown`, a monthly R2 shed carried across midnight when
  GraphQL fails, overrides and their expiry, until ≤ 36 h); apply rules (no call when unchanged,
  re-apply when the app lost it, capability gate, failures cleared once no call is pending).
- `canary`: every transition of §5.4 including all deadlines, idempotent start, limits of manual runs,
  run-ID format against `RunId`.
- `digest`: item table, ordering, 20 items, 8192 bytes, `since`, change key, 6 h and 23:30 rules, the
  hold at the start of a UTC day (23:30 breach, 00:00 cleared: no send until 00:30), empty report; every report passes the contract's rules as `OpsReport`.
- `ops-client`: **only declared methods** (a recording proxy env; the called names equal the methods of
  each app's generated services, `test/contract.ts`, the list the runtime stubs use) and **every
  `ErrorCode` value** plus timeout, foreign
  rejection and invalid output, for every method; every invalid output fixture of
  `contracts/ops-v1/fixtures/invalid/` is refused except the ones the consumer rules tolerate (an
  extra field is dropped, a new additive enum code is read).
- `http`: Access via edge-auth with a test JWKS (Web Crypto RSA keys, stubbed `fetch`), alias and case
  fold, missing/invalid token, CSRF (Origin, header/cookie, signature, key missing), private headers,
  error envelopes, 404/405, `/health` without auth, API shapes against `api-types.ts`, a chunked body
  without Content-Length cut off after 1 KiB.

Runtime (`npm run test:runtime`, Miniflare; `test/runtime/harness.ts`): the bundled Worker with the
real SQLite `HomeState`; stub `mail-hero` and `todofy` Workers exporting `Ops` with only their declared
methods, defaulting to `contracts/ops-v1` fixtures and scripted per test (`/__scenario`, `/__calls`);
an outbound handler playing GraphQL and the Access certs endpoint. Every value a stub returns is a
fixture or passes the contract's rules (`test/contract.ts`). Flows, driven by `scheduled()` with chosen times:

- guard: 81 % → shed on both apps with the expected input; same state → no call; renew on a new day
  (R2), also when GraphQL fails at midnight (no normal in between); < 70 % → normal; the app reporting
  normal after losing state → re-apply; a shed that failed on one app and is no longer wanted clears
  `guard_apply_failed`; owner force/clear with CSRF and their expiry;
- canary: start → pending → delivered → ok (timeline stored); failed delivery; consumer failed;
  timeout at 2 h; paused/unavailable start → skipped with `start_code` shown while waiting and a
  `canary_skipped` item after; missing capability → skipped without a `startCanary` call; manual run
  limits and `canary_active`; the switch: `CANARY_ENABLED=false` starts no scheduled run and answers a
  manual start 409 `canary_disabled` without any app call, shows the info item, and sends reports
  without canary items; a queued run in flight when the Worker is redeployed with `false` (`rebind`,
  same Durable Object storage) is polled to `ok`, a run still `starting` ends as
  `skipped/start/canary_disabled` without another `startCanary` and without a digest item, no run starts
  the next day, and switching back on starts the day's run;
- digest: first report; unchanged items → no call; change → call; 6 h refresh; 23:30 rule; Todofy
  without `ops_digest` → no call; `reportOps` failing → retried next tick;
- an unreachable app (stub throws/unknown method) → `app_unreachable` after 2 ticks, other app still
  handled; GraphQL 401/500/errors → `usage_unavailable`, guard unchanged;
- auth end to end (JWT from the test JWKS through the outbound handler), overview shape, refresh rate
  limit, status() spacing of 10 min across a refresh and the next tick, `tick_stale` when ticks stop,
  banner items that keep their source, 60-day canary retention, DO rows bounded.

Web (vitest + testing-library + jsdom): rendering from a synthetic `OverviewResponse` fixture (all
sections, unknown codes, null usage, dark/light independent), times in a fixed test time zone,
confirmation dialogs and the exact requests they send (CSRF header, retry on 403), disabled refresh,
keyboard flow; `npm run build`; the built files contain no `http(s)://` origin other than inert XML
namespaces.

## 10. Deployment and CI

The production config is the committed `dashboard/wrangler.toml` (top level = production, no `[env.*]`,
no `keep_vars`): account, route and `PUBLIC_HOST`, Access issuer and AUD, `ACCOUNT_ID`, `CANARY_UTC_HOUR`,
entry `worker/src/index.ts`, assets `web/dist`, the Durable Object, its migration, the service bindings and
the cron. `deploy/test/wrangler-config.test.mjs` reads it with the pinned wrangler's own
`experimental_readRawConfig` (from `worker/node_modules`, so `npm ci` in `worker/` comes first) and checks
the known keys, formats and bounds; `.github/scripts/test_wrangler_configs.py` checks that its host differs
from both apps' hosts and that the registry's app links match them. What is never committed is added at
deploy by `deploy/deploy-vars.mjs` (Mail Hero's style; messages name settings, never print values):

| Input | Rule | Output |
| --- | --- | --- |
| `DASHBOARD_CANARY_ENABLED` (var) | exactly `true` or `false`; unset, empty or anything else fails | `--var CANARY_ENABLED` |
| `GITHUB_SHA` | 40 hex | `--var BUILD_SHA` |
| `DASHBOARD_ACCESS_OWNER` (secret) | printable-ASCII email | secrets file `ACCESS_OWNER` |
| `DASHBOARD_ACCESS_OWNER_ALIASES` (secret) | ≤ 8, ≤ 2048 chars, unique, each printable-ASCII email | `ACCESS_OWNER_ALIASES` (`" "` when empty) |
| `DASHBOARD_CSRF_SIGNING_KEY` (secret) | `^[0-9a-fA-F]{64}$` | `CSRF_SIGNING_KEY` |
| `DASHBOARD_CF_ANALYTICS_TOKEN` (secret) | `^[A-Za-z0-9_-]{20,200}$` | `CF_ANALYTICS_TOKEN` |

`secrets <path>` writes the secrets file for `--secrets-file` (mode 0600, never over an existing file,
into `$RUNNER_TEMP`); `exec -- <wrangler deploy …>` validates, then runs the command with the `--var` flags
appended, and refuses `--env`, `--keep-vars`, the caller's own `--var` and any other config. A missing
value fails the deploy, because a deploy without a var deletes it.

CI (`.github/workflows/ci.yml`, pinned action SHAs as today):

- `ci_changes.py`: keys `dashboard_check`, `dashboard_deploy`; `dashboard/` checks and deploys the
  dashboard; `PACKAGE_USERS["edge-auth"]` gains `dashboard` (the `file:` consistency test also scans
  `dashboard/`), an unmapped package counts as used by all three apps; `BUNDLED_BY_BOTH` becomes a map
  `BUNDLED_BY = {"contracts/ops-v1/ops-v1.ts": ("todofy", "mail-hero", "dashboard"),
  "contracts/ops-v1/ops-v1.schema.json": ("dashboard",), "contracts/ops-v1/validate.mjs": ("dashboard",)}`
  (the dashboard validates every `Ops` answer with them; its test also scans `dashboard/worker/src`
  and `dashboard/web/src`; since 2026-10-01 the dashboard reads them with the generated code instead,
  `proto/ops/` in `PROTO_PACKAGES`, and bundles only `ops-v1.ts`); `contracts/` and `.github/` re-check the
  dashboard; dispatch input gains `dashboard` and `all` (`both` keeps meaning Todofy + Mail Hero,
  and stays the default). A dashboard change also runs `Contracts`, which gained a host-only step in
  `dashboard/worker` (`test/ops-client.test.ts`, `guard`, `canary`, `digest`): the caller side of ops-v1
  next to both apps' sides.
- **Dashboard checks** (`needs: changes`, `if: dashboard_check`, working directory `dashboard`): `npm ci`
  in `worker` and `web`; `node --test deploy/test/*.test.mjs`; worker `lint`, `typecheck`, `test`,
  `test:runtime`; web `lint`, `typecheck`, `test`, `build`; a guard that no file under `worker/src` or
  `web/src` imports from `mail-hero/` or `todofy/`; from `worker/`, `deploy-vars.mjs secrets` with
  placeholder values, then `deploy-vars.mjs exec -- wrangler deploy --dry-run --config ../wrangler.toml
  --secrets-file "$RUNNER_TEMP/home-secrets.json" --outdir "$RUNNER_TEMP/home-bundle"`; remove the secrets
  file (`if: always()`).
  `CI gate` needs and checks it.
- **Dashboard deploy**: `needs: [changes, dashboard-checks, gate, todofy-deploy, mail-hero-deploy]`;
  `if: !cancelled() && changes, dashboard-checks, gate == 'success' && todofy-deploy and mail-hero-deploy
  ∈ {success, skipped} && main && (push || dispatch) && dashboard_deploy` (the service bindings need
  both `Ops` entrypoints live; `test_ci_changes.py`'s shape test learns the success-or-skipped form for
  these two); `environment: production`, `concurrency: dashboard-production`; read the host and issuer from the
  committed config, build, write the secrets file, dry-run, `deploy-vars.mjs exec -- wrangler deploy` with
  `CLOUDFLARE_API_TOKEN: secrets.CF_API_TOKEN`; no D1. Probe: an unauthenticated
  `GET https://<host>/` (and `/api/v2/home`) must be a 302 whose `Location` starts with
  `ACCESS_ISSUER + '/'`; retry 10 × 15 s only while the answer is 5xx or no connection (certificate/DNS);
  any 2xx/4xx means the app answered without Access and fails the job at once.

## 11. Open items

- Production checks (verification.md): real Access login and alias; GraphQL with the replacement
  "Account Analytics: Read" token; the first real canary; whether `Ops` calls count in the apps'
  Worker request totals; the deploy probe.
