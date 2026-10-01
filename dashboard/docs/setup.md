# Home dashboard: setup and operations

How the Worker `home` is configured, deployed, rotated and rolled back. The design is
[`design.md`](design.md), the limits [`limits.md`](limits.md), and what has been verified
[`verification.md`](verification.md). No step here reads mail content or needs a secret in a chat or a
log: secrets are entered only in GitHub's or Cloudflare's own settings pages.

## 1. Resources

| Resource | Name / value | Created by |
| --- | --- | --- |
| Worker | `home` (`dashboard/wrangler.toml`, the committed production config), `workers_dev = false`, `preview_urls = false` | the `Dashboard deploy` job |
| Custom Domain | `home.ziyixi.science` (`routes = [{pattern, custom_domain: true}]`) | the deploy (DNS record and certificate) |
| Durable Object | class `HomeState`, SQLite-backed (migration `v1`, `new_sqlite_classes`), one instance named `home-v1` | the deploy |
| Service bindings | `MAIL_HERO` → Worker `mail-hero`, entrypoint `Ops`; `TODOFY` → Worker `todofy`, entrypoint `Ops` | the deploy; both Workers must already export `Ops` (contracts/ops-v1) |
| Static assets | `web/dist`, binding `ASSETS`, `run_worker_first = true` | built in the job |
| Cron Trigger | `*/30 * * * *` (the account's second of 5 Free triggers) | the deploy |
| Access application | "Home", self-hosted, `home.ziyixi.science` | the owner, once (§2); already exists |

There is no D1 database, R2 bucket, KV namespace or queue. The dashboard's state (latest statuses,
usage snapshot, guard decision, canary runs of the last 60 days, digest state) lives in the Durable
Object's SQLite storage. Release order: Todofy with its canary consumer, then Mail Hero with `Ops`,
then the dashboard (contracts/ops-v1 `IMPLEMENTATION.md` §0); CI enforces that the dashboard deploys
after both app deploy jobs in the same run.

## 2. Cloudflare Access ("Home")

Zero Trust → Access → Applications → Self-hosted application "Home" for `home.ziyixi.science` (the
whole host, every path), with the same owner policies and identity providers as Todofy's application:
allow only the owner's exact e-mail addresses on the matching identity providers.

- The application's AUD tag (64 hex) is `ACCESS_AUDIENCE` and the team domain
  `https://<team>.cloudflareaccess.com` is `ACCESS_ISSUER`, both committed in `dashboard/wrangler.toml`.
- The Worker verifies the Access JWT itself (`packages/edge-auth`, Todofy's parameters with a 10 min key
  cache, SPEC §5.4) and accepts only `ACCESS_OWNER` or an address in `ACCESS_OWNER_ALIASES` (≤ 8,
  printable ASCII, compared case-insensitively over ASCII). Put every login the Access policy allows
  for the owner there; any other Access-authenticated user gets 401.
- `/health` is exempt from the Worker's own check but still behind Access (the whole host is).
- Never add an Access bypass or a second hostname: the deploy's probe fails when anything but Access
  answers an unauthenticated request. It accepts only a 302 to Access's login page for this host
  (`https://<team>.cloudflareaccess.com/cdn-cgi/access/login/home.ziyixi.science…`); any other redirect
  fails it, including one to the team domain itself.
- No zone Redirect Rule or Page Rule may match `home.ziyixi.science` (for example the App Launcher
  redirect suggested in `todofy/docs/ui-and-portal-research.md`): such rules run before Access and the
  Worker and would make the dashboard unreachable. Check the zone's Rules pages (read only) before the
  first merge; the probe would now fail on such a rule, but only after the deploy.

## 3. GitHub `production` environment

