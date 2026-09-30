# Release

One workflow, [`.github/workflows/website-release.yml`](../../.github/workflows/website-release.yml), does
every production change of the site. Its two jobs share the concurrency group `website-production`
(`queue: max`, never cancelled) and the GitHub `production` environment, so releases, status refreshes and
Notion writes never overlap, whoever started them.

| Started by               | How                                                                                     | Inputs                                   |
| ------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| A website push on `main` | `ci.yml` → `Website deploy` (after `Website checks` and the CI gate) calls the workflow | `release`, trigger `push`                |
| 发布网站 button          | relay `/publish`                                                                        | `release`, trigger `button`              |
| Change detector          | relay `scheduled()` ([`architecture.md`](architecture.md#automatic-releases))           | `release`, trigger `cron` or `reconcile` |
| 刷新状态 button          | relay `/refresh-status`                                                                 | `status`, trigger `button`               |
| You                      | Actions → Website release → Run workflow                                                | any operation, trigger `manual`          |

The confirmation input must be `<operation>:www.ziyixi.science` (plus `:allow-empty` when `allow_empty` is
set). The relay and the CI caller send fixed inputs; no request can choose a ref, recovery or
`allow_empty`.

## What a release does

Each step is one `pnpm release <command>` ([`scripts/release/cli.ts`](../scripts/release/cli.ts)), run from
`website/` on the newest `main` checked out inside the lock:

1. `context`: only `main`, only a push or a dispatch, and the exact confirmation.
2. `code-sha`: the code identity is the newest commit that touched `website/` (so a Todofy commit does
   not redeploy the site).
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
8. `upload`: production must still serve the baseline version; `wrangler versions upload` creates a
   version that serves nothing yet. (The very first release, `bootstrap`, uses `wrangler deploy` because a
   version cannot be uploaded to a Worker that does not exist.)
9. `record`: a GitHub Deployment (payload schema 3: identity, version, previous version, live hostname,
   content registry, route contract), status `in_progress`. An interrupted run leaves this record blocking.
10. `deploy`: refuses a stale build (main has newer website code) and a production that changed meanwhile;
    `wrangler versions deploy <version>@100%`; confirms the active version; when `wrangler.toml` lists
    hostnames, `wrangler triggers deploy` applies them as Custom Domains (and keeps workers.dev off).
11. `verify-live`: the live hostname (the canonical host once attached, otherwise the preview host) must
    become reachable (a new Custom Domain: up to 20 × 15 s), serve the identity 3 times in a row
    (12 × 5 s) and pass the route contract. With no hostname yet this step is skipped: the version was
    verified locally.
12. `mark-success`, then the **Notion feedback**: `sync-status.ts` compares every row with the live
    `publication-state.json` (on the hostname above, `WEBSITE_LIVE_ORIGIN`) and writes `网站状态`,
    `线上版本时间`, `检查时间`, `网站链接`, `已上线指纹`; after a deploy `update-site-summary.ts` updates the
    database description. A feedback failure is a warning, never a rollback. Without a hostname it is
    skipped.
13. On a failed deploy or live check: `rollback` deploys the recorded previous version again (only if
    production serves this release's version), verifies it, and `mark-failure` records `failure`
    (restored) or `error`. The job fails; the next release must be `recovery`.

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
  re-attach a hostname that was removed by hand).
- **allow_empty**: one run may publish an empty collection after a non-empty one.

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

| Name                            | Kind                                          | Used by                                                                         |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| `WEBSITE_NOTION_TOKEN`          | secret                                        | the Notion sync and the feedback (needs Read and Update content)                |
| `WEBSITE_NOTION_DATA_SOURCE_ID` | secret                                        | same                                                                            |
| `CF_API_TOKEN`                  | secret (shared with Todofy and the dashboard) | Cloudflare reads, `versions upload/deploy`, `triggers deploy`, the relay deploy |
| `WEBSITE_BOOTSTRAP_APPROVAL`    | variable, optional                            | only an empty-registry bootstrap                                                |

The job's `GITHUB_TOKEN` (`contents: read`, `deployments: write`) writes the records. Logs print commit
IDs, version IDs, status codes and counts only; never a token, a response body or Notion content.
