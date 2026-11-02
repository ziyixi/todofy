# Handoff

Updated 2026-11-02 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

`codex/quant-finish-worker` completes the remaining Worker stage without rebuilding/publishing the image or
patching the already-ready collector. The thin public entry retains pinned private 893837b, current-main CI gate,
private registry/native source/digest/readiness checks, hostname/config guards and the existing production lock.
Only the Worker artifact/deploy and a new verified private receipt may write. Normal release operations are
unchanged. Targeted tests, actual scripts checks and diff review passed; admission and finish-worker remain.

The preceding normal release installed source 893837b but timed out after about 902 seconds waiting for Ready.
Read-only verification then proved that collector healthy at source893 and Ready at21:15:21, after the old budget.
The original registry digest is sha256:efe22000d785125a836772faaa202dedde44b8909c826bd4d651e55ed5fd0109; the finish
operation must freshly verify native imageID. Do not rerun the entire image/collector release. Exit137/network
physical causes remain recorded as unknown and, per the owner's latest direction, do not block practical recovery.

The owner's90,000 shared-account Workers line is active. At21:30UTC Home's cache read88,587. To stop before the
line, queued price job6036c4bc-d1cd-4a68-a64a-e9db6dd69010 was cancelled at0/1022, then the original event job
63e5d584-d9e5-4ce6-ae43-6129034add86 stopped at its boundary:663/1022 and675,611 matched observations. Its UI
explicitly offers continuation of359 remaining identities. The Codex goal is active; at00:00UTC quota reset,
refresh account usage and continue that same event execution, preserving its captured scope/asof/checkpoint.
No later queued collection remains. Re-run the saved daily price plan when needed after reset/initialization;
its enabled schedule stays intact. Daily events remain disabled until source/cost acceptance, with end date blank.

Prioritize delivery and bounded retry/checkpoint continuation. Do not reopen speculative runtime investigation,
repeat completed price/SDK/recovery audits, run rejected production upload fixtures, migrate the old development
library, upgrade paid products, or disturb existing Dropbox/Recall/R2 files. Automatic private publication stays off.

## Latest verified release

Private producer `01af683`, checked through parent `f33ca484`, passed exact branch/main admission and one normal
protected publication after Storage's release. Independent health returned the expected source and healthy
dependencies; the original event execution retained its confirmed progress and continued. The complete main
workflow and its post-publication automatic reconciliation passed. All fourteen Worker comparisons, VPS identity,
resource registration and resolved infrastructure drift checks actually ran successfully.

This release includes immutable outcome resolution, reorganization participants and a 600-second startup window
with a 900-second Deployment deadline. Existing chart, console, cancellation, price archive, SDK and captured-head
recovery evidence remains separately scoped. Initial full-pool events and daily-event enablement are unfinished.
The old Tasks receipt remains historical and unconfirmed; the current main has its own successful Tasks receipt.
Historical failure triggers without original evidence remain unknown.

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
