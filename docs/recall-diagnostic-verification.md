# Recall one-shot capture diagnosis

Work branch: `codex/recall-mobile-diagnostic`. The owner reports that `611` still does not capture on
Orion 1.5.5 (3), iOS 27.0.1. This change diagnoses that failure; it does not claim to fix phone capture.
The owner's running Chrome and installed extension files are excluded from native testing and updates.

## Behavior

The Orion options page has Start and Send controls. Start opens one fixed public test page; collection stops
after five minutes or when sent. A local result keeps at most twelve fixed stages plus capped event counts.
No URL, title, content, image, token, native exception text or general log string enters the diagnostic contract.
Navigating the test tab away stops collection and preserves its earlier observations; the regression failed before
the guard and passes after it.
Successful normal capture can still record the public test page through the usual privacy rules.

Send freezes the current observations and posts an empty business batch through the existing authenticated gzip
route. It does not join the focus queue or ordinary upload lock, consume the outbox, or alter upload backoff/badge
state. Failure keeps the local result. Start and Send UI waits are bounded, without guessing that a lost reply
means success. There is no retry service, new credential, endpoint, database table or continuous collection.

The Worker strictly validates closed values, bounds, unique stages and time ordering, then keeps one latest
report in existing meta. Ordinary heartbeats preserve it. The existing owner status exposes the receipt, device
identity and receive time; Settings shows details only when a report exists. Receipt is not capture success.

## Verified locally

- Worker lint/typecheck and 45 real workerd tests passed across diagnostics, ingest, owner API, devices, CPU
  and scale. Synthetic history, archive feed identity and R2 bytes remain unchanged by diagnostic-only ingestion.
  Unsafe fields, excess steps/counts, invalid values, mixed business items and missing authentication are refused.
- The real WebKit options harness passed eight cases using actual built scripts, native IndexedDB/image/gzip and
  a synthetic MV2 bridge. A non-returning query still sends the closed report with `items: []`, keeping the outbox.
  Native-null Alarm and absent sender fixtures remain explicit approximations, not iOS evidence.
- All 140 extension tests and 134 owner UI tests pass, with typecheck/lint/build. The owner UI renders pending stages
  as pending, without presenting capture as successful. The existing end-to-end smoke passes through real local
  Worker/DO/R2, extension upload, search, Dropbox archive and reading after R2 cleanup.
- A disposable copy of local build `2026.1012.743` ran in real Orion macOS 1.1.3/build 152. All native callbacks,
  events, storage, screenshot and network calls remained native. Only test identity, two loopback server constants
  and a test-only Start/Send invocation were added; the original business script body is recoverable byte for byte.
  The UI itself was exercised separately in WebKit. No production credential or browsing content was used.
- The strict loopback consumer received one diagnostic at **07:49:25.828Z** with eleven closed stages, one native
  minute alarm, a saved capture, object/array/string returns and `sender_identity=missing`. Ordinary synthetic
  traffic included a document and real image. No business items were attached to the diagnostic request.

This native run also exposed a diagnostic accuracy issue: restarting the background could replace completed
stages with fresh pending calls, and leaving the page could overwrite its foreground observations. The correction
preserves completed/foreground evidence. The regression and the full extension suite pass. The final artifact
confirmation is recorded below; the earlier local report is not evidence for that later correction.

## Permission investigation after the phone receipt

The owner sent an 812 report with eight tab events and two alarms, but only open-test-page and Alarm-setup
results. No real browsing content was read. A local SW simulation could produce that shape with an earlier
unanswered query; that was a hypothesis, not identification of the phone's failing API.

A fresh real Orion macOS installation then reproduced the same two-stage report. Temporary test-only observations
recorded fixed phase names and return-type categories, without altering native API results. An atomic snapshot
showed focus/session and mirror reads completing, entry into focus-target selection, and completion of the
query's diagnostic observation. The native active-tab query had not answered. The toolbar showed that the test
extension was not permitted on the public fixture and offered a website-access prompt.

