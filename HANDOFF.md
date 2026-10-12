# Handoff

Updated 2026-10-11. Keep this file focused on active work, open acceptance and dated compatibility constraints.
Move completed rollout detail to a dated record and link it here. Repository rules are in [AGENTS](AGENTS.md);
service entry points are in [README](README.md). Never put private content, credentials or raw production output here.

The complete previous handoff is preserved in [the October 11 archive](docs/history/handoff-2026-10-11.md).
Its old waiting lists and release identities are historical, not instructions to repeat completed work.

## Current work

Recall mobile and multi-device preparation is deployed at `0fe663a`: independent named upload tokens,
device-aware timeline/status, an Orion file-install build and bounded native JPEG fallback. Existing Chrome identity,
shared token, privacy rules, snapshot deduplication and the unified Dropbox archive remain.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38193778901) and
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38194203995) passed. GitHub Deployment `7004923541`
verified Worker `0c9f27be-d2c9-4556-8a7a-333b8a55d834`. Both extension assets are version `2026.1012.158`, built
from this SHA. The Mac's stable installation files were updated with its existing key and settings retained; the
browser tool blocks extension-scheme URLs, so its newly running version was not independently read from Chrome.
Read-only production UI checks confirmed the existing public test snapshot still renders and an empty synthetic
device filter reveals no other device's visits. No production token was created or changed for testing.
Actual iPhone installation, visible/hidden events, capture and upload remain the short owner acceptance step in
[the mobile runbook](recall/docs/mobile.md). No new service or dependency. The measured 125.2 KiB Worker bundle
intentionally raises its code-size budget from 125 to 130 KiB; runtime, daily write and monetary budgets are unchanged.

Recall's personal snapshot update is deployed at `de4d561`: first capture after ten seconds, minute sampling,
viewport WebP, seven-day R2 files with FTS kept, and Dropbox reads for archived content. With unchanged text,
the approved 32×32 comparison skips minor picture changes and compares against the last saved image.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38185361002) and the
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38185811434) passed. The first release attempt
uploaded successfully but its version-detail read failed; attempt 2 verified version
`5ff5cde9-11cb-4160-97d6-04c7648b25c3`, Deployment `7003619381`. Extension `2026.1011.2346` is installed
and its displayed SHA was checked. On October 12 UTC, authorized temporary idle simulation in real Chrome
verified capture/upload/display, equal rendered reader text with changed scrolling screenshots, and no repeated snapshots:
three snapshots, newest at 01:08 UTC, despite a later eligible attempt at 01:10:21.453 UTC. Both stored and actual
idle were restored to `idle`, with no open visit; no formal privacy setting or application code changed.
[Verification and its simulation boundary](docs/recall-snapshot-verification.md). No owner-input step remains
pending. No new service, dependency or budget change.

