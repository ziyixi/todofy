# Release

One workflow, [`.github/workflows/website-release.yml`](../../.github/workflows/website-release.yml), does
every production change of the site. Its two production jobs (release and status) share the concurrency
group `website-production` (`queue: max`, never cancelled) and the GitHub `production` environment, so
releases, status refreshes and Notion writes never overlap, whoever started them. Two more jobs run only on
its daily schedule and never release themselves: they dispatch the relay's reconcile release when it is due
([Daily schedule](#daily-schedule)).

| Started by               | How                                                                                           | Inputs                                              |
| ------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| A website push on `main` | `ci.yml` → `Website deploy` (after `Website checks` and the CI gate) dispatches it            | `release`, trigger `push`                           |
| 发布网站 button          | relay `/publish`                                                                              | `release`, trigger `button`                         |
| Change detector          | relay `scheduled()` ([`architecture.md`](architecture.md#automatic-releases))                 | `release`, trigger `cron`, `pending` or `reconcile` |
| 刷新状态 button          | relay `/refresh-status`                                                                       | `status`, trigger `button`                          |
| Daily schedule           | its own `schedule` (hourly 10:30–15:30 UTC) dispatches it when due ([below](#daily-schedule)) | `release`, trigger `reconcile` (the relay's inputs) |
| You                      | Actions → Website release → Run workflow                                                      | any operation, trigger `manual`                     |

The confirmation input must be `<operation>:www.ziyixi.science` (plus `:allow-empty` when `allow_empty` is
set). The relay, `Website deploy` and the daily schedule send fixed inputs; no request can choose a ref,
recovery or `allow_empty`. `Website deploy` only dispatches (`gh workflow run` with its `actions: write` token) and
returns: a main CI run never waits for a queued release, and every release is a run of this workflow, which
is what the relay lists (running release, release window, failures).

**Which commit is built.** Every run checks out `main` inside the lock, then
[`scripts/release/green-commit.ts`](../scripts/release/green-commit.ts) (plain `node`, before any install)
picks the newest first-parent commit of it whose **push** run of `ci.yml` on `main` has a successful
`CI gate` check (the monorepo's single required check; `Changes` diffs push runs from the last successful
one, so a passed gate covers every website change up to that commit) and checks it out. A newer commit that
is red, still running or `[skip ci]` is never built; if none of the newest 50 passed, the run fails before
the gate step, without a record. `context` checks the pinned commit again with the pinned code.

## What a release does

Each step is one `pnpm release <command>` ([`scripts/release/cli.ts`](../scripts/release/cli.ts)), run from
`website/` on the pinned CI-green commit:

1. `context`: only `main`, only a workflow dispatch (a scheduled run never gets here: it dispatches), the
   exact confirmation, and the checked-out commit passed the CI gate.
2. `code-sha`: the code identity is the newest commit at or before it that touched `website/` (so a
   Todofy commit does not redeploy the site).
3. `gate`: reads the `website-release` GitHub Deployment records of this repository. A `release` needs the
   latest one to be `success` (it becomes the baseline); anything else needs `recovery`. With no record at
   all a release stops with a notice asking for `bootstrap` (the job stays green).
4. `recover` (recovery only) or `check-baseline` (release): production must serve the recorded Worker
   version (Cloudflare API), and the recorded live hostname must serve the recorded identity.
5. `pnpm check` on the empty snapshot (no secrets), then `prepare`: the Notion sync with the baseline
   registry (`--for-release`; a non-empty → empty collection needs `allow_empty`).
6. `decide`: identity = website commit + content hash + config hash + schema version. Unchanged →
   no build and no deploy (`force_build` overrides); the Notion feedback still runs.
7. `pnpm build:site`, then `verify-artifact`: `wrangler dev` serves `out/` with `wrangler.toml`; the
   identity and the whole route contract ([`tests/e2e/deployment.spec.ts`](../tests/e2e/deployment.spec.ts):
   every route and status, asset hashes, redirects, 404, segment payloads, a browser pass without console
   errors) must pass before anything is uploaded.
8. `hostnames`, then `upload`: [`tools/cf-guard`](../../tools/cf-guard/README.md) compares the routes in
   `wrangler.toml` with the Worker's live Custom Domains (read-only) and stops the release, before anything
   is uploaded or recorded, when a live hostname would be detached or another Worker's hostname or an
   existing DNS record taken over (an intentional change sets `CF_GUARD_ALLOW_REMOVE` /
   `CF_GUARD_ALLOW_CONFLICT`, the latter as `worker:<host>` or `dns:<host>`, on this step and on `deploy`). The workflow comes from `main` and the code from
   the green commit, so a release dispatched before the first green CI gate after the guard merged builds a
   commit without it: the step skips only a commit whose history never had `tools/cf-guard` (it deploys as
   before), and runs the guard for every later commit, including one that deleted it. Then production must still serve the baseline version; `wrangler versions upload` creates a
   version that serves nothing yet. (The very first release, `bootstrap`, uses `wrangler deploy` because a
   version cannot be uploaded to a Worker that does not exist.)
9. `record`: a GitHub Deployment (payload schema 3: identity, version, previous version, live hostname,
   content registry, route contract), status `in_progress`. An interrupted run leaves this record blocking.
10. `deploy`: runs the hostname guard again (a refusal changes nothing), refuses a production that changed meanwhile; `wrangler versions deploy <version>@100%`; confirms the active version; when `wrangler.toml` lists
    hostnames, `wrangler triggers deploy` applies them: the Custom Domains `www.ziyixi.science` and
    `ziyixi.science`, which wrangler treats as the Worker's complete set (it replaces the attached set with
    the listed one, so with the file matching the live state nothing changes), and keeps workers.dev off.
    Newer website code landing on `main` meanwhile is not a reason to stop: this build passed CI and the
    release that push dispatched is queued behind this one and builds the newer code (refusing here would
    record a failure that blocks the gate for that release too).
11. `verify-live`: the live hostname (the canonical host `www` once attached, otherwise the first listed
    hostname) must become reachable (a new hostname: up to 20 × 15 s), serve the identity 3 times in a row
    (12 × 5 s) and pass the route contract; then every other listed hostname (the apex) must serve the
    same identity the same way. With no hostname yet this step is skipped: the version was verified
    locally.
12. `mark-success`, then the **Notion feedback**: `sync-status.ts` compares every row with the live
    `publication-state.json` (on the hostname above, `WEBSITE_LIVE_ORIGIN`) and writes `网站状态`,
    `线上版本时间`, `检查时间` (the instant of that row's write), `网站链接`, `已上线指纹`; after a deploy `update-site-summary.ts` updates the
    database description. A feedback failure is a warning, never a rollback. Without a hostname it is
    skipped.
13. On a failed deploy or live check: `rollback` deploys the recorded previous version again (only if
    production serves this release's version), verifies it on the hostname where the baseline was
    verified (the baseline record's live hostname, not a hostname this release was adding: if attaching
    it failed, it still serves what answered before), and `mark-failure` records `failure` (restored and
    verified) or `error`. The job fails; every later `release` (push, buttons, relay cron) stops at the
    gate until someone dispatches `recovery`.

## Operations

- **bootstrap** (once, before the first release): needs zero records in this repository. It continues the
  content registry of the last successful record of `ziyixi/ziyixi.science` (Vercel era, read from its public
  GitHub Deployments), so slug history and feed GUIDs carry over. Without such a record, an empty registry
  additionally needs the production variable `WEBSITE_BOOTSTRAP_APPROVAL=https://www.ziyixi.science`.
- **recovery**: after a failed or interrupted release, or a manual rollback. If production serves the
  latest record's version, it is verified again (live identity and route contract) and marked `success`;
  if it serves the earlier successful record's version, that is verified; anything else stops for a human.
  Then a full release runs (recovery always rebuilds).
- **status**: the 刷新状态 button; only the Notion feedback, no build.
- **force_build**: rebuild and redeploy an unchanged identity (for example to re-run the live checks or to
  re-attach a hostname that was removed by hand; not the recorded live hostname: while that one does not
  serve the Worker, the baseline check stops every release first, see
  [`cutover.md`](cutover.md#rollback)).
- **allow_empty**: one run may publish an empty collection after a non-empty one.

## Daily schedule

The relay's change detector dispatches one reconcile release a day ([`architecture.md`](architecture.md#automatic-releases)),
but only while its dispatch token (a fine-grained PAT that only the owner can grant access to
`ziyixi/todofy`) works. So the workflow also has its own `schedule` (`30 10-15 * * *`: hourly from 10:30 to
15:30 UTC, after the relay's `RECONCILE_UTC_HOUR` of 10) that dispatches that same reconcile release, with
the run's `GITHUB_TOKEN` (a `workflow_dispatch` by `GITHUB_TOKEN` starts a run, as `Website deploy`'s does)
and no new secret. A scheduled run is named `Website scheduled reconcile` and never builds or deploys:

1. **Website scheduled reconcile check** (no environment, no secret, no install; `contents`, `actions`,
   `checks` and `deployments` read only) pins the newest CI-green `main` commit like a release and runs
   [`scripts/release/scheduled-reconcile.ts`](../scripts/release/scheduled-reconcile.ts) with plain `node`.
   It stops (`due=false`, a notice with the code) when a `Website release (reconcile)` run, the relay's or one
   an earlier hour dispatched, was created today (UTC) (`RECONCILED_TODAY`); while another run of the
   workflow is queued or running (`RELEASE_RUNNING`: its record may say `in_progress` until it finishes, so
   that is not a gate; the next hour checks again); when there is no `website-release` record
   (`NO_RELEASE_RECORD`) or the latest is not `success` with nothing running (`RECOVERY_GATE`: only
   `recovery` may cross the gate, so no failing run is started); or after 3 failed releases today
   (`FAILURES_TODAY`, the relay's failure stop).
2. Only then **Website scheduled reconcile dispatch** (the `production` environment, for its Notion
   secrets, used only in its last step; `actions: write` to dispatch, otherwise read only; no lock of its
   own) pins the newest CI-green commit again, installs, and runs
   [`scripts/release/scheduled-dispatch.ts`](../scripts/release/scheduled-dispatch.ts): it checks step 1
   again with fresh data, reads Notion exactly as the relay's detector does (its `readNotionRows`,
   `decide` and `relay/wrangler.toml` settings) and holds while the relay would (`QUIET_PERIOD`: an author
   edit or a masked pending change newer than `QUIET_MINUTES`; or Notion did not answer:
   `NOTION_UNAVAILABLE`); the next hour checks again. Otherwise it dispatches exactly the relay's reconcile
   (`release`, `release:www.ziyixi.science`, no `force_build`, no `allow_empty`, trigger `reconcile`) and
   waits until GitHub lists the new run.

The dispatched run is an ordinary `Website release (reconcile)`: every gate above applies, an unchanged
identity deploys nothing and only refreshes the Notion feedback, and the relay sees it as its own (running
release, release window, today's reconcile, failures), so a working relay neither reconciles again that day
nor republishes the edits it already released. A scheduled run that stopped or held is invisible to the
relay (its name does not parse), so it moves no edit window. With a working relay its reconcile comes
first (the first tick after 10:00 UTC) and every scheduled hour stops at `RECONCILED_TODAY`. Two dispatches
on one day need both to decide within the same few seconds (the relay holds while the scheduled run is
listed as running, and the scheduled run ends only after its dispatched run is listed); the second is then
queued behind the first and, unless Notion changed in between, deploys nothing.

GitHub may start a scheduled run late or drop it under load (the next hour checks again), and disables
schedules in a public repository after 60 days without activity. To turn it off, set the repository variable
`WEBSITE_SCHEDULED_RECONCILE` to `false` (Settings → Secrets and variables → Actions → Variables; a
repository variable, since the check job has no environment).

## Rollback by hand

- A failed release rolls back by itself (step 13). To go back to an older version on purpose, prefer a
  revert commit on `main` (a normal release). In an emergency, from a trusted machine:
  `pnpm exec wrangler versions deploy <version-id>@100% --config wrangler.toml`, or Workers →
  ziyixi-website → Deployments → Rollback in the dashboard. The next release then refuses to start
  (production no longer serves the recorded version) until you dispatch `recovery`, which accepts only the
  latest record's version or its predecessor: so roll back only to the latest record's
  `previousWorkerVersionId`. Version IDs are in the Deployment records and in `wrangler versions list`.
- To Vercel during the cutover window: [`cutover.md`](cutover.md#rollback).

## Configuration

Committed: `SITE_URL`, `NOTION_API_VERSION` and `WEBSITE_LEGACY_REPOSITORY` in the workflow's `env`; the
Worker, account and hostnames in [`wrangler.toml`](../wrangler.toml). GitHub `production` environment:

| Name                            | Kind                                          | Used by                                                                                                                          |
| ------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `WEBSITE_NOTION_TOKEN`          | secret                                        | the Notion sync and the feedback (needs Read and Update content)                                                                 |
| `WEBSITE_NOTION_DATA_SOURCE_ID` | secret                                        | same                                                                                                                             |
| `CF_API_TOKEN`                  | secret (shared with Todofy and the dashboard) | Cloudflare reads, `versions upload/deploy`, `triggers deploy` (Custom Domains), the relay deploy; it cannot edit DNS or rulesets |
| `WEBSITE_BOOTSTRAP_APPROVAL`    | variable, optional                            | only an empty-registry bootstrap                                                                                                 |
| `WEBSITE_SCHEDULED_RECONCILE`   | repository variable, optional                 | `false` turns the [daily schedule](#daily-schedule) off; unset or anything else keeps it on                                      |

The release job's `GITHUB_TOKEN` (`contents: read`, `deployments: write`, `checks: read`, `actions: read`)
reads the CI results and writes the records; the scheduled jobs' tokens only read, and the dispatch job's
may also dispatch workflows. It is in the `env` of only the steps that need it (pin the commit, `context`,
`gate`, `recover`, `record`, `mark-success`, `mark-failure`, the scheduled check's decision and the
scheduled dispatch), never of the install, build or test steps, so a dependency's install script cannot
forge a release record. Logs print commit
IDs, version IDs, status codes and counts only; never a token, a response body or Notion content.
