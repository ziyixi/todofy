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

## Remaining browser acceptance

Native automation left the public Example Domain test page in front, but Chrome returned
`idle=idle, window_focused=true`. Its empty outbox therefore does not prove capture or deduplication.
The owner has been asked for actual mouse/keyboard input and two minutes on that public page.

After that input, upload normally and open only the prepared synthetic page's detail. Check the screenshot,
capture time and snapshot count across minute samples; then verify an image-only public page. Record actual
results here. Do not disable the idle/privacy rules or inspect private history to finish this check.

Production seven-day cleanup and owner Dropbox cold reads have not been forced; real history was not altered
or aged for testing. They remain distinct from the local end-to-end archive evidence above.
