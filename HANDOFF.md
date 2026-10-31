# Handoff

Updated 2026-10-31 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md). Historical waiting lists are not instructions.

## Current work

`codex/bazel-build-packages` is implementing the approved whole-repository BUILD simplification and package ownership
correction. Application roots retain final artifacts and public check/config/release entrypoints; source, tests and
tools move into their owning packages. Existing dependency granularity, fixtures, budgets, runtime code, locks and
release behavior must remain. Shared macros encapsulate fixed execution conventions rather than infer dependencies.

The original native graph and all 19 release/synthetic build targets are saved locally for comparison; the baseline
Web/extension/site builds and three Linux images succeeded. Ownership changes and shared runner/archive/audit macros
are implemented across the repository. Native loading, representative moved Python/JS tests and the real ESLint
positive/negative/declaration-file fixture passed. Full configured analysis passed. All archive paths, modes and runtime
payloads match; the three OCI archives are byte-identical. Recall exposed a missing compiler-config input, now declared
and explicitly passed; corrected old/new archives match. Website repeat controls confirm pre-existing build-ID/source-map
metadata variation. Canonical generated paths and incremental dependency links are restored without output cleanup.

The first full check run exposed compiler-root, source-scan launcher placement, quality-check placement and moved
inspection-location issues. Definitions are corrected with assertions/budgets intact; final checks follow existing CI
group concurrency. Branch CI, publication and matching reconciliation remain pending. No real work, content, installed
extension, dependency lock, provider model or credential is changed. Keep current service behavior and user pauses.

## Latest verified release

Newsletter/Gateway `8525c64e`: one same-context format correction shares the existing second-turn opportunity with source
verification. Independent review, deadlines and usage remain. Exhausted technical deep failures retain the approved brief
and report partial failure. Branch/main checks, actual Linux image probes, runtime readiness and matching reconciliation
passed. No real model call, completed-content recomputation or resend was used for acceptance.

See the [October 30 record](docs/history/handoff-2026-10-30.md#newsletter-bounded-format-correction).
The earlier full Bazel migration and Website acceptance are in the same archive; per-application source identities remain independent.

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
