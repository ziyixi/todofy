# ops-v1 implementation plan

How each app implements [`README.md`](README.md). Written against `main` at `bf7a769` (2026-09-29).
Rules that bind every step: Mail Hero's `AGENTS.md` (Workers Free, bounded D1 reads per invocation,
no mail content in logs or alerts, additive migrations), Todofy's `docs/dev-notes.md` §3–§4 (every
D1 statement is a `Query` with its index, CAS transitions, results instead of exceptions over RPC).
Access/JWT/CSRF code (`mail-hero/cloudflare/src/native/security.ts` auth parts,
`todofy/gateway/src/access.ts`, `csrf.ts`) is not touched: `Ops` is reached only through service
bindings. Edits to the entry files are one export line each.

Already done in this change (contract level): the schema, types, validator and fixtures here; the
optional `canary` marker of `mail.received.v1` (schema, text, `fixtures/canary_event.json`);
`buildPayload(..., canary?)` and `syntheticCanaryMail()` in Mail Hero's `pipeline.ts` with the golden
case in `test/contract-fixtures.mjs`; both sides' contract tests and the `Contracts` CI job.

> **Since 2026-10-01 the contract is generated from [`proto/ops/v1/ops.proto`](../../proto/ops/v1/ops.proto)**
> (§3b). The hand-written types and the validators of §1.1–§1.2 were replaced by the generated code and
> the wire JSON codec in every app; those sections record how the surface was first built, and the
> file and test names below that changed are listed in §3b.

## 0. Rollout order

1. Todofy release with `canary_consumer` (migration `0003`, canary handling, `Ops`). Until it is live a
   canary event would be treated as real mail (the current parser ignores unknown fields) and create a
   Todoist task.
2. Mail Hero release with `Ops` (migration `0010`).
3. The dashboard (separate task) binds both, checks `capabilities`, and only then starts canaries.

Each app's release is independent (its own deploy job); CI applies each app's D1 migrations before its
deploy, and both migrations are additive, so the previous Worker's SQL runs correctly against the new
schema during the deploy gap and after a code rollback. That is a schema statement only: a Todofy core
without canary handling treats any canary it touches as real mail (Todoist task, lists, attention). See
§4 for the rollback order.

## 1. Shared pieces

### 1.1 Importing the types (tried; replaced by the generated services, §3b)

| App | File | Import |
| --- | --- | --- |
| Mail Hero | `mail-hero/cloudflare/src/native/ops.ts` | `import type { MailHeroOps, ... } from '../../../../contracts/ops-v1/ops-v1.ts'` |
| Todofy | `todofy/gateway/src/ops.ts` | `import type { TodofyOps, ... } from '../../../contracts/ops-v1/ops-v1.ts'` |

Use `import type` for types (the gateway has `verbatimModuleSyntax`); value imports of the constants
(`OPS_LIMITS`, `OPS_VERSION`, the reason lists) are fine and get bundled. Tried on 2026-09-29 with
throwaway probe files (not committed), each an `export class Ops extends WorkerEntrypoint<Env>
implements <App>Ops` plus one `export { Ops } from ...` line in the entry file:

- Mail Hero: `npm run typecheck` passes; `wrangler deploy --dry-run --config wrangler.native.toml`
  bundles `../../contracts/ops-v1/ops-v1.ts` and exports `MailCoordinator`, `Ops`, `default`;
  `test/native-runtime.test.mjs` (esbuild with `external: ['cloudflare:workers']`, miniflare) passes.
- Todofy gateway: `npm run typecheck` and `eslint` on the import pass; `wrangler deploy --dry-run
  --config gateway/wrangler.toml` bundles it and exports `Ops` and `default`. **vitest fails** because
  the unit tests import `src/index.ts` in Node, where `cloudflare:workers` does not exist. Fix (tried,
  70/70 tests pass, tsc and eslint clean): `resolve: { alias: { 'cloudflare:workers':
  '/test/cloudflare-workers.ts' } }` in `gateway/vitest.config.ts` (a leading `/` is the project root;
  `node:url` would need Node types the gateway does not load) and a stand-in
  `test/cloudflare-workers.ts` exporting `class WorkerEntrypoint<Env> { protected readonly ctx; protected
  readonly env; constructor(ctx, env) }`. Methods without `await` trip `@typescript-eslint/require-await`;
  the real forwarders all await the core.
- Transport: in miniflare, a second Worker with `serviceBindings: { MAIL_HERO: { name: 'mail-hero',
  entrypoint: 'Ops' } }` called `status()` and `setGuard()` of the bundled Mail Hero and got plain JSON
  objects; `throw new Error('invalid_input')` in an entrypoint arrives as `Error` with that exact
  message; an unknown method rejects ("The RPC receiver does not implement the method").
- Dashboard side: the `Service<MailHeroOpsEntrypoint>` declaration from README.md type-checks under the
  gateway's strict flags (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), and the result
  unions narrow (`state === 'queued'` gives a `string` `event_id`).

`ops-v1.ts` uses only erasable syntax (no enums or namespaces), so Node's type stripping imports it too
(`test/ops-contract.test.mjs` does).

### 1.2 Validating outputs against the schema (replaced by the wire codec, §3b)

Validator choice: the repositories have exactly one JSON Schema implementation, Todofy's dev
dependency `jsonschema==4.26.0` (Draft 2020-12), already used by `test_mail_hero_compat.py`. Mail Hero
and the gateway have none (`ajv@6` in the gateway lockfile is ESLint's transitive dependency, Draft-07
only, and not a direct dependency). So:

- Python (Todofy core): `jsonschema.Draft202012Validator({**schema, "$ref": "#/$defs/<Def>"})`, as
  `tests/unit/test_ops_contract.py` does.
- TypeScript (Mail Hero, gateway, dashboard): `contracts/ops-v1/validate.mjs`, dependency-free, the
  keyword subset of the schema only. It throws on any other keyword, and `test_ops_contract.py` asserts
  the schema stays inside that subset, so a schema edit that needs more fails CI instead of being
  skipped. Both sides give every fixture the same verdict (valid under `fixtures/<Def>/`, invalid under
  `fixtures/invalid/<Def>/`), which pins the two implementations together.

Every implementation test that calls an ops method validates its result with one of these.

## 2. Mail Hero

### 2.1 Files and functions

