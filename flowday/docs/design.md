# FlowDay on Workers Free: design

FlowDay runs as one Worker, `flowday`, on the account's Workers Free plan. The Worker serves the UI as static
assets and a small owner API backed by D1. This document covers the F1 port: the code, the tests and the
measurements. It is **not deployed yet**. The resources, the hostname and the data cutover are the later steps
F2–F6 (section 11).

Owner decisions (2026-10-01) this design follows:

- FlowDay is barely used and may be changed freely.
- It is a **read-only view of Todoist** plus FlowDay's own time blocks. Todofy is the only Todoist writer.
- Sync only has to bring Todoist's changes in; a slower sync is fine.
- **D1 writes must stay minimal.** The Free allowance of 100,000 rows written per day is shared by every app on
  the account, and there must be room for future services. Target: a typical day stays well under 1,000 rows.
- No container in the target architecture.

## 1. Shape

```
browser ── Cloudflare Access ── Worker "flowday" ──┬── ASSETS: web/out (Next.js static export)
 (UI, reviews,                  (edge-auth JWT,     ├── D1 "flowday" (drizzle-orm/d1)
  exports)                       CSRF + Origin)     └── api.todoist.com/api/v1/sync (read only)
```

| Path | What it is |
| --- | --- |
| `wrangler.toml` | The production config: top level only, `workers_dev = false`, `preview_urls = false`, no route, placeholder D1 id and Access AUD (F2 fills them in) |
| `worker/src/` | `index.ts` (handler) → `router.ts` (Access, PWA exceptions, logging) → `api.ts` (routes) → `store/*` (D1), `sync.ts` + `todoist.ts` (Todoist), `assets.ts` (static files, CSP), `e2e.ts` (test routes) |
| `migrations/` | `0001_init.sql`: the container-era SQLite schema, unchanged. `0002_incremental_sync.sql`: `tasks.todoist_project_id` |
| `web/` | The Next.js UI as a static export (`output: "export"`). It has no server code; `lib/client/http.ts` is its only `fetch` |
| `deploy/deploy-vars.mjs` | The deploy wrapper, Lab's shape. Before F2 it allows only `wrangler deploy --dry-run` |

There is no cron, no Durable Object and no Queue. The sync runs when a page asks for it (section 4).

## 2. API

Every path needs the owner's Access JWT, verified by `packages/edge-auth`: signature, issuer, audience, expiry and
the single owner (with aliases). The exceptions are `/health` and the exact PWA files (section 7). Every non-GET
`/api` request also needs the signed double-submit CSRF token (`X-CSRF-Token` plus the `flowday_csrf` cookie) and
an allowed `Origin`. Errors use the envelope `{error: {code, message, request_id}}`.

| Route | Methods | Notes |
| --- | --- | --- |
| `/api/csrf` | GET | Issues the token and its cookie (12-hour validity) |
| `/api/tasks` | GET, POST, PATCH, DELETE | Visible tasks; create a local task; title or estimate; soft delete (also removes the task from every flow, in one batch) |
| `/api/tasks/deleted` | GET, POST | Trash (FlowDay deletions only); restore |
| `/api/flows` | GET, PUT | All flows and completions; `setFlow`, `addCompleted`, `removeCompleted`, `rollover`, `rolloverSelected` |
| `/api/entries`, `/api/entries/:id` | GET, POST / PUT, DELETE | Time entries by task, day or both |
| `/api/notes` | GET, PUT | One markdown note per task and day |
| `/api/settings` | GET, PUT | Todoist key (masked on read), day capacity, planning-done flag |
| `/api/sync` | POST | `{mode: "auto" \| "manual"}`. See section 4 |
| `/api/timer/session` | GET, PUT, DELETE | The cross-device active timer (one row) |
| `/api/analytics` | GET | Raw rows of `?start&end` (both dates), or every time entry when no range is given. See section 8 |

`/api/export` and the server-side review maths of the container era are gone. The browser does that work now
(section 8).

## 3. Data

`migrations/0001_init.sql` reproduces the container's SQLite file: the 7 tables, the 10 named indexes and the 3
unique pairs, with no foreign keys and no triggers. Column order matches the live file. `tasks.description`,
`deleted_at` and `deleted_source` were added there by `ALTER TABLE`, so they come last.
`worker/test/runtime/schema.test.ts` pins every table's columns in order, every index and the column defaults.
`0002` appends one nullable column, `tasks.todoist_project_id`. It is not indexed (section 5).

