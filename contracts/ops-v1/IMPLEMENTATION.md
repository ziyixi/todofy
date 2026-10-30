# ops-v1 adapter reference

The [contract](README.md) defines RPC and wire semantics; this file records each producer's bounded reads,
reported counters and deferrable work. IDL and generated codecs live in
[`proto/ops/v1`](../../proto/ops/v1/ops.proto). Entry points use same-account service bindings, with no public Ops
route. Each application owns its storage, tests and release.

## 2. Mail Hero

Sources: `mail-hero/cloudflare/src/native/ops.ts`, `ops-core.ts`, `ops-guard.ts`, `coordinator.ts` and `pipeline.ts`.
The guard and last completed deferrable-job times live in MailCoordinator SQLite, outside D1 and backups.
Losing the object state yields a normal guard and jobs that may run now.

### 2.4 Status and query budget

`status()` makes at most six D1 statements and one coordinator request:

| Read | Bound |
| --- | --- |
| `alertSnapshot` | Five indexed reads of settings/current endpoint, live unsettled mail and delivery queues; no history scan |
| Active alert episodes | At most 16 rows, with their current `active_since` |
| Coordinator | Pending/failed jobs, capacity totals, today's bounded ingress reservations, backup lease and guard |

Counters: `jobs_pending`, `jobs_failed`, `parse_failed`, `delivery_failed`, `policy_error`, `blocked_waiting`,
`paused_waiting`, `oldest_pending_age_seconds`, `capacity_used_bytes`, `capacity_limit_bytes`, `logical_bytes`,
`ingest_today_messages`, `ingest_today_bytes`, `ingest_limit_messages`, `ingest_limit_bytes`.
`last_backup_at` is the last complete backup. Capabilities are `canary_producer` and `guard`.
A failed snapshot produces `status_unavailable`, empty counters and only deployment-derived modes.

### 2.5 Guard: keep or defer

`raw_reconcile`, `lifecycle_retention` and `canary_cleanup` may defer for at most 48 hours since their last
complete pass. A multi-page raw scan or retention backlog keeps its normal cadence once due; a partial batch does
not restart that bound. `GuardState.deferred` lists exactly these three jobs while shed.

Intake, parsing, delivery/retries, route-block rechecks, capacity reconciliation, pending owner deletion,
integrity repair, alert evaluation, backup receipts and lease handling continue. Deferral never moves the
maintenance phase cycle or strands accepted mail.

### 2.6 Canary

`startCanary` validates `run_id`, then looks up `canary:<run_id>` before checking pause or maintenance. An existing
run returns its original event ID even if those modes changed. Otherwise it reads the current default endpoint and
revision, applies the contract's pause/block/capacity checks, and asks the coordinator to create one synthetic
message and automatic delivery. There are at most two D1 reads before writes. Backup holds return
`unavailable/backup_active`.

The action ID fixes the message identity; delivery freezes its event identity, target revision and bytes.
An owner resend of a canary message retains its marker. A connection-test event remains distinct and carries no
canary marker. `canaryDelivery` uses one indexed event lookup with endpoint/revision state and the latest attempt;
it returns the effective paused/pending state, rather than treating a held delivery as failed.

Canary cleanup uses the indexed live-canary range, at most one message per pass, and the normal content-deletion
path. It removes content after seven days only when no delivery remains pending, retrying or sending.
Golden fixtures, real-binding tests and CPU/read-bound checks live in Mail Hero's `:check` closure.

## 3. Todofy

Sources: `todofy/gateway/src/ops.ts`, `worker/todofy/runtime/ops.py`, `core/ops.py` and `runtime/coordinator.py`.
The gateway forwards the generated services to TodofyCore. The object stores only the guard and last completed
job times; structured RPC inputs cross as JSON text, and the core returns a value or a bounded error code.
Todofy creates no Tasks tasks and implements no `reportOps`/digest service.

