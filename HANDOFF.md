# Handoff: work in flight

This file is the shared working state of the monorepo for whoever picks up next: the owner, a local agent
session, or a cloud agent with only this repository. It lists what is live, what is being built and in which
branch, in what order it merges, what still needs checking after a deploy, what waits for the owner, and the
problems already met, so a new session can continue without the previous conversation.

Rules for this file:

- Update it in the same change that starts, lands or abandons a piece of work. A stale entry is worse
  than none.
- This repository is public. Write branch names, commit SHAs, public hostnames, phases, steps and measured
  numbers. Never write secrets, personal values (addresses, emails, Todoist ids), raw API output, watched
  URLs, account ids, local secret file locations, or security-posture details. Those stay with the owner.
- Be complete enough to act on without the conversation that produced the work: for every open branch say
  what is done, what is left, how to verify it and what to check after its deploy. Link to the app docs for
  design detail instead of copying it.

Last updated: 2026-10-02 ~20:30 UTC. Every app's owner API is on proto once this change lands: the dashboard
(`ca63675`) and FlowDay (`8d9100e`) are live and verified, Mail Hero (`d1bde0e`) lands just before this change, and
Todofy lands with it (both below; their post-deploy checks are pending until "Waiting to be verified" says otherwise).

## What is live

| App | Worker | Host(s) | Deploy job | Owner API on proto? |
| --- | --- | --- | --- | --- |
| Mail Hero | `mail-hero` (+ `MailCoordinator` DO) | `mail-hero.ziyixi.science` | `Mail Hero deploy` | Webhook `mail.received.v1` yes; owner API: branch `proto-mail-hero-ui` |
| Todofy | `todofy` (TS gateway) + `todofy-core` (Python) | `todofy.ziyixi.science`, hooks and daily hosts | `Todofy deploy` | Reports `todofy.report.v1`, `task-intent-v1`, `ops-v1` yes; owner API: branch `proto-todofy-ui` |
| Lab | `lab` | `lab.ziyixi.science` | `Lab deploy` | Yes (`lab.ui.v1`, the pilot) |
| Links | `links` | `s.ziyixi.science` | `Links deploy` | Yes (`links.ui.v1`) |
| Watch | `watch` (+ `WatchState` DO) | `watch.ziyixi.science` | `Watch deploy` | Yes (`watch.ui.v1`) |
| FlowDay | `flowday` | `flowday.ziyixi.science` | `FlowDay deploy` | Branch `proto-flowday-ui` |
| Dashboard | `home` (+ `HomeState` DO) | `home.ziyixi.science` | `Dashboard deploy` | Yes (`dashboard.ui.v1`, since `ca63675`) |
| Website | `ziyixi-website` (+ `ziyixi-notion-publish` relay) | `ziyixi.science`, `www.ziyixi.science` | `Website release` | n/a (static) |

Outside this repository (do not move them in without the owner): the newsletter (its own repository, runs
on the owner's VPS in Docker because it calls the Codex CLI; it reads Todofy's `/api/summary` and
`/api/recommendation` with Basic auth), the self-hosted Slash and changedetection containers (to be retired,
see "Waiting for the owner"), and FlowDay's old container (rollback until 2026-10-08).

## How work lands

1. Commit on a branch and push it. Branch CI runs every check job and never deploys.
2. When the branch run is green, fast-forward `main` to the same SHA (`git push origin <sha>:main`).
   Branch protection requires `CI gate`; `main`'s run reuses the green branch checks and runs only the
   deploy jobs the diff reaches (`.github/scripts/ci_changes.py`).
3. Never deploy by hand. Production changes only through CI on `main`.
4. Cloudflare objects managed by `infra/` (Access apps and policies, D1, R2 of the monorepo apps) change only
   through a commit there plus a dispatch of "Infra apply" with `expect` set to the counts and fingerprint the
   "Infra drift" run printed (`infra/README.md`). Never edit them in the dashboard.
5. If two branches touch the same CI files (`ci.yml`, `ci_changes.py`, `test_ci_changes.py`, `README.md`,
   `AGENTS.md`, `proto/README.md`, this file), land one, rebase the other onto the new `main`, resolve by
   meaning (keep both sides), and re-run its checks before pushing.

Practical notes learned the hard way:

- The fast-forward push is refused while a newer CI run for the same SHA is still pending; wait for it and
  check afterwards that `origin/main` really moved.