Settings keys: `todoist_api_key` (plain text, as in the container; see F6), `day_capacity_mins`,
`planning_completed:<date>` and `last_sync_at` (container era). The sync adds `todoist_sync_token`,
`todoist_projects` (the `{id: [name, colour]}` map) and `sync_claimed_at` (epoch ms).

## 4. Todoist sync

**Read only.** `todoist.ts` calls exactly one endpoint: `POST https://api.todoist.com/api/v1/sync` with
`sync_token` and `resource_types=["items","projects"]`. It never sends `commands`. A test asserts the request
carries exactly those two form fields.

**Incremental.** The stored `sync_token` makes Todoist return only the items and projects that changed since the
last sync. Completed items come back with `checked`, deleted ones with `is_deleted`. A quiet day therefore reads
almost nothing. The token `*` asks for a full sync: the first sync, a new API key (saving a different key clears
the token, the project map and the claim), or Todoist resetting the token on its side (`full_sync: true`).

**One request, at most three D1 round trips:**

1. One read of the five settings above (`todoist_api_key`, `todoist_sync_token`, `todoist_projects`,
   `sync_claimed_at`, `last_sync_at`). Without a key the answer is `400 no_todoist_key` and nothing is written.
2. **Atomic throttle**, 1 row:
   `INSERT INTO settings (key, value) VALUES ('sync_claimed_at', :now) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= :now - :interval`.
   Exactly one of several concurrent tabs or devices gets `changes = 1`. The others answer `throttled` without
   reading Todoist or writing anything. The interval is 5 minutes for `auto` and 30 seconds for `manual`.
3. One Todoist read (1 subrequest), then **one atomic `batch`**:
   - Diff upsert of the active items (`json_each` over one JSON parameter, 200 rows per statement). A row whose
     values are all unchanged is not written.
   - Incremental sync: completed or deleted items are hidden (`deleted_source = 'sync'`). Projects that were
     renamed or recoloured update exactly their own tasks (`UPDATE … FROM json_each`, joined on
     `todoist_project_id`).
   - Full sync: every visible Todoist task that is no longer listed is hidden (`NOT IN (SELECT value FROM json_each(?))`).
   - `todoist_sync_token` and `todoist_projects`, each written only when it changed, and `last_sync_at`.

**Kept from the container era** (each has a test): a task hidden by a sync comes back by itself when Todoist
lists it again; a task deleted in FlowDay (`'local'`, or the legacy `NULL` source) stays deleted; a Todoist task
without a duration keeps the estimate set in FlowDay, and a Todoist duration replaces it (a day counts as 480
minutes); due dates are cut to the day; local tasks are never touched by the sync.

**Failures.** Todoist 401/403 answers `502 todoist_unauthorized`; anything else answers
`502 todoist_unavailable`. Either way only the claim was written, so `last_sync_at` still means "last successful
sync", and the next attempt waits for the throttle.

**When the page syncs** (`web/lib/hooks/auto-sync.ts`, tested with a fake clock):

- once when the page opens;
- every 10 minutes while the page is visible;
- on becoming visible again, when the last attempt is older than 5 minutes;
- never while the page is hidden (a background tab or a minimised PWA window), and not at all without a stored
  key.

The Sync buttons send `manual`. The task list is reloaded only when the answer reports changes, a full sync, or a
`last_sync_at` that another tab or device has moved. Automatic failures are quiet; manual ones show the banner.

## 5. Write budget

**How D1 counts.** Measured in workerd through `meta.rows_written`; it matches D1's billing rule that each index a
write touches costs one more row:

| Write | Rows |
| --- | --- |
| Insert a task (row, key index, `due_date`, `deleted_at`, `todoist_id` indexes) | 5 |
| Update a task's unindexed column (title, estimate, project, labels, …) | 1 |
| Update an indexed column (`due_date`, `todoist_id`; hide or restore via `deleted_at`) | 2 |
| Any `UPDATE`/upsert whose `WHERE` finds nothing different | 0 |
| Insert a settings row / update its value | 2 / 1 |
| Insert a time entry (row, key, `task_id`, `flow_date`) | 3 |
| Insert a flow task (row, key, unique pair, `flow_date`, `task_id`) | 5 |
| Move a flow task (`sort_order`, unindexed) | 1 |