| File | Change |
| --- | --- |
| `src/native/ops.ts` (new) | `export class Ops extends WorkerEntrypoint<Env> implements MailHeroOps`: `status()`, `setGuard()`, `startCanary()`, `canaryDelivery()`; input checks (`invalid_input`), signal and health derivation (pure helpers, exported for unit tests) |
| `src/native/index.ts` | one line: `export { Ops } from './ops.ts';` |
| `src/native/coordinator.ts` | constructor: `ops_guard` and `ops_job_runs` tables (2.3); routes `GET /ops/status`, `POST /ops/guard`; `alarm()` passes an `OpsDeferral` to `runMaintenance` |
| `src/native/pipeline.ts` | `runMaintenance(env, deferral?)` skips deferrable jobs (2.5); `createSyntheticCanaryDelivery(env, revisionID, runID)` next to `createSyntheticTestDelivery` (shared helper, `canary_run_id` column); `createDelivery` passes `{run_id: message.canary_run_id}` to `buildPayload` when set; `cleanupCanaryContent(env)` |
| `src/native/alerts.ts` | `alertSnapshot`/`alertSignals` reused unchanged; `evaluateAlerts` upsert maintains `alerts.active_since` (2.2) |
| `src/native/types.ts` | `Env.PUBLIC_HOST?: string` |
| `deploy/generate-ci-config.mjs` (+ its test) | `vars.PUBLIC_HOST` from the already validated `MAIL_HERO_PUBLIC_HOST` (since 2026-09-30 the generator is retired and `PUBLIC_HOST` is committed in `mail-hero/wrangler.toml`) |
| `wrangler.native.toml` | `PUBLIC_HOST = "mail.example.com"` placeholder (the template is retired; see above) |
| `migrations/0010_ops_canary.sql` (new) | 2.2 |
| `src/native/api-messages.ts` | delivery JSON gains `canary: boolean` (message has `canary_run_id`); UI labels such deliveries 金丝雀 (optional, `web/`) |
| docs | `mail-hero/README.md`, `docs/cloudflare-setup.md` (the `Ops` entrypoint, `PUBLIC_HOST`, what shed defers), `docs/verification-native.md` (evidence once run) |

### 2.2 D1 migration `0010_ops_canary.sql` (additive)

```sql
-- ops-v1. Additive: the previous Worker keeps running between this migration and the deploy.
-- Canary messages (origin 'synthetic_test') carry the dashboard's run id; the previous Worker never sets it.
ALTER TABLE messages ADD COLUMN canary_run_id TEXT;
-- Canary content cleanup walks live canary messages by age only.
CREATE INDEX messages_canary_idx ON messages(received_at,id) WHERE canary_run_id IS NOT NULL AND content_deleted_at IS NULL;
-- Start of the current activation of an alert (first_seen_at is the first activation ever).
ALTER TABLE alerts ADD COLUMN active_since TEXT;
```

`evaluateAlerts` sets `active_since` to the evaluation time when a signal turns active (or is active with
`active_since` NULL, i.e. right after the deploy), and NULL when it resolves. An older Worker leaves it
unchanged, which only makes `since` absent or early for one episode. The backup export pages tables
generically; confirm in `native-backup-runtime.test.mjs` that the new columns round-trip. The backup
collector image rebuilds on `migrations/**` changes (existing workflow).

`origin` keeps its CHECK (`cloudflare`, `synthetic_test`): canary messages are `synthetic_test` with a
non-NULL `canary_run_id`, so every existing `origin='cloudflare'` filter (inbox, search, alerts'
unsettled/parse queries, delivery stats, lifecycle) already leaves them out.

### 2.3 Durable Object storage (MailCoordinator, `CREATE TABLE IF NOT EXISTS`)

```sql
CREATE TABLE IF NOT EXISTS ops_guard(id INTEGER PRIMARY KEY CHECK(id=1), level TEXT NOT NULL, reason TEXT,
  until INTEGER, set_at INTEGER)                              -- epoch ms; absent row = normal
CREATE TABLE IF NOT EXISTS ops_job_runs(job TEXT PRIMARY KEY, at INTEGER NOT NULL)  -- last run, epoch ms
```

The guard lives here, not in D1: no migration, never in a backup or restore, not blocked by a backup
snapshot's write lease, and read by the alarm without a D1 query. `POST /ops/guard` validates again
(level, code, `until` in (now, now+36 h]) and returns the `GuardState`; `GET /ops/status` returns
`{jobs_pending, jobs_failed, next_alarm, backup (status() without policy), capacity (snapshot()),
ingest_today: {messages, bytes} (SELECT count(*),sum(size) FROM ingress_reservations WHERE day=?, index
ingress_day, ≤ INGEST_DAILY_MESSAGE_LIMIT rows), guard}`. Both answer 503 on a storage error, which
`Ops` maps to `unavailable`.

### 2.4 `status()`

Sources and budget (≤ 6 D1 statements, no writes, 1 Durable Object request):

| # | Read | Rows |
| --- | --- | --- |
| 1–5 | `alertSnapshot(env)` unchanged: settings+endpoint+revision, `parseStatus`, unsettled, in-flight, waiting | the same partial-index ranges the 10-minute alert phase already reads: live unsettled `cloudflare` messages, deliveries in `pending/retry_wait/sending`, never the history |
| 6 | `SELECT code,active_since FROM alerts WHERE active=1 LIMIT 16` | ≤ 16 (one row per alert code) |
| DO | `GET /ops/status` | DO SQLite: jobs (pending backlog), capacity totals (O(1)), today's reservations (≤ daily limit), guard |

Then `snapshot.capacity_used_bytes/limit_bytes` from the DO capacity (as `evaluateAlerts` does) and
`alertSignals(snapshot)`: the active ones become signals, with `since` = `active_since` when the alerts
row is active. Added signals: `maintenance_mode` (critical, `MAINTENANCE_MODE`), `force_send_paused`
and `send_paused` (warning), `ingest_quota_80` (warning; today's messages or bytes ≥ 80 % of
`INGEST_DAILY_*_LIMIT`; metrics `messages, bytes, message_limit, byte_limit, percent`), `forwarding_off`
(info; mode archive or no current endpoint), `backup_active` (info), `guard_shed` (info,
`seconds_left`). A thrown read gives `health: down`, the single signal `status_unavailable`, empty
`counters`, `modes` from vars only; `status()` itself only throws for a bug.

Counters: `jobs_pending`, `jobs_failed`, `parse_failed`, `delivery_failed`, `policy_error`,
`blocked_waiting`, `paused_waiting`, `oldest_pending_age_seconds`, `capacity_used_bytes`,
`capacity_limit_bytes`, `logical_bytes`, `ingest_today_messages`, `ingest_today_bytes`,
`ingest_limit_messages`, `ingest_limit_bytes`. `last_backup_at` = `app_settings.last_backup_at`.
`ui_url` = `https://${PUBLIC_HOST}/` when `PUBLIC_HOST` is a valid lowercase hostname, else null.
Modes: `maintenance`, `force_send_paused`, `send_paused` (settings), `forwarding`, `backup_active`
(DO backup status has an active lease). Capabilities `["canary_producer", "guard"]`.

