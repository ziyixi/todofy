# Handoff

Updated 2026-10-28 UTC. Current work describes in-flight and unreleased work in detail; released work moves to a
dated record under `docs/history/` and is linked here, without run-ID ledgers. Rules are in [AGENTS](AGENTS.md);
entry points in [README](README.md). Never put private content, credentials or raw production output here.

Archives (their waiting lists are not instructions): [October 27](docs/history/handoff-2026-10-27.md) (Model Router
cutover, Codex gateway and 6.1 runtime, shared workspaces, Mailsort providers and intake, Tasks planning, GTD and
Goals, Mail Hero backup writes, the configuration-drift fix, Watch evidence),
[October 22](docs/history/handoff-2026-10-22.md) (Tasks UI refinement and approved interface),
[October 21](docs/history/handoff-2026-10-21.md) (the Private MCP, Boundary B, done steps in Plan, the Tasks PWA
features, the FlowDay retirement), [October 20](docs/history/handoff-2026-10-20.md),
[October 19](docs/history/handoff-2026-10-19.md), [October 18](docs/history/handoff-2026-10-18.md),
[October 11](docs/history/handoff-2026-10-11.md).

## Current work

### ZFS ARC in Fleet memory (`claude/observer-zfs-arc`, not merged)

On a ZFS host Fleet overstated memory pressure: used was total minus MemAvailable, and MemAvailable leaves out the
ARC although the kernel shrinks it under pressure. The observer now adds the ARC above `c_min` (the htop/btop rule)
to available memory, at most the total, read from the kernel-wide, world-readable `/proc/spl/kstat/zfs/arcstats`
with no new mount (it is not among the runtime's default masked paths).
A missing, unreadable or malformed table keeps MemAvailable alone. The heartbeat's `memory_used_percent` (Fleet's
`memory_high`) uses the same reading. Wire shape unchanged; only the `available_bytes` description in the IDL and
generated schema says so ([observer](fleet/observer/README.md)).

- Done: synthetic tests (present, absent, malformed, `c_min` above size, capped at total; node metrics and heartbeat),
  platform pytest/ruff, observer unittest, proto lint/breaking/tests, Fleet worker typecheck/tests.
- Release: Fleet (IDL comment only) and the platform image, in the usual order. After deploy, the next observer
  report on the ZFS host shows lower memory used than before; an unchanged value means arcstats was unreadable there.

### Fleet node telemetry (`claude/fleet-telemetry`, released with this merge)

Owner request 2026-10-28: per-node CPU, memory, load, disk, network and per-workload usage with history in Fleet,
built in rather than a host monitoring service. Backend and UI done on the branch:

- `fleet.telemetry.v1.NodeMetrics` (optional `HostReport.metrics`), contract fixture `node_metrics.json`; the observer
  reads kernel files, statvfs and `pods.metrics.k8s.io` (`platform/src/personal_cloud/observer/metrics.py`) with new
  read-only mounts in `observer.yaml` ([host boundary](platform/systemd/README.md)).
