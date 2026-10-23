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

## Automated checks

Completed on 2026-10-23 using synthetic pages and local bindings; the final branch CI repeated these checks:

- Watch's 127 unit tests and full 133-case workerd suite passed, including the existing CPU and SQL-row budgets.
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
  304 reuse and a later real change. Its unavailable historical `before_snapshot` stays empty. The final evidence
  runtime file passes all 13 cases.
- Browser Sessions reuse the existing slot with the Free plan's 20-second acquisition interval, including manual
  previews. This replaces the old Quick Actions 10-second value; no additional state or retry loop is introduced.
  A focused real-SQLite regression verifies deferral before 20 seconds, a launch at the boundary, and no ledger
  charge or false daily-exhaustion state while deferred.
  The provider's [current limits](https://developers.cloudflare.com/browser-run/limits/) and
  [Free allowance](https://developers.cloudflare.com/browser-run/pricing/) were checked on the release day.
- The existing preview cache excludes the new reading-evidence object from its SQLite metadata. A regression
  reproduced a JPEG becoming a large numeric JSON object; after the one-line fix, metadata stays below 2 KiB,
  the cached HTML round-trips exactly, and the seven existing preview runtime cases pass.
- MCP's 71 unit and seven workerd cases passed, including real polling/callback transport, Unicode text windows,
  image content blocks and evidence-only source events. These tests do not prove native Dots image viewing.
- Watch UI's 33 tests, TypeScript, lint and build passed. Its final CI JS gzip size is 54.0 KiB under the unchanged 56 KiB
  budget. Home's 279 unit cases, typecheck and lint passed after regenerating its declared-resource inventory.
- Proto lint, API lint/schema, config generation and the affected deployment/config tests passed. The official
  `@cloudflare/puppeteer` dependency adds browser protocol code: the intentional Watch bundle budget rises from
  140 to 300 KiB gzip. The final bundle checker measures 273.7 KiB gzip, below Workers Free's 3 MiB compressed limit.

The browser boundary tests exercise the package through a controlled client. Real Cloudflare Browser Run,
native Dots images and the complete source-event continuation are deployment acceptance, recorded separately.

## Rollout

1. Resource declaration `43f6c31dcbc41a583e75d65ee28d11a1825c22b4` passed full
   [branch CI 39941151337](https://github.com/ziyixi/todofy/actions/runs/39941151337) and reached main unchanged.
   Its first CI attempt timed out downloading the WebKit runner dependencies; rerunning that failed job passed.
2. [Infra apply 39943941218](https://github.com/ziyixi/todofy/actions/runs/39943941218) applied the reviewed
   `create=1,outputs=1@fa2eef776432` plan. Its only resource action created `watch-evidence`. The follow-up provider
   plan has 39 no-ops, zero actions and zero output changes. The new bucket exists before app activation.
3. Final implementation `f7942fb6b10b5557088324b1da8c3e31e808feca` passed the full
   [branch gate 39950244799](https://github.com/ziyixi/todofy/actions/runs/39950244799) and
   [same-SHA main release 39952782780](https://github.com/ziyixi/todofy/actions/runs/39952782780).
   Only Watch, Personal MCP and Home uploaded new Workers. Their provider identities were read back before
   the successful GitHub Deployment records below were written.
   One pre-release Tasks check hit its 15-minute job limit after Ubuntu dependency downloads took 8m18s. The CI job limit
   is now 25 minutes; test cases and application CPU/SQL budgets are unchanged.
4. [Final Infra drift 39952857265](https://github.com/ziyixi/todofy/actions/runs/39952857265) is green:
   39 no-ops, no resource actions and no output changes. Home's deployed R2 section lists
   **Watch 页面证据与截图** under 网页监视, without an unregistered marker.

| App | Verified Worker version | Successful Deployment |
| --- | --- | --- |
| Watch | `bc0f6229-d938-451a-a0a4-f6be347ceda9` | `7278082840` |
| Personal MCP | `b9eafbb0-469e-4a42-a0cc-3e584cd96a80` | `7278098682` |
| Home | `f40b0ac4-8fc2-4f8d-8484-cc5c730045e3` | `7278122009` |

## Native client and saved image

The existing private Personal Cloud plugin is `1.3.0`, release
`pluginrel_6adb523b6668819196094e6ee58757f5`. Read-back matches the repository skill exactly; the App binding,
full manifest presentation and private audience are unchanged. Its existing OAuth account stayed connected.
**Refresh tools** exposes 14 write tools, 22 read tools and six event types. The same existing Dot sees
`watch_read` and `watch_view` and actually reads the final implementation SHA through `connection_status`.
No Reboot or additional login was needed.

Only synthetic Work `50f1e57a-41ef-4af5-864a-c81c25251d63` and dedicated Watch
`watches/w-81e56b36-1580-4dbd-bd6b-3224b3dde6de` were created. The Watch uses browser mode, a 360-minute
interval and `NONE`; its Work link was read back as owned. No preview or repeated forced fetch established this
baseline. Real Browser Run captured the public example page at `2026-10-23T12:29:42.098Z`, HTTP 200:

`watches/w-81e56b36-1580-4dbd-bd6b-3224b3dde6de/snapshots/0mvky672qdlxbv9z`

The native Dot actually called `watch_read` for Markdown and structure, then `watch_view` for its real MCP image.
It read 958 Markdown characters and 1,182 structure characters, with no unread window. Content and image are
available, capture truncation is false, and both error fields are empty. The saved JPEG is 1280 × 960. The Dot
described the book icon, pale background, multilingual paragraphs and blue underlined Learn more link.
The production owner UI independently loaded that same saved JPEG with `complete=true` and natural size
1280 × 960. Text, structure and screenshot remain separate from the ordinary rule comparison.

## Source-event continuation

The native host saved one temporary `work.attention` subscription filtered to the synthetic Work. Its receipt
has `condition_watch`, `X-UNSCHEDULED:1`, enabled and no next run; its real native ID was retained privately.
No periodic routine was created and the existing hourly Work review was preserved.

After the Dot finished that setup turn, the independent MCP client changed only the dedicated fixture's URI
to the IANA explanation linked by its saved baseline, preserving browser mode and `NONE`. One explicit source
check was queued through the existing operator API while Home's guard stayed active. The attempt at
`2026-10-23T12:44:45.350Z` timed out. The source recorded a failed check and retained the earlier successful
snapshot; it did not turn the failed fetch into an unchanged result.

For the event transport test, the independent client then selected the already verified public example page
with a second QA query marker. Browser mode, `NONE`, budgets, guard and timeouts stayed unchanged. Its explicit
check respected the existing interval and completed at `2026-10-23T12:59:47.541Z`, HTTP 200. The ordinary rule
correctly reported unchanged text, while the raw evidence feed recorded the changed source URL. The new snapshot
is `watches/w-81e56b36-1580-4dbd-bd6b-3224b3dde6de/snapshots/0mvkz8w5xt63nxmy`.
At `2026-10-23T13:00:35.965Z`, Work ingested source report `watch:1`, sequence 9, with the first and second
snapshot references frozen as before/after. This controlled URL-metadata change tests source-event transport,
not a website editing itself; the visual-only change path is covered separately by the automated real-storage
regression. No manual `work_report` was used to manufacture the source event.

The existing Dot resumed from the real `work.attention` event
`work_50f1e57a-41ef-4af5-864a-c81c25251d63_9`, without another user message or manual report. It actually read both
frozen Markdown captures and both MCP images. Text and JPEG SHA-256 were identical; it correctly identified the
controlled source-URL change. Independent Work read-back confirms sequence 9 handled and no pending reports.
Its first turn saved the judgment as a fact because it mistook `change_ref` for an ordinary-rule change only.
The existing published contract, skill and regression already allow a real snapshot reference in that field;
after clarification it saved a `watch_review` entry at `2026-10-23T13:03:58.426Z`, sequence 11, with the real after
snapshot as `change_ref`, `verdict: relevant` and a reason tied to the synthetic acceptance goal. Independent
read-back confirms those structured fields. The earlier fact remains in history. This follow-up clarified the
existing contract; it added no field, code change or fabricated ordinary-rule change.

Cleanup completed at `2026-10-23T13:04:27.673Z`:

- The native temporary responsibility returned success and `is_enabled=false`; MCP read-back shows zero
  subscriptions and zero pending deliveries. The actual source event was accepted on its first delivery.
- The dedicated Watch reads `paused`, reason `owner`, and has no next check time. Its owned Work link is observed
  `stopped` at `2026-10-23T13:04:11.697Z`.
- The synthetic Work reads `done`, etag `6`, handled-through sequence `9` and no pending reports. The server has
  zero open Works and zero pending reports, matching the pre-test baseline.

Only public test pages were inspected. Existing user Watches, extensions, operating switches, budgets, the
native hourly Work review and the owner's stopped Codex observations remain unchanged. No `work_report` was
used during acceptance, and the saved test evidence was not deleted.
