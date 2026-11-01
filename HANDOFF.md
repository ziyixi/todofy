# Handoff

Updated 2026-11-01 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md). Historical waiting lists are not instructions.

## Current work

`codex/quant-live-acceptance` continues the checked Quant/Home work and runtime acceptance.
The owner explicitly wants normal K3s resources, including namespaces, RBAC and storage, managed through Actions.
Use native Kubernetes tools with a dedicated short-lived Actions identity; application runtime identities stay scoped.
The private repository owns the implementation and setup evidence. Native CI management and its runtime-identity
fix are merged after exact-source branch and main checks. The reviewed shared infrastructure changes applied and the following
plan had zero changes. The owner completed the one-time cluster trust handoff and real CI authorization verification
passed. Private application health is observed; full publication and data acceptance remain pending. The continuation PRs are merged;
further source changes need a new review.
The merged follow-up preserves the private acceptance evidence and updates shared version metadata handling.
Detailed runtime handoff status remains in the private repository.
Read-only runtime verification and the private-console layout correction passed branch/main checks and are merged.
The live collector and Worker run the checked follow-up source. A complete protected publication subsequently
passed running identity, digest and public combined health checks. Complete owner-console/data acceptance and
actual resource registration before final reconciliation.

The earlier `codex/quant-rollout-resume` continuation in both repositories is merged, along with the original
`codex/private-quant-data` / `codex/quant-data` work. Initial application publication and data acceptance remain pending.
Application sources, private proto, deployment configuration and detailed evidence stay in that repository.
Parent changes supply shared tools/dependencies, a protected private publisher and optional Home registration.
The continuation also opens registered background-service consoles from their Home rows. Private/Home web checks,
release artifact builds and exact-source branch/main CI passed; runtime acceptance remains pending.

The integration and main-only `Private operations` entry are on main after exact-source green checks. Manual
operations reuse prior green source evidence and the existing protected private release lock without invoking
public build selection. Owner confirmed promotion and rollout; preserve that authorization.

The private reviewed infrastructure applied 11 creates with no updates/deletes, followed by a clean plan. The actual
owner audience source passed branch/main CI and was promoted. The private application image is published and
anonymous pulls are refused. Initial workload resources were created through Actions. Continue owner-console verification,
exact resource registration and deployed API/bulk-data acceptance. Bulk collection has not run yet.
The private handoff owns operational details. Source-only API probes and local checks are not deployment evidence.

## Latest verified release

Shared private-application support `2aea26a0`: exact-source branch/main CI, affected public publication and
same-source reconciliation passed. Private source remains pinned through the gitlink, uses the root toolchains/locks,
and restores public caches without uploading private caches or build/test artifacts. A cancelled duplicate operational
run repeated the same source's public publication; a fresh reconciliation also passed. That release did not publish
the private application. Current acceptance is tracked above; the initial submodule evidence is in the October 31 record.

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
