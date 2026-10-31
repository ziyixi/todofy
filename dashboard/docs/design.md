# Home dashboard: current design

Home is the owner's launcher and operational view. It reads application Ops contracts, Cloudflare usage and
resource/configuration observations; its scheduled work applies quota guards, advances a synthetic delivery canary
and creates a daily operational digest in Tasks. It imports shared contracts, proto runtimes and packages, never
another application's implementation.

Current bindings and static production configuration are in [`../wrangler.toml`](../wrangler.toml). Application
manifests, `registry.ts`, generated inventory and drift-desired metadata define the monitored graph. This document
covers runtime behavior; [setup](setup.md), [quota configuration](limits.md) and [verification](verification.md)
cover their separate responsibilities. [Dashboard state and operations](../../docs/dashboard-state.md) defines the
owner-facing meanings of Newsletter evidence, service controls and resource registration.

## 1. Layout and ownership

| Source | Responsibility |
| --- | --- |
| `worker/src/index.ts`, `http.ts` | Thin fetch/scheduled handlers, owner authentication, mutation-header checks and shared HTTP transcoding |
| `worker/src/state.ts` | SQLite HomeState, serialized operations, persisted observations and receipts |
| `worker/src/ops-client.ts` | Generated service calls, timeout/error mapping and wire validation |
| `worker/src/registry.ts`, `registry-types.ts`, `registry-check.ts` | Entries, Workers, resources, flow stages and their validation |
| `worker/src/usage.ts`, `discovery.ts`, `probe.ts`, `drift.ts` | Bounded provider reads and normalized observations |
| `worker/src/guard.ts`, `canary.ts`, `digest.ts`, `attention-state.ts` | Decisions, state machines and reminder disposition |
| `worker/src/views.ts`, `evaluate.ts`, `idl.ts` | Current view evaluation, typed wire output and IDL-derived bounds |
| `web/` | Chinese owner UI, generated client and same-origin transport |
| `proto/dashboard/ui/v1`, `proto/dashboard/mcp/v1` | Owner API and private cached-read contract |

Tool versions and workspace dependencies come from the root locks and Bazel module. Worker and UI consume
`@ziyixi/proto` and `@ziyixi/edge-auth` through declared workspace/Bazel dependencies.

## 2. Configuration and observations

Home has one SQLite-backed Durable Object, HomeState instance `home-v1`, static assets and a half-hour cron. It
has no D1 database or R2 bucket. Ops bindings address each producer's named entrypoint; `TASK_INBOX` is Tasks'
create-only service with source `home`. The website relay has a separate WebsiteSync contract. Fleet projects VPS
observations; Home does not command a VPS or use business APIs to infer success.

Static host, issuer, audience, account and schedule configuration belongs to Wrangler. The existing deployment
wrapper supplies validated operational switches, private identity values, the read-only analytics credential and
build identity. `CANARY_ENABLED=false` starts no new canary. Malformed switch input never starts one.
`DEV_AUTH_BYPASS` and `DEV_NOW` are local/test-only, absent from production configuration.

Registry entries own their tile/status sources; flow stages claim their signals and counters. A stage may be
unmonitored without making the flow healthy. Public probes use fixed registered paths, manual redirects and
status/media-type checks; Access login redirects cannot satisfy a public probe. The shipped UI receives public
registry data at runtime, not probe URLs, binding names or provider credentials in its bundle.

Current account inventory comes from REST observations, including idle Workers. Analytics-only retired scripts
remain historical usage, not current undeclared resources. Registry/inventory validation rejects missing ownership,
duplicate identities, invalid references and excess outbound work. Adding a producer updates its manifest/bindings,
registry and generated registration data in the same change; it does not add a CI path map.

## 3. State and serialization

HomeState creates its versioned SQLite schema in `blockConcurrencyWhile`. Times are epoch milliseconds.

| State | Contents and bound |
| --- | --- |
| `state` documents | Latest per-source observations, usage/discovery/probes/drift, automatic guard and per-app overrides, digest, request log and revision; each JSON row at most 65,536 characters |
| `guard_applied` | Last input, successful acknowledgement and failure state per registered guarded producer |
| `canary_runs` | At most one active run; one scheduled and three manual starts per UTC day; history retained 60 days, with indexed active/latest lookups |
| `item_since` | First observation of active reminder conditions; inactive keys are removed |
| `attention_occurrences` | At most 256 reminder-control records, with occurrence identity, etag and disposition |
| `website_sync_requests` | Permanent indexed UUID receipts, answers bounded to 4,096 characters; uncertainty must never expire into another dispatch |

