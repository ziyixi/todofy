# `ops-v1`: the operations surface of Mail Hero and Todofy

A small, typed RPC surface on each app so that one dashboard Worker (`home`, in
[`dashboard/`](../../dashboard/)) can show health, run a daily end-to-end canary, apply quota guardrails and hand a
single ops digest to Todofy's daily reminder. It is a contract between each app and that dashboard;
the two apps still never call or import each other.

| File | Purpose |
| --- | --- |
| `ops-v1.schema.json` | JSON Schema 2020-12, one `$defs` entry per input and output (table below) |
| `ops-v1.ts` | Dependency-free TypeScript types and bounds; the TS Workers import it by relative path |
| `validate.mjs` | Dependency-free validator for exactly the schema keywords used here (TS Workers' tests, the dashboard) |
| `fixtures/<Def>/*.json` | Valid examples of each input/output; `fixtures/invalid/<Def>/*.json` must fail |
| `IMPLEMENTATION.md` | Per app: files, migrations, guard keep/defer table, canary state machine, digest, query budgets, tests |

Checks (the `Contracts` CI job, and each app's own tests): `mail-hero/cloudflare/test/ops-contract.test.mjs`
runs `validate.mjs` over every fixture and compares the constants of `ops-v1.ts` with the schema;
`todofy/tests/unit/test_ops_contract.py` gives every fixture the verdict of the reference validator
(Python `jsonschema`) and keeps the schema inside the keyword subset `validate.mjs` implements;
`dashboard/worker/test/ops-client.test.ts` checks the caller: only declared methods, every declared
error code.

## Transport

Each app's TypeScript Worker exports a named `WorkerEntrypoint` class `Ops` (from `cloudflare:workers`)
next to its unchanged default handlers:

| App | Worker (script) | Exported from | Implementation |
| --- | --- | --- | --- |
| Mail Hero | `mail-hero` | `mail-hero/cloudflare/src/native/index.ts` | in the Worker; state in the `MailCoordinator` object |
| Todofy | `todofy` (the gateway) | `todofy/gateway/src/index.ts` | forwards to `TodofyCore` RPC methods in `todofy-core` |

The dashboard binds them with service bindings:

```toml
[[services]]
binding = "MAIL_HERO"
service = "mail-hero"
entrypoint = "Ops"

[[services]]
binding = "TODOFY"
service = "todofy"
entrypoint = "Ops"
```

```ts
import type { MailHeroOps, TodofyOps } from '<relative path>/contracts/ops-v1/ops-v1.ts';
interface MailHeroOpsEntrypoint extends Rpc.WorkerEntrypointBranded, MailHeroOps {}
interface TodofyOpsEntrypoint extends Rpc.WorkerEntrypointBranded, TodofyOps {}
interface Env { MAIL_HERO: Service<MailHeroOpsEntrypoint>; TODOFY: Service<TodofyOpsEntrypoint> }
```

There is no new public HTTP route and no Access policy for this surface: a service binding can only be
created by a Worker deployed in the same Cloudflare account, which is the trust boundary (whoever can
deploy there can already read the D1 databases). The default `fetch`, `email` and `scheduled` handlers
keep their exact behaviour. RPC arguments and results are structured-clone values; this contract uses
only JSON values.

## Methods

| Method | App | Input (`$defs`) | Output (`$defs`) | Writes |
| --- | --- | --- | --- | --- |
| `status()` | both | – | `OpsStatus` | none |
| `setGuard(input)` | both | `SetGuardInput` | `GuardState` | the app's Durable Object storage |
| `startCanary(input)` | Mail Hero | `StartCanaryInput` | `StartCanaryResult` | one synthetic message and delivery (D1, R2) when queued |
| `canaryDelivery(eventId)` | Mail Hero | `EventId` | `CanaryDelivery` | none |
| `canaryResult(eventId)` | Todofy | `EventId` | `CanaryResult` | none |
| `reportOps(report)` | Todofy | `OpsReport` | `OpsReportReceipt` | Todofy's Durable Object storage |

**Errors.** A method rejects only with `new Error(code)` where `code` is an `OpsErrorCode`
(the message crosses RPC intact): `invalid_input` (the input fails the schema or a rule below; do not
retry unchanged), `busy` (try again in a minute), `unavailable` (storage or an internal call failed; try
again later). Every expected outcome is a value (`paused`, `unavailable`, `not_seen`, ...). A caller
treats any other rejection (binding error, deploy in progress, an unknown method on an older release)
like `unavailable`.

**Content rule.** Outputs carry only codes, numbers, booleans, timestamps, event IDs, run IDs and the
apps' own UI URLs: never subjects, addresses, bodies, headers, attachment names, URLs of webhook
targets, tokens or remote response text. The output schemas are closed (`additionalProperties: false`,
numeric-only metrics and counters, `Code` pattern for every name) so that a test validating an output
catches a leak; each app's implementation tests seed mail and assert that none of its text appears.

### `status()`

A snapshot built only from bounded, indexed reads (per-app budget in `IMPLEMENTATION.md`); it never
writes and never aggregates a whole table. Poll it no more often than every 10 minutes
(`OPS_LIMITS.statusMinIntervalSeconds`).

- `health`: `down` when maintenance mode is on or the snapshot could not be read (signal
  `status_unavailable`, `counters` then empty); otherwise `degraded` when any signal is `warning` or
  `critical`; otherwise `ok` (`info` signals allowed).
- `modes`: booleans; `maintenance` always present. Mail Hero: `force_send_paused` (deployment variable),
  `send_paused` (owner switch), `forwarding` (mode forward with a current endpoint), `backup_active`.
  Todofy: `processing_paused`, `force_pause_todoist`, `reminder_enabled`, `backup_active`. A
  `status_unavailable` status has only the deployment variables (Mail Hero `maintenance`,
  `force_send_paused`; Todofy `maintenance`, `processing_paused`, `force_pause_todoist`,
  `reminder_enabled`); the keys read from storage (Mail Hero `send_paused`, `forwarding`,
  `backup_active`; Todofy `backup_active`) are left out, so they are optional in `ops-v1.ts`.
- `guard`: the effective `GuardState` (below).
- `signals`: active conditions only, at most 16, sorted by severity (critical first) then code. `metrics`
  are numbers only; `since` when the app tracks the start of the episode.
- `counters`: numbers only, at most 32 keys; a counter the app could not read is left out.
- `last_backup_at`: the app's last complete backup, or null.
- `ui_url`: `https://<owner UI host>/`, or null when the Worker does not know its host.
- `capabilities`: what this release supports. Mail Hero `canary_producer`, `guard`; Todofy
  `canary_consumer`, `guard`, `ops_digest`. The dashboard checks them before using a feature.

Signal codes (severity):

| App | Codes |
| --- | --- |
| both | `maintenance_mode` (critical), `guard_shed` (info, `seconds_left`), `status_unavailable` (critical) |
| Mail Hero | the alert signals of `alerts.ts` with their metrics: `capacity_70` (warning), `capacity_85`, `capacity_95`, `backup_stale`, `endpoint_blocked` (critical), `pending_stale`, `parse_failed`, `endpoint_paused`, `delivery_failed`, `policy_error` (warning); plus `force_send_paused`, `send_paused`, `ingest_quota_80` (warning), `forwarding_off`, `backup_active` (info) |
| Todofy | `attention`, `due_backlog`, `processing_paused`, `todoist_paused`, `gemini_budget_80`, `backup_failed`, `reminder_failed` (warning); `todoist_blocked`, `gemini_budget_95`, `backup_stale` (critical); `reminder_disabled`, `backup_disabled`, `backup_active` (info) |

Counter names are listed per app in `IMPLEMENTATION.md`. New codes and counters may be added in ops-v1;
the dashboard shows unknown ones generically.

### `setGuard(input)` → `GuardState`

`{level: "shed", reason, until}` asks the app to defer deferrable background work until `until`;
`{level: "normal", reason, until: null}` ends it. `reason` is a code chosen by the caller (for example
`d1_reads_high`); `until` must be in the future and at most 36 hours ahead of the app's clock
(`OPS_LIMITS.guardMaxAheadSeconds`), otherwise `invalid_input`.

- Idempotent: the same level, reason and until as stored returns the stored state unchanged (same
  `set_at`). Anything else replaces it (last writer wins; the dashboard is the only writer).
- Persisted in the app's own Durable Object storage (not D1, not in backups). Losing it reads as
  `normal`, the safe default.
- Auto-expiry: the effective level is `shed` only while `now < until`; no alarm is needed. An expired or
  normal guard reads `{level: "normal", reason: null, until: null, set_at: null, deferred: []}`.
- `deferred` lists the job codes that shed defers in this app. **Shed never stops** ingest, parsing,
  webhook intake, delivery or its retries, Gemini/Todoist processing of real mail, the canary,
  schedule-keeping alarms, integrity repair, the daily reminder/digest or alert evaluation. Each deferred
  job still runs when its own bound is reached (a guard renewed forever cannot starve it), and the bound
  covers the whole job: once due, a job that works in pages or batches keeps its normal cadence until
  it has caught up, and only that complete run restarts its bound. The per-job table with reasons is in
  `IMPLEMENTATION.md`.

### `startCanary({run_id})` → `StartCanaryResult` (Mail Hero)

Creates one synthetic canary message (fixed text, `syntheticCanaryMail()` in `pipeline.ts`) and its
`mail.received.v1` delivery to the **current default endpoint**, carrying the top-level
`"canary": {"run_id": ...}` marker (`contracts/mail-received-v1`). It uses the synthetic connection-test
path and the normal delivery path: frozen bytes, authentication, rate limits, retries and backoff.

- Idempotent per `run_id`: a second call returns the same `event_id` with `queued`, even if sending has
  been paused or maintenance turned on since (the one-row lookup runs before any other check).
- Nothing is queued silently. When sending would be held, nothing is created and the call returns
  `paused` with `send_paused` (`FORCE_SEND_PAUSED`), `settings_paused` (owner switch),
  `endpoint_paused` (endpoint paused or archived) or `endpoint_blocked` (current revision blocked). When
  it cannot run: `unavailable` with `maintenance`, `backup_active` (a backup snapshot holds writes),
  `no_endpoint` (archive mode or no current endpoint) or `capacity`. These may be retried with the same
  `run_id`.
- `run_id`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; recommended `canary-YYYY-MM-DD` (UTC), one run a day.
- Mail Hero cannot know whether the endpoint honours `canary`. Only call it when the consumer's
  `status().capabilities` contains `canary_consumer` (Todofy) or the endpoint is known to honour it.

### `canaryDelivery(eventId)` → `CanaryDelivery` (Mail Hero)

The delivery state of a canary event: `pending` (waiting or retrying; `error_code` is the last delivery
error such as `http_503`), `paused` (held: a pause, maintenance, or a block of the event's endpoint
revision that is not yet due for a recheck, the same holds that make `startCanary` answer `paused` and
the owner UI show the delivery paused; `error_code` is then the block code, e.g. `http_401`; a held run
is not a pipeline failure), `delivered` (`delivered_at`; the consumer
durably took it over), `failed` (`error_code`, e.g. `http_400`, `retry_window_expired`), or `unknown`
(no canary delivery has this ID; a real mail's event ID also reads `unknown`). `attempts` counts HTTP
attempts; `last_http_status` is the latest attempt's status when there was a response.

### `canaryResult(eventId)` → `CanaryResult` (Todofy)

What Todofy did with the canary: `not_seen` (no canary event with this ID; a real mail's event ID also
reads `not_seen`), `processing` (taken over, not finished; `waiting_code` `processing_paused`,
`maintenance`, `backup_active` or `retry_wait` when it is held, which is reported and never turned into a
failure), `ok` (the summary call answered and the result passed Todofy's validation; `completed_at`) or
`failed` (`completed_at`, `error_code` from Todofy's vocabulary, e.g. `llm_quota`,
`llm_budget_exhausted`). A canary never reaches Todoist, reports, the attention list or the reminder.

### `reportOps(report)` → `OpsReportReceipt` (Todofy)

Stores the dashboard's latest report: `generated_at`, up to 20 items `{source, code, severity, since,
metrics}` and an optional `dashboard_url`, at most 8 KiB as compact JSON. It replaces the stored report
unless the stored one has a later `generated_at` (then `stored: false` and the receipt describes the
stored one), so a retried older report cannot win. `generated_at` more than 5 minutes ahead of Todofy's
clock is `invalid_input`. An empty `items` list clears the ops section.

**Digest.** Todofy's daily attention reminder (at most one Todoist task per UTC day, frozen title and
body, existing retry rules) gains an ops section built from the stored report when its `generated_at`
is at most 36 hours old: the `warning` and `critical` items, critical first. Each report is listed by at
most one day's reminder. A day with ops items but no attention items still creates that day's one task,
from a report generated before that UTC day began (a report from the current day waits for the next
day's reminder unless mail needs attention first); there is never a second task on a day. The text holds
only sources, codes, severities, timestamps, numeric metrics and links (Todofy's owner UI, the
`dashboard_url`). Days without ops items keep today's exact title and body. Report at about 23:40 UTC so
the next UTC day's reminder carries it.

## Daily canary, end to end (for the dashboard)

1. `TODOFY.status()`; skip the run (report `canary_skipped`) unless `capabilities` has `canary_consumer`.
2. `MAIL_HERO.startCanary({run_id: "canary-" + UTC date})`. `paused`/`unavailable`: report it with its
   reason; do not treat it as a pipeline failure.
3. After about 15 minutes, `MAIL_HERO.canaryDelivery(event_id)`, then (once delivered)
   `TODOFY.canaryResult(event_id)`. Poll a few times at most (for example every 15 minutes for 2 hours).
4. Classify: `delivered` + `ok` is healthy; `pending` past the deadline, `failed`, or `delivered` +
   `failed`/`not_seen` becomes a report item; `paused`/`processing` with a `waiting_code` is a held run,
   not a failure.

## Versioning and bounds

- Additive changes stay `ops-v1`: new optional output fields, new signal/counter/capability codes, new
  enum values of `reason`/`waiting_code`/`error_code` documented here. They land together with the
  schema, `ops-v1.ts` and fixtures in one change. Consumers ignore unknown fields and show unknown codes
  generically.
- Anything else (a removed or retyped field, a changed meaning, a new required input) is `ops-v2`: a new
  entrypoint class `OpsV2` and a new directory, served next to `Ops` until the dashboard moved.
- `mail.received.v1`'s optional `canary` marker is part of that contract (`contracts/mail-received-v1`).

| Bound | Value |
| --- | --- |
| Guard `until` ahead of now | ≤ 36 h |
| Digest window of a stored report | 36 h |
| Report items / report size | ≤ 20 / ≤ 8 KiB compact JSON |
| Signals / metrics per signal or item / modes / counters / capabilities | ≤ 16 / 12 / 12 / 32 / 16 |
| `status()` polling | ≥ 10 min apart |
| D1 statements per call | `status()` Mail Hero ≤ 6, Todofy ≤ 5; `canaryDelivery`/`canaryResult` 1; `setGuard`/`reportOps` 0; `startCanary` ≤ 2 reads, plus the synthetic delivery's writes when queued |