### 2.5 Guard: keep or defer (Mail Hero)

`runMaintenance(env, deferral)` receives `{ defers(job): boolean; ran(job): void }` from the
coordinator: `defers` is true while the guard is effectively `shed` **and** the job last completed
within its bound (48 h, from `ops_job_runs`); `ran` records a complete run. The bound covers the whole
job, not one bounded batch of it: `raw_reconcile` is deferred only when a new pass would start (a pass
in progress, `raw_reconcile_cursor` non-empty, keeps its 10-minute pages) and records `ran` when a pass
reaches the end of the bucket; `lifecycle_retention` records it only after a pass that left nothing due
(`runLifecycle` answered `continueSoon: false`), `alert_history_purge` after a delete that did not fill
its 20-row batch, `canary_cleanup` after a pass that found nothing to clean. So under a guard renewed
forever a full raw scan still ends within 48 h plus its pages, and retention never falls more than about
48 h of mail behind (it clears about 288 items a day at its normal cadence against about 100 arriving).
Without a deferral (tests, older callers) everything runs as today. Skipping never moves the maintenance clock or the phase cycle, so there is no
busy loop and nothing is rescheduled when the guard ends.

| Job (where) | Shed | Why |
| --- | --- | --- |
| `email()` intake, daily reservation, R2 write, job registration | keep | ingest |
| parse jobs (Alarm, `parseJob`) | keep | parsing of accepted mail |
| deliver jobs, retries, rate limits, route-block rechecks | keep | delivery and retries |
| repair phase: re-enqueue pending/stale-parsing/unsent parse, due deliveries | keep | integrity repair (accepted mail cannot be stranded) |
| repair phase: route-block cooldown healing, `retry_window_expired` marking | keep | keeps the in-flight set and the scheduler's view correct (bounded, ≤ 20 rows) |
| `reconcileCapacity` (DO, ≤ 4 D1 point reads) | keep | frees abandoned reservations that gate ingest |
| lifecycle phase: resume `content_purge_pending` | keep | finishes an owner deletion already begun (no resurrection) |
| alerts phase: `evaluateAlerts`, `deliverAlert` | keep | monitoring; `status()` and the owner's alert webhook depend on it |
| backup lease, receipt sync, backup API | keep | driven by the external collector |
| DO `ingress_reservations` expiry | keep | DO only |
| `raw_reconcile`: R2 `raw/` inventory page + receipt lookup, and `collectOrphans` (same block) | **defer** (48 h) | safety net: jobs are registered before the R2 write, so it only finds losses; costs R2 Class A lists; a new pass starts at most 48 h after the last complete one and then runs its pages at the normal cadence, so a lost message is still found within about two days |
| `lifecycle_retention`: `runLifecycle` (expiry, resolved cleanup, clock sweep) | **defer** (48 h) | cleanup only; nothing is lost by running it later (capacity signals stay visible) |
| `canary_cleanup` (new, 2.6) | **defer** (48 h) | cleanup of synthetic content |
| `alert_history_purge`: 180-day `alert_notifications` delete | **defer** (48 h) | cleanup |

`GuardState.deferred` for Mail Hero is `["raw_reconcile", "lifecycle_retention", "canary_cleanup",
"alert_history_purge"]` while shed.

### 2.6 Canary

`startCanary({run_id})` in `ops.ts`, in this order (≤ 2 D1 reads before any write):

1. `run_id` fails `CANARY_RUN_ID` (`pipeline.ts`) → throw `invalid_input`.
2. `SELECT event_id FROM deliveries WHERE action_request_id=?` with `canary:<run_id>` (unique index) →
   `queued` with that ID (idempotent, whatever the pause or maintenance state is now; maintenance stops
   writes, not this read).
3. `MAINTENANCE_MODE` → `unavailable/maintenance` (also when the lookup itself failed).
4. One read of settings + current endpoint + current revision (the `alertSnapshot` settings join):
   `FORCE_SEND_PAUSED` → `paused/send_paused`; `send_paused` → `paused/settings_paused`; mode not
   `forward` or no endpoint → `unavailable/no_endpoint`; endpoint paused or archived →
   `paused/endpoint_paused`; revision blocked and not yet due for recheck → `paused/endpoint_blocked`.