`status()` runs one batch of five bounded D1 reads: `ACTIVE_COUNTS`, `ATTENTION_COUNT`, `RECEIVED_SINCE`,
`OLDEST_DUE` and `mailbox.PENDING_BETWEEN`. Object storage supplies usage, backup and guard facts.
Counters: `active_events`, `attention_events`, `received_24h`, `oldest_due_age_seconds`, `carryover_open`,
`gemini_used_tokens`, `gemini_reserved_tokens`, `gemini_token_budget`, `gemini_calls` and `backup_age_seconds`.
The `gemini_*` names are the existing wire counters. Capabilities are `canary_consumer` and `guard`; modes are
`maintenance`, `processing_paused` and `backup_active`.

A shed may defer a new weekly backup until the last complete backup is 7.5 days old, and retention/metrics-rollup
until 72 hours since a completed pass. Already-running backups and incomplete cleanup/rollup passes continue.
Intake, real-mail processing, canaries, integrity recovery, report precomputation and scheduling continue.
Ending shed makes deferred jobs due again. `GuardState.deferred` is `weekly_backup`, `retention`, `metrics_rollup`.

A canary takes the normal model-summary step, consumes its real budget and ends `complete` or `ignored`; transient
failures retry up to three attempts. Its summary never enters reports or the mailbox. Canary rows remain excluded
from real-mail counts, owner lists, attention and analytics. `canaryResult` uses one primary-key read; unknown or
non-canary IDs return `not_seen`. Pauses and retry waits remain `processing` with the waiting code. The result is
keyed by event ID, including after restore.

Unit/golden tests and real workerd scenarios in `//todofy:check` preserve these exclusions, guard bounds and bytes.

## 3c. Watch

Sources: `watch/worker/src/ops.ts` and `ops-status.ts`, over WatchState SQLite; no D1.
`status()` reads at most 50 watches, 1,000 new changes, 500 pending notifications, indexed TaskInbox delivery counts
and bounded meta/backup facts. The runtime read meter holds it to 1,750 rows. It re-arms a missing scheduler alarm.

Counters: `watches_active`, `watches_paused`, `watches_broken`, `watches_failing`, `changes_new`, `fetches_today`,
`notifications_pending`, `intents_open`, `intents_sent_today`, and `backup_age_seconds` once known. Backup stale
means three days without a complete backup, counted from the first backup step when none exists.

A shed defers `scheduled_checks` only until each watch's last check is a day old, and defers `daily_sweep` until the
guard ends. Owner checks, pending-change confirmation, previews, owner APIs and notifications to Tasks continue.
No name, URL, page text or diff leaves through Ops.

## 3d. Mailsort

Sources: `mailsort/worker/src/ops.ts` and `ops-status.ts`, over MailsortState SQLite and backup facts.
Reads are bounded meta/usage records and indexed pending/review counts. A missing alarm is re-armed and a nearer
backup deadline advances it.

Capabilities are empty and the effective guard is always normal. Shed requests return `invalid_input`;
legacy normal requests clear stored guard fields when writes are allowed. No current provider work is deferred.
Old Clef-era fixtures remain frozen compatibility inputs, not the current provider policy.

Counters: `decided_today`, `applied_today`, `unsure_today`, `review_pending`, `pending`, `gmail_calls_today`,
`last_sync_minutes` once known, `claude_spent_usd`, `claude_monthly_limit_usd`, `claude_input_tokens`,
`claude_cache_write_tokens`, `claude_cache_read_tokens`, `claude_output_tokens`, optional `claude_thinking_tokens`,
and backup counters. Claude spend is observed even when another provider is selected.

Gmail auth/configuration/freshness and backup signals remain separate from the selected provider's failure.
Provider signals use `<provider>_not_configured`, `<provider>_auth` or `<provider>_unavailable`; Codex can report
`codex_quota`, and Claude's budget reports `claude_spend_limit`. No mail subject, sender or label name is returned.

## 3e. Recall

Sources: `recall/worker/src/ops.ts` and `ops-status.ts`, over RecallState SQLite. Reads cover devices, at most eight
consumers' oldest unarchived changes through indexes, a week of usage and bounded meta rows. They do not count the
archive backlog. A missing alarm is re-armed; these reads count toward Recall's daily read budget.