- In zsh, write `${VAR}:refs/heads/x`, never `$VAR:refs/...` (`:r` is a history modifier and mangles it).
- After a rebase, run the checks of every app the rebase touched, not only the Changes unittests (a rebased
  Mail Hero CPU test once used an old meter API and hung CI for 15 minutes).
- A run "cancelled" by the concurrency group is not a failure; re-run it.
- GitHub's scheduled runs are often hours late ("Infra drift" at 13:23 UTC ran at 18:56 on 2026-10-01).
- The owner's local clone (Google Drive, `todofy`) must be fast-forwarded to `origin/main` after every
  landing, only when it is clean and on `main`; never run installs there.

## In flight

The three branches below are pushed (CI only, nothing deploys from a branch). They were built in local
scratch clones by agents that are still finishing them; their latest commits are pushed again when they
finish. If the session that runs them is gone, continue from the pushed branch: re-run the verification
list, do the reviews, fix, rebase, land.

The shared plan for each (owner-approved, Google style, copied from Lab): describe every route the app's UI
calls in `proto/<app>/ui/vN` as AIP resources with `google.api.http`, serve them through
`proto/ts/http-transcoder.ts` behind the app's unchanged edge auth (Access JWT, Origin, CSRF before any body
is read), call them from the UI through `proto/ts/http-client.ts`, delete the hand-written duplicate types,
errors as `google.rpc.Status` with `ErrorInfo` reasons, AIP-155 `request_id`, AIP-154 etags where they pay.
Routes used by other systems keep their exact paths, auth and bytes. Old owner paths answer
`410 reload_required` in the old envelope for one release so open tabs ask for a reload. Check that the deployed
old client shows that message: Lab's, Mail Hero's, Todofy's and FlowDay's show any code's message, but the
dashboard's shows it only for its own eleven codes, so the dashboard sends `not_found` with the reload message
(`dashboard/worker/test/http.test.ts` runs main's error handling on every legacy answer).

Verification list for every branch (from a clean clone of the head): Changes unittests
(`uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts`), cf-guard and tools tests,
Proto checks (lint, api-lint, breaking vs `origin/main`, rules self-test, determinism, `check:schema`,
`test_proto.py`, vitest, Python tests), Contracts, the app's full checks job (workerd runtime and CPU tests,
UI tests and build, bundle budgets, dry run), and a scripted smoke of every UI call against `wrangler dev`
with synthetic data.

### `proto-mail-hero-ui` — Mail Hero owner API as `mailhero.ui.v2`

- State: LANDED on `main` as `d1bde0e` (2026-10-02, third, right after FlowDay; rebased on `8d9100e`). Its first
  CI run failed one CPU bound: SendMessage's first run read 6.01 reference ms against 6 (the codec's first use inside
  the request). The fix runs the owner API's codec path at startup (`mail-hero/cloudflare/src/native/warmup.ts`,
  about 10 ms of a 1 s startup budget), as FlowDay and Todofy do: SendMessage's first run 4.15-4.60 → 3.38-3.98
  reference ms locally. CI margin is still thin (projected 3.7-6.0 on runners); if it flakes, take a cheaper send
  path rather than a looser bound. Post-deploy checks below are pending. Build and review history: four build
  commits (IDL, Worker, UI, docs), one commit per review finding (MH-CS-1, D4, D7, D6, D1+D3, D5, D2, D8).
