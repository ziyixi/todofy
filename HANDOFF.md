# Handoff

Updated 2026-10-15. Keep this file focused on active work, open acceptance and dated compatibility constraints.
Move completed rollout detail to a dated record and link it here. Repository rules are in [AGENTS](AGENTS.md);
service entry points are in [README](README.md). Never put private content, credentials or raw production output here.

The complete previous handoff is preserved in [the October 11 archive](docs/history/handoff-2026-10-11.md).
Its old waiting lists and release identities are historical, not instructions to repeat completed work.

## Current work

Todoist Plus board performance (owner-approved plan, items 1-5 of the October 15 research) is implemented on
local branch `claude/plus-perf-gtd`, based on `de8b93ac`; it is not pushed and has no branch CI or release.
Reads run in the background, confirmed write results merge without full loads, task lookups are indexed,
FlowDay task IDs survive worker restarts, native pages use ReadPlan plus an ID-only cache, and Review/Week
drags show at once with one pending card and one ordered write queue (the owner-approved rule change).
Planning protocol is now 3, so the normal update step applies: Reload in Chrome's extension manager and
refresh Todoist. Review fixes on the same branch make queue edits start from FlowDay's current queue and keep
remembered boards, label saves and pending cards read-only until confirmed. Local types, lint, build, 91 unit
and 14 built-MV3 Chromium cases pass; synthetic before/after measurements are in
[the verification record](docs/todoist-plus-verification.md#board-performance-branch-local-checks-october-15).
Pending: push, full branch CI, owner review, same-SHA release and the owner's real-account check of drag feel.
Research items 6 (backend metadata reads, measure first) and 7 (native observer, local trace first) remain open.

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


Todoist Plus's approved planning board is released at `bcd1d1426f7dcf16198d2e71aefddc62cd7a8a87`.
[Full branch CI 38546241155](https://github.com/ziyixi/todofy/actions/runs/38546241155) and
[same-SHA main 38547547283](https://github.com/ziyixi/todofy/actions/runs/38547547283) pass. Todofy and the
Plus ZIP published; other applications, images, VPS and Recall publication skipped. Deployment `7062548541`
verified core `8e11f818-526f-4613-ac05-2c8eff61b223` and gateway `6113d2c3-e6d6-4c22-96d8-c72bbc07d139`;
public hooks health independently serves the same SHA.

Bets are actual weekly-goal task marks above Review/Week. Stage drag changes only the selected planning
label; day drag writes only FlowDay queues; Focus runs today's confirmed queue/timer. UpdatePlanLabels binds
existing label IDs, keeps other roles and does not relabel tasks. Quarter is explicitly bound in the owner UI.
Date-only child candidates stay with their parent; explicitly different-stage children remain independent.
The obsolete WeekPlanner/TaskFamily and unused CSS are removed. [Internal design and six synthetic screenshots](todoist-plus/docs/planning-interface.md)
cover current behavior and API boundaries; [full verification](docs/todoist-plus-verification.md#approved-board-promoted-to-production-october-14)
separates tests, Chrome synthetic checks, actual deployment and remaining owner acceptance.

Version `2026.1014.598.48337` was downloaded from the actual public release. All seven files match the green
artifact, ZIP and existing `~/Documents/chrome_extensions/todoist-plus` directory. Two obsolete generated
assets were removed; directory identity, permissions and Chrome-stored connection remain. The only new
real task is one owner-authorized task; no existing task or real timer was manually changed. No other
credential, service or budget was altered.

**Pending:** owner Reload in Chrome's extension manager and Refresh Todoist. Tooling blocks that internal
page and alternate methods are forbidden. Do not ask for reinstall, folder changes or token rotation.
PWA and natural Monday rollover remain separate observations. Legacy FlowDay timer replace/clear stays
`RELOAD_REQUIRED` until at least 2026-11-13. `codex/plus-production-verification` only closes root docs and
HANDOFF; application files must remain unchanged so this closure does not publish another ZIP.

The earlier approved synthetic prototype is preserved in
[prototype verification](docs/todoist-plus-planning-prototype.md); its local goal text and stopwatch are
historical design evidence, while production uses Todoist/FlowDay APIs.

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

### Waiting for an existing permission request

Both follow-ups below are blocked on an owner permission request, which is already pending. Stay quiet while it
is unchanged: do not repeat denied queries, switch credentials or channels, recompute real content or substitute
manual triggers. Once permission is confirmed, read only the specified invocation/log metadata; if the old window
expired, observe the next natural task.
Update each verification document through the normal branch CI and same-SHA release, then stop its own follow-up.

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
- The `Newsletter Content Config` workflow has failed after every main push since `b51413a`
  ([first failure](https://github.com/ziyixi/todofy/actions/runs/38516577579); six runs through `1165411`): its plan
  step compares HEAD with the oldest released engine, and that compare now exceeds the script's 2 MiB response cap
  and raises. Nothing is lost (no content-config change is waiting; a config commit's own image skips the compare),
  but every run is red. The fix (an oversized compare cannot prove compatibility, so the plan is not ready) touches
  `newsletter/scripts/publish_content_config.py`, which CI releases as Newsletter and Platform, so it waits for the
  owner's choice.
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
