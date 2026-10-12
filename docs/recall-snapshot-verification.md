# Recall snapshot verification

Implementation: `de4d561f36473cc68b4bea0af3206241eec8b2b9`, October 11, 2026.

## Verified

- [Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38185361002) passed, including every proto user.
  Recall's checks cover 153 unit tests, 93 real DO/R2 runtime tests, 103 extension tests, 128 UI tests, deployment
  checks and the existing end-to-end smoke flow. Existing CPU, row and bundle budgets were retained.
- The focused regressions check changed captures on the same day, retrying after an empty/failed attempt,
  unchanged-text screenshot changes, omission of small visual changes, snapshot history, and retained FTS.
  The runtime suite checks exact screenshot bytes, confirmation of both archived blobs, R2 removal, and
  byte-for-byte text/image reads from fake Dropbox without refilling R2. This is local archive verification.
- [Main release](https://github.com/ziyixi/todofy/actions/runs/38185811434), attempt 2, verified Worker
  `5ff5cde9-11cb-4160-97d6-04c7648b25c3` at 100% with the implementation SHA. GitHub Deployment
  `7003619381` succeeded at `2026-10-11T23:55:41Z`. Other applications were skipped.
- Attempt 1 uploaded successfully but failed while reading version details. The same read later succeeded;
  the failed release job was rerun without code changes. No new retry mechanism was added.
- [Extension release](https://github.com/ziyixi/todofy/releases/tag/recall-extension-v2026.1011.2346)
  was installed into the existing stable folder. Chrome's settings page displays `2026.1011.2346 · de4d561`;
  the existing device settings and saved token remain in place.

## Chrome acceptance, October 12 UTC

The owner explicitly approved temporarily simulating `idle=active` in the extension's session state because
native automation did not reset Chrome's system idle timer. The installed release used real Chrome screenshot
capture, its natural minute Alarm, the existing upload and production detail UI. No application code or privacy
setting changed; no private browsing records were inspected.

- One public long page with a separate test query produced three snapshots, shown at `00:59`, `01:05` and
  `01:08 UTC`. The original tab/document was retained throughout; two scroll operations changed its viewport.
- The first screenshot loaded as a `1920×697` WebP, about 95 KiB. After the browser controller changed the
  viewport height once, the next two screenshots both loaded at `1920×655`. Those two images differed, and
  visual inspection confirmed the new scrolled content. The three rendered reader texts were exactly equal
  (rendered reader `.textContent.length=65178`), so the later captures preserved visual changes alone.
- The unchanged final viewport stayed in front for more than two minutes. A read-only lookup restricted to this
  test tab's visit confirmed `lastAttemptAt=2026-10-12T01:10:21.453Z`; the final detail still contained only the
  three snapshots, with the newest at `01:08 UTC`. No additional snapshot was saved during the later eligible checks.
- At the end, the extension's stored idle and Chrome's real idle both reported `idle`, with no open visit.
  DevTools was closed. The temporary simulation was removed, and existing credentials/settings were retained.

This completes capture, visual-change and deduplication acceptance under the authorized idle simulation. It does
not claim verification of physical-input idle transitions or an empty-body image page; those were not exercised.

Production seven-day cleanup and owner Dropbox cold reads have not been forced; real history was not altered
or aged for testing. They remain distinct from the local end-to-end archive evidence above.
