# Handoff

Updated 2026-11-02 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

`codex/quant-log-timeline` corrects the read-only observer: a rejected log timestamp must not discard independently
valid request diagnostics. It also normalizes explicit RFC3339 offsets/whitespace and retains bounded character
classes for an unrecognized prefix, without raw text. Actual previous-container evidence still needs capture
before collector replacement; a Ready transition alone does not establish the entire unavailable interval.

`codex/quant-immutable-write-recovery` addresses a new real client WriteTimeout on an immutable batch. The
installed consumer handled an explicit incomplete-batch reply but not this send/receive uncertainty. The pending
change resolves both create-only single and batch outcomes through matching metadata and one bounded missing-object
write. It preserves mutable head/CAS, rejects invalid acknowledgements and retains original diagnostics even when
resolution succeeds. Collector checks and independent review passed, and main `99f8895b` plus its complete
reconciliation succeeded. Consumer publication waits for the observer correction and old-log capture above.

The existing read-only runtime probe now retains validated CRI failure/startup times, request bytes and bounded
per-kind recovery records. Publish the checked diagnostic source to main and run verify before replacing the
collector, so its previous-container evidence is not overwritten. The precise network cause and correlation of the
19:09–19:10 public 503s remain open until that evidence is collected. Never restart or replay an Action merely
because an observation times out.

Full-pool event initialization continues from its original scope and checkpoint. Existing reorganization parsing
is installed; its older failed source check needs a normal revisit. Foreign-market earnings identity/date
semantics remain unverified and coverage warnings stay explicit. Daily-event scheduling is still disabled until
initial source/cost acceptance; its saved end date is blank and subsequent collection overlaps seven days.

The owner set this first backfill's shared-account Workers request line to 90,000. Monitor the cached account
usage, preserve other services' headroom and continue the same execution after any necessary UTC-reset wait.
This is an operator line, not an automatic platform guard. Preserve existing Dropbox/Recall/R2 files, keep
automatic private publication disabled, use fresh collection without old-library migration and no paid upgrade.
Do not repeat completed price/SDK/recovery audits or run rejected production upload fixtures.

## Latest verified release

Private producer `01af683`, checked through parent `f33ca484`, passed exact branch/main admission and one normal
protected publication after Storage's release. Independent health returned the expected source and healthy
dependencies; the original event execution retained its confirmed progress and continued. The complete main
workflow and its post-publication automatic reconciliation passed. All fourteen Worker comparisons, VPS identity,
resource registration and resolved infrastructure drift checks actually ran successfully.

This release includes immutable outcome resolution, reorganization participants and a 600-second startup window
with a 900-second Deployment deadline. Existing chart, console, cancellation, price archive, SDK and captured-head
recovery evidence remains separately scoped. Initial full-pool events and daily-event enablement are unfinished.
The old Tasks receipt remains historical and unconfirmed; the current main has its own successful Tasks receipt.
Historical failure triggers without original evidence remain unknown.

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
