# Watch page-evidence verification

Watch saves reading evidence so Dots can judge a page against a Work goal. It does not call a model or decide
business relevance. Ordinary typed rules, confirmations and Tasks notifications retain their own pipeline.

## What is stored

- HTTP captures preserve unmasked structured text, links and page metadata. Browser captures also save the
  rendered page's native accessibility tree and one 1280 × 960 viewport JPEG. They do not capture a full page or
  recursively extract frames.
- Reading text is capped at 256 KiB, structure at 64 KiB and JPEG at 1 MiB. Completeness and capture errors remain
  explicit. The latest 20 captures per Watch and current rule baseline/previous/pending references are retained.
- The existing SQLite DO indexes private R2 objects. Identical ready captures are reused, exact JPEG bytes are
  shared, and the existing Alarm reclaims expired and interrupted objects. No scheduler or database is added.
- `watch_read` pages stored text; `watch_view` returns real MCP image content. Evidence-change Work reports carry
  frozen before/after references even when ordinary rules suppress the difference. Health events remain separate.

## Local checks

Completed on 2026-10-23 using synthetic pages and local bindings:

- Watch's 127 unit tests and full 127-case workerd suite passed, including the existing CPU and SQL-row budgets.
  The native collector suite checks real HTMLRewriter extraction and the official browser client's boundary.
- Real SQLite/R2 tests verify visual-only capture changes, identical capture reuse, interrupted uploads, read-back,
  explicit unavailable evidence, owner edits during storage, independent raw-change events and physical cleanup.
  One additional focused case advances beyond 20 captures and confirms the pinned rule baseline survives while
  an unreferenced capture and its unique image are physically removed.
- The bounded evidence path was tested with 1,000 unrelated rows against limits of 500 reads and 80 writes.
- A focused outbox regression first reproduced evidence events evicting an undelivered ordinary digest. Retention
  now removes settled rows only. With 501 evidence candidates, the pending digest survives, both expired feed
  cursors are rejected, and the ordinary digest reaches Tasks once at its normal daily time. The affected
  notification, service and SQL-row runtime suites passed all 16 cases.
- An existing HTTP Watch without rich evidence fetches one full response before reusing its old ETag and
  Last-Modified. The legacy regression preserves source spacing and the normalized baseline, then verifies normal
  304 reuse and a later real change. Its unavailable historical `before_snapshot` stays empty. All 11 evidence
  runtime cases passed after the final fix; evidence plus the ordinary pipeline had already passed 43 cases.
- Browser Sessions reuse the existing slot with the Free plan's 20-second acquisition interval, including manual
  previews. This replaces the old Quick Actions 10-second value; no additional state or retry loop is introduced.
  A focused real-SQLite regression verifies deferral before 20 seconds, a launch at the boundary, and no ledger
  charge or false daily-exhaustion state while deferred.
  The provider's [current limits](https://developers.cloudflare.com/browser-run/limits/) and
  [Free allowance](https://developers.cloudflare.com/browser-run/pricing/) were checked on the release day.
- MCP's 71 unit and seven workerd cases passed, including real polling/callback transport, Unicode text windows,
  image content blocks and evidence-only source events. These tests do not prove native Dots image viewing.
- Watch UI's 33 tests, TypeScript, lint and build passed. Its JS gzip size is 53.5 KiB under the unchanged 56 KiB
  budget. Home's 279 unit cases, typecheck and lint passed after regenerating its declared-resource inventory.
- Proto lint, API lint/schema, config generation and the affected deployment/config tests passed. The official
  `@cloudflare/puppeteer` dependency adds browser protocol code: the intentional Watch bundle budget rises from
  140 to 300 KiB gzip. The actual dry-run is about 274 KiB gzip, below Workers Free's 3 MiB compressed limit.

The browser boundary tests exercise the package through a controlled client. Real Cloudflare Browser Run,
native Dots images and the complete source-event continuation are deployment acceptance, recorded separately.

## Rollout

1. Resource declaration `43f6c31dcbc41a583e75d65ee28d11a1825c22b4` passed full
   [branch CI 39941151337](https://github.com/ziyixi/todofy/actions/runs/39941151337) and reached main unchanged.
   Its first CI attempt timed out downloading the WebKit runner dependencies; rerunning that failed job passed.
2. [Infra apply 39943941218](https://github.com/ziyixi/todofy/actions/runs/39943941218) applied the reviewed
   `create=1,outputs=1@fa2eef776432` plan. Its only resource action created `watch-evidence`. The follow-up provider
   plan has 39 no-ops, zero actions and zero output changes. The new bucket exists before app activation.
3. Implementation `8af198951b5cd1fe9d61a8fe4c20beac680878b6` passed the full
   [application branch gate 39944068633](https://github.com/ziyixi/todofy/actions/runs/39944068633).
   Pending: the small follow-up gate, same-SHA main release, verified Worker/deployment identities and Home read-back.
4. Pending: update the existing private plugin skill without changing its App, OAuth connection or sharing;
   refresh the native tool catalog and verify saved text, a real screenshot and a source event in Dots.

Only public synthetic test pages may be used. Cleanup must pause the dedicated Watch, stop its scoped native
subscription and close its synthetic Work after reading the current source state. Existing user Watches,
extensions, operating switches, budgets and the owner's stopped Codex observations remain untouched.