- Fleet derives rates at ingest and keeps 5-minute/hourly/daily tiers in its SQLite DO; owner API `ListNodes`,
  `GetNode`, `SummarizeNodeMetrics` ([Fleet README](fleet/README.md#节点遥测)). `disk_high` also covers the new
  filesystems.
- Order: Fleet accepts reports with and without metrics, so the usual Fleet-before-platform-image order holds.
  Workload usage needs the bootstrap RBAC rule in `platform/k3s/bootstrap/rbac.yaml`; until it is applied the
  reports carry no `workloads` and everything else works.
- UI (`fleet/web`): tabs 概览 / 资源. 概览 leads with host freshness and per-node tiles (CPU, memory, disks, network,
  load, uptime); an older observer's report shows its two legacy percentages and everything else as 未知. 资源 draws
  hand-rolled SVG charts per node for 24 小时 / 7 天 / 30 天 / 180 天 / 2 年 (gaps never bridged, local time, hover
  and arrow keys for exact values, a table per chart) and per-workload small multiples. No chart library; light only.
- After deploy: the next observer report carries `metrics`; the second one gives CPU and network rates.
  Live acceptance still has to show the PID 1 `net/dev` mount reports the host's interfaces from inside the Pod.
  A hostPath that cannot be mounted stops the whole observer Pod, so check that the first run after the platform
  deploy still lands a heartbeat (Fleet shows `missing` otherwise); any other telemetry failure only drops `metrics`.

### Fixed K3s node address and DNS (on `main` since c3ce7478; host migrated 2026-10-28)

On 2026-10-27 the host's DHCP lease changed. K3s kept the Node InternalIP and the `default/kubernetes` endpoint on
the old address, so every in-cluster API client (the release and status daemons) failed and VPS releases are held at
`UNAVAILABLE`; host-local kubectl and the business Pods kept working. The owner ruled this an architecture bug, not
something for a restart hook, and ruled that the cluster must not depend on anything DHCP hands out. The branch
makes both the node address and cluster DNS independent of DHCP
([design and runbook](docs/rebuild.md#主机地址变化), [bootstrap](tools/vps-bootstrap/README.md#fixed-node-address-and-dns)):

- A one-shot `personal-cloud-node-address.service`, which `k3s.service` requires, creates or keeps the dummy
  interface `pcloud0` with `10.254.0.42/32`. K3s sets `node-ip` and `advertise-address` to it and `flannel-iface` to
  `pcloud0`; `node-external-ip` stays unset. A NetworkManager drop-in marks only `pcloud0` unmanaged.
- `PCLOUD-K3S` admits cni0 Pod traffic to 6443/10250 only at that address; LAN and Internet stay dropped.
- CoreDNS (`dnsPolicy: Default`) used to forward to the DHCP-provided DNS servers its Pod copied at creation. K3s now
  sets `resolv-conf` to a root-owned `/etc/rancher/k3s/resolv.conf` with `1.1.1.1`, `1.0.0.1` and `8.8.8.8` (IPv4,
  unfiltered, two operators). After K3s runs with it, the pod-template annotation `personal-cloud/upstream-dns` makes
  the CoreDNS Deployment replace its Pod once (a few seconds of cluster DNS pause); an equal value replaces nothing.
  The daemon's own Pod then resolves the Fleet host. Lookups are forwarded Pod traffic; the firewall is unchanged.
  Before any write the migration also queries each resolver directly from that Pod and stops with
  `CLUSTER_DNS_UPSTREAM_UNREACHABLE` if one never replies (`unchecked` while the Pod is unreachable).
- Fresh install, `recover.py` and the new `installer/node_address.py` apply both. Recovery accepts an installed bundle
  that predates the address or the observer AppArmor profile (the original install bundle has neither, so recovery
  could not read it before) and still refuses any other host difference.
- Synthetic tests cover the rendered files, firewall verdicts, migration, interrupted retry, conflicts, rollback and
  recovery, including the CoreDNS replacement, its rerun, a blocked public DNS stopped before any write and one
  undone by rollback. The CI k3s
  fixture is API-only (`--disable-agent`, no CoreDNS), so it cannot exercise node-ip, flannel, CoreDNS or the Pod
  path; the K3s behaviour (node-ip and advertise-address in the serving SANs, advertise-address defaulting to
  node-ip, flannel-iface by name, resolv-conf passed unchanged to the kubelet, which reads it for each new Pod, and
  CoreDNS's `forward . /etc/resolv.conf` read once at startup) was checked against the pinned K3s, Kubernetes and
  CoreDNS sources.

Done 2026-10-28: the owner ran `installer/node_address.py` once from a bundle of c3ce7478. It ended `"status":
"stable"` with one K3s restart and one CoreDNS replacement; `pcloud0` holds only the fixed address, the daemon's node
status returned to ready with real workload observations, and the business Pods kept their UIDs and zero restarts. The
held gateway release was then resumed through the CI resume, and the rerun of main c3ce7478 released every Worker, the
gateway and the paired VPS release. Move this section to a dated archive with the next HANDOFF cleanup.

### Review cleanup wave (released on `main` c3ce7478, 2026-10-28)

The owner approved fixing the October 25-27 review findings within these limits: backups stay as complete and
recoverable as before (Model Router request bodies stay in its backups), no backup scope, retention or restore tool
is reduced, no stored production data is deleted and the privacy pages are not changed. Dated 410 routes and old
core RPCs stay until their recorded dates; legacy contract schemas, fixtures and frozen bytes stay unchanged;
`platform/src/personal_cloud/deployment/` is frozen.

Nine package branches started from `origin/main` `4ed50919` and were reviewed separately. `claude/wave-integrated`
merges them in the order ci, telemetry, watchmcp, router, mailsort, tasks, home, apps, docs (one merge commit each),
then adds the cross-package fixes below. It is on `main`; its release, the matching Personal cloud reconcile and a
current Home check are not yet recorded here. Once they are verified, record the release below and move this section
to a dated archive.

Next, in order: the backups wave below, then the owner's secret cleanup and its small code follow-up (both tracked in
private notes).

Results by branch:

- `claude/wave-ci`: the Router release chain fails closed; the Codex gateway releases only when its own inputs
  change; a root dependency bump deploys only the members it reaches; the pre-workspace install fallbacks, member
  `engines` blocks and `.nvmrc` files are gone (the Node version comes from the root `package.json`); other apps'
  proto packages stay out of the website's code identity; a fresh bootstrap creates `MODEL_ROUTER_MAINTENANCE_MODE`
  and `BRIEF_MODE`. Release repair or rollback can now rebuild only revisions from the shared workspace onward.
- `claude/wave-telemetry`: the Codex gateway monitor is retired and the Model Router is the one Codex usage
  ledger (`codex.monitor.v1`, `OpsStatus.codex_inference` and `WorkloadStatus.inference_status` retired; the gateway's
  `/healthz` is liveness only; Home's gateway row opens the Router console). Newsletter no longer mounts the Codex
  login. ops-v1 is app-agnostic (`OpsStatus.app` is a format, not a list), `OpsDigestService`/`OpsReport` are
  retired, each app checks only its own deployment modes, and website sync evidence moved off `OpsStatus` to the
  relay's own `WebsiteSync` entrypoint: Home's `NOTION_PUBLISH` binding targets the relay's `Ops`, `WEBSITE_SYNC`
  its `WebsiteSync`. Home routes Ops calls through the registry's binding map.
- `claude/wave-watchmcp`: Watch compares evidence by its masked title, Markdown and image hash only, no longer
  captures the accessibility tree (`Snapshot.structure_json` retired) and drops rule confirmations from the private
  feed (`KIND_CHANGE_CONFIRMED`, `WatchEvent.change` retired); a too-short browser render fails again; an evidence
  storage error no longer fails the check. Personal MCP reads the Watch feed in pages, recovers from an expired cursor
  with one gap report per open Work, and keeps its Dot-facing rules in `SKILL.md` and the tool descriptions.
- `claude/wave-router`: the Newsletter identity may call Codex models only; failures carry the shared reason
  contract (provider 400/413/422 are `MODEL_INVALID_REQUEST`, the Router's own deadline is `MODEL_TIMEOUT`, a credit
  balance refusal is `MODEL_SPEND_LIMIT`, output limits are code 13 from every provider, a rejected Gemini key or
  account stays a configuration error); stuck `running` rows are
  closed by the daily cleanup; context expiry is left to the gateway; the dead `/api/session` endpoint and the
  unused `conversations` table go (migration 0004); the console is light-only. Brief keeps its reservation rates
  itself, stops spending attempts and budget on Router outages, and its README records it as stopped.
- `claude/wave-mailsort`: the Workers AI path, new learning examples (historical ones stay), breaker, the
  one-time rechecks, label consolidation, prompt-cache hints and the Codex usage ledger are retired; model failures
  follow the Router contract (a Codex spend limit holds hourly, Claude's waits for the next month) and a failed mail
  is retried alone; Codex is the default provider for a settings row without one; the
  recent read intake skips sent copies; bundled prompts carry no personal details. The two recheck request fields
  stay `deprecated` (an old page still gets `RELOAD_REQUIRED`), and the consolidation RPCs answer `RELOAD_REQUIRED`
  for a restored unfinished job.
- `claude/wave-tasks`: Plan and Focus lost code from retired lanes and views; committed ready work stays in
  Committed; parked pickups are acknowledged; Quick estimates show; task details can clear a saved Waiting or On
  hold; the GTD page no longer lists tasks; `ListGtdDays` and `ListWeeklyReviews` are retired (the daily counts stay
  in D1); GTD task rates are judged per week. Dated QA captures and ledgers became
  [approved interfaces](tasks/design-qa.md) and one [verification record](tasks/docs/verification.md).
- `claude/wave-home`: every drift check reads at least the last day of account writes (a write may appear in two
  checks within a day); stale CSRF-cookie comments are fixed; the token setup text is neutral; local installs use the
  root workspace. Home's static `GET /api/csrf` is dated to the 2026-11-02 cutoff with its old routes.
- `claude/wave-apps`: Newsletter has one default model and no `codex` extra; Todofy stores native model IDs
  (migration 0017, data-only and idempotent; restoring an older weekly backup replays it) and explains the cost of
  each model choice; Todofy's and Mail Hero's `GET /api/csrf` is dated to their cutoffs (a cached pre-keyless UI fetches it before its
  first write, so it stays until then);
  Mail Hero's v1 collector endpoints, container, Dockerfile and image workflow are retired, while the native backup,
  its artifact downloads, `writers`/`reconcile-writer` and the offline v1/v2 restore tools stay.
- `claude/wave-docs`: HANDOFF keeps in-flight work only and the released sections moved to the
  [October 27 archive](docs/history/handoff-2026-10-27.md); one-off verification ledgers moved into their
  applications ([Mailsort](mailsort/docs/verification.md), [Model Router](model-router/docs/verification.md),
  [Recall](recall/docs/verification.md), [Personal MCP](personal-mcp/docs/verification.md),
  [website](website/docs/verification.md), Todofy's Gemini section) and the Codex monitor record to
  [history](docs/history/codex-monitor.md); public docs no longer describe credential custody or open gaps.

Integration fixes: one `fields` retirement kind in `proto/tools/retired.py` (by full field name and number; a kept
file's import used only by retired fields leaves the base with them) serves all five retired fields, with combined
tests and 76 self-test cases; `proto/retired.json` unions every branch's entries; the
[architecture](docs/architecture.md#home) Home paragraph matches `dashboard/wrangler.toml`; archived handoffs link
the condensed Tasks and Work-memory records; CI/CD and architecture docs no longer describe a Mail Hero collector
image; the compatibility tables name each app's dated `GET /api/csrf` (Todofy's and Mail Hero's restored, since a
pre-keyless tab fetches it before its first write and would otherwise get no reload prompt); the audit
window comments say "at least the last day"; the Mailsort and Recall bundle budgets follow the smaller bundles.

Release effects to expect (one push deploys every Worker and the VPS images):

- Order: the website relay deploys before Home (its old `Ops` no longer serves sync); for the few minutes between
  them the old Home shows no sync evidence and an owner 立即同步 tap ends unconfirmed (a later tap works).
- Fleet may reject host reports and show host_stale for up to about 15 minutes, until the new gateway Pod and
  Platform status daemon stop sending `inference_status`. If the VPS release is skipped or fails, Fleet stays stale
  until a gateway or Platform release lands; rolling back means redeploying the previous Fleet.
- The Router chain now fails closed: this run selects the gateway, so a failed gateway VPS release also holds the
  Model Router and, behind it, Todofy, Mailsort, Brief, Home and the Platform/Newsletter VPS release. Re-run the
  failed jobs after fixing the gateway rather than dispatching single apps out of order.
- Each evidence-enabled watch writes one new snapshot and one EVIDENCE_CHANGED event on its first capture (the
  comparison hash changed), so each linked open Work gets one progress report. Old and new `content_sha256` values
  are not comparable.
- Migrations: Todofy 0017 rewrites stored legacy model IDs; Model Router 0004 drops the unused `conversations` table,
  whose content-free bookkeeping rows were already past their own one-day cleanup. Request history is unchanged.
- Every Node app redeploys once (manifests changed) and the website code identity changes once.

Owner follow-ups after the release:

- Press Refresh tools in the existing Personal Cloud App (`watch_read` lost its `representation` input) and
  republish the plugin skill from `personal-mcp/plugin/skills/personal-cloud/SKILL.md` through the usual separately
  authorized account update.
- Refresh Home's Cloudflare check after deploy: its desired config gained the `NOTION_PUBLISH` binding.
- Read-only checks: Home's 网站同步 panel shows evidence after the first tick or refresh; Fleet, Newsletter and the
  gateway tiles return to fresh; Todofy's model settings show native IDs.
- After the first green `main` run: the new `retired.json` entries may be removed (the `reserved` lines stay). The
  `RETIRED_BINDINGS` entries stay until their own verified-release rule allows removal.
- On or after 2026-11-01: delete Mail Hero's `GET /api/csrf` (`csrfResponse`) with its `/api/v1` 410 routes. On or
  after 2026-11-02: delete Home's `GET /api/csrf`, `CsrfResponse`, `PATHS.csrf` and the legacy-410 block, and
  Todofy's `GET /api/csrf` (`issueCsrf`), together with the other dated routes.

### Backups wave (integrated, not yet pushed)

Mailsort, Personal MCP, Watch and the links app now back themselves up daily into their own private R2 buckets, as
Tasks and Model Router already do. The same limits as the cleanup wave apply: nothing reduces another backup's scope,
retention or restore path, no stored production data is deleted, the privacy pages are not changed here and
`platform/src/personal_cloud/deployment/` is untouched. No new secret, route to another app, Paid feature or VPS
service is added.

`claude/backups-infra` (`79edcd54`, on `main`) declares the four buckets in `infra/storage.tf`. Four reviewed
branches started from it: `claude/backups-mailsort`, `claude/backups-mcp`, `claude/backups-watch` and
`claude/backups-links`. `claude/backups-integrated` merges them in that order (one merge commit each). It then
regenerates the shared files: the Home registry, the account inventory, drift-desired, the ops golden and the service
catalog. It also removes the `AHEAD_OF_BINDING` allowance from `test_infra_config.py`, because every declared bucket
is now bound. Finally it brings `infra/README.md`, [architecture](docs/architecture.md) and the
[rebuild](docs/rebuild.md#data-recovery) data-recovery section in line with the merged code. Nothing is pushed or
deployed. Local checks only.

What each app backs up. Every app keeps the newest 30 complete backups. Retention is in code, with no R2 lifecycle
rule:

| App | Bucket | Schedule (UTC) | Holds | Restore entry point |
| --- | --- | --- | --- | --- |
| Mailsort | `mailsort-backups` | 11:41 daily, from `MailsortState`'s Alarm | every table of the object's SQLite, with schema and rowids | set a new `MAILSORT_OBJECT` and release, then the owner RPC `StartBackupRestore` / `GetBackupRestore` (`mailsort.ui.v2`); [backup](mailsort/docs/backup.md) |
| Personal MCP | `personal-mcp-backups` | 05:23 daily, from `SubscriptionStore`'s Alarm | every table and KV key of the store (Work memory, subscriptions, cursors, deliveries) | set a new `STORE_OBJECT` and release, then `POST /owner/restore` through Access; [backup](personal-mcp/docs/backup.md) |
| Watch | `watch-backups` | 11:23 daily, from `WatchState`'s Alarm | every table, plus one copy of each evidence object a ready snapshot names | set a new `WATCH_OBJECT` and release, then 从备份恢复 on the 健康 page (`RestoreBackup`, `watch.ui.v1`); [backup](watch/docs/backup.md) |
| links | `links-backups` | 05:25 daily, run in steps by the Worker's one `*/5` cron | every D1 table (`links`, `link_revisions`, `request_log`) | D1 Time Travel within 7 days, or `links/tools/backup-restore.ts` into a new D1 database, then `verify` and switch; [backup](links/docs/backup.md) |

Each app has its own Node restore tool (`<app>/tools/backup-restore.ts`). The tool downloads a backup and checks each
part's SHA-256 and row count. It can also upload a backup into a new bucket: parts first, the manifest last. The three
Durable Object restores load only into an empty store. Until they finish they pause the app's writes, schedulers and
backups. Then they make the state safe: nothing is replayed to Gmail or Tasks, and in-flight intents end as
`restored`. Watch moves its event sequence 2^32 ahead, so Personal MCP's Watch cursor expires once and reports the
gap. An object the Worker no longer names stops its own Alarm. Each app reports `backup_age_seconds` and
`last_backup_at` to Home, with the app-only signals `backup_stale` (critical after 3 days) and `backup_failed`
(warning). Personal MCP also raises `maintenance_mode` while a restore is unfinished. Home now binds the links app's
`Ops` entrypoint (`LINKS`, fourteen Ops bindings) instead of probing its `/robots.txt`. The links cron is the
account's fifth and last Workers Free cron trigger. Mailsort's Worker bundle budget rose from 138 to 148 KiB.

Landing, in two steps:

1. The bucket declaration (`79edcd54`) is already on `main`. Before pushing this branch, run the gated **Infra apply**
   and confirm that it created `mailsort-backups`, `personal-mcp-backups`, `watch-backups` and `links-backups`. Each
   app's deploy preflight stops on a missing bucket.
2. Push `claude/backups-integrated` and wait for the complete `CI gate`. Promote the same green SHA to `main`. Then
   wait for the matching Personal cloud reconcile and a current Home check. Home deploys after the links app, whose
   `Ops` it now binds. Refresh Home's Cloudflare check, because its desired config gained Home's `LINKS` binding, the four
   `BACKUPS` bindings, the links cron and the four buckets in the account inventory.

Not blocking: `mailsort/AGENTS.md` no longer ties a retention change to the website's `/privacy/mailsort` page
(the owner is the only developer and user; `claude/backup-followup-links`). The page is unchanged.

Verify after deploy (read-only):

- Each app's first backup. It starts at the first Alarm or tick after the release, because no app has backup state
  yet. Home's next status call brings the Durable Object alarms forward. Check that `latest.json` and one
  `backups/<start>/manifest.json` exist in each of the four buckets (keys only, never the content).
- Home's Mailsort, Personal MCP, Watch and 短链接 tiles show `backup_age_seconds` and `last_backup_at`, with no
  `backup_stale` or `backup_failed`. The 短链接 tile now comes from its Ops answer, not a probe.
- After a day: each app's next natural daily run, and Workers Free usage (the links cron's 288 ticks a day, Durable
  Object rows written, R2 Class A operations).
- Not exercised in production: any restore, the owner restore calls through Access (Personal MCP's through
  cloudflared), the upload into a new bucket, and a restore's real Free-plan rows-written cost. Mailsort's restore
  writes at most 50k SQLite rows a UTC day, so a large store takes several days. These are separate, owner-authorized
  exercises.
- The links cron is the account's fifth: check that the release kept its `*/5` schedule (Home's Cloudflare check
  reports a missing one as a schedule drift). Without it no links backup runs and `backup_stale` follows in 3 days.

An independent verification pass re-ran the selected local checks and added two commits. Watch now tells a retired
object by its id, as Mailsort and Personal MCP do, instead of `ctx.id.name`. An invocation without the name would
otherwise keep an old object checking and notifying next to a restored one. The CI/CD and Home docs now list links
and Personal MCP among the deploys Home waits for, and say that all five cron triggers are in use.

### Backup follow-up (`claude/backup-followup-links`, local, not pushed)

Based on `claude/backups-integrated` (`08a2f5d4`); merge after it reaches `main`. It supersedes that wave's links
cron and the 短链接 tile without a probe:

- Home's registry lets an `ops_v1` status carry a `probe` (`[entries.status.probe]` in `app.toml`, generated into
  `registry.ts`): an anonymous GET of a path the app's own Worker answers outside Access, judged as `public_http` and
  added to the tile (the worse of the two, a tie keeps the app's reason; latency as the tile metric). The links app
  probes `/robots.txt` beside its Ops answer again, as before the wave (`text/plain`, 2xx, error rate), so a broken
  Custom Domain or route shows on Home. Outbound calls: 37 per tick (bound 45 < 50), 17 per refresh (bound 20).
  A view reads one more row (`probe:links`): 40/41/40/41, `VIEW_ROWS_READ` 44.
- The links backup runs on the Alarm of a new SQLite Durable Object, `LinksBackup` (binding `BACKUP_ALARM`, object
  `backup-v1`, migration `v1`); `[triggers] crons = []` removes the `*/5` cron at deploy, so the account uses 4 of
  Workers Free's 5. Same steps, five minutes apart while a job runs, 05:25 UTC daily, failed-job retry an hour later,
  newest 30 kept. `Ops.status()` and the owner's first `/_/` request per isolate arm it, at once while there is no
  `state.json`; every run sets the next Alarm.
- `mailsort/AGENTS.md`: a retention change no longer requires a `/privacy/mailsort` edit.

Release: push, full `CI gate`, promote to `main`. The links deploy adds the namespace (the inventory lists `links` as
`FIRST_DEPLOY_PENDING`); Home deploys after it. Then a follow-up commit records the `links-backup` namespace ID in
`config/resources.toml`, clears `FIRST_DEPLOY_PENDING`, regenerates the inventory and adds the DO to Home's registry
resources, as Tasks did for `TaskJobs`. Refresh Home's Cloudflare check (desired: no links cron, the `BACKUP_ALARM`
binding).

Verify after deploy (read-only): the links Worker has no schedule; Home's next status arms the Alarm and the links
Worker's logs show one `{"backup":{"step":...}}` line per run; the 短链接 tile shows the probe's latency and the backup
age; the next 05:25 UTC run completes a backup (`latest.json` names a new prefix, keys only).

## Latest verified release

`129d5fe9`, Router cost visibility and recommendation array schemas:
[main release](https://github.com/ziyixi/todofy/actions/runs/40544317131). Its matching Personal cloud reconcile
passed with resolved drift, resource registration and VPS gates. Per-app identities are in GitHub production
Deployments.

## Verify after deploy

- Model Router's daily 04:47 UTC backup: the next natural run. A fresh-account cloud restore is a separate exercise
  ([backup](model-router/docs/backup.md)).
- Mail Hero's daily 04:17 UTC backup after the write reduction (`d1a6e526`): the next natural run and its daily
  usage ([backup write verification](mail-hero/docs/backup-write-verification.md)).
- Sunday backups: Tasks' weekly backup now holding the GTD and Goals tables, and Todofy's first Sunday backup after
  Boundary B and the FlowDay release (its health page shows it complete with no `tasks` section).
- Merged ahead of the Router releases without a publication record of their own: Tasks' Sunday-first week and shared
  estimate editing (`a048ba34` to `f5cd8bbe`), Mailsort's recent read Inbox intake (`7427565d`). Confirm the `deploy:tasks` and
  `deploy:mailsort` Deployments are at or after those commits and check the behaviour read-only. A natural Mailsort
  batch through the Router has not been observed.
- Native hourly Work review: catalog refresh and Work event continuation passed in the owner's existing Dot
  ([evidence](docs/work-memory-verification.md)); the first natural run of the
  saved shared review is unverified (the host's next-run field is null). Do not substitute a Codex heartbeat, an
  accepted delivery count or a local fake callback for client execution. Existing user Watches and the old stopped
  automations stay as they are.
- Recall: the first production file removal after seven days and one Dropbox cold read, recording metadata only.
  The phone still reports build `337`; `451` needs phone acceptance, and the cause of `page_probe_invalid_reply_type`
  is not established ([verification](recall/docs/verification.md#phone-evidence)). The cost estimates in
  [design §5.3](recall/docs/design.md#53-budgets) predate minute snapshots with screenshots.
- Links and the website relay have not released through their composites since `dd7a6e8` removed the direct `vars`
  expressions; check each one's first natural release (a preflight or no-op does not load the composite).
- Not rechecked since: Watch's first real changed-watch digest and Newsletter's natural provider/send acceptance.
  Check fresh status before treating an old waiting item as open; do not restart Compose, replay a send or request
  credentials solely from an archived note.
- Bootstrap and safe drift repair are verified in the existing environment. Empty-account / clean-VPS setup, DNS and
  host-entry recovery and full historical data recovery remain separate exercises; follow [rebuild](docs/rebuild.md)
  and [its verification table](docs/rebuild-verification.md).
- The two scheduler observations the owner stopped on October 17 (email models, website daily sync) stay stopped
  ([October 18 archive](docs/history/handoff-2026-10-18.md#stopped-scheduler-observations)).

## Code follow-ups

- Mailsort's `AI` binding removal was confirmed by provider readback ([verification](mailsort/docs/verification.md#claude-provider)):
  drop `AI` from Mailsort's `RETIRED_BINDINGS` entry in `tools/cloud-release/control.py` in a push that deploys
  Mailsort anyway.
- Boundary B ([archive](docs/history/handoff-2026-10-21.md#boundary-b-released-claudeboundary-b)): once Todofy's
  Sunday backup above is confirmed, in a push that deploys them anyway, drop the completed `TASKS` name from Todofy's
  `RETIRED_BINDINGS` entry in `tools/cloud-release/control.py` and reword `proto/buf.yaml`'s header comment, which
  still names the retired `todofy/taskintent/v1` (a change to that file alone deploys every app and the VPS).

## Owner items

- Install Recall Orion `2026.1015.451` on the phone; renewed phone acceptance follows it.
- Read-only checks for Boundary B: Tasks › Mail lists mail and its categories; Plan's weekly review shows the
  pending-mail count; Tasks › GTD shows the copied trend; Mail Hero's 提醒 card names Home's digest task.
- Remove the installed FlowDay PWA from each device (optionally, with the owner's OK, its stopped Compose service and
  tunnel rule in `self-host-on-vultr`). By hand on the Mac: the Tasks PWA's Dock menu, a `?task=` link opening in the
  app window, the title-bar toggle, the mini timer and a real lock with Keep and Discard.
- Remove Todoist Plus from `chrome://extensions` (its variable, releases and merged branches are gone).
- Decided 2026-10-15, do not re-ask: Recall keeps its seven-day cloud file window, and native weekly rollover stays
  enabled; a commitment for an ended week reads as weekly in Tasks ([Tasks design](tasks/docs/design.md)).
- Brief is stopped since 2026-10-18 (`BRIEF_MODE=off`, code kept) and Newsletter is the active daily briefing.
  Resuming Brief means setting the mode and dispatching `app=brief`; its sender `onboarding@resend.dev` reaches only
  the Resend account's own address and must change before any send. Retiring either app is a separate owner decision.

## Operating boundaries

- Workers release independently from committed Wrangler configuration. `config/cloud.toml` is the public deployment
  profile; generated `config/resources.toml` records resource identities. Use the configuration/bootstrap tools and
  `infra/` for their declared resources. Preserve root mail records and unrelated resources.
- GitHub Actions deploys the Newsletter/Platform images by digest through the typed daemon API; it holds no SSH key
  or Kubernetes credential. Legacy Compose services stay stopped with their data; Newsletter remains an independent
  VPS service until the owner retires it.
- Mail Hero backs up natively through its DO Alarm and private R2 ([native backup](mail-hero/docs/native-backup.md)).
  Tasks backs itself up weekly into `tasks-backups` ([Tasks backup](tasks/docs/backup.md)), and Todofy backs up only
  its own D1 (both from release 2 of Boundary B). Model Router backs up request metadata and retained bodies daily
  into its private bucket ([backup](model-router/docs/backup.md)). With the backups wave, Mailsort, Personal MCP, Watch
  and the links app each back up daily into their own private bucket (see Current work).
- Provider keys are Router secrets and never pass through GitHub; spending is capped at the provider. Brief's stored
  budget and the other application budgets stay as they are; Workers Free remains in force.
- Keep Home's persistent alert dismissal. Historical unknown business outcomes are not automatic replay permission;
  follow current [dashboard-state semantics](docs/dashboard-state.md).

## Dated compatibility and retained data

The authoritative [compatibility table](docs/history.md#owner-api-compatibility) defines the old-client responses:

| Surface | Earliest removal |
| --- | --- |
| Mail Hero legacy owner routes (and `GET /api/csrf`) | 2026-11-01 |
| Home and Todofy legacy owner routes (and their `GET /api/csrf`) | 2026-11-02 |
| Mailsort v1 owner routes | 2026-11-10 |

Keep Todofy core's `owner_api` RPC until the corresponding gateway compatibility window is complete. Dates permit a
reviewed follow-up; they do not schedule deletion or authorise changing frozen webhook bytes or migrations. Todofy's
retained host cutover snapshot stays through **2026-10-29**; deletion is a separate action
([verification](todofy/docs/verification.md)).

## Working and maintenance entry points

- [CI/CD](docs/ci-cd.md#where-to-change-the-pipeline): checks, release selection and failure navigation. Push a
  branch, wait for the complete gate, then promote the same green SHA. A rebase or new commits need new checks.
- [Rebuild](docs/rebuild.md), [Cloudflare bootstrap](tools/cloud-bootstrap/README.md),
  [VPS bootstrap/recovery](tools/vps-bootstrap/README.md), [infra](infra/README.md): current operating commands.
- [Documentation guide](docs/README.md), [architecture](docs/architecture.md), [service catalog](docs/service-catalog.md),
  [proto](proto/README.md), [contracts](contracts/README.md): canonical boundaries and application entry points.
- [History](docs/history.md) and the archived handoffs above: earlier releases and evidence.
