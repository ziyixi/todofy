# Handoff

Updated 2026-11-03 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

Owner-requested price policy change is in progress on `codex/quant-weekly-adjusted` in both repositories: daily
updates collect only raw prices with seven days of overlap; existing weekly updates collect 90 days of raw overlap
and refresh complete adjusted history from 2016. No new plan type or setting is needed. Update collection/context,
the daily already-current guard, regression tests and plan copy together, then use normal protected publication.
Queued old-policy catch-up `94c9f8b9-6785-4bdb-a485-dcff582de8e1` was cancelled at zero progress at 02:08 UTC.
Initial events continue independently, observed at 835/1,022 at 02:09 UTC. After the policy is live, use the saved
daily price plan once for raw-only catch-up; do not resume the old-policy execution.
Local acceptance passed the actual collector facade (13 targets) and web facade (2 targets), including exact
raw/all request windows, preserved adjusted rows during daily collection and the raw-only already-current guard.
Branch/main CI and one normal publication remain before this policy is live.

Software delivery is complete: source `893837b` runs with private image
`sha256:efe22000d785125a836772faaa202dedde44b8909c826bd4d651e55ed5fd0109`; the Worker stage finished through main
`c05f4ee5` without rebuilding the image or replacing the ready collector. Independent health and a later same-main
check-only reconciliation passed. Do not repeat the full release, add features or block delivery on unrepeatable
network/exit137 details. Existing bounded retry, metadata confirmation and checkpoint continuation are authoritative.

Remaining work is data initialization and plan acceptance. The owner's 90,000 shared-account Workers line is an
operator line. Home's 21:30 UTC cache reached 88,587, so queued price job `6036c4bc-d1cd-4a68-a64a-e9db6dd69010`
was cancelled at zero progress, then original event job `63e5d584-d9e5-4ce6-ae43-6129034add86` stopped at its asset
boundary: 663/1,022 with 675,611 matched observations. The UI offers continuation of the remaining 359 identities.
On November 3 at 00:03 UTC, the account statistic day reset was confirmed (21 requests), and this same event
execution resumed from 663. A fresh UI observation confirmed 664/1,022 and 676,459 matched observations, with its
original ID/start/range preserved. It is running: do not create a replacement or repeat Resume while active.
Both old zero-progress price executions remain cancelled. The pending policy change above supersedes their
raw+vendor-adjusted daily behavior.

After initialization, accept actual source coverage/limitations, catch up through the saved daily price plan if
needed, and enable saved daily events at 03:00 America/Los_Angeles. Its end date is already blank; subsequent source
updates overlap seven days. Daily price 01:00 and weekly Sunday price 02:00 remain enabled. Preserve existing files,
keep automatic private publication disabled and use no paid upgrade or old-library migration. Do not repeat old
price/SDK/captured-head audits or run rejected production upload fixtures. Earlier GFL actions need their normal
revisit; foreign-market earnings semantics remain explicitly unverified rather than silently remapped.

## Latest verified release

Producer `893837b` passed exact-source admission. Its collector became Ready after the original rollout wait had
expired; the checked `finish-worker` operation through main `c05f4ee5` completed only the remaining Worker and
recorded a new verified receipt. Native source/digest/readiness guards and Worker source health passed. Independent
health returned 200/healthy/reachable/completed at the expected source. A later same-main check-only reconciliation
actually passed all fourteen Worker comparisons, VPS identity, registration and resolved drift.

The release handles verifiable immutable single/batch uncertainty without replaying a batch or mutable head and
retains bounded failure/recovery evidence. Existing UI, price archive, SDK and captured-head evidence remains
separately scoped. Data initialization and daily-event enablement remain unfinished; physical network/exit137
details remain open without blocking practical continuation under the owner's latest instruction.

The [November 2 archive](docs/history/handoff-2026-11-02.md) records this publication and earlier corrections.
Shared Storage's protocol/persistence checks remain in [November 1](docs/history/handoff-2026-11-01.md#shared-storage).
Earlier integration and build configuration are in [October 31](docs/history/handoff-2026-10-31.md) and
[October 30](docs/history/handoff-2026-10-30.md). Documentation closeout follows normal main CI and reconciliation.

## Separate acceptance and follow-ups

- Natural Newsletter/send/researcher runs, daily/weekly backup observations, Recall cold archive reads and a complete
  clean-account/clean-VPS historical restore remain distinct from the build migration. Follow each app's verification
  page and [rebuild verification](docs/rebuild-verification.md); do not infer them from uploads or replay real work.
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
