# FlowDay on Workers Free: design

FlowDay runs as one Worker, `flowday`, on the account's Workers Free plan. The Worker serves the UI as static
assets and a small owner API backed by D1. This document covers the F1 port (the code, the tests and the
measurements) and the steps after it (section 11). Since **F2** CI deploys the Worker and its D1 schema; in **F3**
it served the staging Custom Domain `flowday-next.ziyixi.science`. Since the data cutover (**F4**) its only hostname
is the Custom Domain `flowday.ziyixi.science`, behind Cloudflare Access, in place of the old container's tunnel
CNAME; the container stays stopped for the rollback window (F5), and its retirement is F6.

Owner decisions (2026-10-01) this design follows:

- FlowDay is barely used and may be changed freely.
- It is a **read-only view of the task store** plus FlowDay's own time blocks: Tasks since 2026-10 (section 4),
  Todoist before. FlowDay never writes the task store.
- Sync only has to bring the store's changes in; a slower sync is fine.
- **D1 writes must stay minimal.** The Free allowance of 100,000 rows written per day is shared by every app on
  the account, and there must be room for future services. Target: a typical day stays well under 1,000 rows.
- No container in the target architecture.

## 1. Shape

```
browser ── Cloudflare Access ── Worker "flowday" ──┬── ASSETS: web/out (Next.js static export)
 (UI, reviews,                  (edge-auth JWT,     ├── D1 "flowday" (drizzle-orm/d1)
  exports)                       CSRF + Origin)     └── TASKS: Tasks' TasksApi (service binding, read only)
```

| Path | What it is |
| --- | --- |
| `wrangler.toml` | The production config: top level only, `workers_dev = false`, `preview_urls = false`; the real D1 id and Access AUD since F2; one Custom Domain and `PUBLIC_HOST` naming it: the staging host `flowday-next.ziyixi.science` in F3, the production host `flowday.ziyixi.science` since F4 |
| `worker/src/` | `index.ts` (handler) → `router.ts` (Access, PWA exceptions, logging) → `api.ts` (routes) → `store/*` (D1), `native-tasks.ts` + `sync-control.ts` (the Tasks sync and its throttle), `assets.ts` (static files, CSP), `e2e.ts` (test routes) |
| `migrations/` | `0001_init.sql`: the container-era SQLite schema, unchanged. `0002_incremental_sync.sql`: `tasks.todoist_project_id`. `0003_fewer_task_indexes.sql`: drops four indexes no query needs. `0004_focus.sql`: hierarchy/deadline fields, estimate ownership and timer command versions/receipts. `0005_drop_todoist_settings.sql`: deletes the retired Todoist settings |
| `web/` | The Next.js UI as a static export (`output: "export"`). It has no server code; `lib/client/http.ts` is its only `fetch` |
| `deploy/deploy-vars.mjs` | The deploy wrapper, the dashboard's shape: `BUILD_SHA` as a var, the owner and the CSRF key as Worker secrets. It refuses a real deploy while the D1 id or the Access AUD is the all-zeros placeholder (a guard against a revert to the F1 config) |

There is no cron, no Durable Object and no Queue. The sync runs when a page asks for it (section 4).

## 2. API

Every path needs the owner's Access JWT, verified by `packages/edge-auth`: signature, issuer, audience, expiry and
the single owner (with aliases). The exceptions are `/health` and the exact PWA files (section 7). Every non-GET
`/api` request also needs the signed double-submit CSRF token (`X-CSRF-Token` plus the `flowday_csrf` cookie) and
an allowed `Origin`.

The owner API is `flowday.ui.v1` (since 2026-10-02): `proto/flowday/ui/v1` is its one description (resources, routes,
fields, errors), in the AIP style of the repository's other UI APIs (`proto/README.md`, HTTP APIs). The Worker serves
it through the shared transcoder (`worker/src/router.ts`, handlers in `api.ts`) after Access, with the CSRF and
Origin check in the transcoder's `authorize` hook, before any body is read; the UI calls it through the shared typed
client (section 8). Bodies and answers are wire JSON (snake_case, enum names in lower case, RFC 3339 times); errors
are `google.rpc.Status` bodies whose `ErrorInfo.reason` is FlowDay's (`errors.proto`: `TASKS_UNAVAILABLE`,
`ESTIMATE_IN_TASKS`, `TASK_NOT_DELETED`, `TIMER_CONFLICT`, `RELOAD_REQUIRED`; the `TODOIST_*` reasons are retired and
never sent) or a shared one, with the
owner's English copy as its `LocalizedMessage`. A failed D1 call is `UNAVAILABLE` (safe to repeat), any other surprise
`INTERNAL`.

| Resource | Routes (under `/api/v1`) | Notes |
| --- | --- | --- |
| `tasks/{task}` | `GET tasks`, `GET`, `POST tasks`, `PATCH`, `DELETE`, `POST :undelete`, `POST tasks:sync` | The task list (pages; `show_deleted` adds the trash); a local task (its `request_id` names it, `local-<request_id>`); title, or a local task's estimate (`update_mask`); soft delete (also out of every flow, in one batch) and restore; the sync (section 4) |
| `flows/{day}` | `GET flows`, `GET`, `PATCH`, `POST :completeTask`, `POST :reopenTask`, `POST :rollover` | Every day with a flow (pages), its planned tasks in order, its done tasks and its planning flag; `task_ids` or `planning_completed` (`update_mask`); done marks; rollover of the listed tasks, or of every unfinished one only with `all_unfinished` (an empty list moves nothing) |
| `flows/{day}/notes/{task}` | `GET {parent}/notes`, `GET`, `PATCH` | One markdown note per task and day; one never written reads as empty |
| `timeEntries/{entry}` | `GET timeEntries?task_id&flow_date`, `GET`, `POST timeEntries`, `PATCH`, `DELETE` | Time entries by task, day or both (pages); a new one (its `request_id` is its ID); start and end (the duration follows) |
| `timerSession` | `GET`, `POST :command` | Server-owned start, pause, resume, stop and pomodoro transitions with an etag and request ID |
| `settings` | `GET`, `PATCH` | The source (always `tasks`), the day's capacity, the last sync; a `todoist_api_key` is refused |
| (analytics) | `GET analytics:query?start_date&end_date` | Raw rows of a range of days (planned tasks, done tasks, time entries), or every time entry without one, at most 200 rows a page with the tasks they name. See section 8 |

