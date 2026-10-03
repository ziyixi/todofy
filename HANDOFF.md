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

Last updated: 2026-10-03 ~00:03 UTC. The verified foundation implementation is `8628e5e`; subsequent commits may be documentation only. Every app's owner API is on proto now (the dashboard
`ca63675`, FlowDay `8d9100e`, Mail Hero `d1bde0e`, Todofy `b70856f`, all landed and verified on 2026-10-02). Nothing
was in flight at that landing. The owner-authorised foundation work below is complete.

## What is live

| App | Worker | Host(s) | Deploy job | Owner API on proto? |
| --- | --- | --- | --- | --- |
| Mail Hero | `mail-hero` (+ `MailCoordinator` DO) | `mail-hero.ziyixi.science` | `Mail Hero deploy` | Yes (`mailhero.ui.v2`; webhook `mail.received.v1`) |
| Todofy | `todofy` (TS gateway) + `todofy-core` (Python) | `todofy.ziyixi.science`, hooks and daily hosts | `Todofy deploy` | Yes (`todofy.ui.v1`; reports `todofy.report.v1`, `task-intent-v1`, `ops-v1`) |
| Lab | `lab` | `lab.ziyixi.science` | `Lab deploy` | Yes (`lab.ui.v1`, the pilot) |
| Links | `links` | `s.ziyixi.science` | `Links deploy` | Yes (`links.ui.v1`) |
| Watch | `watch` (+ `WatchState` DO) | `watch.ziyixi.science` | `Watch deploy` | Yes (`watch.ui.v1`) |
| FlowDay | `flowday` | `flowday.ziyixi.science` | `FlowDay deploy` | Yes (`flowday.ui.v1`) |
| Dashboard | `home` (+ `HomeState` DO) | `home.ziyixi.science` | `Dashboard deploy` | Yes (`dashboard.ui.v1`, since `ca63675`) |
| Website | `ziyixi-website` (+ `ziyixi-notion-publish` relay) | `ziyixi.science`, `www.ziyixi.science` | `Website release` | n/a (static) |

Newsletter source is now imported on `main` from its deployed engine commit
`c3d622d4771b1ca63ee4e3f785b79032cffc30e1`. Its new independent image is `ghcr.io/ziyixi/todofy-newsletter`. The main publisher at `8628e5e` published it; the package is public, anonymous manifest access passed, and the credential-free configuration workflow pulled and validated the image. The pullable digest is `sha256:94c535ba8f2a64d887656e50a1571f42b31d18aad5472776e0762d69c20e5e51`. The existing VPS still runs
`ghcr.io/ziyixi/newsletter`; image publication here does not update that server. It still reads Todofy's
`/api/summary` and `/api/recommendation` using its existing machine contract. See
`newsletter/docs/import-source.md` and `newsletter/docs/deployment-drain.md` for the import and release boundaries.
The self-hosted Slash and changedetection containers (to be retired, see "Waiting for the owner") and
FlowDay's old container (rollback until 2026-10-08) remain outside this repository.

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

None. Foundation code landed as `8628e5e` and its release verification is complete. The existing VPS runtime
remains unchanged; the next server upgrade is a separate operation using the imported release/drain contract.

## Foundation completed

