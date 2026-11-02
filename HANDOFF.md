# Handoff

Updated 2026-11-02 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

`codex/quant-control-diagnostics` retains the most recent control failure's fixed phase, code and UTC time in
the existing cursor and carries that evidence through health/publication diagnostics after recovery. The latest
publication recovered automatically from a temporary archive error while the collector was reachable, but its
old projection lost the original failure details. The precise trigger remains unknown. A native alarm regression
reproduced the same visible states from a plan dependency failure and recovered without manual intervention;
that demonstrates the mechanism, not the historical trigger. Existing recovery behavior stays in place.
Local retention/privacy regressions, native alarm recovery, type checks and independent review passed;
exact-source admission and publication remain pending.

Full-pool event initialization continues independently of CI from its original checkpoint. Daily price scheduling
has naturally queued its execution behind it. Remaining work is complete source/coverage acceptance, account-budget
control and enabling daily events. Preserve other services' request headroom; do not restart confirmed work or
repeat completed price/SDK/recovery audits merely for acceptance. The proposed older event expansion is not running.

The owner cancelled development-library migration; use fresh collection. Preserve existing Dropbox/Recall/R2 files,
keep automatic private publication disabled and use no paid upgrade. Detailed incident evidence remains private.

## Latest verified release

Private producer `92a6f78`, checked through parent `9c3534f`, passed branch/main admission and first-attempt protected
publication. Native source/image observation, public health and same-main resource/VPS/Worker comparison with
resolved drift passed. The original full-pool event run resumed automatically with its confirmed progress intact.

The release includes complete-history chart resize preservation, UTC event defaults, deletion request headers,
clean confirmation feedback, cancelled-event checkpoint continuation, verified CI connection readiness and reduced
immutable-upload request overhead. The production deletion dialog was opened and cancelled; no plan was deleted.
Synthetic request-count and authority/failure checks are distinct from production source/health observations.

The [November 2 archive](docs/history/handoff-2026-11-02.md) records this publication and the earlier cache/build
and console corrections. Shared Storage is independently connected and registered; its protocol and persistence
checks remain in [November 1](docs/history/handoff-2026-11-01.md#shared-storage). Earlier integration and build
configuration are in [October 31](docs/history/handoff-2026-10-31.md) and [October 30](docs/history/handoff-2026-10-30.md).
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
