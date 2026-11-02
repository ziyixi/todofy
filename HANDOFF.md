# Handoff

Updated 2026-11-02 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

`codex/deployment-receipt-recovery` addresses the separate GitHub receipt failure after an application was already
uploaded and verified. Fixed provider/phase diagnostics and exact readback handle a committed 5xx response without
repeating a POST. An explicit main-only receipt operation revalidates the original gate and live evidence under
the existing production lock, without building, migrating or publishing the application. Unconfirmed writes and
changed live versions remain unresolved. Related unit/workflow checks and an independent review passed; admission
and any applicable receipt completion are pending. The original failed workflow's terminal status is unchanged.

Full-pool event initialization continues from its original captured scope and confirmed progress. The installed
collector resolves an explicit incomplete immutable batch through matching per-object metadata and create-only
writes; an unconfirmed resolution still fences without advancing its final checkpoint. Storage now retains fixed
failure phases/tags in existing logs. The original provider failure's precise stage remains unknown; use the next
natural failure's evidence rather than treating a successful batch or restart as its cause being resolved.

The installed reorganization parser recognizes validated nested participants without transferring another
security's ratios. Its earlier source check requires a normal revisit. Cross-market earnings aliases remain
unaccepted until issuer and date semantics can be represented correctly; unsupported source coverage stays explicit.

The owner raised this first backfill's operational shared-account request line to 90,000 and prioritized finishing
collection. This replaces the earlier 60,000 line. It is operator-controlled, not an implemented automatic guard.
Full-pool initialization continues from its original checkpoint; daily price scheduling has queued its execution
behind it. Remaining work is complete source/coverage acceptance, quota monitoring and enabling daily events.
Preserve other services' headroom and existing Dropbox/Recall/R2 files. Use fresh collection without old-library
migration, keep automatic private publication disabled and use no paid upgrade. Do not repeat completed audits.

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
