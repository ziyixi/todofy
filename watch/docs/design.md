# The watch app: design

The owner's web watches: a page, a feed or a JSON API checked on a schedule, a deterministic pipeline that decides
whether a difference is a change worth the owner's attention, and an inbox of those changes. One Worker `watch`, one
SQLite Durable Object `WatchState`, a Chinese mobile-first UI, on Workers Free at $0. The owner approved this design
on 2026-10-01 with every recommended default (the research report the lead keeps); this document is how it is built.

W1 built and checked it; W2 deploys it on `watch.ziyixi.science` and W3 adds the notifications and ops-v1 (§11).

## 1. Scope

- One owner, at most 50 watches (`WATCHES_MAX`), checked every 6 hours by default (1 hour to 7 days).
- Pages that render on the server, RSS/Atom/JSON feeds, JSON APIs and data embedded in pages (JSON-LD, Next.js).
  Pages that need JavaScript use a browser renderer that v1 keeps behind a flag (§4).
- Not in v1: the AI judge. Deployment and Access came with W2; notifications (W3, §7) are one daily Todoist digest
  task and urgent changes, as task intents of source `SOURCE_WATCH` to Todofy, and ops-v1 counts for the dashboard.
- Never: logging a watched URL, page text or a diff; fetching a site faster than the etiquette allows (a redirect's
  target included); working around a bot challenge; fetching the owner's own hosts or Workers.

## 2. Architecture

```
browser ──Access──▶ Worker "watch" (fetch)
                     │  verify the Access JWT (packages/edge-auth), Origin + CSRF for mutations
                     │  /api/v1/* ──▶ WatchState.fetch: the shared transcoder serves watch.ui.v1
                     │  everything else ──▶ ASSETS (the UI; /new by the single-page fallback)
                     ▼
              WatchState "watch-v1" (SQLite Durable Object)
                     │  alarm() ──▶ scheduler pass: due watches ──▶ pipeline ──▶ SQLite
                     └─ outbound fetch to the watched sites (the only external requests)
```

- The fetch handler stays thin (Workers Free: 10 ms of CPU per request): it verifies a JWT, checks a CSRF token and
  passes the request to the object. Everything else, the API included, runs in WatchState (30 s of CPU per
  invocation).