- Review fixes: the dashboard's buckets are the IDL's `AttemptResult` (SUCCEEDED, RETRIED, FAILED, UNKNOWN, each mapped
  to its attempt outcomes) and the drill-down filter is `attempt_result = <AttemptResult>` (was `attempt_outcome`; the
  UI's drill-down URL parameter too); the dashboard page reads the generated response types; an unmapped module error
  code is `INTERNAL`, never guessed from its status; a malformed filter time is `BAD_REQUEST`;
  `Settings.ledger_retention_days` is always set; SendMessage, ResendDelivery and TestEndpoint all answer
  `{delivery: Delivery}`; `ETAG_MISMATCH` carries the current Message, Endpoint or Settings; Mail Hero's filter parser
  runs the shared corpus; the dashboard stats test no longer asserts host wall time.
- Why v2: the hand-written owner API was `/api/v1`; the new one is `/api/v2/*`, and `/api/v1/*` answers 410
  until 2026-11-01.
- What it does: every owner route through the transcoder in `src/native/api-v2.ts`; MAINTENANCE_MODE,
  Origin and CSRF checked before the body; mutations under the coordinator's write lease as before. The two
  reads that exceeded 10 ms (parsed message content, the delivery dashboard's first time-zone load) are
  answered inside the coordinator DO. Raw and attachment downloads stay outside the service with the same
  headers (no-store, nosniff, attachment). The `mail.received.v1` webhook and `/api/internal/backup/*` are
  untouched.
- Measured (production dry run, `vite build`, the calibrated workerd meter, medians of three fresh isolates):
  Worker 193.3 → 229.0 KiB gzip (budget 274), UI JS 121.4 → 162.4 KiB gzip (budget 195); the isolate's first API
  request 7.2-7.8 reference ms (bound 9 of Free's 10), every other Worker request at most 5.5 first and 2.7 warm;
  the two heavy reads run in the coordinator (slowest 19 ms of its 30 s).
- Startup warm-up (CI fix): the branch's CI failed one check, `delivery-request-cpu.test.mjs` "SendMessage (largest
  record): first run ... 6.01 reference ms" against `WORKER_COLD_BOUND_MS` 6 (the hand-written send reads 4.1-4.9 on
  runners): an isolate's first request ran protobuf-es and the codec before V8 compiled them.
  `cloudflare/src/native/warmup.ts`, called at module scope from `api.ts` as FlowDay's `warmup.ts` is, routes, reads
  and answers synthetic requests of the heaviest methods through the transcoder's routes and the codec (no bindings,
  no I/O, constants only; five rounds, about 10 ms of startup, +2.4 KiB gzip). Reference machine, four serial runs:
  SendMessage first 4.15-4.60 → 3.38-3.98 (the hand-written send 2.84-3.06), the first API request 7.1-8.2 → 5.7-6.5,
  50 messages with a search 4.7-5.1 → 2.8-3.3; bounds unchanged. Watch the next CI run's send (expected about
  4.4-5.8 against 6).
