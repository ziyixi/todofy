# Handoff

Updated 2026-10-27 UTC. Active work, open acceptance and dated compatibility only; move completed rollout detail to
a dated record and link it here. Rules are in [AGENTS](AGENTS.md); entry points in [README](README.md). Never put
private content, credentials or raw production output here.

Archives (their waiting lists are not instructions): [October 22](docs/history/handoff-2026-10-22.md)
(Tasks UI refinement and approved interface), [October 21](docs/history/handoff-2026-10-21.md) (the Private
MCP, Boundary B, done steps in Plan, the Tasks PWA features, the FlowDay retirement),
[October 20](docs/history/handoff-2026-10-20.md), [October 19](docs/history/handoff-2026-10-19.md),
[October 18](docs/history/handoff-2026-10-18.md), [October 11](docs/history/handoff-2026-10-11.md).

## Current work

### Router cost visibility and recommendation schema (released)

Source `129d5fe959a1ef4e855e4df8cd768884a74c1920` passed branch40541274534,
main40544317131 and matching reconcile40545319611 with resolved drift/resource/VPS gates.
[Verification](docs/model-router-verification.md) records the metadata-only diagnosis, synthetic paired control,
exact before/after traces and CI test/environment retry. The owner/Claude checkout remains untouched.

Known cost subtotals now remain visible with explicit unpriced-request counts. Large cumulative SDK usage
uses a Standard text reference; migration0003 derives only missing price metadata. Real Chrome showed
API$0.003339 and subscription reference$3.406225 (67priced/5unpriced), not a subscription bill.
Router internally envelopes the actual recommendation array schema and returns the original array.
The prior synthetic array failure now succeeds; no real recommendation/mail/task was recomputed.
Known SDK failures retain precise safe reasons; generic historical failures remain unchanged. One deliberate
negative diagnostic remains logged and is clearly identified in verification. No queues, retries, model keys,
application budgets/modes or backup retention were added/changed. Local Worker81/UI25 and relevant
native D1/schema/category/process/proto checks passed; the full same-source branch/main gates passed.


### Unified Model Router (released, `codex/model-router`)

Source `8adaf08921f14dc3ff684f241f8e9757f9533861` passed full branch40481469379, same-source
main40486158347 and matching reconcile40489298406, including resolved infrastructure drift and resource
registration. The failed-job CPU rerun and transient Home asset-upload rerun are recorded in
[verification](docs/model-router-verification.md). Maintenance is false. VPS/Newsletter and all migrated
Workers are ready; no sudo, login renewal or private business recomputation was needed for this rollout.

The public inference API is flat/native, with seven final-result fields. Unused temperature, metadata,
client replay IDs, hashes, parameter echo, public conversation lookup and generic non-Codex history are gone.
Owner history/usage has its own proto file. Model IDs/providers are real; Todofy owns its email/report policy.
The console has hourly/daily request/token/cost charts and clearly separate subscription API-equivalent values.
Keys remain one per API provider in Router only; the existing Claude workspace cap is$80/month. Subscription
login/PVC and app budgets/modes/history are unchanged. The owner/Claude checkout is untouched.

Synthetic live calls passed Sol, Opus5.5, Gemini Flash-Lite, ordered BGE vectors, same-context two-turn markers,
observed search and independent literal-URL open, and cleanup. The two API estimates total$0.001190; subscription
reference values are not API bills. SDK-reported Sol identity remains unavailable. No real mail/task content
was used for acceptance. See the linked evidence for trace IDs, local suite scope and verification limits.

The existing create-only bootstrap added the backup bucket/lifecycle:2creates,48no-ops,50 managed objects.
The first cloud copy completed10:27:51.790UTC:18 records/18 bodies/908,979bytes in9.309s; a known synthetic
body matched its source byte-for-byte. Daily04:47UTC backs up metadata and retained bodies for seven days,
without provider keys or execution contexts. Native local copy and fresh SQLite/body restore passed;
next natural cron and fresh-account cloud restore were not exercised. [Operation/recovery](model-router/docs/backup.md).
The read-only catalog and authenticated context cleanup remain available during maintenance for Newsletter
startup/recovery; only new Generate/Embed/Create are held. There is no extra compatibility protocol or retry layer.


### Tasks Sunday planning week (`codex/tasks-next-step-estimate`)

Owner chose Sunday as the first calendar day and Saturday-to-Sunday 00:00 account-local rollover.
Plan/Focus/GTD and date-picker/Next week shortcuts now use Sunday-Saturday daily ranges. Stored Monday week
IDs, weekly goals, review history and date-based queues stay intact; no data migration or new scheduler.
Saturday explicit commitments can carry to next week; Sunday choices belong to the new current week and
Monday causes no further rollover. Existing Sunday review tasks retain ISO history IDs and now describe
reviewing last week/planning this week, with their actual rolling-seven-day statistics unchanged.
Shared planning343, web121 plus calendar/shortcut5, Worker73 and real-D1 planning/GTD29 passed locally;
Current types/build/lint/proto-format and6 targeted browser journeys passed. The complete local browser run
passed154/155; its only remaining assertion indexed today from Monday. That test now verifies Sunday first
and selects the actual today bar; its full time-record journey passes in isolation. No application code changed
for that assertion. Same-SHA full branch/main CI and matching reconcile remain the publication gate. No production task state was changed for acceptance.

### Tasks executable estimate parity (`codex/tasks-next-step-estimate`)

Steps, Standalone and Quick use the same estimate panel in Plan and Focus; native task details expose the
optional estimate for all three. Presets and custom whole minutes save through the existing duration-only
write. Kind, parent, execution flags, queues and configured Quick calendar time remain unchanged. Outcomes
with child Steps retain their full planning editor. No schema change, default duration or task migration is added.
Local estimate checks passed shared planning341, native web120 and5 focused real-D1 Chromium cases.
The first branch CI40285051232 caught an editor-mode replacement on Execution change (153/155 browser cases passed).
The open editor now keeps its controls/draft/focus until close; reopening uses the saved execution kind.
Both original failing journeys and all executable estimate/clock cases pass (6/6); the added App regression
failed before the fix and passes now. Shared planning343, lint/types/build pass on the combined source. Publication is gated by same-SHA branch/main CI and matching Personal cloud reconcile;
actual release identity is recorded by GitHub production Deployments; no production tasks were read or edited.


### Mail Hero backup quota simplification (released)

