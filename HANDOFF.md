# Handoff

Updated 2026-11-01 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

`codex/quant-workbench-storage` adds shared Dropbox object storage and expands the private research workbench.
The owner authorized implementation and publication. Existing Dropbox files and application connections remain
in place. The shared service has independent publication and contracts; private application implementation stays
in `private/`. The private handoff records the data migration, interface work and acceptance requirements.
Shared Storage is published through PR #40 and its real resource identity is registered. Its independent Dropbox
App-folder connection and 15 live object/authentication checks passed. The private workbench is merged through
private PR #15 and pinned by `codex/quant-workbench-release` / parent PR #41. Complete private local and Linux checks
and release artifacts passed, including legacy archive promotion and cross-day event-window regressions.
Resource registration is merged through PR #41. `codex/quant-storage-operations` completes live client
interoperability, large-checkpoint transport and fixed research context propagation before the first private
data migration. Full native checks, release artifacts and independent reviews passed. Final exact-source cloud
checks, protected private publication, live transfer/restoration and same-main reconciliation remain pending.
Data-specific evidence stays in the private repository.

`codex/storage-list-pages` adapts the shared list protocol to the provider's approximate page-size limit.
The current code can reject a legitimate oversized provider page; the fix retains excess metadata in a bounded
short-lived page cache and preserves the signed namespace/prefix cursor. The ongoing private transfer uses
stat/get/put and continues on its checked source. Publish this list-only correction after that transfer completes,
then repeat its live pagination and same-main reconciliation checks.

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