Ordinary successful mutation answers retain the newest 16 request IDs for 24 hours. Method/input identity prevents
reusing a UUID for a different action. Website dispatch receipts use their separate permanent table, including an
uncertain first result. Restarts retain these identities; no page read silently starts another operation.

Ticks, refreshes and mutations run through one in-memory promise chain. Read-only views use the same serialized
state boundary. Each decision receives an explicit clock; cron uses scheduled time and bypassed local requests may
use `DEV_NOW`. A cron retry within ten minutes of a completed tick is skipped.

## 4. Tick and source reads

A tick polls due statuses/probes, updates usage, applies guards, advances the canary, updates the digest and prunes
bounded history. Each Ops request has a ten-second timeout; GraphQL has fifteen seconds. `outboundPerTick()` derives
the ceiling from the registry, including bounded drift work; runtime tests enforce it.

Ops statuses are attempted at most once per ten minutes across cron, refresh and manual actions. Results are
leniently decoded with the shared codec and stored only as declared wire fields. Oversized results above 32 KiB are refused. Unknown fields are dropped;
unknown open-list codes remain readable, while invalid values and unknown closed-enum states fail as
`invalid_output`. Inputs are checked strictly before transmission. Failures become bounded codes, never remote
text. One failed source does not erase another source's evidence.

The frozen [reviewed query](../worker/test/fixtures/usage-query-reviewed.graphql) preserves the September 29
field/filter baseline, the September 30 Workers AI dataset addition and the reviewed Worker row cap of 50 from the
original design. `usage.test.ts` compares the runtime query with it verbatim after whitespace normalization.
This preserves a reviewed reference, not a new live-account verification; current execution is in `usage.ts`.

Usage is one GraphQL query per tick, and at most once per minute on an owner refresh. Non-200/error/malformed,
oversized or timed-out answers retain the previous successful rows and record failure separately. Usage is fresh
only for the current UTC day and within 90 minutes. A missing credential is `not_configured`, not zero usage.
Daily/monthly projections are labeled straight-line estimates and suppressed near the period's start; storage is
not projected. Mapping and configured allowances are in [limits.md](limits.md).

## 5. Scheduled decisions

### 5.3 Per-service guard

Only a registry-eligible producer whose successful status advertises `guard` receives writes. Each producer owns
which jobs a shed defers and their maximum delay ([ops adapter reference](../../contracts/ops-v1/IMPLEMENTATION.md)).

- Fresh complete trigger usage enters shed at actual usage of at least 80%, and holds at least 70% on the same UTC
  day. Comparisons use measured values, not rounded display percentages. Storage and Workers AI do not trigger.
- Automatic expiry is next UTC midnight plus one hour, within the contract's 36-hour bound. Monthly R2 operations
  can carry across midnight within the same month; daily rows cannot. A renewed monthly shed retains that margin.
- Without usable observations, an existing shed lasts only until its stored expiry; no new shed starts.
- A manual shed lasts 24 hours for that service. Manual normal suppresses its automatic shed until the next UTC
  midnight. Other producers retain their own decisions and acknowledgements.

Unchanged acknowledged input makes no call. Lost/expired producer state or a failed pending call causes a later
retry; normal is sent only to clear a known shed. A failure no longer relevant to the desired state is cleared.
The UI shows desired state and actual acknowledgement separately.

### 5.4 Delivery and processing canary

The canary covers Mail Hero webhook delivery, Todofy durable intake and the normal summary/validation step.
Mail Hero creates a pre-parsed synthetic event, so it does not cover source forwarding, Email Routing, ingest quota,
raw storage or MIME parsing. It never creates real Tasks work or enters real-mail reports/counters.

There is at most one active run. Scheduled identity is `canary-YYYY-MM-DD`; the first due tick starts it after
`CANARY_UTC_HOUR`. Manual starts are limited to three per UTC day and use unique run IDs. Start requires fresh
producer/consumer capability evidence. Mail Hero is idempotent per run ID; every retry keeps it.

| Phase | Progress | At the two-hour deadline |
| --- | --- | --- |
| starting | queued freezes event identity and enters delivering; pause/unavailable waits; invalid input fails | Known hold/missing status skips; an unresolved call error fails |
| delivering | delivered records its time and polls the consumer in that tick; failed/unknown delivery fails | Pending times out; paused skips; no response is unreachable |
| consuming | ok completes; explicit consumer failure fails; processing/not_seen waits | A known waiting code skips; otherwise timeout/not_seen/unreachable fails |