Mailsort flat English labels and Settings' classification-effect check are deployed at `4a48878`.
[Branch CI](https://github.com/ziyixi/todofy/actions/runs/38177634581) and the
[same-SHA release](https://github.com/ziyixi/todofy/actions/runs/38177844303) passed; Deployment `7002296191`
verified Worker version `8fad8b3c-c3a0-4a91-856f-42aafe9bb6a0`. The authorized private production consolidation
completed on October 11 at 21:53 UTC: 15 internal categories became 12 active English labels. UI checks confirmed
current labels in the list, overview, undo filter and existing replay results, retained learning/settings, and live
mode with Gmail write access. The next natural sync was visible after completion. No production replay was started.
The owner excluded reverse migration and special historical undo; there is no new service or dependency.
[Operation and dated evidence](mailsort/docs/label-consolidation.md#2026-10-11-上线与生产整理) records the pending-label
fix, validation limits and intentional 140 KiB application bundle budget. CPU, model and Gmail write budgets did
not change. `codex/mailsort-label-verification` closes the documentation; no Mailsort implementation remains open.

No implementation remains open from the October 11 maintenance task. `codex/maintenance-simplification`
landed at `ccf2c27`: concise handoff, checked test-only release exclusions and parsed YAML boundary assertions.
[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38161463808) and
[same-SHA main CI](https://github.com/ziyixi/todofy/actions/runs/38162014695) passed. Main skipped every app
release, image publication, VPS bundle and VPS deploy. Application settings and runtime code were unchanged.
[Maintenance evidence](docs/history.md#october-11-maintenance-simplification) records the local checks and scope.
The branch's final follow-up only records these verified results. Check for owner/agent changes before new work.

## Last verified releases

These are dated observations, not a replacement for current GitHub Deployment records or fresh Fleet/Home receipts.

| Scope | Verified result | Evidence |
| --- | --- | --- |
| CI structure, October 11 | `21c358f` passed branch CI and the same SHA on main. Local composite actions retain explicit job dependencies and release boundaries. Reconcile fell from 128 jobs to 18. | [Branch](https://github.com/ziyixi/todofy/actions/runs/38134080448), [main](https://github.com/ziyixi/todofy/actions/runs/38134511298), [reconcile](https://github.com/ziyixi/todofy/actions/runs/38134699837) |
| VPS, October 11 | Deployment `6994687990` verified Newsletter and Platform at `21c358f`, `phase=ready`. Their exact digests are in the archive. No Newsletter runtime changed in that release. | [Release evidence](docs/history/handoff-2026-10-11.md#done-2026-10-11-ci-workflow-structure) |
| Brief and Home, October 11 | `ebf33fe` deployed both applications. Brief's namespace is registered; Ops reports healthy. Read-only UI checks preserved `MODE=archive` and the owner's saved monthly budget of **$80**. | [Release](https://github.com/ziyixi/todofy/actions/runs/38132200435), [inventory/reconcile](https://github.com/ziyixi/todofy/actions/runs/38132419031), [detailed evidence](docs/history/handoff-2026-10-11.md#done-2026-10-11-brief-resource-registration-and-home-monitoring) |
| Recall, October 11/12 UTC | `de4d561` deployed the snapshot UI and seven-day hot files; CI includes real DO/R2 and fake-Dropbox cold reads. Updated extension passed real Chrome capture, visual-change and deduplication checks with an authorized temporary idle simulation, since removed. | [Release](https://github.com/ziyixi/todofy/actions/runs/38185811434), [verification](docs/recall-snapshot-verification.md), [runbook](recall/README.md) |
| Mailsort, October 11 | `4a48878` verified 12 English labels after production consolidation; live mode and existing learning/settings retained. | [Release](https://github.com/ziyixi/todofy/actions/runs/38177844303), [dated evidence](mailsort/docs/label-consolidation.md#2026-10-11-上线与生产整理) |

The CI refactor exercised every Worker's production preflight/no-op but selected no Worker uploads.
On the next normal release of an affected app, check its verified provider receipt; do not deploy apps just to
fill that evidence gap. The checked recipes and local/branch dry-runs are recorded in the archive.

## Open acceptance

### Waiting for an existing permission request

Both follow-ups below are blocked by the existing Cloudflare token's Observability/log-query permissions (403).
The owner request is already pending. Stay quiet while it is unchanged: do not repeat denied queries, switch
credentials or channels, recompute real content or substitute manual triggers. Once permission is confirmed,
read only the specified invocation/log metadata; if the old window expired, observe the next natural task.
Update each verification document through the normal branch CI and same-SHA release, then stop its own follow-up.

- **Todofy email models:** release `26c9662` keeps email/Canary on Lite 3.5, Flash 3.8, Flash 3.7; reports use
  Flash 3.8, Flash 3.7, Lite 3.5. A real synthetic Canary used Lite. October 5's Top 10 at `13:40:00Z` and summary
  at `13:40:19Z` both returned nonempty `ok` results from `gemini-3.8-flash`. The report ledger has no trigger
  source. Correlate the corresponding `todofy-core` Alarm invocation, time, outcome and version without reading
  report or task content. [Email-model evidence](docs/email-model-verification.md).
- **Website daily sync:** October 5 run `37295602784` and October 6 run `37448792826` match successful
  `SYNC_UNCHANGED` receipts in the daily 10:17 UTC window. Home showed the matching check time and Actions link;
  publishing was skipped. A manual dispatch can also carry the `cron` label, so correlate the relay's existing
  `daily_sync` log (`run_id`, `state`, `error_code`) to establish independent scheduled-controller provenance.
  [Website-sync evidence](docs/website-sync-verification.md). Do not alter reminder dismissal state.

### Remaining observations and separate follow-ups

- The October 11 Mailsort release exposed unsupported direct `vars` expressions in release composites. Its
  own action now inherits the existing workflow job environment. The same direct-expression pattern remains in
  `release-todofy`, `release-mail-hero`, `release-dashboard` and `release-brief`; those were not changed or deployed
  by this task. Review their input boundaries before their next actual upload; a preflight/no-op does not test
  loading the skipped composite.
- Brief's fresh Ops status and Actions inventory passed, but Home's daily REST Worker list still predates its first
  deploy. Observe the normal inventory starting **2026-10-12 02:00 UTC / October 11 19:00 PDT**; it should add Brief
  before the per-Worker checks finish. A usage refresh alone does not refresh this list.
- Brief still needs archive-day acceptance of source coverage, editorial quality and actual model cost. Local checks
  used fake Claude/Resend responses. Preserve archive mode and $80; sending, shadow-mode changes and Newsletter
  retirement require separate owner decisions. Topic `geo.earth` remains at the design's 熟悉 setting pending any
  owner change. See [Brief design §16](brief/docs/design.md) and [README](brief/README.md).
- Home's account-audit change reporting was deployed at `a3705ed`; the recorded follow-up is to confirm a completed
  daily check shows a qualifying dashboard change once as 非 CI 改动. The old handoff contains no final observation.
  [Recorded scope](docs/history/handoff-2026-10-11.md#in-flight-2026-10-06-claude-home-reports-account-changes-made-outside-ci).
- Bootstrap and safe drift repair are implemented and verified in the existing environment. Real empty-account /
  clean-VPS setup, physical DNS restoration, actual host-entry recovery and full historical data recovery remain
  separate exercises. Follow [the current rebuild runbook](docs/rebuild.md) and
  [its verification table](docs/rebuild-verification.md), which supersede the October 3 audit's implementation gaps.
- Older app acceptance has not been rechecked by this maintenance task: Watch's first real changed-watch digest,
  FlowDay's owner setup/device check before F6 retirement, and Newsletter's natural provider/send acceptance after
  its last business change. Use the app runbooks and fresh status before treating an old waiting item as still open;
  do not restart Compose, replay a send or request credentials solely from an archived note.

## Operating boundaries

- Workers release independently from committed Wrangler configuration. `config/cloud.toml` is the public deployment
  profile; generated `config/resources.toml` records resource identities. Use the configuration/bootstrap tools and
  `infra/` for their declared resources. Preserve root mail records and unrelated resources.
- GitHub Actions actively deploys the Newsletter/Platform images by digest through the typed daemon API.
  It holds no SSH key or Kubernetes credential. All legacy Compose services are stopped; keep their retained data
  and do not restart their triggers. Newsletter remains an independent VPS service until the owner retires it.
- Mail Hero backup runs natively in Cloudflare through its existing DO Alarm and private R2. The old VPS backup
  collector is stopped. [Native backup](mail-hero/docs/native-backup.md) separates snapshot success from restore proof.
- Brief's paid Claude calls can run in archive mode, but email is disabled. The stored $80 budget is distinct from
  the code's initial default and any Claude Console limit; preserve it. Owner-supplied Claude/Resend keys never
  pass through GitHub. Workers Free and existing application budgets remain in force.
- Keep Home's persistent alert dismissal. Historical unknown business outcomes are not automatic replay permission;
  read-only Newsletter timeout rows were settled by their explicit migration. Follow current
  [dashboard-state semantics](docs/dashboard-state.md), not the archive's earlier alert instructions.

## Dated compatibility and retained data

The authoritative [compatibility table](docs/history.md#owner-api-compatibility) defines the old-client responses:

| Surface | Earliest removal |
| --- | --- |
| Mail Hero legacy owner routes | 2026-11-01 |
| Home, FlowDay and Todofy legacy owner routes | 2026-11-02 |
| Mailsort v1 owner routes | 2026-11-10 |

Keep Todofy core's `owner_api` RPC until the corresponding gateway compatibility window is complete.
Dates permit a reviewed follow-up; they do not schedule deletion or authorise changing frozen webhook bytes or
migrations. Todofy's retained host cutover snapshot stays through **2026-10-29**; deletion remains a separate action
([verification](todofy/docs/verification.md)). FlowDay F6 teardown also remains an explicit owner action even though
its original rollback window has elapsed.

## Working and maintenance entry points

- [CI/CD](docs/ci-cd.md#where-to-change-the-pipeline): job/recipe ownership, checks, release selection and failure navigation.
  Push a branch, wait for the complete gate, then promote the same green SHA. Rebase or new commits require new checks.
- [Rebuild](docs/rebuild.md), [Cloudflare bootstrap](tools/cloud-bootstrap/README.md),
  [VPS bootstrap/recovery](tools/vps-bootstrap/README.md), [infra](infra/README.md): current operating commands.
- [Documentation guide](docs/README.md), [architecture](docs/architecture.md), [service catalog](docs/service-catalog.md),
  [proto](proto/README.md), [contracts](contracts/README.md): canonical boundaries and application entry points.
- [History](docs/history.md) and [the archived handoff](docs/history/handoff-2026-10-11.md): previous releases,
  failures and recovery evidence. Keep completed details there when closing work here.
