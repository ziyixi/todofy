# Recall rollout history, October 12, 2026

This preserves the superseded Recall handoff entries before the 337 release.
Old pending items and phone instructions describe their dates; current acceptance is in
[HANDOFF](../../HANDOFF.md) and [the diagnostic record](https://github.com/ziyixi/todofy/blob/4ed5091969021e9a7d53b7c97498d88e9d95898c/docs/recall-diagnostic-verification.md).

`codex/recall-orion-probe-fix` fixes two reproduced mobile capture delays and a reviewed privacy race. Established
capture uses the installed listener instead of repeating five-second injection waits. New snapshots and closed
visits upload immediately after persistence, outside serial state work, respecting existing server backoff; unchanged
captures send no empty batch. A guarded content command checks document, raw URL, build and visibility before
reading text; legacy unguarded reads are ignored. Eight fixed probe error codes replace the opaque result error,
and sending a diagnostic now retains recent error metadata. Desktop capture and installed Chrome remain untouched.
Inline empty-connection confirmation replaces the blocked native dialog; real local API deletion reduces only the
synthetic connection count and retains all visits. Local extension type/lint/build, 165 units and 15 actual WebKit
cases pass; web type/lint/build and 146 tests pass. The original published 45 demonstrably queues without automatic
upload and reads the new body's getter during a SPA race; the new body-read count is zero. WebKit now runs in CI
before artifact upload, using the extension's own locked existing Playwright version; CI policy tests pass (190,
one optional local skip). Mac native observation found undefined replies before public-site permission and valid
replies plus text/image afterwards; sender metadata is valid, so no sender/auth guard was relaxed. This is not iOS
proof. Pending: final candidate native check, branch CI/same-SHA release, six guarded empty-test removals and phone
acceptance of automatic text/image/visit uploads. Do not ask for desktop help for the old temporary IAB dialog.

