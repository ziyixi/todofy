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

## Startup observation gap

The owner's phone returned the 812 diagnostic: eight native tab events and two minute alarms, but only
`open_test_page=returned/object` and `alarm_setup=returned/object`. No browsing content was read. A local SW
reproduction produces exactly that report when a native active-tab query hangs before Start; the same hang
started during diagnosis produces `active_tabs=pending`. This is evidence of an observation gap; it does not
identify the actual failing API on the phone.

The correction retains only unfinished native stage names in memory. Start copies their distinct names into
pending steps with `initially_pending=true`, labeled as calls already waiting when diagnosis began. This is a
historical start snapshot and carries no test-page selection. Native callbacks clear their own handle; an error
or duplicate finish cannot erase another unfinished call. The business queue, probes, callback behavior,
privacy gates and desktop path stay unchanged. There is no retry, additional native request or persistent log.

The pre-start regression fails against the old core and passes with this correction. All 141 extension tests,
134 owner UI tests and three focused real workerd diagnostic cases pass, along with typecheck/lint/build and
proto lint/API-lint/breaking/schema. The built WebKit check was strengthened to hang query before Start; it
verifies the historical marker in the UI and sent gzip while normal status/outbox remain unchanged.
An unanswered query does not display a guessed zero-match count. Full CI and the new artifact receipt are pending.

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

## Release and phone boundary

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
Mac Orion and the WebKit bridge cannot establish iOS behavior. The owner should update the existing Orion extension,
start one diagnostic, keep its public page foreground for about a minute, then return and Send. No token rotation or
uninstallation is needed. Only after the actual phone receipt arrives can the platform/selection/injection failure
be diagnosed from native evidence.
