# Recall Orion capture verification

Implementation: `e397f517349bd6d447eb6efff8a398b2a503442b`, October 12, 2026 UTC.

## Observed failure

The owner confirmed Save works, but the phone reported `page_probe_invalid_result` and no sampling.
Read-only Recall Settings showed the phone running `2026.1012.403` and reporting an extension error.
A connection timestamp can be an empty heartbeat; it does not prove capture or content upload.
The screenshot identifies an unusable probe result, not its native type or Orion's internal cause.

## Change and local checks

Orion now injects the existing top-frame probe to install a single content listener, then uses native MV2
`tabs.sendMessage` callbacks to request fresh visibility or text. It ignores file-injection completion values.
Reinjection replaces the listener while preserving document identity. Desktop keeps its file-result path.
The existing URL, password, foreground, build, document identity and snapshot deduplication checks remain.
No dependency, service, retries or budget setting was added.

- All 127 extension tests, typecheck, lint and both builds passed.
- The corrected isolated WebKit harness deliberately discards the file completion value. The downloaded old
  `403 / fe419a4` fails with `not_focused:page_probe_invalid_result`; this test does not assume frameId rejection.
- All six cases pass for the fix: four Save checks and two automatic capture paths. Each capture path reads
  updated DOM after listener installation, uploads one native JPEG/text document and one visit through native
  IndexedDB/gzip, and omits the next unchanged snapshot. Repeated injection keeps one listener; pagehide ends focus.
- The real WebKit DOM, scripts, image compression, IndexedDB and gzip are exercised. The native extension API
  bridge and storage.local remain synthetic. These results do not prove Orion's native API behavior on the phone.

## Release evidence

- [Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38203713036) passed.
- [Same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/38204085384) passed. Deployment `7006529755`
  verified Worker `e97a57e4-815e-4b9b-bd61-4424bc9298f2`; Recall's live UI displayed `e397f51`.
- Both downloaded release ZIPs verified version `2026.1012.429` and commit `e397f51`. The exact downloaded Orion
  ZIP passed all six WebKit checks above, with discarded completion, standard message replies and no page errors.
- Mac installation files were updated in the existing folder, preserving identity/settings. Its running Chrome
  version was not independently read.

[Orion ZIP](https://github.com/ziyixi/todofy/releases/download/recall-extension-v2026.1012.429/recall-orion-v2026.1012.429.zip).

## Phone acceptance still open

Update the existing extension without uninstalling or generating another token. Browse one public page in the
foreground for twenty seconds, then use the existing Upload now button. Confirm a sampling result and check the
phone's actual timeline entry. Read-only verification must not open private page bodies for diagnosis.
No phone capture or upload has yet been accepted for this release. A successful local fixture, empty queue or
heartbeat does not close that acceptance.