- Deploys: Mail Hero only.
- After deploy: inbox list, a message detail (text, HTML in the sandbox, warnings), raw and attachment
  downloads, deliveries and attempts, retry, targets, settings and retention preview, the delivery dashboard;
  an old tab shows the reload message; the dashboard's Mail Hero tile stays ok; the next real mail is
  delivered (Todofy's mail flow tile).

### `proto-todofy-ui` — Todofy owner API as `todofy.ui.v1`

- State: LANDING on `main` (2026-10-02, fourth and last, right after Mail Hero; rebased on `d1bde0e` without
  conflicts, the four doc findings of the rebase audit fixed). All 11 review findings fixed, with tests. Verified
  from a clean clone on the previous base `18e8e92` (every check in the list above, the runtime suite, the
  gateway's workerd CPU test, both dry runs, and lint and typecheck of every other TypeScript proto user); the move
  to `d1bde0e` changed no Todofy file. Post-deploy checks below are pending.
- Review fixes: RecomputeReport stores only a computed report, so the same `request_id` computes again after
  RATE_LIMITED or UNAVAILABLE (a stale unfinished claim is taken over after 120 s); a bug in TodofyCore is
  INTERNAL, not UNAVAILABLE, and the UI retries only UNAVAILABLE and missing answers; ListMailEvents takes one
  AIP-160 `filter` (`state = TODO_UNKNOWN` or `attention = true`) and an AIP-157 `view` (BASIC; GetMailEvent
  FULL); a reused `request_id` is the common BAD_REQUEST (ErrorReason 3 reserved); IDs stay inside AIP-122
  (`gtdReviews/2026-w40`; `legacyTexts/{event UUID}` only); a page token naming no real day is BAD_REQUEST;
  `tools/workerd-cpu` replaces an isolate whose inspector timed out (tools only, deploys nothing).
- What it does: `TodofyUiService` under `/api/v1` (mailEvents, dailyReminders, metricDays, gtdDays, gtdReviews,
  legacyTexts; singletons serviceStatus, latestReports, integration). The TS gateway transcodes and makes one
  `owner_ui` RPC to `TodofyCore`, which reads requests and writes answers with the generated Python code.
  CSRF moves to `GET /api/csrf`. The OpenAPI document becomes `api/machine-api-v1.openapi.yaml` and keeps only
  the hooks hosts' routes (`/hooks/mail`, `/api/summary`, `/api/recommendation`, `/health`), whose wire is
  unchanged; `openapi-typescript` is retired. The old owner paths answer 410 `reload_required` (old envelope)
  for one release; `owner_api` in core keeps serving the old gateway during the deploy. The next Todofy
  release removes both (`todofy/docs/gateway-contract.md` §6.4).
- Measured: gateway 11.8 → 72.0 KiB gzip (budget 86); UI JS 131.9 → 172.4 KiB gzip (budget 208); todofy-core
  153.6 → 168.4 KiB gzip; gateway CPU per owner request at most 6.4
  reference ms (a 1.9 MB ASCII legacy text heavy in escapes; the reports at their limits 5.2), the isolate's
  first API request 4.2-5.2 (bound 8; details in `todofy/docs/gateway-contract.md` §8).
- Deploys: Todofy (core first, then the gateway; no D1 or Durable Object migration) only. Core must answer
  `owner_ui` before the new gateway serves.
- After deploy: walk every Todofy page (首页, 需关注, 事件 and one event's detail, 提醒, 日报 with one recompute,
  统计, GTD, 健康, 接入); act only on a synthetic or already handled event. A tab left open from before shows
  "Todofy 已更新，请刷新页面". The newsletter's next run at 13:30 UTC still gets `/api/summary` and
  `/api/recommendation` (same bytes); Mail Hero's next delivery succeeds and the canary (mail → Todofy) passes
  on the dashboard; the gateway's CPU on the Workers dashboard stays well under 10 ms.

### Landing order

Done in this order on 2026-10-02: the dashboard (alone: its `proto/ts` change redeployed every TypeScript user),
FlowDay, Mail Hero, Todofy, each rebased on the previous landing and re-verified. When an entry's post-deploy
checks pass, move it to "Waiting to be verified" as verified, then delete it once nothing is left for it.

## Waiting to be verified

- `flowday.ui.v1` (landed `8d9100e`, 2026-10-02 18:50 UTC): verified. FlowDay's deploy succeeded; the UI's calls
  (tasks, flows, notes, time entries by day and task, settings, timer, analytics) answer 200 and page; old `/api/*`
  answers 410 with the reload message; the dashboard's tiles are all ok. Left: remove the 410 routes after
  2026-11-02 (`LEGACY_PATHS` in `flowday/worker/src/router.ts`). Its landing needed two CI fixes: a FlowDay test
  narrows each handler's answer (the transcoder's handler type admits `PreEncoded` since the dashboard landed), and
  `proto/test/ensure.test.ts`'s lock tests allow two whole generations (`TWO_GENERATIONS_MS`).
- `dashboard.ui.v1` (landed `ca63675`, 2026-10-02 18:20 UTC): verified. Every deploy of the run succeeded (Lab,
  links, watch, Mail Hero and the dashboard, because of the shared `PreEncoded` transcoder change); the registry
  and the four views answer 200 with ETag and 304 on a repeat (flows and ops included, the bug fixed on the
  branch); 刷新 is `POST /api/v1/homeView:refresh` with CSRF and answers 200; attention is ok; old `/api/v2/*`
  answers 410 with 个人控制台已更新，请刷新页面; a GET with `refresh=1` answers 400. Lab, links, watch and Mail Hero
  load their data after the redeploy. Left: remove the 410 routes after 2026-11-02 (`legacyApi` in
  `dashboard/worker/src/http.ts`).

- Newsletter with `todofy.report.v1` (2026-10-02 13:30 UTC): Cloudflare side checked, Todofy's gateway
  answered 42 requests after 13:25 UTC, all successful, CPU p50 0.7 ms / p99 4.1 ms. The VPS side (the
  newsletter run itself) is not checked: an agent needs the owner's permission for the read-only ssh check,
  or the owner confirms the 2026-10-02 newsletter arrived.
- Infra drift must stay `no-op 19` on its daily scheduled run. The 2026-10-02 scheduled run had not started
  by 17:00 UTC (GitHub delay); check it ran and stayed no-op.
- FlowDay rollback window (F5) ends 2026-10-08: the old container stays untouched until then. F6 (retire the
  container, its tunnel ingress and the `flowday-bypass` Access app) needs the owner's OK and goes through
  `infra/` for the Access app (`flowday/docs/design.md` section 11).
- Watch (live since 2026-10-02, `76b376c`): the scheduler is armed and the dashboard tile is ok. The first daily
  digest task in Todoist after 14:00 UTC can only appear once a watch exists and changes; none exist yet.
- Legacy 410 answers to remove after one release: Lab's after 2026-11-01, Mail Hero's `/api/v1` after 2026-11-01,
  the dashboard's `/api/v2` and FlowDay's old `/api` after 2026-11-02, Todofy's old owner paths (`todofy/gateway/src/owner.ts`)
  and `todofy-core`'s `owner_api` RPC after 2026-11-02.
- Todofy's old host snapshot can be deleted after 2026-10-29 (`todofy/docs/verification.md`).

## Waiting for the owner

- Enter the Todoist key once in FlowDay's settings (the Worker stores it sealed; sync stays off until then).
- Optional: Chrome site search `s` → `https://s.ziyixi.science/%s` (`links/README.md`).
- Dedicated Cloudflare tokens (`CF_INFRA_READ_TOKEN`, `CF_INFRA_TOKEN`) and a fresh deploy token
  (`infra/README.md` "Replacing the token").
- OK to retire the self-hosted Slash and changedetection containers (no data import is wanted).
- OK for F6 after 2026-10-08 (above).
- The pages to watch for W4 (added by the owner at watch.ziyixi.science/new, or named to an agent privately).
- Optional: a newsletter run receipt so the dashboard can show the newsletter's health (changes the newsletter
  repository and the VPS, so it needs the owner's OK).

## Next, in order

1. Finish and land the three remaining proto branches above (FlowDay, Mail Hero, Todofy), then verify each deploy.
2. After them, proto is the single IDL for every interface the monorepo defines. Follow-ups: remove the 410
   routes on their dates; remove `owner_api` from `todofy-core` in the release after `proto-todofy-ui`.
   With the next Mail Hero change (a `mail-hero/docs` edit deploys Mail Hero, so `proto-todofy-ui` leaves it):
   in `mail-hero/docs/todofy-integration.md` point line 13 at `todofy/api/machine-api-v1.openapi.yaml` (the
   `/hooks/mail` route Mail Hero calls) and `proto/todofy/ui/v1` instead of the removed
   `owner-api-v1.openapi.yaml`, and drop line 55's `npm run gen:api` (Todofy's UI no longer generates types
   from the schema).