`GET /api/csrf` (the token and its cookie, 12-hour validity), `/health`, the PWA files and the E2E routes
(`/api/test/*`) are transport, outside the service. Lists are AIP-158 pages of at most 200 tasks, days, entries or
analytics rows (100 notes); a negative `page_size` is `INVALID_ARGUMENT`. Every page is written within Workers Free's
CPU limit even in an isolate's first request (section 6), and reads about its own rows from D1, never a whole table
(section 5, "Read budget"). Updates follow AIP-134 and AIP-203: without an `update_mask` the body is the whole
resource (its `REQUIRED` fields must be there), and an `IMMUTABLE` field (a task's description, priority, labels and
due day; an entry's task, day and source) may only repeat its stored value; a different one is `INVALID_ARGUMENT`,
never silently dropped. A local task's description over 2,000 characters is refused, like its title.
Timer commands use an etag and request receipt because two windows can otherwise save the same segment or overwrite
one another. A D1 batch changes the session, creates the elapsed entry and saves the result together; retries reuse
the request ID. The old timer PATCH and `:clear` return `RELOAD_REQUIRED`. Other mutations keep their existing
small state-setting behavior; creates retain their resource request IDs. The routes before `flowday.ui.v1` (`/api/tasks`, `/api/flows`, ...) answer 410 with the
old envelope `{error: {code: "reload_required", message, request_id}}` until 2026-11-02, so a tab still running the
old UI shows "FlowDay has been updated. Reload the page" on its next write and changes nothing.

`/api/export` and the server-side review maths of the container era are gone. The browser does that work now
(section 8).

## 3. Data

`migrations/0001_init.sql` reproduces the container's SQLite file: the 7 tables, the 10 named indexes and the 3
unique pairs, with no foreign keys and no triggers. Column order matches the live file. `tasks.description`,
`deleted_at` and `deleted_source` were added there by `ALTER TABLE`, so they come last.
`0002` appends one nullable column, `tasks.todoist_project_id`. It is not indexed (section 5).
`0003` drops four indexes that only cost writes: `tasks.due_date` (no query filters by it; the browser groups tasks
by day), `tasks.todoist_id` (a Todoist task's id is its Todoist id, so the primary key finds it), and the
`flow_date` indexes of `flow_tasks` and `completed_flow_tasks` (the leading column of their `UNIQUE(flow_date,
task_id)` index serves the same lookups and ranges). `worker/test/runtime/schema.test.ts` pins every table's
columns in order, the six remaining indexes, the column defaults, and checks with `EXPLAIN QUERY PLAN` that every
lookup by day, task or id still uses an index.

Settings keys: `day_capacity_mins`, `planning_completed:<date>` and `last_sync_at` (container era). The sync adds
`sync_claimed_at` (epoch ms, with the count of failed syncs before it), `tasks_sync_cursor`, `tasks_sync_catalog_v2`
(the last catalog read) and, only while more pages follow, `tasks_sync_pending`. `0005` deleted the Todoist era's
keys: the sealed key (`todoist_api_key`; its `CREDENTIAL_KEY` secret is gone too), `todoist_sync_token`,
`todoist_projects`, `todoist_sync_pending`, `todoist_hierarchy_refresh` and the first catalog cache
`tasks_sync_catalog`. FlowDay holds no credential for its source.

## 4. Tasks sync

**Read only.** `native-tasks.ts` reads Tasks through the `TASKS` service binding to its named `TasksApi`
entrypoint (`props.access = "read"`), with generated `TasksUiService` GET requests only; the entrypoint denies writes
on its side too. No credential, no public fetch. A missing binding, a failed read or an invalid page answers
`TASKS_UNAVAILABLE` (503) and never falls back to anything else.

**Incremental.** `ListChanges` returns the task changes after `tasks_sync_cursor`, at most `NATIVE_SYNC_PAGE` (100)
per page; the catalog (projects and labels) is read only on first use or when a page reports a catalog change, and
cached in `tasks_sync_catalog_v2`. Responses are bounded to 2 MiB. The mirror keeps the bounded description preview;
full task text stays in Tasks. An empty cursor starts the feed from the beginning (`full_sync`).

**One request, at most three D1 round trips:**

1. One read of the settings (`tasks_sync_cursor`, `tasks_sync_catalog_v2`, `tasks_sync_pending`, `sync_claimed_at`,
   `last_sync_at`).
2. **Atomic throttle**, 1 row (`sync-control.ts`): a compare-and-set of the claim read in step 1,
   `INSERT INTO settings (key, value) VALUES ('sync_claimed_at', :claim) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value IS :previous AND CAST(settings.value AS INTEGER) <= :now - :interval`.
   Exactly one of several concurrent tabs or devices gets `changes = 1`. The others answer `throttled` without
   reading Tasks or writing anything. The interval is 5 minutes for `auto` and 30 seconds for `manual`, and 0 for
   the next page of a run (`tasks_sync_pending`).
3. One page read (and the catalog when needed), then **one atomic `batch`** that applies the page with its cursor:
   - after a catalog read, every mirrored task takes its project's current name and colour (only rows that differ,
     hidden ones included); a task without a project is in the catalog's Inbox;
   - diff upsert of the open tasks (`json_each` over one JSON parameter); a row whose values are all unchanged is
     not written, and a task hidden by a sync comes back;
   - completed, deleted or archived tasks are hidden (`deleted_source = 'sync'`), never physically deleted;
   - `tasks_sync_cursor`, `tasks_sync_catalog_v2` (each written only when it changed), `tasks_sync_pending` and
     `last_sync_at`.

**Paging.** More changes than a page answer `partial`; the page asks again right away (at most 12 requests per
sync) and the next page starts at the stored cursor.

**Kept from the container era** (each has a test): a task hidden by a sync comes back by itself when Tasks lists it
again; a task deleted in FlowDay (`'local'`, or the legacy `NULL` source) stays deleted; a mirrored task's estimate
is its Tasks duration (every changed row takes it, a cleared duration clears it, the editor shows it read-only and
UpdateTask refuses another value, `ESTIMATE_IN_TASKS`); local tasks are never touched by the sync. Imported tasks keep
their FlowDay primary keys and the `todoist_id`/`todoist_project_id` columns, which now hold Tasks IDs; queues,
estimates, timers and past time entries keep their references.

**Failures and backoff.** A failed read writes only the claim, so `last_sync_at` still means "last successful sync
request", and the cursor stays where it was. A claim newer than `last_sync_at` is a failed sync, including a request
the runtime stopped (for example for CPU) after its claim. Each failure in a row doubles the automatic interval (5,
10, 20 … up to 160 minutes), stored with the claim as `<epoch ms>:<failures>`, so a failing sync cannot repeat every
5 minutes all day. "Sync now" keeps its 30 seconds; the next success resets the interval. A run of pages that failed
mid-way resumes from its cursor after the backoff.

**After a Tasks restore** a change cursor ahead of Tasks fails the sync with `TASKS_UNAVAILABLE` instead of reporting
it synced; `deploy/reset-tasks-mirror.sql` hides the mirrored rows and forgets the cursor and catalog, so the next
sync replays the restored feed from the start ([Tasks backup](../../tasks/docs/backup.md)).

**When the page syncs** (`web/lib/hooks/auto-sync.ts`, tested with a fake clock):

- once when the page opens;
- every 10 minutes while the page is visible;
- on becoming visible again, when the last attempt is older than 5 minutes;
- never while the page is hidden (a background tab or a minimised PWA window).

The Sync buttons send `manual`. A `partial` answer is followed by the next request right away. The task list is
reloaded once at the end, only when an answer reported changes, a full sync, or a `last_sync_at` that another tab
or device has moved. Automatic failures are quiet; manual ones show the banner.

## 5. Write budget

**How D1 counts.** Measured in workerd through `meta.rows_written`; it matches D1's billing rule that each index a
write touches costs one more row:

| Write | Rows |
| --- | --- |
| Insert a task (row, key index, `deleted_at` index) | 3 |
| Update a task's unindexed column (title, due day, estimate, project, labels, …) | 1 |
| Hide or restore a task (`deleted_at`, indexed) | 2 |
| Any `UPDATE`/upsert whose `WHERE` finds nothing different | 0 |
| Insert a settings row / update its value / delete it | 2 / 1 / 2 |
| Insert a time entry (row, TEXT key index, `task_id`, `flow_date`) | 4 |
| Insert a flow task (row, key, unique pair, `task_id`) | 4 |
| Move a flow task (`sort_order`, unindexed) | 1 |

`store.test.ts` asserts the task and time-entry rows. SQLite rewrites an index entry whenever the index's column
appears in an `UPDATE`'s `SET` list, even when the value is the same. The sync upsert therefore never sets
`deleted_at`; the restore gets its own `UPDATE`, limited to the rows a sync had hidden. Before `0003` dropped the
unread indexes, a new task cost 5 rows and a new flow task 5.

**Other writers, all diff-only.**

- `setFlow` deletes only the tasks that left the day, inserts only new ones and moves only rows whose position
  changed (a reorder of 2 tasks costs 2 rows). The container rewrote the whole day: about 5 rows per task.
- Settings, estimates, titles and notes are conditional (`IS NOT`). Saving the same value writes 0 rows.
- A duplicate completion is `ON CONFLICT DO NOTHING` (0 rows).
- Notes save 1.5 s after typing stops (500 ms in the container). A pending save is flushed when the card closes
  or the page hides.

**Measured** (`worker/test/runtime/native-tasks.test.ts` and `budget.test.ts`, which assert the bounds):

| Scenario | Rows written |
| --- | --- |
| Simulated day of sync: 200 tasks, 20 Tasks changes (10 edits, 3 reschedules, 3 completions, 1 deletion, 2 new tasks, 1 project rename covering 40 tasks), two tabs polling every 10 minutes for 16 hours. Result: 96 syncs, 96 throttled, 96 page reads | **281** (asserted < 320) |
| Simulated day of use: plan 8 tasks, reorder twice, 8 estimates, 12 timer segments, 6 notes × 5 saves, 2 manual entries, 6 completions, a rollover, a quick task | **221** (asserted < 250, and no step above its count through the routes before `flowday.ui.v1`: the same 221) |
| One-off first sync of a new account with 200 tasks (two pages) | 614 (3 per task; asserted < 620) |
| A sync with no change in Tasks | 2 (claim + `last_sync_at`) |
| Each further page of a run | its changed rows + the claim, `last_sync_at` and cursor |
| A throttled sync | 0 |

`last_sync_at` is written on every sync on purpose: it marks the claim as finished, which the failure backoff
needs (192 of the 281 rows). A typical day is therefore about **500 rows**, about 0.5% of the account's 100,000.
Before the port, the container
upserted every task every 60 seconds whether or not the tab was visible. That was about 4 rows per task per
sync: roughly 0.58–1.15 million rows a day for 200 tasks.

Every API mutation logs one line (`request_id`, method, the rpc's name as `route`, status, error reason, `rows_written`, `rows_read`)
and returns its row count in `x-flowday-rows-written`. Workers Observability can then show the real figure
after F2. The logged `rows_read` counts only statements run through `run()`, `all()` or a batch (writes and raw SQL);
drizzle runs its selects with `raw()`, which reports no counts, so the reads are measured by the tests instead.

**Read budget.** D1 Free allows 5 million rows read a day, shared by every app of the account. The UI reads every
page of a list (the task list and every flow on each load, every analytics page of a review), so a page must read
about its own rows: every list seeks to its cursor through an index (`rowid` for tasks; the unique `(flow_date,
task_id)` indexes and the settings key for flows, which first pick the page's days and then read only those days;
`flow_date` for time entries and analytics, with one lower bound, the later of the range's start and the cursor's
day, because SQLite seeks to only one of several). `worker/test/runtime/reads.test.ts` reads each list to its last
page on two synthetic years (1,000 tasks, 8 planned and 4 done tasks a day, 4,000 time entries), adds up D1's own
`rows_read` of every statement (selects included) and asserts fewer than 2 rows read per row answered. Measured:

| List, read to its last page | Pages | Rows answered | Rows read |
| --- | --- | --- | --- |
| `QueryAnalytics`, every entry (the work-pattern stats) | 20 | 8,000 | 8,252 |
| `QueryAnalytics`, a year (an export) | 32 | 12,751 | 13,329 |
| `ListFlows` (730 days) | 4 | 9,490 | 12,467 |

Before each page sought to its cursor (the first `flowday.ui.v1` build), a review's probe on similar data read
122,000 rows for the work-pattern stats (20 pages re-sorting the whole `time_entries`, which has no `start_time`
index), 13,070 for a year and 52,560 per load for the flows: growing with the square of the data. A `start_time`
index was not added, because it would cost a row write per entry.

## 6. Workers Free limits

| Limit | FlowDay |
| --- | --- |
| 10 ms CPU per request | Measured in workerd from the isolate's CPU profile (`cpu.test.ts`). Since the `flowday.ui.v1` review fixes (2026-10-02, reference milliseconds, medians of three fresh isolates on the first run): **every list as an isolate's first API request**, on a heavy owner's history (1,000 tasks, 396 days of 8 planned and 4 done tasks, 2,000 entries): a page of 200 tasks **5.5 ms** (8.5 before), 200 days of flows **6.3** (10.1), 200 of a task's entries **5.1** (7.5), 100 notes of 2,000 characters **3.7** (6.0), the first analytics page of every entry **6.5** (9.5) and of 396 days **6.7** (25.6: that page then carried the whole range's flows and their tasks); warm 1.4–3.7 ms. The Tasks sync's page of 100 changes is measured cold in `native-tasks-cpu.test.ts` (first run and median below 10 ms, in three fresh isolates); a week of analytics 2.3 ms; the page with CSP hashing 0.4–0.8 ms. An isolate's first run of a list cost several times a warm one, mostly in drizzle's query building and row mapping, the messages and the wire writer: `worker/src/warmup.ts` runs each list's query (through a binding that is never called) and answer on synthetic rows at startup, in the global scope (100 rounds add about 80 ms to an isolate's startup in workerd, against Workers' 1 s startup limit; the previous warm-up of the messages only, about 30 ms; `worker/test/warmup.test.ts` checks its rows map as a request's do), and the page sizes (`worker/src/limits.ts`) bound the rest. The test asserts every warm best < 6 ms and every list's first request < 10 ms, the Free limit itself (GitHub runners read cold runs up to about 1.3 times the reference machine, an Apple M1 Max, which 6.7 ms stays within); the heavy handlers are measured warm in one isolate of their own (`tools/workerd-cpu` and its README). Measured CPU scales with the machine (GitHub runners measure the sync 1.1–2.1× the reference, varying 2× within an hour), so the test calibrates in the same isolate with the meter it shares with the other apps (`tools/workerd-cpu`): a fixed, deterministic workload shaped like the sync's (parse a synthetic 1,000-item answer, sort, map to rows, serialise) runs in the Worker through the inspector's `Runtime.evaluate`, and its warm median wall time over the reference's (4.8 ms) is the speed each isolate's numbers are divided by, never below 1×; a median above 5× fails the test as too slow to measure. These are estimates on the test machine, not Cloudflare's meter; a sync request stopped for CPU resumes from its cursor after the backoff. In Observability, watch the log lines whose `route` is `SyncTasks` (`POST /api/v1/tasks:sync`) and any `INTERNAL` or `UNAVAILABLE` |
| 50 subrequests | `SyncTasks` (`POST /api/v1/tasks:sync`): 1 or 2 over the `TASKS` binding (the page, and the catalog when it changed). Everything else: 0 |
| 50 D1 queries per invocation | A sync request: 1 settings read, 1 claim, and a batch of at most 1 project refresh + 1 upsert + restore + hide + 4 settings = 10 |
| 100 bound parameters per statement | Id lists always travel as one JSON parameter to `json_each(?)`. Tests cover 140–250 ids |
| Script size | 516.1 KiB raw, **114.3 KiB gzip** since `flowday.ui.v1` (261.2 KiB raw, 56.1 KiB gzip before: the protobuf-es runtime, the HTTP runtime of `proto/ts` and the descriptors). CI fails above a 140 KiB gzip budget, a ratchet at about 1.2 times that (`worker/scripts/bundle-size.mjs`, measured by the shared `tools/bundle-size`) |
| Static assets | 44 files, 1.77 MiB (`web/scripts/check-export.mjs` keeps it under 1,000 files); the UI's JavaScript 398.9 KiB gzip (362.8 KiB before), held to a 480 KiB budget (`web/scripts/js-budget.mjs`) |
| Cron | None (the account has 5, 3 used) |

The reviews moved to the browser because they ran per minute of logged time. On the server that took 40–63 ms per
100 hours, and those requests would have exceeded the CPU limit.

## 7. Security, PWA and headers

- **Access.** `edge-auth`'s verifier with the dashboard's policy (case-insensitive owner, aliases, cookie
  fallback, cached JWKS). The owner and aliases are Worker secrets.
- **Loopback dev bypass.** Only on http://127.0.0.1 or localhost, and never for a request carrying `cf-ray`. Used
  only by `wrangler dev` and the tests.
- **CSRF.** Signed double-submit, bound to the owner, with `Origin` restricted to `https://$PUBLIC_HOST`, plus the
  loopback origin under the bypass. `PUBLIC_HOST` is `flowday.ziyixi.science` since the F4 cutover (the F3 staging
  host `flowday-next.ziyixi.science` before it): one host at a time can make writes.
- **Private headers on everything.** `no-store`, `nosniff`, `no-referrer`, `DENY` and a strict CSP. The HTML's CSP
  adds the SHA-256 of each inline script in the served page (Next.js inlines its boot and RSC payload). No other
  inline script may run. `/_next/static/*` is cached as immutable.
- **PWA exceptions.** These exact paths are served without a JWT: `/pwa/manifest.webmanifest`, `/pwa/sw` (the
  service worker, from `sw.js`, with `Service-Worker-Allowed: /`), `/pwa/icon-192x192.png`, `icon-512x512.png`,
  `icon-maskable-512x512.png`, `icon.svg` and `apple-touch-icon.png`. While the Access app `flowday-bypass` covers
  `/pwa/*` (F2–F6: `flowday.ziyixi.science/pwa/*`; from F3 until the cutover also
  `flowday-next.ziyixi.science/pwa/*`), those requests arrive without a JWT. Everything else under `/pwa/` needs
  one, and so does all of `/api`. `edge.test.ts` covers both directions, and "FlowDay deploy" checks them on the
  live host, `PUBLIC_HOST` (section 11, F3).
- **Manifest with credentials.** The manifest link has `crossorigin="use-credentials"` (checked in the built HTML),
  so the bypass can be removed later.
- **Service worker `flowday-v2`.** It drops older caches, never caches `/api`, caches only plain same-origin `200`
  responses that were not redirected (never an Access login page), and serves the cached shell offline.
- **E2E routes.** `/api/test/*` exists only with `E2E_TEST_ROUTES=true` and an active loopback bypass. The
  production export is checked for E2E markers.
- **Logs.** IDs, routes, statuses, codes and row counts only. Never a token, a title or a body.

## 8. Client

- **One API client, one request wrapper.** `web/lib/client/flowday-api.ts` is the UI's one module of owner API calls:
  the shared typed client (`proto/ts/http-client.ts`) over `FlowDayUiService`, built from the same descriptors the
  Worker routes with. It reads every page of a list and turns the generated messages into the UI's view models
  (`lib/types/task.ts`, the stores' state) in one place; no hand-written wire type is left. `web/lib/client/http.ts`
  is its transport and the only module that calls `fetch`; ESLint rejects `fetch` anywhere else in app code. It
  fetches the CSRF token at start and attaches it to every write.
- **Expired token.** A `403 CSRF_FAILED` (the token is valid for 12 hours, and a PWA window stays open longer)
  refreshes the token and sends the write once more (the same request, so the same `request_id`).
- **Expired Access session.** A redirect, a login page in place of JSON, or the Worker's own 401 is never retried.
- **Visible failures.** Every failed write, and every expired session, appears in a banner with Reload. A failed
  write is never swallowed. Optimistic local state is kept unless the store reloads from the server, which is the
  container era's behaviour for flows and tasks.
- **Ordered, surviving writes.** Writes small enough are sent with `keepalive`, so a save made while the page
  unloads still arrives. Timer-session writes are queued so they cannot land out of order.
- **Reviews and exports in the browser.** The UI asks `QueryAnalytics` for the rows of a range (a day, an ISO week,
  the export's dates, or every time entry for the work-pattern stats), page by page: each page holds at most 200 rows,
  in one order across the pages (the planned tasks, then the done tasks, then the time entries), with the tasks it
  names, so a year's export is many small pages rather than one first page with the whole range. The container's pure functions
  (`features/analytics/services/analytics-service.ts`) compute the reviews in the browser's time zone. The Export
  dialog builds CSV or JSON from the same rows (`features/settings/services/export-service.ts`) and saves it from
  a `blob:` URL.
- **Shared types.** Both sides take every request and answer shape from the generated code of
  `proto/flowday/ui/v1` (`@ziyixi/proto`), so `tsc` fails on either side when the IDL changes; the Worker's own
  records (`worker/src/model.ts`) are not the wire. Next.js resolves the linked package from the monorepo root
  (`turbopack.root` in `web/next.config.ts`).

## 9. Tests

| Suite | Where | What |
| --- | --- | --- |
| Worker unit | `worker/test/*.test.ts` (Node) | CSP hashing, the PWA list, the startup warm-up (its rows map as a request's do; its time) |
| Worker runtime | `worker/test/runtime/*.test.ts` (Miniflare/workerd, real D1, a fake `TASKS` binding: an empty Tasks unless a test serves its own) | Schema and query plans; every store module (the container's query tests, async), including more than 100 ids and row counts; every rpc of `flowday.ui.v1` through the shared typed client with CSRF (pages and their tokens, update masks, the `request_id` of a create, AIP-164 deletes, Status reasons), the wire JSON, and the old routes' 410; Access with real RS256 JWTs; CSRF and Origin; PWA exceptions; CSP; E2E gating; the sync rules, throttle, concurrency, backoff, paging, archive and restore, a missing binding; the write budget; the rows each paged list reads (`reads.test.ts`); CPU, with every list as an isolate's first request |
| UI unit and integration | `web/__tests__` (Vitest, an in-memory fake of the Worker serving `FlowDayUiService` through the same shared transcoder, so on the real wire) | Stores, the client and its transport (CSRF retry, session expiry, banner, requests never laid out), the auto-sync scheduler, reviews and exports from rows |
| Playwright | `web/__tests__/ui` against `wrangler dev` (`web/scripts/e2e-server.mjs`: E2E export, local D1, bypass, an empty fake Tasks as `TASKS`) | The 53 UI scenarios; all 53 passed locally on 2026-10-18 (Chromium headless shell). With `flowday.ui.v1` 51 passed locally (Chromium headless shell, 2026-10-02); UI-005 (a note typed 0.7 s before a reload) fails about 3 runs in 5 on `main` as well, the same rate. CI does not run them yet, as before F1 |
| Import tool | `deploy/migrate/test_flowday_migrate.py` (Python, synthetic container-era files only) | One operand per value for every hard text (quotes, SQL syntax, emoji, all control characters, hundreds of CRLFs, transaction keywords), exact reals, the statement limit, a WAL that only the staged checkpoint applies, untouched source files, the host's hashes, the excluded key, refusals (a NULL primary key, a cloud-synced work directory); a full export, import into a local D1 (the pinned wrangler and the committed migrations) with edge reals and ±Inf, verify and reset, and no wrangler debug log left behind; the `--remote` paths and the daily write budget against a fake wrangler |
| Config and wrapper | `deploy/test/*.test.mjs`, `.github/scripts/test_wrangler_configs.py`, `test_ci_changes.py`, `test_drift_desired.py` | No route and no hostname (F2), the real D1 id and AUD, no personal value, the placeholder guard; the deploy job's secrets (the dashboard's owner, FlowDay's own keys), migrations before the Worker, the hostname guard, and its production check against a stubbed wrangler; the dashboard's desired state for drift |

The README figures and the UI goldens (`docs/readme`, `docs/ui-goldens`) are compared pixel by pixel on Ubuntu
24.04. Their scripts now start the app through `e2e-server.mjs`. They were not regenerated in F1: the UI is
unchanged apart from the error banner, which only appears on failure.

## 10. Local development

From `worker/`: `npm ci`, then `npm run dev`. That is `wrangler dev` with the production config: local D1 and
`--local-upstream 127.0.0.1:8789`. The values go in `flowday/.dev.vars` (see `.dev.vars.example`). Build the UI
first (`cd ../web && npm run build`), and apply the migrations locally:
`npx wrangler d1 migrations apply DB --local --config ../wrangler.toml`. Never use `--remote`.

## 11. Migration plan after F1

- **F2 (resources, no route).** Done in code (2026-10-01); live once its commit's `FlowDay deploy` passes on
  `main`. The job ("FlowDay deploy" in `.github/workflows/ci.yml`) builds the export, writes the secrets file,
  dry-runs, runs the hostname guard (no route: it passes without a request), applies the D1 migrations, deploys
  through the wrapper and then, with no host to probe, reads production through the API: exactly one version at
  100% whose `BUILD_SHA` is the commit, and no pending migration. The Worker has no route, no `workers.dev` and no
  preview URL, so nothing can reach it yet. Rollback: [`../README.md`](../README.md) "Rollback and removal".
  - Create the D1 database `flowday` and commit its id.
  - Reuse the existing Access app `flowday`: commit its AUD as `ACCESS_AUDIENCE`, unchanged.
  - Add the GitHub secrets `FLOWDAY_CSRF_SIGNING_KEY` and `FLOWDAY_CREDENTIAL_KEY` (each `openssl rand -hex 32`;
    keep an offline copy of the credential key, although losing it only means entering the Todoist key again).
    The owner comes from `DASHBOARD_ACCESS_OWNER(_ALIASES)`, like the dashboard's own.
  - Add the deploy job ("FlowDay deploy", through `deploy/deploy-vars.mjs exec … wrangler deploy` with
    `--secrets-file`, after `wrangler d1 migrations apply DB --remote`).
  - Remove `flowday` from `CHECK_ONLY` in `.github/scripts/ci_changes.py`.
  - Move `flowday/wrangler.toml` from `UNDEPLOYED` to `PRODUCTION` in `test_wrangler_configs.py`, add it to
    `drift_desired.py` and regenerate the dashboard's desired state.
  - The wrapper then refuses the placeholders again, as a guard against a revert.
  - Not in F2: `infra/` (OpenTofu) did not adopt the D1 `flowday` or the Access apps yet. IaC P4 imported the D1
    database and both Access apps (`flowday`, `flowday-bypass`); the F3 staging host leaves both apps through an
    `infra/` commit after F4 (`infra/README.md` "FlowDay").
- **F3 (staging host).** Done in code (2026-10-01); live once its commit's `FlowDay deploy` passes on `main`.
  `wrangler.toml` lists the Custom Domain `flowday-next.ziyixi.science` and sets `PUBLIC_HOST` (the CSRF origin) to
  it, in its own commit; nothing else changes (cf-guard: a new hostname with no DNS record and no other Worker).
  - **Access first.** The Worker verifies the Access JWT itself, but the edge must cover the host before it serves
    anything: before that commit is merged, `flowday-next.ziyixi.science` is added to the existing Access app
    `flowday` (a second destination of the same app, so the AUD and the policy stay the same), and
    `flowday-next.ziyixi.science/pwa/*` to the app `flowday-bypass`.
  - **PWA files: the bypass, as in production.** The staging host gets the same `/pwa/*` bypass as
    `flowday.ziyixi.science` (F2–F6), so it rehearses exactly what F4 puts in production. Without it Access would
    answer every anonymous `/pwa/` request itself and the Worker's exceptions could not be checked at all; whether
    the bypass can go (the manifest with credentials) is F6's own device check, which can first drop only the
    staging destination.
  - **CI checks the live host** after the deploy and the API check: an unauthenticated `GET /` and `/api/v1/tasks` are
    answered by Access with a 302 to its login page for this host (the dashboard's probe); the manifest, two icons
    and `/pwa/sw` answer 200 with their media types from the Worker, and `/pwa/sw.js` (in the export, not on the
    list) the Worker's 401.
  - **Owner checks on a real device:** sign-in, install, real icons (the manifest with credentials), cold start,
    re-login after the Access session expires. Rehearse the DNS rollback path before F4.
  - **Staging writes go to the production D1** (there is only one). Before the first one, note a D1 Time Travel
    bookmark (`wrangler d1 time-travel info flowday`); before the F4 import, restore it (within Time Travel's 7
    days on Free) or delete the staging rows, so that the import starts from empty tables.
  - **Rollback.** Revert the commit (the routes line and `PUBLIC_HOST`, and the regenerated drift state), then
    detach the Custom Domain by hand: a deploy whose config lists no route leaves the Worker's live Custom Domains
    alone, so the revert alone does not remove it. Then remove the staging destinations from both Access apps
    through `infra/` (one commit, "Infra apply" with `update=2@<fingerprint>`; `infra/README.md` "FlowDay"), never in
    the dashboard. [`../README.md`](../README.md) "Rollback and removal".
- **F4 (data cutover, owner present).** Done in code (2026-10-01): the import tool, the cutover commit and
  the commit that clears its cf-guard allowances; live once the cutover's `FlowDay deploy` passes on `main` and
  the steps below are recorded. Frozen from the container stop until the cutover commit's deploy passes:
  export, import, verify and one `FlowDay deploy` job (about 5 minutes, with the checks reused). The data moves with
  `deploy/migrate/flowday_migrate.py` (standard library only; its tests in FlowDay checks use synthetic files and a
  local D1). It never prints a row: only table names, counts, byte totals and digests (prefixes at export, equal or
  DIFFERENT at verify). Every file it writes stays in a private work directory (mode 0700) on a local disk: it
  refuses one inside the repository or under a cloud-synced folder (`~/Library/CloudStorage`, iCloud Drive,
  `~/Desktop`, `~/Documents`, Dropbox, OneDrive), so make it with `mktemp -d`. Every wrangler call runs with
  `WRANGLER_WRITE_LOGS=false`: by default wrangler appends all it prints, the rows `verify` reads included, to a
  debug log kept 30 days in its global config directory (`~/.wrangler/logs` when `~/.wrangler` exists, otherwise
  `~/Library/Preferences/.wrangler/logs` on macOS and `~/.config/.wrangler/logs` on Linux). Run any manual
  `wrangler d1 execute` that returns rows with the same switch, or delete its log afterwards.
  - **What the tool does.** `export --source <copy>/flowday.db --workdir <private> --expect-sha256 <copy>/host.sha256`
    checks the copied files against the hashes taken on the host after the stop, copies them into the work
    directory and checkpoints that copy (`file:<copy>?immutable=1` alone would ignore the WAL and lose its last
    commits), checks it (`integrity_check`), proves the source files byte-identical afterwards, and refuses a table
    or column that is not migration 0001's, invalid UTF-8, a settings key only the Worker writes, a row with a NULL
    primary key, a `-wal` none of whose frames apply, and more than `--max-rows-written` (30,000) estimated D1 rows
    written (index entries included). It writes `import.sql`: one INSERT per row with named columns and one operand
    per value (no `unistr(`; a text with a control character such as CR, or with "BEGIN TRANSACTION"/"COMMIT;"
    that wrangler's trimmer would rewrite, as `CAST(X'<utf-8>' AS TEXT)`; a real as its exact mantissa times powers
    of two), `settings` **without** the `todoist_api_key` row (the Worker uses only a key sealed under its own
    secret), and every statement under D1's 100,000 bytes (a longer text is inserted empty, then appended in
    chunks). One file, because wrangler imports a `--remote` file atomically. `import` runs `check-empty`, checks the
    write budget (below), saves the empty D1's Time Travel bookmark to `<private>/d1-bookmark-import-<time>.json`
    (only the path is printed) and then runs `wrangler d1 execute DB --remote --file import.sql --yes --json`
    (wrangler's own output goes only to the work directory). Its answer is the JSON after the progress lines that
    wrangler's spinner prints to stdout even with `--json` ("Checking if file needs uploading", "Uploading ..."):
    the first production import exited 2 with "wrangler did not answer with JSON" although `verify` then found D1
    equal to the snapshot. When wrangler exits 0 and its answer still cannot be read, `import` exits 3
    (unconfirmed) and asks for `verify`, never for a second import. `verify` compares per table `count(*)`, the
    total length of each column's text and BLOBs, and the SHA-256 of the sorted canonical rows (reals exactly, ±Inf
    included), from read-only SELECTs paged by primary key (`WHERE pk > :last ORDER BY pk LIMIT 1000`: each row is
    read once, where LIMIT/OFFSET would read the skipped rows again on every page), and checks that D1 holds no
    `todoist_api_key` row. The D1-only sync, parent and deadline fields must remain NULL; nonempty imported estimates
    become overrides, the timer's initial etag is `0`, and `timer_commands` stays empty. `reset` empties D1 again: `--bookmark-env NAME` or
    `--bookmark-file <saved file>` restores a Time Travel bookmark (writes no rows through SQL; the bookmark saved
    by a reset undoes that reset), and `--delete-all-rows --workdir <private>` saves the current bookmark in the
    work directory and deletes every row in one atomic file. It deletes only what is that work directory's own
    import: no table may hold more rows than its manifest, and no row that only the Worker writes (its sync
    settings, changed import baseline or timer commands) may exist. After the cutover D1 is production data, which only an
    explicit `--confirm-database flowday` deletes.
  - **The daily write budget.** The account's 100,000 rows written per UTC day are shared by every app, and a
    deletion costs about as many rows as the import did. `import` and `reset --delete-all-rows` each estimate their
    own rows written (the import from its file, the reset from D1's row counts, index entries included) and refuse
    when the work directory's ledger (`<private>/d1-writes.json`) would pass `--max-rows-written-per-day` (30,000)
    for the UTC day, or when the account's D1 rows written today plus the estimate would pass
    `--max-account-rows-written-per-day` (80,000). The account's figure comes from the GraphQL Analytics API
    (`d1AnalyticsAdaptiveGroups`, every database summed), so `CLOUDFLARE_API_TOKEN` needs Account Analytics Read
    besides D1 Edit, and the account is `CLOUDFLARE_ACCOUNT_ID` or the config's `account_id`; analytics lag a few
    minutes, so the ledger counts when it is larger. Without the token, or on an API error, the write is refused.
    **Make at most one import attempt per UTC day**: on a failed verify, restore the bookmark
    (`reset --remote --bookmark-file <private>/d1-bookmark-import-<time>.json`, which writes no rows through SQL)
    and retry after 00:00 UTC.
  - **Landing the commits.** Three commits on top of each other: the import tool (no host change; it can land any
    time), the cutover commit (the hostname move below) and the commit that clears its cf-guard allowances. Never
    push or merge them in one go: CI deploys only the last commit of a push, and the clearing commit deployed while
    the staging host is still attached and the tunnel CNAME is still in place fails cf-guard (an unlisted live
    Custom Domain and an unallowed DNS conflict), with the container already stopped. Push each by its SHA with
    `git push origin <sha>:main`, and the next one only after its `FlowDay deploy` passed. The cutover commit
    touches `.github/`, so every app's checks run for it (Website Playwright, Todofy runtime and more): run them
    before the freeze on a branch (`git push origin <cutover sha>:refs/heads/flowday-f4-cutover`, a branch run never
    deploys), and the push of the same SHA to `main` then reuses that green run and goes straight to the deploy
    (README "CI", `checks_reused`). `main` must not move in between: a rebased cutover commit is a new SHA, which
    needs its own branch run first.
  - **Before the freeze.** Land the import tool. Check that the F3 Time Travel bookmark is still within its 7 days
    and hold it in an environment variable, never in a file in the repository. Save the current DNS record of
    `flowday.ziyixi.science` (the tunnel CNAME: target, proxied flag, TTL) somewhere private for the rollback.
    Push the cutover commit to the branch and wait for its run to pass.
  - **The freeze, in order.** (1) Close every `flowday-next.ziyixi.science` tab and uninstall the staging PWA on
    every device: a keepalive or queued timer write (section 8) would land in the freshly imported D1. (2) Stop the
    container; this is required, not just closing tabs: a clean stop checkpoints the WAL, and the container must
    not take a write after the copy, which would never reach D1 (it keeps serving `flowday.ziyixi.science` until
    the cutover deploy). It stays stopped until that deploy passed, or until the rollback below. (3) On the host,
    after the stop, record `sha256sum flowday.db*` into `host.sha256`; copy it, `flowday.db` and, if present,
    `flowday.db-wal` into a local directory that is not cloud-synced. Never open the live file. (4) `export` (with
    `--expect-sha256`). (5) `check-empty --remote`; if staging left rows, first `reset --remote --bookmark-env
    NAME`. (6) `import`, then `verify` (after exit 3, unconfirmed, only `verify`); on DIFFERENT or any error stop
    here: reset with the bookmark and start the container again (nothing else changed). (7) `verify` once more;
    then delete the tunnel CNAME of `flowday.ziyixi.science` (saved before the freeze) and right after it push the
    cutover commit's SHA to `main`. The Workers Custom Domain API refuses a hostname with a DNS record it did not
    create (Cloudflare error `100117`), even though CI's wrangler passes `override_existing_dns_record` and
    cf-guard allowed the conflict, so with the CNAME still in place the deploy fails (this happened in
    production). Until the deploy attaches the Custom Domain the hostname does not resolve; the container is
    stopped anyway. (8) When its `FlowDay deploy` passed, `verify` again before the owner first signs in on
    `flowday.ziyixi.science`.
  - **After the cutover deploy.** The owner signs in on `flowday.ziyixi.science` and checks the data, then enters
    the Todoist key once in Settings (stored sealed). The first sync is then a full sync, in chunks of 200 tasks.
    It writes `todoist_project_id` once into every Todoist task row (about one row each, a one-off cost of roughly
    the task count), so `verify` reports that column from then on. Push the clearing commit. Delete the work
    directory, the copy and `host.sha256`.
  - The hostname move is its own commit (pushed alone by its SHA during the freeze, after the import is verified, see
    "Landing the commits"):
    `wrangler.toml` lists only `flowday.ziyixi.science` and sets `PUBLIC_HOST` to it (writes from the staging host
    stop). The Access apps already cover the host (the container used them). Before merging it, save the current
    DNS record of `flowday.ziyixi.science` (the rollback restores it: [`../README.md`](../README.md) "Rollback and
    removal"). wrangler applies the listed Custom Domains as the Worker's complete
    set, so the deploy detaches `flowday-next.ziyixi.science`; and CI's non-interactive wrangler asks the API to
    overwrite an existing DNS record of a new Custom Domain, which the API refused for the tunnel CNAME of
    `flowday.ziyixi.science` (error `100117`): the CNAME is deleted by hand right before the deploy (the freeze's
    step 7). cf-guard stops both unless allowed, so that commit sets both allowances on FlowDay's guard step:
    `CF_GUARD_ALLOW_REMOVE: flowday-next.ziyixi.science` and `CF_GUARD_ALLOW_CONFLICT: flowday.ziyixi.science`
    (the tunnel CNAME is the allowed conflict; cf-guard now takes the kind with the name, which would be
    `dns:flowday.ziyixi.science`, and with the CNAME deleted first there is no conflict to allow), and the guard
    test in `.github/scripts/test_ci_changes.py` expected exactly those two (`HostnameGuard.ALLOWED`). The next commit cleared
    both again (`ALLOWED` is empty). After that, and after IaC P4's first "Infra apply" (the import of both apps), remove the staging destinations from both Access apps through `infra/`, never the dashboard: one commit drops it from both entries of `local.flowday_apps` and empties `RETIRING_HOSTS`, and "Infra apply" applies the reviewed `update: 2` (`infra/README.md` "FlowDay"); the deploy already detached the
    staging Custom Domain (check Workers & Pages → `flowday` → Domains & Routes, and that no DNS record is left for
    `flowday-next.ziyixi.science`).
- **F5 (7-day rollback window = D1 Time Travel).**
  - Keep the container stopped and its data directory untouched.
  - Every change in the window must stay readable by the container code. `0002` only adds a nullable column,
    `0003` only drops indexes (the container creates its own in its own file), and the new settings keys are
    ignored by the container.
  - A reverse D1 → SQLite export must drop `tasks.todoist_project_id` (or keep it: the container names its
    columns) and may drop `todoist_sync_token`, `todoist_projects`, `sync_claimed_at` and
    `todoist_sync_pending`. The sealed `todoist_api_key` is useless to the container: enter the key there again
    after a rollback.
  - Never replace only `flowday.db` next to the old WAL.
- **F6 (retire).**
  - Remove the container, its tunnel hostname and, after the device check, the `flowday-bypass` Access app. That
    application is managed by `infra/` (with `prevent_destroy`): it leaves through its own reviewed `infra/` change
    and a confirmed "Infra apply" (`infra/README.md` "FlowDay", F6), never by a dashboard delete, which the next
    plan would turn into a `create`. Keep the Worker's PWA exceptions only if the narrow bypass is kept.

## Plan and Focus in Tasks

`NativeFocusEntrypoint` is a same-account service binding that Todofy's private Planning channel uses for Tasks'
Plan and Focus. It permits paged task reads, daily flow reads, queue order changes, day moves and timer commands
(ListTasks, GetFlow, UpdateFlow, RolloverFlow, GetTimerSession, CommandTimer). Every other method is NOT_FOUND
there; estimates are Tasks durations, and FlowDay's own page runs the sync. It does not expose settings, credentials, local-task creation/deletion or the public owner
authentication bypass. The normal Worker fetch still checks Access, Origin and CSRF.

Todofy completes the task in Tasks first, then sends `SETTLE` with a stable request ID and the observed timer etag.
FlowDay records local completion and saves a matching timer segment; an unrelated active task keeps running.
A failed settlement does not authorize another completion. Todofy keeps that success and retries settlement.
`STOP` and `PAUSE` never complete tasks. Ordinary FlowDay completion remains local to its day flow.

Migration `0004` adds Todoist parent and actual deadline fields, distinct from due/scheduled dates. It also added
the `estimate_override` marker (set on existing nonempty estimates), which kept a FlowDay estimate over the source's
duration. Since the release that removed FlowDay's estimate override, nothing reads or sets it: the source's
duration is a mirrored task's only estimate. The column stays for the one-time copy of those estimates into Tasks
([backup](../../tasks/docs/backup.md#one-time-flowday-estimate-backfill)).
Existing Todoist sync state also got a one-shot hierarchy refresh marker for the Todoist sync of that release;
`0005` deleted it with the rest of the Todoist settings.
The timer remains one session row; its command receipts and recorded time entries are included in the normal D1 backup.

Local checks on October 13 passed Worker lint/typecheck, 21 unit tests, 123 real-D1/workerd cases (including timer
CPU and the daily write budget), UI lint/typecheck, 119 unit/integration cases, import checks and the production
static export. All 51 existing desktop browser scenarios passed against synthetic local data; the count-up case
was rerun after its time-control helper was changed to wait for the accepted asynchronous resume.
A separate SQLite upgrade check preserved existing estimates, an unknown estimate and a paused timer through
`0004`. These checks do not establish a production deployment or a Todoist PWA installation.

The container import tool also passed all 38 tests of its mandatory-Wrangler suite against synthetic local D1
under Python 3.12, including the SQLite expression-limit test. Existing estimates import as
overrides even when `0004` ran before the insert; verification still compares every original column exactly and
checks the added state explicitly. Changed hierarchy, deadline, estimate ownership, timer version or timer command
rows cause verification and reset without `--confirm-database flowday` to stop.
