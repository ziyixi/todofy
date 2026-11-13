# Handoff

Updated 2026-11-09 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Documentation entrypoints are in [docs/README](docs/README.md).

## Current work

Private operating follow-ups are tracked in `private/HANDOFF.md`.

Branch `codex/release-revenue-yoy` computes release revenue growth from a confirmed quarter end and a same-currency
prior quarter visible at decision time. It keeps the release EPS surprise column missing while comparable per-share
bases are unavailable. Run branch CI before adopting the new reader pin. Verify on a frozen dataset containing release
facts and period evidence after publication.

The SDK coverage follow-up reads the archive start from the frozen manifest's part index so it stays
the same when candidate securities change between year slices. Synthetic fixtures verify both time
policies and the calendar fallback when the first settlement is absent from the trading calendar.
Run branch CI before updating the SDK pin. Verify year-sliced parity on a complete freeze after publication.

Branch `codex/verified-return-factors` marks market caps `split_unverified` when the share-count interval
crosses an unresolved stock dividend. The affected release buyback ratio is missing when it receives that
market-cap status. Existing frozen files can still be read. All 179 SDK tests passed locally, including
synthetic regressions for the effect date and both normalizer versions. Run branch CI before using the
new SDK pin, then verify the refreshed archive with the published SDK. Private application release
details remain in `private/HANDOFF.md`.

Branch `claude-schema-diagnostic` reports `claude_schema_complexity` for Anthropic's documented structured-output
compilation limit response. Other HTTP refusals keep their existing mapping. The diagnostic is a fixed value, and
the upstream error body stays private. The 42 adapter tests, worker typecheck and lint targets passed. The
synthetic streaming tests cover the exact refusal and a similar unrecognized message. After branch CI, verify
the Router trace if this refusal recurs on a synthetic request.

Branch `codex/research-fiscal-periods` fixes SDK quarter derivation for 12-week interim periods and a
16- or 17-week fourth quarter. The fallback requires matching filing periods at the same fiscal start
and annual evidence for the fourth quarter. It fills gaps after evaluating the existing quarter choices.
Derived caches use a new version. All 61 targeted SDK tests passed locally. The archived comparison
recovered fresh quarterly values for five issuers with this calendar, with unchanged comparison issuers
and same-period TTM/FY revenue. Land after branch CI and confirm the refreshed archive with the published SDK.

Branch `codex/checked-source-rollout` adds Standard OpenAI reservation rates to the Router catalog and restricts
a new private service caller to approved models and bounded text generation. Router type checks, pricing and native
binding tests passed locally. Publish the Router before enabling its consumer binding. After publication, verify the
restricted catalog and one bounded synthetic generation.

The test suite consolidation landed on main. Its CI gate stopped at the Links backup export CPU check, which
measured a 5.20 ms warm median against a 5 ms assertion. The backup implementation, fixture and CPU meter match
the previous green revision. Branch `codex/links-backup-cpu` uses the existing 7 ms first-run ceiling for warm
exports too. A local warm-only slowdown reached 8.17 ms and failed the updated guard.

The same main run's comparison also treated every app as affected when a new test label was missing from the old
graph. The repair branch compares shared labels and selects new compatible targets individually. Merge after the
branch gate passes, then verify the cumulative main selection, its publications and same-SHA reconciliation.

Main `71f87df7` carries the Storage console work and pins the private application's improvement waves. Normal main
publication ships them; record its verification here once observed, then move this to the dated archive.

- Storage owner console: overview, keys and activity tabs; per-key request counters by UTC day with recent
  failures; the Dropbox account's space, cached in the Durable Object; and an owner-started, read-only object scan
  that counts each namespace's objects and bytes. Space reads and scan pages give up on a stalled body.
- Owner: while applications are idle, disconnect and reconnect Dropbox in the Storage console so the space tile
  fills in (no Dropbox App Console change is needed), then start 扫描对象 to count each namespace's objects.
- Private application work, operating limits and owner follow-ups, including a committed follow-up that waits for
  its own pin, are recorded only in `private/HANDOFF.md`.
- Newsletter retrieval (headline consensus leads, the added feeds, event threads, frozen excerpts, and the run page's
  检索漏斗 and 必知追踪 with the Wikipedia reference) is live; natural runs show headline groups, consensus leads, the
  reference and funnel counts. Branch `claude/newsletter-followups` (local, based on `07dbfab7`) carries follow-ups:
  the timeline and the overview hold a mapped node's items, not its whole span, to the per-attempt budget; 必知追踪
  adds 搜集标为必知 (additive `newsletter.ui.v1` field `Run.must_know_candidates`) and says the reference page is read
  before Wikipedia finishes it; the reference also keeps Law and crime and International relations; Nature and Nature
  Machine Intelligence are read through Crossref by ISSN, papers with an abstract only
  ([sources](newsletter/docs/content-config.md#研究员订阅源)). Main publication ships the Newsletter image under the drain
  contract, the console Worker and the unchanged todofy Worker; the content config then publishes the two registry
  entries, which the running engine already accepts. Until the image is live 搜集标为必知 reads as if nothing was marked.
  Verify on the first natural run after it: discovery and briefs are marked over budget only when one item ran past
  it, 搜集标为必知 lists the world direction's marked candidates and how far each got, the reference can list law and
  international events, and both Nature sources answer ok (they yield few leads).

Every Storage, shared release-tool, CI/build and private-entry-point change from the November 2 review landed with
`c5c1b7e0`; the automatic publication replaced that review's removal of the never-enabled private path. A
documentation-only follow-up describes Home's generated private registration in its setup guide, extends the generic
naming rule to the private repository's own commit subjects and branch names, and names the private check's error
codes generically. It changes no source, so it publishes no service and no private application.

- Private source in public CI: every job fetches the pinned private commit through the quiet
  `.github/actions/private-checkout` action and keeps private operation output in a runner-side file, so public logs
  expose only reviewed `PRIVATE_*` codes and bounded fields. The scheduled reconcile also compares the private application's live sources with
  the pinned gitlink (or its newest settled release). Verify after landing: the release, Home and reconcile jobs print
  no checkout subject, and the next scheduled reconcile reports `PRIVATE_REVISION_MATCHES_PIN`.

## Latest verified release

Main `e213919a` published the checked private correction and Home; matching reconciliation passed. See the
[November 8 archive](docs/history/handoff-2026-11-08.md#private-runtime-recovery).

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