3. Watch W4: a shadow-mode week (watches report, no Todoist tasks), then the owner's watches.
4. FlowDay F6 after 2026-10-08 with the owner's OK.
5. Service catalog (IaC P5): one `app.toml` per app generating hostnames, Access apps, dashboard links and
   probes, validated against each `wrangler.toml`; then P6 (rollback drill for `infra/`).
6. Code quality phases Q0–Q7: English comments everywhere, coverage and lint ratchets, clock injection in every
   app's tests.

## Known problems and how they were solved

- Linux 6.17 GitHub runners throttle large bodies over Miniflare's loopback: tests that push big bodies time
  out only on CI. Stream in 32 KiB slices (`watch/worker/test/runtime/fake-net.ts`).
- CPU tests: use `tools/workerd-cpu` (calibrated to machine speed; cold runs are the median of three fresh
  isolates; a busy-machine guard). Never compare raw ms from a laptop with Free's 10 ms directly.
- Dashboard tests depend on the hour: use the injected `DEV_NOW` clock (only honoured behind the loopback dev
  bypass; every `DEV_*` setting is barred from production configs by `test_dev_only_settings_never_reach_a_deploy`).
- A Workers custom domain cannot be attached while an external DNS record exists for the host (API code
  100117, even with override): the record must be removed first, which the deploy token cannot do.
- The dashboard's registry must name every Durable Object namespace by id (`dashboard/worker/src/registry.ts`);
  a new DO needs a follow-up commit with its id after its first deploy.

## Owner decisions already taken (do not re-ask)

- Workers Free only; no paid products without the owner's explicit OK.
- proto is the single IDL, Google style (google.api.http, AIP, google.rpc.Status, api-linter, the in-repo
  transcoder); one app at a time.
- IaC manages only the monorepo apps' Access apps, D1, R2 and their hostnames; never self-hosted hosts, mail
  records, third-party TXT records or zone settings.
- FlowDay runs on Workers Free (no container); its data was imported.
- Short links: owner-defined keys on `s.ziyixi.science`; no import from Slash.
- Watch: rule-based change detection first (no AI); digests go to Todoist through Todofy's intents.
- The newsletter stays on the VPS (it needs the Codex CLI).
- Agents keep going without asking for step approvals on these personal projects, as long as everything stays
  recoverable; anything touching the owner's mail, VPS writes or secrets still needs the owner.
