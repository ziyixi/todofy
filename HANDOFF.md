# Handoff

Updated 2026-10-12. Keep this file focused on active work, open acceptance and dated compatibility constraints.
Move completed rollout detail to a dated record and link it here. Repository rules are in [AGENTS](AGENTS.md);
service entry points are in [README](README.md). Never put private content, credentials or raw production output here.

The complete previous handoff is preserved in [the October 11 archive](docs/history/handoff-2026-10-11.md).
Its old waiting lists and release identities are historical, not instructions to repeat completed work.

## Current work

`codex/recall-startup-diagnostic` repairs a reproduced observation gap in the one-shot tool.
The owner's 812 report arrived through normal authentication with 8 tab events and 2 alarms, but only
open-test-page and Alarm-setup results. No private browsing content or production credential was read.
The existing local SW harness reproduces that exact two-stage pattern when a native active-tab call hangs
before Start; the same hang after Start is visible as pending. This identifies a diagnostic gap, not the exact
native failing API on the phone. Track only in-flight fixed native stage names in memory, and snapshot those
already waiting at Start with an explicit historical flag. Do not restart the queue, add probes, retry native
calls, change privacy or touch owner Chrome. Local checks pass: 141 extension tests, 134 owner UI tests, focused real workerd diagnostic tests, and proto lint/API-lint/breaking/schema.
The built WebKit check now hangs the native bridge query before Start, verifies the historical marker and confirms
normal status/outbox are untouched. Full branch CI, final artifact checks and the Actions release are pending.

