# Handoff

Updated 2026-11-03 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

Private application work, releases, operating limits and owner items are tracked only in the private submodule's
`private/HANDOFF.md`; this file names that side only generically (AGENTS).

`claude/review-fixes-public` (local, not pushed; on `9a8f7704`) merges four reviewed public branches with
`--no-ff`, main as first parent, then two commits: one moves the private gitlink to the private side's merged review
fixes and records this plan; the next applies the integration review's corrections and re-pins the gitlink.

- `claude/storage-fixes`: Storage refuses malformed keys before waking its Durable Object, checks batch item hashes
  before commit and answers `BATCH_NOT_COMMITTED` for failures before finish, drops a connection Dropbox already
  revoked, reports a full Dropbox distinctly with the last provider error (written at most once a minute), removes
  the unused list page cache and starts the Durable Object with one unknown-key request during release.
- `claude/release-tools`: receipts read every job page; release units come from the app manifests; twelve Worker
  release actions share `worker-prepare`/`worker-deploy` and the three image publishers share `publish-image`;
  `PRIVATE_CATALOG` is validated with Home's own parser; tests cover the release checks no test exercised.
- `claude/ci-build`: three workerd runners, caches saved only from main with one lockfile-keyed repository cache,
  the never-enabled automatic private publication removed, private Bazel output kept off the public log, Recall's
  extension published only when its content changed, release images built once (`check-*` become `build-*`), pinned
  `.node-version`/`.opentofu-version`, tsx and Playwright from the root package, and an AppArmor compile test.
- `claude/private-entry-point`: every private operation runs through the pinned private entry point with the
  operation on its command line, so an older entry point refuses an operation it does not know; the public copy of
  the finish step is removed.
- Review corrections: the private release job may run 45 minutes instead of 30, enough for a slow private rollout
  and the checks after it; the landing and rollback plan below.

Only the three image release facades conflicted (`codex-gateway`, `newsletter`, `platform`): each now declares its
`build-<service>` action and the shared `publish-image`, which is what `ci.yml` runs. The Storage release action and
the private release workflow merged cleanly and were checked by hand. The gitlink and the entry-point change land in
the same push; the private push, release gate, release, its checks and its rollback follow `private/HANDOFF.md`.

Local checks on macOS with CI's flags and caches: the changed files reach 72 test targets in the check, node,
python and workerd groups (Target Determinator was emulated from Bazel's query graph; the same emulation reproduced
main's 84-target selection for `9a8f7704`). All passed except two Linux-only targets left to CI (AppArmor compile,
platform export). A wider run of 329 targets in every changed BUILD package plus Storage, tools, proto, contracts
and `.github` passed, Storage and the release/CI tool suites also uncached, and the private build and check passed
on this tree (40 passed, one skipped as in CI).

Landing deploys, in the existing order: all fourteen Workers (Model Router, Todofy, Tasks, Watch, Mail Hero,
Mailsort, Links, Fleet, Recall, Storage, Personal MCP, Newsletter console, website relay, then Home), the website
workflow, and all three VPS images with their VPS releases, because every release facade's actions changed. It
does not publish the Recall extension and runs no private release: the automatic private path is gone, so the
private side stays at its running revision until its manual release.

Landing order: this branch first, then the private release.

1. Window: after the private HANDOFF lifts its release gate, start soon after 00:00 UTC and finish the branch run,
   the main run, its reconcile and the private release before 09:00 UTC (the private HANDOFF says why). Both runs
   start with cold Bazel caches, because the cache keys and paths changed. The 13:41 UTC reconcile and the 15:00 UTC
   Newsletter daily job come later.
