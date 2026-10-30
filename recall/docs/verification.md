# Recall verification

What was actually tested, by date. Only public or synthetic pages were used; no private browsing record, page
text, image, credential or device ID is recorded here. Real macOS Orion and the WebKit harness (real DOM,
IndexedDB, image encoding and gzip behind a synthetic extension API bridge) never stand in for iPhone results.
Current behaviour is in [design](design.md) and [mobile](mobile.md); the run-by-run records this page condenses
are in the repository history at `4ed50919` (`docs/recall-*-verification.md`).

## Snapshots and hot files

2026-10-11/12, `de4d561`. CI checks exact screenshot bytes, confirmation of both archived files, removal from R2
and byte-for-byte text and image reads from a fake Dropbox without refilling R2. In real Chrome, under an
owner-approved temporary idle simulation, one public long page produced three snapshots: the later two kept
visual-only changes while the text stayed identical, and an unchanged viewport added none in the following
minutes. Physical-input idle transitions and an empty-body image page were not exercised. The first production
removal after seven days and a Dropbox cold read were not forced.
Evidence: [release](https://github.com/ziyixi/todofy/actions/runs/38185811434).

## Connections in settings

2026-10-12/13, `1ab7cfc` and `566858e`. Connections are grouped by name with old same-name installations folded;
an upload credential can be renamed without a new token, and a 390px page has no horizontal overflow. Removal is
an inline two-step confirmation; the server checks visits, snapshots and the last reported queue before deleting
only the connection row, never a token or record. Six empty phone test connections were removed this way in
production; the recorded connections and every credential remain.
Evidence: [release](https://github.com/ziyixi/todofy/actions/runs/38343212917).

## Orion capture

2026-10-12 to 10-15. Each correction below has a regression that failed before it, and the published Orion ZIP
matched the tested CI files byte for byte:

- `2026.1012.611`: Orion answers a missing Alarm with `null` and sends internal messages without a sender ID.
  A `null` Alarm counts as missing; a missing sender ID is accepted and a foreign one still refused.
- `2026.1012.1736`: an unanswered active-tab query held the serial focus queue. Selection uses the event's tab ID
  and checks the page is active and visible; mobile callbacks are bounded at five seconds.
- `2026.1013.45`: injection may complete through a Promise or a callback, once; a missing completion proceeds to
  the bounded content request, whose actual answer is still required.
- `2026.1013.337`: capture reuses the current document's listener and reads only the expected document; a newly
  stored snapshot or ended visit uploads at once.
- `2026.1015.451`: reinstalling the probe on every focus check starved the queue when completion never arrived
  (content after about 70 seconds instead of 12). Focus asks the existing listener first.

The one-shot diagnostic sends only closed stages, counts and fixed reason codes; its receipt is not capture
success. The current phone build retains that optional diagnostic. On macOS, an API permission grant did not change
Orion's per-site access: scripts ran only after the toolbar's grant. That observation does not establish an iOS
permission flow.
Evidence: [`451` release](https://github.com/ziyixi/todofy/actions/runs/38684233200).

## Phone evidence

- `2026.1013.45` (2026-10-12 PT): one public test page's text and visit arrived after one manual upload; no
  screenshot.
- `2026.1013.337` (2026-10-12 PT): text, a JPEG screenshot and the ended visit uploaded automatically, without a
  manual upload, in one foreground test.
- 2026-10-14: the same `337` phone reported `page_probe_invalid_reply_type` with no text, screenshot or stored
  capture. `451` fixes the reproduced queue starvation; its phone acceptance is pending, and the cause of the
  malformed reply is not established.

iOS background and suspension behaviour is not established; mobile recording is foreground-only.

## Build-migration checks

The Bazel extension units, real typecheck, ESLint and pinned WebKit options/capture check passed locally with
synthetic input. The Worker smoke chain also passed against local workerd and fake Dropbox. This confirms the
local build/test path, without installing an extension or reading real browsing data. Final Linux CI and main
publication remain [current handoff](../../HANDOFF.md) acceptance. Phone acceptance remains paused by the owner.
