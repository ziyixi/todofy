# The watch app: design

The owner's web watches: a page, a feed or a JSON API checked on a schedule, a deterministic pipeline that decides
whether a difference meets an ordinary watch rule, and saved evidence for Dots to judge against a Work goal.
One Worker `watch`, one SQLite Durable Object `WatchState`, a private evidence R2 bucket and a Chinese mobile-first
UI. Production bindings and limits are declared in `wrangler.toml`; the default design uses Workers Free.

## 1. Scope

- One owner, at most 50 watches (`WATCHES_MAX`), checked every 6 hours by default (1 hour to 7 days).
- Pages that render on the server, RSS/Atom/JSON feeds, JSON APIs and data embedded in pages (JSON-LD, Next.js).
  Pages that need JavaScript or screenshots use the metered browser renderer (§4).
- The ordinary AI judge is disabled. Confirmed-rule notifications create a daily digest or urgent Tasks through
  the create-only `TaskInbox`; private Work monitoring instead exposes evidence for Dots to judge. Ops reports counts
  and codes to Home.
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
- WatchState schedules itself with `setAlarm()`; there is no cron trigger. An error is
  caught, logged as a code and the alarm re-armed 5 minutes later. A check that throws never stops the others: it is
  a failure of its own (`INTERNAL_ERROR`, §5), counts toward BROKEN and the auto-pause, and is retried with a delay
  that doubles from 5 minutes up to the regular interval, never sooner than 15 minutes after its request. Every API
  call arms an alarm when none is set (the fallback for a lost alarm), and writes that need a check soon bring it
  forward to a second from now.
- Configuration, rule state and evidence indexes live in the object's SQLite. Bounded reading captures and
  screenshots live in private R2 (§Page evidence); there is no D1 or KV.

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
- `check_interval_minutes`, `fetcher` (HTTP or BROWSER), `notify_policy` (DIGEST, URGENT, or NONE),
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
3. **Browser** (`FETCHER_BROWSER`): the official `@cloudflare/puppeteer` package opens one Browser Run session
   per check. Main-frame navigations pass the same async robots/host/redirect gate as HTTP; HTTP(S) subresources
   follow the URL policy too. Images, fonts and public frames may render; frame documents are not recursively
   extracted. The same page supplies its rendered HTML and a fixed 1280 × 960 JPEG (quality 65, at most 1 MiB). The
   screenshot is a viewport, not the full page. The session closes after capture, including failure. Text remains
   available when only the screenshot fails, with an explicit source error code. A rendered page whose text is too
   short fails `TOO_SHORT` like any page; its screenshot is still saved as evidence.
   The app retains its 480-second daily ledger under the account's shared allowance. Budget exhaustion is
   `JS_QUOTA_EXHAUSTED`, never no change. The existing browser slot spaces new sessions at least 20 seconds
   apart, including manual previews. Browser checks retain their existing six-hour minimum interval.

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

