# Handoff

Updated 2026-11-02 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

`codex/deployment-receipt-recovery` addresses the separate GitHub receipt failure after an application was already
uploaded and verified. Fixed provider/phase diagnostics and exact readback handle a committed 5xx response without
repeating a POST. An explicit main-only receipt operation revalidates the original gate and live evidence under
the existing production lock, without building, migrating or publishing the application. Unconfirmed writes and
changed live versions remain unresolved. Related unit/workflow checks and an independent review passed; admission
and any applicable receipt completion are pending. The original failed workflow's terminal status is unchanged.

`codex/quant-event-source-shapes` corrects a confirmed corporate-action parser omission: a reorganization's
participating security may appear in its stock-movement list. Validate that relation without transferring the
top-level security's ratios to a nested participant. Synthetic source/association regressions passed; admission
and publication are pending. Cross-market earnings aliases remain unaccepted until identity/date semantics can
be represented correctly. The already admitted batch release remains independently pinned to parent `72b00df`.

The consumer follow-up also resolves explicit incomplete immutable batches with existing per-object metadata
checks and create-only writes. A fully confirmed group can continue the same asset without repeating source
collection; failed confirmation still fences and mutable head CAS is unchanged. Five affected Bazel test targets,
including native transport and cold recovery, passed. The application's actual Bazel Ruff checks also pass after
correcting test imports that a root-config check classified differently. Admission and publication are pending.
The same publication gives the growing library a 600-second startup window and 900-second Deployment deadline.
The earlier measured restore and expected full-pool reference count expose a risk of outgrowing the old window;
the estimate is not a new full-pool restore result. Existing deployment regressions passed.

`codex/quant-event-throughput` adds bounded create-only batches on Storage's existing machine content path and
uses them for Quant's raw/normalized asset stages. The existing Dropbox connection and Durable Object stream a
batch through native upload sessions and synchronous completion. No new service, permission, stored format or
migration. Every item must match before one final control checkpoint can advance; mutable head CAS remains.
Successful finer news/calendar windows also replace unused intermediate response uploads; failures retain evidence.

Storage native/auth/stream/conflict checks, collector atomicity/recovery tests, dual-language golden/schema/lint/
compatibility checks and independent reviews passed. The exact Linux image layer and wheel contain the new shared
protocol module. A same-input synthetic asset drops 25 Storage requests to 4 with identical data/coverage; this is
not a production throughput prediction. Storage and the checked consumer are now deployed. A real batch returned
`BATCH_INCOMPLETE`; automatic recovery retained confirmed progress but repeated the unconfirmed security. The
provider stage remains unknown. A small follow-up records fixed batch phases and bounded error tags through the
existing logs, without paths, objects or response bodies. It changes no API result or upload/replay behavior.

The owner raised this first backfill's operational shared-account request line to 90,000 and prioritized finishing
collection. This replaces the earlier 60,000 line. It is operator-controlled, not an implemented automatic guard.
Full-pool initialization continues from its original checkpoint; daily price scheduling has queued its execution
behind it. Remaining work is complete source/coverage acceptance, quota monitoring and enabling daily events.
Preserve other services' headroom and existing Dropbox/Recall/R2 files. Use fresh collection without old-library
migration, keep automatic private publication disabled and use no paid upgrade. Do not repeat completed audits.

## Latest verified release

Private producer `e566485`, checked through parent `72b00df`, passed its exact branch/main CI gate and normal
first-attempt protected publication after Storage's production release. Public health observed the expected source
and healthy dependencies. A same-main check-only reconciliation passed, including resolved infrastructure drift.
The main workflow separately failed while recording a successful Tasks deployment; its GitHub receipt has no
status and remains unresolved. A successful deployment is not recorded as a wholly successful main workflow.

The original full-pool event run resumed with its confirmed progress intact; the later real batch failure above
still blocks business acceptance. The release retains complete-history
chart resizing, UTC event defaults, deletion headers/confirmation feedback, cancelled-event continuation, verified
CI connection readiness and reduced immutable-upload request overhead. The production delete dialog was opened
cleanly and cancelled; no plan was deleted. Historical failure triggers without original evidence remain unknown.

The [November 2 archive](docs/history/handoff-2026-11-02.md) records this publication and earlier corrections.
Shared Storage's protocol/persistence checks remain in [November 1](docs/history/handoff-2026-11-01.md#shared-storage).
Earlier integration and build configuration are in [October 31](docs/history/handoff-2026-10-31.md) and
[October 30](docs/history/handoff-2026-10-30.md). Documentation closeout follows normal main CI and reconciliation.

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
