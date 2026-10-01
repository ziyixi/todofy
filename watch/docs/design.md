# The watch app: design

The owner's web watches: a page, a feed or a JSON API checked on a schedule, a deterministic pipeline that decides
whether a difference is a change worth the owner's attention, and an inbox of those changes. One Worker `watch`, one
SQLite Durable Object `WatchState`, a Chinese mobile-first UI, on Workers Free at $0. The owner approved this design
on 2026-10-01 with every recommended default (the research report the lead keeps); this document is how it is built.

Step W1 (this one) builds and checks it; nothing is deployed (§11).

## 1. Scope

- One owner, at most 50 watches (`WATCHES_MAX`), checked every 6 hours by default (1 hour to 7 days).
- Pages that render on the server, RSS/Atom/JSON feeds, JSON APIs and data embedded in pages (JSON-LD, Next.js).
  Pages that need JavaScript use a browser renderer that v1 keeps behind a flag (§4).
- Not in v1: deployment and Access (W2), notifications (W3: a task intent of kind `SOURCE_WATCH` to Todofy and
  ops-v1 counts for the dashboard, after the ops-v1 proto migration), the AI judge. Their interfaces exist (§7).
- Never: logging a watched URL, page text or a diff; fetching a site faster than the etiquette allows; working around
  a bot challenge; fetching the owner's own hosts.

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
  caught, logged as a code and the alarm re-armed 5 minutes later; a failing check of one watch is retried alone 5
  minutes later and never stops the others. Every API call arms an alarm when none is set (the fallback for a lost
  alarm), and writes that need a check soon bring it forward to a second from now.
- All data lives in the object's SQLite: zero D1 writes, no R2, no KV.

## 3. A watch

`Watch` in `proto/watch/ui/v1/watch.proto`; the value rules the IDL cannot express are in
`worker/src/config.ts` and `worker/src/limits.ts`.

- `uri`: `https:` (or `http:` with `fetch_policy.allow_http`, which the UI warns about), no user, password or port,
  a DNS name with a dot: never an IP literal (also in its numeric spellings), `localhost`, a local suffix, or the
  owner's zone `ziyixi.science` and every host under it. The fragment is dropped.
- `source`, one of: `html` (visible text, optional include and exclude selectors in HTMLRewriter's subset, link
  addresses, landmarks), `feed`, `json` (a JSONPath subset: `$`, `.name`, `['name']`, `[n]`, `[*]`), `embedded`
  (`json_ld`, or `next_data` with a path). The wire profile has no oneofs: the Worker refuses two kinds.
