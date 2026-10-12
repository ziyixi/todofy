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
preserves completed/foreground evidence. The regression and the full extension suite pass. Published-package
confirmation is recorded below once complete; the earlier local report is not evidence for that later correction.

## Release and phone boundary

Full branch CI, same-SHA Actions publication and downloaded-package confirmation are pending.
Mac Orion and the WebKit bridge cannot establish iOS behavior. The owner should update the existing Orion extension,
start one diagnostic, keep its public page foreground for about a minute, then return and Send. No token rotation or
uninstallation is needed. Only after the actual phone receipt arrives can the platform/selection/injection failure
be diagnosed from native evidence.
