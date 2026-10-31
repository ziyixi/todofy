# Handoff

Updated 2026-10-31 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md). Historical waiting lists are not instructions.

## Current work

`codex/private-quant-data` and private branch `codex/quant-data` finish a private application rollout.
Application sources, private proto, deployment configuration and detailed evidence stay in that repository.
Parent changes supply shared tools/dependencies, a protected private publisher and optional Home registration.

The initial integration is on main and verified below. The current follow-up separates manual `Private operations`
from public build/release selection; it reuses the exact source's green gate and the existing private release lock.
Its local routing and source-gate regressions passed. Owner confirmed promotion and rollout; preserve that authorization.

The private read-only infrastructure plan has 11 creates and no updates/deletes; no private apply, deployed API
acceptance or bulk collection has run. After this follow-up's branch CI, promote the same source and continue the
private plan/apply, actual identity recording, image/Worker publication, initial installation and data acceptance.
The private handoff owns operational details. Source-only API probes and local checks are not deployment evidence.

## Latest verified release

Shared private-application support `2aea26a0`: exact-source branch/main CI, affected public publication and
same-source reconciliation passed. Private source remains pinned through the gitlink, uses the root toolchains/locks,
and restores public caches without uploading private caches or build/test artifacts. A cancelled duplicate operational
run repeated the same source's public publication; a fresh reconciliation also passed. The private application itself
has not been deployed. The initial submodule acceptance is retained in the October 31 record.

See the [October 31 record](docs/history/handoff-2026-10-31.md#private-submodule-and-public-ci) for verification and the earlier
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
