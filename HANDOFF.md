# Handoff

Updated 2026-10-30 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md). Historical waiting lists are not instructions.

## Current work

The complete Bazel implementation and its Website publication correction are deployed and verified.
No implementation from this migration is awaiting release. Check the current Git status and open pull requests
before starting new work; another agent may be working independently.

## Latest verified release

Native build migration `eee152de` and Website snapshot correction `477f66b5`: complete branch/main checks,
Worker publications, physical VPS readiness, live Website identity, complete resource registration and matching
Personal cloud reconciliation passed. Per-application release identities remain independent.

The [October 30 record](docs/history/handoff-2026-10-30.md#full-bazel-migration) holds the scope and actual acceptance.
Earlier business releases are indexed in [history](docs/history.md).

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