`codex/recall-mobile-diagnostic` implements the authorized one-shot Orion capture diagnosis.
The owner still reports no visits or samples on `611`, Orion 1.5.5 (3), iOS 27.0.1; heartbeat works.
It records closed stage metadata on a fixed public test page and sends an empty authenticated batch independently
of the capture queue. Only one latest report is retained through existing meta/status, with no content or credentials.
Chrome's running browser and installed extension files remain untouched. Local checks pass: 140 extension tests,
134 owner UI tests, 45 real workerd tests, typecheck/lint/build, protocol checks and the existing end-to-end smoke.
The real WebKit options harness passes eight cases, including Send while native query never returns. Real Orion
macOS returned eleven closed stages, a native minute alarm and a saved text/image capture through a strict loopback
consumer. That run exposed completed/foreground observations being overwritten on return; the small correction has
a regression. CI measured the requested UI at 62.2 KiB; its artifact budget is deliberately 64 KiB,
while Worker/runtime/cost limits remain unchanged.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38221876740) and the
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38222892688) passed at `3fb51d2`.
Deployment `7009598383` verified Recall Worker `9d200fff-7bb8-471a-b67f-878f4bf9ed0d`; other app deploys were skipped.
The exact CI artifact `2026.1012.812` passed eight WebKit cases and was visibly imported into real Orion macOS.
At 08:18:30.720Z the native consumer received eleven stages and three alarms; foreground/completed observations
survived returning to management. Synthetic uploads included nonempty text and an image, with the next unchanged
capture deduplicated. All files of both downloaded release ZIPs match the tested artifacts byte for byte.
[Orion ZIP](https://github.com/ziyixi/todofy/releases/download/recall-extension-v2026.1012.812/recall-orion-v2026.1012.812.zip).
The temporary Orion extension is uninstalled, the consumer stopped and its port closed. Chrome remains untouched.
`codex/recall-diagnostic-verification` records these receipts in root docs only, without another application release.
[Diagnostic evidence](docs/recall-diagnostic-verification.md) separates synthetic/native Mac checks from the phone
result still needed. Owner updates the existing Orion extension, Starts, stays on the public test page about one
minute, then Sends and reports back; no token rotation or uninstall. Do not claim iOS capture is fixed.

The native Orion fixes from `codex/recall-orion-native-capture` are released at `88bbc3d` (`2026.1012.611`).
Real Orion macOS 1.1.3/build 152 now runs in a dedicated empty test environment, with a loopback-only
copy of the released extension and a synthetic HTTP consumer. Native callbacks reproduce two differences
missed by the synthetic bridge: a missing minute alarm is `null` (so `ensureAlarm` never creates it), and
file injection returns a valid page probe while the subsequent content-message callback is `null`.
Both fixes now have regressions that failed before correction; all 128 extension tests, typecheck and lint pass.
The fresh build was visibly imported as `2026.1012.601`. Real native Alarm/message/IndexedDB/image/gzip checks
received one text/JPEG document at 06:03:50.109Z, omitted the next unchanged snapshot, and received the ended
visit at 06:05:39.509Z. [Native evidence](docs/recall-mobile-verification.md) distinguishes this from the old fake bridge.
No phone capture success is claimed. Native Mac checks cannot establish iOS lifecycle behavior.
[Branch CI](https://github.com/ziyixi/todofy/actions/runs/38211057207) and the
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38211415292) passed. Deployment `7007714439`
verified Worker `8c3b0ddc-2623-4509-b852-e978dfe24d5c`; Home release was skipped. The actual published ZIP has been
downloaded and visibly imported in Orion; its loopback test copy received a text/JPEG document at 06:22:46.218Z
and an ended visit at 06:23:40.801Z. Native content-message sender ID is explicitly `undefined`.
Root-docs-only branch `codex/recall-orion-native-verification` records these receipts; no further application
change or release. No credential changes. Owner explicitly requires leaving their active
Chrome and its installed extension files untouched; no Chrome interaction or installation update was performed.
The temporary Orion test extension was removed and its loopback consumer stopped; only local safe evidence remains.

Recall Orion content-message capture fix is released at `e397f51` (extension `2026.1012.429`).
The owner's `403` screenshot reports `page_probe_invalid_result`; it identifies an unusable probe result,
not the exact native shape or Orion implementation defect. The mobile path now ignores file-injection
completion and requests fresh visibility/text through callback-based `tabs.sendMessage`. One replaced top-frame,
own-extension listener preserves document identity; desktop behavior, privacy and deduplication stay unchanged.
All 127 extension tests, typecheck, lint and builds pass. The same corrected WebKit harness reproduces
`not_focused:page_probe_invalid_result` with downloaded `403`; it passes all six cases on the actual downloaded
`429` ZIP, including fresh DOM/JPEG, native IndexedDB/gzip, automatic alarms, one visit and no repeated snapshot.
The API bridge is synthetic, so phone capture/upload acceptance remains open. Do not infer success from heartbeats.
[Branch CI](https://github.com/ziyixi/todofy/actions/runs/38203713036) and the
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38204085384) passed. Deployment `7006529755`
verified Worker `e97a57e4-815e-4b9b-bd61-4424bc9298f2`; the live UI displayed `e397f51`.
Mac installation files were updated preserving settings; its running version was not independently read.
[Evidence and minimal phone check](docs/recall-mobile-verification.md),
[phone ZIP](https://github.com/ziyixi/todofy/releases/download/recall-extension-v2026.1012.429/recall-orion-v2026.1012.429.zip).
`codex/recall-orion-page-messages-verification` records receipts only; no further application change or release.
No new dependency, service, retries, token or budget change.

Recall Orion capture fixes are released at `fe419a4` (extension `2026.1012.403`).
Owner confirmed Save now works, but no sampling result appeared. Read-only production UI selected the phone device:
its timeline had no visits today or link to an earlier recorded day. The settings timestamp is a heartbeat, not
proof of content upload; there is no per-device document count in that view. Do not infer all uploads succeeded.
Callback-only MV2 tests reproduced `alarms.get` failing to read or preserve the minute alarm; the mobile path now
reads its callback. Mobile `tabs.onUpdated(status=complete)` retries the existing focus check after loading.
The built probe now reports page visibility with the MV2 callback instead of calling `.catch` on a void return.
The identical full WebKit chain failed against released `2026.1012.322` and passed the fixes: real built probe/capture,
native IndexedDB and JPEG, automatic alarms, native gzip, consumer text/visit receipt and unchanged-snapshot dedup.
Four Save checks remain. Only the extension API bridge and storage.local are synthetic; no evidence yet identifies
the owner's exact native Orion failure or proves live phone capture. Local status now exposes activity checks,
ongoing visit count, explicit not-yet-sampled state and fixed error codes without content. Heartbeat labels no
longer promise content upload. No new service, dependency, retry mechanism, privacy change or budget change.
Local checks passed: all 123 extension tests, all 133 web tests, typecheck/lint, both extension builds and the web build.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38202046041) and the
[same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/38202298241) passed. Deployment `7006241331`
verified Worker `337f8be9-879a-43ab-8021-106e2d50f983`. Both downloaded ZIPs verified `2026.1012.403` / `fe419a4`.
The exact downloaded Orion ZIP passed all six WebKit checks, with one text/JPEG document and one visit per capture
case, no duplicate snapshot and zero page errors. Re-running the same harness on the previous downloaded
`2026.1012.322` reproduced failure to enter focus after page-load completion. Production Settings showed build
`fe419a4`, the corrected connection labels and heartbeat explanation; only device metadata was read.
Mac installation files were updated while preserving identity/settings; its running version was not independently
read. [Phone ZIP](https://github.com/ziyixi/todofy/releases/download/recall-extension-v2026.1012.403/recall-orion-v2026.1012.403.zip).
The subsequent owner screenshot reports `page_probe_invalid_result`; this release did not establish phone capture. Pending actual phone capture/upload acceptance. Do not mark
that passed from local fixtures or from a heartbeat. Owner can browse normally after updating; check its timeline,
and if still empty use the new activity-check, sampling and fixed-error fields instead of another blind trial.
`codex/recall-orion-capture-verification` records these receipts; root documentation only, no further app release.

Recall's Save isolation and MV2 callback fixes are released at `5d476a0`.
The owner's screenshot of `354db53` proves phone mode now works but Save remains pending and token status is false.
A browser focus query can still hold the original global queue before settings write; the missing regression
failed on that code. Settings now use an independent write queue. Mobile tabs get/query/execute/capture use native
MV2 callbacks; the callback-only tests failed before the correction and now save actual synthetic text/JPEG.
No evidence identifies the exact Orion native call that hung on the owner's phone; do not present that as confirmed.
Save has a twelve-second unconfirmed state with a content-free pending-step diagnostic and keeps the pasted token;
status refresh after successful persistence cannot hold the button. No automatic retry or new credential is added.
Typecheck, lint, all 117 extension tests and both builds passed. An isolated real WebKit check of actual Orion
options + background scripts and native IndexedDB passed normal Save, blocked focus query, stalled local storage,
and stalled post-save status refresh. The browser API bridge remains synthetic; Orion/iOS lifecycle needs final
owner acceptance. The reusable browser check and its exact command are in the mobile runbook.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38199278131) and the
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38199601005) passed. Deployment `7005804573`
verified Worker `3668aa37-e6e8-436e-a07b-aae0c1329d82`. Both downloaded assets verified version
`2026.1012.322`, commit `5d476a0`. The actual downloaded Orion ZIP passed all four real WebKit/native IndexedDB
checks with zero page errors. [Phone ZIP](https://github.com/ziyixi/todofy/releases/download/recall-extension-v2026.1012.322/recall-orion-v2026.1012.322.zip).
Mac installation files were updated preserving its settings/identity; no running Chrome version was independently
read. Owner has since confirmed phone Save works; capture acceptance is tracked above. No new runtime dependency or service.

The earlier Orion phone-mode/upload-wait fixes were released at `354db53`. The owner confirmed the correct old phone artifact loaded
settings but selected desktop mode. The dedicated iPhone/iPad build now selects mobile mode directly; Save
acknowledges local persistence without waiting for the first upload. Both targeted regressions failed before fixing.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38197332604) and the
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38197579283) passed. Deployment `7005477101`
verified Worker `ab5b5c92-3185-4e0c-beac-33003215c162`. Both downloaded extension assets verified version
`2026.1012.252`, commit `354db53`, the correct desktop/phone modes and the Save fix.
[Phone ZIP](https://github.com/ziyixi/todofy/releases/download/recall-extension-v2026.1012.252/recall-orion-v2026.1012.252.zip).
Typecheck, lint, all 114 extension tests and both builds passed; the built options page also passed a synthetic DOM
click/progress/success, token clearing, mobile controls and validation-error check. Mac installation files were
updated preserving its identity and settings; its running version was not independently read from Chrome.
Actual phone acceptance remains: update the existing extension without uninstalling, set its retained `Chrome` label
to `iPhone`, then check Save confirms immediately and the environment says Orion · iOS. Previously saved token can
stay blank. Capture/upload acceptance remains in [the mobile runbook](recall/docs/mobile.md).
No new dependency, credential, retry mechanism, backend behavior or budget change.

Recall mobile and multi-device preparation is deployed at `0fe663a`: independent named upload tokens,
device-aware timeline/status, an Orion file-install build and bounded native JPEG fallback. Existing Chrome identity,
shared token, privacy rules, snapshot deduplication and the unified Dropbox archive remain.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38193778901) and
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38194203995) passed. GitHub Deployment `7004923541`
verified Worker `0c9f27be-d2c9-4556-8a7a-333b8a55d834`. Both extension assets are version `2026.1012.158`, built
from this SHA. Documentation follow-up `935254c` also ran the repository's Recall release rule successfully:
[main run](https://github.com/ziyixi/todofy/actions/runs/38194829673), then-verified Worker
`1f377641-0f18-4191-9ad9-6938f622b7c8`, Deployment `7005025557`; application code and extension assets are unchanged.
The Mac's stable installation files were updated with its existing key and settings retained; the
browser tool blocks extension-scheme URLs, so its newly running version was not independently read from Chrome.
Read-only production UI checks confirmed the existing public test snapshot still renders and an empty synthetic
device filter reveals no other device's visits. No production token was created or changed for testing.
Actual iPhone installation, visible/hidden events, capture and upload remain the short owner acceptance step in
[the mobile runbook](recall/docs/mobile.md). No new service or dependency. The measured 125.2 KiB Worker bundle
intentionally raises its code-size budget from 125 to 130 KiB; runtime, daily write and monetary budgets are unchanged.

Recall's personal snapshot update is deployed at `de4d561`: first capture after ten seconds, minute sampling,
viewport WebP, seven-day R2 files with FTS kept, and Dropbox reads for archived content. With unchanged text,
the approved 32×32 comparison skips minor picture changes and compares against the last saved image.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38185361002) and the
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38185811434) passed. The first release attempt
uploaded successfully but its version-detail read failed; attempt 2 verified version
`5ff5cde9-11cb-4160-97d6-04c7648b25c3`, Deployment `7003619381`. Extension `2026.1011.2346` is installed
and its displayed SHA was checked. On October 12 UTC, authorized temporary idle simulation in real Chrome
verified capture/upload/display, equal rendered reader text with changed scrolling screenshots, and no repeated snapshots:
three snapshots, newest at 01:08 UTC, despite a later eligible attempt at 01:10:21.453 UTC. Both stored and actual
idle were restored to `idle`, with no open visit; no formal privacy setting or application code changed.
[Verification and its simulation boundary](docs/recall-snapshot-verification.md). No owner-input step remains
pending. No new service, dependency or budget change.

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