5. `withBackupWrite(env, () => requestDelivery(env, {kind: 'canary', revisionID, runID}))`: the coordinator
   runs `createSyntheticCanaryDelivery(env, revisionID, runID)` (`/deliveries/create`; building the event
   is beyond a Worker request's 10 ms) and passes its error code back; a refused lease
   (`backup_in_progress`) → `unavailable/backup_active`; `logical_capacity` or the capacity-guarded
   message insert not happening → `unavailable/capacity`; any other error → throw `unavailable`.
6. → `{event_id, state: "queued"}`.

`createSyntheticCanaryDelivery` is `createSyntheticTestDelivery` with the action ID `canary:<run_id>`
(so the message ID is still `sha256("synthetic:" + actionID)`, stable per run), `syntheticCanaryMail()`
instead of `syntheticTestMail()`, `canary_run_id` in the message insert and `retryMode: 'auto'` (the
canary exercises the real retry path; the owner's connection test stays `once`). `createDelivery` reads
the message row anyway and passes `canary_run_id` to `buildPayload`, so an owner "resend as new event"
of a canary message is a canary again. The owner's connection test bytes are unchanged (golden
`synthetic_test_event.json`). A canary action ID can never collide with an owner action (those are UUIDs).

`canaryDelivery(eventId)`: UUID check, then one statement:

```sql
SELECT d.state,d.attempt_count,d.delivered_at,d.last_error,e.paused,e.archived_at,s.send_paused,r.blocked_reason,r.blocked_until,
  (SELECT a.http_status FROM delivery_attempts a WHERE a.event_id=d.event_id ORDER BY a.attempt_no DESC LIMIT 1) last_http_status
FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN endpoint_revisions r ON r.id=d.endpoint_revision_id
JOIN webhook_endpoints e ON e.id=r.endpoint_id JOIN app_settings s ON s.id=1
WHERE d.event_id=? AND m.canary_run_id IS NOT NULL
```

No row → `unknown` (also for real mail). `delivered` → `delivered`; `failed`/`cancelled` → `failed`
(`error_code` = `last_error`, `canary_cancelled` when NULL); `pending/retry_wait/sending` → `paused`
when `FORCE_SEND_PAUSED`, `MAINTENANCE_MODE`, settings or endpoint pause/archive, or a block of the
event's revision not yet due for a recheck (`blocked_until` NULL or later; `error_code` = the block code)
hold it, as `deliveryJSON`'s `effective_state` and `startCanary`'s `endpoint_blocked`; else `pending`
(`error_code` = `last_error` when set).

Canary content cleanup (`cleanupCanaryContent`, alerts phase, deferrable): at most one message per pass,
`SELECT m.id,m.version FROM messages m INDEXED BY messages_canary_idx WHERE canary_run_id IS NOT NULL AND
content_deleted_at IS NULL AND received_at<? AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE
d.message_id=m.id AND d.state IN('pending','retry_wait','sending')) ORDER BY received_at LIMIT 1` with
the cutoff 7 days, then `deleteMessageContent(env, id, version)` (the owner-delete path: capacity,
deletion manifest, tombstone). About 15 D1 statements; the alerts phase stays under the 40 the bounded
runtime test allows. Without it every daily canary would leave a message, a payload and a parsed object
forever (owner connection tests keep today's behaviour).

### 2.7 Tests (Mail Hero)

- `test/ops-golden.test.mjs`: the exact bytes of every answer for fixed synthetic state (§3b).
- `test/native-ops.test.mjs` (Node): signal/health derivation, input validation, `GuardState` expiry
  arithmetic, run-id rules; every produced object read back strictly with the wire codec.
- `test/cpu/native-ops-cpu.test.mjs` (workerd, `npm run test:cpu`, alone and serially): CPU of every
  `Ops` call against the Free limit, the isolate's first `status()` included (the median of three fresh
  isolates).
- `test/native-ops-runtime.test.mjs` (miniflare, two Workers as in 1.1: the bundle and a caller with an
  `Ops` service binding): status in normal/maintenance/paused/shed states validates against `OpsStatus`
  and contains none of the seeded synthetic subjects/addresses; D1 statements of `status()` ≤ 6 with the
  meter of `native-bounded-runtime.test.mjs`; setGuard idempotency, 36 h bound, expiry; startCanary
  queued → the fake consumer receives bytes with `canary` equal to what `buildPayload` builds, same
  `event_id` on a second call, `paused`/`unavailable` create nothing (no rows, no R2 objects); the
  endpoint's 503 then 204 → `canaryDelivery` pending (http 503) then delivered; shed skips exactly the
  four jobs and runs them once `ops_job_runs` is older than 48 h; under a renewed guard a multi-page raw
  scan and multi-batch retention and history backlogs run every cycle until caught up, then defer
  again; canary cleanup after 7 days.
- Existing suites unchanged; `contract-fixtures.test.mjs` already covers `canary_event.json`.

## 3. Todofy

### 3.1 Files and functions

| File | Change |
| --- | --- |
| `gateway/src/ops.ts` (new) | `export class Ops extends WorkerEntrypoint<Env> implements TodofyOps`: each method calls one core method on `coordinator(this.env)` and unwraps `{ok}` / `{error}` (throws `new Error(code)`); a thrown call → `unavailable`. `reportOps` refuses a report over 8 KiB of compact JSON before calling the core |
| `gateway/src/index.ts` | one line: `export { Ops } from './ops.ts';` |
| `gateway/src/coordinator.ts` | `Coordinator` interface gains `ops_status()`, `ops_set_guard(inputJson)`, `ops_canary_result(eventId)`, `ops_report(reportJson)`, each `Promise<{ok: T} \| {error: ErrorCode}>` (`ops.v1.ErrorCode`) |
| `gateway/vitest.config.ts`, `gateway/test/cloudflare-workers.ts` (new) | the alias and stand-in from 1.1 |
| `worker/todofy/runtime/coordinator.py` | the four RPC methods (they return plain dicts and never raise; `JsException` → `{"error": "unavailable"}`); canary branches in `_summarize`, `_create_task`, `_lookup`, `_complete`; deferral in `_run`, `_ticks`, `_metrics_tick`, `_next_alarm_ms` |
| `worker/todofy/runtime/ops.py` (new) | DO tables, guard read/write, `defer_until(job, now)`, `ran(job)`, report store, status assembly |
| `worker/todofy/core/ops.py` (new, pure) | input validation (`Code`/`RunId`/timestamp regexes with `fullmatch`, the 36 h and 5 min rules, 8 KiB), signal and health derivation, digest item selection and ordering |
| `worker/todofy/core/contract.py` | `MailEvent.canary_run_id: str \| None`; `canary` present → must be an object whose `run_id` fullmatches the pattern, else `ContractError("canary")` (400, nothing stored) |
| `worker/todofy/runtime/ledger.py`, `core/sql/ledger.py` | `EventRow.canary_run_id`; `ingest(..., canary_run_id)` writes it; `recover_interrupted` canary branch |
| `worker/todofy/core/vocab.py` | `Code.CANARY_SIDE_EFFECT_BLOCKED`; `allowed_actions(state, code, *, canary=False)` → `()` for canaries |
| `worker/todofy/core/metrics.py`, `runtime/metrics.py`, `core/sql/metrics.py` | `Step.CANARY`; the transition walk skips canaries (3.6) |
| `worker/todofy/core/sql/{views,reminders}.py` | canary exclusions (3.6) |
| `worker/todofy/core/reminder_text.py`, `runtime/reminder.py`, `core/sql/reminders.py` | digest (3.7) |
| `worker/todofy/runtime/api.py` | canary-free counts; `EventDetail.canary`; reconcile passes `canary` to `allowed_actions`; `Reminder.ops_count` |
| `worker/todofy/core/sql/backup.py` | `MAIL_EVENTS` columns + `canary_run_id`, `MAIL_REMINDERS` + `ops_count`, `ops_generated_at` (restore names its columns, so older backups still load) |
| `migrations/0003_ops.sql` (new) | 3.2 |
| `api/owner-api-v1.openapi.yaml` (since 2026-10-02 the IDL `proto/todofy/ui/v1`: `MailEvent.canary`), `web/src/lib/labels.ts`, `web/` | optional `EventDetail.canary`, `Reminder.ops_count`, the new code's label, a 金丝雀 badge on the event page |
| docs | `docs/gateway-contract.md` §3 (four RPC methods, the `Ops` entrypoint), `docs/dev-notes.md` §5–§6 (module contracts, canary exclusions, AE step `canary`), `docs/cloudflare-setup.md` (what shed defers) |

### 3.2 D1 migration `0003_ops.sql` (additive)

```sql
-- ops-v1. Additive: the previous release keeps running between this migration and the deploy.
-- Set only for mail.received.v1 events that carry "canary"; the previous release never sets it.
ALTER TABLE mail_events ADD COLUMN canary_run_id TEXT CHECK (canary_run_id IS NULL OR length(canary_run_id) BETWEEN 1 AND 64);
-- Ops items in that day's reminder (the frozen body lists them).
ALTER TABLE mail_reminders ADD COLUMN ops_count INTEGER NOT NULL DEFAULT 0 CHECK (ops_count >= 0);
-- generated_at (epoch ms) of the report that day's body lists, 0 for none.
ALTER TABLE mail_reminders ADD COLUMN ops_generated_at INTEGER NOT NULL DEFAULT 0 CHECK (ops_generated_at >= 0);
```

`tests/unit/test_schema_sql.py` then re-checks every query plan; `tests/runtime/test_migrations.py`
covers applying it.

### 3.3 Durable Object storage (TodofyCore, `DO_SCHEMA` of `runtime/ops.py`)

```sql
CREATE TABLE IF NOT EXISTS ops_guard (id INTEGER PRIMARY KEY CHECK (id = 1), level TEXT NOT NULL, reason TEXT,
  until INTEGER, set_at INTEGER)                              -- Unix seconds; absent row = normal
CREATE TABLE IF NOT EXISTS ops_job_runs (job TEXT PRIMARY KEY, at INTEGER NOT NULL)
CREATE TABLE IF NOT EXISTS ops_report (id INTEGER PRIMARY KEY CHECK (id = 1), generated_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL, doc TEXT NOT NULL CHECK (length(doc) <= 8192))
```

Like the object's other tables these may be lost (cutover, `lose_object_storage`): the guard reads
`normal`, the report is gone until the dashboard's next daily report (one digest without an ops section).

### 3.4 RPC and errors

Core methods take JSON text for structured inputs (`json.loads` in Python; no JsProxy conversion) and
return `{"ok": <value>}` or `{"error": "invalid_input" | "busy" | "unavailable"}`. They are allowed in
maintenance mode: `status` reports it, `setGuard`/`reportOps` write only object storage,
`canaryResult` reads one row. `ops_report` wakes the object and sets `control.next_reminder_check` to
now, so a day whose reminder was not yet created considers the new report at once.

### 3.5 `status()` and budget

One D1 batch of ≤ 6 statements, no D1 writes: `views.ACTIVE_COUNTS`, `views.ATTENTION_COUNT`,
`views.RECEIVED_SINCE` (now − 1 day), `views.OLDEST_DUE` (the Overview's batch, canaries excluded),
`reminders.REMINDER_DAY` for today and, since task-intent-v1 (2026-09-30), `intents.COUNTS` (pending
intents and intents failed within 7 days, on the `task_intents_updated` index). Rows: active events
(twice, `mail_events_by_state`), events of the last 24 h, due events, one reminder row, the intents
counted. The GTD ledger adds no D1 read (object storage, below). Object storage: `budgets()`, `backup.overview`, the guard.

Signals: `maintenance_mode` (critical); `processing_paused`, `todoist_paused` (warning);
`reminder_disabled` (info); `attention` (warning, `count`); `due_backlog` (warning, oldest due ≥ 1 h,
`oldest_age_seconds`); `todoist_blocked` (critical, `seconds_left`); `gemini_budget_80` (warning) and
`gemini_budget_95` (critical) on (used + reserved) / budget, metrics `percent, used_tokens,
reserved_tokens, budget_tokens`; `backup_stale` (critical: backups bound and no complete backup or the
last one older than 8 days; `age_seconds, has_backup`), `backup_failed` (warning, last job failed),
`backup_disabled` / `backup_active` (info); `reminder_failed` (warning: today's row `failed` with no
attempts left, or `unknown`; `attempts`); `guard_shed` (info); from the GTD ledger
(todofy/docs/gtd-features.md, object storage only): `gtd_snapshot_stale` (warning, `age_hours`: the daily
Todoist snapshot is allowed and its last ok run, or the first attempt, is over 48 h old) and
`review_overdue` (info, `days`: the weekly review and the daily snapshot that sees it done are both on,
and its last completion is over 10 days old;
info on purpose, so a skipped personal review never degrades the tile or enters the digest). Health as in
README.md.

Counters: `active_events`, `attention_events`, `received_24h`, `oldest_due_age_seconds`,
`gemini_used_tokens`, `gemini_reserved_tokens`, `gemini_token_budget`, `gemini_calls`,
`todoist_window_calls`, `todoist_window_limit`, `intents_pending`, `intents_failed_7d` (task-intent-v1),
`backup_age_seconds`, and the GTD ledger's `inbox_open`,
`inbox_oldest_days`, `overdue`, `carryover_open` (mail tasks of the 14 days before the last 24 h still
open), `completed_7d` (the latest complete snapshot aggregate, each left out while unknown) and
`review_age_days` (while the review and the snapshot are on): at most 19 of the 32 allowed.
`last_backup_at` from
`backup.overview`; `ui_url` = `https://{TODOFY_PUBLIC_HOST}/`; capabilities `["canary_consumer",
"guard", "ops_digest"]`; modes `maintenance`, `processing_paused`, `force_pause_todoist`,
`reminder_enabled`, `backup_active` (`backup.holds_ledger`).

### 3.6 Canary processing and exclusions

Intake is unchanged: the gateway's Bearer, maintenance, media-type and size checks, then
`TodofyCore.ingest`: `parse_mail_event` (now reading `canary`), key = `event_id`, `ledger.ingest` with
`canary_run_id` (same idempotency: same bytes 204, different bytes 409). 204 means taken over.

State machine of a canary row (ledger states; transitions are the usual CAS + `event_transitions`):

```
pending --(alarm step; not PROCESSING_PAUSED, no backup hold, not maintenance)-->
   reserve tokens refused ----------------------------------------> ignored   [llm_budget_exhausted]
   stored payload unreadable / needs_review ------------------------> ignored   [invalid_saved_event | mail_needs_review]
   summarizing --Gemini ok + clean_summary + render_todo_body
                 + build_task_request (built, never sent)-----------> complete  [''] (no summaries row)
               --RequestTooLarge--------------------------------------> ignored   [todoist_rejected]
               --Gemini failed, transient (summary_failed, llm_quota)
                 and attempts + 1 < 3 --------------------------------> pending   [code] (normal backoff: 1, 2 min)
               --Gemini failed otherwise ----------------------------> ignored   [code]
   summarizing interrupted: crashes + 1 < 3 -----------------------> pending
                            crashes + 1 ≥ 3 -----------------------> ignored   [processing_interrupted_limit]
summarized | todo_sending | todo_unknown | todo_created (only if an older release ingested it):
   _create_task / _lookup ------------------------------------------> ignored   [canary_side_effect_blocked] (no Todoist call)
   _complete -------------------------------------------------------> complete  (no summaries row)
```

`_summarize` branches when `row.canary_run_id` or the parsed payload's `canary_run_id` is set (either is
enough; the payload check also covers rows restored from a backup without the column). The Gemini call
is the normal one (same prompts, preface, deadline, token reservation and settlement, `llm_inflight`);
its Analytics Engine point uses `Step.CANARY` instead of `Step.SUMMARY` so summary latency stays real
mail only; the object's `gemini_calls`/`gemini_tokens:<model>` counters still count it (they measure the
budget the canary really spends).

