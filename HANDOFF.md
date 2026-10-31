# Handoff

Updated 2026-10-31 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md). Historical waiting lists are not instructions.

## Current work

`codex/root-go-module` is moving the existing Go dependency manifest and sums to the repository root.
The Go SDK, dependency versions, annotation checks and package BUILD entrypoints remain. Root Bazel imports
the shared module; repository audits and current documentation are updated. Native Go tests, API lint and
repository audits passed; dependency declarations and checksums match the previous module. Branch/main CI
and same-source reconciliation remain pending. No application runtime, credentials or business data change.

## Latest verified release

Build ownership and configuration publishing `8f5b83fb`: implementation targets live in their owning packages,
while directories keep their main interfaces. Full migration checks, independent source/test/artifact comparisons,
application publications, VPS rollout and Website live verification passed. The final configuration fix also passed
affected branch/main checks, actual validation/publication using the existing image and same-source reconciliation.
Application runtime sources, dependency locks, credentials, business content and installed owner extensions remain unchanged.

See the [October 31 record](docs/history/handoff-2026-10-31.md#bazel-package-ownership-and-shared-build-recipes).
The earlier build migration and Newsletter correction remain in the [October 30 archive](docs/history/handoff-2026-10-30.md).
Per-application source identities remain independent.

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