Each phase polls before applying its deadline. Stage, safe reason, attempts and timestamps remain observable.
A green result never proves another business path. With `CANARY_ENABLED=false`, queued delivery/consumer phases
continue toward a verdict; starting receives no more start attempts and becomes skipped. No missing-day failure
is invented. Re-enabling permits the day's scheduled run if none exists.

### 5.5 Digest

The raw condition list is separate from the outbound report. Disposition is applied before trimming warning/critical
items to 20 and 8,192 compact JSON bytes. Items are deduplicated by source/code and sorted by severity/source/code;
`since` comes from producer evidence or the first active observation. Codes, numbers, times and Home's own link are
the only task content.

The first tick of a UTC day with actionable items freezes one create-only TaskInbox request with a UUID. Retries
keep that exact request until Tasks acknowledges it; a lost reply cannot create a second task. At most six failed
attempts are allowed; terminal failure becomes `digest_task_failed`. A day without items creates no task. Only a
scheduled tick sends the digest; refreshes and reminder-management actions do not send external work immediately.

## 6. Owner API and UI

[`DashboardUiService`](../../proto/dashboard/ui/v1/dashboard_ui_service.proto) is the route/shape/error authority.
The Worker verifies owner Access before the transcoder. Mutations require exact allowed Origin, a bounded nonempty
custom CSRF header (current clients send `1`) and JSON media type before reading their body. No CSRF cookie or signing
key is involved. Details and per-app policy are in [edge-auth](../../packages/edge-auth/SPEC.md#54-per-app-parameters).

| Surface | Behavior |
| --- | --- |
| `GET /api/v1/registry` | Isolate-cached registry; build/catalog ETag, no object call |
| `homeView`, `flowsView`, `cloudflareView`, `opsView` GETs | One cached HomeState projection with ETag/304 |
| Home/Cloudflare refresh methods | Separate rate-limited scopes; only due source reads |
| Guard override and canary run | Serialized, UUID-identified actions with explicit receipts |
| Attention dismiss/restore | Occurrence etag plus UUID; stale conditions return `ATTENTION_CHANGED` |
| Website sync request | Permanent first receipt; repeat looks up the same request, never dispatches twice |

The ordinary-view regression budgets are documented separately from larger stress cases and platform limits:

| Route | Served by | Budget |
| --- | --- | --- |
| `GET /api/v1/registry` | Worker, no object call | ≤ 20 KiB |
| `GET /api/v1/homeView` | HomeState, one object call | ≤ 10 KiB; ≤ 44 rows read |
| `GET /api/v1/flowsView` | HomeState, one object call | ≤ 20 KiB; ≤ 44 rows read |
| `GET /api/v1/cloudflareView` | HomeState, one object call | ≤ 24 KiB; ≤ 44 rows read |
| `GET /api/v1/opsView` | HomeState, one object call | ≤ 24 KiB; ≤ 44 rows read |

`views.test.ts` keeps this table and the `api-types.ts` header equal to `VIEW_BODY_BUDGET`; actual constructed
answers remain subject to the existing body/read assertions and the separate stress bounds.

`/health` and static CSRF compatibility are transport paths. Legacy owner paths retain the dates and reload behavior
in the [compatibility table](../../docs/history.md#owner-api-compatibility); those deadlines are not advanced here.

HomeState builds generated wire types and serializes once. `PreEncoded` passes those verified bytes through the
Worker without another codec pass. Tests strictly decode and re-encode real Worker answers byte for byte. Lists
respect IDL bounds. ETags combine the state revision and body hash excluding `generated_at`, so time-dependent
levels cannot produce a stale 304. Responses are `no-store`; the client retains its body/ETag pair itself.

The UI has four hash-routed views: Home launcher/attention, business flows, Cloudflare observations and operations.
Only the visible view polls, every five minutes; registry is read once per load. Cards keep registry order. Light/dark
styles use text plus status shapes, with separate launch links and status-detail controls; links use
`noopener noreferrer`. A failing source affects its own evidence, not the entire layout.

The visual contract is the warm-paper/ink-blue token set in `web/src/styles/tokens.css`: paper `#f3f1ec`, cards
`#fcfbf8`, ink `#1d2126`, muted text `#5a5f66` and accent `#2b5c8a`. Components use the light/dark tokens, with
4.5:1 text and 3:1 non-text contrast requirements. Status uses shape plus word; external fonts, gradients and
status-only color meanings are avoided. On phones, apps/sites share a three-column launcher grid, services are
readable rows and the four-tab bar reserves 60px plus safe area; desktop tabs sit below the title. Launch links
and status-detail controls remain separate accessible elements.

| Observation | Level rule |
| --- | --- |
| Ops/probe never attempted | unknown |
| Ops consecutive failures | contribute warning after one and critical after two; absent fresh status independently contributes unknown, with the worse level retained |
| Fresh public probe failure | warning after one, critical after two consecutive failures |
| Ops status older than 75 minutes | contributes unknown; stronger failure evidence remains |
| Public probe older than 75 minutes | unknown; stale evidence is not recovery |
| Usage/analytics evidence older than 90 minutes or from another day | stale/unknown rather than a fresh zero |
| Worker error rate | judged only at 20 requests; warning at 5%, critical at 20%; smaller samples are unjudged |

Levels roll up critical, unknown, warning, held, ok. Link-only and unmonitored stages cannot make a flow green.
Tile health belongs to that entry; a flow uses its worst monitored stage. Fresh canary badges verify only their two
stages and never lower a worse observation. Newsletter content/delivery/backup are read in its console; Codex usage
is read in Model Router. Home exposes their observation metadata and navigation, not private business content.

API/body/read and CPU/bundle budgets are executable assertions in `worker/src/api-types.ts`, `idl.ts` and
unit/workerd suites. Ordinary and retained-decision stress cases have different regression budgets; neither is a
universal platform limit. Over-budget logging contains counts, never the response body.

## 7. Configuration drift

Generated desired state describes production Worker names, routes/domains, schedules, binding names/types and
personal-value flags, never secret values. The bounded read-only check compares live configuration independently
of usage analytics. It advances at most 12 provider calls per tick, with three attempts per step and a daily run
budget. Oversized, unfinished or failed runs record that failure while retaining prior completed evidence.

Configuration categories are scripts, domains, routes, crons, bindings, Workers subdomain flags and personal-value
binding type. Account writes are separate historical counts; they do not create configuration drift. Provider
responses are reduced immediately to safe names/types/flags or codes. An unreadable audit log is distinct from an
unreadable configuration check.

The owner Cloudflare refresh can advance this check across ticks. A usage refresh succeeding does not establish a
new completed configuration comparison. The UI displays both the last completion time and current progress/error;
unknown or stale observations never count as recovery. Registration, generated metadata and reconcile procedures
are in [Dashboard state and operations](../../docs/dashboard-state.md) and [infrastructure](../../infra/README.md).

## 8. Reminder control

Home stores condition identities and dispositions in `attention_occurrences`. Closing removes an occurrence from
attention/badges/future digest items but changes no producer health, business record or retry decision. Restoring is
another etag/UUID-checked local write. A failed reread after a confirmed write does not undo that confirmation.

Signatures use meaningful source changes. Newsletter's monotonic unknown-record revision, rather than a decreasing
count, identifies a new batch; a new canary failure uses its run identity. Age and percentage drift do not reopen the
same incident. Fresh confirmed recovery followed by recurrence may create a new occurrence; an unavailable source
is not recovery.

At capacity, only absent eligible old records are retired; unresolved closed decisions remain. New facts still
appear when no control slot is available, with `control_unavailable_count`, instead of failing the entire page.
No disposition action immediately sends an external message.

## 9. Private cached Home read

`HomeApi.readHome({after_occurrence_seq})` uses
[`home_service.proto`](../../proto/dashboard/mcp/v1/home_service.proto) over a private service binding. It reads
current cached statuses, their observation times and current open reminders. It performs no refresh, canary, guard
write or digest send.

Occurrence sequences increase for a new meaningful condition and survive row deletion; dismiss/restore changes
etag without changing sequence. Cursor zero establishes a baseline/head. Later reads return only current open
occurrences above the saved sequence, at most 256 in sequence order; a cursor ahead of the head is invalid. This is
not an event history: a short-lived condition recovered between reads is not replayed. Missing control capacity and
stale evidence remain explicit.

## 10. Checks and release

`bazel test //dashboard:check` covers the original unit, UI, runtime, CPU, tooling, compiler, lint and budget checks.
`bazel build //dashboard` produces the canonical release archive. Synthetic fixtures and loopback providers exercise
service failure, guard hysteresis, canary transitions, digest identity, reminder control, drift and wire conformity.

Publication uses the tested archive through the shared main-only release pipeline, with existing hostname,
credentials, ordering and reconcile gates. A local check or branch build is not production verification; dated
records are in [verification.md](verification.md), and active work/release acceptance is in root HANDOFF.
