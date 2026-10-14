# Handoff

Updated 2026-10-13. Keep this file focused on active work, open acceptance and dated compatibility constraints.
Move completed rollout detail to a dated record and link it here. Repository rules are in [AGENTS](AGENTS.md);
service entry points are in [README](README.md). Never put private content, credentials or raw production output here.

The complete previous handoff is preserved in [the October 11 archive](docs/history/handoff-2026-10-11.md).
Its old waiting lists and release identities are historical, not instructions to repeat completed work.

## Current work

`codex/todoist-plus-week-planner` replaces the first Plus flat lists after the owner's actual Chrome audit.
The owner has installed and connected the released extension. Plan now expands outcomes/steps beside a
seven-day FlowDay board; Focus uses ordered duration blocks, parent paths and day switching. Day placement
only changes FlowDay queues, as the owner explicitly chose; Todoist due dates and Deadlines stay intact.
Native selection/spacing and locally collapsed utility favorites are corrected without editing account
favorites. The existing RolloverFlow method is narrowly allowed; same-day calls are rejected to avoid the
old destructive behavior. No new service or storage was added. Source and live evidence are in
[Plus verification](docs/todoist-plus-verification.md) and [the application checks](todoist-plus/docs/verification.md).

FlowDay's old migration had excluded its Todoist key. The existing credential was restored through the
normal owner UI and sealed by FlowDay; key-saved and Sync-complete states plus a fresh sync time were
observed. No key was generated, logged, committed or put in the extension. Real task content/priorities and
running timers were not changed by the audit.

Local checks pass: 26 extension cases, seven actual built-MV3 Chromium scenarios; FlowDay's 21 unit and
127 real-D1/runtime cases; gateway's 128 units and runtime CPU check; types/lint and proto lint/API-lint,
regeneration/schema/types. Real Chrome synthetic previews caught and removed a prototype-only layout
override. Weekly planner `ba149ec541136666ef1e25b5cbad4fa5ada574fe` passed branch CI 38503430909 and
same-SHA main release 38504086473; FlowDay, Todofy and Plus were published and verified, other application
publications and VPS/image releases skipped. A real synthetic Inbox parent/two steps proved creation,
today placement and Focus completion; all test tasks were completed afterward, with no timer started.
This check caught stale hidden App state on native-page return. The small extension-only follow-up
unmounts on native exit, refreshes on custom-view switches, and marks already-queued steps as In today;
its built-browser regression failed before the fix and now passes. Pending: follow-up branch CI/release,
place the tested artifact under `Documents/chrome_extensions/todoist-plus`, then owner loads/connects
that new directory for live drag acceptance.
Keep the current home-folder installation working until that switch; do not alter Chrome's private profile.


Todoist Plus is released at `51342322e473c4073bfb395a61c867995a9ac902` after
[full branch CI 38468696858](https://github.com/ziyixi/todofy/actions/runs/38468696858) and the
[same-SHA main release 38469896460](https://github.com/ziyixi/todofy/actions/runs/38469896460) passed.
Todofy, FlowDay, Home's binding inventory and the independent Plus ZIP were the only publications;
Newsletter, VPS, Recall and other services were skipped. The old release-composite `vars` parsing
error is corrected by inheriting the workflow's existing resolved environment. Operational switches
and secret inputs are unchanged. [Acceptance record](docs/todoist-plus-verification.md) has provider
receipts and distinguishes synthetic, packaged-browser and live evidence.

The live owner `/plus` page recognized all existing labels. Its mapping and Monday rollover were
confirmed on October 13; the page shows enabled in `US/Pacific`. The agent has made no real Todoist task edits or
extension credential issuance at this checkpoint. The owner completed the initial Chrome install and connection. Future directory changes still need
one manual load/connect step: browser tooling blocks Chrome's internal extensions
manager and forbids alternate control methods. The dedicated installation folder matches all seven
files of the published, CI-tested ZIP, version `2026.1013.1271.20788`. Do not replace Recall's folder.

Continue real Todoist synthetic task writes, FlowDay cross-view and PWA checks after the
new directory is loaded and connected. Preserve any real running timer. The first natural weekly rollover remains
a future observation, independent of synthetic scheduler tests. The old FlowDay timer replace/clear
methods return `RELOAD_REQUIRED` and stay until at least 2026-11-13.

The owner-page control styles are released at `d657985df185821a9154829db7c9bd214058ef1c` after
[branch CI 38471249025](https://github.com/ziyixi/todofy/actions/runs/38471249025) and
[main release 38472126635](https://github.com/ziyixi/todofy/actions/runs/38472126635) passed.
Only Todofy was published. All 93 UI cases, types and build pass; real Chrome confirms the existing
40-pixel green button and styled device input. The original one-time-token tab was preserved.
This presentation change leaves the published extension and API contract unchanged. The owner subsequently completed the initial connection; the new weekly-planning revision above
now owns the remaining release and installed-extension acceptance.

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
| Brief and Home, October 11 | `ebf33fe` deployed both applications. Brief's namespace is registered; Ops reports healthy. Read-only UI checks preserved `MODE=archive` and the owner's saved monthly budget of **$80**. | [Release](https://github.com/ziyixi/todofy/actions/runs/38132200435), [inventory/reconcile](https://github.com/ziyixi/todofy/actions/runs/38132419031), [detailed evidence](docs/history/handoff-2026-10-11.md#done-2026-10-11-brief-resource-registration-and-home-monitoring) |
| Recall, October 11/12 UTC | `de4d561` deployed the snapshot UI and seven-day hot files; CI includes real DO/R2 and fake-Dropbox cold reads. Updated extension passed real Chrome capture, visual-change and deduplication checks with an authorized temporary idle simulation, since removed. | [Release](https://github.com/ziyixi/todofy/actions/runs/38185811434), [verification](docs/recall-snapshot-verification.md), [runbook](recall/README.md) |
| Mailsort, October 11 | `4a48878` verified 12 English labels after production consolidation; live mode and existing learning/settings retained. | [Release](https://github.com/ziyixi/todofy/actions/runs/38177844303), [dated evidence](mailsort/docs/label-consolidation.md#2026-10-11-上线与生产整理) |

The CI refactor exercised every Worker's production preflight/no-op but selected no Worker uploads.
On the next normal release of an affected app, check its verified provider receipt; do not deploy apps just to
fill that evidence gap. The checked recipes and local/branch dry-runs are recorded in the archive.

## Open acceptance

### Waiting for an existing permission request

Both follow-ups below are blocked by the existing Cloudflare token's Observability/log-query permissions (403).
The owner request is already pending. Stay quiet while it is unchanged: do not repeat denied queries, switch
credentials or channels, recompute real content or substitute manual triggers. Once permission is confirmed,
read only the specified invocation/log metadata; if the old window expired, observe the next natural task.
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

### Remaining observations and separate follow-ups

- The October 11 Mailsort release exposed unsupported direct `vars` expressions in release composites. Its
  own action now inherits the existing workflow job environment. The same direct-expression pattern remains in
  `release-todofy`, `release-mail-hero`, `release-dashboard` and `release-brief`; those were not changed or deployed
  by this task. Review their input boundaries before their next actual upload; a preflight/no-op does not test
  loading the skipped composite.
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
