# Handoff

Updated 2026-11-03 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

Private application work, releases, operating limits and owner items are tracked only in the private submodule's
`private/HANDOFF.md`; this file names that side only generically (AGENTS).

`claude/landable-now` (on `85ebd0b1`) holds three independent public changes:

- Home's usage query raises its Durable Object and R2 storage row caps from 10 to 25 and the R2 operation cap from
  50 to 250, above the account's 13 object classes and 14 buckets; DO requests, DO duration and R2 storage were
  lower bounds before. Only `limit` values change: no `orderBy` is added because none was checked on the live
  account, and the new values are not yet verified there. Unit and real-workerd checks passed.
- Mailsort's one-time October 29 requeue of terminal model failures is removed. It had completed (see
  [verification](mailsort/docs/verification.md#optional-accounting-and-recovery-2026-10-29)); running it again
  would count those mails twice. Recovered decisions and recorded counts are unchanged; a real-workerd regression
  fails on the old code and passes now.
- AGENTS adds the generic-naming rule for the private submodule, and this file keeps only the pointer above. The
  November 2 archive no longer carries two private image digests or the private application's name; the private
  archive keeps both.

The 84 test targets that depend on the changed files passed locally, including both apps' worker, web, deploy
bundle-budget and repository audit checks; the CPU group also passed uncached, as CI runs it. The branch reaches
only `//dashboard:release` and `//mailsort:release`: landing deploys the Home and Mailsort Workers, not Storage, the
VPS images or any private target, provided the newest main push run is green at landing time (a failed one widens
the cumulative release diff). Land it as a merge with `origin/main` as first parent, together with or after the
private HANDOFF update that takes over the owner items removed here in `eee152de`, so the pointer above is true.
After release, check that Home's next usage refresh succeeds with Durable Object rows no longer marked as lower
bounds; on a `graphql_error`, revert the usage change. Mailsort's following passes should classify as before.

## Latest verified release

Main `85ebd0b1` passed its complete main workflow and the matching Personal cloud reconcile, whose fourteen
Worker comparisons, VPS identity, resource registration and resolved infrastructure drift checks all ran and
passed. Private application releases and their evidence are in the private HANDOFF.

Shared Worker receipt recovery (`7ef001fe`) adds fixed failure stages, exact committed-result readback and a
guarded receipt-only path without application redeployment. The old statusless Tasks receipt remains historical
and unconfirmed; the current main has its own successful Tasks receipt.
Historical failure triggers without original evidence remain unknown.

The [November 2 archive](docs/history/handoff-2026-11-02.md) records the earlier November 2 publications and
corrections. Shared Storage's protocol/persistence checks remain in [November 1](docs/history/handoff-2026-11-01.md#shared-storage).
Earlier integration and build configuration are in [October 31](docs/history/handoff-2026-10-31.md) and
[October 30](docs/history/handoff-2026-10-30.md). Documentation closeout follows normal main CI and reconciliation.

## Separate acceptance and follow-ups

- Natural Newsletter/send/researcher runs, daily/weekly backup observations, Recall cold archive reads and a complete
  clean-account/clean-VPS historical restore remain distinct from the build migration. Follow each app's verification
  page and [rebuild verification](docs/rebuild-verification.md); do not infer them from uploads or replay real work.
- Durable Object errors on November 2 (Fleet 135 of 549 requests, Mailsort 46 of 369 in the 22:18 UTC reading)
  were reviewed from code only; no bug was found and no application change was made. Fleet's count equals its
  three Ops status calls in each of the 45 Home ticks by then, but also about half of its observer's five-minute
  receipts, and Mailsort's is within one of its single call per tick, so the counts do not identify a cause; that
  day's four deploys of each do not fit. No Home status failure is known, but none was checked. Watch and Recall
  forward Home's status the same way; their absence from that reading proves nothing, as it may have been cut by the
  old unordered 10-row cap. The item stays open. First read Home's own status records (ok, error, consecutive
  failures) for the three Fleet entries and Mailsort; once the larger usage caps are live, run a read-only
  `durableObjectsInvocationsAdaptiveGroups` query by `scriptName` and `status` for Fleet, Mailsort, Watch and
  Recall. Change Fleet or Mailsort code only after that.
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