2. Push the pinned private commit first: the Private Bazel check checks out the gitlink from the private repository
   ([CI/CD](docs/ci-cd.md#private-checks)). If private main moved, the private merge is rebuilt and re-pinned here.
3. Push this branch and wait for a complete green branch run whose Changes job selects exactly the set above. If
   main moved, rebuild the four merges on the new main and rerun the checks.
4. Fast-forward main to that green SHA (`git push origin <sha>:main`) while the newest main run is green. No new
   merge commit: release artifacts are reused only for the SHA the branch run built.
5. Wait for the main workflow and its Personal cloud reconcile: every deploy job green, Storage's release logging the
   Durable Object's 401 for an unknown key, and reconcile's fourteen Worker comparisons, VPS identity, registration
   and resolved drift. Then the private release.
6. Afterwards Storage's owner console shows its connection and no `INSUFFICIENT_SPACE`, `CONNECTION_INVALID` or
   `BAD_REQUEST` timed after the deploy. The console keeps the newest provider error until a reconnect, and
   `UNAVAILABLE` alone is a transient rate limit. Home shows every Worker, Storage and the private probes healthy at
   their next refresh.

Rollback:

- Restore `9a8f7704`'s tree, gitlink included, in one commit; or revert newest first, `git revert` for the two
  non-merge commits, then `git revert -m 1` for each of the four merges. One `git revert -m 1` of the last merge
  would leave the other three in place.
- After a green landing run, pushing the revert redeploys the same set from the old source. After a failed or
  partial one, the cumulative base stays at the last green main, which the revert's tree equals, so nothing is
  redeployed: dispatch `CI and deploy` on the reverted main with `app` set to each application that actually
  deployed (`dashboard` for Home; `all` only if the VPS images also published, accepting the VPS restart), then
  confirm the new receipts name the revert SHA.
- `PERSONAL_CLOUD_AUTO_REPAIR` is on, so the 13:41 UTC reconcile and the one after each green main run redeploy
  each Worker's last good receipt. Before an emergency `wrangler rollback`, the owner sets it to `false`, or the
  revert and dispatch finish first; it is restored once receipts name the reverted source.
- Storage's old code recreates the dropped cache table on start and ignores the new provider-error key, so reverting
  Storage is safe.

## Latest verified release

Main `9a8f7704` (Home usage limits, Mailsort cleanup and the generic-naming rule) passed its complete main
workflow, which deployed only Home and Mailsort, and the matching Personal cloud reconcile, whose fourteen Worker
comparisons, VPS identity, resource registration and resolved infrastructure drift checks all ran and passed. Its
[November 3 archive](docs/history/handoff-2026-11-03.md) lists the post-release checks not yet observed. Private
application releases and their evidence are in the private HANDOFF.

Shared Worker receipt recovery (`7ef001fe`) adds fixed failure stages, exact committed-result readback and a
guarded receipt-only path without application redeployment. The old statusless Tasks receipt remains historical
and unconfirmed; the current main has its own successful Tasks receipt.
Historical failure triggers without original evidence remain unknown.

The [November 2 archive](docs/history/handoff-2026-11-02.md) records the November 2 publications and corrections.
Shared Storage's protocol/persistence checks remain in [November 1](docs/history/handoff-2026-11-01.md#shared-storage).
Earlier integration and build configuration are in [October 31](docs/history/handoff-2026-10-31.md) and
[October 30](docs/history/handoff-2026-10-30.md). Documentation closeout follows normal main CI and reconciliation.

## Separate acceptance and follow-ups

- Natural Newsletter/send/researcher runs, daily/weekly backup observations, Recall cold archive reads and a complete
  clean-account/clean-VPS historical restore remain distinct from the build migration. Follow each app's verification
  page and [rebuild verification](docs/rebuild-verification.md); do not infer them from uploads or replay real work.
- Durable Object errors on November 2 are all `clientDisconnected`, none a failed invocation: a read-only
  `durableObjectsInvocationsAdaptiveGroups` query by `scriptName` and `status` gave Fleet 144, Watch 48, Recall 48,
  Mailsort 49, Mail Hero 4, with every other invocation `success`. That is one per Home status tick (48 a day) for
  each Durable Object behind an Ops status entrypoint, three for Fleet: Home closes the call after reading the answer
  and the object records the disconnect. Home received valid statuses all day, so nothing failed and no application
  change is needed; the counts only inflate the error column of Home's usage view.
- Recall phone acceptance is paused by the owner's choice. Stopped scheduler observations remain stopped.
  Do not request device reinstallation or restart retired Compose services for this task.
- Model Router's Ops currently reports maintenance in `modes` while deriving health from request/backup signals;
  this differs from the general ops-v1 maintenance/down rule. The docs record its actual behavior. A correction is
  separate from this build/documentation migration.

## Operating boundaries

The repository introduction is available in [Chinese](README.md) and [English](README.en.md), with matching application
and documentation links. Its editorial update is recorded in the [October 30 archive](docs/history/handoff-2026-10-30.md#repository-introduction).

The [architecture](docs/architecture.md), [CI/CD](docs/ci-cd.md), [Bazel](docs/bazel.md), [resource catalog](docs/service-catalog.md)
and [rebuild](docs/rebuild.md) guides are current entrypoints. Application runbooks own recovery and runtime semantics.

Keep the dated [old-client compatibility windows](docs/history.md#owner-api-compatibility), frozen webhook/schema bytes,
resource identities and database migrations. Dates do not authorize automatic data deletion or early route removal.
The migration changed no business history, model choice, budget, credential or installed owner extension.
