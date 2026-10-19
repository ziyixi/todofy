# Handoff

Updated 2026-10-19 UTC. Keep this file focused on active work, open acceptance and dated compatibility constraints.
Move completed rollout detail to a dated record and link it here. Repository rules are in [AGENTS](AGENTS.md);
service entry points are in [README](README.md). Never put private content, credentials or raw production output here.

The complete previous handoff is preserved in [the October 11 archive](docs/history/handoff-2026-10-11.md).
Its old waiting lists and release identities are historical, not instructions to repeat completed work.

## Current work

### Cloud reconcile recovery and inline subtasks (2026-10-18 UTC)

Branch `codex/cloud-recovery-tasks` uses an isolated checkout while the owner's other agent works.
The failed VPS comparison in [39147228294](https://github.com/ziyixi/todofy/actions/runs/39147228294)
was recovered with the documented owner-run k3s restart. All three running Pod UIDs and restart counts
were unchanged; the failed-job rerun passed. Fleet now reports a ready runtime and a clean reconcile plan.
The separate Mail Hero stale-backup alert was traced to an expired native snapshot lease. The existing
native retry verified 1,903 files / 66,221,731 bytes at 22:33:49 UTC and released its pause. No backup
contents were read locally. After the next due owner refresh, every Home app is normal and its attention
list is empty; no alert was dismissed.
The owner-approved legacy email project is archived through the owner UI. Its 192 incomplete and 2,115
completed tasks remain intact; no filter or task was deleted. The original Todoist account was not changed.
Inline child lists start collapsed, read bounded pages only when opened and reuse normal task actions.
Schedule and priority icons now use the installed Base UI tooltip on hover/focus in both task menus.
The owner also reported missing drag support in parent details. Both Subtasks and Steps now expose
handles and before/after drop feedback, persisting only sibling sort order. Their kinds remain unchanged.
Initial SHA `81dbf79f4da8b419cef40c57ea5fb615c3ad75bb` passed branch
[39174037014](https://github.com/ziyixi/todofy/actions/runs/39174037014) and same-SHA main
[39174359695](https://github.com/ziyixi/todofy/actions/runs/39174359695). Independent provider reads verify
version `062d24b5-7bc5-4b7f-8223-de64429dcdb4`, source SHA, database and Planning binding.
Owner follow-ups keep existing editors open after Save, hide Steps from ordinary views/counts, detach
subtasks through main-list dragging, and show years outside the current account year. Those changes pass
56 web units, 58 Chromium/local-D1 journeys and 41 Worker runtime checks. Actual Chrome confirms Save
retains the frame, a future deadline includes its year, and expanded main lists omit Steps.
The newer requests are implemented: native property tags separated from real labels, batched list
planning reads, sidebar project/Inbox/label/Today drops, and Plan outcome/Step completion through the
existing receipt/Focus settlement path. Committed alone occupies the full-width row below the existing
desktop columns; candidate cards remain vertical. The owner's correction explicitly rules out splitting
the other desktop columns into separate rows. Real Chrome synthetic checks confirm this layout and both
outcome and scheduled-Step completion; no real tasks were edited for those checks.
Quick now implies standalone in native projections/writes and both editors. Existing Quick rows need
no backfill; a real Worker/D1 test confirms reads retain their physical row/revision. Core's focused
34 checks, shared planning's 23 units, 57 Tasks units and 61 Tasks browser/D1 journeys pass.
The legacy shared-UI consumer's final packaged browser checks and the complete branch gate are being
finished; final production verification remains. No schema, wire format, dependency, service or
persistent cache was added. The original/Claude checkouts remain untouched.
See [acceptance](tasks/docs/inline-subtasks-verification.md).

### Tasks workflow refinement (2026-10-18 UTC)

Follow-up `codex/tasks-dependency-layout` is released after the owner reported a warm-open inward flash.
Real Chromium/local-D1 reproduction identified two independent shifts: the dependency loading paragraph
removed about 17px above its heading, and empty child placeholders removed another 27px. Same-height
dependency status and stable empty child instructions now keep that heading still across both replies.
The owner also requested optional Time/Repeat panels and a quieter sidebar resize affordance. Browser
regressions now cover warm inner geometry and the common property popups.
The combined local suite passes lint/type/build, 55 unit checks and 50 real Chromium/local-D1 journeys.
Actual owner Chrome with the synthetic preview confirms cached reopening and the default collapsed Date
panel; its screenshot is in the refinement record. No real task was edited.
SHA `857bf1283fe9b9930b328fdfa7ebcb8a59cb52d1` passed full branch
[39117050187](https://github.com/ziyixi/todofy/actions/runs/39117050187) and same-SHA main
[39117391432](https://github.com/ziyixi/todofy/actions/runs/39117391432). Only Tasks released.
Deployment `7152959808` records version `cd6a3621-817b-40f9-8059-ac3b8995908c`; an independent provider
read verified that SHA, persistent resource identity and declared public configuration with zero differences.
Production owner Chrome loaded `index-DdNq1sIy.js`, an unchanged 860×780 detail frame and 19 badges;
the dependency heading is 20px with no old loading paragraph/child placeholders, Time/Repeat panels are
collapsed, and sidebar feedback is 44px. The real dialog was closed without saving. Cold/warm/response
boundary movement is established by synthetic real-browser tests; private task content was not emitted.
Closing branch `codex/tasks-layout-verification` records these receipts only, with no new app changes.

All 28 items in the owner's acceptance list are implemented and released. The original branch was
`codex/tasks-workflow-refinement`; `codex/tasks-read-efficiency` completes the read/DB work.
Closing branch `codex/tasks-read-verification` records the production evidence only.
The scope is native counts/navigation, ordinary task editing with planning/dependencies/start windows,
separate Task/Subtask and schedulable Step semantics, structured recurrence, native effort, legacy
tag/title cleanup and Focus timing against FlowDay's existing timer. Production cleanup must preserve
task IDs, dependencies, completed history and time/queue references. No VPS, Newsletter or Recall product changes.
Current status and item-by-item evidence are tracked in [the refinement record](tasks/docs/refinement-verification.md).
Implementation SHA `2dbd6aad31d7876a2a609ac3e172612f5d9f5616` passed complete branch
[39102347298](https://github.com/ziyixi/todofy/actions/runs/39102347298), then the same-SHA main
[39102825081](https://github.com/ziyixi/todofy/actions/runs/39102825081). Tasks, FlowDay and Todofy actual
Worker/config/resource identities are verified by Deployments 7150745728, 7150757426 and 7150769623.
Owner Chrome verified category counts, quiet empty search and working project collapse. One synthetic
task saved/reopened its real native planning/effort/deadline/lead values, then was soft-deleted. It was
never scheduled/completed/timed. Final checks include 37 web units, 39 real Chromium/D1 journeys,
36 Worker runtime checks and 18 real Core/Tasks integration checks; current source remains unchanged.

The owner explicitly authorized the complete cleanup on 2026-10-18. The exact frozen 312-task scope was
revalidated, then applied: eight retired labels, 222 cleaned task titles, 163 Deep and 119 Shallow effort
facts, the one overlapping effort left unspecified, four receipt-proven Steps, two already-queued
Standalone facts, the exact redundant Mail favorite and separator filter. Remaining legacy labels and
key markers are both zero. Task IDs, relationships, business dates, estimates and all 2,824 completion
occurrences compare exactly with the pre-cleanup snapshot. All 25 FlowDay flows (103 planned and 15 done
references) and 80 time entries are byte-for-byte unchanged after owner-API reads. No source Todoist data changed.
The one-time operator's Tasks metadata initially used Core's seconds; those exact target timestamps were
corrected to milliseconds and verified. The existing changefeed received new events; its old entries,
sequence and consumer cursors were retained. One embedded key in the same frozen task set was also removed.
Production Chrome confirms the obsolete Favorites section and old labels/filters are absent.

Branch `codex/tasks-details-polish` completed the owner's added items 23–26: stable task-detail loading
without a false unchecked phase or changing modal height, deliberate Action/Status option placement,
visible supported Date/Deadline input formats, and a floating label picker that does not expand the editor.
No new infrastructure or settings were needed. The combined local checks passed: 37 web units,
44 real Chromium/local-D1 journeys, 22 shared planning units,
308 retired-consumer regressions and type/lint/build. Actual Chrome's synthetic fixture keeps its 860×780
frame and body height unchanged with the label popup; date format guidance is visible. No schema, API,
credential, cost or infrastructure changes. SHA `f5745def60865a832781727bb71919754ee23b0e` passed complete
branch [39110446990](https://github.com/ziyixi/todofy/actions/runs/39110446990) and same-SHA main
[39110769544](https://github.com/ziyixi/todofy/actions/runs/39110769544). Read-only production Chrome
confirmed the stable frame, loaded option groups, both input hints and floating label picker; no real task
was edited for this follow-up.

Items 27–28 add one bounded 30-second page-memory detail cache, fresh mutation preflights, no-op saves,
metadata-only Catalog reads for internal consumers and existing-index count queries. No cookies,
persistent private cache, new database index, service or dependency was added. Core reuses Catalog only
within one planning request; Tasks deploys before the new Core/FlowDay consumers. Real synthetic D1
measurements fell from 4,254 to 179 read rows for a full Catalog and 10 for metadata only, all zero writes.
Growing completed label history from 2,000 to 4,000 keeps count results and 298 read rows unchanged.
Backend, cross-language and proto checks pass. Final combined web checks also pass: lint/type/build,
55 unit/hook checks and 47 real Chromium/local-D1 journeys. The complete branch gate
[39114444628](https://github.com/ziyixi/todofy/actions/runs/39114444628) and same-SHA main release
[39114918906](https://github.com/ziyixi/todofy/actions/runs/39114918906) both passed at
`2bfe0add9c515b24e0c30a5d1bb36f4f4185231d`.

Independent read-only provider verification confirms this SHA, registered databases/namespaces, static
bindings/vars, schedules and exposure settings, with zero differences for these four Workers:

| Application | Successful Deployment | Actual Worker version |
| --- | --- | --- |
| Tasks | 7152582778 | `0493376d-5a71-4a76-a12b-1e4beb266d99` |
| FlowDay | 7152598143 | `dfe80fa3-1b70-4384-b0a6-944b22cd3786` |
| Todofy Core / Gateway | 7152610118 | `12205dc1-bb5b-4347-916e-c084e3a0132e` / `217b411b-a885-4c92-93f0-7435e0c8a911` |

Owner Chrome loaded the new `index-CfShSuyT.js`, 19 category badges and a real task's loaded planning
controls in the unchanged 860×780 frame. The dialog was closed without saving. Full-description cache
reuse, exact read counts, no-op writes and mutation conflicts are established by the synthetic browser
and real local-D1 checks, not by reading private production descriptions. The earlier authorized cleanup
and all protected history/queue/time comparisons above remain the data acceptance evidence.

Initial branch run [39113526896](https://github.com/ziyixi/todofy/actions/runs/39113526896) was cancelled
after the unchanged Recall WebKit fixture failed its focused-page assertion. Its fake tab activation had
not brought the real test page to the front; the test also anchored dwell time before navigation.
A test-only correction now waits for navigation/foreground and advances from the recorded focus start.
A fresh current-source extension build passes all 16 existing WebKit cases, with capture/upload/dedup
assertions retained. An earlier local failure used stale ignored build output and is excluded as evidence.
No Recall product code or installed extension was changed. The corrected SHA passed the full gate.
The existing test-path release classification also rebuilt/redeployed the unchanged Recall product and
published its artifacts in main run 39114918906 (Deployment 7152579970); no installed Chrome/phone files
were updated, and this is not new phone/Orion product acceptance. VPS and Newsletter releases were skipped.

The owner also reported a transient approximately 20-second Tasks refresh stall. Public HTTP redirected
to Access in about 0.1 seconds, while authenticated Chrome inspection stalled and later recovered in the
same tab. No root cause was established; no cookies were cleared, browser restarted or auth config changed.
The read optimization must not be described as a verified fix for that separate incident.

### VPS release recovery (2026-10-18 UTC)

Branch `codex/vps-release-recovery` records host recovery only; no application, release-client or
bootstrap code changes. The host address changed while K3s still advertised its previous Node IP.
The API EndpointSlice and NAT agreed with that obsolete address. Pod API connections failed with
EHOSTUNREACH; release `99305435-d841-4481-86b8-08a6348052fa`, source `7eae74653b37333f278a5894ec3f6dcc36ce6447`,
held at `suspend / UNAVAILABLE` before closing Newsletter admission or replacing an image.

The owner verified the installed config against the retained bundle and restarted only `k3s`.
At `2026-10-18T04:11:23Z`, API Service TLS passed and daemon observations were ready, with Newsletter
healthy/accepting, zero active work and zero unknown outcomes. All three running Pod UIDs and zero
restart counts were retained through host recovery. The original-target resume passed in
[Actions 39096240942](https://github.com/ziyixi/todofy/actions/runs/39096240942). The daemon recorded ready
at `2026-10-18T04:20:33Z`; actual source, both frozen digests, request IDs and generations match, and
Newsletter is healthy/accepting with zero active work and zero unknown outcomes. Deployment `7149842106`
records that ready receipt. Only the failed VPS job of
[latest main 39089092378, attempt 3](https://github.com/ziyixi/todofy/actions/runs/39089092378) was rerun;
the whole run now succeeds, with successful Cloudflare jobs retained. Deployment `7149857702` records
release `63d0dfb5-64fc-4eb6-89ba-cbb872b95471` ready at `2026-10-18T04:22:25Z`, source
`5d6461f4cd49a6aebb325dad88fe5efa3d3bd551`. All three Deployments are ready at generation 21 and both
CronJobs are unsuspended. The natural Fleet report observed `2026-10-18T04:25:10Z`, received at
`04:25:11Z`, confirms this source, ready release and clean reconciliation. Owner Chrome shows Fleet
ready/configuration consistent and Home all normal, including Newsletter. No reminder was dismissed.
The recovery is complete; this branch only records the evidence and minimal runbook, through branch
CI followed by the same green SHA on main. Root-document classification selects no application release.
See [host recovery](docs/rebuild.md#主机地址变化).

The owner excludes fixed DHCP leases as a requirement. No NetworkManager hook, timer, daemon, static
node address or new network layer was installed. Automatic address-change recovery remains unimplemented;
do not describe this verified manual recovery as preventing every recurrence.

### Native Tasks replacement (2026-10-18)

Branch `codex/tasks-native`, working checkout `/private/tmp/todofy-tasks-impl`. The native Tasks cutover was
verified at `77edb46915f6939675fa98e011dd21516738fdff`. Complete branch gate
[39086347716](https://github.com/ziyixi/todofy/actions/runs/39086347716) passed. The
[same-SHA main 39086983750](https://github.com/ziyixi/todofy/actions/runs/39086983750) verified Tasks → FlowDay →
Todofy → Home, with Deployments `7148421922`, `7148434459`, `7148449126`, `7148465493`. Its separate VPS job
stopped at `RELEASE_HELD` after the earlier `UNAVAILABLE`; it did not update the server. The host network
cause and original-release recovery are recorded above; the historical failure was not hidden or bypassed.

The final private, read-only source snapshot and empty post-export Sync delta were verified. Tasks contains
22 projects, 3 sections, 27 labels, 12 filters, 2,644 task resources and 2,824 completion occurrences with exact
ID/digest matches and no orphan parent/project references. No original Todoist task was changed. Planning's
identity preflight matched zero rows; no provider SQL was executed. FlowDay completed its native cursor sync;
all existing queue/time reference multisets stayed unchanged, including preexisting historical cache gaps.
The authorized synthetic owner task was created, edited, reloaded and immediately soft-deleted in Tasks.

The refinement adds native color/property/context menus, sidebar resizing, responsive editing, atomic family
duplication and search refreshes without blanking rows. GTD choices now live in Todofy's `plan_task_state`,
with task content in Tasks and queues/timers in FlowDay. The private conversion matched 310 planning states,
retired 19 exact technical labels and 11 replaced filters, and kept 8 ordinary labels and 1 filter. Task count
stayed at 2,653 through conversion. Imported filter colors are filled; no source snapshot was re-imported.
The native UI has no label mapping or extension key; legacy Plus ZIP publication is removed,
with its shared synthetic browser regressions retained. Mail saves a taskless summary; the owner explicitly
creates an Inbox task from the independent Mail page. Historical linked tasks are retained, and deleting Mail
does not delete Tasks. New native writes use generic protobuf Tasks requests, including atomic reorder, rather
than Todoist Sync commands. See [planning parity](tasks/docs/planning-parity.md).

The maintenance release [39085839713](https://github.com/ziyixi/todofy/actions/runs/39085839713) drained the old
writers before final metadata capture. Native state, exact retirement and 188 matching pending legacy Mail
entries are verified. The activation marker is set. Owner Chrome loaded Plan/Focus/Mail and native settings;
FlowDay shows Tasks connected and Sync complete, with no pending cursor page. All 103 queue, 15 completed
queue and 80 time references remain exactly unchanged. No real Mail conversion/deletion or task move was used
for acceptance. The one production synthetic task earlier remains soft-deleted.

Processing restoration [39087810767](https://github.com/ziyixi/todofy/actions/runs/39087810767) passed in full,
Deployment `7148606156`. Independent provider comparison verified all five Workers and persistent identities
against their declarations; all three actual switches are false. Owner serviceStatus reports no active jobs
and an armed future Alarm. The owner VerifyPlanStore API reports 310 state rows and zero orphans. The old
authenticated `/plus` bookmark redirects to Tasks settings. No post-resume natural Mail summary had completed
at the metadata observation; do not describe the synthetic pipeline check as a real incoming-mail check.

No application cutover remains. This closing documentation follows the normal branch gate and same-SHA main
flow. Before editing the original checkout, check for owner changes and fast-forward it if clean; its last
pre-closure observation was clean at `ca5c309e`. Do not repeat the initialized one-time conversion. Current
evidence: [Tasks verification](tasks/docs/verification.md).

The staged-release declaration failure was the missing Tasks wrapper enrollment, specifically BUILD_SHA:
release inputs already merge the secret fields. The corrected independent live comparison had zero differences.

Early refinement `cd3c6eab` was held by full branch CI before production. Three additive native Mail methods
retain old required-field contracts and the FlowDay assertion now uses generic read access. `533da462` exposed
Quick Add before account settings finish and a 0.2 KiB gateway review-budget excess. Released `77edb469` waits
for those settings, pins browser regression tests to UTC and reviews the bundle budget at 87 KiB.

The owner requested stopping both old acceptance reminders. The app confirmed deletion of heartbeat IDs
`automation` (website cron evidence) and `todofy` (email-model scheduler evidence) on 2026-10-17. Their missing
historical log evidence is not treated as a successful verification.

Todoist Plus is retired in the current refinement: Tasks hosts Plan, Focus and Mail, with native planning
facts and owner Access. Historical extension releases, pending old-source observations and owner Reload
steps are preserved in [the retired handoff](docs/history/todoist-plus-handoff-2026-10-17.md); they are not
new work or installation instructions. Shared synthetic regression coverage remains in CI.

Recall's mobile queue correction is released at `eb2c9187095f22eeac4ef2ae1e7e886b2e9076f3`.
[Full branch CI 38683400263](https://github.com/ziyixi/todofy/actions/runs/38683400263) and
[same-SHA main release 38684233200](https://github.com/ziyixi/todofy/actions/runs/38684233200) pass.
Only Recall Worker and extension publication ran. Deployment `7084275594` verified Worker
`149d88fd-06b5-4ac4-bcb2-601d1578196b` at `2026-10-15T04:59:28Z`. Published Orion version
`2026.1015.451 · eb2c918` has eleven files byte-identical to the green CI artifact; its ZIP digest matches
GitHub. `codex/recall-orion-reply-verification` closes root documentation only, without another app release.

The owner's fresh 337 report showed thirteen tab events, no Alarm, a valid visible probe and no capture stages.
The exact released 337 bundle reproduced that shape with finite events and unanswered injection completion:
no document through sixty seconds, first capture around seventy-one. Current-build listeners are now reused;
only missing/older listeners install. Desktop probe shape and document/URL/visibility/privacy checks remain.
Local 166 units, types/lint/build and sixteen built-WebKit cases pass; the content-result regression fails on 337.

The disposable native Mac fixture used the exact CI code with example.org/loopback scope and native APIs.
After example.org was granted Allow in native Permissions (other sites Ask), the strict loopback consumer
recorded two ordinary batches at `2026-10-15T05:06:18.110202Z`: one nonempty text document with a JPEG,
zero visits and zero diagnostic posts, before manual upload or reload. More than a minute later, the document
count remained one. Native settings showed unchanged capture with JPEG after four minute checks; the final
consumer recorded one ended visit as well. The temporary extension was removed (native manager empty), its
new tabs closed and its loopback consumer stopped (port closed). User Chrome files, real browsing content,
owner configuration, credentials and budgets were unchanged.

Pending: renew phone acceptance; the latest phone report still declares 337.
The independent `page_probe_invalid_reply_type` cause is not established by this queue correction. Do not claim
all native reply anomalies are fixed. [Diagnostic evidence](docs/recall-diagnostic-verification.md#october-14-recurrence-and-repeated-installation-delay).


Recall cleanup is released at `bc0adffdc1d8ee018b0663737c77e8de701de0aa`, extension `2026.1013.654`.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38359057094) and the
[same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/38359638951) pass. Only Recall and extension
publication ran; other app/image/VPS releases skipped. Deployment `7032157796` verifies Worker
`1b278c1f-4891-4ed0-a366-1bca48d1a443` at `2026-10-13T06:58:14Z`. Published ZIPs match every CI file: twelve
for Chrome and eleven for Orion, which no longer includes the unused desktop capture.js.

The cleanup removes obsolete save-phase polling, extra diagnostic-context messages and unused injection fallbacks.
Orion skips Chrome's disk-update marker. Required native callbacks/time bounds, independent settings writes,
guarded capture, deduplication, automatic upload, server backoff and the owner-started diagnostic remain.
Typecheck/lint, 164 units and fifteen isolated built-artifact WebKit cases pass. Independent review found no normal
capture/upload regression. No new dependency, IDL, storage, credential or budget change. Installed Chrome and phone
files were not updated; no phone experiment is requested. [Cleanup evidence](docs/recall-diagnostic-verification.md#cleanup-after-the-successful-phone-check).

The preceding real Orion `337` phone check confirmed automatic public-test text, JPEG and a 55-second ended visit
without Immediate Upload. It establishes the foreground repair, not a physical-phone run of cleanup `654`.
[Phone evidence](docs/recall-diagnostic-verification.md#october-12-ios-follow-up-automatic-text-image-and-visit-receipt).
Six empty old test connections were removed; the new phone install leaves two groups/three connections, preserving
recorded phone `45` and Mac `429`. Token names can change without rotation; same-name installs fold without merging
history. [Settings evidence](docs/recall-settings-verification.md).

The permission-button (`33ded73`) and startup-tracker (`d04501a`) experiments remain unmerged and unreleased;
the evidence did not justify them. Superseded Recall rollout details are in the
[dated archive](docs/history/recall-rollout-2026-10-12.md), not additional current tasks.

Mailsort flat English labels and Settings' classification-effect check are deployed at `4a48878`.
[Branch CI](https://github.com/ziyixi/todofy/actions/runs/38177634581) and the
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38177844303) passed; Deployment `7002296191`
verified Worker version `8fad8b3c-c3a0-4a91-856f-42aafe9bb6a0`. The authorized private production consolidation
completed on October 11 at 21:53 UTC: 15 internal categories became 12 active English labels. UI checks confirmed
current labels in the list, overview, undo filter and existing replay results, retained learning/settings, and live
mode with Gmail write access. The next natural sync was visible after completion. No production replay was started.
The owner excluded reverse migration and special historical undo; there is no new service or dependency.
[Operation and dated evidence](mailsort/docs/label-consolidation.md#2026-10-11-上线与生产整理) records the pending-label
fix, validation limits and intentional 140 KiB application bundle budget. CPU, model and Gmail write budgets did
not change. `codex/mailsort-label-verification` closes the documentation; no Mailsort implementation remains open.
Its docs-only `da3f519` then released identical code again, which is the latest Mailsort release (see below).

No implementation remains open from the October 11 maintenance task. `codex/maintenance-simplification`
landed at `ccf2c27`: concise handoff, checked test-only release exclusions and parsed YAML boundary assertions.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38161463808) and
[same-SHA main CI](https://github.com/ziyixi/todofy/actions/runs/38162014695) passed. Main skipped every app
release, image publication, VPS bundle and VPS deploy. Application settings and runtime code were unchanged.
[Maintenance evidence](docs/history.md#october-11-maintenance-simplification) records the local checks and scope.
The branch's final follow-up only records these verified results. Check for owner/agent changes before new work.

## Last verified releases

These are dated observations, not a replacement for current GitHub Deployment records or fresh Fleet/Home receipts.

| Scope | Verified result | Evidence |
| --- | --- | --- |
| CI structure, October 11 | `21c358f` passed branch CI and the same SHA on main. Local composite actions retain explicit job dependencies and release boundaries. Reconcile fell from 128 jobs to 18. | [Branch](https://github.com/ziyixi/todofy/actions/runs/38134080448), [main](https://github.com/ziyixi/todofy/actions/runs/38134511298), [reconcile](https://github.com/ziyixi/todofy/actions/runs/38134699837) |
| VPS, October 11 | Deployment `6994687990` verified Newsletter and Platform at `21c358f`, `phase=ready`. Their exact digests are in the archive. No Newsletter runtime changed in that release. | [Release evidence](docs/history/handoff-2026-10-11.md#done-2026-10-11-ci-workflow-structure) |
| Brief and Home, October 11/13 | `ebf33fe` deployed both applications. Brief's namespace is registered; Ops reports healthy. Read-only UI checks preserved `MODE=archive` and the owner's saved monthly budget of **$80**. Brief has not been redeployed since. Home was redeployed at `5134232` on October 13: Deployment `7050487447`, Worker `957e44a3-a32d-49a3-9087-2adbd4484df7`. | [Release](https://github.com/ziyixi/todofy/actions/runs/38132200435), [inventory/reconcile](https://github.com/ziyixi/todofy/actions/runs/38132419031), [detailed evidence](docs/history/handoff-2026-10-11.md#done-2026-10-11-brief-resource-registration-and-home-monitoring), [Home release](https://github.com/ziyixi/todofy/actions/runs/38469896460) |
| Recall, October 11/12 UTC | `de4d561` deployed the snapshot UI and seven-day hot files; CI includes real DO/R2 and fake-Dropbox cold reads. Updated extension passed real Chrome capture, visual-change and deduplication checks with an authorized temporary idle simulation, since removed. | [Release](https://github.com/ziyixi/todofy/actions/runs/38185811434), [verification](docs/recall-snapshot-verification.md), [runbook](recall/README.md) |
| Mailsort, October 11 | `4a48878` verified 12 English labels after production consolidation; live mode and existing learning/settings retained. The docs-only `da3f519` released identical code again and is the latest release: Deployment `7002434222`, Worker `cde09719-52a1-462b-8dd7-e6b894d36f17`, `2026-10-11T22:02Z`. Docs-only changes under `mailsort/` also release Mailsort. | [Release](https://github.com/ziyixi/todofy/actions/runs/38177844303), [`da3f519` release](https://github.com/ziyixi/todofy/actions/runs/38178679513), [dated evidence](mailsort/docs/label-consolidation.md#2026-10-11-上线与生产整理) |

The CI refactor exercised every Worker's production preflight/no-op but selected no Worker uploads.
On the next normal release of an affected app, check its verified provider receipt; do not deploy apps just to
fill that evidence gap. The checked recipes and local/branch dry-runs are recorded in the archive. The apps
still awaiting that check are listed under remaining observations below.

## Open acceptance

### Archived scheduler observations

The owner stopped both scheduled follow-ups on October 17. Their source evidence remains incomplete; do not
restart polling, reminders or permission requests. The records below are available for a later explicit request,
and do not imply natural scheduler provenance was established.

- **Todofy email models:** release `26c9662` keeps email/Canary on Lite 3.5, Flash 3.8, Flash 3.7; reports use
  Flash 3.8, Flash 3.7, Lite 3.5. A real synthetic Canary used Lite. October 5's Top 10 at `13:40:00Z` and summary
  at `13:40:19Z` both returned nonempty `ok` results from `gemini-3.8-flash`. The report ledger has no trigger
  source. Correlate the corresponding `todofy-core` Alarm invocation, time, outcome and version without reading
  report or task content. [Email-model evidence](docs/email-model-verification.md).
- **Website daily sync:** October 5 run `37295602784` and October 6 run `37448792826` match successful
  `SYNC_UNCHANGED` receipts in the daily 10:17 UTC window. Home showed the matching check time and Actions link;
  publishing was skipped. A manual dispatch can also carry the `cron` label, so correlate the relay's existing
  `daily_sync` log (`run_id`, `state`, `error_code`) to establish independent scheduled-controller provenance.
  [Website-sync evidence](docs/website-sync-verification.md). Do not alter reminder dismissal state.

### Owner decisions, 2026-10-15

Answered in chat; do not re-ask.

- The FlowDay Todoist key restoration recorded in the Plus verification was owner-authorized
  ([dated note](docs/todoist-plus-verification.md#installed-version-audit-and-weekly-planner-revision)).
- Recall keeps its seven-day cloud file window. `de4d561` deployed at `2026-10-11T23:55Z`; after about 2026-10-18,
  verify the first production file removal and one Dropbox cold read, recording metadata only, never page content.
- GTD additions: the Waiting list, the weekly review checklist and the Sunday-commit fix. The one-card
  Clarify queue was not chosen, so the checklist only counts the mail project's unplanned tasks and links it.
- Todoist Plus's weekly rollover stays on. Its first natural run is the ten-minute cron after Monday 2026-10-19
  00:00 US/Pacific (07:00 UTC). Afterwards observe it by metadata only (old-week batch drained, week start
  advanced, no error code), never task content.
  Controls: [weekly rollover and controls](todofy/docs/todoist-plus.md#weekly-rollover-and-controls).
- The 48 merged `codex/*` branches were pruned from origin after a local bundle backup, so branch names cited
  above as closing documentation no longer exist. The three unmerged Recall experiment branches remain:
  `codex/recall-permission-setup`, `codex/recall-startup-diagnostic` and `codex/recall-orion-permission-verification`.

### Waiting for the owner

- Install Recall Orion `2026.1015.451` on the phone; renewed phone acceptance follows it.
- Brief's recorded sender is `onboarding@resend.dev`, which delivers only to the Resend account's own address.
  Change it before any shadow or live sending.
- Verify the Claude Console workspace spend limit against Brief's stored $80 runtime budget; it is unverified
  (the original suggestion was $50).
- Dedicated Cloudflare tokens for the infra workflows and a fresh deploy token
  ([replacing the token](infra/README.md#replacing-the-token)); the infra workflows have not switched yet.

### Remaining observations and separate follow-ups

- `5134232` removed the direct `vars` expressions from the release composites; none remain under `.github/actions/`.
  Todofy and Home uploaded through them in [run 38469896460](https://github.com/ziyixi/todofy/actions/runs/38469896460)
  (Deployments `7050459573` and `7050487447`). The Mail Hero, Brief, Links, Watch, Fleet and
  website-relay composites have not yet been loaded by a real upload; their latest Deployments predate the `dd7a6e8`
  refactor. Check the first natural release of each; a preflight/no-op does not load the skipped composite.
- `Newsletter Content Config` failed after every main push from `b51413a` until `1e88aa3c` fixed it on 2026-10-15:
  the plan's compare with the oldest released engine passed the script's 2 MiB response cap; an oversized compare
  now cannot prove compatibility, so the plan ends not ready. The owner accepted the one Newsletter/Platform
  re-release ([main 38764957974](https://github.com/ziyixi/todofy/actions/runs/38764957974), VPS deploy passed); the
  following [content-config run](https://github.com/ziyixi/todofy/actions/runs/38765464322) passed.
- Brief's fresh Ops status and Actions inventory passed, but Home's daily REST Worker list still predates its first
  deploy. Observe the normal inventory starting **2026-10-12 02:00 UTC / October 11 19:00 PDT**; it should add Brief
  before the per-Worker checks finish. A usage refresh alone does not refresh this list.
- Brief still needs archive-day acceptance of source coverage, editorial quality and actual model cost. Local checks
  used fake Claude/Resend responses. Preserve archive mode and $80; sending, shadow-mode changes and Newsletter
  retirement require separate owner decisions. Topic `geo.earth` remains at the design's 熟悉 setting pending any
  owner change. See [Brief design §16](brief/docs/design.md) and [README](brief/README.md).
- Home's account-audit change reporting was deployed at `a3705ed`; the recorded follow-up is to confirm a completed
  daily check shows a qualifying dashboard change once as 非 CI 改动. The old handoff contains no final observation.
  [Recorded scope](docs/history/handoff-2026-10-11.md#in-flight-2026-10-06-claude-home-reports-account-changes-made-outside-ci).
- Bootstrap and safe drift repair are implemented and verified in the existing environment. Real empty-account /
  clean-VPS setup, physical DNS restoration, actual host-entry recovery and full historical data recovery remain
  separate exercises. Follow [the current rebuild runbook](docs/rebuild.md) and
  [its verification table](docs/rebuild-verification.md), which supersede the October 3 audit's implementation gaps.
- Older app acceptance has not been rechecked by this maintenance task: Watch's first real changed-watch digest,
  FlowDay's owner setup/device check before F6 retirement, and Newsletter's natural provider/send acceptance after
  its last business change. Use the app runbooks and fresh status before treating an old waiting item as still open;
  do not restart Compose, replay a send or request credentials solely from an archived note.
- Todoist Plus: review which planning-configuration methods belong with `ConfirmPlanMapping` among the
  owner-only methods.
- Recall: the free-tier storage and request cost estimates in [design §5.3](recall/docs/design.md#53-budgets)
  predate minute snapshots with screenshots and have not been redone.

## Operating boundaries

- Workers release independently from committed Wrangler configuration. `config/cloud.toml` is the public deployment
  profile; generated `config/resources.toml` records resource identities. Use the configuration/bootstrap tools and
  `infra/` for their declared resources. Preserve root mail records and unrelated resources.
- GitHub Actions actively deploys the Newsletter/Platform images by digest through the typed daemon API.
  It holds no SSH key or Kubernetes credential. All legacy Compose services are stopped; keep their retained data
  and do not restart their triggers. Newsletter remains an independent VPS service until the owner retires it.
- Mail Hero backup runs natively in Cloudflare through its existing DO Alarm and private R2. The old VPS backup
  collector is stopped. [Native backup](mail-hero/docs/native-backup.md) separates snapshot success from restore proof.
- Brief's paid Claude calls can run in archive mode, but email is disabled. The stored $80 budget is distinct from
  the code's initial default and any Claude Console limit; preserve it. Owner-supplied Claude/Resend keys never
  pass through GitHub. Workers Free and existing application budgets remain in force.
- Keep Home's persistent alert dismissal. Historical unknown business outcomes are not automatic replay permission;
  read-only Newsletter timeout rows were settled by their explicit migration. Follow current
  [dashboard-state semantics](docs/dashboard-state.md), not the archive's earlier alert instructions.

## Dated compatibility and retained data

The authoritative [compatibility table](docs/history.md#owner-api-compatibility) defines the old-client responses:

| Surface | Earliest removal |
| --- | --- |
| Mail Hero legacy owner routes | 2026-11-01 |
| Home, FlowDay and Todofy legacy owner routes | 2026-11-02 |
| Mailsort v1 owner routes | 2026-11-10 |

Keep Todofy core's `owner_api` RPC until the corresponding gateway compatibility window is complete.
Dates permit a reviewed follow-up; they do not schedule deletion or authorise changing frozen webhook bytes or
migrations. Todofy's retained host cutover snapshot stays through **2026-10-29**; deletion remains a separate action
([verification](todofy/docs/verification.md)). FlowDay F6 teardown also remains an explicit owner action even though
its original rollback window has elapsed.

## Working and maintenance entry points

- [CI/CD](docs/ci-cd.md#where-to-change-the-pipeline): job/recipe ownership, checks, release selection and failure navigation.
  Push a branch, wait for the complete gate, then promote the same green SHA. Rebase or new commits require new checks.
- [Rebuild](docs/rebuild.md), [Cloudflare bootstrap](tools/cloud-bootstrap/README.md),
  [VPS bootstrap/recovery](tools/vps-bootstrap/README.md), [infra](infra/README.md): current operating commands.
- [Documentation guide](docs/README.md), [architecture](docs/architecture.md), [service catalog](docs/service-catalog.md),
  [proto](proto/README.md), [contracts](contracts/README.md): canonical boundaries and application entry points.
- [History](docs/history.md) and [the archived handoff](docs/history/handoff-2026-10-11.md): previous releases,
  failures and recovery evidence. Keep completed details there when closing work here.