- `normalize`: `ignored_lines` (the drawer's "忽略这一行"), `disable_default_masks`, `mask_numbers`.
- `trigger`, one of: `any_change` (floors of lines and share), `text_appears`, `text_disappears`, `new_item`, `number`
  (thresholds, a share of change, a label), `availability` (JSON-LD only).
- `stability`: the confirmation fetch (HTML only, 15 to 120 minutes, default 15) or `skip_confirmation`.
- `check_interval_minutes`, `fetcher` (HTTP or BROWSER), `notify_policy` (DIGEST or URGENT, for W3),
  `request_locale` (the Accept-Language, default `zh-CN,zh;q=0.9,en;q=0.8`: the object runs in one place, so the
  page's language must not depend on it), `ai` (refused when enabled), `fetch_policy`, `shadow_mode`.

The stored settings are the wire JSON of a Watch holding only these fields, so an AIP-134 mask applies field by field.
Two hashes of the settings decide what a check may reuse: the read hash (uri, source, normalize, fetcher, locale,
fetch policy) and the check hash (also the trigger and the confirmation). A new read hash makes the next check set a
new notified state without a change; a new check hash makes it evaluate the page again even if its bytes are the
same.

## 4. Fetch tiers and etiquette

Tiers, cheapest first:

0. **Structured sources**: feeds, JSON APIs, JSON-LD and `__NEXT_DATA__`. Data the site publishes as data: read
   before any text, never confirmed by a second fetch.
1. **Conditional GET**: with the last answer's `ETag`/`Last-Modified` when the settings did not change since. A 304
   skips the parse and the snapshot and writes only the scheduling rows (the watch and its host).
2. **Plain GET** with `Accept: text/markdown, text/html;q=0.9` (markdown only when no selector needs HTML) and a
   streaming HTMLRewriter extraction: character references decoded by the Worker (HTMLRewriter hands over source
   text), a depth counter for the dropped elements (`script`, `style`, `noscript`, `template`, `svg`, `iframe`, ...),
   no attributes kept, landmark regions dropped unless kept. The charset is decided first: the header's, else a BOM,
   else `<meta charset>` or `http-equiv` in the first 2 KiB, and the response is relabelled before HTMLRewriter reads
   it, so a GBK page that names its encoding only in a meta tag decodes. The U+FFFD ratio gates mojibake.
3. **Browser** (`FETCHER_BROWSER`): Browser Run's `content` quick action through a Fetcher, one render per check,
   images, media and fonts not loaded; never `/json`, `/crawl`, screenshots, PDFs or a kept-alive session. Browser
   Run gives the whole account 10 minutes a day, so the app keeps its own ledger of 480 s a day (a render starts only
   with 15 s left, counts the time the renderer reports) and a 429 marks the day exhausted: such checks fail as
   `JS_QUOTA_EXHAUSTED` until 00:00 UTC, shown as "今日 JS 配额已用完", never as "no change". Renders are 10 s apart.
   **Behind a flag in v1**: the production config binds no browser, so such watches are refused
   (`BROWSER_NOT_AVAILABLE`) and the tier runs only in the workerd tests against a fake binding. Wiring the real
   Browser Run binding is a later step that needs its own check against the live service.

Etiquette (`worker/src/etiquette.ts`, `obtain.ts`, `fetcher.ts`, `scheduler.ts`):

- Each request names this agent (`ziyixi-watch/1.0`, no address) and sends the watch's Accept-Language; no cookie,
  no credential.
- robots.txt is respected by default: one cached verdict per host for a day; a 4xx allows everything, a 5xx or no
  answer disallows everything (RFC 9309), cached an hour. It is fetched right before the first page request of a host
  it is missing for, as crawlers do. The owner can override it per watch (`fetch_policy.ignore_robots`).
- One request at a time per host, page requests at least 30 s apart; a 429 or 503 backs the host off for its
  `Retry-After` (capped at 7 days) or 15 minutes doubling to a day. A watch whose host is not ready is deferred to
  the moment it is.
- The same watch is never fetched twice within 15 minutes, an owner's check and a confirmation included.
- Every check is moved by up to ±10 % of its interval (deterministic per watch and slot, so tests need no seed).
- Redirects are followed by hand, at most 5, each hop's Location checked like a saved URI (no IP literal, no own
  host, no `http:` unless allowed).
- A body over 2 MiB is abandoned (`TOO_LARGE`); one 15 s timer covers the chain and the body and is always cleared.
- Per alarm: at most 40 external requests (a check starts only with 12 left per check in flight, so three concurrent
  checks never overrun the 50 subrequests of an invocation), at most 24 MiB of bodies (the parse is what costs CPU),
  at most 8 minutes of wall time, three hosts at a time. What is left stays due for the next alarm a second later.
- PreviewWatch obeys the same rules: it waits for the host's spacing (at most 30 s) and never fetches a host that is
  backing off.

## 5. The noise pipeline

Deterministic, in order (`worker/src/pipeline.ts`); D is a default, W a per-watch setting.

0. **Fetch and health gate** (`obtain.ts`, `extract/`, `health.ts`). A non-2xx answer, a bot challenge or block page
   (markers of Cloudflare, Akamai, Imperva, PerimeterX, DataDome, AWS WAF, captcha titles; never worked around), a
   content type that does not fit the source, an include selector that matched nothing, a page too short to be the
   page, mojibake, robots.txt, rate limiting, a timeout, a network error, too large, a refused redirect, a parse
   error, a missing trigger value and the JS quota are all failures, never "no change". Three in a row make the
   watch BROKEN and put one `watch_broken` event in the outbox (always DIGEST: a broken page is never urgent); 14
   days of failures pause it (`BROKEN_TOO_LONG`, one `watch_paused` event). A success makes it ACTIVE again.
1. **Short-circuit**: a 304, or the same raw bytes (SHA-256) read with the same settings (the check hash), writes
   only the scheduling rows.
2. **Extraction** per source (W). Feeds and JSON give items with keys (a feed item's guid, id or link; a JSON
   value's `id`, `url`, `key` or `slug`), JSON-LD gives one line per product offer and the first offer's
   availability.
3. **Normalization** (D, W): NFKC, zero-width characters removed, whitespace collapsed; masks for relative times in
   English and Chinese (`3 minutes ago`, `3小时前`, `半小时前`, `刚刚`, `昨天 12:30`), times with seconds and the time
   part of ISO date-times, epoch milliseconds, UUIDs, long hex and base64 strings, nonce and cache-busting query
   values, copyright years; absolute dates and other numbers are kept (a price, a version, a date is often the
   point). `mask_numbers` masks the rest, `ignored_lines` drops exact lines. A check whose raw page changed but whose
   normalized text did not counts as masked (`health.masked_change_count`).
4. **Diff** against the notified state: Myers' algorithm on the lines after the common prefix and suffix, giving up
   after 1,000 edits for a multiset difference with the same counts. A change keeps at most 200 lines of at most 500
   characters.
5. **Triggers** (W). AnyChangeTrigger and NewItemTrigger compare with the notified state, so small differences add up
   until they reach the floor. The others are edges between the previous check's text and this one: they fire when
   their condition becomes true and not again while it stays true, but again after it was false in between (a
   restock after a sell-out is news again). NumberTrigger's `change_percent` is a share of the notified value. A
   difference is evaluated once: the same text is not recorded again until it changes.
6. **Confirmation** (D, W): a change of an HTML source waits about 15 minutes for a second fetch. The same text
   confirms it. The page back at its notified state is a flicker: suppressed (`FLICKER`) for AnyChangeTrigger,
   confirmed as `reverted` for a typed trigger. A third version is evaluated again (from the text before the pending
   change) and becomes the candidate; the third new version in a row is decided as it stands. Feeds and structured
   sources are confirmed at once.
7. **AI judge**: off in v1 (`judge.ts`); `ai.enabled` is refused. The interface may only drop a change the rules
   confirmed, never confirm one they suppressed.
8. **Record and notify**: every suppressed difference is kept with its reason (`BELOW_THRESHOLD`, `TRIGGER_NOT_MET`,
   `FLICKER`) for the drawer; a confirmed one moves the notified state and goes to the outbox with the watch's policy.
   **Shadow mode** (W, 7 days from the write that sets it) confirms what the rules would drop, with the reason it
   would have had (`Change.shadow`), so the owner can see what a rule drops before relying on it.

Each check's writes are one transaction after every await, applied only if the watch's settings did not change while
it was fetched (an owner's update wins; the result is dropped).

PreviewWatch runs stages 0 to 5 for given settings without storing anything but the etiquette rows and the fetch
(below), and answers every stage: the fetch (status, type, charset and whether it came from a meta tag, redirects,
markdown, robots.txt, whether it was the stored fetch), the failure, the page's blocks each with a selector in
HTMLRewriter's subset (an id anchor or `body`, then `:nth-of-type` steps; generated-looking ids are skipped), the
extracted and normalized lines, the masks and ignored lines, items, the number and the availability, and for an
existing watch what its trigger would say now. A page fetched for a preview is stored (gzipped, a few rows, 15
minutes) so the owner can tap blocks one after another without a new request; an object leaves memory after seconds
without requests, so this cache is in SQLite, not memory.

## 6. WatchState's storage

`worker/src/store.ts`; every table is bounded and `prune` runs after every alarm.

| Table | Holds | Bound |
| --- | --- | --- |
| `watches` | the settings (wire JSON) and the scheduler's state: state, failures, last outcome and failure, validators, raw and seen hashes, the notified and previous snapshots, a pending change, shadow end | 50 rows |
| `snapshots` | a Content (normalized lines, item keys, number, availability), gzipped JSON of at most 64 KiB (a larger text keeps its first lines) | 20 per watch, plus the notified, the previous and a pending one |
| `changes` | a recorded difference: state, reason, shadow, trigger kind, summary, counts, kept diff, values, times | 50 suppressed and 200 in all per watch (the oldest resolved go first; never a pending or new one) |
| `hosts`, `robots` | the etiquette per host | one row per host |
| `ledger` | per UTC day: external requests, browser milliseconds, the browser's exhausted flag | 8 days |
| `requests` | AIP-155 request IDs with their first response | 24 hours |
| `previews` | PreviewWatch's stored fetches | 4 rows, 15 minutes |
| `notifications` | the outbox (§7) | 30 days, 500 rows |

A check that finds nothing new writes one or two rows (the watch and its host); the day's request count is written
once per alarm. The schema has a version in `meta`; a change adds a migration step.

## 7. Bindings, the notification interface

Bindings (`wrangler.toml`, `worker/src/env.ts`): `WATCH` (the object), `ASSETS`; vars `PUBLIC_HOST`
(`watch.ziyixi.science`, the CSRF origin), `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, and `BUILD_SHA` at deploy; secrets
`ACCESS_OWNER`, `ACCESS_OWNER_ALIASES` (the dashboard's owner, as for Lab, FlowDay and the links app) and the app's
own `CSRF_SIGNING_KEY`. A `BROWSER` binding turns on tier 3 (§4). Local development and tests only:
`DEV_AUTH_BYPASS`, `DEV_MANUAL_ALARMS` (no alarm is armed; a clock the tests set; `/__dev/clock` and `/__dev/step`
over loopback), `DEV_FAKE_UPSTREAM` (every page request goes to a loopback server of synthetic sites),
`DEV_FETCH_TIMEOUT_MS`. The committed config never sets a `DEV_` var (`test_wrangler_configs.py`).

Notifications (`worker/src/notify.ts`) are the seam W3 plugs into. v1 fills an outbox in the same transaction as the
state it reports and delivers nothing:

- `change_confirmed` with the watch's policy (`digest` or `urgent`);
- `watch_broken` (always `digest`), once per run of failures;
- `watch_paused` (always `digest`), when the Worker pauses a watch.

An event carries IDs, a kind and a policy only. A `NotificationSink` takes a batch and answers the IDs it took over
(it keeps its own inbox and deduplicates by ID); `deliver` marks those. `pendingCounts` is what ops-v1 will report.
W3's sinks: a task intent of kind `SOURCE_WATCH` to Todofy for `urgent` events and the daily digest, and ops-v1
counts for the dashboard.

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
the reference machine of `tools/workerd-cpu`): the fetch handler 2 ms on its very first request and 0.4 to 1 ms
otherwise, whatever the answer's size; in WatchState a full list of 50 watches about 2 to 3 ms, a full page of 50
changes with 200 diff lines each about 25 ms, a preview of a 200 KiB page about 40 ms and of a 2 MiB page about
340 ms, an alarm pass over 200 KiB pages 0.6 to 1.1 s and the worst pass (pages of 2 MiB, bounded by the 24 MiB
budget) about 4 s of the 30 s an invocation may use. The test fails beyond 4 ms (2 ms warm) for the fetch handler,
300 ms for an API call and 7.5 s for an alarm pass, in reference milliseconds scaled by the machine's speed.
Bundles: the Worker 101.4 KiB gzip (budget 122 KiB, `deploy/bundle-size.mjs`), the UI's JavaScript 46.1 KiB gzip
(budget 56 KiB, `web/scripts/js-budget.mjs`).

## 9. The UI

`web/`: plain DOM and TypeScript (no framework), Chinese, mobile first, light and dark from the system, no external
font, script or image, and nothing but its own API through the shared typed client.

- `/`: the inbox of new changes across watches (已读 acknowledges) and the suppressed drawer: each suppressed change
  with its reason and "忽略这一行" per line, which adds the line to the watch's ignored lines (and so sets a new
  notified state at the next check), undoable from the toast.
- `/watches`, `/watches/<id>`: each watch's health in words, check now, pause or resume, delete, the settings form
  (saved with the etag: an edit made elsewhere is refused and the latest loaded) and the changes by state.
- `/status`: the health view: the scheduler, the request count, the browser ledger, and the watches grouped as
  broken, blocked, robots.txt, rate limited, JS quota and failing.
- `/new` and `/new#u=<encoded url>`: the add flow. The fragment carries the URL from the phone's share sheet or a
  bookmarklet and never reaches a server; the page previews it, the owner taps blocks to build include ("只看这些")
  or exclude ("排除这些") selectors, sees the lines that will be compared, adjusts the settings and saves (a POST with
  CSRF).

## 10. Tests

All hermetic: synthetic content only, the only network is loopback, clocks are injected.

- Unit (`npm test` in `worker/`, Node): normalization and every mask, the diff, the triggers (edges, floors, values),
  robots.txt, scheduling and backoff, the URL policy, JSONPath, feeds, JSON-LD, markdown, numbers, charsets (GBK),
  the health gate, snapshots, settings and hashes, the fetch with a stub (redirects, cap, timeout), the dev rewrite.
- workerd (`npm run test:runtime`): Miniflare runs the bundled Worker with a real SQLite WatchState; every request it
  makes goes to `test/fake-sites.ts` through the outbound service, so no socket is opened. A probe Worker calls
  `step(now)`, `setClock(now)` and test-only reads over the object binding. Files cover every tier, the etiquette as
  the sites see it, every stage, every trigger, confirmation, flicker and third versions, BROKEN and the auto-pause,
  GBK, masks, shadow mode, the API surface, the browser tier with a fake binding, real alarms, storage bounds and
  the CPU (§8).
- UI (`npm test` in `web/`, jsdom): the transport, the formats, the inbox and drawer with ignore and undo, the add
  flow from a fragment with the block picker, the health groups, a stale save; no external URL, `fetch` only in
  `api.ts`, no HTML from strings.
- Local: `wrangler dev` with `DEV_FAKE_UPSTREAM` and `worker/test/runtime/serve-fake-sites.ts` (README "Develop").

## 11. Steps

- **W1** (this step): the IDL `proto/watch/ui/v1`, the Worker, WatchState, the UI, the tests and CI. `watch` is in
  `ci_changes.py`'s `CHECK_ONLY` (a `Watch checks` job in the gate, no deploy job), `wrangler.toml` is in
  `test_wrangler_configs.py`'s `UNDEPLOYED` with no route and the all-zeros Access AUD, and
  `deploy/deploy-vars.mjs` refuses anything but `--dry-run`.
- **W2** (the lead): create the Access application "watch" for the whole host `watch.ziyixi.science` (through
  `infra/` and "Infra apply"), commit its AUD, add `routes = [{ pattern = "watch.ziyixi.science", custom_domain =
  true }]`, add a `Watch deploy` job (cf-guard, the wrapper with the dashboard's owner secrets and a new
  `WATCH_CSRF_SIGNING_KEY`, a production check and an Access probe), and move `watch` out of `CHECK_ONLY` and
  `UNDEPLOYED` into the production lists (and the drift check) in the same commit. The first API call after the
  deploy arms the alarm.
- **W3**: after the ops-v1 proto migration merges, the notification sinks (§7): task intents of kind `SOURCE_WATCH`
  to Todofy and ops-v1 counts for the dashboard.