SQLite rewrites an index entry whenever the index's column appears in an `UPDATE`'s `SET` list, even when the
value is the same. The sync upsert therefore sets only unindexed columns, and `due_date`, `todoist_id` and the
restore each get their own `UPDATE`, limited to the rows where that value differs. Without this split an edited
title cost 4 rows instead of 1.

**Other writers, all diff-only.**

- `setFlow` deletes only the tasks that left the day, inserts only new ones and moves only rows whose position
  changed (a reorder of 2 tasks costs 2 rows). The container rewrote the whole day: about 5 rows per task.
- Settings, estimates, titles and notes are conditional (`IS NOT`). Saving the same value writes 0 rows.
- A duplicate completion is `ON CONFLICT DO NOTHING` (0 rows).
- Notes save 1.5 s after typing stops (500 ms in the container). A pending save is flushed when the card closes
  or the page hides.

**Measured** (`worker/test/runtime/sync.test.ts` and `budget.test.ts`, which assert the bounds):

| Scenario | Rows written |
| --- | --- |
| Simulated day of sync: 200 tasks, 20 Todoist changes (10 edits, 3 reschedules, 3 completions, 1 deletion, 2 new tasks, 1 project rename covering 40 tasks), two tabs polling every 10 minutes for 16 hours. Result: 96 syncs, 96 throttled, 96 Todoist reads | **287** (asserted < 400) |
| Simulated day of use: plan 8 tasks, reorder twice, 8 estimates, 12 timer segments, 6 notes × 5 saves, 2 manual entries, 6 completions, a rollover, a quick task | **239** (asserted < 300) |
| One-off first sync of a new account with 200 tasks | 1,008 (about 5 per task) |
| A sync with no Todoist change | 2 (claim + `last_sync_at`), or 3 if Todoist rotates the token |
| A throttled sync | 0 |

A typical day is therefore about **530 rows**, about 0.5% of the account's 100,000. Before the port, the container
upserted every task every 60 seconds whether or not the tab was visible. That was about 4 rows per task per
sync: roughly 0.58–1.15 million rows a day for 200 tasks.

Every API mutation logs one line (`request_id`, method, route, status, error code, `rows_written`, `rows_read`)
and returns its row count in `x-flowday-rows-written`. Workers Observability can then show the real figure
after F2.

## 6. Workers Free limits

| Limit | FlowDay |
| --- | --- |
| 10 ms CPU per request | Measured in workerd from the isolate's CPU profile (`cpu.test.ts`, which asserts the best warm run < 10 ms). Warm medians: full sync of 1,000 tasks 4.4 ms (10.3 ms on the isolate's first request), incremental sync with 20 changes 2.1 ms, `GET /api/tasks` with 1,000 tasks 3.4 ms, analytics rows for 1,000 hours 4.9 ms, a week 1.7 ms, the page with CSP hashing 0.4 ms. These vary by about 1 ms between runs. They are estimates on the test machine, not Cloudflare's meter; watch `/api/sync` in Observability after F2 |
| 50 subrequests | `/api/sync`: 1 (Todoist). Everything else: 0 |
| 50 D1 queries per invocation | A full sync of the maximum 5,000 items needs 25 upserts + 4 task statements + 3 settings + 2 = 34. Larger answers are refused (`MAX_SYNC_ITEMS`) |
| 100 bound parameters per statement | Id lists always travel as one JSON parameter to `json_each(?)`. Tests cover 140–250 ids |
| Script size | 254.9 KiB raw, **54.3 KiB gzip**. CI fails above a 3 MiB gzip budget (`worker/scripts/bundle-size.mjs`) |
| Static assets | 44 files, 1.66 MiB (`web/scripts/check-export.mjs` keeps it under 1,000 files) |
| Cron | None (the account has 5, 3 used) |

The reviews moved to the browser because they ran per minute of logged time. On the server that took 40–63 ms per
100 hours, and those requests would have exceeded the CPU limit.

## 7. Security, PWA and headers

- **Access.** `edge-auth`'s verifier with the dashboard's policy (case-insensitive owner, aliases, cookie
  fallback, cached JWKS). The owner and aliases are Worker secrets.