Recall settings cleanup is released at `1ab7cfc9`. The live footer confirms that SHA: eight connections display as
two name groups with six old phone installs folded; old identities and timeline links remain separate. Empty
connection removal is guarded by stored visits/snapshots and pending count, with schema 6 adding only an index.
Token labels rename without rotating current/previous/Worker-secret credentials; Worker-secret-only credentials
have a direct rename menu. [Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38334672139) and
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38335237087) pass. Deployment `7028272346` verifies
Worker `1bcd9109-a612-4520-b0f0-35dc9d7a8fb4`; all other app/image/VPS releases and extension publication skip.
Local web 144 tests, worker 158 tests, relevant real-workerd CPU/scale and existing smoke pass. The real local UI
saves token rename and has no horizontal overflow at 390px. Production verification reads only Settings metadata.
No production credential or connection was changed; six empty test connections are folded and expose removal.
The synthetic empty-delete native confirmation blocked IAB tab 9; the owner is away, so do not require immediate
desktop help. Its preview process is stopped. The phone's recurring page_probe_invalid_result and screenshot/auto-upload
acceptance remain open; this release does not fix capture. `codex/recall-settings-verification` records release
and UI evidence in root docs only, with no further app deployment. See [verification](https://github.com/ziyixi/todofy/blob/4ed5091969021e9a7d53b7c97498d88e9d95898c/docs/recall-settings-verification.md).

Recall's injection-completion correction is released at `bafbac85` (`2026.1013.45`). The actual 1736 phone receipt
had eight tab events/two alarms, returned query+lookup and pending injection, without capture/store/screenshot.
New code consumes real Promise or callback completion; completion timeout alone asks the existing listener once.
Real API failures still stop and actual document/build/URL/visibility validation remains. No new permissions,
readiness state, channel, retry, proto or storage. Chrome remains untouched.
[Branch CI](https://github.com/ziyixi/todofy/actions/runs/38328527602), type/lint/build and 152 extension tests pass.
Twelve exact-CI WebKit cases pass, including missing callbacks with actual installed DOM listeners, Promise-only
completion, text/image/IDB/gzip and minute dedup; 1736 fails the new missing-completion regression.
Native Mac normal capture also passes: one nonempty document/image, two alarms and unchanged sampling, without
manual reload. This is a normal-native regression; missing-completion cases use the WebKit API bridge, not native iOS.
[Main release](https://github.com/ziyixi/todofy/actions/runs/38329158703) attempt 2 passes at the same SHA. First upload
succeeded but immediate verification still saw the old SHA; only the failed Recall job was rerun, without changing
checks. Deployment `7027350758` verifies Worker `88849e08-3452-4218-9285-60c53ea95a22`; unrelated deploys are skipped.
Downloaded release ZIPs each match all twelve corresponding CI files. The native manager is empty, the verified
test consumer is stopped and its port is closed. The real iOS 45 receipt now reaches visible focus, page/capture
replies and capture_store=saved despite pending injection completion. Its two queued items were not sent by the
content-free diagnostic. After the owner's single Immediate Upload click, the limited public-test search finds
one 40-second iPhone/Orion visit and one snapshot; the nonempty rendered reader contains 905 characters and no
screenshot element. The latest 45 device queue subsequently reports zero. This establishes real phone text and
visit ingestion/display after manual flush, not screenshot capture or unattended minute uploads. Direct bounded
metadata navigation was client-blocked, so no exact device-UUID/document join or byte count is claimed. Do not ask
for another reinstall or infer image support/failure from this run. See the dated phone receipt in
[verification](https://github.com/ziyixi/todofy/blob/4ed5091969021e9a7d53b7c97498d88e9d95898c/docs/recall-diagnostic-verification.md). The settings cleanup above is released; capture acceptance remains separate.

Recall's mobile deadlock correction is released at `1c1e0b5` (`2026.1012.1736`). Known event tab IDs and the current
span precede enumeration, with fresh active/visible/privacy checks; unanswered mobile callbacks release after five
seconds. The diagnostic-created ID enters the same capture path. No new permissions, proto, resources or retries.
[Branch CI](https://github.com/ziyixi/todofy/actions/runs/38284967839) and
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38295443553) pass. Local type/lint/build, 148 tests and
nine exact-CI WebKit cases pass; the same stalled-query recording regression fails on released 812.
Fresh real Orion Mac A/B also passes: 812 remains at zero content after its public-site grant, with injection pending;
1736 automatically uploads one nonempty document and one image, then an ended visit, without manual reload/restart.
Three native minute alarms leave document/image counts at one and report capture_store=unchanged. Actual native
options verifies 1736 and sends the report. Both downloaded release ZIPs match all twelve corresponding CI files.
Deployment `7021502888` verifies Worker `90d14ea6-052a-42eb-8045-defeb6bd05da`; every other app/VPS deploy is skipped.
Test extensions are removed, the exact consumer stopped and port closed. Owner Chrome remains untouched.
Phone iOS acceptance remains open: disable the old instance, load the new ZIP from file, Start, keep the public page foreground about
one minute, then Send. Do not infer phone success from Mac, heartbeat or an empty outbox. See
[verification](https://github.com/ziyixi/todofy/blob/4ed5091969021e9a7d53b7c97498d88e9d95898c/docs/recall-diagnostic-verification.md). The permission-button and startup-tracker experiments stay unmerged.
The settings cleanup above supersedes the earlier connection-list and token-name follow-up.

The earlier `codex/recall-permission-api-verification` records the native permission investigation; its proposed
permission-button release remains held.
The owner 812 receipt has 8 tab events, 2 alarms and only open-test-page/Alarm-setup results. A fresh native Mac
Orion test reproduced that pattern. Temporary closed phase observations showed state/mirror reads completing and
execution waiting in the native active-tab query. The browser displayed a site-access prompt for the public fixture.
Granting example.org access for one day and reloading the same test extension restored text/image uploads.
The actual published 812 files were then tested with the grant: its 09:47:30.794Z receipt has 11 stages, 13 tab events
and 3 alarms; uploads added one nonempty text document and one image. No private browsing content was read.
This establishes macOS behavior only. The owner could not find the proposed permission entry on iOS, and a full
Orion restart/public-page test still produced zero records. Do not describe the phone failure as a confirmed
permission issue or send the owner to a macOS-only menu. Current ZIP already declares required `<all_urls>`.
`codex/recall-startup-diagnostic` at `d04501a` passed CI but is unmerged and never released. Its proposed in-flight
tracker did not explain the native result, and a start/observe timing gap remains; do not promote it as a phone fix.
The test extension is removed, loopback consumer stopped and port closed. Owner Chrome and production remain unchanged.
The minimal native Mac probe returned `granted` through contains/request callbacks, but actual `executeScript`
of constant `42` in its newly created public tab remained unanswered. Granting only example.org for one day through
Orion's toolbar, refreshing options and creating the same public tab made that identical script return `[42]`.
This is native execution evidence that the standard permission reply does not open the Mac site-access gate.
It does not establish the iOS cause or an iOS fix.
`codex/recall-permission-setup` at `33ded73` keeps the direct Save-request experiment, unmerged and unreleased.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38236788381), local type/lint/build, 141 tests and twelve
WebKit cases pass. Those checks establish UI/save behavior, not activation of Orion's site-access gate. Do not merge
or publish this as a phone fix without native execution evidence. Keep ordinary Save simple in production.
Do not ask the owner to hunt for a Mac-only menu or repeatedly reinstall; owner Chrome remains untouched.


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
[Diagnostic evidence](https://github.com/ziyixi/todofy/blob/4ed5091969021e9a7d53b7c97498d88e9d95898c/docs/recall-diagnostic-verification.md) separates synthetic/native Mac checks from the phone
receipt already received; the follow-up above supersedes the earlier phone test instructions. Do not repeat them or
claim iOS capture is fixed.

The native Orion fixes from `codex/recall-orion-native-capture` are released at `88bbc3d` (`2026.1012.611`).
Real Orion macOS 1.1.3/build 152 now runs in a dedicated empty test environment, with a loopback-only
copy of the released extension and a synthetic HTTP consumer. Native callbacks reproduce two differences
missed by the synthetic bridge: a missing minute alarm is `null` (so `ensureAlarm` never creates it), and
file injection returns a valid page probe while the subsequent content-message callback is `null`.
Both fixes now have regressions that failed before correction; all 128 extension tests, typecheck and lint pass.
The fresh build was visibly imported as `2026.1012.601`. Real native Alarm/message/IndexedDB/image/gzip checks
received one text/JPEG document at 06:03:50.109Z, omitted the next unchanged snapshot, and received the ended
visit at 06:05:39.509Z. [Native evidence](https://github.com/ziyixi/todofy/blob/4ed5091969021e9a7d53b7c97498d88e9d95898c/docs/recall-mobile-verification.md) distinguishes this from the old fake bridge.
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
[Evidence and minimal phone check](https://github.com/ziyixi/todofy/blob/4ed5091969021e9a7d53b7c97498d88e9d95898c/docs/recall-mobile-verification.md),
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
stay blank. Capture/upload acceptance remains in [the mobile runbook](../../recall/docs/mobile.md).
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
[the mobile runbook](../../recall/docs/mobile.md). No new service or dependency. The measured 125.2 KiB Worker bundle
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
[Verification and its simulation boundary](https://github.com/ziyixi/todofy/blob/4ed5091969021e9a7d53b7c97498d88e9d95898c/docs/recall-snapshot-verification.md). No owner-input step remains
pending. No new service, dependency or budget change.