`canaryResult(eventId)`: `ledger.get` (primary key). No row or `canary_run_id` NULL → `not_seen`;
`pending`/`summarizing` → `processing` with `waiting_code` `maintenance` (`MAINTENANCE_MODE`),
`processing_paused`, `backup_active` (`backup.holds_ledger`) or `retry_wait` (`last_error_code` set);
`complete` → `ok`, `completed_at` = `updated_at`; `ignored` → `failed`, `error_code` =
`last_error_code`; any other state → `failed`, `canary_side_effect_blocked`.

Every read that must skip canaries (add `AND canary_run_id IS NULL`; the named index still drives each
plan, `test_schema_sql.py` re-checks):

| Query / code | Why |
| --- | --- |
| `sql/reminders.py` `ATTENTION_COUNT`, `ATTENTION_ROWS` | never in reminders (a canary held by a pause for > 6 h would otherwise be "attention") |
| `sql/views.py` `ATTENTION_PAGE`, `ATTENTION_COUNT` | never in the attention list or its count |
| `sql/views.py` `ACTIVE_COUNTS`, `RECEIVED_SINCE`, `OLDEST_DUE` | Overview and `status()` count real mail only |
| `sql/views.py` `RECENT_PAGE`, `RECENT_PAGE_BY_STATE` | hidden from the owner's event lists; `GET /api/v1/events/{id}` still answers, with `canary: true` and a badge |
| `sql/metrics.py` `TRANSITIONS_AFTER` + `runtime/metrics._walk` | join `mail_events` for arrivals too (`t.from_state IS NULL OR t.to_state = 'complete'`), select `e.canary_run_id`, and skip canary rows: no `mails_received`/`mails_completed`/latency. About one extra primary-key read per arrival (≈ 100 a day) |
| `summaries` / reports / newsletter | nothing to change: a canary never writes a `summaries` row (complete without `CompletedSummary`), and `/api/summary`, `/api/recommendation` and precompute read only `summaries`; a runtime test asserts it |
| Todoist | `_create_task`, `_lookup`, `_complete` guards above; `allowed_actions(..., canary=True)` is empty, so no owner reconcile can resend a canary |
| retention | nothing: `mail_events` is never deleted; canary rows are terminal with `payload` NULL (≈ 365 small rows a year) |