- **Loopback dev bypass.** Only on http://127.0.0.1 or localhost, and never for a request carrying `cf-ray`. Used
  only by `wrangler dev` and the tests.
- **CSRF.** Signed double-submit, bound to the owner, with `Origin` restricted to `https://$PUBLIC_HOST`, plus the
  loopback origin under the bypass. `PUBLIC_HOST` is not set before FlowDay has a host (F3), so before then only
  the loopback bypass can make writes.
- **Private headers on everything.** `no-store`, `nosniff`, `no-referrer`, `DENY` and a strict CSP. The HTML's CSP
  adds the SHA-256 of each inline script in the served page (Next.js inlines its boot and RSC payload). No other
  inline script may run. `/_next/static/*` is cached as immutable.
- **PWA exceptions.** These exact paths are served without a JWT: `/pwa/manifest.webmanifest`, `/pwa/sw` (the
  service worker, from `sw.js`, with `Service-Worker-Allowed: /`), `/pwa/icon-192x192.png`, `icon-512x512.png`,
  `icon-maskable-512x512.png`, `icon.svg` and `apple-touch-icon.png`. While the Access app `flowday-bypass` covers
  `/pwa/*` (F2–F6), those requests arrive without a JWT. Everything else under `/pwa/` needs one, and so does all
  of `/api`. `edge.test.ts` covers both directions.
- **Manifest with credentials.** The manifest link has `crossorigin="use-credentials"` (checked in the built HTML),
  so the bypass can be removed later.
- **Service worker `flowday-v2`.** It drops older caches, never caches `/api`, caches only plain same-origin `200`
  responses that were not redirected (never an Access login page), and serves the cached shell offline.
- **E2E routes.** `/api/test/*` exists only with `E2E_TEST_ROUTES=true` and an active loopback bypass. The
  production export is checked for E2E markers.
- **Logs.** IDs, routes, statuses, codes and row counts only. Never a token, a title or a body.

## 8. Client

- **One request wrapper.** `web/lib/client/http.ts` is the only module that calls `fetch`; ESLint rejects `fetch`
  anywhere else in app code. It fetches the CSRF token at start and attaches it to every write.
- **Expired token.** A `403 csrf_failed` (the token is valid for 12 hours, and a PWA window stays open longer)
  refreshes the token and retries the write once.
- **Expired Access session.** A redirect, a login page in place of JSON, or the Worker's own 401 is never retried.
- **Visible failures.** Every failed write, and every expired session, appears in a banner with Reload. A failed
  write is never swallowed. Optimistic local state is kept unless the store reloads from the server, which is the
  container era's behaviour for flows and tasks.
- **Ordered, surviving writes.** Writes small enough are sent with `keepalive`, so a save made while the page
  unloads still arrives. Timer-session writes are queued so they cannot land out of order.
- **Reviews and exports in the browser.** The UI asks `/api/analytics` for the rows of a range (a day, an ISO week,
  or every time entry for the work-pattern stats). The container's pure functions
  (`features/analytics/services/analytics-service.ts`) compute the reviews in the browser's time zone. The Export
  dialog builds CSV or JSON from the same rows (`features/settings/services/export-service.ts`) and saves it from
  a `blob:` URL.
- **Shared types.** The Worker's response types live in `worker/src/api-types.ts`.
  `web/lib/types/worker-contract.ts` fails `tsc` when the UI's types drift from them.

## 9. Tests