Owner authorized implementation, same-SHA CI publication and bounded live acceptance. Keep daily 04:17 UTC
backups, the existing v2 restore format and all current mail/verified backups. Move transient source/file
inventories from per-object SQLite rows into private R2 work checkpoints; DO keeps one small batch cursor.
Baseline at `459bf7da`: 100 objects first/repeat 717/776 DO writes; 1,000 objects 5,457/6,434
(SQL rowsWritten including indexes plus setAlarm). Fixtures contain synthetic R2 objects only.
Implementation and restore roundtrip are complete. New DO writes first/repeat are 123/81 for 100 objects,
186/153 for 1,000 (97.6% lower on the 1,000 repeat). Existing Python restore tests 11/11 pass.
The 2,500-object fixture still takes 33 Alarm ticks, with no increase in scheduling bounds.
Local/CI/publication evidence: [backup write verification](mail-hero/docs/backup-write-verification.md).
Source `d1a6e526c7e5de5138ef750a13decd8b439db9c6` passed [branch CI40283095333](https://github.com/ziyixi/todofy/actions/runs/40283095333),
[same-SHA main40283588911](https://github.com/ziyixi/todofy/actions/runs/40283588911) and
[reconcile40283801879](https://github.com/ziyixi/todofy/actions/runs/40283801879), including VPS/resource registration
and resolved-infrastructure gate. Mail Hero deployment7326047450 records Worker version
`ce420e14-42d2-4716-a9ea-f92cc1b74326`; provider BUILD_SHA matches. Daily04:17 UTC remains enabled,
5GiB limit/operating switches unchanged. No extra production backup was triggered, to avoid invoking normal
rotation of existing backups. The next natural production backup and its mixed daily usage are not yet observed.
Shared owner/Claude checkout remains untouched.


### Mailsort recent read Inbox classification (`codex/mailsort-recent-read-mail`)

Owner confirmed the automatic scope as the last 48 hours of Inbox without P1-P4, including read mail.
History and normal preparation no longer require UNREAD. Each due normal batch makes a bounded recent-ID
catch-up query that excludes existing P labels before the 100-result cap. The normal receipt guard anchors
to existing pending.added_at so accepted work survives provider/quota holds; old installation cutoffs are
replaced by this 48-hour scope. Unknown receipt dates are skipped, and old non-model eligibility skips may
be recovered with their prior flow count retracted. Valid decisions stay frozen. Manual unread/recheck
batches keep their original scope and are not automatically started. No database table, setting or service
is added; the existing 15-minute configuration, model/prompt and Gmail write rules remain.
Implementation and local acceptance are complete: 238 Worker units, 125 real workerd/SQLite cases, 112 UI
cases, 26 deployment-tool cases, lint/types/build, fixed Gmail guard/oracle and HTTP smoke (52 synthetic Google
operations) passed. Worker 149.2 KiB gzip locally; Linux CI measured 150.1 KiB, so this feature uses a 152 KiB size budget
with modest build headroom. Workers Free platform, CPU, model and spending limits are unchanged. Proto format/API lint/breaking/schema checks pass.
No production mailbox content was read and no manual classification was invoked.
Rollout is gated by the existing same-SHA branch/main workflow and matching reconcile; actual publication
identity is recorded by GitHub production Deployments (`deploy:mailsort`). The acceptance below is synthetic,
so the owner mailbox is not used as a test fixture. Source/rollout checks are available in
[the branch runs](https://github.com/ziyixi/todofy/actions/workflows/ci.yml?query=branch%3Acodex%2Fmailsort-recent-read-mail).


### Mailsort automatic classification interval (released)

Source `42897d14ef61d1cdd2f7592a2b89a4b29075fa2e` passed the full
[branch CI 40258762062](https://github.com/ziyixi/todofy/actions/runs/40258762062),
[same-SHA main 40259875945](https://github.com/ziyixi/todofy/actions/runs/40259875945) and
[post-release reconcile 40260037384](https://github.com/ziyixi/todofy/actions/runs/40260037384).
Verified Mailsort deployment 7322823236 has Worker version `13bb8f8a-6677-4052-a709-9fe56e5b04e5`.

Settings now offers 5/15/30/60-minute normal classification intervals, default 15, persisted in the existing row.
Gmail maintenance stays five minutes. Legacy adoption runs once; retries/deferred work and provider quota holds
keep their deadlines. An active batch uses its frozen provider/prompt, then reads the latest interval for its
next normal batch. No new job, database or service was added. Acceptance used synthetic mail and configuration metadata;
no manual real-mail read or unread reclassification was invoked.
Real Chrome confirmed 15 selected, live mode and `gpt-6.1-sol` medium retained, and the normal next batch moved from
20:35 to 19:50 PDT after the existing Alarm adopted the setting. Prompts and previous choices were not changed.
Local checks passed 236 Worker units, 119 real runtime cases, 111 UI cases, relevant types/lint/build, Wrangler
smoke and proto checks. The Worker bundle remains 148.7 KiB within the unchanged 150 KiB budget.
The initial unchanged Todofy report-Alarm fixture timed out; local 4/4 and same-source runtime rerun passed.
Its initial cause remains unconfirmed. A separate collector defect mixed old/new same-name JUnit artifacts;
the existing uploader now replaces that shard's report on rerun. No Todofy business logic/timeout was altered.
Full final CI passed, including Newsletter/image checks. Evidence: [interval verification](mailsort/docs/classification-interval-verification.md).

### Tasks planning and detail update (released)

Source `f3a689fa519977f824b3045b4649fff6d9c5cc94` passed the complete
[branch CI 40254268612](https://github.com/ziyixi/todofy/actions/runs/40254268612), including 152 Chromium cases,
and [same-SHA main 40255033152](https://github.com/ziyixi/todofy/actions/runs/40255033152).
[Post-release reconcile 40255267212](https://github.com/ziyixi/todofy/actions/runs/40255267212) passed the complete
Worker comparison, account registration, VPS and resolved-infrastructure gate.
GitHub Tasks deployment 7322171388 records verified success at 2026-10-26 01:38:17 UTC;
Worker version is `34954a3f-6fd1-43b7-b02d-e483d00e801a`. Personal MCP released the same source as required.
The subsequent verified monorepo release above republished Tasks with the same behavior at source `42897d14`:
deployment 7322826331, Worker version `f9b85a6d-6e94-4e1f-a3ce-beca97913e3d`. Its matching reconcile also passed.

Completed prerequisites and open Deadline windows surface inactive work in Parked, without changing stored
stages or queues. Plan hides waiting tasks and their descendants across Review, Week, Quick and calendar;
Focus data stays intact. Start/stage drag acknowledges readiness with the existing Active flag. Native details
have read-only Dependents through the indexed GetTask projection (Task tag 42); ordinary lists do not expand it.
Explicit Save closes or returns to the previous task; description Done stays inline. Quick shows its configured
clock instead of unknown duration, retains clock editing and has no Estimate prompt. Enter/Escape operate only
within deletion confirmations. No scheduler, database migration or production task mutation was added.
Local checks also passed planning UI 338, Tasks web 117, Worker 72 unit and relevant runtime/CPU checks;
CI passed all 158 real D1/runtime cases. Acceptance used synthetic data, not owner task content.
Behavior and evidence: [planning readiness](tasks/docs/planning-readiness.md),
[refinement verification](tasks/docs/refinement-verification.md#2026-10-26-planning-and-task-details).

### Configuration drift audit false positive (`codex/fix-config-drift`)

The owner requested fixing the configuration drift indication. Home's stored check at 03:30 UTC has zero
configuration differences and three audit groups: user update, token create/delete and a DO namespace query
misidentified by the audit API as create. The actual latest reconcile summary is `in_sync` with 42 no-op
infrastructure resources and no planned actions; its Worker comparisons did not deploy repairs.
Home now keeps historical account operations informational, excludes `.query` reads and
derive config status/alerts only from the seven actual configuration categories. Existing audit records and
reminder dismissals are retained. Legacy cached query findings are normalized at read time; no resource
configuration, secrets, external Tasks or schedules are changed for this correction.
The owner also requires post-work drift to be prevented by the delivery flow. The existing reconcile workflow
now has a final infrastructure result gate: unresolved/manual plans cannot silently remain green. Home uses
an internal desired-content hash to discard old partial comparisons and permit same-day rechecks; its existing
Cloudflare refresh advances at most twelve drift GETs under the original limit. GET pages remain cache-only.
Generated optional-secret flags now follow the same manifest policy as CI. Root AGENTS requires waiting for
the matching post-deploy reconcile and a completed current Home check before delivery.
An independent live read at 23:00 UTC compared all fourteen Workers and found zero configuration differences,
no truncated lists and no unread zones. Final local checks passed Worker 280 unit/104 real runtime tests,
UI 181 tests, lint/typechecks/build, 458 Changes tests, API lint and breaking checks. The refresh/fingerprint
and final-gate cases are included. Source `0a1b647f` passed [full branch CI 40243518209](https://github.com/ziyixi/todofy/actions/runs/40243518209)
and [same-SHA main 40244731183](https://github.com/ziyixi/todofy/actions/runs/40244731183).
The matching [post-release reconcile 40244947088](https://github.com/ziyixi/todofy/actions/runs/40244947088)
also passed, including its new resolved-infrastructure gate. Real Chrome refreshes plus the normal cron
completed Home's fresh fourteen-Worker check at 23:32:50 UTC (16:32 PDT): zero config findings, no error,
truncation or unchecked zones, and in_progress=false. The UI shows the new completion time and no config
warning; the earlier audit-only warning was not dismissed to obtain success. Shared checkout remains untouched.

### Persistent Codex daily usage (`codex/inference-daily-usage`)

The owner requires gateway statistics to survive restart and show daily requests, failures and reported tokens.
Gateway now commits completion-day aggregates and the latest eight content-free samples to stdlib SQLite.
It reuses `platform-state/codex-gateway` through a narrow subPath mount; Platform creates that directory as
its existing UID before Gateway deploys. No new PVC, service, root command or deployment workflow is required.
Process-only fields remain compatible; Home derives Today / 7-day / 30-day totals and its daily table from
persistent rows, with the persistent history start and actual sample time visible. Unrecorded old usage is not guessed.

Local checks passed Gateway 32, relevant Platform 86 (+80 subtests, two isolated-k3s cases skipped locally),
and Home 176 UI tests with lint/typechecks/build. Physical SQLite tests cover reopen, UTC-day boundaries,
independent instances and retained samples. The 30-day health snapshot is about 8 KiB, so only Gateway's
existing bounded monitor read is raised to 12 KiB; NodeStatus and HostReport remain 12/16 KiB.
Shared API lint/breaking and Changes checks passed. The complete [branch gate 40234985072](https://github.com/ziyixi/todofy/actions/runs/40234985072)
passed and `0fb5cb60` entered production. The new Platform and Newsletter images are running; all four services
remain ready, but runtime readback exposed an older reconcile contract defect: its resource-key format omitted
the three existing Gateway aliases and its plan bound was ten instead of thirteen. The staged Gateway manifest
change therefore made `nodeStatus` return INTERNAL while ordinary workload reads stayed 200. The incomplete
Actions run was stopped before Gateway deployment. The exact contract inventory correction and a real
Planner/Service transition regression passed [full branch CI 40237892117](https://github.com/ziyixi/todofy/actions/runs/40237892117)
and [same-SHA main 40238899660](https://github.com/ziyixi/todofy/actions/runs/40238899660), source `0e3b78ed`.
The reviewed rule record names only these two old/new output corrections, preserving every other compatibility check.
Runtime readback is HTTP 200, release ready and reconcile clean; all four Deployments are ready. The actual
Gateway mounts the existing `platform-state` claim at subPath `codex-gateway`, without exposing its parent ledger.
A real synthetic 6.1 call at 22:18 UTC recorded one success, 4,666 input / 15 output tokens and 4.5 s in SQLite.
A separate health read reopened the same file and returned identical daily totals. The natural 22:20 UTC
observation reached Home, whose real Today/7-day/30-day controls and daily row matched. File-reopen and restart
behavior was tested with physical local databases; no extra production restart was forced. No real mail was
read/reclassified and no sudo or credential change was needed. The shared checkout remains untouched.

### Codex monitor and Mailsort usage (`codex/inference-monitor`)

The owner requested a Codex inference dashboard and Codex usage totals in Mailsort. Home's dedicated
`#/ops/codex-gateway` view reuses the existing Gateway → Platform observer → Fleet → Home path. Gateway
keeps process-lifetime counts, reported tokens, full request latency and eight content-free recent samples;
the page names the actual observation time and restart boundary. No prompt, response or account identity is kept.
Mailsort's v12 schema adds a UTC-day usage table, current-month totals and 400-day cleanup in its existing DO.
Both failed and successful HTTP attempts are counted; reported usage is separate from missing usage. Provider
switches retain both histories, and pre-upgrade Codex usage is not guessed or reclassified.

Local checks passed Gateway 29, Platform 135 (+143 subtests), Fleet 67 unit/10 workerd, Mailsort 229 unit/115
workerd/106 UI, and Home 173 UI tests, with affected lint/typechecks/builds. Linux CI measured Mailsort at 148.8
KiB and Recall at 130.4 KiB; their code-size budgets are intentionally 150/132 KiB for this shared monitor
descriptor and usage feature. CPU and spending budgets are unchanged. Home UI is 168.0 KiB. Full telemetry
stays inside existing 4/12/16 KiB host-response limits. The actual
Home UI was inspected in Chrome with synthetic desktop and 390px iframe views. Released
`1e86e6763ab30e3614ea2afdd9f6b9e334f1371d` after the complete
[branch CI 40230659454](https://github.com/ziyixi/todofy/actions/runs/40230659454) and
[same-SHA main 40232060456](https://github.com/ziyixi/todofy/actions/runs/40232060456), both successful.
Existing CI released Fleet before the VPS producers. A real synthetic 6.1 turn on the VPS private endpoint
recorded one success, 4,671 input / 15 output tokens and 3.6 s latency. The natural host observer's 20:50 UTC
snapshot reached the deployed Home page after its 20:51 UTC refresh, with matching counters and recent row.
All four VPS Deployments are ready, with zero Pod restarts. Mailsort's real status API exposes the new monthly
usage at zero until a new classification request; no old usage was guessed or mail reclassified.
Detailed evidence: [Codex monitor verification](docs/codex-monitor-verification.md). The shared checkout remains untouched.

### Codex 6.1 availability (`codex/codex61-runtime`)

Owner requires `gpt-6.1-sol` for Mailsort and Newsletter and explicitly accepts interruption during this upgrade.
The common stable SDK/CLI pair is 0.163.0. [Main SDK release 40221852886](https://github.com/ziyixi/todofy/actions/runs/40221852886)
succeeded, and the host standalone CLI was upgraded from 0.153.4 to the same 0.163.0 using the official checked binary.
At 18:42 UTC a real 6.1 / medium turn through the production endpoint returned all four synthetic IDs in 5.8 seconds;
reported usage was 7,357 input / 152 output tokens. No real mail was used. This branch now switches Gateway,
Mailsort and Newsletter defaults directly to 6.1; Newsletter's explicit Deployment env prevents a legacy secret
from selecting its old model. Preserve archive mode, prompts, budgets and old mail. Gateway's process-private
CLI home links only the existing auth file, keeping its cache and built-in skills separate from Newsletter.
Default-model commit `b4365194` passed [branch CI 40222677321](https://github.com/ziyixi/todofy/actions/runs/40222677321)
and [same-SHA main 40223093443](https://github.com/ziyixi/todofy/actions/runs/40223093443). The gateway's actual
default is 6.1 / medium; a second real synthetic turn at 18:57 UTC succeeded in 5.4 seconds, and the actual
Newsletter Deployment selects 6.1. All four Deployments are ready. No real Newsletter generation/send or
old-mail reclassification was started. The shared checkout remains untouched.
The owner selected full-repo standard workspaces with shared manifests/locks, and verified VPS migration to
Python 3.14 for one uv workspace. That migration is developed separately in `/private/tmp/todofy-dependency-workspaces`
on `codex/dependency-workspaces`: root pnpm 11.25.0 catalog/lock with Node 26, root uv workspace/lock with Python 3.14,
and corresponding CI/build updates. Do not treat this as merely comparing two duplicated dependency pins.

### Shared dependency workspaces (`codex/dependency-workspaces`)

The owner selected standard workspaces for the entire repository, including moving VPS Python to 3.14.
All 29 Node packages now use the root pnpm catalog/lock; five Python members use the root uv constraints/lock
and Python 3.14.7. CI installs from those same locks, retains independent app releases, and tracks root inputs
in build/source identities. The three VPS images keep separate application dependencies and root build contexts.
The setup and dependency update commands are in [dependencies](docs/dependencies.md).

Local checks passed 27 Node typechecks, 21 lint runs, 3,522 Vitest cases, 204 Mail Hero cases and 12 builds.
Proto passed 459 TypeScript and 110 Python cases. Python 3.14 passed Newsletter's 2,322 tests and mypy,
Gateway's 21, Platform's 131 (+143 subtests), Todofy's 1,255 and two build-context cases. All three production
dependency selections install on 3.14; Linux amd64 wheel-only resolution passed.

Released `725d1d5dd8666127594798d3a5b5e416aab0bbbf` after the full
[branch CI 40224123983](https://github.com/ziyixi/todofy/actions/runs/40224123983) and
[same-SHA main release 40225053622](https://github.com/ziyixi/todofy/actions/runs/40225053622), both successful.
All three Linux images built and their independent releases completed. The four VPS Deployments are ready,
their four running Pods have zero restarts, and the host Codex CLI is 0.163.0. A real 6.1 / medium synthetic
turn on the Python 3.14 gateway at 19:19 UTC returned all four IDs in 5.3 seconds. Home build `725d1d5`
visibly shows Newsletter/Codex normal; its refreshed 19:21 UTC Fleet/Mailsort/Codex observations are all ok.
No real Newsletter generation/send or old-mail reclassification was triggered. The shared Google Drive
checkout remains untouched; temporary host CLI staging was removed.

The first full workspace CI exposed a missing direct `workerd` test dependency under pnpm's isolated layout
and Python 3.14 lint updates. Both are fixed; the real local Pyodide server now starts/stops and caches its bundle.
The selected historical website source also restores its own Node version before the existing legacy install.
These fixes preserve the checked build/release paths without adding another dependency manager or runtime fallback.

### Mailsort provider switch and independent Codex gateway

Released `3e4c6b2f357b13b052c00790ac8fd0d0d3b96456` after
[branch CI 40195966957](https://github.com/ziyixi/todofy/actions/runs/40195966957) and
[same-source main 40196225288, attempt 2](https://github.com/ziyixi/todofy/actions/runs/40196225288/attempts/2).
Mailsort now persistently selects **VPS Codex, `gpt-6-sol` / medium**, in live mode. The real Chrome UI and
settings readback preserve all other settings, including daily/run write caps 150/10 and both saved prompt fields.
A real production-client call through Access/Tunnel returned all four synthetic IDs with valid priorities in
5.3 s (reported 6,598 input / 202 output tokens); an incorrect bearer received 401. No old-mail recheck was run.

The initial desktop `gpt-6.1-sol` assumption failed in the VPS model stage. The new read-only, root-proto
`CheckInference` RPC confirmed an authenticated complete catalog without that identifier, and `gpt-6-sol`
with medium support. The corrected fixed model then completed real inference; no automatic model fallback was added.
Mailsort remains the only scheduler/Gmail writer. The independent gateway uses the pinned official SDK and
existing login PVC, without a job database or mail logs. Claude credentials, its $20 cap and usage history remain.
Gateway-only releases retain the accepted Newsletter/platform versions; their Pods/images remained unchanged
across the final gateway update. All four Deployments are ready and all five existing PVCs are Bound.

Home's Codex row visibly says normal; fresh tool readback marks Fleet/Mailsort/Codex ok. Final
[reconciliation 40197045485](https://github.com/ziyixi/todofy/actions/runs/40197045485) is green: VPS and Workers
clean, Infra in sync with zero resource actions, and account registration complete. Both original GitHub switches
are restored to true. The eight-hour sudo helper/sudoers entry and its installer were removed; private temporary
copies were deleted. The inference-only owner credential remains in the existing private local config directory.
No natural Codex Gmail batch was observed at acceptance (pending=0; next batch 14:14 UTC); that is separate
from the successful real synthetic inference and does not require another automation.

Checks and detailed release/cleanup evidence are in [Codex verification](docs/mailsort-codex-verification.md).
The shared checkout was not modified. Local/runtime/UI/CPU/smoke and full shared-proto CI passed; final Worker
bundle remains 146.1 KiB gzip inside its existing 148 KiB budget. The verified-release lookup also retains a prior
success when GitHub appends inactive, resolving the pre-existing false reconciliation failures.

### Tasks GTD execution review

Released `cb6e8c810c1f836decd2cdee9beb8708ada32699` after full
[branch CI 40176734141](https://github.com/ziyixi/todofy/actions/runs/40176734141) and
[same-SHA main 40177554343](https://github.com/ziyixi/todofy/actions/runs/40177554343).
Overview, Completion and Time replace the mail-oriented GTD page; Focus retains daily execution and timers.
Tasks Deployment `7310763434` verifies `0a056945-5c9c-4f62-b61a-25bee85a6394`; MCP Deployment `7310771205`
verifies `d1193235-0f02-40b7-8389-31de93f4d227`. Migration 0010 is applied with no pending migration, and the
existing D1/bucket identities remain. Native Chrome read-only acceptance passed. No real Task/time writes
were invoked and the shared checkout stayed untouched. Metric definitions, tests, visual/performance evidence
and the first-week historical limit are in [GTD verification](docs/tasks-gtd-verification.md) and
[GTD](tasks/docs/gtd.md). No new service, dependency, secret, paid plan or scheduler was introduced.
The next natural weekly production backup containing the new tables remains unobserved.

Tasks Goals is released at `fd4a82c109f9d25e903f9f058bd5e286a8b0ddc0`, after
[full branch CI 40171075047](https://github.com/ziyixi/todofy/actions/runs/40171075047) and the
[same-SHA main release 40171731163](https://github.com/ziyixi/todofy/actions/runs/40171731163).
Tasks Deployment `7309929919` verifies Worker `c19ef834-faef-4d3d-a567-febb33002e79`; Personal MCP Deployment
`7309935989` verifies `20548e78-102e-4fff-ba67-8e6c402bded9`. Direct provider readback matched both builds and
preserved Tasks' D1, jobs namespace and backup bucket. The existing MCP tool catalog was not extended.
The authorized private Notion import is complete: four annual Objectives and 12 KRs, all 27 source sections
preserved and every full KR read back with zero content mismatches. Progress, milestones, focus and completions
were not inferred. Original Bets, lane orders, next-week choices and task/catalog counts match the pre-import
baseline. Live UI shows all four directions and all 12 picker choices; exploration has no metric prompts.
Private plaintext input/SQL/bookmarks were deleted after verification. No production test Task was created.
Implementation/local/CI/browser/performance/backup evidence and the initial portable-test-path correction are in
[Goals verification](docs/tasks-goals-verification.md) and [design QA](tasks/design-qa.md#goals).
Work stayed in the isolated checkout; Claude's shared checkout was untouched. No new service, model call or
scheduler was added. The next natural weekly backup containing Goals has not yet been observed.

Few-shot examples are released at `c121b02da666592b12c1c575ad48328c004b523b`, after
[branch CI 40153945767](https://github.com/ziyixi/todofy/actions/runs/40153945767) and the
[same-SHA main release 40154139320](https://github.com/ziyixi/todofy/actions/runs/40154139320).
Deployment `7307508589` verifies Worker `51499494-76d0-45f6-b88d-f8efb1f23971`, with the same DO namespace.
Three input/JSON-response pairs cover seven synthetic messages and all four priorities, within 8,897 UTF-8 bytes
including personal rules. Current/removed personal preferences take precedence over the sample defaults.
The new base was saved in the live editor at 02:19 UTC before that code release, then survived reload and the
subsequent Worker deployment with the original save time and personal rules intact. No runtime code, model key,
budget or Gmail batch changed. See [few-shot verification](docs/mailsort-claude-verification.md#few-shot-examples).

Editable Mailsort prompts and cache accounting are released at `70a60d4959289ade5691f5b9a12bf0818d756009`,
after [branch CI 40152547981](https://github.com/ziyixi/todofy/actions/runs/40152547981) and the
[same-SHA main release 40153166848](https://github.com/ziyixi/todofy/actions/runs/40153166848).
Mailsort Deployment `7307375160` verifies Worker `b22c80f4-4bde-445f-b767-b7e5e47dcc77`; Home Deployment
`7307385472` verifies `f68f77b1-8b78-4c1d-be7b-3651fcb2fb7a`. Both provider builds match that SHA.
The owner-requested USPS, Daily Briefing and shopping-receipt rules were saved through the live settings UI
and survived reload. Future deployments retain the saved base/rules override. Opus 5.5 medium, live mode,
the $20 cap, Gmail credentials and DO namespace are unchanged. Existing usage remains 209,921 input and
12,525 output tokens at $1.090184; actual cache reads/writes are both zero, so no real cache hit is claimed.
The [privacy release 40153219914](https://github.com/ziyixi/todofy/actions/runs/40153219914) succeeded and its
public text was checked. Local checks passed 215 Worker unit, 98 workerd/CPU and 94 UI tests, synthetic
Wrangler smoke, proto and affected Home/website checks; dry Worker/UI bundles are 139.4/60.3 KiB gzip.
No old mail batch, model call or new key was created for acceptance. Work stayed in the isolated checkout;
Claude's shared checkout was untouched. See
[Claude verification](docs/mailsort-claude-verification.md#editable-prompt-and-cache-accounting).

Recheck counting and badge freshness are fixed at `ed236228229450ac1c8b06de70a9f090d82c6da2`, after
[branch CI 40148723336](https://github.com/ziyixi/todofy/actions/runs/40148723336) and
[main release 40149463353](https://github.com/ziyixi/todofy/actions/runs/40149463353). Deployment `7306876510`
verifies Worker `7626477f-8e3c-46b9-8d9d-0154c0913763` and the unchanged DO. The original-100 run retained its
`2026-10-25T00:31:22.597Z` start time and now correctly reports 52 changed, 48 unchanged, zero excluded and zero failures.
Its recorded nominal cost stayed $1.090184; no model rerun or stored-state migration was needed. Fresh Gmail
metadata shows P2 has three messages, all unread; the labels UI now shows the same three and refreshes report badges
with progress without replacing row/detail nodes. The button is named “重判最初100封” to identify its actual cohort.
Limits, prompt and owner guards are unchanged. See [verification](docs/mailsort-claude-verification.md#recheck-result-counters-and-priority-badge-freshness).

The earlier unread progress fix shipped at `c18f73f1985bd46eef96594914b3a3154d64f2eb`, after
[branch CI 40146082647](https://github.com/ziyixi/todofy/actions/runs/40146082647) and
[main release 40146726819](https://github.com/ziyixi/todofy/actions/runs/40146726819). Mailsort Deployment
`7306499723` verifies Worker `f5b272b5-3919-454e-a4c7-57f651b646c1` and the same DO namespace. The manual card now
updates while active/visible and shows the actual daily-cap resume time; already-labelled eligibility precedes
Gmail write-cap holds. The owner's existing 113-message batch completed 12 applications, 101 skips and zero failures with
$0.13058 app-recorded nominal Claude usage. The deployed status retained the original batch start time, live mode,
Opus 5.5 medium and the $20 monthly limit. No batch was restarted or existing limits raised.
See [Claude verification](docs/mailsort-claude-verification.md#manual-unread-progress-follow-up).

The earlier Codex/VPS batch runner was canceled and removed. Current gateway work keeps scheduling in Mailsort. The six-condition
Claude comparison used [the original benchmark prompt](https://github.com/ziyixi/todofy/blob/511ec5063ecc1cd3602020aa2544f6cf975090f1/mailsort/prompts/priority-classification.txt)
and cost $3.514105 at list prices before credits. Its temporary evaluation key is disabled and its local file removed.
The maintained prompt now clarifies personal periodic reports; the benchmark remains a record of its earlier
version. See [Claude comparison](docs/mailsort-claude-comparison.md).

Mailsort's Claude implementation and release are complete at `ff4b3532b1f15eef3b61520b0a4fb2f29dd8fdb1`, after
[branch CI 40140845410](https://github.com/ziyixi/todofy/actions/runs/40140845410) and
[main release 40141649309](https://github.com/ziyixi/todofy/actions/runs/40141649309). It reuses the existing Worker,
SQLite DO/Alarm and Gmail ledger, with roughly hourly Opus 5.5 medium batches and a dedicated $20/month workspace.
The owner-confirmed key is only in Worker secrets; Gmail credentials and the Brief key remain unchanged.
Mailsort Deployment `7305900543` verifies Worker `081e7f5a-2ca1-437c-9bab-5c1f00ce8ea5`; Home Deployment
`7305911514` verifies `56885555-268c-4dcf-9ac5-af92d5db64a8`. The exact retirement-list fix allowed only the planned
Mailsort `AI` removal after the first preflight stopped before upload.

The built client passed one real five-synthetic-message request ($0.01684); app-recorded usage remains zero at the
runtime check. The owner cleared the old daily-write-limit breaker and the fresh UI confirms live mode, writable
Gmail, Opus 5.5 medium and the $20 limit. Natural hourly inference and real Gmail writes were not used as acceptance
evidence. Home refreshed at `2026-10-24T23:41:23.022Z` and reports Mailsort `ok`, zero pending and no signals;
the old warning disappeared without dismissal. The public privacy
page names Anthropic and the monthly limit. Full evidence: [Claude rollout](docs/mailsort-claude-verification.md).
Work stays in `/private/tmp/todofy-tasks-design`, outside Claude's shared source checkout.

The earlier original-100 batch ended after the owner asked to leave that mail unchanged: 45 actual Gmail
changes, 55 skipped and no pending members. Its five unstarted rechecks were cancelled in the authorized audit;
do not resume them. The later authorization to reclassify all currently unread mail has not been executed.
This rollout starts no original-100 or all-unread reclassification and does not automatically recheck existing P1-P4 mail.

The owner rejected a new post-model Gmail metadata check for concurrent manual edits. That request, its exact-label
guard and three tests were removed, along with one redundant P1 condition. Keep the ordinary initial label check
and pre-existing retry/ledger behavior; do not restore concurrency machinery or a test matrix. Earlier Clef
calibration, release checks and the cancelled original-100 batch are in
[priority verification](docs/mailsort-priority-verification.md).

The Watch evidence implementation and native Dots acceptance are complete; the verification record is in
[Watch evidence verification](docs/watch-evidence-verification.md). Its temporary subscription is stopped,
dedicated Watch paused and synthetic Work done. Existing hourly Work review remains unchanged.
Work used the isolated checkout `/private/tmp/todofy-tasks-design`; Claude's shared source checkout is untouched.

## Latest verified release

The shared-dependency rollout is `725d1d5d`; all declared consumers passed their checks and released through
[main 40225053622](https://github.com/ziyixi/todofy/actions/runs/40225053622). Feature records below identify
the corresponding behavior changes. Tasks and Personal MCP retain GTD execution review and daily-only Focus from `cb6e8c81`. The approved Goals view,
optional native associations and imported definitions remain intact. Source/version, full-suite and live evidence
are in [GTD verification](docs/tasks-gtd-verification.md).

Mailsort and Home run `725d1d5d`. Mailsort selects Codex 6.1 Sol / medium; the Claude choice retains Opus 5.5
medium, its independent $20 monthly workspace limit and usage history. Live mode remains selected. The earlier Clef release
and cancelled original-100 batch are historical records in [priority verification](docs/mailsort-priority-verification.md).
No five-member recheck remains pending. Provider identities and completed manual progress are in
[Claude rollout](docs/mailsort-claude-verification.md).

Watch page evidence (`f7942fb6`) passed the complete
[branch gate](https://github.com/ziyixi/todofy/actions/runs/39950244799) and
[same-SHA production release](https://github.com/ziyixi/todofy/actions/runs/39952782780). Watch, Personal MCP and
Home deployed; their exact provider versions and successful Deployment IDs are in
[the verification record](docs/watch-evidence-verification.md). The private evidence bucket is managed by IaC;
[final drift](https://github.com/ziyixi/todofy/actions/runs/39952857265) has 39 no-ops and no changes. Home lists the
bucket under Watch. Private Personal Cloud skill 1.3.0 matches source, preserves its App/OAuth connection and
shows 36 tools plus the existing six events. The same Dot sees the new tools without a Reboot. No model API,
periodic scheduler, new secret or paid upgrade was introduced; ordinary Watch notifications remain independent.

Real Browser Run saved Markdown, native structure and a 1280 × 960 JPEG. The existing Dot actually read the images
and resumed on source event `watch:1`, handled sequence 9 and saved a structured relevance review against the frozen
after snapshot. The live fixture changed source-URL metadata; automated real-storage tests cover visual-only
changes. Scoped cleanup completed at 2026-10-23 13:04:27.673 UTC: subscription count, open Works and pending reports
all returned to zero. The verification record distinguishes the initial fact checkpoint from the structured
review added after clarifying the existing snapshot-reference contract.

Tasks' sidebar change (`56662a46`) passed the complete [branch gate](https://github.com/ziyixi/todofy/actions/runs/39931674226)
and [same-SHA production release](https://github.com/ziyixi/todofy/actions/runs/39933099264). The verified deployment
is `7274991045`, Worker version `01b39f19-8e70-48b2-b837-77af3a61e2a5`. Only Tasks deployed. Without a saved
branch choice, nested projects default expanded, including when the catalog arrives asynchronously; manual
collapse remains persistent. Six local Sidebar cases, TypeScript and lint passed. The owner's current project
branches were expanded through their existing controls and stayed open after reloading the deployed app.
Only browser navigation preferences changed; no real tasks or catalog records were modified.

Personal work memory (`84183945`) passed the complete [branch CI](https://github.com/ziyixi/todofy/actions/runs/39777372400)
and [same-SHA production release](https://github.com/ziyixi/todofy/actions/runs/39779693261). Watch and Recall deployed
before MCP, then Home. The authenticated existing MCP connection returns the exact SHA and `stage: work_memory`;
its old accepted delivery records remain intact. The private plugin skill is `1.2.0`, read back against source with
the App identity, OAuth connection, presentation and sharing unchanged. There is no new service, database resource,
model API or scheduler. Budgets, operating switches, browser extensions and real user content remain unchanged.

Local checks include 64 MCP unit tests, seven workerd cases and the source apps' checks; full CI also verified all
repository gates. Worker/version identities and the native-client results are in
[work-memory verification](docs/work-memory-verification.md). The earlier Tasks interface release and its 135
browser cases remain in [the dated record](docs/history/handoff-2026-10-22.md#approved-tasks-interface) and
[visual review](tasks/design-qa.md).

## Open from earlier releases

- Boundary B ([archive](docs/history/handoff-2026-10-21.md#boundary-b-released-claudeboundary-b)): after the
  2026-10-25 Sunday backup, Todofy's health page shows it complete with no `tasks` section. In the next push that
  deploys them anyway, remove only the completed Todofy entry from `RETIRED_BINDINGS` and reword `proto/buf.yaml`'s header comment, which
  still names the retired `todofy/taskintent/v1` (a change to that file alone deploys every app and the VPS).
  Mailsort's separate `AI` retirement entry stays until its production removal is verified.
- Owner UI, read-only, for Boundary B: Tasks › Mail lists mail and its categories; Plan's weekly review shows the
  pending-mail count; Tasks › GTD shows the copied trend; Mail Hero's 提醒 card names Home's digest task.
- Owner, blocked secret operations: delete todofy-core's Worker secrets `TODOIST_API_KEY`,
  `TODOIST_DEFAULT_PROJECT_ID`, `TODOIST_OPS_PROJECT_ID` and `TODOIST_REVIEW_PROJECT_ID`, then their optional
  declarations in `todofy/app.toml`, and regenerate (`tools/cloud-config/generate.py`,
  `.github/scripts/drift_desired.py`).
- Set `INFRA_TFVARS` again from the complete private input without the FlowDay names, then empty `RETIRED_VALUES` in
  `infra/scripts/infra_state.py`.
- After 2026-10-25 10:00 UTC, confirm on Todofy's health page that the first Sunday backup after the FlowDay release
  completed.
- Owner: remove the installed FlowDay PWA from each device (optionally, with the owner's OK, its stopped Compose
  service and tunnel rule in `self-host-on-vultr`); by hand on the Mac, the Tasks PWA's Dock menu, a `?task=` link
  opening in the app window, the title-bar toggle, the mini timer and a real lock with Keep and Discard.
- Owner: remove Todoist Plus from `chrome://extensions` (its variable, releases and merged branches are gone).

## Open acceptance

### Native hourly Work review

Catalog refresh and native Work event continuation passed in the owner's existing Dot; see
[the actual-client evidence](docs/work-memory-verification.md#native-dots-acceptance-2026-10-23-utc).
The scoped synthetic subscription is stopped, its dedicated Watch paused, and its Work done after source
read-back. The shared native hourly review is saved, but its first natural run is unverified (the host's next-run
field is null). Recall image viewing passed on the known older public diagnostic snapshot; today's new capture
did not arrive and was not used. Do not substitute a Codex heartbeat,
accepted delivery count or local fake callback for client execution. Existing user Watches and all old stopped
automations stay as they are.

The two scheduler observations the owner stopped on October 17 (email models, website daily sync) are kept
in [the October 18 archive](docs/history/handoff-2026-10-18.md#stopped-scheduler-observations); do not restart them.

### Owner decisions, 2026-10-15

Answered in chat; do not re-ask.

- Recall keeps its seven-day cloud file window. `de4d561` deployed at `2026-10-11T23:55Z`; after about 2026-10-18,
  verify the first production file removal and one Dropbox cold read, recording metadata only, never page content.
- GTD additions: the Waiting list, the weekly review checklist and the Sunday-commit fix. The one-card
  Clarify queue was not chosen, so the checklist only counts the mail project's unplanned tasks and links it.
- Native weekly rollover stays enabled; a commitment for an ended week reads as weekly in Tasks
  ([Tasks design](tasks/docs/design.md), [evidence](docs/tasks-plan-reliability-verification.md)).

### Waiting for the owner

- Install Recall Orion `2026.1015.451` on the phone; renewed phone acceptance follows it.
- Brief's sender `onboarding@resend.dev` delivers only to the Resend account's own address; change it before sending.
- Check the Claude Console workspace spend limit against Brief's stored $80 budget (unverified; $50 was suggested).
- Dedicated Cloudflare tokens for the infra workflows and a fresh deploy token; the infra workflows have not switched
  yet ([replacing the token](infra/README.md#replacing-the-token)).

### Remaining observations and separate follow-ups

- `5134232` removed the direct `vars` expressions from the release composites. Todofy and Home uploaded through them
  in [run 38469896460](https://github.com/ziyixi/todofy/actions/runs/38469896460); the Mail Hero, Brief, Links,
  Fleet and website-relay composites have not been loaded by a real upload since the `dd7a6e8` refactor. Check the
  first natural release of each; a preflight/no-op does not load the skipped composite.
- Brief still needs archive-day acceptance of source coverage, editorial quality and actual model cost (local checks
  used fakes). Preserve archive mode and $80; sending, shadow mode and Newsletter retirement are separate owner
  decisions, and topic `geo.earth` stays 熟悉. See [Brief design §16](brief/docs/design.md) and [README](brief/README.md).
- Home's account-audit change reporting was deployed at `a3705ed`; confirm a completed daily check shows a qualifying
  dashboard change once as 非 CI 改动
  ([recorded scope](docs/history/handoff-2026-10-11.md#in-flight-2026-10-06-claude-home-reports-account-changes-made-outside-ci)).
- Bootstrap and safe drift repair are verified in the existing environment. Empty-account / clean-VPS setup, DNS and
  host-entry recovery and full historical data recovery remain separate exercises; follow [rebuild](docs/rebuild.md)
  and [its verification table](docs/rebuild-verification.md).
- Not rechecked since: Watch's first real changed-watch digest, Newsletter's natural provider/send acceptance and
  Brief in Home's daily Worker inventory. Check fresh status before treating an old waiting item as open; do not
  restart Compose, replay a send or request credentials solely from an archived note.
- Recall: the cost estimates in [design §5.3](recall/docs/design.md#53-budgets) predate minute snapshots with
  screenshots. The phone still reports build 337, and the `page_probe_invalid_reply_type` cause is not established
  ([diagnostic evidence](docs/recall-diagnostic-verification.md#october-14-recurrence-and-repeated-installation-delay)).

## Operating boundaries

- Workers release independently from committed Wrangler configuration. `config/cloud.toml` is the public deployment
  profile; generated `config/resources.toml` records resource identities. Use the configuration/bootstrap tools and
  `infra/` for their declared resources. Preserve root mail records and unrelated resources.
- GitHub Actions deploys the Newsletter/Platform images by digest through the typed daemon API; it holds no SSH key
  or Kubernetes credential. Legacy Compose services stay stopped with their data; Newsletter remains an independent
  VPS service until the owner retires it.
- Mail Hero backs up natively through its DO Alarm and private R2 ([native backup](mail-hero/docs/native-backup.md)).
  Tasks backs itself up weekly into `tasks-backups` ([Tasks backup](tasks/docs/backup.md)), and Todofy backs up only
  its own D1 (both from release 2 of Boundary B).
- Brief's paid Claude calls can run in archive mode, but email is disabled. The stored $80 budget is distinct from
  the code's initial default and any Claude Console limit; preserve it. Owner-supplied Claude/Resend keys never
  pass through GitHub. Workers Free and existing application budgets remain in force.
- Keep Home's persistent alert dismissal. Historical unknown business outcomes are not automatic replay permission;
  follow current [dashboard-state semantics](docs/dashboard-state.md).

## Dated compatibility and retained data

The authoritative [compatibility table](docs/history.md#owner-api-compatibility) defines the old-client responses:

| Surface | Earliest removal |
| --- | --- |
| Mail Hero legacy owner routes | 2026-11-01 |
| Home and Todofy legacy owner routes | 2026-11-02 |
| Mailsort v1 owner routes | 2026-11-10 |

Keep Todofy core's `owner_api` RPC until the corresponding gateway compatibility window is complete. Dates permit a
reviewed follow-up; they do not schedule deletion or authorise changing frozen webhook bytes or migrations. Todofy's
retained host cutover snapshot stays through **2026-10-29**; deletion is a separate action
([verification](todofy/docs/verification.md)).

## Working and maintenance entry points

- [CI/CD](docs/ci-cd.md#where-to-change-the-pipeline): checks, release selection and failure navigation. Push a
  branch, wait for the complete gate, then promote the same green SHA. A rebase or new commits need new checks.
- [Rebuild](docs/rebuild.md), [Cloudflare bootstrap](tools/cloud-bootstrap/README.md),
  [VPS bootstrap/recovery](tools/vps-bootstrap/README.md), [infra](infra/README.md): current operating commands.
- [Documentation guide](docs/README.md), [architecture](docs/architecture.md), [service catalog](docs/service-catalog.md),
  [proto](proto/README.md), [contracts](contracts/README.md): canonical boundaries and application entry points.
- [History](docs/history.md) and the archived handoffs above: earlier releases and evidence.