The Worker's production config is the committed `dashboard/wrangler.toml` (top level = production, no
`[env.*]`, no `keep_vars`; the repository is public, so nothing personal or secret goes there): account ID
(also the var `ACCOUNT_ID`, the GraphQL `accountTag`), the route and `PUBLIC_HOST` (CSRF origin, digest
link; different from both app hosts, and the registry's app links, `worker/src/registry.ts`, must match
the apps' hosts: `.github/scripts/test_wrangler_configs.py`), `ACCESS_ISSUER`, `ACCESS_AUDIENCE` and
`CANARY_UTC_HOUR` (0–23, 16). Changing one is a commit to that file.

The `Dashboard deploy` job uses the existing `production` environment (deployment branch `main`).
`deploy/deploy-vars.mjs` adds only what is never committed, validating every value and naming a failing
setting without printing its value (a deploy without a var deletes it, so a missing one fails the job):

| Name | Kind | Rule | Becomes |
| --- | --- | --- | --- |
| `DASHBOARD_CANARY_ENABLED` | variable | exactly `true` or `false`; unset, empty or any other value (`False`, `0`, `no`, a stray space) fails the deploy, so a deleted variable never turns stopped canaries back on | `--var CANARY_ENABLED` (§6, §7) |
| `DASHBOARD_ACCESS_OWNER` | secret | printable-ASCII e-mail | Worker secret `ACCESS_OWNER`; `Lab deploy`, `FlowDay deploy` and `Links deploy` read it too (same owner, `lab/README.md` "Deploy secrets", `flowday/README.md` "Deploy", `links/README.md` "Deploy") |
| `DASHBOARD_ACCESS_OWNER_ALIASES` | secret, may be empty | ≤ 8 unique printable-ASCII e-mails, ≤ 2048 chars | Worker secret `ACCESS_OWNER_ALIASES` (a single space when empty, so an emptied list replaces the old one); `Lab deploy`, `FlowDay deploy` and `Links deploy` read it too |
| `DASHBOARD_CSRF_SIGNING_KEY` | secret | 64 hex (for example `openssl rand -hex 32`, run locally) | Worker secret `CSRF_SIGNING_KEY` |
| `DASHBOARD_CF_ANALYTICS_TOKEN` | secret | `[A-Za-z0-9_-]{20,200}` | Worker secret `CF_ANALYTICS_TOKEN` (§4) |
| `CF_API_TOKEN` | secret (existing, Todofy's deploy token) | – | `CLOUDFLARE_API_TOKEN` for the read-only hostname guard (`tools/cf-guard`) and `wrangler deploy` only; the secrets step also receives it, only to warn when `DASHBOARD_CF_ANALYTICS_TOKEN` equals it (never written anywhere) |

The secrets go to `$RUNNER_TEMP` (mode 0600) for `wrangler deploy --secrets-file` and are removed at the
end. `GITHUB_SHA` becomes `--var BUILD_SHA` (shown by `/health`). Changing a variable or secret takes
effect with the next deploy: run the workflow on `main` with `app: dashboard` (or `all`). The two owner
secrets also feed Lab, FlowDay and the links app, and each Worker takes a change only with its own deploy: after
changing `DASHBOARD_ACCESS_OWNER` or `DASHBOARD_ACCESS_OWNER_ALIASES` (for example removing an alias), run
`app: all`, or `dashboard`, `lab`, `flowday` and `links`; until then the others keep accepting the old addresses.

## 4. The analytics token (`CF_ANALYTICS_TOKEN`)

The Worker uses this token only as `Authorization: Bearer` to `https://api.cloudflare.com/client/v4`, for
two read-only purposes (both URLs are constants, not configuration):

- the usage query: `POST .../graphql` (`worker/src/usage.ts`), at most once per tick and once per
  minute on an owner refresh;
- the daily configuration drift check (`worker/src/drift.ts`, [`design-v2.md`](design-v2.md) §10):
  `GET` on the account's Worker scripts and Custom Domains, the zone's Worker routes, and each Worker's
  schedules, settings and subdomain flags, at most 12 calls per tick on about three ticks a day. Only
  binding names and types are kept from the settings; values are dropped while parsing.

It is never logged, stored, echoed to the page or sent anywhere else, and unit tests check that it
appears only in the authorization header of those requests.

**Today a broader token is reused.** A token for this secret becomes a Worker secret of an
internet-facing Worker, so it must be able to do no more than read analytics: any future bug in the
Worker would otherwise expose account write access. The owner allowed reusing the deploy token until a
read-only token is saved (2026-09-30), so when `DASHBOARD_CF_ANALYTICS_TOKEN` equals the deploy token
`CF_API_TOKEN` `deploy-vars.mjs` only adds a "Broad analytics token" warning to the run (by name, without a
value); it cannot check the scope of any other token. Replace it with a token that can only read
analytics:

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token.
2. Permissions: **Account → Account Analytics → Read** (the permission the GraphQL API needs for
   account-level datasets, [docs](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)),
   **Account → Workers Scripts → Read** and **Zone → Workers Routes → Read** (this zone only) for the
   drift check. Nothing else: no Edit permission.
3. Account resources: include only this account. Optionally restrict client IPs (not practical for
   Workers egress) and set an expiry you will remember to renew.
4. Save the token value directly into the GitHub secret `DASHBOARD_CF_ANALYTICS_TOKEN` (production
   environment). Do not paste it anywhere else.
5. Run the workflow on `main` with `app: dashboard`. The deploy uploads the new secret.
6. Open the dashboard, press 刷新 (refresh, at most once a minute), and check that the quota section
   shows fresh data (no "用量数据获取失败" item). The next day after 02:00 UTC, check that 配置漂移 on
   the Cloudflare view shows a completed check (not 检查失败 with HTTP 403). Record the dates in
   `verification.md`.
7. Only then stop using the broader token for this purpose. Do not revoke it if it is still used
   elsewhere (for example as a deploy token).

If the token lacks a drift permission, 配置漂移 shows 检查失败 and the digest reports
`drift_unavailable` after two failed days; usage is unaffected. If the token fails (revoked, expired,
wrong permission), the page and the digest show `usage_unavailable` after 2 h; the guard then never enters `shed` on its own (no fresh usage means no
automatic shed) and an automatic shed already in place lapses at its `until`. Rotation is the same
procedure with a new token.

## 5. Local development

```sh
cd dashboard/worker && npm ci
cd ../web && npm ci && npm run build            # web/dist, served by the Worker
cp ../.dev.vars.example ../.dev.vars           # local values, gitignored; edit the CSRF key
cd ../worker && npm run dev                      # http://127.0.0.1:8787, local bindings only, never --remote
```

`dashboard/wrangler.toml` is production, so local work always uses local bindings, and the local values
come from the untracked `dashboard/.dev.vars` next to it (wrangler reads the `.dev.vars` beside the
config), with synthetic values only: the local `PUBLIC_HOST`, `BUILD_SHA`, `CANARY_ENABLED`,
`DEV_AUTH_BYPASS=true`, `ACCESS_OWNER=owner@example.com` and a locally generated 64-hex
`CSRF_SIGNING_KEY` ([`.dev.vars.example`](../.dev.vars.example)). The bypass works only for
`http://localhost`, `127.0.0.1` or `[::1]` requests without `cf-ray`; anywhere else an enabled bypass
answers 503. `npm run dev` (`worker/package.json`) pins the local origin with `--ip 127.0.0.1 --port 8787
--local-upstream 127.0.0.1:8787`: wrangler dev otherwise takes the config's first route as every local
request's URL, so the Worker would see `https://home.ziyixi.science` and refuse the bypass (503
`access_not_configured`). Change `--port` and `--local-upstream` together, and never run a bare
`wrangler dev` of this config; `web/`'s Vite proxy sends that origin as `Origin`. The production config never holds `DEV_AUTH_BYPASS` (tests check it). Without the two app Workers running locally, their tiles show ◆ 未知 · 无法连接
after the first poll and ■ 故障 from the second, and without a `CF_ANALYTICS_TOKEN` the Cloudflare view
has no usage and no Worker rows; both are the expected state. The registry's website probe is the only
public request a tick makes (one `GET https://www.ziyixi.science/build-info.json`, status and latency
only); set that entry's `enabled: false` in `worker/src/registry.ts` (uncommitted) to avoid it. Use
synthetic data only; never point a local run at production resources.

For an end-to-end check of the UI against the real Worker without any account, run the Worker in
Miniflare the way `worker/test/runtime/harness.ts` does (bundle `src/index.ts`, stub `mail-hero` and
`todofy` Workers from `test/stubs/ops-stub.js` with the contract fixtures, an `outboundService` that
answers the GraphQL endpoint with `test/graphql-fixture.ts` and the probe URL with a 200) but with
`ASSETS` serving `web/dist` and `DEV_AUTH_BYPASS=true`, then open `http://127.0.0.1:<port>/` in a
browser. [`verification.md`](verification.md) §1d records such a run.

## 6. Operations

- **Guard.** Automatic: any daily resource or monthly R2 operation class ≥ 80 % → `shed` on both apps
  until the next UTC midnight + 60 min, renewed while still ≥ 70 % that day; cleared below 70 % or on a
  new UTC day. From the page: 强制降载 (force shed for 24 h) or 解除降载 (clear, and hold automatic shed
  off until 00:00 UTC). `shed` only defers each app's deferrable cleanup and safety-net jobs within
  their own bounds (Mail Hero: raw reconcile, retention, canary and alert-history cleanup, each at most
  48 h; Todofy: starting a new weekly backup unless the last one is older than 7.5 days, retention,
  metrics rollup, at most 72 h); intake, parsing, delivery, retries, a backup already running and
  real-mail processing continue. A `shed` guard expires by itself (at most 36 h ahead), so a stopped
  dashboard cannot leave an app shed.
- **Canary.** Daily at the first tick at or after `CANARY_UTC_HOUR` (UTC), plus up to 3 manual runs a
  UTC day (立即运行金丝雀). Mail Hero creates one synthetic `mail.received.v1` event with the `canary`
  marker directly (no Email Routing, raw storage or parsing) and delivers it to Todofy; Todofy
  summarizes it through the normal path (one Gemini call, up to 3 when a transient failure is retried,
  counted in the Gemini budget) and records the result, never a Todoist task, list entry or reminder.
  A skipped run (sending paused, no endpoint, maintenance, a missing capability) is reported in the
  digest as `canary_skipped` with its reason.
- **Canary switch** (`DASHBOARD_CANARY_ENABLED`, `true` or `false`; required). With `false` the dashboard starts no
  canary: the scheduled run is not created, 立即运行金丝雀 is disabled with
  "金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）", and `POST /api/v2/canary` answers 409
  `canary_disabled` with the same message. A run already queued is still polled every 30 minutes until
  it ends (at most 2 h after queuing), so its verdict is recorded; a run not yet queued (Mail Hero
  answered paused/unavailable, or the call failed) gets no further start attempt and ends at the next
  tick as skipped at the start stage with code `canary_disabled` (no digest item for it). While off, the page shows
  an info item "金丝雀已关闭" in the banner and a note in the canary section; it never raises the level,
  it is not a digest item and it never reaches Todofy (the digest carries warning and critical items
  only, contracts/ops-v1). No item is raised for the days without a run. The digest still reports the
  latest finished run as before (a failure or skip stays listed until a later run finishes, which needs
  the switch back on). To change it: set the variable in the GitHub `production` environment and run the
  workflow on `main` with `app: dashboard`; a change takes effect with that deploy, not before.
  Switching back to `true` starts the day's scheduled run at the next tick if the hour has passed and
  none ran that UTC day.
- **Digest.** Warning and critical items go to `TODOFY.reportOps` when the set changes or every 6 h
  (not during 00:00–00:20 UTC while the last report is from the previous day, so that day's reminder
  still lists it);
  Todofy's daily attention reminder (at most one Todoist task per UTC day) carries them. The dashboard
  creates Todoist tasks in no other way. Mail Hero's own `ALERT_WEBHOOK_URL` stays unconfigured.

## 7. Rollback and removal

- **The first release is different.** `wrangler deploy` makes the Worker live as soon as it uploads it,
  then creates the Custom Domain (DNS record and certificate) and the Cron Trigger, all before the
  "Check that Access answers" step. So if `Dashboard deploy` fails at or after "Deploy the Worker home"
  (a probe failure, a Custom Domain error), the Worker, its Durable Object namespace, its secrets and its
  `*/30` cron are already live, and each tick calls both apps' `Ops` (status, `setGuard`, the daily
  canary with its synthetic Mail Hero event and up to 3 Gemini calls in Todofy, `reportOps` into
  Todofy's reminder). There is no previous version to roll back to, and **reverting the merge commit does
  not undo the deploy**: the revert also removes the `Dashboard deploy` job, so CI never touches the live
  Worker again, and (because it also changes `ci.yml`) it re-checks every app. To stop it: Cloudflare
  dashboard → Workers → `home` → Settings → Trigger events → remove the Cron Trigger (the Worker stays
  reachable only through Access), or delete the Worker `home` and check that its Custom Domain and
  Durable Object namespace are gone ("Remove the dashboard" below). Only then revert or fix on `main`;
  a fixed deploy recreates the trigger. Any `shed` it set expires by itself (≤ 36 h).

- **Worker code** (after the first release). Revert the commit on `main` and push: CI redeploys the
  previous code (the change is under `dashboard/`). For an immediate rollback, Cloudflare dashboard → Workers → `home` →
  Deployments → roll back to the previous version; the next deploy from `main` replaces it again, so
  revert the commit too. The Durable Object class and its migration `v1` stay; the SQLite tables are
  created with `IF NOT EXISTS`, so older code reads the same state.
- **Stop all dashboard activity** (canaries, guard calls, digest reports): Cloudflare dashboard →
  Workers → `home` → Settings → Trigger events → remove the Cron Trigger. The page keeps working from
  its cached snapshot. Any `shed` it set expires by itself (≤ 36 h), and Todofy's reminder stops
  carrying the last ops report once it is older than 36 h (contracts/ops-v1 `README.md`). The next deploy from `main` restores
  the trigger, so change `dashboard/wrangler.toml` too if the stop must last.
- **Before rolling Todofy back** to a release without canary handling (contracts/ops-v1
  `IMPLEMENTATION.md` §4: such a release would turn a canary it still sees into a real Todoist task and
  list it as mail):
  1. Stop new canaries: set `DASHBOARD_CANARY_ENABLED=false` in the GitHub `production` environment and
     run the workflow on `main` with `app: dashboard`. Check the page: the banner shows
     "运维面板：金丝雀已关闭", 立即运行金丝雀 is disabled, "下次定时运行" says 已关闭. Do not rely on the
     dashboard noticing Todofy's missing `canary_consumer` capability instead: statuses may be up to an
     hour old, and an old release may not answer `status()` at all.
  2. Drain what is in flight. The canary section's "正在运行" run, if any, keeps being polled until it
     ends (at most 2 h after it was queued; one not yet queued ends at the next tick). Then, for every canary of the last 7 days
     (Mail Hero retries a canary delivery for up to 7 days; the table lists the last 14 runs, so more
     than 14 runs in 7 days means you cannot see them all), the contract's condition is that its delivery
     is no longer `pending`/`paused` and its Todofy result is terminal. Settled: a run that ended `ok`; one
     that failed at the consumer stage with Todofy's own code (for example `llm_quota`); one skipped at
     the start stage with a reason other than `canary_disabled` (Mail Hero answered paused/unavailable
     and wrote nothing, or no call was made). Not known to be settled, because the dashboard stopped
     polling it: a start that failed on a call error (the event may exist), a start skipped as
     `canary_disabled` (the page does not show whether an earlier attempt failed on a call error), any
     delivery-stage failure or skip, and a consumer-stage `timeout`, `not_seen`, `unreachable` or hold
     (`processing` with a waiting code).
  3. If any run is unsettled or you cannot tell, do not wait on it: set Mail Hero's
     `MAIL_HERO_FORCE_SEND_PAUSED=true` and Todofy's `TODOFY_PROCESSING_PAUSED=true` (GitHub variables,
     each app's own deploy) before the rollback, and keep both until the canary rows are cancelled or
     completed on a release with canary handling again.
  4. Roll Todofy back. Once a release with canary handling (`canary_consumer` in its `status()`) is live
     again, set `DASHBOARD_CANARY_ENABLED=true` and deploy the dashboard (never delete the variable:
     the deploy refuses an unset switch).

  Removing the Cron Trigger (above) also stops canaries, but it stops the guard and the digest too, and
  the next deploy restores it; the switch is the intended way.
- **Remove the dashboard.** Delete the Worker `home` in the Cloudflare dashboard (check afterwards
  that its Durable Object namespace and the Custom Domain are gone too) and remove the `dashboard/` directory and its CI jobs in one commit. Mail Hero and
  Todofy need no change: their `Ops` entrypoints stay unused, a `shed` guard expires, and no route of
  theirs depends on the dashboard.
