# Handoff

Updated 2026-10-30 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md). Historical waiting lists are not instructions.

## Current work

The Newsletter console repair is deployed and its morning model-failure impact is verified. No implementation in
this handoff is awaiting release. Check current Git status and open pull requests before starting independent work.

## Latest verified release

Newsletter console `5db4f86e`: related branch/main checks, actual Linux image regression, VPS readiness and matching
Personal cloud reconciliation passed. Authenticated production overview/run reads and the actual console UI recovered.
The morning failure was a deep writer's invalid output; all five topics published as independently reviewed briefs.
The planned deep article was not delivered. No completed content was recomputed or resent.

See the [October 30 record](docs/history/handoff-2026-10-30.md#newsletter-console-sqlite-and-morning-model-failure).
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

The [architecture](docs/architecture.md), [CI/CD](docs/ci-cd.md), [Bazel](docs/bazel.md), [resource catalog](docs/service-catalog.md)
and [rebuild](docs/rebuild.md) guides are current entrypoints. Application runbooks own recovery and runtime semantics.

Keep the dated [old-client compatibility windows](docs/history.md#owner-api-compatibility), frozen webhook/schema bytes,
resource identities and database migrations. Dates do not authorize automatic data deletion or early route removal.
The migration changed no business history, model choice, budget, credential or installed owner extension.
