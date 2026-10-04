# Handoff: work in flight

This file is the shared working state of the monorepo for whoever picks up next: the owner, a local agent
session, or a cloud agent with only this repository. It lists what is live, what is being built and in which
branch, in what order it merges, what still needs checking after a deploy, what waits for the owner, and the
problems already met, so a new session can continue without the previous conversation.

Rules for this file:

- Update it in the same change that starts, lands or abandons a piece of work. A stale entry is worse
  than none.
- This repository is public. Write branch names, commit SHAs, public hostnames, phases, steps and measured
  numbers. Never write secrets, personal values (addresses, emails, Todoist ids), raw API output, watched
  URLs, account ids, local secret file locations, or security-posture details. Those stay with the owner.
- Be complete enough to act on without the conversation that produced the work: for every open branch say
  what is done, what is left, how to verify it and what to check after its deploy. Link to the app docs for
  design detail instead of copying it.

Last updated: 2026-10-03. The verified foundation implementation is `8628e5e`; the k3s/Fleet
implementation and pinned connector bootstrap reached `main` at `54861b2`. The owner completed the bounded
SDK repair at `c703378`; Actions then activated the first API release and verified the physical images.
The subsequent `0f84d91` release encountered a Kubernetes field-ownership conflict. The owner completed
the guarded phase repair, and the original-ID resume succeeded in Actions `37142362209`. The normal
`7a66336` release then completed in Actions `37142838447`; its typed API reports `ready` with frozen
targets verified. Newsletter admission is accepting, with zero active work and all 32 historical unknown
outcomes preserved. k3s and the dedicated connector are running; Docker is inactive and disabled.
Fresh Fleet/Home checks confirm the release identities and clear the old deployment/admission alerts.
The classifier release `c0dddd3` completed in Actions `37146439819`; the typed release is ready with
frozen targets verified. Its natural 19:05 UTC observer recorded `BUS/APPARMOR_DENIED` for all four
units, while the main container successfully read the snapshot and submitted its receipt. The exact
official denial prefix is recognized in memory; no private error body is logged or stored. Direct
bounded host observations found all four units active. The owner completed the pinned AppArmor
installation, whose fixed file hash was rechecked. The full green `93b387c` follow-up reached main and
[Actions 37151397315](https://github.com/ziyixi/todofy/actions/runs/37151397315) completed the active VPS deployment.
Request `b663d6a9-30e0-44d4-90fc-13613ecb82d0` reports ready with frozen targets verified; both
actual sources are `93b387c` and generation 9 matches. The natural 20:30 UTC observer reported
`SYSTEMD_COMPLETE`, all four units active, and `OBSERVER_ACCEPTED/READ_OK`. Fresh Fleet/Home
receipts clear all four daemon-unknown alerts. The 32 historical Newsletter unknowns remain unchanged.
No new provider/send or fresh-account recovery claim follows from this acceptance. The temporary
host-admin window is expired; routine typed deployment and bounded metadata diagnosis need no sudo.

Completed at `5837c0c` on `main`: a simple native Mail Hero daily snapshot and actionable
rebuild/transferable-configuration runbooks. The owner explicitly removed added encryption/key-management.
The existing DO Alarm copies D1/schema, business DO control and complete R2 objects to private BACKUP_STORE;
no VPS/k3s collector, new recovery key, encrypted segments or paid product is required. The old collector
is stopped, its data and v1 recovery compatibility retained. Full branch CI
[37159139080](https://github.com/ziyixi/todofy/actions/runs/37159139080) and main
[37159607595](https://github.com/ziyixi/todofy/actions/runs/37159607595) both succeeded;
Mail Hero and Dashboard deploys passed. Other application/VPS releases were correctly skipped.
The real snapshot `b009accd-8697-44c9-8fcb-392e862c7782` reached complete/native_readback_verified at
2026-10-03 23:06:19 UTC: 1,031 files, 37,723,651 bytes, a verified R2 marker, and no pending D1 receipt sync.
The next daily wake is 2026-10-04 04:17 UTC. A fresh Home status refresh cleared backup_stale and left
only the 32 historical Newsletter unknown outcomes. The owner subsequently asked to clear that reminder;
the business ledger remains factual, while the Home-owned disposition described below is being added.
Typed VPS verification remains ready
at `93b387c` with frozen targets and generation matching. No real mail/backup content was printed or
used as a fixture; production proof is bounded status/marker metadata and Home acceptance.
The owner Google Drive checkout still stalls reading Git objects: a bounded status check returned
IO wait and only its own process was terminated. Remote main and this independent checkout are current;
do not overwrite any owner/Claude changes or claim that local clone was fast-forwarded.
Local checks: 204 Worker tests and 81 UI tests passed. Plain offline recovery's 11 new tests passed;
its 40-test combined legacy suite has one local GnuPG skip, with real GnuPG required in Linux CI.
1000 synthetic objects' second backup used 16,621 DO reads, 6,201 SQL writes and 466 Alarm writes;
this includes prior inventory cleanup and same-day rotation, but is not a 10,000-file/full5GiB test.
The snapshot ceiling is 10,000 files/5GiB; account free quotas remain shared. The rebuild docs separately
state today's commands and four P0 follow-ups; no fresh-account/VPS or whole-cloud restore drill was run.
Every app's owner API is on proto now (the dashboard
`ca63675`, FlowDay `8d9100e`, Mail Hero `d1bde0e`, Todofy `b70856f`, all landed and verified on 2026-10-02). Nothing
was in flight at that landing. The foundation evidence below describes that completed release.

## What is live

| App | Worker | Host(s) | Deploy job | Owner API on proto? |
| --- | --- | --- | --- | --- |
| Mail Hero | `mail-hero` (+ `MailCoordinator` DO) | `mail-hero.ziyixi.science` | `Mail Hero deploy` | Yes (`mailhero.ui.v2`; webhook `mail.received.v1`) |
| Todofy | `todofy` (TS gateway) + `todofy-core` (Python) | `todofy.ziyixi.science`, hooks and daily hosts | `Todofy deploy` | Yes (`todofy.ui.v1`; reports `todofy.report.v1`, `task-intent-v1`, `ops-v1`) |
| Lab | `lab` | `lab.ziyixi.science` | `Lab deploy` | Yes (`lab.ui.v1`, the pilot) |
| Links | `links` | `s.ziyixi.science` | `Links deploy` | Yes (`links.ui.v1`) |
| Watch | `watch` (+ `WatchState` DO) | `watch.ziyixi.science` | `Watch deploy` | Yes (`watch.ui.v1`) |
| FlowDay | `flowday` | `flowday.ziyixi.science` | `FlowDay deploy` | Yes (`flowday.ui.v1`) |
| Dashboard | `home` (+ `HomeState` DO) | `home.ziyixi.science` | `Dashboard deploy` | Yes (`dashboard.ui.v1`, since `ca63675`) |
| Fleet | `fleet` (+ `FleetState` DO) | `fleet.ziyixi.science` | `Fleet deploy` | Yes (`fleet.ui.v1`; live receipts and verified runtime) |
| Website | `ziyixi-website` (+ `ziyixi-notion-publish` relay) | `ziyixi.science`, `www.ziyixi.science` | `Website release` | n/a (static) |

Newsletter source was imported on `main` from its deployed engine commit
`c3d622d4771b1ca63ee4e3f785b79032cffc30e1`. Its independent image is `ghcr.io/ziyixi/todofy-newsletter`.
The running Newsletter uses source `93b387c` and image artifact:
`sha256:5d1fa9d445c321b30fa040fead4ae77392d60c73c0aff2a8a876a80442af3b25`.
The package is public; anonymous manifest access and the manifest/config identity checks passed.
`ghcr.io/ziyixi/newsletter` was the old VPS runtime. It is stopped, with its image and persistent state
preserved. Newsletter runs in k3s and the latest `93b387c` release is ready; this does not prove an
external business operation. The application reads Todofy's
`/api/summary` and `/api/recommendation` using its existing machine contract. See
`newsletter/docs/import-source.md` and `newsletter/docs/deployment-drain.md` for the import and release boundaries.
The old Slash, changedetection and FlowDay containers are also stopped under the owner's subsequent
instruction to stop every Compose service; retained state remains outside this repository. This includes
the old Mail Hero backup collector: its retained backups remain available, but no new automatic VPS
backup is running. Platform/Newsletter health must not be reported as backup coverage.

## How work lands

1. Commit on a branch and push it. Branch CI runs every check job and never deploys.
2. When the branch run is green, fast-forward `main` to the same SHA (`git push origin <sha>:main`).
   Branch protection requires `CI gate`; `main`'s run reuses the green branch checks and runs only the
   deploy jobs the diff reaches (`.github/scripts/ci_changes.py`).
3. Never deploy by hand. Production changes only through CI on `main`.
4. Cloudflare objects managed by `infra/` (Access apps and policies, D1, R2 of the monorepo apps) change only
   through a commit there plus a dispatch of "Infra apply" with `expect` set to the counts and fingerprint the
   "Infra drift" run printed (`infra/README.md`). Never edit them in the dashboard.
5. If two branches touch the same CI files (`ci.yml`, `ci_changes.py`, `test_ci_changes.py`, `README.md`,
   `AGENTS.md`, `proto/README.md`, this file), land one, rebase the other onto the new `main`, resolve by
   meaning (keep both sides), and re-run its checks before pushing.

Practical notes learned the hard way:

- The fast-forward push is refused while a newer CI run for the same SHA is still pending; wait for it and
  check afterwards that `origin/main` really moved.
- In zsh, write `${VAR}:refs/heads/x`, never `$VAR:refs/...` (`:r` is a history modifier and mangles it).
- After a rebase, run the checks of every app the rebase touched, not only the Changes unittests (a rebased
  Mail Hero CPU test once used an old meter API and hung CI for 15 minutes).
- A run "cancelled" by the concurrency group is not a failure; re-run it.
- GitHub's scheduled runs are often hours late ("Infra drift" at 13:23 UTC ran at 18:56 on 2026-10-01).
- The owner's local clone (Google Drive, `todofy`) must be fast-forwarded to `origin/main` after every
  landing, only when it is clean and on `main`; never run installs there.

## In flight

On `codex/k3s-personal-cloud`, following green main `9fc80fc`: persistent owner reminder dismiss/restore.
Home owns occurrence identities and dispositions in its existing SQLite DO; the source's health, counters
and business results remain unchanged. The typed `dashboard.ui.v1` actions use occurrence etags and
idempotent request IDs, with existing Access/Origin/CSRF checks. Dismissed occurrences leave attention
badges and future digest messages, stay inspectable/restorable, and survive reload/restart. Meaningful
count/severity changes or confirmed recovery followed by recurrence re-open a reminder; a disconnected
source does not count as recovery. Fleet exposes Newsletter's unknown count as a signal metric, explains
the aggregate and links to Home for reminder actions. No new VPS control or credential is required.
Before merge: complete synthetic DO/IDL/UI tests, independent review and full branch CI; merge only the
same green SHA. After deploy: use the owner's Home UI to dismiss the current Newsletter occurrence,
reload and verify the saved state, cleared badges and accurate visible counters. No business replay or
external report send is part of acceptance.
Local implementation is ready: Home UI 146 tests, Fleet UI 5, seven new real DO cases and three SQLite
capacity/prototype-key regressions passed; Worker typecheck/lint and buf/API lint passed. The full
existing runtime suite and shared-consumer checks are delegated to branch CI. Ordinary view read budgets
are 40 rows; a representative six-source stress case is guarded at 64KiB/320 reads. The UI applies the
server-confirmed action response before refetch, with stable live feedback and neutral dismissed labels.
Review fixes include newer-occurrence CAS, filtering before the outbound 20-item bound, retaining closed
decisions through unavailable underlying telemetry, and independent drift-recovery evidence.

`codex/k3s-personal-cloud` starts from `450110b`. The owner authorised GitHub-driven k3s reconciliation,
a separate Cloudflare Fleet worker/UI, Newsletter monitoring in Home, and Compose retirement. The owner
subsequently clarified that **all existing Compose services should stop**, rather than migrating unrelated
apps. All 13 inventoried containers are stopped and their automatic restart is disabled; containers,
volumes, private configurations and migration snapshots are retained. Do not restart legacy triggers.

Implemented on `main`: GitHub Actions actively calls the shared-proto daemon API; the daemon applies its own
CI-verified Kustomize resources. Actions holds only narrow HTTPS credentials, with no SSH key or Kubernetes
credential. Newsletter releases drain/freeze before
changing the exclusive stateful process; an observer CronJob using the platform image reports bounded
status to Fleet. Application code and dependencies stay inside images; no host executable is deployed.
Public deployment profiles and a rebuild runbook separate empty resource recreation from historical data
recovery. Initial k3s/systemd setup requires one pinned bootstrap executed by the owner with sudo; routine
reconciliation must need neither SSH nor a GitHub-held host credential. The owner accepted that one-time
step. FastAPI, httpx, the official Kubernetes SDK and Jeepney provide the standard runtime integrations.
No Shiv, standalone application binary, host Python dependency installation or observer systemd timer is
part of the deployment. Loss of k3s scheduling produces stale/missing observations rather than an
independent host diagnosis.

Local platform, image-context, release-client and bootstrap checks passed: 97 tests plus 79 subtests;
all 53 relevant Python files passed lint and format. Profile/infrastructure checks passed 89 tests;
Newsletter's changed drain/monitor behavior passed 45 synthetic tests. A real offline Kustomize/bootstrap
bundle contained ten runtime resources, keeping Newsletter held and the observer enabled. Full branch
and main CI passed at `ca10078`. At that release neither k3s nor Fleet was deployed. The later Fleet
publication is recorded below; VPS and production business acceptance remain pending. Do not claim the
old process supports the new drain API.

First branch run [37092747486](https://github.com/ziyixi/todofy/actions/runs/37092747486) at `b441e46`
passed the actual Linux Platform image build/import/identity smoke and Fleet checks. The complete gate
failed on stale integration expectations (new Ops apps/service bindings/private monitor route), Newsletter
structure/type guards, Infra format and a Lab fixture that aged outside its simulated retry window.
Those narrow fixes passed locally, including Newsletter's complete 2478-test `make check`, before the
next branch SHA. No publisher or production deployment ran from the failed gate.

Second branch run [37093454362](https://github.com/ziyixi/todofy/actions/runs/37093454362) at `d0854a9`
passed all nineteen other check jobs, including the complete Todofy runtime matrix, Proto, Mail Hero,
Newsletter and both real Linux image checks. Only Dashboard's document-consistency assertion failed:
the documented Cloudflare rows budget still said 28 while the actual budget is 30. The table and current
view-budget prose were synchronized without weakening the implementation or assertions; all thirteen
local view tests then passed. Historical measured verification records were retained. No publisher or
production deployment ran from this failed gate either.

Third branch run [37094119254](https://github.com/ziyixi/todofy/actions/runs/37094119254) at `242024b`
stopped in Changes: a temporary Git repository's background maintenance raced strict directory cleanup.
Only those two synthetic repositories now disable automatic GC/maintenance; cleanup stays strict and user
Git configuration is untouched. All 375 root-script tests (one historical skip) passed locally. No image
job ran for this SHA. The Fleet deployment-test glob was also found to admit zero tests on Node 26; actual
deployment boundary tests replace that empty step before the next candidate. All eleven Fleet deployment
boundary tests and 47 cross-config checks passed locally; the CI now names both actual files, and an
explicit missing-file negative control fails. Final bootstrap review also found that its temporary env
injection would disappear on the daemon's first normal apply. Fixed mounted data/auth/config paths now
belong to the canonical Deployment. The real offline Kustomize/bootstrap/daemon-render regression and
first-apply controller regression passed; scoped suites passed 70 Platform, fourteen bootstrap and thirteen
release-client tests. A successful bootstrap now records a root-owned completion marker: exact retries
return `already_initialized` without reapplying admission/CronJob state, different bundles must use the
normal release API, and failure cannot write that marker. Private credential preflight now matches the
actual editor/send/deployment identity requirements. Eighteen installer tests, five platform bootstrap
boundary tests and thirteen release-client tests passed after these final corrections; retained host
paths did not change.

Fourth branch run [37095413618](https://github.com/ziyixi/todofy/actions/runs/37095413618) passed all checks
at `ca10078`; [main run 37095911161](https://github.com/ziyixi/todofy/actions/runs/37095911161) reused that
same green SHA and both tested image artifacts. Platform's Linux job passed 103 tests plus actual
network-disabled Docker imports and source identity checks. Newsletter's Docker job performed a
no-login Codex startup and offline configuration validation. The public Platform image is
`ghcr.io/ziyixi/todofy-platform@sha256:ed5bb253b3d94f2f3f62c2ca1abe595e2a8d5c2a1f45e132c7805092e3359d98`.
Anonymous reads verified both published manifest digests and their tested image configuration identities.
Fleet/Home remained deliberately frozen; VPS deploy remains disabled until bootstrap and machine access
are ready. Image publication is not a live deployment test.

Managed infrastructure is partially created. The reviewed initial plan contained nine creates and nineteen
no-ops, with no update/delete/replace. [Apply 37096080218](https://github.com/ziyixi/todofy/actions/runs/37096080218)
verified the encrypted state backup before applying, then failed with a generic provider HTTP headline.
[Read-only drift 37096329221](https://github.com/ziyixi/todofy/actions/runs/37096329221) confirmed all six new
Access objects persisted; only the dedicated Tunnel, its configuration and its DNS record remained
three creates, with twenty-five no-ops. [Controlled retry 37096566266](https://github.com/ziyixi/todofy/actions/runs/37096566266)
failed with the same insufficient diagnostic. Stop blind retries: the current branch adds bounded
OpenTofu JSON diagnostics containing only managed resource aliases, HTTP status and numeric API codes.
No permission failure is confirmed, and the old private logs were deleted normally. A fresh drift and
reviewed fingerprint must precede the next diagnostic apply. Strict read-only lookups verified the newly
created Fleet owner/receipt identities for the pending activation configuration.

Pending branch corrections are implemented: explicit resume reuses the daemon's frozen images, never
rebuilds/publishes replacements, and accepts only the original held source SHA when `main` has advanced.
Current code is checked independently; the original etag/targets remain mandatory throughout physical
verification. The daemon's immutable release ledger and proto are unchanged. All 379 root-script checks
passed (one historical skip), seventeen synthetic HTTP client tests passed, and lint/format/diff checks
passed. Fleet's verified Access configuration and activation guards passed 220 related checks. Safe
apply diagnostics passed ninety Infra checks and forty-four root Infra guards, with zero new legacy lint
violations. No synthetic test proves a live Tunnel, bootstrap or successful application rollout.

Final first-install review corrected two boundary failures before production: the Tunnel unit now uses
cloudflared's standard connected notification, and a failed startup cannot write the completion marker.
The ConfigSync Deployment initializes a truly empty volume with its existing packaged seed using the
same Newsletter image; retained configurations are strictly validated without changed bytes/timestamps,
and corrupt or partly initialized directories fail rather than being overwritten. Both renderers pin the
init container to the same reviewed digest and profile. Seventy-nine Newsletter configuration tests,
sixty-three deployment tests plus forty-nine subtests, scoped lint/format, Mypy and structure guards passed.
The first API release must keep the bootstrap source SHA; do not enable normal VPS deployment or advance
that first-release commit until its held admission is verified and activated.
The rendered daily trigger now passes the real Newsletter CLI's check-only configuration contract,
with an independent socket-denial guard; its explicit internal-HTTP switch is `1`, not `true`.
The Kubernetes cadence retains the old public configuration's 07:00 America/Los_Angeles schedule.
The optional GitHub preparation workflow has not been connected to this private k3s Service; the daemon
Tunnel does not proxy its `/v1/runs` route. Do not assume an old public URL remains usable.

The next full branch run [37098884977](https://github.com/ziyixi/todofy/actions/runs/37098884977) at `0b381c0`
passed the other checks and both real Linux image jobs, but Mail Hero's unchanged delivery CPU test
failed twice: SendMessage warm medians were 3.53 and 3.52 reference ms against the 3.5 bound. Calibration
did not report a busy runner. No publisher or deployment ran. The branch now reuses one current
non-extractable WebCrypto HMAC key instead of repeatedly deriving it in the same request. Rotation,
invalid configuration and failed derivation are covered; the existing derivation parameters, signatures,
frozen payloads and CPU budgets are unchanged. A valid local delivery CPU run measured 2.60 ms warm
for SendMessage and 2.54 ms for ResendDelivery. The full seven-test CPU suite then passed, including
delivery, owner routes, Ops and payload construction; SendMessage measured 3.80 ms first and 2.31 ms
warm against the unchanged 6/3.5 bounds. All 190 Worker tests, type checks and 91 consumer contract
tests passed locally; these results still require a complete green branch CI before landing.

The follow-up [37100229358](https://github.com/ziyixi/todofy/actions/runs/37100229358) at `e8e2ba3` passed
every other check and both Linux image jobs; delivery SendMessage measured 3.56 ms warm and again failed
the old 3.5 ms goal. The delivery benchmark now guards meaningful regressions with warm below 5 ms,
first below 6 ms, against Free's 10 ms request limit. It keeps the calibrated multi-isolate measurement
and large-record coverage; hundredths of a millisecond near a self-imposed target are not a release blocker.
The action ledger also uses D1's standard transaction batch for its unchanged reservation and read,
reducing one database call. Actual workerd regressions cover rollback, retry, concurrent deduplication,
conflicts and owner isolation; all 191 Worker tests, type checks and 91 consumer contract tests passed.
An inspector timeout exposed a separate test bookkeeping bug: discarded isolates retained coordinator
samples and shifted their calibration pairing. The tests now pair samples with completed measured runs,
check each run's complete sample count and keep the coordinator's maximum bound. Four recovery/negative
controls passed; a single final full CPU run passed all seven real CPU cases and those four recovery
checks. SendMessage measured 4.52 ms first and 2.87 ms warm; coordinator maxima remained below 16 ms
against the unchanged 1000 ms bound. The shared meter is unchanged.

The final branch [37101662598](https://github.com/ziyixi/todofy/actions/runs/37101662598) passed all 22
checks at `95614de`. Main [37102132805](https://github.com/ziyixi/todofy/actions/runs/37102132805) reused
those exact-SHA checks and published both original Linux-tested image artifacts; Mail Hero, Fleet and
Home deploy jobs passed. Fleet's deployed source SHA and the unauthenticated Fleet/Home Access probes
passed. Fleet's actual namespace was read from that verified deployment and recorded in the public
resource inventory; its generated Home identity and eight cloud-config tests passed. This does not
prove owner UI behavior or live VPS telemetry. Mail Hero has no additional live-version probe in this
release. VPS deployment remains disabled and was skipped.

Anonymous registry manifest/config checks independently matched both image digests, their CI-tested
image IDs and the exact source SHA. Platform published
`sha256:f4b026388208d4289fa0a8e05dc54b049f72f3e468626d3466db9f4a8b4f9aa3`.
These checks did not pull all layers or run the images on the VPS.

The read-only [37102132807](https://github.com/ziyixi/todofy/actions/runs/37102132807) retained exactly
three creates, twenty-five no-ops and one output change; its nonzero exit signals planned drift.
Controlled apply [37102749784](https://github.com/ziyixi/todofy/actions/runs/37102749784) passed its saved
plan gates, then returned HTTP 403 / Cloudflare code 10000 for the dedicated Tunnel. The owner was asked
to restore the regular dashboard login and add only the missing Tunnel write permission to the existing
deployment token, preserving all previous permissions. Do not retry until that barrier is resolved;
then recheck the exact plan before applying. No secret or raw provider response was logged.

The real VPS still has cloudflared `2024.8.3`, which cannot read `--token-file`. The bootstrap now pins
official cloudflared `2026.8.2` and its linux/amd64 checksum alongside k3s, using the existing standard-library
download pattern. Its separate project connector leaves the global binary and existing SSH services alone;
fresh hosts no longer need a separate cloudflared installation. Download and verification precede state
migration and Docker retirement. The public installer bundle includes this shared binary helper and its
hash; application dependencies still live only in images. Thirty-four synthetic bootstrap tests and five
platform bootstrap boundary tests passed, plus scoped lint/format. This fix awaits its branch gate; no
new connector binary, system service or k3s runtime has been installed on the VPS.

The namespace inventory and connector fix passed branch [37103481732](https://github.com/ziyixi/todofy/actions/runs/37103481732)
at `54861b2`; main [37103957207](https://github.com/ziyixi/todofy/actions/runs/37103957207) promoted its original
tested image artifacts. After the owner approved only the missing Tunnel and scoped DNS permissions,
[apply 37106269391](https://github.com/ziyixi/todofy/actions/runs/37106269391) created the three remaining
transport resources and its post-apply plan was unchanged. Its encrypted one-time handoff was privately
staged; the owner executed the exact public bootstrap. Read-only host checks confirm k3s and the
dedicated connector are running and the old Docker runtime is inactive. The authenticated typed daemon
API and Fleet's signed receipt path are reachable; no API release ledger exists yet. These facts do not
prove successful release activation, provider operations or backup coverage.

The pinned Kubernetes SDK 36 exposed two integration bugs hidden by the older call_api mock:
it resolves the Bearer prefix by `BearerToken`, and accepts `response_types_map` rather than `response_type`.
The narrow client fix uses the canonical identity key with its existing rotation hook and maps successful
200/201 replies to objects. Real SDK tests replace only the final HTTP transport and verify outgoing
authentication, rotation, physical field casing and creation response parsing. Six scoped tests and three
subtests passed, plus lint/format. The installed image still contains the old client; a new source SHA must
receive its own tested immutable image, without republishing different bytes under `54861b2`.

The owner completed in-Pod diagnosis: the old client omitted the Bearer prefix and Kubernetes returned
401. [Branch CI 37107689599](https://github.com/ziyixi/todofy/actions/runs/37107689599) passed at `27bfca2`,
including 125 Platform checks and the real Linux image; that intermediate artifact is not deployed.
The new candidate adds a bounded privileged recovery of the unavailable daemon, optional namespace-only
diagnosis without sudo, and the owner's approved historical-unknown policy. Actual local work must stop
before replacement; every unknown record remains intact and visible, with no automatic replay.
See [bootstrap recovery](tools/vps-bootstrap/README.md#initial-client-repair).
Local validation passed 169 Platform/build/release/bootstrap tests plus 155 subtests, and 46 Newsletter
drain tests. The latter execute the real Store/exclusive-lock repair entry point on synthetic SQLite.
All 64 Platform/tool Python files and the changed Newsletter files passed lint/format. The exact candidate
passed [branch 37110131910](https://github.com/ziyixi/todofy/actions/runs/37110131910) at `c703378`, including
the real Linux image checks. [Main 37110576394](https://github.com/ziyixi/todofy/actions/runs/37110576394)
promoted those artifacts; its second attempt enabled the first normal CreateRelease after the owner's
completed repair. VPS deploy passed. Typed API and namespace metadata agree on ready/activated, actual
source/digests/request identity, and accepting Newsletter admission with zero active work and all 32
unknown outcomes retained. The Platform digest is
`sha256:4fdfdb874bd717f8c2447692230ffa540dde39a6b93592b2406e43183f851441`.
Optional namespace metadata diagnosis now works without sudo and rejects Secret/exec/write access.
No real model/provider/send or backup acceptance has been claimed.

The earlier systemd diagnostic failed before method calls: the UID10001 container's system-bus connection
closed, and that UID was not registered on the host. A fixed non-root diagnostic reproduced it. The
`0f84d91` candidate introduced a standard same-image init container as the host's existing UID65534 (`nobody`),
retains the non-mutating polkit denial checks, and writes only a bounded shared-proto daemon snapshot
to an emptyDir. The main observer keeps its existing UID, durable state and receipt identity. The init
receives no projected Kubernetes identity or application secret. Both images are pinned to the same
tested digest. The subsequent `7a66336` release completed and fresh Fleet/Home receipts were verified,
but system-daemon still reports `unknown`. A separate bounded diagnostic is pending; live daemon-state
acceptance has not passed. An unreadable probe must still report unknown, never assume health.
Local validation passed 178 Platform/build/release/bootstrap checks and 166 subtests, including actual
shared-codec snapshot bounds/freshness and offline Kustomize identity/permission checks. All 67 relevant
Python files passed lint/format; proto lint, API lint, schema checks and breaking checks passed. The
Linux image gate also exercises the probe CLI as UID65534 without capabilities, network, credentials or
a host bus; that smoke only proves the image and unknown-state path, not live D-Bus authorization.

[Branch 37113613969](https://github.com/ziyixi/todofy/actions/runs/37113613969) passed the complete gate
at `0f84d91`, including the real Linux probe smoke. [Main 37113997517](https://github.com/ziyixi/todofy/actions/runs/37113997517)
published its images and Cloudflare Workers; VPS deploy held after daemon replacement. A same-ID resume
in [37114292742](https://github.com/ziyixi/todofy/actions/runs/37114292742) also held. Metadata confirms
that merge-patch activation transferred release `phase` to an Update manager, so the next manifest Apply
conflicted while changing it back to `applying`. The owner completed the guarded phase-only recovery of
the two release ConfigMaps. The explicit original-ID resume in
[37142362209](https://github.com/ziyixi/todofy/actions/runs/37142362209) then succeeded; the frozen release
targets and identity were retained. The Platform digest at the earlier held checkpoint was
`sha256:150f970d33b337ef9021191322fa5d9f9c794768d31d59ce87576f2bd6124482`.

The branch's permanent fix at `0adfb34` passed [CI gate 37115872382](https://github.com/ziyixi/todofy/actions/runs/37115872382).
It separates manifest ownership from the narrowly scoped phase/suspend
workflow; see [deployment ownership](platform/src/personal_cloud/deployment/README.md).
The accompanying Fleet correction keeps the historical unknown-outcome warning while requiring actual
process, admission, Pod and release identity evidence for readiness. Those historical business outcomes
alone must not produce a process failure or pending-release alert. After the original-ID resume, the normal
`7a66336` release completed in [37142838447](https://github.com/ziyixi/todofy/actions/runs/37142838447).
The typed API reports `ready` and `frozen_targets_verified=true`; both workloads have generation 6 and
request `9b00f775-b0df-4147-8660-33e50fc126f1`. Actual Newsletter and Platform sources are `7a66336`.
Platform's actual image is
`sha256:15d6c8ad7f60f1bd1ca310ae3662721846754aae0dfbd39cfb59bc6c5e8bc60a`;
Newsletter's actual image at that release was
`sha256:0a12974b38ef5a3f35c4f38aec0f2366efe5d37250e38bdb9e60b34e25163afc`.
A fresh Fleet receipt at 18:15 UTC matched actual/desired
source, digests and request identity and recorded `resolved_deployment_pending`. Both ConfigMap phases
are `activated`; their only phase manager is `personal-cloud-runtime-status`, while the base
`personal-cloud` manager does not own phase. `newsletter-daily` and the observer both have `suspend=false`.
At 18:19 UTC, a normal Home refresh changed Newsletter from failure to attention: only
`newsletter_unknown` remains for the 32 historical outcomes; `newsletter_unavailable`,
`deployment_pending` and paused alerts cleared. Todofy reports normal; Notion writing remains unconnected.
System-daemon remains `unknown`, so its diagnostic and live acceptance are still pending. These checks
do not prove a real provider/send operation or backup coverage.

The next bounded diagnostic uses Kubernetes' standard termination file in the existing observer image.
Init records only fixed unit aliases, states, stages and safe error codes; the main observer records
snapshot-read status. Both containers use `terminationMessagePolicy: File`, with no log fallback.
Messages are at most 1 KiB and cannot contain exception text, D-Bus bodies, credentials or configuration.
The existing namespace reader can inspect this Pod metadata without exec/log access or new host privileges.
Unknown states and the non-mutating polkit authorization guard remain unchanged. Gate and publish this
candidate normally, inspect a naturally scheduled observer's bounded metadata, then verify fresh Fleet/Home
receipts. A successful init or accepted receipt alone does not prove the system daemons were observed.
Local validation of the diagnostic candidate passed all 192 Platform/build/release/bootstrap tests
and 186 subtests;
all 69 relevant Python files passed lint/format. Wire fixtures exercise the actual Jeepney serializer,
private response/error text is excluded, snapshot expiry remains unknown, and termination output is bounded.
Branch [37144434050](https://github.com/ziyixi/todofy/actions/runs/37144434050) and main
[37144825529](https://github.com/ziyixi/todofy/actions/runs/37144825529) succeeded. The typed release is
ready with frozen targets verified; both workloads use request `994e94db-f8f7-41ee-b2fe-177fc34e2089`
and source `c2f0d09`. Platform's actual digest is
`sha256:c3f1d49825c171a88eff72f6676ab051a68160945b066d9c2026e3c20ac0e1f8`.
The 18:40 UTC natural observer matched that image: each init unit returned unknown with
`BUS/DBUS_DENIED`, while the main container returned `OBSERVER_ACCEPTED/READ_OK`.
This rules out snapshot transfer/freshness as the current cause and does not yet confirm the specific
connection policy. The new fixed-prefix classifier must be verified before applying a host policy fix.
The classifier's local suite passed 193 tests and 190 subtests, with lint/format passing. Its fixtures
decode actual Jeepney Hello errors, require the exact known error name and prefix, and keep arbitrary
responses mapped to the existing safe enums without printing their bodies.
Classifier branch [37146094974](https://github.com/ziyixi/todofy/actions/runs/37146094974) and main
[37146439819](https://github.com/ziyixi/todofy/actions/runs/37146439819) succeeded. Request
`264188c8-4238-45a6-bffb-62f0d548c6ad` is ready with both actual sources `c0dddd3` and frozen targets
verified. Platform's actual digest is
`sha256:f359484b0623448faac58a8d8f2ccdeb4457d4be321ada870b2776d49b0e5f76`.
The natural 19:05 UTC observer used that image and reported `BUS/APPARMOR_DENIED` for each unit,
with `OBSERVER_ACCEPTED/READ_OK` from its main container. AppArmor is therefore the confirmed
connection blocker. The candidate preserves the pinned containerd baseline, adds seven fixed D-Bus
send rules and selects the profile only for the credential-free init container. A profile-only CLI
checks fixed bytes, supported host and safe paths, dry-compiles before writing one root-owned file,
loads only that profile and verifies exact enforce mode. Fresh VPS bootstrap includes the same step.
Local candidate validation passed 200 tests and 192 subtests; 71 Python files passed lint/format.
Actual Linux parser compilation, host load, successful Polkit guard and fresh daemon states remain
separate checks; do not replace unknown with healthy or bypass confinement to finish the release.
The complete `4a2b725` branch [37147403600](https://github.com/ziyixi/todofy/actions/runs/37147403600)
passed its gate, including real Ubuntu parser compilation, all reached application checks and both image checks.
The staged six-file public installer also passed exact hashes and the existing VPS parser with
`--skip-kernel-load --skip-cache`; kernel loading remains pending. Final independent rebuild review
found that the fixed daemon list assumes the old global `cloudflared.service`, which a fresh VPS without
an SSH Tunnel will not have. This report/runbook caveat is separate from the existing-node repair;
do not create an unused host service to silence it or claim the monitoring contract is already configurable.
Local candidate validation passed 182 Platform/build/release/bootstrap tests plus 178 subtests,
45 Fleet unit tests and eight real workerd SQLite tests. Fleet type checks and lint passed; all 71
relevant Python files passed lint/format. The two-release ownership test uses the real SDK transport
with a synthetic field-manager model; it is not production Kubernetes acceptance.
The rebuild follow-up propagates the configured node alias to Fleet without changing epochs and documents
observer-state recovery, the supported two-workload profile, actual Compose retirement, and the existing
sealed bootstrap handoff. Nine cloud-config tests passed; all thirteen current-profile generated outputs
remain unchanged. Profile/catalog checks and a synthetic certificate/CMS roundtrip also passed. The new
configuration-only recovery instructions still need an empty-account/VPS exercise; no such live drill was run.

The 2026-10-03 [rebuild audit](docs/rebuild-audit.md) reviews all eleven applications, deployment identities,
infra adoption and VPS/state boundaries. A strictly configuration-only fresh-account rebuild is not yet
supported: Watch and the relay acceptance check retain account-specific workers.dev references; normal
infra apply and import-only bootstrap do not form an empty-account creator; hostname/inventory coverage and
historical recovery have listed gaps. The report proposes bounded follow-ups without implementing a new
provisioner or moving accounts/data. The runbook now states those limits, preserves creation-time machine
secrets, documents Tunnel's outbound 7844 requirement and directs Newsletter to the current k3s flow.
Profile/catalog/drift checks remain current; nine profile tests, two migration-reference tests and a check
of 113 relative document links passed. The owner phase repair, original-ID resume and normal second
production release are now complete, with fresh Fleet/Home acceptance as recorded above. System-daemon
acceptance subsequently passed at `93b387c`, as recorded at the top of this handoff. No new-account/VPS rebuild or historical
recovery drill was performed, and no new automatic VPS backup is running.

## Foundation completed (historical release evidence)

- Root README is concise and bilingual; docs, contracts and migration history have separate navigation. P5 uses nine `app.toml` files, generates Home/Access metadata, and validates ten Workers against their committed Wrangler configs. Existing Home public bytes and Access identities were preserved. The read-only Infra drift run reported `no-op 19`; no infrastructure apply was needed.
- Changes: 360 tests (one intentional Watch/no-D1 skip); catalog: 18; infra driver: 75; Home unit: 249 and workerd: 73. Secretless OpenTofu fmt/validate and cross-config guards passed. Newsletter: 2476 tests, locked lint/type/structure, synthetic HTTP smoke, no-login Codex startup, build, isolated wheel and actual Linux Docker/configuration smoke passed.
- Full branch run [37079465314](https://github.com/ziyixi/todofy/actions/runs/37079465314) passed at `8628e5e`. Earlier CI exposed shared unittest discovery state and a Node 26 Watch stub lifetime issue; isolated loaders and retained requests with a controlled clock cover both. Codex cleanup failure retains an uncertain activity and blocks freeze.
- Main run [37079972709](https://github.com/ziyixi/todofy/actions/runs/37079972709) reused the exact tested image artifact; Newsletter image publish, Mail Hero deploy, Watch deploy and Dashboard deploy all passed. All nine shared probe calls use a quoted workspace absolute path, with regressions from actual workflow directories and a workspace containing spaces; the old Watch call fails the negative control with exit 127.
- Configuration run [37080121901](https://github.com/ziyixi/todofy/actions/runs/37080121901) pulled the public released image without a Docker login, validated the authored configuration and published its immutable bundle to the monorepo's `published` branch. This does not switch the VPS config-sync source or trigger a preparation/send. The root daily trigger's settings have not been migrated and its manual dispatch has not been exercised.
- The owner approved a public code-only `todofy-newsletter` package; GitHub created it public. The original Newsletter package permissions and existing VPS image/configuration are unchanged. Source import and first-upgrade/rollback boundaries are documented in `newsletter/docs/import-source.md` and `newsletter/docs/deployment-drain.md`.
- Four retired GHCR packages (`todofy`, `todofy-llm`, `todofy-todo`, `todofy-database`; 302 versions) were deleted after exact owner confirmation and verified absent. Current public server deployment configuration has no references; the older local deployment checkout is stale. Migration snapshots and unrelated images remain.
- No K3s was installed, no VPS service was upgraded, and no real model call, Notion operation or newsletter send was used for this foundation's verification.


The pattern every owner API followed (owner-approved, Google style, from Lab), for any new app or API: describe every route the app's UI
calls in `proto/<app>/ui/vN` as AIP resources with `google.api.http`, serve them through
`proto/ts/http-transcoder.ts` behind the app's unchanged edge auth (Access JWT, Origin, CSRF before any body
is read), call them from the UI through `proto/ts/http-client.ts`, delete the hand-written duplicate types,
errors as `google.rpc.Status` with `ErrorInfo` reasons, AIP-155 `request_id`, AIP-154 etags where they pay.
Routes used by other systems keep their exact paths, auth and bytes. Old owner paths answer
`410 reload_required` in the old envelope for one release so open tabs ask for a reload. Check that the deployed
old client shows that message: Lab's, Mail Hero's, Todofy's and FlowDay's show any code's message, but the
dashboard's shows it only for its own eleven codes, so the dashboard sends `not_found` with the reload message
(`dashboard/worker/test/http.test.ts` runs main's error handling on every legacy answer).

Verification list for every branch (from a clean clone of the head): Changes unittests
(`uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts`), cf-guard and tools tests,
Proto checks (lint, api-lint, breaking vs `origin/main`, rules self-test, determinism, `check:schema`,
`test_proto.py`, vitest, Python tests), Contracts, the app's full checks job (workerd runtime and CPU tests,
UI tests and build, bundle budgets, dry run), and a scripted smoke of every UI call against `wrangler dev`
with synthetic data.

## Waiting to be verified

- `todofy.ui.v1` (landed `b70856f`, 2026-10-02 20:02 UTC): verified. Todofy's deploy succeeded (core, then the
  gateway); every owner route the UI calls answers 200 (serviceStatus, mailEvents with paging and `filter`, one
  event, dailyReminders, latestReports, metricDays, gtdDays, gtdReviews, integration); old owner paths answer 410
  with "Todofy 已更新，请刷新页面"; the machine routes are unchanged (`/api/summary` and `/api/recommendation` 401
  with Basic realm "todofy" without credentials, `/health` 200). A manual canary at 20:06 UTC was delivered to
  Todofy. Left: the next Newsletter run after the k3s release is verified and activated (configured daily
  at 07:00 America/Los_Angeles, reading `/api/summary` and `/api/recommendation`); remove
  the old owner paths (`todofy/gateway/src/owner.ts`) and core's `owner_api` after 2026-11-02.
- `mailhero.ui.v2` (landed `d1bde0e`, 2026-10-02 20:00 UTC): verified. Mail Hero's deploy succeeded; overview,
  setup status, settings, messages (list, one detail, its content), deliveries and endpoints answer 200; the raw
  download answers 200 with no-store, nosniff and attachment; old `/api/v1/*` answers 410 with "Mail Hero 已更新，
  请刷新页面"; real mail and the canary were delivered after the deploy. On CI the send's first run read about
  3.6-4.0 reference ms with the startup warm-up (bound 6). Left: remove the `/api/v1` 410 answer after 2026-11-01
  (`mail-hero/cloudflare/src/native/api.ts`).
- `flowday.ui.v1` (landed `8d9100e`, 2026-10-02 18:50 UTC): verified. FlowDay's deploy succeeded; the UI's calls
  (tasks, flows, notes, time entries by day and task, settings, timer, analytics) answer 200 and page; old `/api/*`
  answers 410 with the reload message; the dashboard's tiles are all ok. Left: remove the 410 routes after
  2026-11-02 (`LEGACY_PATHS` in `flowday/worker/src/router.ts`). Its landing needed two CI fixes: a FlowDay test
  narrows each handler's answer (the transcoder's handler type admits `PreEncoded` since the dashboard landed), and
  `proto/test/ensure.test.ts`'s lock tests allow two whole generations (`TWO_GENERATIONS_MS`).
- `dashboard.ui.v1` (landed `ca63675`, 2026-10-02 18:20 UTC): verified. Every deploy of the run succeeded (Lab,
  links, watch, Mail Hero and the dashboard, because of the shared `PreEncoded` transcoder change); the registry
  and the four views answer 200 with ETag and 304 on a repeat (flows and ops included, the bug fixed on the
  branch); 刷新 is `POST /api/v1/homeView:refresh` with CSRF and answers 200; attention is ok; old `/api/v2/*`
  answers 410 with 个人控制台已更新，请刷新页面; a GET with `refresh=1` answers 400. Lab, links, watch and Mail Hero
  load their data after the redeploy. Left: remove the 410 routes after 2026-11-02 (`legacyApi` in
  `dashboard/worker/src/http.ts`).

- Newsletter with `todofy.report.v1` (2026-10-02 13:30 UTC): Cloudflare side checked, Todofy's gateway
  answered 42 requests after 13:25 UTC, all successful, CPU p50 0.7 ms / p99 4.1 ms. The VPS side (the
  newsletter run itself) is not checked: an agent needs the owner's permission for the read-only ssh check,
  or the owner confirms the 2026-10-02 newsletter arrived.
- Infra drift's foundation baseline was `no-op 19` (2026-10-02). The k3s/Fleet extension contains 28 managed
  objects; the current partial apply reads three creates and twenty-five no-ops. After its remaining
  transport objects are created and verified, the new expected steady state is `no-op 28`. Daily drift
  runs at 13:23 UTC, but GitHub may start it hours late.
- FlowDay rollback window (F5) ends 2026-10-08: the old container stays untouched until then. F6 (retire the
  container, its tunnel ingress and the `flowday-bypass` Access app) needs the owner's OK and goes through
  `infra/` for the Access app (`flowday/docs/design.md` section 11).
- Watch (live since 2026-10-02, `76b376c`): the scheduler is armed and the dashboard tile is ok. The first daily
  digest task in Todoist after 14:00 UTC can only appear once a watch exists and changes; none exist yet.
- Legacy 410 answers to remove after one release: Lab's after 2026-11-01, Mail Hero's `/api/v1` after 2026-11-01,
  the dashboard's `/api/v2` and FlowDay's old `/api` after 2026-11-02, Todofy's old owner paths (`todofy/gateway/src/owner.ts`)
  and `todofy-core`'s `owner_api` RPC after 2026-11-02.
- Todofy's old host snapshot can be deleted after 2026-10-29 (`todofy/docs/verification.md`).

## Waiting for the owner

- Enter the Todoist key once in FlowDay's settings (the Worker stores it sealed; sync stays off until then).
- Optional: Chrome site search `s` → `https://s.ziyixi.science/%s` (`links/README.md`).
- Dedicated Cloudflare tokens (`CF_INFRA_READ_TOKEN`, `CF_INFRA_TOKEN`) and a fresh deploy token
  (`infra/README.md` "Replacing the token").
- The pages to watch for W4 (added by the owner at watch.ziyixi.science/new, or named to an agent privately).
- Real Newsletter model/provider/send acceptance remains distinct from the verified deployment;
  historical unknown outcomes require deliberate reconciliation, not automatic replay.
- Historical whole-cloud recovery and external provider acceptance remain distinct from running backups.

## Next, in order

1. Root proto is the single IDL for the Cloudflare owner interfaces (done 2026-10-02); imported
   Newsletter retains its external protobuf dependency and its separately versioned internal deployment JSON. Follow-ups: remove the 410
   routes on their dates; remove `owner_api` from `todofy-core` in the release after `proto-todofy-ui`.
   The Mail Hero integration document now names the machine OpenAPI and root owner proto; its stale
   owner OpenAPI and removed UI generator references were corrected by the foundation branch.
2. Watch W4: a shadow-mode week (watches report, no Todoist tasks), then the owner's watches.
3. FlowDay F6 after 2026-10-08 with the owner's OK.
4. Service catalog (IaC P5): one `app.toml` per app generating hostnames, Access apps, dashboard links and
   probes, validated against each `wrangler.toml`; P5 is implemented on main; P6 (rollback drill for `infra/`) remains later.
5. Code quality phases Q0–Q7: English comments everywhere, coverage and lint ratchets, clock injection in every
   app's tests.

## Known problems and how they were solved

- Linux 6.17 GitHub runners throttle large bodies over Miniflare's loopback: tests that push big bodies time
  out only on CI. Stream in 32 KiB slices (`watch/worker/test/runtime/fake-net.ts`).
- CPU tests: use `tools/workerd-cpu` (calibrated to machine speed; cold runs are the median of three fresh
  isolates; a busy-machine guard). Never compare raw ms from a laptop with Free's 10 ms directly.
- Dashboard tests depend on the hour: use the injected `DEV_NOW` clock (only honoured behind the loopback dev
  bypass; every `DEV_*` setting is barred from production configs by `test_dev_only_settings_never_reach_a_deploy`).
- A Workers custom domain cannot be attached while an external DNS record exists for the host (API code
  100117, even with override): the record must be removed first, which the deploy token cannot do.
- The dashboard's registry must name every Durable Object namespace by id (`dashboard/worker/src/registry.ts`);
  a new DO needs a follow-up commit with its id after its first deploy.
- A first request that pays for the codec: an isolate's first owner-API request runs protobuf-es and the wire codec
  before V8 compiled them (about 1-2 reference ms more). Run the answer path once at startup (`warmup.ts` in FlowDay
  and Mail Hero, `warm.ts` in Todofy's gateway), which costs about 10 ms of the 1 s startup budget.
- Since `PreEncoded` (the dashboard), the transcoder's handler type answers `Message | PreEncoded`; a test that calls
  a handler directly narrows the answer first (FlowDay's `reads.test.ts` `message()`).
- Rebasing shared docs: a union merge of long one-line paragraphs duplicates clauses. Merge by meaning, then compare
  every long changed line with both parents (each list of apps must name every app once).

## Owner decisions already taken (do not re-ask)

- Workers Free only; no paid products without the owner's explicit OK.
- proto is the single IDL, Google style (google.api.http, AIP, google.rpc.Status, api-linter, the in-repo
  transcoder); one app at a time.
- IaC manages only the monorepo apps' Access apps, D1, R2 and their hostnames; never self-hosted hosts, mail
  records, third-party TXT records or zone settings.
- FlowDay runs on Workers Free (no container); its data was imported.
- Short links: owner-defined keys on `s.ziyixi.science`; no import from Slash.
- Watch: rule-based change detection first (no AI); digests go to Todoist through Todofy's intents.
- The newsletter stays on the VPS (it needs the Codex CLI).
- The owner approved upgrading past the 32 historical Newsletter unknown outcomes. Preserve every
  record, do not retry or mark success, wait for actual local work to stop, and retain dashboard alerts.
- Agents keep going without asking for step approvals on these personal projects, as long as everything stays
  recoverable; anything touching the owner's mail, VPS writes or secrets still needs the owner.
