# Handoff

Updated 2026-11-02 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

`codex/k3s-session-readiness` retains native command failure evidence and replaces local-listener readiness with
verified end-to-end identity/authority before writes. Only explicitly classified transient read-only preflight
failures may wait within the existing startup budget; resource mutations do not replay. The prior generic K3s
failure lost its exact operation and cause, which remain unknown. Existing application source remains healthy.

The same work makes cancelled event initialization resumable from its existing checkpoint for quota control,
without changing other job types or adding a pause framework. Earlier public health observation and empty-error
confirmation corrections are included but await activation. Related native checks and the actual web bundle
passed; exact-source admission, read-only verification and protected publication remain pending.

Full-pool event initialization continues independently of CI. Daily price scheduling has naturally queued its
09:00 UTC execution; it waits behind initialization. Remaining work is complete source/coverage acceptance,
account-budget control and enabling daily events. Preserve other services' request headroom; do not restart
confirmed work to recover quota or repeat completed price/SDK/recovery audits merely for acceptance.
The proposed older event expansion is not running.

The owner cancelled development-library migration; use fresh collection. Preserve existing Dropbox/Recall/R2
files, keep automatic private publication disabled and use no paid upgrade. Detailed incident evidence remains
in the private handoff.

## Latest verified release

Private source `b6597e8`, checked through parent `18607f1`, passed branch/main admission and ordinary protected
publication. Native source/digest observation and public health passed; same-main resource/VPS/Worker comparison
and resolved infrastructure drift passed. Initial full-history charts and source-link wrapping were observed on
production desktop and narrow views. The later installed source also preserves resizing; publication observation
and confirmation feedback remain current work above.

The [November 2 archive](docs/history/handoff-2026-11-02.md) records the published cache/build and console corrections.
Shared Storage is independently connected and registered; its protocol and persistence checks remain in
[November 1](docs/history/handoff-2026-11-01.md#shared-storage). Earlier integration and build configuration are in
[October 31](docs/history/handoff-2026-10-31.md) and [October 30](docs/history/handoff-2026-10-30.md).
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