Counters: `visits_today`, `texts_today`, `rows_written_today`, `rows_read_today`. Archive signals describe Recall's
own Dropbox writer. Capabilities are empty and guard writes are refused. No URL, host, title or text is returned.

## 3g. Tasks

`tasks/worker/src/ops.ts` runs one batch of three D1 reads: newest change, newest GTD-day rows and weekly-review
creation/completion. TaskJobs supplies backup facts and re-arms or advances its alarm when needed.

Counters: `database_ready`, `change_sequence`, available `inbox_open`, `inbox_oldest_days`, `overdue`, `completed_7d`,
`review_age_days`, `backup_age_seconds`. Backup stale means eight days without a complete weekly backup, counted
from its first step when none exists. Other signals are `gtd_stale`, `backup_failed` and `review_overdue`.
There is no guard capability; `maintenance` is false. Runtime Ops/jobs/backup tests cover the adapter.

## 3h. Personal MCP

`personal-mcp/worker/src/ops.ts` reads SubscriptionStore's bounded subscription, delivery, source and Work counts,
plus backup/restore facts. Reading re-arms a missing alarm or brings it forward to a nearer backup deadline.

Counters: `active_subscriptions`, `pending_deliveries`, `accepted_deliveries`, `failed_deliveries`, `open_work`,
`waiting_work`, `unhandled_work_reports`, bounded `last_*_ms` times and `backup_age_seconds` once known.
Backup stale means three days without completion. An unfinished restore sets maintenance/down; backup and restore
signals are app-only. There is no guard capability. No subscription content is returned.

## 3i. Links

Sources: `links/worker/src/ops.ts` and `ops-status.ts`. `status()` checks one D1 row and the backup's `state.json`,
then arms the backup object's alarm. D1 failure is `status_unavailable`; bucket failure is `backup_failed`.
Counters are `database_ready` and known `backup_age_seconds`. Backup stale means three days without completion.
There is no guard capability; `maintenance` is false. `ui_url` names the `/_/` launcher. No link key, target or
inventory count is returned. Golden and real-binding backup tests protect the adapter.

## Fleet, Newsletter and Codex gateway

`fleet/worker/src/ops.ts` exports `Ops`, `NewsletterOps` and `CodexGatewayOps`, bound by Home to `FLEET`, `NEWSLETTER`
and `CODEX_GATEWAY`. Each reads FleetState's latest signed host observation; none controls a VPS or accepts a guard.
Replaying the same receipt never refreshes its receive time. Stale business counters are omitted and unavailable
counts remain unknown.

The embedded `platform.runtime.v1` message keeps desired and verified physical release identities separate.
A recent receipt or healthy process does not prove model execution, a Notion write or email delivery.
Fleet reports heartbeat and available capacity counters; Newsletter adds fresh queue/in-flight/unknown counts.
`last_backup_at` remains null unless an actual backup observation exists.

Newsletter unknown records warn only for delivery/packet/Notion side effects. Interrupted activities alone remain
informational. `unknown_revision` keys dismissal, so reducing a count does not reopen an incident. Delivery is
independently overdue after 28 hours without accepted evidence, or 2.5 hours while the latest send is unknown;
a rejected latest send reports `newsletter_delivery_rejected`. These observations never authorize an uncertain retry.

## Model Router

`model-router/worker/src/ops.ts` reads today's indexed request counts, running requests older than 15 minutes in a
bounded two-day window, and RouterEngine backup facts. Counters are `requests_today`, `succeeded_today`,
`failed_today`, `interrupted` (the still-running count) and known `backup_age_seconds`. Capabilities are empty;
shed is refused and normal returns normal. The maintenance/health mismatch is documented in the contract README
and tracked in HANDOFF; this reference does not change that implementation.

## Checks and compatibility

`//proto:check` checks shared codec/Schema/fixture behavior. Producer and Home `:check` roots include their own
golden, runtime, query-bound and CPU checks. CI follows those declared dependencies. Legacy schemas and fixtures
remain frozen; new current fixtures are reviewed with their producers and consumers. Baseline compatibility uses
`bazel run //proto:breaking -- BASE`, including retirement and wire-profile rules.