`worker/src/store.ts`; regular history is pruned, while an undelivered outbox row stays until Tasks accepts it.
The schema includes the delivery inbox, immutable change context, private evidence indexes and
`backup_evidence` ([backup.md](backup.md): every table but `previews` and that record is backed up). After an alarm the watches whose checks may have added rows are pruned
(`pruneWatches`, through the `(watch_id, state, id)` index: only that watch's rows are read); the global tables at
most once an hour and every watch once per UTC day (`pruneGlobal`).

| Table | Holds | Bound |
| --- | --- | --- |
| `watches` | the settings (wire JSON) and the scheduler's state: state, failures, last outcome and failure, validators, raw and seen hashes, the notified and previous snapshots, a pending change, shadow end | 50 rows |
| `snapshots` | a Content (normalized lines, item keys, number, availability), gzipped JSON of at most 64 KiB (a larger text keeps its first lines) | 20 per watch, plus the notified, the previous and a pending one |
| `changes` | frozen bounded context and a recorded difference: state, reason, shadow, trigger kind, summary, counts, kept diff (at most 32 KiB), values, times | 50 suppressed and 200 in all per watch: the oldest acknowledged go first, then suppressed, then confirmed ones beyond the 50 newest (never a pending one) |
| `hosts`, `robots` | the etiquette per host | one row per host |
| `ledger` | per UTC day: external requests, browser milliseconds, the browser's exhausted flag | 8 days |
| `requests` | AIP-155 request IDs with their first response | 24 hours |
| `previews` | PreviewWatch's stored fetches | 4 rows, 15 minutes |
| `url_fetches` | when each URL was last requested (a check or a preview) | 15 minutes |
| `notifications` | ordinary outbox and evidence feed | settled history: 30 days, at most 500 rows; undelivered Tasks notifications retained until handoff |
| `evidence_snapshots` | private R2 capture addresses and hashes | 20 recent captures per watch, plus current rule references |
| `evidence_deletions` | private object keys awaiting cleanup | drained in batches of 20 by the existing Alarm |
| `intents` | the sink's inbox (§7): each row's ID, kind, day, state, attempts, code; its frozen request until Tasks created it | 30 days (at most 10 a day) |
| `backup_evidence` | the evidence objects the daily backup copied into `watch-backups`, with their SHA-256 ([backup.md](backup.md)) | the copies the 30 kept backups name |

A check that finds nothing new writes a few rows (the watch, its host, the URL's fetch time); the day's request count
is written once per alarm. The schema version in `meta` advances through explicit migration steps.

## 7. Bindings, notifications

Bindings (`wrangler.toml`, `worker/src/env.ts`): `WATCH` (the object), `ASSETS`, `EVIDENCE_STORE` (private R2),
`BACKUPS` (private R2, the daily backups: [backup.md](backup.md)),
`TASKS` (Tasks' `TaskInbox`
entrypoint with `props = { source = "watch" }`: it creates tasks of this source only, and never reads, changes or
deletes one; the notification sink); vars `PUBLIC_HOST`
(`watch.ziyixi.science`, the CSRF origin), `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, and `BUILD_SHA` at deploy; secrets
`ACCESS_OWNER`, `ACCESS_OWNER_ALIASES` (the dashboard's owner, as for the links app). Owner JSON
mutations require exact Origin and the custom header `X-CSRF-Token: 1`; no signing key or cookie is used. A `BROWSER` binding turns on tier 3 (§4). Local development and tests only:
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

The sink (`worker/src/tasks.ts`) is Tasks' `TaskInbox` entrypoint over the `TASKS` service binding (least privilege: `createInboxTask`
for source `watch` only; `proto/tasks/inbox/v1`):

- **The digest**: once a UTC day, at the first alarm from 14:00 UTC (`DIGEST_UTC_HOUR`; the alarm wakes for it),
  every pending event of both policies becomes one task `digest-<day>` with one subtask per watch (past 30 watches,
  the last one names how many more). A BROKEN or auto-paused watch is only ever in the digest. A day with nothing
  pending sends nothing.
- **Urgent changes**: each watch with a change confirmed on an URGENT watch gets its own task in the alarm that
  confirmed it, as `urgent-<change id>` (the watch's first change's ID). This app creates at most 10 tasks a UTC day
  (`INTENTS_PER_DAY`; TaskInbox itself refuses a 21st of a source with `daily_limit`), so an urgent task is frozen
  only while the rows still open (of any day: a failure carries them over) plus those created today, plus one slot for
  a digest not yet frozen today, stay below 10: nine on a normal day. An urgent change past that waits for the digest.
  When the digest is frozen, every open row Tasks surely never created (never sent, or every answer was
  `daily_limit`) is folded into it (its events join the digest, it ends `superseded`), and the digest is sent before
  any urgent task. A row whose answer was lost may already have its task and is never folded (it could repeat one).
- **What a task says**: only the owner's display name of the watch, the trigger type with a count (`数值 2 次变化`)
  or its trouble (`检查失效`, `已自动暂停`), and a link to the watch in this app,
  `https://watch.ziyixi.science/watches/<id>`. Never the page's text, a watched URL or a change summary: page content
  is untrusted (a page could address an assistant that reads the owner's tasks), and a watched URL leaves the object
  only through the owner API. A name is made one line (control characters and separators become spaces) and cut to
  200 code points. A name that holds the watched URL, its origin, its host or a parent domain of it is replaced by
  `监视 <id>` (`tasks.ts` `taskName`), and the UI never derives a name from the URL: the owner types it before saving
  (a shared `/new#u=` link's host is not the owner's text).
- **Delivery**: the `CreateInboxTaskRequest`, with a random `request_id`, is frozen in `intents` with the events it
  took, and sent with exactly those bytes until Tasks answers: TaskInbox answers a repeated `request_id` with its first
  answer (`replayed`), so a lost answer never makes a second task. `unavailable` or a lost answer is retried (5
  minutes doubling to 6 hours), `daily_limit` at the next UTC day; `invalid_input` is final (`refused`). A task still
  not created 7 days after it was frozen is given up. At most 3 calls an alarm, the digest first. A row open a day, or
  one refused or given up this week, raises `notify_unsettled`. The row (ID, kind, state, code) is kept 30 days. Logs
  carry row IDs, kinds, counts and codes only.

Without the binding (local development, most workerd tests) there is no sink and the outbox only fills; the change
inbox is always how the owner sees what changed.

**ops-v1** (`worker/src/ops.ts`, `worker/src/ops-status.ts`; `contracts/ops-v1` IMPLEMENTATION.md §3c): the named
entrypoint `Ops` answers the dashboard's service binding `WATCH` (no public route). `status()` holds counts and codes
only, from WatchState's SQLite: `watches_active`, `watches_paused`, `watches_broken`, `watches_failing`,
`changes_new` (counted up to 1,000 through `changes_state`), `fetches_today`, `notifications_pending`, `intents_open`
(frozen, the task not created yet), `intents_sent_today` (created in Tasks this UTC day), `backup_age_seconds` and
`last_backup_at` (the daily backup, [backup.md](backup.md)); signals `backup_stale` (critical: no complete backup for 3
days), `backup_failed`, `watches_broken`,
`scheduler_stale` (no pass for 12 hours while a watch is to be checked), `notify_unsettled` (a task still not created a
day after it was frozen, or one given up or refused this week) and `guard_shed`; modes `maintenance` (always false) and
`notifications` (the TASKS binding is configured). Never a
watch's name, URL, page text or a diff. Its one write: it arms the alarm when none is set, so the dashboard's tick
(every 30 minutes) restarts a lost scheduler. `setGuard()` (the dashboard's 80 % rule, capability `guard`) defers
`scheduled_checks` (a scheduled check waits until the watch's last check is a day old: every watch is still checked
daily) and `daily_sweep` (the sweep of every watch's bounds waits for the shed's end); an owner's check, a pending
change's confirmation, previews, the owner API and the notifications go on.

### Private work monitoring

The `WatchApi` entrypoint serves the same generated WatchUiService through a service binding whose `access` prop
must be `read` or `read-write`. It forwards into WatchState; it does not add a fetcher, store or scheduler. The
public forwarding path strips the private marker, and the transcoder refuses `PollWatchEvents` without it.

The optional `Watch.intent` is at most 200 characters. It is deliberately absent from `readHash` and `checkHash`:
changing the work goal does not reset the deterministic comparison. Dots can read and judge the candidate against
the current work goal, recording relevance and reasons in the work log. The Worker still decides only its existing
rules and confirmation. A semantic decision never alters baseline, ignored lines or `Change.classifier`.

`NotifyPolicy.NONE` retains checks and the change inbox without creating Tasks. `enqueue` still inserts the same
immutable event, settling its unused Tasks delivery at creation. Health transitions respect NONE too. The feed
reads all event rows, including those delivered to Tasks; it does not consume `delivered_at`. Existing watches
continue to default to DIGEST.

`PollWatchEvents` starts from an explicit baseline and returns ascending transition sequences, a persistent opaque
cursor and `has_more`; each page contains at most 100 events and no page content. It carries reading-evidence
changes (inserted when a capture is saved; see Page evidence) and health transitions, never the rule
confirmations of Tasks' outbox. The SQLite autoincrement sequence retains the head after deletion; pruning records
the highest expired sequence. A cursor below that floor fails as `CURSOR_EXPIRED` instead of silently skipping
history. Retention stays at 30 days or 500 events; the private reader then takes a new baseline and reports the gap
as unknown history (the changes stay readable through `ListChanges`).

Each change freezes normalized context around changed lines while both compared texts exist: at most 40 lines,
500 characters per line and 8 KiB JSON per side. Insertions and deletions include neighboring unchanged anchors
on the opposite side. Evidence survives snapshot pruning. Old changes have `context_available = false`; new
changes flag extraction, snapshot and context losses as `context_truncated`. A snapshot predating the explicit
completeness marker is also treated as incomplete. These fields describe evidence; they do not classify relevance.

## 8. HTTP surface, limits and cost

- The whole host is behind the Access application "watch". The Worker verifies the JWT on every path but
  `/health` (liveness, the build, no data). Mutations require exact allowed Origin, a bounded nonempty `X-CSRF-Token` header
  (current clients send `1`) and JSON media type, checked before reading the body. No CSRF signing key or cookie is used.
- `/api/v1/*`: WatchUiService through the shared transcoder (AIP-131/132/133/134/135, `:pause`, `:resume`,
  `:check`, `watches:preview`, `watches/-/changes?filter=state = NEW`, `:acknowledge`, `serviceStatus`), AIP-154
  etags (a mask names `etag` for the shared client to send it), AIP-155 request IDs (one transaction with the
  mutation; a repeat answers the first response, another rpc or resource is BAD_REQUEST), AIP-158 page tokens and
  the AIP-160 subsets. Errors are google.rpc.Status bodies with Chinese LocalizedMessages; storage is the object's
  own, so anything unexpected is INTERNAL.
- Every response: `no-store` (immutable for the UI's hashed files), `nosniff`, no referrer, never framed, the strict
  CSP. A refusal logs one line (request ID, status, reason); an alarm logs counts; a failed check logs its watch ID
  and an error code. Invocation logs and traces are off: they would record URLs.

CPU, serialization and SQLite read/write budgets are executable checks in `worker/test/runtime/cpu.test.ts`,
`rows.test.ts` and `ops.test.ts`, selected through `//watch:check`. The HTTP handler stays thin; extraction,
confirmation and storage run in WatchState. Tests use synthetic pages, injected clocks and the reference CPU meter.
Per-path limits remain assertions rather than estimates of a typical day.

A private feed page reads its sequence, retention floor and at most 101 indexed events (one extra for `has_more`);
an idle poll reads at most four rows and writes none. Frozen context adds at most 8 KiB per side without another row.
The 2026-10-22 local work-monitoring checks passed the existing CPU and row budgets; that record is not a production
or Dots acceptance result. Current acceptance runs the complete Bazel facade. Original per-path local measurements remain in the
[fixed historical design](https://github.com/ziyixi/todofy/blob/288e5ef7/watch/docs/design.md); they are not current budgets.

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

- Unit (`//watch/worker:check`): normalization and every mask (deadlines kept, linear on hostile runs), the
  diff, the triggers (edges, floors, values, the kept diff's bytes), robots.txt, scheduling and backoff, the URL
  policy (the own names), JSONPath, feeds, JSON-LD, markdown, numbers, charsets (GBK), the health gate, snapshots,
  settings and hashes, the fetch with a stub (redirects, the hop gate, caps, per-request timers), the browser ledger,
  the dev rewrite.
- Workerd (`//watch:check`): Miniflare runs the bundled Worker with a real SQLite WatchState; every request it
  makes goes to `test/fake-sites.ts` through the outbound service, a proxy Worker that streams each body as it is read
  (`test/runtime/fake-net.ts`: a body written ahead of a busy WatchState into Miniflare's loopback connection crawled
  on Linux 6.17 runners), so nothing leaves the machine. A probe Worker calls `step(now)`, `setClock(now)` and
  test-only reads (rows, the row meter) over the object binding; a fake site may move the clock while its request is
  out. Files cover every tier, the etiquette as the sites see it (redirect targets' robots.txt and backoff, one
  request at a time per host across previews and the alarm, the URL's 15 minutes for previews and edits, the time each
  check is stamped with), every stage, every trigger, confirmation, flicker, third versions and the window, ignored
  lines with a change pending, a check that throws, BROKEN and the auto-pause, GBK, UTF-16, an omitted `</head>`,
  masks, shadow mode, the API surface (AIP-155 replays), the browser tier (the production renderer on a synthetic
  launcher, `test/stubs/browser-state.ts`; the ledger charges failed renders), real alarms, storage bounds, the rows
  budget and the CPU (§8).
- UI (`//watch/web:check`, jsdom): the transport, the formats, the inbox and drawer with ignore and undo, the add
  flow from a fragment (nothing fetched before 预览, the fragment cleared) with the block picker, a create whose
  response was lost, the settings form's round trip and mask, taking an ignored line back, accessibility, the health
  groups, a stale save; no external URL, `fetch` only in `api.ts`, no HTML from strings.
- Local: `wrangler dev` with `DEV_FAKE_UPSTREAM` and `worker/test/runtime/serve-fake-sites.ts` (README "Develop").

## Page evidence (2026-10-23)

Reading evidence is captured before the raw-HTML and normalized-text short circuits. The HTTP extractor retains
unmasked Markdown headings, lists, tables, labels/links and page metadata. Rendered captures additionally keep the
JPEG. This representation is independent of the small normalized `Content` used by existing typed rules; a feed, JSON or
embedded source's capture is its rule extraction's own lines, parsed once. No model, OCR or semantic judge runs in Watch.

SQLite's `evidence_snapshots` indexes immutable text object addresses and content/image hashes; private
`EVIDENCE_STORE` (`watch-evidence`) holds bounded JSON documents and JPEGs. Image hashes reuse exact image bytes;
a capture compared equal reuses the latest ready snapshot. The comparison is the title and Markdown after the default
masks, with link and image query strings removed, plus the image bytes; capture time, URI, links and metadata are
stored but not compared, so per-request tokens never wake a Dot. A changed text or image creates a candidate even when
an ordinary rule would suppress it. The private feed returns only those candidates and health, never the ordinary rule
confirmations (Tasks' outbox). Notifications carry refs only; the paired snapshots are read through the authenticated
API, not refetched from today's page.

The latest 20 reading captures per watch and the rule baseline/previous/pending references are retained.
Normal pruning/deletion queues private object cleanup for the
existing Alarm; image objects still referenced by a retained capture stay. Interrupted uploads remain indexed and
are reclaimed at the serialized scheduler boundary. An R2 failure leaves that one check without capture refs (logged
as a code) while its rules run as usual; the next capture compares with the last saved one, so no change is lost. Historical
reading refs may expire; existing frozen short text context remains. `GetSnapshot` and `GetSnapshotImage` report
unavailable/expired evidence explicitly and do not reconstruct an old page from a new request.

MCP `watch_read` returns one Unicode-safe Markdown window plus metadata; `watch_view` returns the saved
JPEG as real MCP image content. Dots judges relevance, records its decision in Work and decides subsequent action.
The UI lazily reads current and before/after evidence in existing watch/change details. Historical records without
capture refs remain readable using their original frozen context.
