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

Last updated: 2026-10-11.
<!-- Active work is separate from the production evidence below. -->

## In flight (2026-10-11): Brief resource registration and Home monitoring

First deployment confirmed: `7bea3ec`, [CI run 38128504001](https://github.com/ziyixi/todofy/actions/runs/38128504001).
"Infra apply" created the Access applications `brief` and `brief-feedback`. A limited production check confirmed
`BUILD_SHA=7bea3ec`, `MODE=archive`, the `BriefState` namespace and the configured secret names `ANTHROPIC_API_KEY` and
`RESEND_API_KEY`; no secret values were read. The GitHub variable `BRIEF_MODE` is also `archive`. This mode fetches
sources and can call the paid Claude API, but sends no email. Configured keys do not prove successful model calls or
email delivery.

Current work: `codex/brief-home-monitoring`, based on `7bea3ec`, registers the existing `brief-state` namespace,
regenerates the resource inventory, removes the first-deploy exceptions and connects Home's `BRIEF` Ops binding
(`status.type = "ops_v1"`, status/guard fixtures and labels). CI must deploy Brief before Home at the same SHA.
Implementation and local checks are complete; branch CI, release and production acceptance for this follow-up
remain pending. Local verification: 435 repository checks (one skipped), 33 service-catalog and 17 cloud-config
tests; proto lint/breaking checks; Home's 267 unit, 97 workerd, 158 web and 17 deployment-configuration tests;
Brief's six Ops tests and the workerd restart test preserving the saved budget. Home typecheck, lint and web build
passed. A read-only comparison with the Cloudflare account found zero Worker, D1, DO or R2 inventory differences.
The release classifier selects only Brief and Home; Newsletter, VPS and other applications are not selected.

The production settings page was checked read-only: version `7bea3ec`, archive mode and the owner's saved **$80**
monthly budget. Preserve this stored setting; the code's initial default remains $40, and the Claude Console limit
is separate and unverified. Keep `MODE=archive`; Newsletter is unchanged by this work. The sender remains
`onboarding@resend.dev`, as the newsletter's, so future mail can reach only
the Resend account's own address until the sender changes.

Owner request 2026-10-10: replace the newsletter with a cheaper, better briefing (design in `brief/docs/design.md`,
rules in `brief/AGENTS.md`, use and deploy in `brief/README.md`). The owner's answers of 2026-10-10 are in the design
(§3.3, §6, §19): the LLM topics 熟悉 (seismology and ML for geophysics 专业, the rest 通俗); full text wherever it is
public as the owner's browser would reach it (AI-agent robots blocks do not apply, a group naming `ziyixi-brief`
does; pacing, the honest UA and arXiv's 1 request / 3 s stay; never a paywall or a login); the spend approved in
principle (originally a $40 budget and a suggested $50 Console limit); 06:30 weekdays and 07:30 Saturday;
`brief.ziyixi.science`; the deep read at `high` effort. The newsletter's retirement stays a separate decision
(root `AGENTS.md` now names the brief as its
successor in progress).

The initial implementation landed on `main` in `0e48a59`, from `brief-land` (the design, the Worker, the archive UI,
the email's render, the dry run and the review fixes of 2026-10-11). The following records that build's predeployment
implementation and synthetic validation:

- `brief/worker/`: the fetch handler (Access, CSRF, `/feedback` with its HMAC token before anything else) and
  `BriefState` (`brief-v1`): the alarm chain with per-step budgets (40 subrequests, a 4-minute step wall with its own
  AbortSignal under the 15-minute alarm, crash counters, deploy-interrupted steps and calls not counted), the registry
  loader, the fetchers (RSS/Atom/RDF, the arXiv API at 1 request / 3 s, JSON, GeoJSON, sitemaps, full text through
  HTMLRewriter, per-host pacing, robots.txt for the brief's own token), dedup and world clusters (Workers AI bge-m3), the
  Haiku gate, the Opus pick and write (the official SDK, streaming with `finalMessage`, structured outputs, adaptive
  thinking with explicit effort, server-side fallbacks for Opus, refusals, bisection, cost from usage), the grounding
  check in code, the Saturday deep read, the render, the Resend ledger (one send a day, unknown never replayed), the
  votes and weekly learning, the monthly budget, ops-v1 and the owner API `proto/brief/ui/v1`.
- The email (`worker/src/render.ts`): one column of at most 600 px, every style inline, a dark scheme for the clients
  that honour it and mid-tone colours for Gmail's forced inversion, Chinese typesetting in the email only, the source
  line from the registry, 👍 · 👎 · 多来点 per item, the quiet-day note; golden files `test/golden/email-*` byte for
  byte (`.gitattributes`). Checked as screenshots in headless Chromium at 375 and 800 px, light and dark; never in a
  real Gmail, Apple Mail or Outlook client. The writer's prompts (`worker/src/prompts.ts`): `policy.md` then
  `profile.md` as one frozen first block with the one cache breakpoint, shared by the write, the bisection, the repair
  and the deep read (design §7); `policy.md` and `profile.md` tightened (熟悉 is "less background, more of what is
  new"; length limits for titles and `why`; full-width punctuation). The issue's items keep the pick's order after a
  repair or a bisection, and `ok_source_count` no longer counts sources never polled (来源's 未抓取).
- `brief/deploy/` (`deploy-vars.mjs` with `BRIEF_MODE`, the owner-machine keys refused; `bundle-size.mjs`, 340 KiB gzip
  against 274.3 KiB measured) and their tests; `brief/app.toml`.
- `brief/web/`: the archive UI (期刊 · 来源 · 偏好 · 设置, mailsort's and recall's design system with the amber of
  Home's tile and a red for problems; plain TypeScript, Vite, no framework): the issues with their state chips, an
  issue as in the email with each `[n]` opening its quote, document and entailment verdict, the votes (VoteItem), 还有,
  成本明细; the sources' health and weights; the topic weights and 重置; 暂停, 恢复调用 and the monthly budget. 47 jsdom
  tests over a fake of `brief.ui.v1` on the shared transcoder; 47.7 KiB of JavaScript gzip against 57 KiB. Checked by
  hand at 360 px, light and dark, in a browser against the real Worker in Miniflare (the runtime harness's synthetic web
  and fake Claude and Resend, a week of alarms, loopback only; its CSP, CSRF, VoteItem, 暂停 and the budget), and the
  local loop (`npm run dev` in `worker/` and `web/`: reads and a CSRF mutation through Vite's proxy); not against
  Cloudflare.
- Review fixes (2026-10-11, design §4-§8, §15): 暂停 and `BRIEF_MODE=off` stop an issue already running (checked at
  every model call; the step waits without an attempt and ends at 12:00); no call or retry past the send cutoff, and an
  earlier day's run never holds up the next; an answer that is no JSON is never re-read; a write or deep read out of
  tokens or time is halved or shortened, not repeated; a failing sitemap page ends its round; the read never waits on
  a host backing off; headings and links are checked, quantities within 10%, negations in aligned quotes, magnitudes,
  分/秒 and 近万-style words; world stories and 还有 never repeat (whole clusters run, the hold-back at the cutoff);
  cards keep every topic's best (the 专业 topics' 5); 8 items in all; old feed entries and early mentions handled; a
  failed gate call leaves its candidates pending; the feedback body read capped; a page's hidden elements dropped; the
  Guardian and NPR read as pages.
- Tests: 105 unit tests (the SDK over a fake SSE stream, every 4xx class, the grounding check's synthetic Chinese and
  English sets, the ops-v1 golden bytes, the prompts, the golden emails) and 40 workerd tests (a weekday and a Saturday
  end to end, every failure wall, owner API, ops-v1, `rows.test.ts` and `cpu.test.ts` at the bounds of
  `test/runtime/bulk.ts`, and `dry-run.test.ts`: a shadow weekday from synthetic feeds and article pages through the
  gate, a fake Opus that picks across topics and writes plausible Chinese items with verbatim quotes and the quotes'
  numbers, one overstated number repaired, the render in the pick's order and exactly one send through the fake Resend
  though the day runs on and an alarm runs twice). Measured on 2026-10-11 (reference ms): a collect alarm of 40 polls of
  1 MiB 523, the embedding and gate 96, the pick with its hold-back 35, the check over 68 aligned quotes 137; a day at
  the bounds about 36,000 rows read and 6,500 written.

Initial check-only integration (`0e48a59`, historical): the catalog (`brief/app.toml`, Home's tile with
`status.type = "none"`), `CHECK_ONLY` in `ci_changes.py`, the "Brief checks" and "Brief deploy" jobs, the release recipe
in `worker-release.yml` (it builds `brief/web`; `CHECK_ONLY` kept it from running), the reconcile matrix, the release
and bootstrap tools, cf-guard's committed-config test, `infra/` (the owner application `brief` and the Bypass
application `brief-feedback` of exactly `/feedback` with its policy: 39 objects; `AHEAD_OF_DEPLOY`), the drift desired
state (with `rules` taught as a bundling key), the account inventory and the reconcile matrix
(`FIRST_DEPLOY_PENDING = {"brief"}` and the matrix's `exclude` skipped checks before the first deploy) and ops-v1's
`OpsStatus.app` (`UNBOUND_OPS_APPS` contained `brief`). "Infra drift" and Home's 配置漂移 showed the three missing
Access objects until "Infra apply". These were rollout stages, not the current deployment state.

Verify, in `brief/worker`: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:runtime`; in `brief/web`:
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build` (the JavaScript budget); in `brief`:
`node --test deploy/test/*.test.mjs`; the dry run of "Brief checks"; the root guards (`.github/scripts`, the tools'
tests, `generate.py --check`, `catalog.py --check`, `inventory.py --check`, `drift_desired.py --check`, cf-guard's
tests); `proto/`: lint, api-lint, breaking, the rules self-test, the codecs' tests; the dashboard's Worker and UI tests.

Open for the owner: whether `geo.earth` stays 熟悉 (the design's reading of "seismology and geophysics stay 专业": the
seismology and ML-for-geophysics topics 专业, the broader solid Earth 熟悉); the writer's cache breakpoint follows the
spec's caching of the stable prefix (about $0.1 a month when it misses, design §7). The initial checks above used fake
Claude responses. The prompts, efforts and Opus's length and format handling still need archive-day acceptance.

Next, in order:

1. Complete the resource and Home integration checks, then release the same green SHA through main CI.
2. Confirm Brief and Home's build SHAs, the registered namespace and Home's real Ops status; verify `MODE=archive`
   and the saved $80 budget remain in place. Record the exact CI run and production evidence here.
3. Observe the archive days for source coverage, model quality and cost (design §16). Shadow mode, live sending and
   Newsletter retirement require separate owner decisions.


## Done (2026-10-11, Claude): mailsort archives every labelled mail

Owner decision (2026-10-11): a mail mailsort labels leaves the inbox and is found under its label, and is never marked
read. Deployed in `a49349d`: the needs_action exception and question are gone; only a label's 归档 switch
(`keep_in_inbox`) keeps its mail in the inbox (the owner turned it off on every label, so all of them archive).

## Live (2026-10-11, Claude): recall, the browsing recorder

Status 2026-10-11 08:11Z: the owner's device uploads (extension from the GitHub Releases), the Dropbox archive is
connected and its hourly pass verified (`ServiceStatus.dropbox_backup`: `last_upload_time` advances, `synced_seq` grows;
a pass comes one hour after the first change since the last one, so up to about an hour pending is normal), and the
rolling text retention (365 days, only after Dropbox confirms) is deployed in `2a6e241`. The history below is how it
got there.

Owner request (2026-10-10): record what the owner reads in Chrome (visits with real focus time, the page's text after
ten seconds), with a very good timeline and search UI, and keep a durable copy on the NAS through a generic protocol
so the store can change later. New app `recall/` (Worker `recall`, host `recall.ziyixi.science`, one SQLite DO
`RecallState`, private R2 bucket `recall-store`, a MV3 extension; the NAS copy was a pull container until 2026-10-11,
now recall pushes the archive to the owner's Dropbox); design in
`recall/docs/design.md`, rules in `recall/AGENTS.md`, use and deploy in `recall/README.md`. Owner defaults of §12
kept: sensitive sites by their site alone, Google Docs/Drive IDs kept by the scrubber.

Landed on `main` at `eaeddf4` (branch `recall`), all built and checked, nothing deployed:

- The contracts: the owner API `proto/recall/ui/v1`, the upload `proto/recall/ingest/v1` (the extension uses its
  generated wire types only: `recall.ingest.v1` is in `gen_wire_ts.py`'s `WIRE_PACKAGES`), and the archive contract
  `contracts/recall-archive-v1` (IDL `proto/recall/archive/v1`, generated schema, golden fixtures, sample archive;
  `proto/test/recall-archive.test.ts`, `PROTO_READS`).
- `recall/shared/` (URL normalization and the page ID, the scrubber, the denylist, the bigram segmenter, run by both
  the extension and the Worker); `recall/worker/` (machine routes with digest-checked tokens before Access,
  `RecallState`: the write and index budgets, the compacted feed with `feed_id` and tombstones, FTS5 search, the
  timeline, the owner API, ServiceStatus and ops-v1); `recall/deploy/` (deploy-vars, bundle budget, `mint-tokens.mjs`).
- `recall/extension/` (focus, visits, captures, outbox, uploads, self-update through `BUILD`; CI builds the artifact
  `recall-extension-<sha>`, kept 30 days, and every main run that changes `recall/extension/` or `recall/shared/`
  publishes a permanent GitHub Release `recall-extension-v<version>` with the zip (job `recall-extension-release`); extension ID `kpehdcbafdhgghclgaeigokjoceemfhj`, from the committed public
  key).
- `recall/web/` (时间线 · 搜索 · 设置, mailsort's design system with a violet accent; 53.6 KiB of JavaScript gzip
  against 62 KiB).
- `recall/sync/` (the reference consumer, one standard-library Python file, its Dockerfile) and the manual workflow
  `recall-sync-image.yml` (`ghcr.io/ziyixi/recall-sync`; never dispatched): removed by `recall-dropbox-archive`.
- The smoke run `recall/worker/test/smoke/smoke.mts` (`npm run test:smoke`, in "Recall checks"): the extension's own
  code uploads to a real `wrangler dev`, the owner API answers the UI's calls, `recall_sync.py --once` fills an archive
  that the generated codec and the contract accept, a second pull changes nothing and a DeletePage reaches it.
- A second review of the built code (safety, correctness, UI) was applied on the branch (design §12): a daily read
  budget and bounded search sources (rows read held in `worker/test/runtime/scale.test.ts` at two years' scale), a
  wider scrubber and denylist, the owner's site-only list (`site_only_patterns` in Settings and the upload's answer),
  `unsupported_item` for a newer extension's items, `_` in the archive's Site format, the
  deletion ledger in recall's clock, `mint-tokens.mjs --revoke` for a leaked token, NAS details out of the public docs,
  and the UI's back, phone rows, picker, focus and wording fixes. These contract changes were made before anything was
  deployed; against `main` (CI's diff base) they are additions, against the branch's earlier commit the profile's
  breaking rules would name the Site format and `RejectedItem.reason`.

Landed check-only (design §11 step 1, mailsort's step 1 as the template), each list one entry: the catalog
(`recall/app.toml`, Home's tile with `status.type = "none"`), `CHECK_ONLY` in `ci_changes.py`, the "Recall checks"
and "Recall deploy" jobs, the release recipe in `worker-release.yml` (production, Access and Bypass probes), the
reconcile matrix, the release and bootstrap tools (`control.py`, `cloudflare.py`, `deployments.py`, `finalize.py`,
`github_secrets.py`), cf-guard's committed-config test, `infra/` (the owner application, the Bypass application of the
three machine routes and the bucket: 36 objects; `AHEAD_OF_DEPLOY`), the drift desired state, the account inventory
and ops-v1's `OpsStatus.app` (Home kept recall out of the apps it calls: `UNBOUND_OPS_APPS`). The owner's "Infra
apply" (2026-10-10) created the four objects "Infra drift" had planned (two Access applications, the Bypass policy,
the bucket). Home's 配置漂移 shows recall missing until the first deploy (a view, no mail).

On `main`, "Personal cloud reconcile" has failed since `eaeddf4`: its inventory job counts 2 changes (the
Worker `recall` and the bucket `recall-store`, registered but not created) and "Compare or repair recall" ends
`VERIFIED_DEPLOYMENT_MISSING` (never deployed). Branch `recall-release`, commit 1, makes both wait for the first
deploy: `FIRST_DEPLOY_PENDING` in `tools/service-catalog/inventory.py` now names Workers (`{"recall"}`): the Worker
and the buckets it binds may be absent, its namespace has no id and an existing one is not reported, and
`expected()` refuses a recorded id while the entry remains; the reconcile matrix has `exclude: - app: recall`, held
equal to that set (and its app list to `control.py`'s `WORKERS`) by `test_reconcile_workflow.py`. The release recipe
itself was already complete on `main` (`ci.yml` `recall-deploy`, `worker-release.yml`, `control.py`, `cloudflare.py`,
`deployments.py`, `finalize.py`, `github_secrets.py`; `RELEASE_PENDING` was removed before landing).

Branch `recall-release`, commit 2, is the go-live commit (design §11 step 3, mailsort's `0d74183` as the template):
the AUD and application id of the Access application `recall` in `config/resources.toml`, written by `generate.py`
into `recall/wrangler.toml` (`ACCESS_AUDIENCE`) and `infra/ids.tf`; `CHECK_ONLY` and `AHEAD_OF_DEPLOY` emptied,
`recall` in `HOME_BOUND`; Home's `RECALL` binding to recall's `Ops` (`dashboard/wrangler.toml`, `status.type =
"ops_v1"`, guard false, `UNBOUND_OPS_APPS` emptied, Chinese labels for recall's signals and counters), Home's deploy
waiting for recall's in `ci.yml`, and Home's tick budget `MAX_OUTBOUND_PER_TICK` raised from 30 to 31 (eight
`status()` calls now; Free allows 50 subrequests); recall's ops-v1 fixtures `OpsStatus/recall-ok.json` and
`recall-degraded.json` with their golden test `recall/worker/test/ops-golden.test.ts` (a Contracts step), its
deployment-mode profile in Mail Hero's and Todofy's contract tests, and the drift desired state regenerated. The
Bypass application `recall machine routes` keeps its AUD and id out of the repository: nothing checks them (the Worker
checks the machine tokens itself; fleet_receipt's id is recorded only for a rebuild by import, which would also need
its policy's id). `FIRST_DEPLOY_PENDING` and the reconcile `exclude` stay until the commit after the first deploy.

Branch `recall-dropbox-archive` (2026-10-11, one commit on `5086599`; owner decisions of 2026-10-11: the NAS backup
must not depend on code of ours on the NAS or the Mac, UGOS syncs Dropbox but cannot pull an S3 endpoint, and the
owner runs no command):

- The archive is pushed by recall: the alarm writes `contracts/recall-archive-v1`'s layout into the app folder of the
  owner's own Dropbox app (`worker/src/archive.ts`, `backup.ts`, `dropbox.ts`; schema 2: `archive_days`,
  `archive_blobs`), about an hour after changes, at most 40 subrequests and 5 minutes a pass, newest day first, each
  blob once (`add`), day files and `state.json` whole (`overwrite`), Dropbox's content hash checked, 429/Retry-After
  and backoff, never a delete (a deletion is its tombstone line; the archive only grows). Connected in 设置 → 备份到
  Dropbox with the App key alone (OAuth 2 PKCE, `token_access_type=offline`), callback `GET /api/dropbox/callback`
  behind Access (no Bypass), state once and 15 minutes, the refresh token only in the DO; 断开 revokes it.
  `fixtures/archive/state.json` and `ArchiveState/synced.json` now say `consumer: dropbox` (never consumed before).
- The machine tokens are made in 设置 → 插件口令 (`RegenerateMachineToken`, `DeleteMachineToken`; `worker/src/tokens.ts`):
  shown once, only the SHA-256 kept, 24 h grace on regenerate, `revoke_previous` for a leak; the Worker keeps the
  DO's digests a minute (a refused bearer rechecks after 10 s); Worker-secret digests stay accepted. The export token is
  optional. `deploy/mint-tokens.mjs` and its test are deleted; the extension's options point at 设置.
- The owner API additions (additive, api-linter clean, no breaking change against `main`): `DropboxBackup`,
  `MachineToken`, `ServiceStatus.dropbox_backup` and `.machine_tokens`, `ERROR_REASON_INVALID_APP_KEY`.
- ops-v1: `archive_behind` now measures the Dropbox writer (`hours`, `since`; 24 h, from the connection at the
  earliest), `archive_not_connected` is new (warning until connected); feed consumers raise nothing.
  `OpsStatus/recall-degraded.json`, recall's and Home's ops goldens and Home's Chinese labels follow.
- Removed: `recall/sync/`, `.github/workflows/recall-sync-image.yml`, the consumer and Python steps of "Recall checks".
  The UI: 设置's 插件口令 and 备份到 Dropbox cards, the header's backup line, the delete confirmation's wording.

Verify, in `recall/worker`: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:runtime` (workerd, a fake
Dropbox), `npm run test:smoke` (after the UI build; a loopback fake Dropbox); in `recall/web` and `recall/extension`:
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; in `recall`: `node --test deploy/test/*.test.mjs`;
in `proto`: `npm run lint`, `npm run api-lint`, `npm run breaking -- origin/main`, `npm test`; Home's
`dashboard/worker` and `dashboard/web` tests; the root guards (`python3 -m unittest discover -s .github/scripts`, the
tools' tests, `generate.py --check`, `catalog.py --check`, `inventory.py --check`, cf-guard's tests).

After its deploy: the release probes as before (the machine routes answer 503 until a token exists, then 401);
设置 shows 插件口令 and 备份到 Dropbox; Home's 浏览记录 tile warns `archive_not_connected` until the owner connects.

Branch `recall-retention` (2026-10-11, one commit on `c3e21b6`; owner request of 2026-10-11: everything is backed up
to Dropbox, so Cloudflare keeps a rolling hot window of texts, not everything, to stay inside the free limits):

- `Settings.text_retention_days` (365 by default, 30-3650, or unset = every text stays), edited in 设置 → 存储. The
  alarm's retention step (`worker/src/retention.ts`, after the archive pass; at most 100 texts and one R2 call a run,
  within the daily maintenance allowance) moves a text out of R2 and the FTS index only when its capture is older than
  the window, its page is live, Dropbox is connected and not failing, and the archive ledger confirmed this exact
  blob (`archive_blobs` for the current target with Dropbox's content hash; a `dropbox_conflict` is now recorded
  without one), its day file written since, and `state.json`'s seq past it. The document row stays (`archived_ms`,
  schema 3, same seq and blob path); pages and visits are never removed; no tombstone; the feed and the archive are
  unchanged; the blob route answers 410 `blob_deleted` (the contract README says retention causes it and the Dropbox
  copy remains). A new Dropbox target gets every line but not the texts only the old folder holds (documented).
- Owner API, additive: `Settings.text_retention_days` (`optional`, mask-only), `Document.text_archived` and
  `.archive_path`, `ServiceStatus.text_retention_days`, `.archived_text_count`, `.text_retention_paused_reason`
  (`dropbox_not_connected`, `dropbox_failing`), `ERROR_REASON_INVALID_RETENTION`. No ops-v1 change:
  `archive_not_connected` and `archive_behind` already cover a paused window.
- UI: 设置 → 存储's window (a choice of 30 天 to 10 年 or 永久; shorter asks first; the counts in Cloudflare and only in
  Dropbox; the pause in words; the settings etag shared with 网站名单), the page detail's 正文已归档到 Dropbox with the
  archive path, the search's line that text search covers the last N days.

Verify, in `recall/worker`: `npm run lint`, `npm run typecheck`, `npm test` (`test/retention.test.ts`),
`npm run test:runtime` (`retention.test.ts`, the CPU and two-year scale tests with a retention step),
`npm run test:smoke` (a late upload of a text read 400 days ago leaves Cloudflare right after the confirming pass);
`recall/web` and `recall/extension` lint, typecheck, test, build; `node --test deploy/test/*.test.mjs`; `proto` lint,
api-lint, breaking against `origin/main`, test; `.github/scripts` unit tests.

After its deploy: 设置 → 存储 shows 正文在云端保留 1 年 and, until Dropbox is connected, the paused line; nothing leaves
Cloudflare before the first texts are a year old (October 2027 at the default), so no early production check exists
beyond the status fields; Home's tile is unchanged.

Next, in order:

1. Owner, before `recall-release` lands: the CSRF key, never shown, in their own terminal:
   `openssl rand -hex 32 | gh secret set RECALL_CSRF_SIGNING_KEY -R ziyixi/todofy --env production`. Nothing else is
   new: the owner addresses come from `DASHBOARD_ACCESS_OWNER(_ALIASES)`, `RECALL_WORKER_SECRETS` may stay unset, and
   the machine tokens' digests are never a deploy's. Without the key, "Recall deploy" stops at "Write the Worker
   secrets file" and Home's deploy (which needs it) does not run.
2. Done (2026-10-11, `ee02b62`): `recall-release` landed; its push deployed recall for the first time, then Home with the `RECALL`
   binding. Check: the release's production, Access and Bypass probes; `https://recall.ziyixi.science/` asks for the
   Access login; after a tick Home's 浏览记录 tile shows recall's own status (正常, with the information `no_device`
   until the first upload) instead of 未知.
3. Done (2026-10-11): the `RecallState` namespace id into `config/resources.toml` `[durable_objects]`
   (`recall-state`, read with the read-only admin helper), `FIRST_DEPLOY_PENDING` emptied and the reconcile matrix's
   `exclude` removed in the same commit (the inventory and `test_reconcile_workflow.py` refuse anything else), then
   `generate.py` (Home's resource identities) and `inventory.py --generate`; as mailsort's `6f5f93e`.
4. Done (2026-10-11, `c3e21b6`): `recall-dropbox-archive` landed (its push deployed recall, then Home). Next, land
   `recall-retention` (its push deploys recall, then Home); it does not touch `.github/workflows/ci.yml`.
5. Agent: build the extension on the owner's Mac into `~/recall-extension` (`npm run install-extension` in
   `recall/extension`).
6. Owner, clicks only (`recall/README.md` "The owner's setup"): 设置 → 插件口令 → 生成 → 复制; `chrome://extensions` →
   开发者模式 → 加载已解压的扩展程序 → `~/recall-extension`, the icon → options: paste the token, the device label, 保存;
   dropbox.com/developers/apps → Create app (Scoped access, App folder) → Permissions `files.content.write` and
   `files.content.read` → Redirect URI `https://recall.ziyixi.science/api/dropbox/callback` → copy the App key; 设置 →
   备份到 Dropbox → App key → 连接 → Allow; UGOS Cloud Drives → Dropbox → sync `Apps/<app name>` to a shared folder,
   cloud → NAS. Phase 1a's first checks in a real Chrome (design §3.10, `recall/extension/README.md`): one focus
   switch, one capture, the badge, the options page, and whether Chrome serves an unpacked extension's files as they
   are on disk (the self-update relies on it); then 设置 → 备份到 Dropbox `已全部备份` and the files in the app folder.

## Done (2026-10-10, Claude): mailsort model-first, calibrated and live

mailsort decides every mail with the model since `af11953`..`2fa050d` (no sender rules; two views; a small review
queue; trusted domains; the replay evaluation; design §4.4, §5, §5.1). The replay of 81 mails the owner had labelled
calibrated the gate: p(suspicious) told ordinary mail nothing apart, so it is gated only for unauthenticated senders
(< 0.6) and trust labels (< 0.95); about 60 of the 81 labelled at about 97 % precision (design §8.1). The daily neuron
budget defaults to 95 % of the account's allocation, shared with the replay. Live since 2026-10-10: the owner set
`MAILSORT_MODE=live` and put the modify grant (`mint-token.mjs --scope modify`); 设置's mode is 正式. Watch the first
days' corrections in Gmail and 概览; undo by range in 设置.


## In flight (2026-10-06, Claude): Home reports account changes made outside CI

Owner request (security follow-up): be told when the Cloudflare account changes other than through CI. Home's
daily drift check (`dashboard/worker/src/drift.ts`, design-v2 §10) now also reads the account audit log for the
writes since the previous check not made with an API token (CI uses API tokens only): dashboard edits (token
edits included), `wrangler login` deploys, a Global API Key. New drift category `account_changes` (非 CI 改动),
one finding per way in and resource with action counts; each change shows once, the day after; analytics and log
queries are dropped; no actor address, IP or id is kept. Read with the existing `CF_ANALYTICS_TOKEN` (verified
2026-10-06: the current token reads the audit log); a split read-only token needs Account Settings Read, and
without it the panel says the changes were not checked while the rest of the check runs. The check now takes
four ticks (account step: four calls). Live since Home's deploy with mailsort (`a3705ed`, 2026-10-07). Verify: the
first 配置漂移 check after 02:00 UTC on 2026-10-08 completes, and the owner's dashboard actions of 2026-10-07 (the
Lab Worker deletion) show once as 非 CI 改动.

## In flight (2026-10-06, Claude): mailsort, the Gmail auto-labeler

New app `mailsort/` (Worker `mailsort`, host `sort.ziyixi.science`, one SQLite DO `MailsortState`, no D1/R2), owner
plan approved 2026-10-06; design and safety model in `mailsort/docs/design.md`. Rules first, then nearest corrected
examples (bge-m3), then the Cloudflare decision model Clef 27B (Clef-flash for the rest of the UTC day past ~70% of
the neuron budget). One label per mail, at Gmail's top level (up to three levels; no `分拣/` prefix since
`feat/mailsort-labels-ui`); confident mail is labelled and archived
(INBOX removed) but never marked read, unless the label or rule keeps it in the inbox; unsure mail gets nothing. No
backfill. Gmail is touched only through the closed operation table in `mailsort/worker/src/gmail.ts` (no trash,
delete, send, UNREAD or non-owned labels; undo via the ledger only). The Gmail grant is written into the Worker from
the owner's machine (`mailsort/deploy/mint-token.mjs`), never into GitHub. Rules are personal values: they are
imported at runtime (ImportRules of the rule file, API only since the UI redesign), never committed.

Landing order:
1. Done 2026-10-06: `feat/mailsort` landed at `899b063` with `mailsort` in CHECK_ONLY (the smoke now stops the whole
   wrangler process group; a passing smoke used to hang the Linux job until its timeout).
2. Done 2026-10-07: the owner's Infra apply (run `37582770604`) created the mailsort Access app and deleted Lab's two
   objects; its verify plan was no-op (32).
3. `feat/mailsort-live`: AUD and application id in `config/resources.toml` (`generate.py` writes them into
   `mailsort/wrangler.toml` and `infra/ids.tf`), CHECK_ONLY emptied; landing deploys mailsort and Home.
4. Done: deployed at `a3705ed` (mailsort and Home); the `MailsortState` namespace id is in `config/resources.toml`
   (`chore/after-mailsort-live`). Live on 2026-10-07 in shadow: the owner's readonly Gmail grant (mint-token), the
   15-label template and the 93-rule file imported through the dashboard (93 create, 0 invalid).
5. `feat/mailsort-labels-ui` (2026-10-07): labels at Gmail's top level without `分拣/` (the owner's request,
   2026-10-07; `mailsort/docs/design.md` §2 "Labels without a prefix"). The guard creates only the store's planned
   names and renames an owned label only to its planned path; a Gmail label of exactly a label's path is never taken
   over by a write (the label shows 已有同名标签 and writes nothing) and only the owner's 从 Gmail 同步 adopts it,
   never one with sublabels; a label already on a mail is never written, so an undo cannot remove the owner's own
   (schema version 4, `gmail_adopted` and `gmail_name_taken`; additive, the live labels and rules need no data
   change); SyncLabels follows renames and deletions by Gmail ID and never imports; the rule file's legacy `分拣/`
   still imports. After its deploy: 标签 lists the 15 labels without `分拣/` (each label's 高级 says Gmail：尚未创建);
   设置 → 从 Gmail 同步 answers 已同步：关联 0，改名 0，Gmail 中缺失 0 and adds no label (a Gmail label of exactly one of
   their paths is adopted instead, 已沿用原有标签; one with sublabels is not, and that label's detail opens with
   Gmail 里已有同名标签).
   On the same branch, the UI redesign (the owner's "less is more", 2026-10-07; `mailsort/docs/design.md` §9), UI only,
   no proto or stored-data change: B1 done (the design system, the shell with four tabs 待审 · 概览 · 标签 · 设置 and
   one status line, 待审 with the picker and keys, 概览 with the always-drawn flow, 设置 with the mode, the previewed
   range undo, the sync and the filter download; 流程, 准确率, 状态, 例子, 导入 and 记录 removed) and B2 done (标签 as the
   one place for a label: search over paths and rule values, the tree grouped by top level with one line per label
   and 正式打, the detail inline with the description, 留在收件箱, the rules and 添加规则, the examples and 高级; the
   template when there is no label; `/rules` gone). The UX review's findings are fixed on it too (no sideways scroll at
   360 px on 概览 or 待审, tabs that keep the focus, no lasting error box, 阈值 and a rule's 留在收件箱 out of the UI, a
   visible off state and switch track, menus that close, 删除 of a rule asks first). Checked locally only (web lint,
   typecheck, vitest, build, a hand run against `wrangler dev` with the loopback fakes, and the review fixes at 360 px,
   light and dark, against the web tests' fake API); the branch is not pushed. After its deploy: 概览 draws the
   skeleton on a quiet day, 设置 → 撤销 → 预览 counts 0 while the grant is read-only, and 标签 shows the 15 labels in
   their groups with the 93 rules' counts (searching a sender of the rule file finds its label). A label whose name
   is taken or that Gmail lost says so on its row (同名已占用, Gmail 中已删除). Verified before landing: every CI job
   of the changed files locally, and workerd probes that the owner's own Gmail labels are never written by any
   automatic path. Known follow-up (low, needs the owner to act in Gmail first): a label mailsort already holds that
   later gains sublabels in Gmail keeps being written (`writes.ts` executeWrites, `api.ts` SyncLabels); refuse it the
   way adoption already refuses a label with sublabels.

Already set: production secret `MAILSORT_CSRF_SIGNING_KEY`, variable `MAILSORT_MODE=shadow` (the mode ceiling).

Google side, done by an agent with the owner's OK on 2026-10-06: a dedicated Google Cloud project with the Gmail API
enabled; the consent screen External (the owner approved accepting the User Data Policy) with homepage
`https://www.ziyixi.science/`, privacy policy `https://www.ziyixi.science/privacy/mailsort` (live since `3e369ec`) and
authorized domain `ziyixi.science`; published In production (unverified, so the grant shows Google's notice once).
Done 2026-10-07: the Desktop OAuth client (owner), `mint-token.mjs --scope readonly` (the owner pasted the secret in
their own terminal), the 15-label template and the validated rule set (93 precision-checked rules from a read-only
survey of the last 30 days, kept off the repo). Superseded 2026-10-10 by the model-first branch above (no rules, no
正式打): going live is the replay evaluation, then `--scope modify` and `MAILSORT_MODE=live`.
The synthetic Clef evaluation is dropped: the shadow run on real mail measures each label instead.

## In flight (2026-10-05, Claude): readability review, Newsletter warning, Lab removal

The owner asked for working, readable code (no large rewrites; complex but correct code such as the platform
release state machine stays), meaningful Home warnings, and Lab removed entirely.

Landing now as one stack (each app still deploys only through its own job):

- Newsletter: a node that hits its own deadline is `failed`/`timeout`, not `unknown` (read-only work has nothing to
  reconcile). This was the source of the daily `newsletter_unknown` warning (38 historical rows, all
  `workflow_attempts`). Releases the Newsletter + Platform images through the gated VPS release.
- Fleet + Home: Newsletter warnings mean the owner must act: `newsletter_side_effect_unknown` (delivery/Notion/packet
  ambiguity), `newsletter_delivery_overdue` (no accepted delivery for about 28 h), rejection, unavailability.
  Workflow bookkeeping (`newsletter_unknown`) is info only.
- CPU hot paths near Free's 10 ms: Mail Hero attachment downloads are answered by the coordinator (they parsed the
  whole parsed record in the Worker) and the Ops status codec is warmed at startup; Todofy's gateway passes the large
  non-paged core answers through as `PreEncoded`; the website relay's status reads fewer GitHub records.
- Home: unreachable guard paths and finished migrations removed; attention roll-up computed once.
- CI: one `test_app_isolation.py` replaces eight per-app import greps; job comments tidied. No deploy condition changed.

Landed after it (2026-10-06):

1. `refactor/newsletter-legacy-and-unknowns` (landed `befa1e7`, verified): the 38 historical `workflow_attempts`
   unknowns (37 `timeout`, 1 `interrupted`) become `failed` through a one-time migration
   (`migration:settle_read_only_attempts:v1`; error codes and rows kept, other ledgers untouched); cancelled and
   restart-recovered read-only attempts are also `failed`/`interrupted` from now on. The dead legacy pipeline
   (legacy-daily recipe, repair scan, whole-edition editor, v1 Notion, `legacy` backend) is deleted; stored legacy
   editions still render. The owner's read-only production count (2026-10-06) passed the gate: production runs
   `dag` with dual-database Notion, no open non-story runs or pending repairs, only old blocked history. A leftover
   `NOTION_DATA_SOURCE_ID` in the private Secret is ignored. Verified: Fleet reports
   unknown_count 0 at `befa1e7`; Home shows no Newsletter item. Left: the next daily issue is accepted.
2. `chore/decommission-lab` (landed 2026-10-06): Lab (paper radar) removed from the tree. Production teardown, in order
   (steps 3–5 done 2026-10-07 by the owner; `LAB_WORKER_SECRETS` no longer existed):
   1. Wait for Home's deploy: its release removes the live `LAB` service binding (reason
      `RETIRED_SERVICE_BINDING` in `tools/cloud-release/control.py`).
   2. Until step 4 these are red by design: Infra drift (a planned delete), the reconcile inventory check (lab
      Worker, D1 `lab`, LabState namespace unregistered) and Home's drift list (lab script and custom domain).
   3. Owner: delete the `lab` Worker in the Cloudflare dashboard (its LabState data and custom domain go with it).
   4. Infra drift must read exactly `create: 1` (the mailsort Access app) and `delete: 2` (`retired_lab` Access app
      and D1), output changes 2; the owner dispatches Infra apply with the expect it prints
      (`create=1,delete=2,outputs=2@…`) and `confirm_destructive=delete-replace-forget`.
   5. Owner: delete the GitHub `production` secrets `LAB_CSRF_SIGNING_KEY` and `LAB_WORKER_SECRETS`.
   6. Done (`chore/after-mailsort-live`): Home's deploy dropped the live `LAB` binding; the moved blocks, the `RETIRED`
      pairs and the `RETIRED_SERVICE_BINDINGS` entry are gone (the mechanism stays, its tests use synthetic entries).
      Lab is fully decommissioned.
3. Later, from the same review: Newsletter prompts as resources and mechanical cleanup, one shared deploy-vars
   engine for the Workers, platform helper de-duplication (and the 1000 vs 2^31 monitor-count cap mismatch), and a
   shorter HANDOFF.


## Todofy email model order: deployed; report trigger provenance pending

Release `26c9662c1ace2c578866f1691b3549a0cabb2f93` separates email/Canary model selection from daily reports.
Email order is Flash-Lite 3.5, Flash 3.8, Flash 3.7; reports retain Flash 3.8, Flash 3.7,
Flash-Lite 3.5. Missing email configuration inherits the existing default chain.
The shared client, fallback classifier, deadlines, token budget and frozen history stay intact.
The additive owner status field and Budget page show both orders.

[Branch CI 37247921893](https://github.com/ziyixi/todofy/actions/runs/37247921893),
[same-SHA main release 37248342156](https://github.com/ziyixi/todofy/actions/runs/37248342156)
and [post-release reconciliation 37248539807](https://github.com/ziyixi/todofy/actions/runs/37248539807)
succeeded. Cloudflare's actual variables and the live Budget page match both configured orders.
Synthetic Canary `canary-manual-20261005T004417Z` completed at Todofy using real
`gemini-3.5-flash-lite`; it created no Todoist task or report-summary row.

The October 5 finite metadata check confirmed real `gemini-3.8-flash` results for Top 10 at
`2026-10-05T13:40:00Z` and daily summary at `13:40:19Z`, both `ok` with nonempty input and no stored
error code. The application still reports the accepted release SHA and both intended model orders.
Branch `codex/email-report-acceptance` records this evidence only; it changes no application or switch.

Pending: platform invocation evidence that identifies the automatic Alarm as the trigger.
The report ledger stores no trigger origin; an on-demand request can write the same daily row.
This acceptance made no compute request, so it verifies the live report model without independently
proving automatic-trigger provenance. The thread follow-up remains active for that final check.
Fake services cover provider failures, Top 5's default chain and frozen history. Local test details,
production Canary scope, report observations and rollback links are in
[docs/email-model-verification.md](docs/email-model-verification.md).

## Website content sync: daily-window checks verified; controller source pending

`da35586e171f4eb8a9df93746f4b5948008ec8f3` passed branch CI and the same SHA passed the main release.
The existing relay now triggers a full content check daily at 10:17 UTC. Home provides **立即同步**
and monitors actual GitHub check/publication receipts through Ops. No new storage service or paid
product was introduced. Existing static identity, route verification and rollback remain authoritative.

The configured Notion Blog now has one **内容** view, the eight original content fields and
Draft/Published. Operational fields, buttons and summary were removed after the old writers drained;
both article bodies, content values and media references were preserved. Legacy writer workflows
were disabled, preserving their history. A subsequent full snapshot retained the same content hash.

The first Home manual sync completed with `SYNC_UNCHANGED`; the check clock advanced while the
verified publication clock and actual Worker version stayed unchanged. Additional requests were
accepted into the existing queue. Full evidence and the remaining checks are in
[docs/website-sync-verification.md](docs/website-sync-verification.md).

The expected October 5 and 6 daily windows produced cron-labelled runs
[37295602784](https://github.com/ziyixi/todofy/actions/runs/37295602784) and
[37448792826](https://github.com/ziyixi/todofy/actions/runs/37448792826). Their exact run/attempt/request
identities match successful `SYNC_UNCHANGED` receipts, checked at `2026-10-05T10:18:37.560Z` and
`2026-10-06T10:18:57.147Z`. Both verified the live baseline and skipped publishing. Between the
two daily windows, normal code pushes updated the website; the October 6 baseline is publication `2026-10-06T07:28:14Z`,
version `2fd07a7c`, website code `30fd74d`, also confirmed by Cloudflare's current version history.
Home was observed on October 6 with the new check time, matching Actions links and next check
`2026-10-07T10:17:00Z`; reminder controls were untouched. A direct local public identity fetch
was blocked, so its identity verification is the recorded Actions baseline check.

The relay schedule is confirmed as `17 10 * * *`, but the workflow also accepts a manual `cron`
label. Independent controller provenance still needs an existing relay `daily_sync` log with the
exact run ID. Existing token permissions block that query; the owner permission request is already
pending. The acceptance follow-up remains active and should wait quietly for that permission,
then correlate the existing run and stop once complete. Do not substitute a manual dispatch.
Complete withdrawal protection, provider failure, cancellation and rollback paths were tested
with fixtures; no live articles were withdrawn or production deliberately interrupted for this acceptance.

## Current production evidence

Dashboard state controls landed at
`8937e61c8b018d8c893356759f28cd9f2fd4ac57`: Newsletter process/outcome separation,
stable reminder batches, independent service controls and exact account inventory checks.
[Branch CI 37228587877](https://github.com/ziyixi/todofy/actions/runs/37228587877),
[main release 37229075275](https://github.com/ziyixi/todofy/actions/runs/37229075275) and
[post-release check 37229282583](https://github.com/ziyixi/todofy/actions/runs/37229282583) succeeded.
Fresh VPS/Fleet receipts verify the same source, release `686ff4c5-c790-4705-9a54-5b9d2d5160ca`
and generation 12, with these actual image digests:

| Image | Verified digest |
| --- | --- |
| Newsletter | `sha256:4b06b3f2ffb5e4247dad046749118a7593c216c1f4772285a31634e1c47224cb` |
| Platform | `sha256:54ef3cd0b9b581657df6dc68ce4958b6299bf76fc97a56807fb875f98f46e93d` |

The latest delivery record is `provider_accepted`. Home's Newsletter ops region shows normal status
and says the mail provider accepted the latest email, with no action required. All 34 historical
unknown outcomes are `workflow_attempts`; delivery and the other categories are zero.
Home's batch 34 was dismissed; a subsequent refresh showed no unhandled reminders or digest items,
and Todofy's latest receipt saved zero digest items. The business records remain intact.
The desktop Newsletter row grew to 77.1 px and wrapped without overflow. Both monthly R2 usage and
the R2 table correctly register `infra-state`. Verification triggered no new business sends.

The final Home wording revision `d4a2aa9733f1c4277c79e897c5fe383f9afeb64e` passed
[branch CI 37230057641](https://github.com/ziyixi/todofy/actions/runs/37230057641),
[main release 37230332240](https://github.com/ziyixi/todofy/actions/runs/37230332240) and
[post-release check 37230452684](https://github.com/ziyixi/todofy/actions/runs/37230452684).
After the natural 13:00 local tick, the browser showed all 11 current REST Workers registered,
including idle `ziyixi-website`. `__unknown__` and `ziyixi-apex-redirect` appeared only in the
separate historical usage section, with wording that no current resource matches them.
Home's footer shows `d4a2aa9`, zero unhandled reminders and one ignored item; the dismissed
Newsletter batch remains closed across the new tick. Operational semantics and acceptance
are in [docs/dashboard-state.md](docs/dashboard-state.md); rebuild limits remain in
[docs/rebuild.md](docs/rebuild.md) and [docs/rebuild-verification.md](docs/rebuild-verification.md).

### Foundation and migration history

The verified foundation implementation is `8628e5e`; the k3s/Fleet
implementation and pinned connector bootstrap reached `main` at `54861b2`. The owner completed the bounded
SDK repair at `c703378`; Actions then activated the first API release and verified the physical images.
The subsequent `0f84d91` release encountered a Kubernetes field-ownership conflict. The owner completed
the guarded phase repair, and the original-ID resume succeeded in Actions `37142362209`. The normal
`7a66336` release then completed in Actions `37142838447`; its typed API reports `ready` with frozen
targets verified. Newsletter admission is accepting, with zero active work and all 32 historical unknown
outcomes preserved. k3s and the dedicated connector are running; Docker is inactive and disabled.
Fresh Fleet/Home checks confirm the release identities and clear the old deployment/admission alerts.
The classifier release `c0dddd3` completed in Actions `37146439819`; the typed release is ready with
frozen targets verified. Its natural 19:05 UTC observer recorded `BUS/APPARMOR_DENIED` for all four
units, while the main container successfully read the snapshot and submitted its receipt. The exact
official denial prefix is recognized in memory; no private error body is logged or stored. Direct
bounded host observations found all four units active. The owner completed the pinned AppArmor
installation, whose fixed file hash was rechecked. The full green `93b387c` follow-up reached main and
[Actions 37151397315](https://github.com/ziyixi/todofy/actions/runs/37151397315) completed the active VPS deployment.
Request `b663d6a9-30e0-44d4-90fc-13613ecb82d0` reports ready with frozen targets verified; both
actual sources are `93b387c` and generation 9 matches. The natural 20:30 UTC observer reported
`SYSTEMD_COMPLETE`, all four units active, and `OBSERVER_ACCEPTED/READ_OK`. Fresh Fleet/Home
receipts clear all four daemon-unknown alerts. The 32 historical Newsletter unknowns remain unchanged.
No new provider/send or fresh-account recovery claim follows from this acceptance. The temporary
host-admin window is expired; routine typed deployment and bounded metadata diagnosis need no sudo.

Completed at `5837c0c` on `main`: a simple native Mail Hero daily snapshot and actionable
rebuild/transferable-configuration runbooks. The owner explicitly removed added encryption/key-management.
The existing DO Alarm copies D1/schema, business DO control and complete R2 objects to private BACKUP_STORE;
no VPS/k3s collector, new recovery key, encrypted segments or paid product is required. The old collector
is stopped, its data and v1 recovery compatibility retained. Full branch CI
[37159139080](https://github.com/ziyixi/todofy/actions/runs/37159139080) and main
[37159607595](https://github.com/ziyixi/todofy/actions/runs/37159607595) both succeeded;
Mail Hero and Dashboard deploys passed. Other application/VPS releases were correctly skipped.
The real snapshot `b009accd-8697-44c9-8fcb-392e862c7782` reached complete/native_readback_verified at
2026-10-03 23:06:19 UTC: 1,031 files, 37,723,651 bytes, a verified R2 marker, and no pending D1 receipt sync.
The next daily wake is 2026-10-04 04:17 UTC. A fresh Home status refresh cleared backup_stale and left
only the 32 historical Newsletter unknown outcomes. The owner subsequently asked to clear that reminder;
the business ledger remains factual, while the Home-owned disposition described below is being added.
Typed VPS verification remains ready
at `93b387c` with frozen targets and generation matching. No real mail/backup content was printed or
used as a fixture; production proof is bounded status/marker metadata and Home acceptance.
At that release the owner Google Drive checkout stalled reading Git objects: a bounded status check returned
IO wait and only its own process was terminated. Remote main and this independent checkout are current;
the local clone was not fast-forwarded then. The subsequent clean checkout was verified and fast-forwarded during this bootstrap implementation; continue checking for owner/Claude changes before syncing.
Local checks: 204 Worker tests and 81 UI tests passed. Plain offline recovery's 11 new tests passed;
its 40-test combined legacy suite has one local GnuPG skip, with real GnuPG required in Linux CI.
1000 synthetic objects' second backup used 16,621 DO reads, 6,201 SQL writes and 466 Alarm writes;
this includes prior inventory cleanup and same-day rotation, but is not a 10,000-file/full5GiB test.
The snapshot ceiling is 10,000 files/5GiB; account free quotas remain shared. The rebuild docs separately
state today's commands and four P0 follow-ups; no fresh-account/VPS or whole-cloud restore drill was run.
Every app's owner API is on proto now (the dashboard
`ca63675`, FlowDay `8d9100e`, Mail Hero `d1bde0e`, Todofy `b70856f`, all landed and verified on 2026-10-02). Nothing
was in flight at that landing. The foundation evidence below describes that completed release.

## What is live

| App | Worker | Host(s) | Deploy job | Owner API on proto? |
| --- | --- | --- | --- | --- |
| Mail Hero | `mail-hero` (+ `MailCoordinator` DO) | `mail-hero.ziyixi.science` | `Mail Hero deploy` | Yes (`mailhero.ui.v2`; webhook `mail.received.v1`) |
| Todofy | `todofy` (TS gateway) + `todofy-core` (Python) | `todofy.ziyixi.science`, hooks and daily hosts | `Todofy deploy` | Yes (`todofy.ui.v1`; reports `todofy.report.v1`, `task-intent-v1`, `ops-v1`) |
| Links | `links` | `s.ziyixi.science` | `Links deploy` | Yes (`links.ui.v1`) |
| Watch | `watch` (+ `WatchState` DO) | `watch.ziyixi.science` | `Watch deploy` | Yes (`watch.ui.v1`) |
| FlowDay | `flowday` | `flowday.ziyixi.science` | `FlowDay deploy` | Yes (`flowday.ui.v1`) |
| Dashboard | `home` (+ `HomeState` DO) | `home.ziyixi.science` | `Dashboard deploy` | Yes (`dashboard.ui.v1`, since `ca63675`) |
| Fleet | `fleet` (+ `FleetState` DO) | `fleet.ziyixi.science` | `Fleet deploy` | Yes (`fleet.ui.v1`; live receipts and verified runtime) |
| Website | `ziyixi-website` (+ `ziyixi-notion-publish` relay) | `ziyixi.science`, `www.ziyixi.science` | `Website release` | n/a (static) |

Newsletter source was imported on `main` from its deployed engine commit
`c3d622d4771b1ca63ee4e3f785b79032cffc30e1`. Its independent image is `ghcr.io/ziyixi/todofy-newsletter`.
The running Newsletter uses source `4f1306b` and image artifact:
`sha256:47add1811cc06d0616d140d4accd62681375e97e2a049cf6f1c6ba5f1f4baebe`.
The package is public; anonymous manifest access and the manifest/config identity checks passed.
`ghcr.io/ziyixi/newsletter` was the old VPS runtime. It is stopped, with its image and persistent state
preserved. Newsletter runs in k3s and the latest `4f1306b` release is ready; this does not prove an
external business operation. The application reads Todofy's
`/api/summary` and `/api/recommendation` using its existing machine contract. See
`newsletter/docs/import-source.md` and `newsletter/docs/deployment-drain.md` for the import and release boundaries.
The old Slash, changedetection and FlowDay containers are also stopped under the owner's subsequent
instruction to stop every Compose service; retained state remains outside this repository. This includes
the old Mail Hero backup collector: its retained backups remain available, but no new automatic VPS
backup is running. Platform/Newsletter health must not be reported as backup coverage.

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

### Completed: personal-cloud bootstrap and reconciliation

`codex/personal-cloud-bootstrap` starts at `19582c4`. The owner authorised implementation of the
configuration/bootstrap/release/drift-repair plan on 2026-10-04. This phase validates the existing
environment and synthetic empty-environment flows; a real fresh-account/VPS drill and whole-cloud
historical restoration remain separate acceptance work.

Work is split into public deployment configuration, OpenTofu/bootstrap and private initialisation,
typed VPS reconciliation/recovery, and Actions release evidence/operator documentation. Existing
Worker/Wrangler ownership, namespace restrictions, business pause settings and persistent-resource
protections remain enforced. Routine safe repairs may run automatically; Access, credentials,
ownership conflicts and persistent-resource recovery require an explicit operator action.

Implemented: generated deployment profile, private fresh/adopt bootstrap, scoped state imports,
complete secret maps, per-app verified GitHub Deployment records, reusable release recipes, fixed
VPS bundles, typed reconcile transactions and operator guidance. Local checks include 407 CI guards
(one local skip), 229 platform/VPS tests with 197 subtests, 22 Worker-release tests, 104 infrastructure
tests, 34 bootstrap tests and 19 complete-secret-map tests. Synthetic API/official Kubernetes SDK boundaries verify
repair/no-op, stale plans, pause protection and durable-ledger preservation.

Existing-account adoption completed: five exact existing objects were imported into encrypted state;
a subsequent run verified no resource changes and exported the public inventory. Only INFRA_TFVARS
was synchronised; existing application keys were retained. Fresh-create collision checks refuse unknown
same-name resources, with bounded complete pagination. The provider's FlowDay include compatibility
exception retains independent actual-rule validation; see infra/README.md.

The first branch run found a legacy Newsletter tooling test and an incompatible daemon-map rule change;
the test now inspects the reusable release recipe, and optional configured-daemon fields retain the old wire rules.
The actual buf/profile comparison against the base passed. Publishing also derives both image names from
the complete configured repository. Follow-up branch CI 37191723503 passed; the same `adaa835` reached main.
Full release 37192028704, independent Website release 37192071431 and post-release reconcile 37192262241 succeeded.
Fleet confirms both actual digests/source SHA, generation 10, Newsletter 1/1 and all configured daemons running;
Home confirms the new build and retained reminder dismissal. No-drift Worker deployment steps were skipped.
The full follow-up branch CI 37193088127 passed at `4f1306b`, including the real official k3s API fixture.
Its same-SHA main release and fresh Fleet receipts are recorded above. Real SSA restoration, no-write dry-run,
409 ownership conflicts and Secret/PVC object preservation passed; the API-only fixture does not prove mounted data or Pod readiness.
An isolated Cloudflare cron/service-binding drift was detected and restored, then all three owned fixtures were removed.
The optional DNS physical fixture stopped at a read-only preflight 403 before creating any record; its restore proof remains pending.
Routine auto-repair was enabled after successful production checks and clean repairs. No new-account creation,
mail forwarding change, paid upgrade, business-data deletion or fresh-VPS acceptance occurred. See docs/rebuild-verification.md.

### Completed: persistent reminder controls

Live application source is `92b56447c77703fad7e01ee972d08ac7c18cd184`. Full branch
[CI 37167497796](https://github.com/ziyixi/todofy/actions/runs/37167497796) passed; the same SHA
reached main and [release 37167882939](https://github.com/ziyixi/todofy/actions/runs/37167882939)
succeeded. Home and Fleet deployed; other application and VPS releases were correctly skipped.

The owner clarified that the historical Newsletter reminder should be removable. Home now owns
persistent dismiss/restore in its existing SQLite DO, through typed actions with Access/Origin/CSRF,
occurrence/disposition etags and bounded idempotent receipts. Source health, counts and business results
remain factual. Meaningful count/severity changes or confirmed recovery followed by recurrence reopen
an alert; unavailable underlying telemetry does not count as recovery. Full raw explanations are built
before applying dispositions; outgoing reports are filtered before their 20-item cap. Report history
uses its stored snapshot, separate from live attention. Details: dashboard/docs/design-v2.md §11.

Production acceptance on 2026-10-04 UTC: refreshed Fleet's count, dismissed the current 32-record
Newsletter occurrence through Home, then reloaded. Home reports no pending reminders, zero tab badges
and one restorable ignored reminder. Home service/flow labels are neutral; Fleet still shows healthy
process, zero queued/active work and 32 unconfirmed records. Both live UI builds identify `92b5644`.
A 375px browser viewport had no horizontal overflow and exposed the restore button; the viewport was
reset. The natural 01:30 UTC scheduled digest received Todofy's stored receipt with zero items. No
manual report send, business replay, ledger deletion, new credential or VPS update was used.

Local checks: 253 Worker units, 146 Home UI tests, five Fleet UI tests, seven new real DO regressions,
three SQLite capacity/prototype-key cases and 55 relevant existing runtime tests passed. Buf/API lint,
types/lint, schema generation and both CPU suites passed; full platform validation passed in branch CI.
The ordinary read budget is 40 rows; representative stress tests use 64KiB/320 reads. DO cold-start CI
measured 16.57ms, covered by a 20ms regression budget; warm and HTTP budgets remain unchanged.

`codex/k3s-personal-cloud` starts from `450110b`. The owner authorised GitHub-driven k3s reconciliation,
a separate Cloudflare Fleet worker/UI, Newsletter monitoring in Home, and Compose retirement. The owner
subsequently clarified that **all existing Compose services should stop**, rather than migrating unrelated
apps. All 13 inventoried containers are stopped and their automatic restart is disabled; containers,
volumes, private configurations and migration snapshots are retained. Do not restart legacy triggers.

Implemented on `main`: GitHub Actions actively calls the shared-proto daemon API; the daemon applies its own
CI-verified Kustomize resources. Actions holds only narrow HTTPS credentials, with no SSH key or Kubernetes
credential. Newsletter releases drain/freeze before
changing the exclusive stateful process; an observer CronJob using the platform image reports bounded
status to Fleet. Application code and dependencies stay inside images; no host executable is deployed.
Public deployment profiles and a rebuild runbook separate empty resource recreation from historical data
recovery. Initial k3s/systemd setup requires one pinned bootstrap executed by the owner with sudo; routine
reconciliation must need neither SSH nor a GitHub-held host credential. The owner accepted that one-time
step. FastAPI, httpx, the official Kubernetes SDK and Jeepney provide the standard runtime integrations.
No Shiv, standalone application binary, host Python dependency installation or observer systemd timer is
part of the deployment. Loss of k3s scheduling produces stale/missing observations rather than an
independent host diagnosis.

Local platform, image-context, release-client and bootstrap checks passed: 97 tests plus 79 subtests;
all 53 relevant Python files passed lint and format. Profile/infrastructure checks passed 89 tests;
Newsletter's changed drain/monitor behavior passed 45 synthetic tests. A real offline Kustomize/bootstrap
bundle contained ten runtime resources, keeping Newsletter held and the observer enabled. Full branch
and main CI passed at `ca10078`. At that release neither k3s nor Fleet was deployed. The later Fleet
publication is recorded below; VPS and production business acceptance remain pending. Do not claim the
old process supports the new drain API.

First branch run [37092747486](https://github.com/ziyixi/todofy/actions/runs/37092747486) at `b441e46`
passed the actual Linux Platform image build/import/identity smoke and Fleet checks. The complete gate
failed on stale integration expectations (new Ops apps/service bindings/private monitor route), Newsletter
structure/type guards, Infra format and a Lab fixture that aged outside its simulated retry window.
Those narrow fixes passed locally, including Newsletter's complete 2478-test `make check`, before the
next branch SHA. No publisher or production deployment ran from the failed gate.

Second branch run [37093454362](https://github.com/ziyixi/todofy/actions/runs/37093454362) at `d0854a9`
passed all nineteen other check jobs, including the complete Todofy runtime matrix, Proto, Mail Hero,
Newsletter and both real Linux image checks. Only Dashboard's document-consistency assertion failed:
the documented Cloudflare rows budget still said 28 while the actual budget is 30. The table and current
view-budget prose were synchronized without weakening the implementation or assertions; all thirteen
local view tests then passed. Historical measured verification records were retained. No publisher or
production deployment ran from this failed gate either.

Third branch run [37094119254](https://github.com/ziyixi/todofy/actions/runs/37094119254) at `242024b`
stopped in Changes: a temporary Git repository's background maintenance raced strict directory cleanup.
Only those two synthetic repositories now disable automatic GC/maintenance; cleanup stays strict and user
Git configuration is untouched. All 375 root-script tests (one historical skip) passed locally. No image
job ran for this SHA. The Fleet deployment-test glob was also found to admit zero tests on Node 26; actual
deployment boundary tests replace that empty step before the next candidate. All eleven Fleet deployment
boundary tests and 47 cross-config checks passed locally; the CI now names both actual files, and an
explicit missing-file negative control fails. Final bootstrap review also found that its temporary env
injection would disappear on the daemon's first normal apply. Fixed mounted data/auth/config paths now
belong to the canonical Deployment. The real offline Kustomize/bootstrap/daemon-render regression and
first-apply controller regression passed; scoped suites passed 70 Platform, fourteen bootstrap and thirteen
release-client tests. A successful bootstrap now records a root-owned completion marker: exact retries
return `already_initialized` without reapplying admission/CronJob state, different bundles must use the
normal release API, and failure cannot write that marker. Private credential preflight now matches the
actual editor/send/deployment identity requirements. Eighteen installer tests, five platform bootstrap
boundary tests and thirteen release-client tests passed after these final corrections; retained host
paths did not change.

Fourth branch run [37095413618](https://github.com/ziyixi/todofy/actions/runs/37095413618) passed all checks
at `ca10078`; [main run 37095911161](https://github.com/ziyixi/todofy/actions/runs/37095911161) reused that
same green SHA and both tested image artifacts. Platform's Linux job passed 103 tests plus actual
network-disabled Docker imports and source identity checks. Newsletter's Docker job performed a
no-login Codex startup and offline configuration validation. The public Platform image is
`ghcr.io/ziyixi/todofy-platform@sha256:ed5bb253b3d94f2f3f62c2ca1abe595e2a8d5c2a1f45e132c7805092e3359d98`.
Anonymous reads verified both published manifest digests and their tested image configuration identities.
Fleet/Home remained deliberately frozen; VPS deploy remains disabled until bootstrap and machine access
are ready. Image publication is not a live deployment test.

Managed infrastructure is partially created. The reviewed initial plan contained nine creates and nineteen
no-ops, with no update/delete/replace. [Apply 37096080218](https://github.com/ziyixi/todofy/actions/runs/37096080218)
verified the encrypted state backup before applying, then failed with a generic provider HTTP headline.
[Read-only drift 37096329221](https://github.com/ziyixi/todofy/actions/runs/37096329221) confirmed all six new
Access objects persisted; only the dedicated Tunnel, its configuration and its DNS record remained
three creates, with twenty-five no-ops. [Controlled retry 37096566266](https://github.com/ziyixi/todofy/actions/runs/37096566266)
failed with the same insufficient diagnostic. Stop blind retries: the current branch adds bounded
OpenTofu JSON diagnostics containing only managed resource aliases, HTTP status and numeric API codes.
No permission failure is confirmed, and the old private logs were deleted normally. A fresh drift and
reviewed fingerprint must precede the next diagnostic apply. Strict read-only lookups verified the newly
created Fleet owner/receipt identities for the pending activation configuration.

Pending branch corrections are implemented: explicit resume reuses the daemon's frozen images, never
rebuilds/publishes replacements, and accepts only the original held source SHA when `main` has advanced.
Current code is checked independently; the original etag/targets remain mandatory throughout physical
verification. The daemon's immutable release ledger and proto are unchanged. All 379 root-script checks
passed (one historical skip), seventeen synthetic HTTP client tests passed, and lint/format/diff checks
passed. Fleet's verified Access configuration and activation guards passed 220 related checks. Safe
apply diagnostics passed ninety Infra checks and forty-four root Infra guards, with zero new legacy lint
violations. No synthetic test proves a live Tunnel, bootstrap or successful application rollout.

Final first-install review corrected two boundary failures before production: the Tunnel unit now uses
cloudflared's standard connected notification, and a failed startup cannot write the completion marker.
The ConfigSync Deployment initializes a truly empty volume with its existing packaged seed using the
same Newsletter image; retained configurations are strictly validated without changed bytes/timestamps,
and corrupt or partly initialized directories fail rather than being overwritten. Both renderers pin the
init container to the same reviewed digest and profile. Seventy-nine Newsletter configuration tests,
sixty-three deployment tests plus forty-nine subtests, scoped lint/format, Mypy and structure guards passed.
The first API release must keep the bootstrap source SHA; do not enable normal VPS deployment or advance
that first-release commit until its held admission is verified and activated.
The rendered daily trigger now passes the real Newsletter CLI's check-only configuration contract,
with an independent socket-denial guard; its explicit internal-HTTP switch is `1`, not `true`.
The Kubernetes cadence retains the old public configuration's 07:00 America/Los_Angeles schedule.
The optional GitHub preparation workflow has not been connected to this private k3s Service; the daemon
Tunnel does not proxy its `/v1/runs` route. Do not assume an old public URL remains usable.

The next full branch run [37098884977](https://github.com/ziyixi/todofy/actions/runs/37098884977) at `0b381c0`
passed the other checks and both real Linux image jobs, but Mail Hero's unchanged delivery CPU test
failed twice: SendMessage warm medians were 3.53 and 3.52 reference ms against the 3.5 bound. Calibration
did not report a busy runner. No publisher or deployment ran. The branch now reuses one current
non-extractable WebCrypto HMAC key instead of repeatedly deriving it in the same request. Rotation,
invalid configuration and failed derivation are covered; the existing derivation parameters, signatures,
frozen payloads and CPU budgets are unchanged. A valid local delivery CPU run measured 2.60 ms warm
for SendMessage and 2.54 ms for ResendDelivery. The full seven-test CPU suite then passed, including
delivery, owner routes, Ops and payload construction; SendMessage measured 3.80 ms first and 2.31 ms
warm against the unchanged 6/3.5 bounds. All 190 Worker tests, type checks and 91 consumer contract
tests passed locally; these results still require a complete green branch CI before landing.

The follow-up [37100229358](https://github.com/ziyixi/todofy/actions/runs/37100229358) at `e8e2ba3` passed
every other check and both Linux image jobs; delivery SendMessage measured 3.56 ms warm and again failed
the old 3.5 ms goal. The delivery benchmark now guards meaningful regressions with warm below 5 ms,
first below 6 ms, against Free's 10 ms request limit. It keeps the calibrated multi-isolate measurement
and large-record coverage; hundredths of a millisecond near a self-imposed target are not a release blocker.
The action ledger also uses D1's standard transaction batch for its unchanged reservation and read,
reducing one database call. Actual workerd regressions cover rollback, retry, concurrent deduplication,
conflicts and owner isolation; all 191 Worker tests, type checks and 91 consumer contract tests passed.
An inspector timeout exposed a separate test bookkeeping bug: discarded isolates retained coordinator
samples and shifted their calibration pairing. The tests now pair samples with completed measured runs,
check each run's complete sample count and keep the coordinator's maximum bound. Four recovery/negative
controls passed; a single final full CPU run passed all seven real CPU cases and those four recovery
checks. SendMessage measured 4.52 ms first and 2.87 ms warm; coordinator maxima remained below 16 ms
against the unchanged 1000 ms bound. The shared meter is unchanged.

The final branch [37101662598](https://github.com/ziyixi/todofy/actions/runs/37101662598) passed all 22
checks at `95614de`. Main [37102132805](https://github.com/ziyixi/todofy/actions/runs/37102132805) reused
those exact-SHA checks and published both original Linux-tested image artifacts; Mail Hero, Fleet and
Home deploy jobs passed. Fleet's deployed source SHA and the unauthenticated Fleet/Home Access probes
passed. Fleet's actual namespace was read from that verified deployment and recorded in the public
resource inventory; its generated Home identity and eight cloud-config tests passed. This does not
prove owner UI behavior or live VPS telemetry. Mail Hero has no additional live-version probe in this
release. VPS deployment remains disabled and was skipped.

Anonymous registry manifest/config checks independently matched both image digests, their CI-tested
image IDs and the exact source SHA. Platform published
`sha256:f4b026388208d4289fa0a8e05dc54b049f72f3e468626d3466db9f4a8b4f9aa3`.
These checks did not pull all layers or run the images on the VPS.

The read-only [37102132807](https://github.com/ziyixi/todofy/actions/runs/37102132807) retained exactly
three creates, twenty-five no-ops and one output change; its nonzero exit signals planned drift.
Controlled apply [37102749784](https://github.com/ziyixi/todofy/actions/runs/37102749784) passed its saved
plan gates, then returned HTTP 403 / Cloudflare code 10000 for the dedicated Tunnel. The owner was asked
to restore the regular dashboard login and add only the missing Tunnel write permission to the existing
deployment token, preserving all previous permissions. Do not retry until that barrier is resolved;
then recheck the exact plan before applying. No secret or raw provider response was logged.

The real VPS still has cloudflared `2024.8.3`, which cannot read `--token-file`. The bootstrap now pins
official cloudflared `2026.8.2` and its linux/amd64 checksum alongside k3s, using the existing standard-library
download pattern. Its separate project connector leaves the global binary and existing SSH services alone;
fresh hosts no longer need a separate cloudflared installation. Download and verification precede state
migration and Docker retirement. The public installer bundle includes this shared binary helper and its
hash; application dependencies still live only in images. Thirty-four synthetic bootstrap tests and five
platform bootstrap boundary tests passed, plus scoped lint/format. This fix awaits its branch gate; no
new connector binary, system service or k3s runtime has been installed on the VPS.

The namespace inventory and connector fix passed branch [37103481732](https://github.com/ziyixi/todofy/actions/runs/37103481732)
at `54861b2`; main [37103957207](https://github.com/ziyixi/todofy/actions/runs/37103957207) promoted its original
tested image artifacts. After the owner approved only the missing Tunnel and scoped DNS permissions,
[apply 37106269391](https://github.com/ziyixi/todofy/actions/runs/37106269391) created the three remaining
transport resources and its post-apply plan was unchanged. Its encrypted one-time handoff was privately
staged; the owner executed the exact public bootstrap. Read-only host checks confirm k3s and the
dedicated connector are running and the old Docker runtime is inactive. The authenticated typed daemon
API and Fleet's signed receipt path are reachable; no API release ledger exists yet. These facts do not
prove successful release activation, provider operations or backup coverage.

The pinned Kubernetes SDK 36 exposed two integration bugs hidden by the older call_api mock:
it resolves the Bearer prefix by `BearerToken`, and accepts `response_types_map` rather than `response_type`.
The narrow client fix uses the canonical identity key with its existing rotation hook and maps successful
200/201 replies to objects. Real SDK tests replace only the final HTTP transport and verify outgoing
authentication, rotation, physical field casing and creation response parsing. Six scoped tests and three
subtests passed, plus lint/format. The installed image still contains the old client; a new source SHA must
receive its own tested immutable image, without republishing different bytes under `54861b2`.

The owner completed in-Pod diagnosis: the old client omitted the Bearer prefix and Kubernetes returned
401. [Branch CI 37107689599](https://github.com/ziyixi/todofy/actions/runs/37107689599) passed at `27bfca2`,
including 125 Platform checks and the real Linux image; that intermediate artifact is not deployed.
The new candidate adds a bounded privileged recovery of the unavailable daemon, optional namespace-only
diagnosis without sudo, and the owner's approved historical-unknown policy. Actual local work must stop
before replacement; every unknown record remains intact and visible, with no automatic replay.
See [bootstrap recovery](tools/vps-bootstrap/README.md#initial-client-repair).
Local validation passed 169 Platform/build/release/bootstrap tests plus 155 subtests, and 46 Newsletter
drain tests. The latter execute the real Store/exclusive-lock repair entry point on synthetic SQLite.
All 64 Platform/tool Python files and the changed Newsletter files passed lint/format. The exact candidate
passed [branch 37110131910](https://github.com/ziyixi/todofy/actions/runs/37110131910) at `c703378`, including
the real Linux image checks. [Main 37110576394](https://github.com/ziyixi/todofy/actions/runs/37110576394)
promoted those artifacts; its second attempt enabled the first normal CreateRelease after the owner's
completed repair. VPS deploy passed. Typed API and namespace metadata agree on ready/activated, actual
source/digests/request identity, and accepting Newsletter admission with zero active work and all 32
unknown outcomes retained. The Platform digest is
`sha256:4fdfdb874bd717f8c2447692230ffa540dde39a6b93592b2406e43183f851441`.
Optional namespace metadata diagnosis now works without sudo and rejects Secret/exec/write access.
No real model/provider/send or backup acceptance has been claimed.

The earlier systemd diagnostic failed before method calls: the UID10001 container's system-bus connection
closed, and that UID was not registered on the host. A fixed non-root diagnostic reproduced it. The
`0f84d91` candidate introduced a standard same-image init container as the host's existing UID65534 (`nobody`),
retains the non-mutating polkit denial checks, and writes only a bounded shared-proto daemon snapshot
to an emptyDir. The main observer keeps its existing UID, durable state and receipt identity. The init
receives no projected Kubernetes identity or application secret. Both images are pinned to the same
tested digest. The subsequent `7a66336` release completed and fresh Fleet/Home receipts were verified,
but system-daemon still reports `unknown`. A separate bounded diagnostic is pending; live daemon-state
acceptance has not passed. An unreadable probe must still report unknown, never assume health.
Local validation passed 178 Platform/build/release/bootstrap checks and 166 subtests, including actual
shared-codec snapshot bounds/freshness and offline Kustomize identity/permission checks. All 67 relevant
Python files passed lint/format; proto lint, API lint, schema checks and breaking checks passed. The
Linux image gate also exercises the probe CLI as UID65534 without capabilities, network, credentials or
a host bus; that smoke only proves the image and unknown-state path, not live D-Bus authorization.

[Branch 37113613969](https://github.com/ziyixi/todofy/actions/runs/37113613969) passed the complete gate
at `0f84d91`, including the real Linux probe smoke. [Main 37113997517](https://github.com/ziyixi/todofy/actions/runs/37113997517)
published its images and Cloudflare Workers; VPS deploy held after daemon replacement. A same-ID resume
in [37114292742](https://github.com/ziyixi/todofy/actions/runs/37114292742) also held. Metadata confirms
that merge-patch activation transferred release `phase` to an Update manager, so the next manifest Apply
conflicted while changing it back to `applying`. The owner completed the guarded phase-only recovery of
the two release ConfigMaps. The explicit original-ID resume in
[37142362209](https://github.com/ziyixi/todofy/actions/runs/37142362209) then succeeded; the frozen release
targets and identity were retained. The Platform digest at the earlier held checkpoint was
`sha256:150f970d33b337ef9021191322fa5d9f9c794768d31d59ce87576f2bd6124482`.

The branch's permanent fix at `0adfb34` passed [CI gate 37115872382](https://github.com/ziyixi/todofy/actions/runs/37115872382).
It separates manifest ownership from the narrowly scoped phase/suspend
workflow; see [deployment ownership](platform/src/personal_cloud/deployment/README.md).
The accompanying Fleet correction keeps the historical unknown-outcome warning while requiring actual
process, admission, Pod and release identity evidence for readiness. Those historical business outcomes
alone must not produce a process failure or pending-release alert. After the original-ID resume, the normal
`7a66336` release completed in [37142838447](https://github.com/ziyixi/todofy/actions/runs/37142838447).
The typed API reports `ready` and `frozen_targets_verified=true`; both workloads have generation 6 and
request `9b00f775-b0df-4147-8660-33e50fc126f1`. Actual Newsletter and Platform sources are `7a66336`.
Platform's actual image is
`sha256:15d6c8ad7f60f1bd1ca310ae3662721846754aae0dfbd39cfb59bc6c5e8bc60a`;
Newsletter's actual image at that release was
`sha256:0a12974b38ef5a3f35c4f38aec0f2366efe5d37250e38bdb9e60b34e25163afc`.
A fresh Fleet receipt at 18:15 UTC matched actual/desired
source, digests and request identity and recorded `resolved_deployment_pending`. Both ConfigMap phases
are `activated`; their only phase manager is `personal-cloud-runtime-status`, while the base
`personal-cloud` manager does not own phase. `newsletter-daily` and the observer both have `suspend=false`.
At 18:19 UTC, a normal Home refresh changed Newsletter from failure to attention: only
`newsletter_unknown` remains for the 32 historical outcomes; `newsletter_unavailable`,
`deployment_pending` and paused alerts cleared. Todofy reports normal; Notion writing remains unconnected.
System-daemon remains `unknown`, so its diagnostic and live acceptance are still pending. These checks
do not prove a real provider/send operation or backup coverage.

The next bounded diagnostic uses Kubernetes' standard termination file in the existing observer image.
Init records only fixed unit aliases, states, stages and safe error codes; the main observer records
snapshot-read status. Both containers use `terminationMessagePolicy: File`, with no log fallback.
Messages are at most 1 KiB and cannot contain exception text, D-Bus bodies, credentials or configuration.
The existing namespace reader can inspect this Pod metadata without exec/log access or new host privileges.
Unknown states and the non-mutating polkit authorization guard remain unchanged. Gate and publish this
candidate normally, inspect a naturally scheduled observer's bounded metadata, then verify fresh Fleet/Home
receipts. A successful init or accepted receipt alone does not prove the system daemons were observed.
Local validation of the diagnostic candidate passed all 192 Platform/build/release/bootstrap tests
and 186 subtests;
all 69 relevant Python files passed lint/format. Wire fixtures exercise the actual Jeepney serializer,
private response/error text is excluded, snapshot expiry remains unknown, and termination output is bounded.
Branch [37144434050](https://github.com/ziyixi/todofy/actions/runs/37144434050) and main
[37144825529](https://github.com/ziyixi/todofy/actions/runs/37144825529) succeeded. The typed release is
ready with frozen targets verified; both workloads use request `994e94db-f8f7-41ee-b2fe-177fc34e2089`
and source `c2f0d09`. Platform's actual digest is
`sha256:c3f1d49825c171a88eff72f6676ab051a68160945b066d9c2026e3c20ac0e1f8`.
The 18:40 UTC natural observer matched that image: each init unit returned unknown with
`BUS/DBUS_DENIED`, while the main container returned `OBSERVER_ACCEPTED/READ_OK`.
This rules out snapshot transfer/freshness as the current cause and does not yet confirm the specific
connection policy. The new fixed-prefix classifier must be verified before applying a host policy fix.
The classifier's local suite passed 193 tests and 190 subtests, with lint/format passing. Its fixtures
decode actual Jeepney Hello errors, require the exact known error name and prefix, and keep arbitrary
responses mapped to the existing safe enums without printing their bodies.
Classifier branch [37146094974](https://github.com/ziyixi/todofy/actions/runs/37146094974) and main
[37146439819](https://github.com/ziyixi/todofy/actions/runs/37146439819) succeeded. Request
`264188c8-4238-45a6-bffb-62f0d548c6ad` is ready with both actual sources `c0dddd3` and frozen targets
verified. Platform's actual digest is
`sha256:f359484b0623448faac58a8d8f2ccdeb4457d4be321ada870b2776d49b0e5f76`.
The natural 19:05 UTC observer used that image and reported `BUS/APPARMOR_DENIED` for each unit,
with `OBSERVER_ACCEPTED/READ_OK` from its main container. AppArmor is therefore the confirmed
connection blocker. The candidate preserves the pinned containerd baseline, adds seven fixed D-Bus
send rules and selects the profile only for the credential-free init container. A profile-only CLI
checks fixed bytes, supported host and safe paths, dry-compiles before writing one root-owned file,
loads only that profile and verifies exact enforce mode. Fresh VPS bootstrap includes the same step.
Local candidate validation passed 200 tests and 192 subtests; 71 Python files passed lint/format.
Actual Linux parser compilation, host load, successful Polkit guard and fresh daemon states remain
separate checks; do not replace unknown with healthy or bypass confinement to finish the release.
The complete `4a2b725` branch [37147403600](https://github.com/ziyixi/todofy/actions/runs/37147403600)
passed its gate, including real Ubuntu parser compilation, all reached application checks and both image checks.
The staged six-file public installer also passed exact hashes and the existing VPS parser with
`--skip-kernel-load --skip-cache`; kernel loading remains pending. Final independent rebuild review
found that the fixed daemon list assumes the old global `cloudflared.service`, which a fresh VPS without
an SSH Tunnel will not have. This report/runbook caveat is separate from the existing-node repair;
do not create an unused host service to silence it or claim the monitoring contract is already configurable.
Local candidate validation passed 182 Platform/build/release/bootstrap tests plus 178 subtests,
45 Fleet unit tests and eight real workerd SQLite tests. Fleet type checks and lint passed; all 71
relevant Python files passed lint/format. The two-release ownership test uses the real SDK transport
with a synthetic field-manager model; it is not production Kubernetes acceptance.
The rebuild follow-up propagates the configured node alias to Fleet without changing epochs and documents
observer-state recovery, the supported two-workload profile, actual Compose retirement, and the existing
sealed bootstrap handoff. Nine cloud-config tests passed; all thirteen current-profile generated outputs
remain unchanged. Profile/catalog checks and a synthetic certificate/CMS roundtrip also passed. The new
configuration-only recovery instructions still need an empty-account/VPS exercise; no such live drill was run.

The 2026-10-03 [rebuild audit](docs/rebuild-audit.md) reviews all eleven applications, deployment identities,
infra adoption and VPS/state boundaries. A strictly configuration-only fresh-account rebuild is not yet
supported: Watch and the relay acceptance check retain account-specific workers.dev references; normal
infra apply and import-only bootstrap do not form an empty-account creator; hostname/inventory coverage and
historical recovery have listed gaps. The report proposes bounded follow-ups without implementing a new
provisioner or moving accounts/data. The runbook now states those limits, preserves creation-time machine
secrets, documents Tunnel's outbound 7844 requirement and directs Newsletter to the current k3s flow.
Profile/catalog/drift checks remain current; nine profile tests, two migration-reference tests and a check
of 113 relative document links passed. The owner phase repair, original-ID resume and normal second
production release are now complete, with fresh Fleet/Home acceptance as recorded above. System-daemon
acceptance subsequently passed at `93b387c`, as recorded at the top of this handoff. No new-account/VPS rebuild or historical
recovery drill was performed, and no new automatic VPS backup is running.

## Foundation completed (historical release evidence)

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
  Todofy. Left: the next Newsletter run after the k3s release is verified and activated (configured daily
  at 07:00 America/Los_Angeles, reading `/api/summary` and `/api/recommendation`); remove
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
- Infra drift's foundation baseline was `no-op 19` (2026-10-02). The k3s/Fleet extension contains 28 managed
  objects; the current partial apply reads three creates and twenty-five no-ops. After its remaining
  transport objects are created and verified, the new expected steady state is `no-op 28`. Daily drift
  runs at 13:23 UTC, but GitHub may start it hours late.
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
- The pages to watch for W4 (added by the owner at watch.ziyixi.science/new, or named to an agent privately).
- Real Newsletter model/provider/send acceptance remains distinct from the verified deployment;
  historical unknown outcomes require deliberate reconciliation, not automatic replay.
- Historical whole-cloud recovery and external provider acceptance remain distinct from running backups.

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
- The owner approved upgrading past the 32 historical Newsletter unknown outcomes. Preserve every
  record, do not retry or mark success, wait for actual local work to stop, and retain dashboard alerts.
- Agents keep going without asking for step approvals on these personal projects, as long as everything stays
  recoverable; anything touching the owner's mail, VPS writes or secrets still needs the owner.