Not excluded on purpose: `NEXT_DUE`, `NEXT_WAKE`, `INTERRUPTED`, `EVENT` (the canary must be processed,
recovered and looked up).

### 3.7 Guard: keep or defer (Todofy)

`runtime/ops.defer_until(env, store, job, now)` returns None (run) or the Unix time to reconsider:
`min(guard.until, bound)` while the guard is effectively shed and the job is inside its bound. Deferring
**moves the job's own control time** to that value (otherwise `_next_alarm_ms` would see a past time and
loop every second). `setGuard(normal)` from shed sets `control.next_maintenance` and
`metric_flush.next_at` to at most now and wakes the object, so deferred jobs run at once.

| Job (where) | Shed | Why |
| --- | --- | --- |
| webhook intake (`ingest`) | keep | intake |
| ledger step: summary, task, lookup, complete (`_step`) | keep | real mail |
| canary processing | keep | same path |
| `_settle_interrupted_summaries`, `recover_interrupted`, watchdog alarm | keep | integrity |
| a backup job already running (`backup.run` with `state.job`) | keep | it holds the ledger; abandoning it wastes its reads and restarts later |
| reminder / digest tick | keep | schedule-keeping; the digest is how a shed day is reported |
| report precompute (`reports.tick`) | keep | deferring moves the cost to the newsletter's on-demand computation, it saves nothing |
| `todoist_calls`, `llm_usage`, `report_*` DO housekeeping | keep | DO only |
| cron `wake()` | keep | schedule |
| `weekly_backup`: starting a new job (`backup.run` with no job) | **defer** unless the last complete backup is older than 7.5 days or there is none | D1 rows read of a full export; bounded so a renewed shed cannot skip a whole week, and 12 h below `backup_stale` (8 days) so the guard never raises that critical signal itself |
| `retention` tick (`control.next_maintenance`) | **defer** (72 h since the last sweep that left no expired rows; a sweep that continues in a minute does not count) | pure cleanup of expired rows, bounded batches; once due it drains the whole backlog |
| `metrics_rollup` (`_metrics_tick`, `metrics.flush`) | **defer** (72 h since the last flush that caught up; one that continues in a minute does not count) | the walk is cursor-based and catches up 7 days per flush, so no day is lost; days only appear later on the trends page |
| `gtd_snapshot` (a new daily Todoist snapshot, `runtime/gtd.py`) | **defer** (48 h since the last completed snapshot; one already running continues) | a few hundred D1 rows written a day; the carryover and the GTD counters then use an older snapshot or none, and the brief falls back to the 24 h report |
| GTD review (Sunday task) | keep | owner-facing, like the reminder |

`GuardState.deferred` for Todofy is `["weekly_backup", "retention", "metrics_rollup", "gtd_snapshot"]` while
shed.

### 3.8 `reportOps` and the digest

`ops_report(report_json)`: `core.ops.validate_report` (schema rules with `fullmatch`, ≤ 20 items,
≤ 8 KiB, `generated_at` ≤ now + 300 s) → `invalid_input`; if a stored report has a later
`generated_at` → `{stored: false, <stored generated_at>, <stored item_count>}`; else replace the row
(compact JSON) → `{stored: true, ...}`.

