# Handoff

Updated 2026-10-31 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md). Historical waiting lists are not instructions.

## Current work

`codex/private-submodule-ci` is adding the approved private repository as the root `private/` submodule.
Root toolchains and dependencies remain authoritative. The synthetic private target and repository/CI audits pass
locally; all 12,356 public query targets are identical with and without an initialized submodule. Private CI checks
the recorded commit, gates publication and restores public caches without saving private outputs. Actual GitHub
checkout/build/test, branch/main CI and reconciliation remain pending.

## Latest verified release

Root Go module `60460b21`: all Go packages share root go.mod/go.sum, imported by the existing Bazel toolchain.
Go, dependency versions and checksums remain. Native Go/API-lint/repository checks, affected branch/main CI,
actual configuration validation/publication and same-source reconciliation passed. Application artifacts and
deployments were skipped.
Application runtime sources, dependency locks, credentials, business content and installed owner extensions remain unchanged.

See the [October 31 record](docs/history/handoff-2026-10-31.md#root-go-module) for verification and the earlier
package-ownership and configuration-publishing changes.
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