- WatchState schedules itself with `setAlarm()`; there is no cron trigger (the account's five are taken). An error is
  caught, logged as a code and the alarm re-armed 5 minutes later. A check that throws never stops the others: it is
  a failure of its own (`INTERNAL_ERROR`, §5), counts toward BROKEN and the auto-pause, and is retried with a delay
  that doubles from 5 minutes up to the regular interval, never sooner than 15 minutes after its request. Every API
  call arms an alarm when none is set (the fallback for a lost alarm), and writes that need a check soon bring it
  forward to a second from now.
- All data lives in the object's SQLite: zero D1 writes, no R2, no KV.

## 3. A watch

`Watch` in `proto/watch/ui/v1/watch.proto`; the value rules the IDL cannot express are in
`worker/src/config.ts` and `worker/src/limits.ts`.

- `uri`: `https:` (or `http:` with `fetch_policy.allow_http`, which the UI warns about), no user, password or port,
  a DNS name with a dot: never an IP literal (also in its numeric spellings), `localhost`, a local suffix, or one of
  the owner's own names and every host under it (`OWN_SUFFIXES` in `url-policy.ts`: the zone `ziyixi.science` and the
  account's `workers.dev` subdomain). The fragment is dropped.
- `source`, one of: `html` (visible text, optional include and exclude selectors in HTMLRewriter's subset, link
  addresses, landmarks), `feed`, `json` (a JSONPath subset: `$`, `.name`, `['name']`, `[n]`, `[*]`), `embedded`
  (`json_ld`, or `next_data` with a path). The wire profile has no oneofs: the Worker refuses two kinds.
- `normalize`: `ignored_lines` (the drawer's "忽略这一行": exact lines dropped from both sides of every comparison),
  `disable_default_masks`, `mask_numbers`.
- `trigger`, one of: `any_change` (floors of lines and share), `text_appears`, `text_disappears`, `new_item`, `number`
  (thresholds, a share of change, a label), `availability` (JSON-LD only).
- `stability`: the confirmation fetch (HTML only, 15 to 120 minutes, default 15) or `skip_confirmation`.
- `check_interval_minutes`, `fetcher` (HTTP or BROWSER), `notify_policy` (DIGEST or URGENT, for W3),
  `request_locale` (the Accept-Language, default `zh-CN,zh;q=0.9,en;q=0.8`: the object runs in one place, so the
  page's language must not depend on it), `ai` (refused when enabled), `fetch_policy`, `shadow_mode`.

The stored settings are the wire JSON of a Watch holding only these fields, so an AIP-134 mask applies field by field.
Two hashes of the settings decide what a check may reuse: the read hash (uri, source, the masks of normalize,
fetcher, locale, fetch policy) and the check hash (also the ignored lines, the trigger and the confirmation). A new
read hash makes the next check set a new notified state without a change, and confirms a change still pending as it
was seen, with a note ("设置已更改，未经二次确认"): its confirmation cannot be compared any more, and it is never dropped
unseen. A new check hash makes it evaluate the page again even if its bytes are the same, and a pending change is
evaluated again under the new settings at its confirmation fetch (what no longer fires is suppressed with its reason).
Ignored lines are not part of what is read: snapshots keep every line and comparisons drop the ignored ones on both
sides (`content.ts` `viewOf`), so an ignore, or its undo, keeps the notified state, a pending change and the small
differences adding up against it.

## 4. Fetch tiers and etiquette

Tiers, cheapest first:

0. **Structured sources**: feeds, JSON APIs, JSON-LD and `__NEXT_DATA__`. Data the site publishes as data: read
   before any text, never confirmed by a second fetch.
1. **Conditional GET**: with the last answer's `ETag`/`Last-Modified` when the settings did not change since. A 304
   skips the parse and the snapshot and writes only the scheduling rows (the watch and its host).
2. **Plain GET** with `Accept: text/markdown, text/html;q=0.9` (markdown only for a check whose watch has no
   selector; a preview always asks for HTML, so the block picker has elements) and a streaming HTMLRewriter extraction: character references decoded by the Worker (HTMLRewriter hands over source
   text), a depth counter for the dropped elements (`script`, `style`, `noscript`, `template`, `svg`, `iframe`, ...),
   no attributes kept, landmark regions dropped unless kept. The charset is decided first: the header's, else a BOM,
   else `<meta charset>` or `http-equiv` in the first 2 KiB, and the response is relabelled before HTMLRewriter reads
   it, so a GBK page that names its encoding only in a meta tag decodes. HTMLRewriter reads only ASCII-compatible
   encodings: a UTF-16 body (a BOM or the header) is decoded and handed on as UTF-8, and a meta that says utf-16 is
   read as UTF-8 (the HTML rule). An omitted `</head>` is closed by the first element that cannot be in `head`. The
   U+FFFD ratio gates mojibake; a body no parser can read is `PARSE_ERROR`, never an exception.
3. **Browser** (`FETCHER_BROWSER`): Browser Run's `content` quick action through a Fetcher, one render per check,
   images, media and fonts not loaded; never `/json`, `/crawl`, screenshots, PDFs or a kept-alive session. Browser
   Run gives the whole account 10 minutes a day, so the app keeps its own ledger of 480 s a day (a render starts only
   with 15 s left, and every render that reached the binding is charged, a failed one too: the time the renderer
   reports or the 15 s reserve) and a 429 marks the day exhausted: such checks fail as `JS_QUOTA_EXHAUSTED` until
   00:00 UTC, shown as "今日 JS 配额已用完", never as "no change". Renders are 10 s apart, each counts as a request of
   the alarm's budget, the rendered HTML is read through the 2 MiB cap (never buffered whole), robots.txt and the
   host's spacing apply to the watched URL, and a render that reports ending on a URL a watch may not fetch is
   `REDIRECT_REFUSED`. **Behind a flag in v1**: the production config binds no browser, so such watches are refused
   (`BROWSER_NOT_AVAILABLE`) and the tier runs only in the workerd tests against a fake binding. Wiring the real
   Browser Run binding is a later step that needs its own check against the live service, and Browser Run's `content`
   action does not report where the page ended: that step must limit the render to the watch's host (request
   interception) or obtain the final URL, so the browser cannot follow a page to an IP literal or the owner's hosts.

Etiquette (`worker/src/etiquette.ts`, `obtain.ts`, `fetcher.ts`, `scheduler.ts`):

- Each request names this agent (`ziyixi-watch/1.0`, no address) and sends the watch's Accept-Language; no cookie,
  no credential.
- Every request of a page fetch, the first and each redirect hop, passes one gate (`obtain.ts` `pageGate`), so a
  redirect's target gets exactly the etiquette of the watched host: its robots.txt for the hop's path, its backoff and
  spacing, its lock.
- robots.txt is respected by default: one cached verdict per host for a day; a 4xx allows everything, a 5xx, no
  answer, or a redirect our policy refuses (an IP literal, an own host, a sixth hop) disallows everything (RFC 9309:
  unreachable), cached an hour; an `http:` hop is followed for robots.txt alone (it is public and nothing private is
  sent); a file over 512 KiB is read up to that size (RFC 9309 §2.5). It is fetched right before the first request
  to a host it is missing for, as crawlers do; the robots.txt requests of one check share 6 requests. The owner can
  override it per watch (`fetch_policy.ignore_robots`).
- One request at a time per host, requests at least 30 s apart (a hop to the same host as the request before it
  follows at once): the host's next start is reserved (written) before a request is sent, and the request runs under
  the host's lock in WatchState (`host-locks.ts`), shared by the alarm's lanes and the owner's previews, so they never
  overlap however the clock moves. A 429 or 503 backs the host off for its `Retry-After` (capped at 7 days) or 15
  minutes doubling to a day. A watch whose host, or a redirect's host, is not ready is deferred to the moment it is;
  that is never a failure.
- The same URL is never fetched twice within 15 minutes, by a check (an owner's check and a confirmation included)
  or a preview (`url_fetches`). A watch saved after its preview is first checked 15 minutes after the preview's
  fetch. A request is recorded on its watch as soon as it is made (`last_fetch_at`), also when the owner edits the
  watch meanwhile or the check fails later.
- Every check is stamped with the time it starts (`deps.now()`), not the alarm's: a pass may last minutes, and the
  host's spacing, the URL's 15 minutes and the confirmation fetch count from the real request.
- Every check is moved by up to ±10 % of its interval (deterministic per watch and slot, so tests need no seed).
- Redirects are followed by hand, at most 5, each hop's Location checked like a saved URI (no IP literal, no own
  host, no `http:` unless allowed).
- A body over 2 MiB is abandoned (`TOO_LARGE`); each request has a 15 s timer that covers it and its body and is
  always cleared.
- Per alarm: at most 40 external requests (a check starts only with 12 left per check in flight: 6 for the page and
  its redirects, 6 for robots.txt files; so three concurrent checks never overrun the 50 subrequests of an
  invocation), at most 24 MiB of bodies (the parse is what costs CPU), at most 8 minutes of wall time, three hosts at
  a time. What is left stays due for the next alarm a second later.
- PreviewWatch obeys the same rules: it answers a URL fetched within 15 minutes from its stored fetch (with the time
  it may fetch again), waits for the host's spacing (at most 30 s, once) and never fetches a host that is backing off.

## 5. The noise pipeline

Deterministic, in order (`worker/src/pipeline.ts`); D is a default, W a per-watch setting.

0. **Fetch and health gate** (`obtain.ts`, `extract/`, `health.ts`). A non-2xx answer, a bot challenge or block page
   (markers of Cloudflare, Akamai, Imperva, PerimeterX, DataDome, AWS WAF, captcha titles; never worked around), a
   content type that does not fit the source, an include selector that matched nothing, a page too short to be the
   page, mojibake, robots.txt, rate limiting, a timeout, a network error, too large, a refused redirect, a parse
   error, a missing trigger value, the JS quota and an unexpected error of the check after its fetch
   (`INTERNAL_ERROR`) are all failures, never "no change". Three in a row make the
   watch BROKEN and put one `watch_broken` event in the outbox (always DIGEST: a broken page is never urgent); 14
   days of failures pause it (`BROKEN_TOO_LONG`, one `watch_paused` event). A success makes it ACTIVE again.
1. **Short-circuit**: a 304, or the same raw bytes (SHA-256) read with the same settings (the check hash), writes
   only the scheduling rows.
2. **Extraction** per source (W). Feeds and JSON give items with keys (a feed item's guid, id or link; a JSON
   value's `id`, `url`, `key` or `slug`), JSON-LD gives one line per product offer and the first offer's
   availability.
3. **Normalization** (D, W): NFKC, zero-width characters removed, whitespace collapsed; masks for relative times in
   English and Chinese (`3 minutes ago`, `in 5 min`, `3小时前`, `半小时前`, `三年前`, `刚刚`, `昨天 12:30`), times with
   seconds and the time part of ISO date-times, epoch milliseconds, UUIDs, long hex and base64 strings, nonce and
   cache-busting query values, copyright years; absolute dates and other numbers are kept (a price, a version, a date
   is often the point): a date followed by 前, "before" (`10月15日前`, `2026年前`), and a promised duration (`Ships in 3
   days`) are content, not load noise. Page text is untrusted: every repetition in a mask is bounded and anchored, so
   a mask costs linear time on any run of its own characters (tested per character class, and a 2 MiB page of such
   runs in the CPU test). `mask_numbers` masks the rest. `ignored_lines` are dropped when texts are compared, from
   both sides (§3). A check whose raw page changed but whose normalized text did not counts as masked
   (`health.masked_change_count`).
4. **Diff** against the notified state: Myers' algorithm on the lines after the common prefix and suffix, giving up
   after 1,000 edits for a multiset difference with the same counts. A change keeps at most 200 lines of at most 500
   characters, and at most 32 KiB of them as stored.
5. **Triggers** (W). AnyChangeTrigger and NewItemTrigger compare with the notified state, so small differences add up
   until they reach the floor. The others are edges between the previous check's text and this one: they fire when
   their condition becomes true and not again while it stays true, but again after it was false in between (a
   restock after a sell-out is news again). NumberTrigger's `change_percent` is a share of the notified value. A
   difference is evaluated once: the same text is not recorded again until it changes.
6. **Confirmation** (D, W): a change of an HTML source waits about 15 minutes for a second fetch. The same text
   confirms it. The page back at its notified state is a flicker: suppressed (`FLICKER`) for AnyChangeTrigger,
   confirmed as `reverted` for a typed trigger. A third version is evaluated again (from the text before the pending
   change) and becomes the candidate; the third new version in a row is decided as it stands. Feeds and structured
   sources are confirmed at once. All of this holds within the change's window, 4 confirmation delays from its
   detection plus the URL's 15 minutes (75 minutes by default, `CONFIRM_WINDOW_DELAYS`): a confirmation fetch that
   keeps failing is retried at the confirmation pace only within it, then the watch returns to its regular interval
   and the change is confirmed as it was seen ("二次确认未能抓取，按所见确认"); a page seen back at its notified
   state after the window (the confirmation was deferred by a backing-off host, say) is a confirmed, reverted change,
   never a flicker.
7. **AI judge**: off in v1 (`judge.ts`); `ai.enabled` is refused. The interface may only drop a change the rules
   confirmed, never confirm one they suppressed.
8. **Record and notify**: every suppressed difference is kept with its reason (`BELOW_THRESHOLD`, `TRIGGER_NOT_MET`,
   `FLICKER`) for the drawer; a confirmed one moves the notified state and goes to the outbox with the watch's policy.
   **Shadow mode** (W, 7 days from the write that sets it) confirms what the rules would drop, with the reason it
   would have had (`Change.shadow`), so the owner can see what a rule drops before relying on it.

Each check's writes are one transaction after every await, applied only if the watch's settings did not change while
it was fetched (an owner's update wins; the result is dropped, but its request still counts for the URL's 15
minutes). A check that throws after its fetch (a bug, a storage error) is recorded as `INTERNAL_ERROR` by the
scheduler: a failure like any other for BROKEN and the auto-pause, retried with a delay doubling from 5 minutes up to
the regular interval and never within 15 minutes of its request, so a deterministic bug cannot become a fetch loop.

PreviewWatch runs stages 0 to 5 for given settings without storing anything but the etiquette rows and the fetch
(below), and answers every stage: the fetch (status, type, charset and whether it came from a meta tag, redirects,
markdown, robots.txt, whether it was the stored fetch and when the URL may be fetched again), the failure, the page's
blocks each with a selector in
HTMLRewriter's subset (an id anchor or `body`, then `:nth-of-type` steps; generated-looking ids are skipped), the
extracted and normalized lines, the masks and ignored lines, items, the number and the availability, and for an
existing watch what its trigger would say now. A block inside a landmark (a nav, the body's header or footer) is
marked so; tapping it in 只看这些 counts it (an include selector that matches inside a landmark is the owner's
opt-in; one around a landmark, such as `body`, does not count the landmark). A page fetched for a preview is stored
(gzipped, a few rows, 15 minutes, one entry per URL whatever the source kind) so the owner can tap blocks one after
another without a new request; an object leaves memory after seconds without requests, so this cache is in SQLite,
not memory.

## 6. WatchState's storage

`worker/src/store.ts`; every table is bounded (schema v3 adds the sink's `intents` and a partial index of the
undelivered events). After an alarm the watches whose checks may have added rows are pruned
(`pruneWatches`, through the `(watch_id, state, id)` index: only that watch's rows are read); the global tables at
most once an hour and every watch once per UTC day (`pruneGlobal`).

| Table | Holds | Bound |
| --- | --- | --- |
| `watches` | the settings (wire JSON) and the scheduler's state: state, failures, last outcome and failure, validators, raw and seen hashes, the notified and previous snapshots, a pending change, shadow end | 50 rows |
| `snapshots` | a Content (normalized lines, item keys, number, availability), gzipped JSON of at most 64 KiB (a larger text keeps its first lines) | 20 per watch, plus the notified, the previous and a pending one |
| `changes` | a recorded difference: state, reason, shadow, trigger kind, summary, counts, kept diff (at most 32 KiB), values, times | 50 suppressed and 200 in all per watch: the oldest acknowledged go first, then suppressed, then confirmed ones beyond the 50 newest (never a pending one) |
| `hosts`, `robots` | the etiquette per host | one row per host |
| `ledger` | per UTC day: external requests, browser milliseconds, the browser's exhausted flag | 8 days |
| `requests` | AIP-155 request IDs with their first response | 24 hours |
| `previews` | PreviewWatch's stored fetches | 4 rows, 15 minutes |
| `url_fetches` | when each URL was last requested (a check or a preview) | 15 minutes |
| `notifications` | the outbox (§7) | 30 days, 500 rows |
| `intents` | the Todofy sink's inbox (§7): each intent's ID, kind, day, state, attempts, code; its frozen text until Todofy holds it | 30 days (at most 10 a day) |

A check that finds nothing new writes a few rows (the watch, its host, the URL's fetch time); the day's request count
is written once per alarm. The schema has a version in `meta`; a change adds a migration step (v2: the
`changes_watch_state` index and `url_fetches`; v3: `intents` and `notifications_pending`).

## 7. Bindings, notifications

Bindings (`wrangler.toml`, `worker/src/env.ts`): `WATCH` (the object), `ASSETS`, `TODOFY` (Todofy's `Intents`
entrypoint with `props = { source = "watch" }`: task intents of this source only, never Todofy's ops-v1 methods; the
notification sink); vars `PUBLIC_HOST`
(`watch.ziyixi.science`, the CSRF origin), `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, and `BUILD_SHA` at deploy; secrets
`ACCESS_OWNER`, `ACCESS_OWNER_ALIASES` (the dashboard's owner, as for Lab, FlowDay and the links app) and the app's
own `CSRF_SIGNING_KEY`. A `BROWSER` binding turns on tier 3 (§4). Local development and tests only:
`DEV_AUTH_BYPASS`, `DEV_MANUAL_ALARMS` (no alarm is armed; a clock the tests set; `/__dev/clock` and `/__dev/step`
over loopback), `DEV_FAKE_UPSTREAM` (every page request goes to a loopback server of synthetic sites),
`DEV_FETCH_TIMEOUT_MS`. The committed config never sets a `DEV_` var (`test_wrangler_configs.py`).

Notifications (`worker/src/notify.ts`): an outbox filled in the same transaction as the state it reports:

- `change_confirmed` with the watch's policy (`digest` or `urgent`);
- `watch_broken` (always `digest`), once per run of failures;
- `watch_paused` (always `digest`), when the Worker pauses a watch.

An event carries IDs, a kind and a policy only. A `NotificationSink` takes events over synchronously, in the
transaction that marks them delivered, into its own durable inbox (so an event is never lost and never sent twice
whatever fails afterwards), then sends from that inbox after the transaction. `pendingCounts` is what ops-v1 reports.

The sink (W3, `worker/src/todofy.ts`; the owner's decisions of 2026-10-01) is Todofy's `Intents` entrypoint over the
`TODOFY` service binding (least privilege: `proposeTasks` and `taskIntentStatus` for source `watch` only), through task-intent-v1 (`contracts/task-intent-v1`, source `SOURCE_WATCH`):

- **The digest**: once a UTC day, at the first alarm from 14:00 UTC (`DIGEST_UTC_HOUR`; the alarm wakes for it),
  every pending event of both policies becomes one intent `digest-<day>` in `subtasks` mode: a parent task and one
  task per watch (past 30 watches, the last one names how many more). A BROKEN or auto-paused watch is only ever in
  the digest. A day with nothing pending sends nothing.
- **Urgent changes**: a change confirmed on an URGENT watch leaves in the alarm that confirmed it, as
  `urgent-<change id>` (`separate` mode, the first change's ID when one alarm confirms several), at most 9 a UTC day
  (`URGENT_INTENTS_PER_DAY`): Todofy records at most 10 intents per source and day, and one is the digest's. An urgent
  change past them waits for the digest.
- **What a task says**: only the owner's display name of the watch, the trigger type with a count (`数值 2 次变化`)
  or its trouble (`检查失效`, `已自动暂停`), and a link to the watch in this app,
  `https://watch.ziyixi.science/watches/<id>`, the only host Todofy allows for this source. Never the page's text, a
  watched URL or a change summary: page content is untrusted (a page could address an assistant that reads the
  owner's tasks), and a watched URL leaves the object only through the owner API. A name is made one line (control
  characters and separators become spaces) and cut to the contract's bounds. A name that holds the watched URL, its
  origin, its host or a parent domain of it is replaced by `监视 <id>` (`todofy.ts` `taskName`), and the UI never
  derives a name from the URL: the owner types it before saving (a shared `/new#u=` link's host is not the owner's
  text).
- **Delivery**: the intent's wire JSON is frozen in `intents` with the events it took; it is proposed with exactly
  those bytes until Todofy records it (`pending`, `created`, `duplicate`, `failed`, `paused`: Todofy holds it and
  deduplicates by intent ID). A lost answer, `unavailable`, a pause or the day's limit is retried (5 minutes doubling
  to 6 hours, or Todofy's `retry_after_seconds`); a URL off the list or a conflict is final; an intent not taken over
  within 7 days is given up. At most 3 proposals an alarm. Once Todofy holds it the frozen text is cleared; the row
  (ID, kind, state, code) is kept 30 days. Logs carry intent IDs, kinds, counts and codes only.

Without the binding (local development, most workerd tests) there is no sink and the outbox only fills; the change
inbox is always how the owner sees what changed.

**ops-v1** (`worker/src/ops.ts`, `worker/src/ops-status.ts`; `contracts/ops-v1` IMPLEMENTATION.md §3c): the named
entrypoint `Ops` answers the dashboard's service binding `WATCH` (no public route). `status()` holds counts and codes
only, from WatchState's SQLite: `watches_active`, `watches_paused`, `watches_broken`, `watches_failing`,
`changes_new` (counted up to 1,000 through `changes_state`), `fetches_today`, `notifications_pending`, `intents_open`,
`intents_sent_today`; signals `watches_broken`, `scheduler_stale` (no pass for 12 hours while a watch is to be
checked), `notify_unsettled` (an intent Todofy has not taken over for a day, or one given up or refused this week) and
`guard_shed`; modes `maintenance` (always false) and `notifications` (the TODOFY binding is configured). Never a
watch's name, URL, page text or a diff. Its one write: it arms the alarm when none is set, so the dashboard's tick
(every 30 minutes) restarts a lost scheduler. `setGuard()` (the dashboard's 80 % rule, capability `guard`) defers
`scheduled_checks` (a scheduled check waits until the watch's last check is a day old: every watch is still checked
daily) and `daily_sweep` (the sweep of every watch's bounds waits for the shed's end); an owner's check, a pending
change's confirmation, previews, the owner API and the notifications go on.

## 8. HTTP surface, limits and cost

- The whole host is behind the Access application "watch" (W2). The Worker verifies the JWT on every path but
  `/health` (liveness, the build, no data). Mutations need the same-origin Origin and the signed double-submit CSRF
  token (`watch_csrf`, from `GET /api/csrf`), checked before the body is read.
- `/api/v1/*`: WatchUiService through the shared transcoder (AIP-131/132/133/134/135, `:pause`, `:resume`,
  `:check`, `watches:preview`, `watches/-/changes?filter=state = NEW`, `:acknowledge`, `serviceStatus`), AIP-154
  etags (a mask names `etag` for the shared client to send it), AIP-155 request IDs (one transaction with the
  mutation; a repeat answers the first response, another rpc or resource is BAD_REQUEST), AIP-158 page tokens and
  the AIP-160 subsets. Errors are google.rpc.Status bodies with Chinese LocalizedMessages; storage is the object's
  own, so anything unexpected is INTERNAL.
- Every response: `no-store` (immutable for the UI's hashed files), `nosniff`, no referrer, never framed, the strict
  CSP. A refusal logs one line (request ID, status, reason); an alarm logs counts; a failed check logs its watch ID
  and an error code. Invocation logs and traces are off: they would record URLs.

Measured on 2026-10-01 (`worker/test/runtime/cpu.test.ts`, WatchState in an isolate of its own as on Cloudflare,
the reference machine of `tools/workerd-cpu`): the fetch handler about 2 ms on its very first request and 0.4 to 1
ms otherwise, whatever the answer's size; in WatchState a full list of 50 watches about 2 to 5 ms, a full page of 50
changes with 200 diff lines each about 25 to 35 ms, a preview of a 200 KiB page about 40 to 50 ms, of a 2 MiB page
about 340 ms and of a 2 MiB page of hostile runs (2,000 characters of each class the masks consume) about 65 ms
(the quadratic Chinese mask it replaced took ~5 s), an alarm pass over 200 KiB pages 0.6 to 1.2 s and the worst
pass (pages of 2 MiB, bounded by the 24 MiB budget) about 4 s of the 30 s an invocation may use. The test fails
beyond 6 ms (2 ms warm) for the fetch handler, 300 ms for an API call and 7.5 s for an alarm pass or the largest
preview, and the hostile preview beyond twice the plain one, in reference milliseconds (each isolate's numbers divided
by its measured speed); the fetch handler's very first request is the median of three fresh isolates, the rest is
measured once, in the third (`tools/workerd-cpu` and its README). The worst pass must read all 12 pages its byte budget
allows, each a change, with none of its own or the earlier passes' checks failed: a timeout would hide a page's parse.
Wall time is the machine's, not what the test bounds (a request's timer includes waiting for the isolate while the other
lanes parse; one request of that pass outlived production's 15 s on GitHub runners), so its page requests may take 60 s
and its measured runs 120 s; the fetch timeout itself is `etiquette.test.ts`'s.
Bundles: the Worker 125.2 KiB gzip with the Todofy sink and the Ops entrypoint (budget 140 KiB,
`deploy/bundle-size.mjs`), the UI's JavaScript 50.2 KiB gzip (budget 56 KiB, `web/scripts/js-budget.mjs`), both with
the wire profile's rule checker of proto/ts.

SQLite rows are a budget of their own: Workers Free gives the account's SQLite Durable Objects 5,000,000 rows read
and 100,000 rows written a day, Mail Hero's included, and every call fails past them until 00:00 UTC. The store
counts what each statement reads and writes (`takeMeter`); `worker/test/runtime/rows.test.ts` fills every table to
its bound (50 watches, 200 changes and 22 snapshots each) and holds each path to a budget. Measured on 2026-10-01:

| Path | Rows read | Rows written |
| --- | --- | --- |
| an idle alarm pass | 5 | 1 |
| an idle alarm pass with the Todofy sink (`notify.test.ts`) | 11 | 1 |
| a check that finds nothing new | ~30 | ~7 |
| a check that records a change (its own watch's prune included) | ~330 | ~22 |
| the daily sweep of every watch's bounds (once per UTC day) | ~14,500 | ~200 |
| ListWatches, GetServiceStatus (they count the open changes) | ~5,200 here, at most ~10,000 | 0 |
| the inbox (a page of ListChanges) | ~150 | 0 |

A day, typically (50 watches at 6 hours, ~250 checks, a few dozen changes, a few dozen page loads): under 100,000
rows read and 5,000 written. At every bound at once (50 watches at 1 hour, every check a change with its
confirmation, ~2,400 checks; every watch at 200 unread changes; 100 loads of the heaviest pages): ~0.8 M rows read by
checks and ~2 M by the UI, ~55,000 written: within the day's 5 M and 100 k, with room for Mail Hero, but only
because a prune reads one watch's rows (before the `(watch_id, state, id)` index every alarm read ~318,000 rows).

## 9. The UI

`web/`: plain DOM and TypeScript (no framework), Chinese, mobile first, light and dark from the system, no external
font, script or image, and nothing but its own API through the shared typed client.

- `/`: the inbox of new changes across watches (已读 acknowledges) and the suppressed drawer: each suppressed change
  with its reason and "忽略这一行" per line, which adds the line to the watch's ignored lines (dropped from both sides
  of every comparison from the next check on; the notified state stays). The toast offers 撤销 at once; every ignored
  line can be taken back later on the watch's page.
- `/watches`, `/watches/<id>`: each watch's health in words, check now, pause or resume, delete, the settings form
  and the changes by state. The form keeps the stored watch under its draft and saves with an update_mask of the
  fields it edits (and the etag: an edit made elsewhere is refused and the latest loaded), so what it does not show
  (the confirmation delay, a trigger's share, the AI intent) survives a save and the ignored lines are never written
  back stale. It offers the masks (numbers too, or none of the defaults), whether landmarks count, and lists the
  ignored lines, each with 取消忽略; the watch's own suppressed changes offer 取消忽略 on a line still ignored.
- `/status`: the health view: the scheduler, the request count, the browser ledger, and the watches grouped as
  broken, blocked, robots.txt, rate limited, JS quota and failing.
- `/new` and `/new#u=<encoded url>`: the add flow. The fragment carries the URL from the phone's share sheet or a
  bookmarklet and never reaches a server; the page fills the box with it, shows its host and removes the fragment from
  the address bar and history, and fetches nothing until the owner taps 预览 (the watch host is public in this
  repository: a link anyone sends must not make the Worker request a URL, a beacon, by being opened). Then the owner
  taps blocks to build include ("只看这些") or exclude ("排除这些") selectors (a landmark block says it does not count
  unless picked), sees the lines that will be compared, adjusts the settings and saves (a POST with CSRF; a create
  whose response was lost is repeated with the same request_id and answers the watch the first one made).
- Screen readers: the preview is not a live region (it is rebuilt on every tap); a status line says how many lines
  will be compared and how many blocks are picked. Diff lines say 新增/删除 in words with the glyph hidden, and each
  line's button names its line.

## 10. Tests

All hermetic: synthetic content only, the only network is loopback, clocks are injected.

- Unit (`npm test` in `worker/`, Node): normalization and every mask (deadlines kept, linear on hostile runs), the
  diff, the triggers (edges, floors, values, the kept diff's bytes), robots.txt, scheduling and backoff, the URL
  policy (the own names), JSONPath, feeds, JSON-LD, markdown, numbers, charsets (GBK), the health gate, snapshots,
  settings and hashes, the fetch with a stub (redirects, the hop gate, caps, per-request timers), the browser
  renderer's cap and cost, the dev rewrite.
- workerd (`npm run test:runtime`): Miniflare runs the bundled Worker with a real SQLite WatchState; every request it
  makes goes to `test/fake-sites.ts` through the outbound service, a proxy Worker that streams each body as it is read
  (`test/runtime/fake-net.ts`: a body written ahead of a busy WatchState into Miniflare's loopback connection crawled
  on Linux 6.17 runners), so nothing leaves the machine. A probe Worker calls `step(now)`, `setClock(now)` and
  test-only reads (rows, the row meter) over the object binding; a fake site may move the clock while its request is
  out. Files cover every tier, the etiquette as the sites see it (redirect targets' robots.txt and backoff, one
  request at a time per host across previews and the alarm, the URL's 15 minutes for previews and edits, the time each
  check is stamped with), every stage, every trigger, confirmation, flicker, third versions and the window, ignored
  lines with a change pending, a check that throws, BROKEN and the auto-pause, GBK, UTF-16, an omitted `</head>`,
  masks, shadow mode, the API surface (AIP-155 replays), the browser tier with a fake binding (the ledger charges
  failed renders), real alarms, storage bounds, the rows budget and the CPU (§8).
- UI (`npm test` in `web/`, jsdom): the transport, the formats, the inbox and drawer with ignore and undo, the add
  flow from a fragment (nothing fetched before 预览, the fragment cleared) with the block picker, a create whose
  response was lost, the settings form's round trip and mask, taking an ignored line back, accessibility, the health
  groups, a stale save; no external URL, `fetch` only in `api.ts`, no HTML from strings.
- Local: `wrangler dev` with `DEV_FAKE_UPSTREAM` and `worker/test/runtime/serve-fake-sites.ts` (README "Develop").

## 11. Steps

- **W1** (this step): the IDL `proto/watch/ui/v1`, the Worker, WatchState, the UI, the tests and CI. `watch` is in
  `ci_changes.py`'s `CHECK_ONLY` (a `Watch checks` job in the gate, no deploy job), `wrangler.toml` is in
  `test_wrangler_configs.py`'s `UNDEPLOYED` with no route and the all-zeros Access AUD, and
  `deploy/deploy-vars.mjs` refuses anything but `--dry-run`.
- **W2** (the lead; the first deploy). Like the links app's L2 (`links/docs/design.md` §11, commit "Deploy links on
  s.ziyixi.science (L2)"), every list a production Worker is in changes in one commit, "Deploy the watch app on
  watch.ziyixi.science (W2)". As built: the Access probe covers `/`, `/api/v1/watches` and `/new` (the whole host is
  behind Access, `/health` too, so no anonymous request reaches the Worker); the dashboard's `WATCH` binding, its
  registry entry and the `WatchState` row (id after the deploy) arrived with W3's Ops entrypoint and this commit; the
  alarm is checked by hand after the deploy (README "Deploy"). The lead fills in two values read after the apply
  (`infra/README.md` "Adding an app" step 4) and commits them together: the AUD in `wrangler.toml`
  (`deploy/test/wrangler-config.test.mjs` fails while it is the placeholder) and the application id in
  `infra/ids.tf` `access_app_ids["watch"]` (`test_infra_config.py` fails while it is the all-zeros UUID). The push
  changes `infra/`, so it runs "Infra drift": it must be green (`no-op: 19`, `output changes: 0`, no outputs problem)
  before the deploy is trusted, since the Access probes pass whatever the AUD (Access answers before the Worker runs);
  red with `vars.ACCESS_AUDIENCE differs` means a wrong AUD: fix it and push again:
  1. Resources: the Access application "watch" for the whole host `watch.ziyixi.science` (an `owner_apps` entry in
     `infra/access.tf`, session 24h as for the other owner apps, created by "Infra apply" before this commit:
     `infra/README.md` "Adding an app"), its AUD committed as `ACCESS_AUDIENCE`; the `production` GitHub secret `WATCH_CSRF_SIGNING_KEY` (64 hex); the owner inputs come from
     the dashboard's `DASHBOARD_ACCESS_OWNER` and `DASHBOARD_ACCESS_OWNER_ALIASES`. No D1 database and no R2 bucket.
  2. `wrangler.toml`: `routes = [{ pattern = "watch.ziyixi.science", custom_domain = true }]`.
  3. `.github/scripts/test_wrangler_configs.py`: `watch` from `UNDEPLOYED` to `PRODUCTION` and `WRAPPERS`, its
     `WATCH_ACCESS_OWNER*` in `PERSONAL_INPUTS` and `SHARED_SECRETS`, and a routed Worker in
     `LocalDev.test_the_production_configs_with_routes_are_the_ones_dev_runs`;
     `.github/scripts/test_infra_config.py`: `watch` in `PRODUCTION` (or `NOT_ADOPTED` with its reason until the Access
     application is in `infra/`).
  4. `.github/scripts/ci_changes.py`: `watch` out of `CHECK_ONLY`, a `watch_deploy` output; `.github/workflows/ci.yml`:
     a `Watch deploy` job shaped like `Links deploy` (secrets file, dry run with the bundle budget, `tools/cf-guard`
     on the config, the wrapper's deploy, the production check of the live `BUILD_SHA`, an Access probe of `/`,
     `/api/v1/watches` and `/new` answering Access's login redirect; `/health` is behind Access too and not probed);
     stubs in
     `test_ci_changes.py`.
  5. `tools/cf-guard/test/cf-guard.test.mjs`: `"watch/wrangler.toml": ["watch", ["watch.ziyixi.science"]]`.
  6. The drift check: `watch` in `.github/scripts/drift_desired.py` `WORKERS` and in `WRAPPERS` as `{"language":
     "js", "file": "watch/deploy/deploy-vars.mjs", "vars": "watch", "secrets": "watch"}`; regenerate
     `dashboard/worker/src/drift-desired.json`; the Worker count in `dashboard/worker/test/drift.test.ts` and
     `dashboard/docs/design-v2.md`.
  7. The dashboard registry (`dashboard/worker/src/registry.ts`): the Worker `watch` in `WORKERS`, and a `RESOURCES`
     row of kind `do` for the namespace `WatchState`, whose id is known only after the first deploy (a follow-up
     commit adds it, as `registry.test.ts` records for an id not yet known).
  8. After the deploy: the first API call arms the alarm; verify with a synthetic page on a host the lead controls.

  Rollback (README "Rollback"): normally a code-only revert through `Watch deploy`. Leaving production is a separate
  decision with ordered steps: stop the side effects first (Todofy's `TASK_INTENT_SOURCES = "lab"`, every watch
  paused), then detach the Custom Domain, and keep the dashboard's `WATCH` binding, registry entry and drift entry
  while the Worker exists. Reverting this commit alone would leave WatchState running and the dashboard reporting it
  unreachable.
- **W3** (notifications; ops-v1 is merged: `proto/ops/v1/ops.proto`, generated code and the Contracts job). Steps 1
  to 3 are done (commit "task-intent-v1: SOURCE_WATCH, ...", the Todofy sink and the Ops entrypoint, §7); the
  dashboard's `WATCH` binding is part of the first deploy (W2), since a binding needs the Worker deployed:
  1. `proto/todofy/taskintent/v1`: a new `Source` value `SOURCE_WATCH` whose URL host allow-list is
     `watch.ziyixi.science` only, so a task links to the change in the app (`/watches/<id>`), never to the watched URL
     (which keeps the rule that a watched URL leaves the object only through the owner API); Todofy's source handling
     (`todofy/worker/todofy/core/intents.py` and its tests) accepts it with that allow-list
     (`ERROR_CODE_SOURCE_NOT_ALLOWED` otherwise); the task-intent-v1 schema and fixtures regenerated.
  2. A `[[services]]` binding `TODOFY` to `todofy`'s entrypoint `Intents` with `props = { source = "watch" }` in
     `wrangler.toml` (Lab binds `Ops`; `Intents` has only the two task-intent methods, for this source), called from
     WatchState by a `NotificationSink` (`notify.ts`): an `urgent` change at once, the `digest` events once a day.
  3. An `export { Ops }` entrypoint (as `lab/worker/src/index.ts`) answering ops-v1 from `pendingCounts` and the
     scheduler's state; `watch` out of `ci_changes.py`'s `NO_CONTRACTS`, with its ops-v1 golden test run by the
     Contracts job like the other apps'; the dashboard registry's ops binding for it.
  4. Logs stay IDs and counts: a task intent carries the watch's display name, the trigger type and a count (the
     owner decided against the change's summary: it is page text), never the page's text or URL.
