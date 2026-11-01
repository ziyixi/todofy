# Handoff

Updated 2026-11-01 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

`codex/quant-fresh-start` completes the owner-authorized private workbench. The owner explicitly cancelled the
development-library migration: the data is inexpensive to collect again. Start the new workbench with an empty
working cache and collect through the application. Remove the transfer from the release prerequisite; do not add
recovery machinery to the cancelled transfer or import old execution history. The connection-retry-only proposal
was abandoned without an implementation.

The workbench and shared Storage integration are merged and have passed exact-source local/Linux checks and
independent review. Fresh-start local checks and review passed; cloud checks, protected publication and live
acceptance remain pending.
CI builds and deploys the checked source and waits for service readiness; data collection runs in the application.

Shared Storage is published, independently connected and registered. Its real object/authentication, gzip,
32 MiB and pagination/replay checks passed; the [November 1 archive](docs/history/handoff-2026-11-01.md#shared-storage)
records that separate release. Existing Dropbox files and application connections are preserved.

Next: verify empty-cache startup, publish the checked workbench, collect fresh data and verify its Dropbox reads,
API/Colab and runtime plans, then require same-main reconciliation. Detailed
application and data evidence stays in the private handoff; automatic private publication remains disabled.

## Latest verified release

Private application and shared native CI support are published. Runtime source private `7c984e5`, checked through
parent `808a3c4`, passed exact-source branch/main checks, complete protected Actions publication, live owner/API
acceptance and measured bulk collection with immutable archive acceptance. Normal Kubernetes management uses
Actions; application runtime identities remain scoped. Actual private runtime resources are registered and Home's
normal publication is verified. Detailed application/data evidence stays in the private repository.

The [November 1 archive](docs/history/handoff-2026-11-01.md) records the shared integration and compatibility
regressions. Earlier private-submodule support, public publication and configuration-publishing evidence remain in
[October 31](docs/history/handoff-2026-10-31.md); build migration and Newsletter correction are in
[October 30](docs/history/handoff-2026-10-30.md). Per-application source identities remain independent.
Documentation-only closeout still follows normal main CI and same-main reconciliation before delivery.

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