`reminder.tick` (`runtime/reminder.py`): after the existing early exits (disabled, `FORCE_PAUSE_TODOIST`,
`PROCESSING_PAUSED`, the day already claimed and not retryable), compute `attention` (canary-free) and
`ops = core.ops.digest_items(stored_report, now)`: only if `now - generated_at ≤ 36 h`, only
`warning`/`critical` items, sorted by severity (critical first), then `source`, `code`, `since`. The
digest is then dropped (`_ops_due`) when an earlier day's reminder already listed that report
(`OPS_CARRIED`: `ops_generated_at` of the at most two rows from the report's UTC day to yesterday), or
when nothing needs attention and the report was generated on the current UTC day: on its own a report
is the next day's digest, so the 23:40 report never makes that evening's task and the next day's, 20
minutes apart, with the same items. If both are empty → check again in 10 min (today's behaviour).
Otherwise claim the day as today, with `subject = reminder_title(attention, len(ops))`, `body =
reminder_body(attention, day, rows, host, ops=OpsDigest(generated_at, items, dashboard_url))`,
`ops_count = len(ops)` and `ops_generated_at` (the report's epoch ms, 0 for none) bound in `CLAIM_DAY`.
`ATTENTION_ROWS` runs only when `attention > 0`. Retries (`CLAIM_RETRY`) reuse the frozen subject and
body, so the `X-Request-Id` stays the same, and run while mail needs attention or the frozen day lists
ops items (`ops_count > 0`); never a second task on a day.

Text (`core/reminder_text.py`). Without ops items both functions return today's exact bytes (the Go
golden tests stay). Titles:

| attention | ops | Title |
| --- | --- | --- |
| > 0 | 0 | `[Todofy System] Mail Hero：{a} 封邮件需要处理` (unchanged) |
| > 0 | > 0 | `[Todofy System] Mail Hero：{a} 封邮件需要处理；运维 {o} 项` |
| 0 | > 0 | `[Todofy System] 运维：{o} 项需要关注` |

Body with ops items: the unchanged attention part (header and rows, when `attention > 0`), then the ops
section, then the unchanged instructions when `attention > 0`, or only the last line
`\n此提醒每个 UTC 日最多创建一次。` when `attention == 0`. The ops section:

```
\n运维（仪表盘报告，生成于 {generated_at}）：\n
- {severity} · {source} · {code} · 自 {since}[ · {k}={v}, {k}={v}]\n     (one line per item, at most 20)
查看仪表盘：{dashboard_url}\n                                          (only when present)
```

Metrics are sorted by name; an integral value prints as an integer, anything else with up to three
decimals and no trailing zeros. Timestamps print as Todofy's `rfc3339` (seconds, `Z`). Only these fields
reach the text; the report never carries free text (the schema's `Code` pattern and numeric metrics,
re-checked by `fullmatch` in Python). `mail_reminders.attention_count` keeps the attention count only.

Example (attention 0, one critical item):

```
[Todofy System] 运维：1 项需要关注

运维（仪表盘报告，生成于 2026-09-29T23:40:00Z）：
- critical · mail-hero · endpoint_blocked · 自 2026-09-29T10:02:11Z · current_blocked=1, waiting_deliveries=3
查看仪表盘：https://home.example.com/

此提醒每个 UTC 日最多创建一次。
```

### 3.9 Tests (Todofy)

- `tests/unit/test_ops_contract.py` (exists): reference-validator verdicts, keyword subset.
- `tests/unit/test_mail_hero_compat.py` (updated): `canary_event` accepted and rendered; only it carries
  the marker; unreadable markers fail the schema. Add: `parse_mail_event` returns `canary_run_id` for it
  and raises `ContractError("canary")` for the unreadable ones.
- `tests/unit/test_ops_core.py` (new, host): validation rules, signal/health derivation, digest item
  selection; every value validated with `jsonschema` against its `$defs` entry.
- `tests/unit/test_reminder_text.py`: the Go goldens unchanged without ops; new goldens
  `tests/unit/golden/reminder_ops_only.txt`, `reminder_attention_and_ops.txt` built from
  `contracts/ops-v1/fixtures/OpsReport/daily.json`; the text contains no character outside the report's
  codes, numbers and URLs.
- `tests/unit/test_schema_sql.py`: re-checks the changed statements automatically.
- `tests/runtime/`: an `ops_probe` Worker (JS, never shipped, like `clients_probe`) with a service
  binding `{service = "todofy", entrypoint = "Ops"}` exposing the four methods over loopback HTTP to
  pytest; scenarios: `status()` validates (`OpsStatus`) in normal, paused, maintenance and shed states;
  canary fixture posted → `canaryResult` `ok`, zero Todoist fake requests, no `summaries` row, absent from
  `/api/v1/events` and the Overview counts, absent from the reminder, `daily_metrics` unchanged; Gemini
  fake failing → `failed` with its code after 3 attempts; `PROCESSING_PAUSED` → `processing` /
  `processing_paused`, never failed; ops-only day → exactly one Todoist reminder task with the golden
  text, a second report the same day → still one task; shed defers retention/metrics/backup and they run
  after `setGuard(normal)`; `test_scenarios_webhook.py` keeps posting every fixture (the canary one now
  ends `complete` without a task).

## 3c. The watch app (added 2026-10-01, additive)

The watch app (`watch/`, Worker `watch`, `watch/docs/design.md` §7) joined after Mail Hero and Todofy. `OpsStatus.app` became an open
list first (its own change, so this one is compatible: `proto/tools/profile_breaking.py` refuses a new name in a closed
list), then gained `watch`; fixtures `OpsStatus/watch-ok.json`, `OpsStatus/watch-degraded.json` and
`GuardState/shed-watch.json`. Nothing of the other apps' surface changed; the dashboard binds `WATCH`.

- Files: `watch/worker/src/ops.ts` (the entrypoint, forwards to `WatchState`), `watch/worker/src/ops-status.ts` (status
  and guard over the object's SQLite). No D1. Rows read per `status()`: the watches (at most 50), the new changes
  through the `changes_state` index (counted up to 1,000), the undelivered events through the partial index
  `notifications_pending` (at most 500), the Todofy sink's unsettled intents, those ended badly in a week and those
  recorded today (three indexed counts) and a few meta rows: 1,709 at those bounds, held to 1,750
  (`STATUS_ROWS_MAX`, `watch/worker/test/runtime/ops.test.ts`), so 48 calls a day read at most 84,000. Its one write:
  when WatchState has no alarm set it arms one, so the dashboard's tick restarts a lost scheduler.
- Counters: `watches_active`, `watches_paused`, `watches_broken`, `watches_failing`, `changes_new`, `fetches_today`,
  `notifications_pending`, `intents_open`, `intents_sent_today`. Signals: `watches_broken`, `scheduler_stale`,
  `notify_unsettled` (warning), `guard_shed` (info). Never a watch's name, URL, page text or a diff.
- Guard: a shed defers `scheduled_checks` (a scheduled check waits until the watch's last check is a day old, so
  every watch is still checked daily) and `daily_sweep` (the sweep of every watch's bounds waits for the shed's end).
  An owner's check, a pending change's confirmation, previews, the owner API and the notifications to Todofy are never
  deferred.

## 3b. The move onto proto/ (2026-10-01, no wire change)

The contract's source of truth became the IDL [`proto/ops/v1/ops.proto`](../../proto/ops/v1/ops.proto)
(package `ops.v1`; services `OpsService`, `CanaryProducerService`, `CanaryConsumerService`,
`OpsDigestService`), with the value rules as `common.wire.v1` options ([proto/README.md "Value
rules"](../../proto/README.md#value-rules)). `ops-v1.schema.json` is generated from it; the hand-written
schema is frozen in `legacy/` for the rollout checks.

| App | Before | After |
| --- | --- | --- |
| Mail Hero | `ops.ts` `implements MailHeroOps`; answers built as objects, checked by `validate.mjs` in tests | `implements ops.OpsService, ops.CanaryProducerService` (`ops_wire.ts`); `ops-core.ts` builds generated messages and writes them with `toWire`; `ops-guard.ts` reads `setGuard` input with `fromWireArguments` |
| Todofy core | `core/ops.py` hand-written rules, `jsonschema` in tests | `ops_pb` messages written with `to_wire`, inputs read strictly; the enums of `OpsError`/`Severity` derived from the generated ones |
| Todofy gateway | `implements TodofyOps` | `implements` the generated services (types only, no runtime code added) |
| Dashboard | `validate.mjs` + schema on every answer, `declared-methods.ts` parsed `ops-v1.ts` | `ops-client.ts` reads every answer with a lenient codec read, which refuses a new value of a closed enum and a null REQUIRED enum or message (both stated in the IDL); inputs go out through a strict read; methods and code lists from the generated services and enums |

Wire bytes: the golden tests (`mail-hero/cloudflare/test/ops-golden.test.mjs`,
`todofy/tests/unit/test_ops_golden.py`, `dashboard/worker/test/ops-golden.test.ts`) were written by the code before
the move and pass unchanged after it; every app writes field order.

Rollout: no order is required. Every answer of a new app passes the legacy schema (the golden tests
check it), so a dashboard deployed before the move keeps working; and a new dashboard reads the answers
of an app deployed before the move (the same bytes, and the dashboard's golden reads every fixture and
the newer variants). A rollback of any one Worker is safe in both directions for the same reasons.

## 4. Risks and open points

- A consumer other than Todofy behind Mail Hero's default endpoint may act on canaries; the dashboard
  gates on `canary_consumer`, but only Todofy can advertise it. Document for any other consumer.
- A Mail Hero rollback to a release without canary support leaves stored canary messages; an owner's
  manual "resend as new event" of one during that window would lose the marker. Automatic retries reuse
  the frozen bytes and keep it.
- A Todofy rollback to a core without canary handling is **not** side-effect free. The old parser ignores
  the unknown `canary` field and its SQL has no canary filter, so a canary row still active in the ledger
  (for example waiting for a Gemini retry) or a canary event Mail Hero is still retrying (auto retry
  mode, up to 48 attempts over 7 days) is summarized into a real Todoist task and listed as real mail;
  the current release only marks such rows `canary_side_effect_blocked` afterwards. Before rolling
  Todofy back: stop the dashboard's canaries, then either wait until `canaryResult` is terminal for every
  recent canary and `canaryDelivery` is no longer `pending`/`paused` for any of them, or set Mail Hero's
  `FORCE_SEND_PAUSED` and Todofy's `PROCESSING_PAUSED` first and keep them until the canary rows are
  cancelled or completed on the new release.
- `status()` reads the same partial-index ranges as the 10-minute alert pass; polling every 10 minutes
  at most doubles those reads. If the unsettled range ever grows large (a long outage), both grow
  together; the dashboard may back off to 30 minutes when `health` is `degraded`.
- Whether a service-binding call counts as a request of the callee on Workers Free is to be checked
  against Cloudflare's current pricing page when the dashboard is built (not verified here); at the
  documented polling rate it is under 400 calls a day per app either way.


## Fleet and the VPS Newsletter monitor (2026-10-02, additive)

Worker `fleet` exports `Ops` (app `fleet`) and `NewsletterOps` (app `newsletter`). Home binds
`FLEET` and `NEWSLETTER` respectively; the second is an explicit external status provider for the
VPS application, rather than a second Newsletter Worker. Both expose `status()` only for practical
use, advertise no capabilities, and return `invalid_input` for `setGuard`. Home never forwards
guard writes to either binding.

`FleetState` reads a single latest signed host report. It computes freshness at read time and leaves
never-seen, stale and missing observations degraded. Replaying identical latest bytes does not
refresh the receive timestamp. Counters from stale business observations are omitted; unknown
counts remain unknown rather than guessed as zero. A recent healthy process without current
generic runtime evidence cannot make Newsletter or its release healthy.

The generic runtime message comes from `proto/platform/runtime/v1`; it carries independent desired
and actual release identities. Fleet imports that message rather than creating a second release
DTO. `deployment_pending` includes an unverified/missing release daemon. Process health and a
verified running image do not prove a model, Notion write or mail operation succeeded.

Fleet counters: `heartbeat_age_seconds`, optional `disk_used_percent`, `memory_used_percent`.
Newsletter counters: `heartbeat_age_seconds`, optional `queued_count`, `inflight_count`,
`unknown_count`. Only fresh metadata is projected. `last_backup_at` stays null: no backup is
inferred from a healthy heartbeat.

## Newsletter outcome signals (2026-10-05, additive)

Newsletter warnings mean the owner has to act. `newsletter_unknown` keeps its metrics and the
`unknown_<kind>` counters but is info. Records that may hide a real email, packet or Notion write
(`delivery`, `packets`, `notion_entities`, `notion_versions`; every record for an unclassified legacy
report) raise `newsletter_side_effect_unknown` with `count` and, when reported, `unknown_revision`;
interrupted activities and workflow attempts alone never warn. Neither marks Newsletter degraded.
Home keys dismissal of either code on the revision, so only new records reopen it (a new record of
any kind bumps it). `newsletter_delivery_overdue` (`since` = the latest delivery time) covers the
daily 07:00 America/Los_Angeles send: no delivery evidence, the latest accepted delivery older than
28 h (24 h, 1 h DST, the 2 h 05 min job deadline and a margin), or the latest still unknown after
2.5 h. A latest rejection raises only
`newsletter_delivery_rejected`. The host report proto and `fleet-report-v1` bytes are unchanged.
