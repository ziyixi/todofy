# Recall Orion capture verification

## Native reproduction, October 12, 2026 UTC

The owner's phone still failed on `2026.1012.429 / e397f51`: no activity check, local visit or sample was shown.
Earlier WebKit checks used a synthetic extension API bridge and did not establish native Orion compatibility.
A successful connection or empty upload queue is not proof of captured content.

Orion macOS **1.1.3/build 152** was installed from Kagi's official full macOS package into Applications.
The small installer repeatedly failed in its updater; the full browser launches normally. No browsing data or
credentials were imported. All native checks used one window and a synthetic loopback article/HTTP consumer.

A temporary copy of the actual released `429` ZIP kept the business scripts, replacing only the two server
constants and its test identity/host permissions. Observers passed through real native callbacks and events;
they recorded types, booleans and counts, never URLs, page text or credentials. Synthetic credentials stayed local.

| Actual native observation | Consequence |
| --- | --- |
| Missing `alarms.get('tick')` replies `null`, with no `lastError`. | The `undefined`-only check never creates the minute Alarm. |
| `tabs.executeScript` replies with a valid probe; the following content-message reply is `null`. | File execution itself works in this Mac check. |
| The content listener receives the request, has its own runtime ID, receives no string sender ID, returns `false` and never calls `sendResponse`. | The exact sender-ID guard rejects Orion's internal message. |
| The local consumer receives only empty heartbeat batches. | The native failure reproduces the phone's connection-without-content symptom. |

The baseline ZIP and content-free diagnostics were retained locally before changing source.
Native Mac reproduction identifies concrete compatibility bugs; it does not prove the phone has identical API values.

## Minimal correction and checks

- Treat `null` and `undefined` as a missing Alarm; keep an existing Alarm.
- In the Orion top-frame content listener, accept the optional missing sender ID and still reject a present foreign ID.
  Background settings/control and visibility authentication remain unchanged. Chrome documents `tabs.sendMessage`
  as routing to the current extension's content scripts, and `MessageSender.id` as optional.
- Preserve the existing URL exclusions, password/foreground/build/document checks, screenshot limits and deduplication.
  No new service, dependency, retry mechanism, permissions or budget change.

Both targeted regressions failed before the corresponding fix. All **128 extension tests**, typecheck and lint passed.
The compiled-script regression checks a genuinely absent sender property and retains foreign-ID rejection.

The fresh corrected build was imported into real Orion and verified in its native extension manager as
`2026.1012.601`. The temporary observer still used real extension APIs, IndexedDB, screenshot encoding and gzip:

- A natural native Alarm fired and probe/capture messages returned valid current-page objects.
- At **06:03:50.109Z**, the consumer received one synthetic text document and one actual JPEG, verified from its bytes.
- Another native screenshot/capture at **06:04:39Z** created no second document for the unchanged page.
- Navigating away ended the visit; at **06:05:39.509Z**, the consumer received one visit and no new document.

This is native browser evidence, not a fake API success. Observers and the synthetic seed can affect event-page
lifetime; iOS app switching, suspension and screenshots still need phone acceptance. Temporary test code is not shipped.

## Release and phone acceptance

The correction is on `codex/recall-orion-native-capture`; branch CI and same-SHA Actions publication are pending.
No new phone trial is requested until the published package has been checked locally.

After publication, update the existing phone extension from its file-import/update entry without uninstalling or
creating another token. A final public-page check must confirm an actual sample and a matching phone timeline entry.
No phone capture/upload success has yet been accepted. Previous `429` release and synthetic checks remain historical
at [its Actions run](https://github.com/ziyixi/todofy/actions/runs/38204085384).

References: [Chrome tabs.sendMessage](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage),
[MessageSender](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender).