- Root README is concise and bilingual; docs, contracts and migration history have separate navigation. P5 uses nine `app.toml` files, generates Home/Access metadata, and validates ten Workers against their committed Wrangler configs. Existing Home public bytes and Access identities were preserved. The read-only Infra drift run reported `no-op 19`; no infrastructure apply was needed.
- Changes: 360 tests (one intentional Watch/no-D1 skip); catalog: 18; infra driver: 75; Home unit: 249 and workerd: 73. Secretless OpenTofu fmt/validate and cross-config guards passed. Newsletter: 2476 tests, locked lint/type/structure, synthetic HTTP smoke, no-login Codex startup, build, isolated wheel and actual Linux Docker/configuration smoke passed.
- Full branch run [37079465314](https://github.com/ziyixi/todofy/actions/runs/37079465314) passed at `8628e5e`. Earlier CI exposed shared unittest discovery state and a Node 26 Watch stub lifetime issue; isolated loaders and retained requests with a controlled clock cover both. Codex cleanup failure retains an uncertain activity and blocks freeze.
- Main run [37079972709](https://github.com/ziyixi/todofy/actions/runs/37079972709) reused the exact tested image artifact; Newsletter image publish, Mail Hero deploy, Watch deploy and Dashboard deploy all passed. All nine shared probe calls use a quoted workspace absolute path, with regressions from actual workflow directories and a workspace containing spaces; the old Watch call fails the negative control with exit 127.
- Configuration run [37080121901](https://github.com/ziyixi/todofy/actions/runs/37080121901) pulled the public released image without a Docker login, validated the authored configuration and published its immutable bundle to the monorepo's `published` branch. This does not switch the VPS config-sync source or trigger a preparation/send. The root daily trigger's settings have not been migrated and its manual dispatch has not been exercised.
- The owner approved a public code-only `todofy-newsletter` package; GitHub created it public. The original Newsletter package permissions and existing VPS image/configuration are unchanged. Source import and first-upgrade/rollback boundaries are documented in `newsletter/docs/import-source.md` and `newsletter/docs/deployment-drain.md`.
- Four retired GHCR packages (`todofy`, `todofy-llm`, `todofy-todo`, `todofy-database`; 302 versions) were deleted after exact owner confirmation and verified absent. Current public server deployment configuration has no references; the older local deployment checkout is stale. Migration snapshots and unrelated images remain.
- No K3s was installed, no VPS service was upgraded, and no real model call, Notion operation or newsletter send was used for this foundation's verification.


The pattern every owner API followed (owner-approved, Google style, from Lab), for any new app or API: describe every route the app's UI
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

## Waiting to be verified

- `todofy.ui.v1` (landed `b70856f`, 2026-10-02 20:02 UTC): verified. Todofy's deploy succeeded (core, then the
  gateway); every owner route the UI calls answers 200 (serviceStatus, mailEvents with paging and `filter`, one
  event, dailyReminders, latestReports, metricDays, gtdDays, gtdReviews, integration); old owner paths answer 410
  with "Todofy 已更新，请刷新页面"; the machine routes are unchanged (`/api/summary` and `/api/recommendation` 401
  with Basic realm "todofy" without credentials, `/health` 200). A manual canary at 20:06 UTC was delivered to
  Todofy. Left: the newsletter's 2026-10-03 13:30 UTC run (reads `/api/summary` and `/api/recommendation`); remove
  the old owner paths (`todofy/gateway/src/owner.ts`) and core's `owner_api` after 2026-11-02.
- `mailhero.ui.v2` (landed `d1bde0e`, 2026-10-02 20:00 UTC): verified. Mail Hero's deploy succeeded; overview,
  setup status, settings, messages (list, one detail, its content), deliveries and endpoints answer 200; the raw
  download answers 200 with no-store, nosniff and attachment; old `/api/v1/*` answers 410 with "Mail Hero 已更新，
  请刷新页面"; real mail and the canary were delivered after the deploy. On CI the send's first run read about
  3.6-4.0 reference ms with the startup warm-up (bound 6). Left: remove the `/api/v1` 410 answer after 2026-11-01
  (`mail-hero/cloudflare/src/native/api.ts`).
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
- Infra drift must stay `no-op 19` on its daily scheduled run (13:23 UTC; GitHub often starts it hours late). On
  2026-10-02 the scheduled run had not started by 18:25 UTC; a dispatched run (read-only plan) then read `no-op 19`.
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
- Optional: a Newsletter run receipt so the dashboard can show its health. Its source is now here;
  the existing VPS runtime is unchanged and receipt deployment is a later phase.

## Next, in order

1. Root proto is the single IDL for the Cloudflare owner interfaces (done 2026-10-02); imported
   Newsletter retains its external protobuf dependency and its separately versioned internal deployment JSON. Follow-ups: remove the 410
   routes on their dates; remove `owner_api` from `todofy-core` in the release after `proto-todofy-ui`.
   The Mail Hero integration document now names the machine OpenAPI and root owner proto; its stale
   owner OpenAPI and removed UI generator references were corrected by the foundation branch.
2. Watch W4: a shadow-mode week (watches report, no Todoist tasks), then the owner's watches.
3. FlowDay F6 after 2026-10-08 with the owner's OK.
4. Service catalog (IaC P5): one `app.toml` per app generating hostnames, Access apps, dashboard links and
   probes, validated against each `wrangler.toml`; P5 is implemented on main; P6 (rollback drill for `infra/`) remains later.
5. Code quality phases Q0–Q7: English comments everywhere, coverage and lint ratchets, clock injection in every
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
- A first request that pays for the codec: an isolate's first owner-API request runs protobuf-es and the wire codec
  before V8 compiled them (about 1-2 reference ms more). Run the answer path once at startup (`warmup.ts` in FlowDay
  and Mail Hero, `warm.ts` in Todofy's gateway), which costs about 10 ms of the 1 s startup budget.
- Since `PreEncoded` (the dashboard), the transcoder's handler type answers `Message | PreEncoded`; a test that calls
  a handler directly narrows the answer first (FlowDay's `reads.test.ts` `message()`).
- Rebasing shared docs: a union merge of long one-line paragraphs duplicates clauses. Merge by meaning, then compare
  every long changed line with both parents (each list of apps must name every app once).

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
