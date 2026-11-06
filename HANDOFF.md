# Handoff

Updated 2026-11-06 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

Main `71f87df7` carries the Storage console work and pins the private application's improvement waves. Normal main
publication ships them; record its verification here once observed, then move this to the dated archive.

- Storage owner console: overview, keys and activity tabs; per-key request counters by UTC day with recent
  failures; the Dropbox account's space, cached in the Durable Object; and an owner-started, read-only object scan
  that counts each namespace's objects and bytes. Space reads and scan pages give up on a stalled body.
- Owner: while applications are idle, disconnect and reconnect Dropbox in the Storage console so the space tile
  fills in (no Dropbox App Console change is needed), then start 扫描对象 to count each namespace's objects.
- Private application work, operating limits and owner follow-ups, including a committed follow-up that waits for
  its own pin, are recorded only in `private/HANDOFF.md`.
- Newsletter retrieval (not yet on main), one release: headline feeds grouped by event, with at most three
  code-counted consensus leads a day entering the pool as news (selection still judges must-know); new health,
  technology, world and economy feeds; cross-day event threads in the discovery and selection prompts; sha256-pinned
  headline excerpts as abstract evidence for a one-paragraph signal; and the run page's 检索漏斗 and 必知追踪 with a
  Wikipedia Current events reference ([workflow](newsletter/docs/workflow.md#从线索到成稿)). Release the VPS
  Newsletter image first under the drain contract; the content config (the `role` field and the `current_events`
  source) applies after it (the old engine rejects both, and config sync keeps the previous version until then).
  The console Worker may go either way. The todofy Worker also redeploys, unchanged: `//todofy:core_proto_sources`
  bundles every generated proto module. Verify on the first natural run that the world headline record has every
  feed answering and consensus groups, consensus leads reach selection, the reference reads as available and the
  funnel has counts.

Every Storage, shared release-tool, CI/build and private-entry-point change from the November 2 review landed with
`c5c1b7e0`; the automatic publication replaced that review's removal of the never-enabled private path. A
documentation-only follow-up describes Home's generated private registration in its setup guide, extends the generic
naming rule to the private repository's own commit subjects and branch names, and names the private check's error
codes generically. It changes no source, so it publishes no service and no private application.

- Private source in public CI: every job fetches the pinned private commit through the quiet
  `.github/actions/private-checkout` action and keeps private operation output in a runner-side file, so public logs
  show only fixed `PRIVATE_*` codes. The scheduled reconcile also compares the private application's live sources with
  the pinned gitlink (or its newest settled release). Verify after landing: the release, Home and reconcile jobs print
  no checkout subject, and the next scheduled reconcile reports `PRIVATE_REVISION_MATCHES_PIN`.

## Latest verified release

Main `07dbfab7` passed cumulative CI, all nine selected Worker publications, the Website release and same-source
production reconciliation. The [November 6 archive](docs/history/handoff-2026-11-06.md) records the selection
failure, Links CPU guard and verification. The [November 3 archive](docs/history/handoff-2026-11-03.md) records
the earlier automatic publication changes.

Shared Worker receipt recovery (`7ef001fe`) adds fixed failure stages, exact committed-result readback and a
guarded receipt-only path without application redeployment. The old statusless Tasks receipt remains historical
and unconfirmed; the current main has its own successful Tasks receipt.
Historical failure triggers without original evidence remain unknown.

The [November 2 archive](docs/history/handoff-2026-11-02.md) records the November 2 publications and corrections.
Shared Storage's protocol/persistence checks remain in [November 1](docs/history/handoff-2026-11-01.md#shared-storage).
Earlier integration and build configuration are in [October 31](docs/history/handoff-2026-10-31.md) and
[October 30](docs/history/handoff-2026-10-30.md). Documentation closeout follows normal main CI and reconciliation.

## Separate acceptance and follow-ups

- Not yet observed after the November 2 review's Storage release (`c5c1b7e0`): Storage's owner console showing its
  connection and no `INSUFFICIENT_SPACE`, `CONNECTION_INVALID` or `BAD_REQUEST` timed after that release (the console
  keeps the newest provider error until a reconnect; `UNAVAILABLE` alone is a transient rate limit), and Home showing
  every Worker, Storage and the private probes healthy. Only Storage's synthetic unknown-key 401 is recorded.
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
