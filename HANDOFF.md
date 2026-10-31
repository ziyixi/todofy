# Handoff

Updated 2026-10-31 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md). Historical waiting lists are not instructions.

## Current work

`codex/newsletter-config-ci-noop` addresses a post-acceptance configuration workflow failure: documentation-only
Service CI published no Newsletter image, but its follow-up still scanned historical engines. Reuse the existing
image-publication check to skip that no-op. Compatibility compares against the latest tested main source, while
the selected image keeps its actual publication SHA; unrelated green changes no longer block real configuration
pushes. Direct pushes, candidate-image validation and real image-publication follow-ups remain. Native regressions
pass; branch/main CI, the actual no-op follow-up and same-source reconciliation remain pending.

## Latest verified release

Bazel package ownership `eb3a983c`: implementation targets now live in their owning packages, while directories keep
their main interfaces. Full branch/main checks, independent source/test/artifact comparisons, application publications,
VPS rollout, Website live verification, Newsletter configuration publication and matching reconciliation passed.
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