After granting only example.org for one day and reloading the same extension, the consumer received nonempty text
and images. The current published 812 files were rechecked against the downloaded ZIP and visibly imported.
With the site grant retained, that version produced eleven stages at **09:47:30.794Z**, with thirteen tab events
and three alarms. Its run added one nonempty text document and one image beyond the recorded pre-import baseline.
The original script is recoverable byte for byte after removing test identity, loopback constants and owner
invocation. The temporary phase statements were not included in this final 812 check.

The proposed tracker on `d04501a` passed [branch CI](https://github.com/ziyixi/todofy/actions/runs/38227995048),
but was not merged or released. The native investigation exposed an observation/start timing gap; the branch is
not a phone fix. The test extension was uninstalled and the exact loopback process stopped; port 18793 is closed.
No owner Chrome files, production code, credentials or permissions were changed.

The owner reports no visible permission entry on iOS and no records after restarting Orion and testing the public
page. macOS permission behavior therefore cannot establish the phone cause. Official [website settings](https://help.kagi.com/orion/features/website-settings.html)
document per-site extension permissions for macOS; the [iOS extension guide](https://help.kagi.com/orion/browser-extensions/ios-ipados-extensions.html)
does not document that control. Do not invent an iOS menu path from the Mac UI.

The actual 812 MV2 manifest already declares required `<all_urls>`, tabs, webNavigation, alarms, storage and
unlimitedStorage; there are no optional permissions. A manifest declaration is distinct from actual browser access.
The [Orion API table](https://browser.kagi.com/WebExtensions-API-Support.html) lists permissions.contains/getAll/request
as supported on iOS, but does not establish their connection to Orion's website-access gate. Standard
[permission requests](https://developer.chrome.com/docs/extensions/reference/api/permissions#method-request) require
a user gesture and can request required permissions withheld by the browser. Any enable action must run directly
from that click, report the real answer and avoid treating a permission response as capture success.

## Unreleased permission experiment

The phone installer screenshot lists only browsing history and unlimited storage. The actual required host
declaration is already present; the screenshot alone cannot establish that Orion withheld website access.
A disposable native Mac fixture with only `https://example.org/*` permission returned `granted` callbacks from
contains, request and the subsequent contains. No API results were replaced. On returning to and refreshing the
public page, its toolbar still reported the extension not permitted there. An API grant therefore does not establish
that the website-access control changed. The toolbar alone also cannot prove actual script execution is blocked.

A second minimal fixture (1.0.1, ZIP SHA-256
`654164c4d604acd0cda7f8c55a0c8bccf9c86c76c24a5138420443441551c3c3`) checked actual execution. Its only permission
is `https://example.org/*`, with no background, storage, history or tabs permission. A button created a fixed public
tab and retained only its returned ID; another directly called native `tabs.executeScript` with constant `42`.
It did not query existing tabs or read content. After contains/request/contains all answered `granted`, script
completion remained unanswered beyond the eight-second observation window, including after visiting the target.
No website prompt appeared automatically. The toolbar's own prompt then granted example.org for one day. After
refreshing options and creating another fixed public tab, the identical sentinel callback answered and exactly
matched `[42]`, without another permission request. No native return values were replaced. This establishes a Mac
execution difference under the separate website control; it is not iOS execution evidence.
The native manager verified fixture version 1.0.1 before cleanup and an empty extension list afterwards.
The original ZIPs remain available locally; no owner Chrome interaction or installation update occurred.

The experiment on `codex/recall-permission-setup` (`33ded73`) directly requests the declared `<all_urls>` on Save,
before any await or background message. It is unmerged and unreleased.
Initial contains and request replies are shown separately from settings persistence and actual sampling.
Unavailable/error/nonboolean replies remain unconfirmed; after twelve seconds without a reply the UI says so,
keeps Save usable and avoids a second pending permission prompt. A late native reply may update that status.
An earlier contains reply cannot overwrite a later request result. Chrome compilation removes this permission
code; manifest, extension identity, capture core, upload, proto and backend remain unchanged.

Local typecheck, lint, build and 141 extension tests pass. The existing built-options WebKit harness passes twelve
cases. New cases exercise trusted submit ordering before the actual Save message, refused/error/missing/unanswered
permissions with native IDB persistence, initial-check timeout, stale initial replies and a late request reply.
The [full branch CI](https://github.com/ziyixi/todofy/actions/runs/38236788381) also passed. The bridge supplies
permission replies; these tests do not establish Orion iOS permission behavior. Keep the experiment out of production
until a native execution test establishes that it enables website access. No new phone download is requested.

## Release and phone boundary

### Event-path correction

The two-stage phone report exposed an application deadlock in addition to the unresolved platform behavior.
The first mobile focus initialization queried active tabs for a window ID that mobile selection did not use.
An unanswered callback held the serial focus queue indefinitely. Later events, capture and tick work queued behind
it; heartbeat, settings and the diagnostic's counters used independent paths. A native call started before Start
also carried no run identity, so its pending stage was absent from that diagnostic.

The correction uses event-provided tab IDs and the current span, with fresh active/visible/privacy checks, before
enumerating tabs. Known targets that cannot prove foreground state return no target. Mobile callbacks have a
five-second bound; no new retry mechanism is introduced. The created diagnostic tab ID feeds the ordinary focus
path even when native creation omits its URL. Existing native callbacks, minute tick, upload and deduplication remain.
No permissions, static scripts, proto fields or new production resources are added. Desktop calls retain their original path.
Regression tests failed before the corresponding fix and now save a real IDB visit, text and upload while native
enumeration never answers. Separate checks cover hidden/background pages, mirror resume and startup queue recovery.
Native Mac and final iOS results must be recorded independently; these application regressions do not prove phone success.

Full [branch CI](https://github.com/ziyixi/todofy/actions/runs/38284967839) passed for
`1c1e0b5bbf6f34bd825452c54d496070d23d5cac`. All 148 extension tests pass. The same WebKit recording regression fails
on actual released 812 and passes on the exact CI artifact `2026.1012.1736`, along with all nine existing options,
diagnostic and capture cases. It checks actual DOM text, native IDB, JPEG, gzip receipt and automatic minute dedup.

A fresh native Orion Mac comparison used independent test identities, only example.org/loopback host scopes and
the same disposable consumer. Business script bytes are recoverable exactly after removing the two loopback
constants and test owner invocation. No native API results were replaced. The helper invoked Start through the
unchanged owner handler; Send was clicked in native options. Neither run manually reloaded/restarted the extension.
The only website grant was example.org for one day, through the native toolbar prompt.

- Released 812 started at **18:59:35.395Z**. Its **19:01:38.796Z** pre-reload snapshot has zero ordinary uploads,
  documents and images. The native toolbar subsequently opened options without another permission prompt, confirming
  the grant. Send at **19:03:02.047Z** reports 21 tab events, three alarms, returned active-tab/lookup calls and pending
  probe injection; content counts remain zero.
- Exact CI 1736 started at **19:04:50.408Z**. Before any manual reload, the consumer had one nonempty text document
  and one image in the saved snapshot at **19:06:29.610Z**, and still one of each at **19:07:26.457Z**. Native options shows one local visit,
  JPEG and unchanged sampling. Send at **19:08:15.586Z** reports 21 tab events, three alarms and eleven stages;
  injection, capture and screenshot have returned, visibility is visible and capture_store is unchanged. The final
  ordinary uploads contain one document, one image and the ended visit. All times in this comparison are UTC.

[Same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/38295443553) passed. Both Recall Worker release
and extension release succeeded; all other app/image/VPS deployment jobs were skipped. Deployment `7021502888`
records verified Worker `90d14ea6-052a-42eb-8045-defeb6bd05da`, with latest status success at **19:08:12Z**.
The downloaded public Orion and Chrome ZIPs each match all twelve corresponding tested CI files byte for byte.
Orion ZIP SHA-256: `31faaed020049f97e208f48ff0490cef33cf588b3e5d736b55cb21f8022de5ac`.
[Published Orion ZIP](https://github.com/ziyixi/todofy/releases/download/recall-extension-v2026.1012.1736/recall-orion-v2026.1012.1736.zip).
The native manager verifies both tested versions and an empty list after cleanup; the exact consumer is stopped and
port 18793 closed. Owner Chrome was neither operated nor updated. iOS capture success still requires the phone's
next receipt; no permission menu path is prescribed.

### Phone injection completion follow-up

The owner sent the 1736 phone report after file installation. The Settings diagnostic card and device metadata
confirm version 2026.1012.1736: eight tab events, two alarms, returned query/lookup, pending injection and hidden
foreground selection. No probe reply, capture, screenshot or store stage was reached. No browsing body or private
website list was read. Connection and an empty queue do not establish successful capture.

A targeted test using actual released 1736 executes the real probe into WebKit and installs its listener, while
withholding only the injection completion callback. The product never sends its content request and captures nothing,
although an independent listener request returns the visible document. Returning a resolved native Promise without
calling the callback has the same failure. The earlier fixture discarded the callback value but always invoked it.
This establishes an application dependency/test gap; it does not prove that the phone installed its listener.

The scoped correction consumes a real Promise completion as well as a callback, once. A completion timeout alone
now proceeds to the existing bounded content request, whose actual response remains required. Genuine API errors
still stop; document/build/URL/visibility checks remain. No new message channel, readiness state, polling, permissions
or storage is added. Tests also require no content when the probe never installed. Native/exact-artifact release
checks and the next phone receipt remain to be recorded. Phone file-loading instructions now match the owner's
actual workflow; in-place update or identity preservation is not assumed.

### Initial one-shot diagnostic release

The first full branch run reached a UI size failure: 62.2 KiB against the previous 62 KiB budget.
The requested diagnostic view raises only that artifact budget to 64 KiB, with the reason recorded beside it.
Worker gzip remains 126.5 KiB within its unchanged 130 KiB budget.

The final [full branch CI](https://github.com/ziyixi/todofy/actions/runs/38221876740) passed for
`3fb51d25250d982ab49244bc7761987627bdff68`. The
[same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/38222892688) reused those checks and artifacts;
Recall deploy and extension publication succeeded. No other application deploy ran. Deployment `7009598383` records
Worker `9d200fff-7bb8-471a-b67f-878f4bf9ed0d` with status `success`, after running identity/configuration verification.

The exact CI files (`2026.1012.812 · 3fb51d2`) passed all eight WebKit options cases. A disposable loopback copy
was visibly imported as that version into real Orion macOS. Its strict consumer received a diagnostic at
**08:18:30.720Z** with eleven closed stages and three native minute alarms. `active_tabs` selected the test page;
`focus_target` remained visible; both current/stored visibility remained visible; sender identity was missing.
The completed Alarm answer remained `returned/object` after reloading the background. Ordinary synthetic uploads
contained one nonempty text document and one real image; the later capture reported `unchanged`. The diagnostic
itself contained no business items. Test-only Start/Send invocation is separate from the UI clicks exercised in
WebKit; no native API results were replaced.

Both actual release ZIPs were downloaded. All twelve files in each match the corresponding tested CI artifact
byte for byte; version and short SHA match. The desktop script contains no mobile diagnostic target.
Orion ZIP SHA-256: `cfd83dc2f0cb06ccfd72d20fe1836c931347396b9177f0f477ba63f33c62c46a`.
[Published Orion ZIP](https://github.com/ziyixi/todofy/releases/download/recall-extension-v2026.1012.812/recall-orion-v2026.1012.812.zip).
No owner Chrome installation update or Chrome interaction was performed. The disposable Orion test extension was
uninstalled (the native manager is empty), and its exact loopback consumer process was stopped; the port is closed.
Mac Orion and the WebKit bridge cannot establish iOS behavior. The subsequent phone receipt and permission
investigation are recorded above. No token rotation, repeated reinstallation or invented iOS menu path is required.