| Suite | Where | What |
| --- | --- | --- |
| Worker unit | `worker/test/*.test.ts` (Node) | Todoist parsing and failure mapping, the request body (never `commands`), the sync plan, CSP hashing, the PWA list |
| Worker runtime | `worker/test/runtime/*.test.ts` (Miniflare/workerd, real D1, a fake Todoist Sync API) | Schema; every store module (the container's query tests, async), including more than 100 ids and row counts; the API over HTTP with CSRF; Access with real RS256 JWTs; CSRF and Origin; PWA exceptions; CSP; E2E gating; the sync rules, throttle and concurrency; the write budget; CPU |
| UI unit and integration | `web/__tests__` (Vitest, an in-memory fake of the API) | Stores, the request wrapper (CSRF retry, session expiry, banner), the auto-sync scheduler, reviews and exports from rows |
| Playwright | `web/__tests__/ui` against `wrangler dev` (`web/scripts/e2e-server.mjs`: E2E export, local D1, bypass) | The 52 UI scenarios. All passed locally (Chromium headless shell). CI does not run them yet, as before F1 |
| Config and wrapper | `deploy/test/*.test.mjs`, `.github/scripts/test_wrangler_configs.py` | No route, no hostname, placeholders, no personal value, dry-run only, CI inputs are placeholders |

The README figures and the UI goldens (`docs/readme`, `docs/ui-goldens`) are compared pixel by pixel on Ubuntu
24.04. Their scripts now start the app through `e2e-server.mjs`. They were not regenerated in F1: the UI is
unchanged apart from the error banner, which only appears on failure.

## 10. Local development

From `worker/`: `npm ci`, then `npm run dev`. That is `wrangler dev` with the production config: local D1 and
`--local-upstream 127.0.0.1:8789`. The values go in `flowday/.dev.vars` (see `.dev.vars.example`). Build the UI
first (`cd ../web && npm run build`), and apply the migrations locally:
`npx wrangler d1 migrations apply DB --local --config ../wrangler.toml`. Never use `--remote`.

## 11. Migration plan after F1

- **F2 (resources, no route).**
  - Create the D1 database `flowday` and commit its id.
  - Reuse the existing Access app `flowday`: commit its AUD as `ACCESS_AUDIENCE`, unchanged.
  - Add the GitHub secret `FLOWDAY_CSRF_SIGNING_KEY`. The owner comes from `DASHBOARD_ACCESS_OWNER(_ALIASES)`,
    like Lab.
  - Add the deploy job ("FlowDay deploy", through `deploy/deploy-vars.mjs exec … wrangler deploy` with
    `--secrets-file`, after `wrangler d1 migrations apply DB --remote`).
  - Remove `flowday` from `CHECK_ONLY` in `.github/scripts/ci_changes.py`.
  - Move `flowday/wrangler.toml` from `UNDEPLOYED` to `PRODUCTION` in `test_wrangler_configs.py`, add it to
    `drift_desired.py` and regenerate the dashboard's desired state.
  - The wrapper then refuses the placeholders again, as a guard against a revert.
- **F3 (staging host).** Set `PUBLIC_HOST` (the CSRF origin) and add a staging Custom Domain in its own commit
  (cf-guard). Owner checks on a real device: install, real icons (the manifest with credentials), cold start,
  re-login after the Access session expires. Rehearse the DNS rollback path before F4.
- **F4 (data cutover, owner present, about 15 minutes frozen).**
  - Stop the container.
  - Copy the db and wal off the host. Never open the live file; open the copy with `file:<copy>?immutable=1`.
  - Export each table with `.headers on` and `.mode insert <table> --escape off`, and assert there is no
    `unistr(` and that every INSERT names its columns. A column-order test exists, but named columns make the
    order irrelevant.
  - Import with `wrangler d1 execute flowday --remote --file`. Compare per table `count(*)`, `total(length(col))`
    and sorted-dump SHA-256s, without printing any rows.
  - The first sync after the import is a full sync (no token). It writes `todoist_project_id` once into every
    Todoist task row: about one row each, a one-off cost of roughly the task count.
  - The hostname move is its own commit with `adopt = "cname"`, because CI's non-interactive wrangler takes over
    the tunnel CNAME.
- **F5 (7-day rollback window = D1 Time Travel).**
  - Keep the container stopped and its data directory untouched.
  - Every change in the window must stay readable by the container code. `0002` only adds a nullable column, and
    the new settings keys are ignored by the container.
  - A reverse D1 → SQLite export must drop `tasks.todoist_project_id` (or keep it: the container names its
    columns) and may drop `todoist_sync_token`, `todoist_projects` and `sync_claimed_at`.
  - Never replace only `flowday.db` next to the old WAL.
- **F6 (retire).**
  - Remove the container, its tunnel hostname and, after the device check, the `flowday-bypass` Access app.
    Keep the Worker's PWA exceptions only if the narrow bypass is kept.
  - Afterwards: encrypt the Todoist key at rest (AES-GCM with a deploy-bootstrapped key; a lost key only means
    entering the Todoist key again).
