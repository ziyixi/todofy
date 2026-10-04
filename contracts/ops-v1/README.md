# `ops-v1`: personal-cloud operations contracts

A small, typed RPC surface on each app so that one dashboard Worker (`home`, in
[`dashboard/`](../../dashboard/)) can show health, run a daily end-to-end canary, apply quota guardrails and hand a
single ops digest to Todofy's daily reminder. It is a contract between each app and that dashboard;
the two apps still never call or import each other.

The source of truth is the IDL [`proto/ops/v1/ops.proto`](../../proto/ops/v1/ops.proto): its services
are the methods, its messages and enums the values, and its `common.wire.v1` options every value rule
(formats, allowed codes, sizes, bounds, which fields a state requires or forbids; [proto/README.md "Value
rules"](../../proto/README.md#value-rules)). Every producer and the dashboard read and write ops-v1 with
the code generated from it and the wire JSON codec (`proto/ts/wire-json.ts`,
`ziyixi_proto.wire_json`), which checks those rules on every read and every write, so a value that
breaks the contract never leaves an app. The bytes on the wire are the ones of the hand-written
contract this replaced (each app's golden test, below).

| File | Purpose |
| --- | --- |
| [`proto/ops/v1/ops.proto`](../../proto/ops/v1/ops.proto) | The contract: services, messages, enums and value rules |
| `ops-v1.schema.json` | JSON Schema 2020-12 **generated** from the IDL (`proto/tools/gen_schema.py`), one `$defs` entry per input and output (table below), per format and per enum; never edited by hand, `npm run check:schema` in `proto/` fails when stale. Kept for readers outside the monorepo and as the oracle the tests check the codec against. The names the hand-written schema had (`App`, `Counters`, `Metrics`, `Modes`, `OpsErrorCode`) still resolve, as aliases of what the IDL generates (`ALIASES` in `gen_schema.py`) |
| `ops-v1.ts` | `OPS_LIMITS`: the rules no codec can check (relative to a clock or to a whole message); the TS Workers import it by relative path, `todofy-core` keeps the same numbers |
| `legacy/ops-v1.schema.json` | The hand-written schema the dashboards deployed before the move validate answers with, frozen: the golden tests prove every answer still passes it (rollout) |
| `validate.mjs` | Dependency-free validator for the JSON Schema keywords the contracts use; Lab checks `task-intent-v1` with it at runtime, the golden tests check answers against the legacy schema with it |
| `fixtures/<Def>/*.json` | Valid examples of each input/output; `fixtures/invalid/<Def>/*.json` must fail |
| `IMPLEMENTATION.md` | Per app: files, migrations, guard keep/defer table, canary state machine, digest, query budgets, tests |

Checks (the `Contracts` CI job, `Proto checks`, and each app's own tests):

- `proto/test/ops.test.ts` and `proto/test/python/test_ops.py`: every valid fixture round-trips byte for
  byte through both codecs (strict and lenient reads), every invalid one is refused by a strict read,
  and a lenient read tolerates exactly what the consumer rules allow (an unknown field, a new code of
  an open list); `proto/test/cross-language.test.ts` compares the two languages on the same bytes.
- `todofy/tests/unit/test_ops_contract.py`: the generated schema gives every fixture the verdict of the
  reference validator (Python `jsonschema`) and the codec agrees with it; about 22,000 mutations of the
  valid fixtures get the same verdict from the generated and the legacy schema; the generated schema
  stays inside the keyword subset `validate.mjs` implements.
- Golden tests (`mail-hero/cloudflare/test/ops-golden.test.mjs`, `lab/worker/test/ops-golden.test.ts`,
  `todofy/tests/unit/test_ops_golden.py`, `dashboard/worker/test/ops-golden.test.ts`): the exact bytes
  each app answers (or the dashboard sends and keeps) for fixed synthetic state, written by the code
  before the move, and every one valid under the legacy schema. The watch app joined after the move
  (`watch/worker/test/ops-golden.test.ts`): its answers are held to the generated schema and to its own
  fixtures, not the legacy one, which no dashboard that binds it ever used.
- `dashboard/worker/test/ops-client.test.ts` checks the caller: only the methods of the generated
  services, every declared error code.

## Transport

Each app's TypeScript Worker exports a named `WorkerEntrypoint` class `Ops` (from `cloudflare:workers`)
next to its unchanged default handlers:

| App | Worker (script) | Exported from | Implementation |
| --- | --- | --- | --- |
| Mail Hero | `mail-hero` | `mail-hero/cloudflare/src/native/index.ts` | in the Worker; state in the `MailCoordinator` object |
| Todofy | `todofy` (the gateway) | `todofy/gateway/src/index.ts` | forwards to `TodofyCore` RPC methods in `todofy-core` |
| Lab | `lab` | `lab/worker/src/index.ts` | in the Worker; state in the `LabState` object (its own SQLite only) |
| the watch app | `watch` | `watch/worker/src/index.ts` | in the Worker; state in the `WatchState` object (its own SQLite only) |
| Fleet | `fleet` | `fleet/worker/src/index.ts` (`Ops`) | read-only receipt projection in `FleetState` SQLite |
| Newsletter | `fleet` | `fleet/worker/src/index.ts` (`NewsletterOps`) | independently observed VPS process/release metadata; no VPS command surface |

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

[[services]]
binding = "LAB"
service = "lab"
entrypoint = "Ops"

[[services]]
binding = "WATCH"
service = "watch"
entrypoint = "Ops"
```

The method signatures are the generated services' wire types (`@ziyixi/proto/ops/v1/ops_wire`, types
only): `OpsService` on every app, `CanaryProducerService` on Mail Hero, `CanaryConsumerService` and
`OpsDigestService` on Todofy. An app's `Ops` class `implements` them; the dashboard types its bindings
with them:

```ts
import type * as ops from '@ziyixi/proto/ops/v1/ops_wire';
interface MailHeroOpsEntrypoint extends Rpc.WorkerEntrypointBranded, ops.OpsService, ops.CanaryProducerService {}
interface TodofyOpsEntrypoint extends Rpc.WorkerEntrypointBranded, ops.OpsService, ops.CanaryConsumerService, ops.OpsDigestService {}
interface Env { MAIL_HERO: Service<MailHeroOpsEntrypoint>; TODOFY: Service<TodofyOpsEntrypoint> }
```

`status()`, `canaryDelivery(eventId)` and `canaryResult(eventId)` take their request's fields as
positional arguments (`common.wire.v1.method.positional`), so the RPC calls are exactly the ones before
the IDL; `toWireArguments`/`fromWireArguments` convert them.

There is no new public HTTP route and no Access policy for this surface: a service binding can only be
created by a Worker deployed in the same Cloudflare account, which is the trust boundary (whoever can
deploy there can already read the D1 databases). The default `fetch`, `email` and `scheduled` handlers
keep their exact behaviour. RPC arguments and results are structured-clone values; this contract uses
only JSON values.

## Methods

| Method | App | Input (`$defs`) | Output (`$defs`) | Writes |
| --- | --- | --- | --- | --- |
| `status()` | every app | – | `OpsStatus` | none (an app may re-arm its own missing scheduler alarm, below) |
| `setGuard(input)` | every app | `SetGuardInput` | `GuardState` | the app's Durable Object storage |
| `startCanary(input)` | Mail Hero | `StartCanaryInput` | `StartCanaryResult` | one synthetic message and delivery (D1, R2) when queued |
| `canaryDelivery(eventId)` | Mail Hero | `EventId` | `CanaryDelivery` | none |
| `canaryResult(eventId)` | Todofy | `EventId` | `CanaryResult` | none |
| `reportOps(report)` | Todofy | `OpsReport` | `OpsReportReceipt` | Todofy's Durable Object storage |

**Errors.** A method rejects only with `new Error(code)` where `code` is an `ErrorCode` (`ops.v1.ErrorCode`; the
schema's `OpsErrorCode` is the same list under its earlier name)
(the message crosses RPC intact): `invalid_input` (the input fails the contract's rules or a rule below; do not
retry unchanged), `busy` (try again in a minute), `unavailable` (storage or an internal call failed; try
again later). Every expected outcome is a value (`paused`, `unavailable`, `not_seen`, ...). A caller
treats any other rejection (binding error, deploy in progress, an unknown method on an older release)
like `unavailable`.

**Content rule.** Outputs carry only codes, numbers, booleans, timestamps, event IDs, run IDs and the
apps' own UI URLs: never subjects, addresses, bodies, headers, attachment names, URLs of webhook
targets, tokens or remote response text. The outputs are closed (only the IDL's fields, numeric-only
metrics and counters, the `Code` format for every name and code), and the codec checks that on every
answer an app writes, so a leak fails before it leaves the app and a test catches it; each app's implementation tests seed mail and assert that none of its text appears.

### `status()`

A snapshot built only from bounded, indexed reads (per-app budget in `IMPLEMENTATION.md`); it writes no
data and never aggregates an unbounded table. The one write allowed: an app that schedules itself may re-arm
its own scheduler alarm when none is set (the watch app's `WatchState` does, so the dashboard's tick revives a
lost alarm; `IMPLEMENTATION.md` §3c). Poll it no more often than every 10 minutes
(`OPS_LIMITS.statusMinIntervalSeconds`).

- `health`: `down` when maintenance mode is on or the snapshot could not be read (signal
  `status_unavailable`, `counters` then empty); otherwise `degraded` when any signal is `warning` or
  `critical`; otherwise `ok` (`info` signals allowed).
- `modes`: booleans; `maintenance` always present. Mail Hero: `force_send_paused` (deployment variable),
  `send_paused` (owner switch), `forwarding` (mode forward with a current endpoint), `backup_active`.
  Todofy: `processing_paused`, `force_pause_todoist`, `reminder_enabled`, `backup_active`. Lab:
  `maintenance` (always false: Lab has no maintenance switch) and `ingest_paused` (the owner's pause of
  the daily pipeline, read from storage). The watch app: `maintenance` (always false: it has no maintenance switch)
  and `notifications` (its TODOFY binding is configured: the daily digest and urgent changes go to Todofy). A
  `status_unavailable` status has only the deployment variables (Mail Hero `maintenance`,
  `force_send_paused`; Todofy `maintenance`, `processing_paused`, `force_pause_todoist`,
  `reminder_enabled`); the keys read from storage (Mail Hero `send_paused`, `forwarding`,
  `backup_active`; Todofy `backup_active`) are then simply absent from the map: `modes` is a
  `map<string, bool>` whose only required key is `maintenance` (`required_keys` in the IDL).
- `guard`: the effective `GuardState` (below).
- `signals`: active conditions only, at most 16, sorted by severity (critical first) then code. `metrics`
  are numbers only; `since` when the app tracks the start of the episode.
- `counters`: numbers only, at most 32 keys; a counter the app could not read is left out.
- `last_backup_at`: the app's last complete backup, or null.
- `ui_url`: `https://<owner UI host>/`, or null when the Worker does not know its host.
- `capabilities`: what this release supports. Mail Hero `canary_producer`, `guard`; Todofy
  `canary_consumer`, `guard`, `ops_digest`; Lab `guard`; the watch app `guard`. The dashboard checks them before
  using a feature. Fleet and Newsletter monitoring expose no capabilities and never accept a quota guard mutation.

Signal codes (severity):

| App | Codes |
| --- | --- |
| every app | `maintenance_mode` (critical; never raised by Lab or the watch app), `guard_shed` (info, `seconds_left`), `status_unavailable` (critical) |
| Mail Hero | the alert signals of `alerts.ts` with their metrics: `capacity_70` (warning), `capacity_85`, `capacity_95`, `backup_stale`, `endpoint_blocked` (critical), `pending_stale`, `parse_failed`, `endpoint_paused`, `delivery_failed`, `policy_error` (warning); plus `force_send_paused`, `send_paused`, `ingest_quota_80` (warning), `forwarding_off`, `backup_active` (info) |
| Lab | `feed_stale` (warning, `hours`: no successful arXiv fetch for over 72 h), `neuron_cap_hit` (warning, `used`, `cap`: the daily Workers AI ceiling stopped AI work until 00:00 UTC), `send_unsettled` (warning, `count`: a send to Todofy failed or unknown for over 24 h) |
| watch | `watches_broken` (warning, `count`: watches failing their third check in a row or more), `scheduler_stale` (warning, `hours`: no scheduler pass for over 12 h while a watch is to be checked; no metric when none ever ran), `notify_unsettled` (warning, `open`, `failed`: a task intent whose tasks do not all exist 24 h after it was frozen; one Todofy reports failed; or one given up or refused in the last 7 days) |
| Todofy | `attention`, `due_backlog`, `processing_paused`, `todoist_paused`, `gemini_budget_80`, `backup_failed`, `reminder_failed`, `gtd_snapshot_stale` (warning, `age_hours`); `todoist_blocked`, `gemini_budget_95`, `backup_stale` (critical); `reminder_disabled`, `backup_disabled`, `backup_active`, `review_overdue` (info, `days`) |
| Fleet | `host_never_seen`, `host_stale`, `host_missing`, `daemon_k3s_inactive`, `daemon_k3s_failed`, `daemon_k3s_missing`, `daemon_k3s_unknown`, `daemon_k3s_activating`, `daemon_k3s_deactivating`, `daemon_cloudflared_inactive`, `daemon_cloudflared_failed`, `daemon_cloudflared_missing`, `daemon_cloudflared_unknown`, `daemon_cloudflared_activating`, `daemon_cloudflared_deactivating`, `daemon_ssh_inactive`, `daemon_ssh_failed`, `daemon_ssh_missing`, `daemon_ssh_unknown`, `daemon_ssh_activating`, `daemon_ssh_deactivating`, `daemon_cloudflared_platform_inactive`, `daemon_cloudflared_platform_failed`, `daemon_cloudflared_platform_missing`, `daemon_cloudflared_platform_unknown`, `daemon_cloudflared_platform_activating`, `daemon_cloudflared_platform_deactivating`, `cluster_degraded`, `cluster_unavailable`, `cluster_unknown`, `disk_high`, `memory_high`, `deployment_pending`, `release_held`, `release_failed`, `release_in_progress` (daemon failures, missing heartbeat, held/failed release critical; in-progress release info; other readiness/capacity conditions warning) |
| Newsletter | `host_never_seen`, `host_stale`, `host_missing`, `newsletter_unavailable` (critical), `newsletter_unknown` (warning), `newsletter_paused`, `newsletter_delivery_accepted` (info), `newsletter_delivery_rejected` (warning), `deployment_pending` (warning) |

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
  codes of the open lists `reason`/`waiting_code`, new `error_code`s documented here, and a new app. `OpsStatus.app`
  is an open list (since 2026-10-01, ahead of the watch app): a dashboard reads a status naming an app it was built
  without, and keeps only the answer of the app whose binding it called, so the list grows with the new app's
  `Ops` entrypoint and the dashboard's binding to it. They land in `ops.proto`
  together with the regenerated schema (`npm run schema` in `proto/`) and fixtures in one change;
  `buf breaking` and the wire profile check (`proto/tools/profile_breaking.py`) refuse a change that
  would alter the bytes of an existing field. Consumers ignore unknown fields and show unknown codes
  generically.
- Anything else (a removed or retyped field, a changed meaning, a new required input) is `ops-v2`: a new
  entrypoint class `OpsV2` and a new directory, served next to `Ops` until the dashboard moved. That includes
  a new value of any enum ops-v1 writes (`Health`, `Severity`, `GuardLevel`, each `State`): they are closed
  (`(common.wire.v1.closed)`), because the dashboard branches on every value, so every reader refuses an
  unknown one and `profile_breaking.py` refuses the change (`PROFILE_ENUM_CLOSED`). A changed value rule of an
  output (a format, a bound, a closed list) is refused too (`PROFILE_RULE_SAME`): older dashboards read newer
  apps' answers with the older rules and the other way round. Every REQUIRED enum and message is `non_null`:
  never null on the wire, on any read or write.
- `mail.received.v1`'s optional `canary` marker is part of that contract (`contracts/mail-received-v1`).

| Bound | Value |
| --- | --- |
| Guard `until` ahead of now | ≤ 36 h |
| Digest window of a stored report | 36 h |
| Report items / report size | ≤ 20 / ≤ 8 KiB compact JSON |
| Signals / metrics per signal or item / modes / counters / capabilities | ≤ 16 / 12 / 12 / 32 / 16 |
| `status()` polling | ≥ 10 min apart |
| D1 statements per call | `status()` Mail Hero ≤ 6, Todofy ≤ 5; `canaryDelivery`/`canaryResult` 1; `setGuard`/`reportOps` 0; `startCanary` ≤ 2 reads, plus the synthetic delivery's writes when queued |
