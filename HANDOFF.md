# Handoff

Updated 2026-11-03 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

No unpublished software changes remain from the automatic-publication work. Private application work, operating
limits and owner follow-ups are recorded only in `private/HANDOFF.md`.

## Latest verified release

Main `9da2d116` passed its complete automatic publication: selected public service publications, the selected
private publication, then one Home publication. The matching Personal cloud reconcile ran all fourteen actual
Worker comparisons, VPS identity, complete resource registration and resolved infrastructure drift successfully.
The [November 3 archive](docs/history/handoff-2026-11-03.md) records the shared changes and automatic chain;
private application evidence is in the private HANDOFF. Documentation-only closure does not republish services.

Shared Worker receipt recovery (`7ef001fe`) adds fixed failure stages, exact committed-result readback and a
guarded receipt-only path without application redeployment. The old statusless Tasks receipt remains historical
and unconfirmed; the current main has its own successful Tasks receipt.
Historical failure triggers without original evidence remain unknown.

The [November 2 archive](docs/history/handoff-2026-11-02.md) records the November 2 publications and corrections.
Shared Storage's protocol/persistence checks remain in [November 1](docs/history/handoff-2026-11-01.md#shared-storage).
Earlier integration and build configuration are in [October 31](docs/history/handoff-2026-10-31.md) and
[October 30](docs/history/handoff-2026-10-30.md). Documentation closeout follows normal main CI and reconciliation.

## Separate acceptance and follow-ups

- Natural Newsletter/send/researcher runs, daily/weekly backup observations, Recall cold archive reads and a complete
  clean-account/clean-VPS historical restore remain distinct from the build migration. Follow each app's verification
  page and [rebuild verification](docs/rebuild-verification.md); do not infer them from uploads or replay real work.
- Durable Object errors on November 2 are all `clientDisconnected`, none a failed invocation: a read-only
  `durableObjectsInvocationsAdaptiveGroups` query by `scriptName` and `status` gave Fleet 144, Watch 48, Recall 48,
  Mailsort 49, Mail Hero 4, with every other invocation `success`. That is one per Home status tick (48 a day) for
  each Durable Object behind an Ops status entrypoint, three for Fleet: Home closes the call after reading the answer
  and the object records the disconnect. Home received valid statuses all day, so nothing failed and no application
  change is needed; the counts only inflate the error column of Home's usage view.
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
